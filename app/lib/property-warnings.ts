// ══════════════════════════════════════════════════════════════════════
// property-warnings — six predicates over a property's residents + vehicles.
// ══════════════════════════════════════════════════════════════════════
//
// V1 (2026-08-08): manager portal only. CA portal HAS NO per-property
// residents/vehicles state — it aggregates via ad-hoc queries and
// company-wide RPCs (get_enforcement_insights). Building CA
// integration in V1 would either double the scope (add per-property
// list-loading to CA) or require a new server-side RPC that
// re-implements noAuthorizedBucket + the other 5 predicates —
// recreating the divergence class this panel exists to detect.
// V2: extend CA — either add per-property fetch there, or route both
// portals through an RPC that embeds noAuthorizedBucket server-side.
//
// ── AUDIENCE — LEASING OFFICE, NOT ENGINEERING ───────────────────────
//
// Copy contract (Mateo lock 2026-08-08):
//   - No column names, no status values, no table names, no internal
//     concepts. Everything a leasing agent would read as words.
//   - Every row states what to DO, not just what's wrong.
//   - Self-service action wherever one exists.
//   - Named escalation contact wherever it doesn't ("your company
//     administrator", "ShieldMyLot support") — never "flag for review".
//
// The CA-portal copy for the escalation warnings will differ from the
// manager-portal copy: on the CA portal the CA is the escalation
// contact for row 1, so it reads "Contact ShieldMyLot support"
// instead of "Contact your company administrator." That's V2 — same
// warning, different next step by audience.
//
// ── SORT ─────────────────────────────────────────────────────────────
//
// Red above amber. Within red: by unit (the two red warnings arise
// from writes that didn't record themselves, so may have no usable
// timestamp — sort by unit within the tier, don't fabricate an age).
// Within amber: by created_at descending (recency), then unit.
// ══════════════════════════════════════════════════════════════════════

import { noAuthorizedBucket, type CrmResident } from './pm-crm'

// Threshold for warning #5 "pending vehicles aging" (Jose 2026-08-08).
// 7 days catches genuine neglect without flagging normal review cycle.
export const PENDING_AGE_THRESHOLD_DAYS = 7

export type WarningSeverity = 'red' | 'amber'

export type WarningKind =
  | 'portal_approved_enforcement_denied'      // 🔴 tow risk
  | 'enforcement_authorized_portal_pending'   // 🔴 tow risk (permissive)
  | 'duplicate_resident_registration'
  | 'active_resident_no_authorized_vehicle'
  | 'pending_vehicles_aging'
  | 'unit_spelling_collision'

export type WarningRemedyAction =
  | { kind: 'open_add_vehicle';    resident: CrmResident }
  | { kind: 'scroll_to_pending';   unit: string }
  // Future: 'deactivate_duplicate', 'edit_unit', 'contact_ca' (mailto),
  // etc. Absence of remedyAction = the row is informational + the
  // copy names an escalation contact.

export interface PropertyWarning {
  id:            string             // stable React key + dedup
  kind:          WarningKind
  severity:      WarningSeverity
  title:         string             // bold header ("Unit 214 · ABC1234")
  body:          string             // full explanatory sentence — leasing-office plain language
  remedy:        string             // action verb + description
  remedyAction?: WarningRemedyAction
  timestamp?:    string             // ISO; amber-tier sort key
  sortAnchor:    string             // unit (or best proxy); red-tier sort key + amber tiebreaker
}

export interface WarningInput {
  crmResidents:              CrmResident[]
  pendingAgeThresholdDays?:  number   // default PENDING_AGE_THRESHOLD_DAYS
}

// Normalize a unit string for collision detection (#6). Strips common
// prefixes ("apt", "unit", "#"), collapses whitespace, lowercases.
// Preserves the raw string separately so the row copy can name both
// variants side-by-side.
function normalizeUnit(u: string | null | undefined): string {
  if (!u) return ''
  return u
    .toLowerCase()
    .replace(/^\s*(apt|apartment|unit|ste|suite|#)\s*\.?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

export function computePropertyWarnings(input: WarningInput): PropertyWarning[] {
  const { crmResidents } = input
  const thresholdDays = input.pendingAgeThresholdDays ?? PENDING_AGE_THRESHOLD_DAYS
  const warnings: PropertyWarning[] = []

  // ── #1 — Portal shows approved, enforcement denies ────────────────
  // 🔴 Wrongful tow. Natalie's exact shape. No usable timestamp on the
  // divergence itself (it's the discrepancy between two writes, one of
  // which may have been the one to fail). Sort by unit within red tier.
  for (const r of crmResidents) {
    for (const v of (r.vehicles ?? [])) {
      if (v.status === 'active' && v.is_active === false) {
        warnings.push({
          id:        `portal_approved_enforcement_denied:${r.id}:${v.id}`,
          kind:      'portal_approved_enforcement_denied',
          severity:  'red',
          title:     `Unit ${r.unit || '—'} · ${v.plate ?? '(no plate)'}`,
          body:      'this vehicle shows as approved here, but it will not scan as authorized. It could be towed.',
          remedy:    'Contact your company administrator — this needs to be corrected by ShieldMyLot.',
          sortAnchor: r.unit || '',
        })
      }
    }
  }

  // ── #5 — Enforcement authorizes, portal shows pending ─────────────
  // 🔴 Permissive tow-risk (the reverse of #1). An unapproved car
  // parking freely. Same divergence backlog; same "no timestamp"
  // rationale for the red-tier sort.
  for (const r of crmResidents) {
    for (const v of (r.vehicles ?? [])) {
      if (v.is_active === true && v.status === 'pending') {
        warnings.push({
          id:        `enforcement_authorized_portal_pending:${r.id}:${v.id}`,
          kind:      'enforcement_authorized_portal_pending',
          severity:  'red',
          title:     `Unit ${r.unit || '—'} · ${v.plate ?? '(no plate)'}`,
          body:      'this vehicle is still waiting for your approval, but it is already scanning as authorized.',
          remedy:    'Approve or decline it to bring the records in line. (If declining doesn’t take effect, contact your company administrator.)',
          sortAnchor: r.unit || '',
        })
      }
    }
  }

  // ── #2 — Duplicate resident registration ───────────────────────────
  // Same lowered email, 2+ rows at the property. Portal-lockout cause.
  // Row appears once per group (not per row) — the manager needs to
  // resolve the group, not read the same warning twice.
  const byEmail = new Map<string, CrmResident[]>()
  for (const r of crmResidents) {
    const key = (r.email || '').toLowerCase()
    if (!key) continue
    const bucket = byEmail.get(key)
    if (bucket) bucket.push(r)
    else byEmail.set(key, [r])
  }
  for (const [email, group] of byEmail) {
    if (group.length < 2) continue
    // Sort group by created_at asc so the "oldest" reads naturally in
    // any future extension; for the row today, we just pick the first
    // active-shape resident for the display name.
    const displayResident = group.find(r => r.status === 'active') ?? group[0]
    const timestamp = group.reduce((latest: string | undefined, r) => {
      if (!r.created_at) return latest
      if (!latest) return r.created_at
      return r.created_at > latest ? r.created_at : latest
    }, undefined)
    warnings.push({
      id:        `duplicate_resident_registration:${email}`,
      kind:      'duplicate_resident_registration',
      severity:  'amber',
      title:     `${displayResident.name || displayResident.email} · Unit ${displayResident.unit || '—'}`,
      body:      `this resident is registered ${group.length} times. They may have trouble signing in.`,
      remedy:    'Deactivate the duplicate entry, keeping the one with their vehicles.',
      timestamp,
      sortAnchor: displayResident.unit || '',
    })
  }

  // ── #3 — Active resident, no authorized vehicle ────────────────────
  // Reuse noAuthorizedBucket — same predicate as the chip. Returns
  // null for residents with zero vehicles OR any authorized vehicle
  // (V1 scope; zero-vehicle actives are a V2 candidate per Jose).
  //
  // Add Vehicle now exists (85f9b87) → row has an in-product remedy.
  for (const r of crmResidents) {
    if (noAuthorizedBucket(r) === null) continue
    // Prefer the most recent vehicle's created_at as the timestamp so
    // amber sort surfaces recent activity (a resident whose plates
    // just went declined vs. one whose have been that way for months).
    const timestamp = (r.vehicles ?? []).reduce((latest: string | undefined, v: any) => {
      if (!v.created_at) return latest
      if (!latest) return v.created_at
      return v.created_at > latest ? v.created_at : latest
    }, undefined)
    warnings.push({
      id:        `active_resident_no_authorized_vehicle:${r.id}`,
      kind:      'active_resident_no_authorized_vehicle',
      severity:  'amber',
      title:     `Unit ${r.unit || '—'} · ${r.name || r.email}`,
      body:      'this resident has no vehicle approved to park.',
      remedy:    'Add a vehicle for them',
      remedyAction: { kind: 'open_add_vehicle', resident: r },
      timestamp,
      sortAnchor: r.unit || '',
    })
  }

  // ── #4 — Pending vehicles aging ────────────────────────────────────
  // Grouped by resident so a resident with 3 aging pendings gets ONE
  // row, not 3. Threshold from PENDING_AGE_THRESHOLD_DAYS (Jose:
  // 7 days catches neglect without flagging normal review cycle).
  for (const r of crmResidents) {
    const agingVehicles = (r.vehicles ?? []).filter((v: any) =>
      v.status === 'pending' && v.created_at && daysSince(v.created_at) > thresholdDays
    )
    if (agingVehicles.length === 0) continue
    // Oldest of the aging set feeds the "X days" copy.
    const oldest = agingVehicles.reduce((old: any, v: any) =>
      v.created_at < old.created_at ? v : old
    , agingVehicles[0])
    const oldestAgeDays = daysSince(oldest.created_at)
    warnings.push({
      id:        `pending_vehicles_aging:${r.id}`,
      kind:      'pending_vehicles_aging',
      severity:  'amber',
      title:     `Unit ${r.unit || '—'} · ${r.name || r.email}`,
      body:      `${agingVehicles.length === 1 ? '1 vehicle has' : `${agingVehicles.length} vehicles have`} been waiting for approval for ${oldestAgeDays} days. Their cars are not authorized to park until you approve them.`,
      remedy:    'Review pending vehicles',
      remedyAction: { kind: 'scroll_to_pending', unit: r.unit || '' },
      timestamp: oldest.created_at,
      sortAnchor: r.unit || '',
    })
  }

  // ── #6 — Unit-spelling collision ──────────────────────────────────
  // The condition that made Natalie possible. Group units by
  // normalized key; a key with 2+ distinct raw variants is a
  // collision. Considers residents' units AND vehicles' units — a
  // vehicle at "136" with no resident there but a resident at "Apt
  // 136" is the same class.
  const rawUnitsByNormalized = new Map<string, Set<string>>()
  for (const r of crmResidents) {
    const raw = (r.unit || '').trim()
    if (!raw) continue
    const norm = normalizeUnit(raw)
    if (!norm) continue
    const bucket = rawUnitsByNormalized.get(norm)
    if (bucket) bucket.add(raw)
    else rawUnitsByNormalized.set(norm, new Set([raw]))
  }
  for (const r of crmResidents) {
    for (const v of (r.vehicles ?? [])) {
      const raw = (v.unit || '').trim()
      if (!raw) continue
      const norm = normalizeUnit(raw)
      if (!norm) continue
      const bucket = rawUnitsByNormalized.get(norm)
      if (bucket) bucket.add(raw)
      else rawUnitsByNormalized.set(norm, new Set([raw]))
    }
  }
  for (const [norm, rawVariants] of rawUnitsByNormalized) {
    if (rawVariants.size < 2) continue
    const variants = Array.from(rawVariants).sort()
    warnings.push({
      id:        `unit_spelling_collision:${norm}`,
      kind:      'unit_spelling_collision',
      severity:  'amber',
      title:     variants.map(v => `Unit "${v}"`).join(' and '),
      body:      'these are probably the same unit, entered two different ways. Residents in one may not be counted with the other.',
      remedy:    'Edit one resident’s unit so both match.',
      sortAnchor: variants[0],
    })
  }

  // ── Sort: red above amber; recency within amber; unit within red ──
  warnings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'red' ? -1 : 1
    if (a.severity === 'red') {
      // Two red warnings arise from writes that didn't record themselves;
      // sort by unit within the tier, don't fabricate an age.
      return a.sortAnchor.localeCompare(b.sortAnchor, undefined, { numeric: true, sensitivity: 'base' })
    }
    // Amber: recency descending, then unit ascending.
    if (a.timestamp && b.timestamp) {
      if (a.timestamp < b.timestamp) return 1
      if (a.timestamp > b.timestamp) return -1
    } else if (a.timestamp) return -1
    else if (b.timestamp) return 1
    return a.sortAnchor.localeCompare(b.sortAnchor, undefined, { numeric: true, sensitivity: 'base' })
  })

  return warnings
}

// Count-only helper for the tab badge. Cheap enough to call on every
// render (crmResidents is already memoized upstream).
export function countPropertyWarnings(input: WarningInput): number {
  return computePropertyWarnings(input).length
}
