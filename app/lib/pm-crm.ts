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
    const status = ((r.status as string) ?? (r.is_active ? 'active' : 'pending')) as CrmResident['status']
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
        // Only APPROVED vehicles are enforcement-authorized to park at
        // the assigned space. Pending / under_review / declined excluded.
        for (const v of other.vehicles) {
          const st = norm(v.status)
          if (st !== 'active' && st !== 'approved') continue
          authorizedPlates.push({
            plate: v.plate ?? '',
            owner_email: other.email,
            owner_name: other.name,
            owner_unit: other.unit,
            isThisResident,
          })
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
    if (r.status === 'active') activeResidents++
    approvedPermits += r.vehicleCounts.approved
  }
  return { needApproval, spaceRequests, platesUnderReview, activeResidents, approvedPermits }
}

// ── List filter + search (client-side)

export type CrmFilter = 'all' | 'active' | 'needs' | 'review'

export function filterCrmRows(rows: CrmResident[], filter: CrmFilter, search: string): CrmResident[] {
  const q = search.trim().toLowerCase()
  return rows.filter(r => {
    if (filter === 'active' && r.status !== 'active') return false
    if (filter === 'needs' && !r.needsApproval) return false
    if (filter === 'review' && r.vehicleCounts.underReview === 0) return false
    if (!q) return true
    const hay = [r.name, r.email, r.unit, ...r.vehicles.map((v: any) => v.plate)].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?'
}
