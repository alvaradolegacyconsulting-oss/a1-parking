// PM Resident CRM — client-side grouping helpers.
//
// The whole point of this module: fold N property-scoped batch loads
// (residents · pending residents · vehicles · spaces · space_residents ·
// guest_authorizations · space_requests) into a single CrmResident[]
// indexed by resident. Zero per-resident queries. This is the anti-N+1
// contract that keeps the CRM fast under any RLS regime.
//
// Match rule: primary by lowercased email; fallback by unit for legacy
// rows missing resident_email (early A1 data had unit-only vehicles).

import type { GuestAuth } from './guest-auth'

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()

// ── Row shapes (loose; source tables carry lots of columns we don't need)

export interface CrmSpace {
  id: number
  label: string
  type: string | null
  status: string | null
  is_active: boolean
  assigned_to_resident_email?: string | null
  property?: string | null
  // 2026-08-19 designated-vehicle arc — reference-data pointer from
  // spaces.designated_vehicle_id. NULL means "any approved vehicle"
  // (today's behavior — unchanged). Chip only; never gates enforcement.
  designated_vehicle_id?: number | null
  // Denormalized plate — resolved inside buildCrmResidents from the
  // vehicles array already loaded (no extra fetch). NULL when the
  // designated vehicle isn't in the current vehicles slice (e.g. RLS
  // hidden or race with the lifecycle trigger from Commit 2).
  designated_vehicle_plate?: string | null
}

// Slice 3 enrichment: each assigned space carries its authorized plate list
// with owner attribution. Computed client-side from ties + vehicles; no new
// fetch. isThisResident distinguishes the currently-viewed resident's own
// plates from roommate plates when the space is shared.
export interface CrmAuthorizedPlate {
  plate: string
  owner_email: string
  owner_name: string
  owner_unit: string
  isThisResident: boolean
  // CLARIFY (2026-07-04): under-review vehicles keep their OLD plate
  // enforce-valid until PM approves the plate-change. When true, `plate`
  // is the OLD plate (from vehicle_plate_changes.old_plate) and the
  // render tags it "· plate change under review" so the space list
  // stays honest.
  plateChangeUnderReview: boolean
}

export interface CrmResidentSpace extends CrmSpace {
  authorizedPlates: CrmAuthorizedPlate[]
  roommateCount: number  // count of tied residents OTHER than the current one
}

export interface CrmSpaceResidentTie {
  space_id: number
  resident_email: string
}

// Slice 4 — plate re-approval lifecycle. Populated only when a vehicle's
// row in vehicle_plate_changes carries status='pending'. Attached to the
// vehicle via enrichment (Phase 3 in buildCrmResidents) so the CRM
// VehicleCard can render Do-Not-Tow + old→new + approve/decline without
// a per-vehicle query.
export interface CrmPendingPlateChange {
  id: number
  vehicle_id: number
  old_plate: string
  new_plate: string
  submitted_by: string
  submitted_at: string
}

export interface CrmSpaceRequest {
  id: number
  resident_email: string
  property: string
  note?: string | null
  status: string
  requested_at: string
  decline_reason?: string | null
  assigned_space_id?: number | null
}

export interface CrmResident {
  id: number
  name: string
  email: string
  unit: string
  property: string
  phone: string | null
  status: 'pending' | 'active' | 'declined'
  is_active: boolean
  lease_end: string | null
  created_at: string | null
  manager_note: string | null
  // 2026-08-05 Task 3 Commit 2 — deactivation fields.
  // 🔴 INTERNAL-ONLY. These render in the manager CRM detail when
  // is_active=false. They MUST NOT be added to residents-export.ts
  // (a leasing_agent could download deactivation_note in a CSV).
  // Not shown in resident portal, driver surfaces, or any email.
  // Same data-minimization rule as B225. See COMMENT ON the columns
  // in 20260805_deactivation_reason_columns.sql.
  deactivation_reason: string | null
  deactivation_note: string | null
  deactivated_by: string | null
  deactivated_at: string | null
  // Grouped derivations:
  vehicles: any[]
  vehicleCounts: { approved: number; pending: number; underReview: number }
  assignedSpaces: CrmResidentSpace[]
  guests: GuestAuth[]
  // RT-4 — resident-submitted guest requests awaiting PM approve/decline.
  // Populated from a separate WHERE status='pending' fetch (fetchActiveGuestAuths
  // filters to active). Feeds Overview approval callout + GuestsPane pending
  // section + needsApproval.
  pendingGuestRequests: GuestAuth[]
  spaceRequest: CrmSpaceRequest | null
  needsApproval: boolean
}

// ── Grouping (single pass) ───────────────────────────────────────────

export function buildCrmResidents(input: {
  residents: any[]
  pendingResidents: any[]
  vehicles: any[]
  spaces: CrmSpace[]
  spaceResidentTies: CrmSpaceResidentTie[]
  guestAuths: GuestAuth[]
  spaceRequests: CrmSpaceRequest[]
  pendingPlateChanges?: CrmPendingPlateChange[]
  // RT-4 — property-scoped fetch of `guest_authorizations WHERE status='pending'`.
  // Separate from guestAuths (which is status='active') so callers don't
  // conflate approve-time / pending-time semantics.
  pendingGuestRequests?: GuestAuth[]
}): CrmResident[] {
  const allResidents = [...input.pendingResidents, ...input.residents]

  // Slice 4 — Attach pendingPlateChange onto its vehicle IN PLACE before
  // grouping. Vehicles are stored by reference in every CrmResident.vehicles;
  // enriching the source rows here means the CRM VehicleCard reads
  // `v.pendingPlateChange` directly without a second pass.
  if (input.pendingPlateChanges && input.pendingPlateChanges.length > 0) {
    const pcByVehicle = new Map<number, CrmPendingPlateChange>()
    for (const pc of input.pendingPlateChanges) pcByVehicle.set(pc.vehicle_id, pc)
    for (const v of input.vehicles) {
      const pc = pcByVehicle.get(v.id)
      if (pc) v.pendingPlateChange = pc
    }
  }

  // Vehicles: index by lowered email, and by unit as fallback.
  const vehiclesByEmail = new Map<string, any[]>()
  const vehiclesByUnit = new Map<string, any[]>()
  for (const v of input.vehicles) {
    const email = norm(v.resident_email)
    const unit = norm(v.unit)
    if (email) {
      const list = vehiclesByEmail.get(email) ?? []
      list.push(v); vehiclesByEmail.set(email, list)
    }
    if (unit) {
      const list = vehiclesByUnit.get(unit) ?? []
      list.push(v); vehiclesByUnit.set(unit, list)
    }
  }

  // 2026-08-19 designated-vehicle Commit 3 — resolve
  // spaces.designated_vehicle_id → plate from the vehicles array
  // already loaded. Zero-fetch; the same denormalization
  // fetchSpacesList does batched, done here in-memory. If the
  // designated vehicle isn't in the vehicles slice (e.g. mid-race
  // with the lifecycle trigger from Commit 2), plate stays null and
  // the chip renders as "designated but resolved-plate unknown".
  const vehicleById = new Map<number, any>()
  for (const v of input.vehicles) {
    if (typeof v.id === 'number') vehicleById.set(v.id, v)
  }
  for (const s of input.spaces) {
    const dvId = s.designated_vehicle_id ?? null
    if (dvId != null && vehicleById.has(dvId)) {
      s.designated_vehicle_plate = vehicleById.get(dvId)?.plate ?? null
    } else {
      s.designated_vehicle_plate = null
    }
  }

  // Spaces grouping — BUG-1 fix (2026-07-04). space_residents ties are
  // AUTHORITATIVE. Legacy `assigned_to_resident_email` fallback is per-
  // space and applies ONLY when that specific space has NO ties AND its
  // legacy assignee column is set (genuine pre-v1.1 row).
  //
  // Prior behavior fell back per-EMAIL: if the ties array was empty for
  // any reason (silent fetch failure, race, wrong scope), the whole
  // second loop treated `assigned_to_resident_email` as SoT for every
  // space. That masked a multi-resident space (assigned_to_resident_email
  // = NULL by v1.1 design) as unassigned for the roommate whose tie was
  // the only source. Result: G-1 (French Quarter, May + Joe as ties)
  // vanished from Joe's assignedSpaces while his primaries surfaced
  // through the fallback. Per-space fallback preserves the pre-v1.1
  // legacy correctness without the silent-substitute misbehavior.
  const spacesByEmail = new Map<string, CrmSpace[]>()

  // Index ties by space_id for O(1) per-space lookup.
  const tieEmailsBySpaceId = new Map<number, string[]>()
  for (const tie of input.spaceResidentTies) {
    const email = norm(tie.resident_email)
    if (!email) continue
    const list = tieEmailsBySpaceId.get(tie.space_id) ?? []
    list.push(email)
    tieEmailsBySpaceId.set(tie.space_id, list)
  }

  for (const s of input.spaces) {
    const tiedEmails = tieEmailsBySpaceId.get(s.id) ?? []
    if (tiedEmails.length > 0) {
      // Authoritative: attribute this space to every tied resident.
      for (const email of tiedEmails) {
        const list = spacesByEmail.get(email) ?? []
        list.push(s)
        spacesByEmail.set(email, list)
      }
      continue
    }
    // No ties for this specific space — legacy fallback (pre-v1.1 row).
    const legacyEmail = norm(s.assigned_to_resident_email)
    if (!legacyEmail) continue
    const list = spacesByEmail.get(legacyEmail) ?? []
    list.push(s)
    spacesByEmail.set(legacyEmail, list)
  }

  // Guest auths: by email OR unit.
  const guestsByEmail = new Map<string, GuestAuth[]>()
  const guestsByUnit = new Map<string, GuestAuth[]>()
  for (const g of input.guestAuths) {
    const email = norm((g as any).resident_email)
    const unit = norm((g as any).unit)
    if (email) {
      const list = guestsByEmail.get(email) ?? []
      list.push(g); guestsByEmail.set(email, list)
    }
    if (unit) {
      const list = guestsByUnit.get(unit) ?? []
      list.push(g); guestsByUnit.set(unit, list)
    }
  }

  // RT-4 — pending guest requests: index the same way as active guests.
  // Resident-submit RPC always writes resident_email + visiting_unit, so
  // both keys populate reliably.
  const pendingGuestsByEmail = new Map<string, GuestAuth[]>()
  const pendingGuestsByUnit = new Map<string, GuestAuth[]>()
  for (const g of input.pendingGuestRequests ?? []) {
    const email = norm((g as any).resident_email)
    const unit = norm((g as any).visiting_unit ?? (g as any).unit)
    if (email) {
      const list = pendingGuestsByEmail.get(email) ?? []
      list.push(g); pendingGuestsByEmail.set(email, list)
    }
    if (unit) {
      const list = pendingGuestsByUnit.get(unit) ?? []
      list.push(g); pendingGuestsByUnit.set(unit, list)
    }
  }

  // Pending space requests: one per resident (first-wins on duplicates).
  const spaceReqByEmail = new Map<string, CrmSpaceRequest>()
  for (const sr of input.spaceRequests) {
    if (norm(sr.status) !== 'pending') continue
    const email = norm(sr.resident_email)
    if (email && !spaceReqByEmail.has(email)) spaceReqByEmail.set(email, sr)
  }

  // Count residents per unit so we can warn about ambiguous unit-fallback
  // attribution at shared units (slice-2 guardrail per Jose 2026-07-03).
  const residentsPerUnit = new Map<string, number>()
  for (const r of allResidents) {
    const u = norm(r.unit)
    if (u) residentsPerUnit.set(u, (residentsPerUnit.get(u) ?? 0) + 1)
  }

  // Phase 1 — build a plain rows array without space enrichment.
  const rows: CrmResident[] = allResidents.map((r): CrmResident => {
    const email = norm(r.email)
    const unit = norm(r.unit)
    let vs = vehiclesByEmail.get(email) ?? []
    if (vs.length === 0 && !email && unit) {
      vs = vehiclesByUnit.get(unit) ?? []
      // Ambiguous-attribution guard: unit-fallback fired at a unit with >1
      // resident. Surface (not silence) so any real-world drift is loud.
      if (vs.length > 0 && (residentsPerUnit.get(unit) ?? 0) > 1) {
        console.warn('[pm-crm] vehicle unit-fallback matched at shared unit — ambiguous attribution', {
          unit,
          resident_id: r.id,
          resident_name: r.name,
          matched_vehicle_ids: vs.map((v: any) => v.id),
          note: 'resident had no email; vehicle attribution may be wrong. Verify resident_email on the vehicle rows.',
        })
      }
    }
    const counts = countVehicles(vs)
    const gs = guestsByEmail.get(email) ?? guestsByUnit.get(unit) ?? []
    const pgs = pendingGuestsByEmail.get(email) ?? pendingGuestsByUnit.get(unit) ?? []
    const ss = spacesByEmail.get(email) ?? []
    const sr = spaceReqByEmail.get(email) ?? null
    // 2026-07-26: fallback no longer invents 'pending' from is_active=false.
    // Downstream residentDisplayStatus() reads is_active separately, so a
    // (status=null, is_active=false) row now derives 'deactivated' via the
    // ladder instead of being mis-badged "Needs approval". Census shows zero
    // null-status rows today; this closes the class before it can hit one.
    const status = ((r.status as string) ?? 'active') as CrmResident['status']
    const needsApproval =
      status === 'pending' ||
      counts.pending > 0 ||
      counts.underReview > 0 ||
      sr !== null ||
      pgs.length > 0
    return {
      id: r.id,
      name: r.name || '(unnamed)',
      email: r.email || '',
      unit: r.unit || '',
      property: r.property || '',
      phone: r.phone ?? null,
      status,
      is_active: r.is_active ?? (status === 'active'),
      lease_end: r.lease_end ?? null,
      created_at: r.created_at ?? null,
      manager_note: r.manager_note ?? null,
      deactivation_reason: r.deactivation_reason ?? null,
      deactivation_note:   r.deactivation_note   ?? null,
      deactivated_by:      r.deactivated_by      ?? null,
      deactivated_at:      r.deactivated_at      ?? null,
      vehicles: vs,
      vehicleCounts: counts,
      // Placeholder — Phase 2 replaces with CrmResidentSpace[] with per-space
      // authorized plate list.
      assignedSpaces: ss.map(s => ({ ...s, authorizedPlates: [], roommateCount: 0 })),
      guests: gs,
      pendingGuestRequests: pgs,
      spaceRequest: sr,
      needsApproval,
    }
  })

  // Phase 2 — enrich each row's assignedSpaces with authorized plates + roommate
  // counts. Needs a full email → row index built from Phase 1's results.
  const rowByEmail = new Map<string, CrmResident>()
  for (const r of rows) rowByEmail.set(norm(r.email), r)

  const tiesBySpaceId = new Map<number, string[]>()
  for (const tie of input.spaceResidentTies) {
    const email = norm(tie.resident_email)
    if (!email) continue
    const list = tiesBySpaceId.get(tie.space_id) ?? []
    list.push(email)
    tiesBySpaceId.set(tie.space_id, list)
  }

  for (const r of rows) {
    const currentEmail = norm(r.email)
    r.assignedSpaces = r.assignedSpaces.map(s => {
      let tiedEmails = tiesBySpaceId.get(s.id) ?? []
      // Legacy fallback: no ties yet but spaces.assigned_to_resident_email
      // is set (pre-v1.1 single-resident model).
      if (tiedEmails.length === 0 && s.assigned_to_resident_email) {
        tiedEmails = [norm(s.assigned_to_resident_email)]
      }
      const authorizedPlates: CrmAuthorizedPlate[] = []
      let roommateCount = 0
      for (const tiedEmail of tiedEmails) {
        const isThisResident = tiedEmail === currentEmail
        if (!isThisResident) roommateCount++
        const other = rowByEmail.get(tiedEmail)
        if (!other) continue
        // CLARIFY (2026-07-04): only ACTIVE tied residents contribute
        // plates. A deactivated resident's plates are unauthorized (their
        // vehicles are is_active=false via the RT-D cascade + trigger
        // auto-freed the space tie anyway); belt-and-suspenders filter
        // here regardless.
        if (other.is_active === false) continue
        for (const v of other.vehicles) {
          const st = norm(v.status)
          // Deactivated vehicles excluded regardless of status.
          if (v.is_active === false) continue
          if (st === 'active' || st === 'approved') {
            // Approved vehicle → current plate is enforce-valid.
            authorizedPlates.push({
              plate: v.plate ?? '',
              owner_email: other.email,
              owner_name: other.name,
              owner_unit: other.unit,
              isThisResident,
              plateChangeUnderReview: false,
            })
          } else if (st === 'under_review' && v.pendingPlateChange) {
            // Plate-change review in flight — OLD plate stays enforce-
            // valid until approve/decline. Show the OLD plate with the
            // under-review marker; the pending NEW plate is NOT yet
            // authorized so it does not appear on the space.
            authorizedPlates.push({
              plate: v.pendingPlateChange.old_plate ?? v.plate ?? '',
              owner_email: other.email,
              owner_name: other.name,
              owner_unit: other.unit,
              isThisResident,
              plateChangeUnderReview: true,
            })
          }
          // pending / declined / anything else → not enforce-valid → skip.
        }
      }
      return { ...s, authorizedPlates, roommateCount }
    })
  }

  return rows
}

export function countVehicles(vs: any[]): { approved: number; pending: number; underReview: number } {
  let approved = 0, pending = 0, underReview = 0
  for (const v of vs) {
    const s = norm(v.status)
    if (s === 'under_review') underReview++
    else if (s === 'pending') pending++
    else if (s === 'active' || s === 'approved') approved++
  }
  return { approved, pending, underReview }
}

// ── Insights (top-of-page 5-count strip)

export interface CrmInsights {
  needApproval: number
  spaceRequests: number
  platesUnderReview: number
  activeResidents: number
  approvedPermits: number
}

export function computeInsights(rows: CrmResident[]): CrmInsights {
  let needApproval = 0, spaceRequests = 0, platesUnderReview = 0, activeResidents = 0, approvedPermits = 0
  for (const r of rows) {
    if (r.needsApproval) needApproval++
    if (r.spaceRequest) spaceRequests++
    platesUnderReview += r.vehicleCounts.underReview
    if (residentDisplayStatus(r) === 'active') activeResidents++
    approvedPermits += r.vehicleCounts.approved
  }
  return { needApproval, spaceRequests, platesUnderReview, activeResidents, approvedPermits }
}

// ── Resident display status — precedence ladder ─────────────────────
//
// residents.status and residents.is_active co-encode overlapping state,
// and the deactivate writer normalizes only is_active — so a
// deactivated row reads as (status='active', is_active=false). Callers
// deriving "is this display-active" from status alone mis-badge the
// row as Active. The ladder below is the single source of truth for
// display state; badges, KPIs, and filters route through it so they
// can't drift.
//
// Precedence: pending > declined > !is_active > active
//   - 'pending'      → approval state; hides deactivation entirely
//   - 'declined'     → manager rejected registration; terminal
//   - 'deactivated'  → is_active=false on a non-pending/-declined row
//   - 'active'       → status='active' AND is_active=true
export type ResidentDisplayStatus = 'pending' | 'declined' | 'deactivated' | 'active'

export function residentDisplayStatus(r: Pick<CrmResident, 'status' | 'is_active'>): ResidentDisplayStatus {
  if (r.status === 'pending') return 'pending'
  if (r.status === 'declined') return 'declined'
  if (r.is_active === false) return 'deactivated'
  return 'active'
}

// ══════════════════════════════════════════════════════════════════════
// vehicleDisplayStatus — symmetric to residentDisplayStatus
// ══════════════════════════════════════════════════════════════════════
//
// Consumers of vehicles.status + is_active MUST NOT read the raw
// columns for display-gate decisions. A pending vehicle is
// is_active=FALSE — same trap that shipped a red DEACTIVATED banner
// onto pending residents 2026-08-06 (fixed in 6269fdf). Use this
// helper so display code can disambiguate cleanly.
//
// Status vocabulary from plate-status.ts (project canon):
//   'pending' | 'active' | 'under_review' | 'declined' | 'expired' |
//   'deactivated'
//
// This function collapses (status, is_active) into a single display
// state. The panel gate on VehicleCard MUST use it, not raw is_active.
//
// ── SITES THAT COMPUTE VEHICLE STATUS TODAY ──────────────────────────
//
// Commit 3 (2026-08-06) migrated VehicleCard's inline computation
// (was at PmResidentCrm.tsx:1030-1043) onto this helper. Other
// consumers still doing their own thing:
//
//   - residents-export.ts:vehicleStatusLabel — maps to human labels
//     for CSV; should call this helper internally in a follow-up so
//     the classification lives in one place. Deferred to avoid
//     dragging CSV-shape risk into this commit.
//   - vehicle-state.ts (if it still exists) — check + fold in the
//     same follow-up.
//
// DO NOT add a fourth copy of this classification. Route through the
// helper.
// ══════════════════════════════════════════════════════════════════════

export type VehicleDisplayStatus =
  | 'pending'
  | 'active'
  | 'under_review'
  | 'declined'
  | 'expired'
  | 'deactivated'
  | 'unknown'

export function vehicleDisplayStatus(v: { status?: string | null; is_active?: boolean | null }): VehicleDisplayStatus {
  const raw = (v.status ?? '').toLowerCase()
  // Status ladder: check explicit lifecycle values first, is_active
  // last (so a manager-deactivated vehicle whose status='deactivated'
  // reads as 'deactivated' regardless of is_active). 'approved' is a
  // legacy alias for 'active'.
  if (raw === 'pending')      return 'pending'
  if (raw === 'under_review') return 'under_review'
  if (raw === 'declined')     return 'declined'
  if (raw === 'expired')      return 'expired'
  if (raw === 'deactivated')  return 'deactivated'
  if (raw === 'active' || raw === 'approved') {
    // A vehicle marked status='active' but is_active=FALSE is the
    // C_orphaned case from noAuthorizedBucket (silent divergence).
    // For DISPLAY purposes, show 'active' — the manager needs the
    // signal that the row still carries the approved status. Panel
    // classification is what surfaces the divergence, not this
    // helper.
    return 'active'
  }
  return 'unknown'
}

// ── List filter + search (client-side)

export type CrmFilter = 'all' | 'active' | 'needs' | 'review' | 'no-authorized'

export function filterCrmRows(rows: CrmResident[], filter: CrmFilter, search: string): CrmResident[] {
  const q = search.trim().toLowerCase()
  return rows.filter(r => {
    if (filter === 'active' && residentDisplayStatus(r) !== 'active') return false
    if (filter === 'needs' && !r.needsApproval) return false
    if (filter === 'review' && r.vehicleCounts.underReview === 0) return false
    if (filter === 'no-authorized' && noAuthorizedBucket(r) === null) return false
    if (!q) return true
    const hay = [r.name, r.email, r.unit, ...r.vehicles.map((v: any) => v.plate)].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

// ══════════════════════════════════════════════════════════════════════
// No-authorized-vehicle panel (2026-08-06)
// ══════════════════════════════════════════════════════════════════════
//
// Bucket function for the "No authorized vehicle" filter chip on the
// Residents tab. Population: active residents (is_active=TRUE +
// status='active') whose vehicles exist but NONE are is_active=TRUE.
//
// 🔴 PREDICATE — READS v.is_active + v.status DIRECTLY.
//
// Uses per-vehicle `v.is_active` (enforcement predicate — matches
// check_resident_plate 20260524:139). Does NOT read
// `r.vehicleCounts` — that comes from countVehicles() which reads
// `status` ALONE and disagrees with enforcement (see
// docs/backlog/vehicles-status-is_active-divergence.md). The
// tempting-wrong line inside this fn is `r.vehicleCounts.approved
// === 0` — DO NOT use it.
//
// The `=== true` check for F excludes NULL rows, matching SQL
// `is_active = TRUE`. Other client sites use `!== false` which treats
// NULL as active — that's inconsistent but not this file's problem
// to fix. Confirm vehicles.is_active is NOT NULL via
// information_schema; if it's nullable, the client-side inconsistency
// is its own finding.
//
// ── BUCKETS ───────────────────────────────────────────────────────────
//
// C_orphaned      — any vehicle with is_active=false AND status='active'
//                   (silent divergence: was authorized, then trimmed)
// B_all_declined  — every vehicle status='declined'
// A_all_pending   — every vehicle status='pending'
// E_deactivated   — every vehicle is_active=false AND status='deactivated'
//                   (deliberate manager action, not a defect — panel it
//                   for visibility, badge neutral not red)
// D_mixed         — anything else (mix of pending + declined, or
//                   under_review, expired, or unanticipated
//                   combinations)
// null            — not in panel (has ≥1 is_active=true vehicle OR
//                   zero vehicles at all)
//
// ── EVALUATION ORDER (first-match) ────────────────────────────────────
//
// C → B → A → E_deact → D. Pure single-status buckets checked in
// urgency order; D is the fallback for anything mixed. A resident's
// bucket is the FIRST matching classification, so a resident with
// orphans + declined lands in C (not B or D).
//
// ── DISPLAY SORT ORDER (SEPARATE from evaluation) ────────────────────
//
// C → B → D → A → E_deact. Anything containing a declined plate ranks
// above a pure pending queue (pending resolves as the manager works
// the queue; declined does not). E_deact last — deliberate manager
// action, lowest urgency in the panel.
//
// ── DO NOT ────────────────────────────────────────────────────────────
//
// - DO NOT merge evaluation and display orders (Mateo Aug 6 lock).
// - DO NOT use `!== false` for the F check — enforcement uses
//   `is_active = TRUE` which excludes NULL.
// - DO NOT read vehicleCounts anywhere in this fn.
// - DO NOT swap E_deact and D — E_deact is a pure single-status
//   classification (like A and B); D is the fallback for mixed.
// - DO NOT add an age threshold on A speculatively — the Aug 6
//   diagnostic showed 1 A-resident total; revisit past ~10.
// ══════════════════════════════════════════════════════════════════════

export type NoAuthorizedBucket =
  | 'C_orphaned'
  | 'B_all_declined'
  | 'A_all_pending'
  | 'E_deactivated'
  | 'D_mixed'

// First-match evaluation. C → B → A → E_deact → D. See header.
export const NO_AUTHORIZED_EVALUATION_ORDER: readonly NoAuthorizedBucket[] = [
  'C_orphaned', 'B_all_declined', 'A_all_pending', 'E_deactivated', 'D_mixed',
] as const

// Display sort. C → B → D → A → E_deact. Different from evaluation
// on purpose — see header.
export const NO_AUTHORIZED_DISPLAY_SORT_ORDER: readonly NoAuthorizedBucket[] = [
  'C_orphaned', 'B_all_declined', 'D_mixed', 'A_all_pending', 'E_deactivated',
] as const

// Per-resident bucket classification. Returns null when the resident
// does not belong in the panel (has an authorized vehicle OR has no
// vehicles at all).
export function noAuthorizedBucket(r: CrmResident): NoAuthorizedBucket | null {
  const vs: any[] = r.vehicles ?? []
  if (vs.length === 0) return null
  // F: any authorized vehicle → not in panel.
  if (vs.some((v: any) => v.is_active === true)) return null
  // C: has any orphaned (was approved, is_active flipped without status update)
  if (vs.some((v: any) => v.is_active === false && v.status === 'active')) return 'C_orphaned'
  // Pure single-status buckets, in urgency order
  if (vs.every((v: any) => v.status === 'declined'))    return 'B_all_declined'
  if (vs.every((v: any) => v.status === 'pending'))     return 'A_all_pending'
  if (vs.every((v: any) => v.status === 'deactivated')) return 'E_deactivated'
  // Fallback
  return 'D_mixed'
}

// ══════════════════════════════════════════════════════════════════════
// Reapproval-orphans predicate (2026-08-07)
// ══════════════════════════════════════════════════════════════════════
//
// Per-vehicle predicate for the reapproval orphans panel — fires when
// a manager approves a resident who has plates on file that aren't
// currently authorized. Same philosophy as noAuthorizedBucket
// (enforcement predicate = v.is_active) but different granularity:
// noAuthorizedBucket classifies a RESIDENT into a bucket, this
// classifies each VEHICLE for the panel's per-plate checkboxes.
// Kept as its own helper rather than forcing reuse (Mateo Aug 7:
// "if the shapes don't line up cleanly, say so rather than forcing
// it") because bucket-per-resident and predicate-per-vehicle are
// genuinely different questions.
//
// A vehicle is a "reapproval orphan" if:
//   - is_active === false          (matches enforcement — not currently authorized)
//   - status !== 'pending'         (pending is in the approval queue with its own surface)
//
// Excludes:
//   - is_active === true → already authorized, nothing to restore
//   - status === 'pending' → already in the approval queue, restore would collide
//
// Includes any deactivated, declined, expired, or under_review plate.
// The panel shows the reason (if populated via Task 3 Commit 3's
// deactivation_reason column) so the manager can distinguish
// vehicle_sold from moved_out from admin_cascade.
export function isVehicleUnauthorizedForRestore(v: { is_active?: boolean | null; status?: string | null }): boolean {
  if (v.is_active === true) return false
  if ((v.status ?? '').toLowerCase() === 'pending') return false
  return true
}

// Badge text builder — enumerates statuses actually present on the
// resident's vehicles rather than assuming pending + declined. An
// unanticipated combination (e.g., 1 under_review + 1 expired)
// degrades to something true rather than to zeros. Kept in this
// module (not the component) so it's testable pure logic.
export function noAuthorizedBadgeText(r: CrmResident, bucket: NoAuthorizedBucket): string {
  const vs: any[] = r.vehicles ?? []
  const count = (status: string) => vs.filter((v: any) => v.status === status).length
  const orphaned = vs.filter((v: any) => v.is_active === false && v.status === 'active').length

  switch (bucket) {
    case 'C_orphaned':
      return `${orphaned} orphaned plate${orphaned === 1 ? '' : 's'}`
    case 'B_all_declined':
      return `${count('declined')} declined plate${count('declined') === 1 ? '' : 's'}`
    case 'A_all_pending':
      return `${count('pending')} pending plate${count('pending') === 1 ? '' : 's'}`
    case 'E_deactivated':
      return `${count('deactivated')} deactivated plate${count('deactivated') === 1 ? '' : 's'}`
    case 'D_mixed': {
      const parts: string[] = []
      const pending      = count('pending')
      const declined     = count('declined')
      const underReview  = count('under_review')
      const expired      = count('expired')
      const deactivated  = count('deactivated')
      if (pending)     parts.push(`${pending} pending`)
      if (declined)    parts.push(`${declined} declined`)
      if (underReview) parts.push(`${underReview} under review`)
      if (expired)     parts.push(`${expired} expired`)
      if (deactivated) parts.push(`${deactivated} deactivated`)
      // Fallback for unanticipated status combinations — degrade to
      // something true rather than to zeros.
      if (parts.length === 0) parts.push(`${vs.length} unknown status`)
      return parts.join(' · ')
    }
  }
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?'
}
