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
// ── 🔴 SQL MIRROR OF THE TWO RED PREDICATES EXISTS 🔴 ────────────────
//
// 2026-08-21 — Mateo shipped a super-admin cross-tenant rollup for
// the RED predicates only, in migrations/20260821_get_console_red_
// warnings.sql (RPC: public.get_console_red_warnings). That RPC is a
// DELIBERATE partial mirror of kinds #1 (portal_approved_enforcement_
// denied) and #5 (enforcement_authorized_portal_pending) below.
//
// 🔴 IF YOU CHANGE EITHER RED PREDICATE HERE, ALSO CHANGE THE SQL
//    MIRROR IN THE SAME COMMIT. The four amber predicates are NOT
//    mirrored (super-admin sees only red per Jose's spec).
//
// The mirror is PROVISIONAL: it exists because the full 6-predicate
// extraction is blocked on the Aug 8 warnings-self-clearing diagnostic
// and Jose needed the cross-tenant view now. When the full extraction
// lands, the mirror RPC either calls into it or is deleted, and this
// file becomes the sole implementation of the red predicates again.
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

import { noAuthorizedBucket, residentDisplayStatus, type CrmResident } from './pm-crm'

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
  // 🔴 Permissive tow-risk (the reverse of #1). Same divergence
  // backlog; same "no timestamp" rationale for the red-tier sort.
  //
  // 2026-08-08 remedy fix (Mateo close-out): the row previously
  // said "contact your company administrator" — but the manager can
  // resolve this themselves by approving or declining. Same action
  // the amber #4 aging-pending row already offers. Telling the
  // manager to escalate for something they can fix teaches them to
  // ignore rows. Wired to `scroll_to_pending` so the button switches
  // to the Residents tab where they can act.
  for (const r of crmResidents) {
    for (const v of (r.vehicles ?? [])) {
      if (v.is_active === true && v.status === 'pending') {
        warnings.push({
          id:        `enforcement_authorized_portal_pending:${r.id}:${v.id}`,
          kind:      'enforcement_authorized_portal_pending',
          severity:  'red',
          title:     `Unit ${r.unit || '—'} · ${v.plate ?? '(no plate)'}`,
          body:      'this vehicle is still waiting for your approval, but it is already scanning as authorized.',
          remedy:    'Approve or decline it',
          remedyAction: { kind: 'scroll_to_pending', unit: r.unit || '' },
          sortAnchor: r.unit || '',
        })
      }
    }
  }

  // ── #2 — Duplicate resident registration ───────────────────────────
  // Same lowered email, 2+ LIVE rows at the property.
  //
  // Aug 8 fixes (Mateo relay #):
  //   1. Count only rows where residentDisplayStatus !== 'deactivated'.
  //      A deactivated duplicate is history, not a live problem.
  //   2. NAME EVERY DISTINCT UNIT the resident is registered under —
  //      when the units differ (Sayra: "117", "#117", "Apt 117"),
  //      the different spellings ARE the problem, and picking one to
  //      display hides that. When all live rows share one unit
  //      spelling (Test Twice · Unit 222), the row reads "twice at
  //      Unit 222" without variant enumeration.
  //   3. Restate the harm. Portal-lockout was the pre-cc3bc4d
  //      symptom; cc3bc4d fixed it (get_my_effective_active picks the
  //      best row by precedence). Real live consequence now is that
  //      VEHICLES AND RECORDS SPLIT across entries — Natalie's
  //      trimmed plates + dropped re-registration vehicle came from
  //      exactly this.
  const byEmail = new Map<string, CrmResident[]>()
  for (const r of crmResidents) {
    if (residentDisplayStatus(r) === 'deactivated') continue
    const key = (r.email || '').toLowerCase()
    if (!key) continue
    const bucket = byEmail.get(key)
    if (bucket) bucket.push(r)
    else byEmail.set(key, [r])
  }
  for (const [email, group] of byEmail) {
    if (group.length < 2) continue
    const displayResident = group.find(r => r.status === 'active') ?? group[0]
    const timestamp = group.reduce((latest: string | undefined, r) => {
      if (!r.created_at) return latest
      if (!latest) return r.created_at
      return r.created_at > latest ? r.created_at : latest
    }, undefined)
    const rawUnits = Array.from(new Set(group.map(r => (r.unit || '').trim()).filter(u => u.length > 0))).sort()
    const unitPhrase = rawUnits.length === 0
      ? 'no unit on file'
      : rawUnits.length === 1
        ? `at Unit ${rawUnits[0]}`
        : `under Unit ${rawUnits.map(u => `"${u}"`).join(', Unit ')}`
    const displayName = displayResident.name || displayResident.email
    warnings.push({
      id:        `duplicate_resident_registration:${email}`,
      kind:      'duplicate_resident_registration',
      severity:  'amber',
      // Title omits the unit for multi-unit groups (the units go in
      // the body where they can be enumerated). Single-unit groups
      // keep the "· Unit X" title shape for consistency with other
      // rows.
      title:     rawUnits.length > 1
        ? displayName
        : `${displayName} · Unit ${displayResident.unit || '—'}`,
      body:      rawUnits.length > 1
        ? `registered ${group.length} times at this property, ${unitPhrase}. Their vehicles and records are split across the ${group.length} entries.`
        : `registered ${group.length} times at this property, ${unitPhrase}. Their vehicles and records are split across the ${group.length} entries.`,
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
  //
  // Aug 8 fixes (Mateo relay #):
  //   - LIVE-only. Deactivated residents are history; if a collision
  //     only exists via a deactivated row it's not a live problem.
  //   - Track contributing resident emails per normalized unit so
  //     the post-processing subsumption step can drop collisions
  //     fully explained by a single resident's duplicate rows
  //     (already covered by warning #2). Collisions across DIFFERENT
  //     residents survive — those are the ones a manager can't
  //     otherwise see.
  const rawUnitsByNormalized      = new Map<string, Set<string>>()
  const emailsByNormalizedUnit    = new Map<string, Set<string>>()
  const trackUnit = (raw: string | null | undefined, email: string | null | undefined) => {
    const cleaned = (raw || '').trim()
    if (!cleaned) return
    const norm = normalizeUnit(cleaned)
    if (!norm) return
    const raws = rawUnitsByNormalized.get(norm)
    if (raws) raws.add(cleaned); else rawUnitsByNormalized.set(norm, new Set([cleaned]))
    const emailKey = (email || '').toLowerCase().trim()
    if (emailKey) {
      const emails = emailsByNormalizedUnit.get(norm)
      if (emails) emails.add(emailKey); else emailsByNormalizedUnit.set(norm, new Set([emailKey]))
    }
  }
  for (const r of crmResidents) {
    if (residentDisplayStatus(r) === 'deactivated') continue
    trackUnit(r.unit, r.email)
    for (const v of (r.vehicles ?? [])) {
      trackUnit(v.unit, v.resident_email ?? r.email)
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

  // ── POST-PROCESS: dedup red rows by (kind, normalized plate) ──────
  //
  // Aug 8 fix (Mateo relay #): a single physical vehicle can appear
  // in the vehicles table under multiple unit spellings (BULKAPPROVE
  // at "205" AND "apt 205"). Both fired warning #5 twice — the same
  // problem rendered twice in front of a customer. Merge red rows
  // that share (kind, normalized plate) into one row that names all
  // unit spellings. Amber aging-pending for the same plate is a
  // different warning and stays separate.
  {
    const normalizePlate = (p: string | null | undefined): string =>
      (p || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    // Extract the plate from a red row's title (shape:
    // "Unit X · PLATE"). Alternative would be widening PropertyWarning
    // with a plateKey field; extracting here keeps the type surface
    // stable for V1.
    const platefromTitle = (title: string): string => {
      const idx = title.lastIndexOf(' · ')
      return idx === -1 ? '' : normalizePlate(title.slice(idx + 3))
    }
    const groups = new Map<string, PropertyWarning[]>()
    const survivors: PropertyWarning[] = []
    for (const w of warnings) {
      if (w.severity !== 'red') { survivors.push(w); continue }
      const plate = platefromTitle(w.title)
      if (!plate) { survivors.push(w); continue }
      const key = `${w.kind}:${plate}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(w)
      else groups.set(key, [w])
    }
    for (const bucket of groups.values()) {
      if (bucket.length === 1) { survivors.push(bucket[0]); continue }
      // Merge: collect distinct unit spellings from the title prefix
      // "Unit X ".
      const units = Array.from(new Set(bucket.map(w => {
        // "Unit X · PLATE" → "X"
        const m = w.title.match(/^Unit (.+?) · /)
        return m ? m[1] : ''
      }).filter(u => u.length > 0))).sort()
      const first = bucket[0]
      const plate = platefromTitle(first.title)
      const unitPhrase = units.length > 1
        ? `Units ${units.map(u => `"${u}"`).join(' and ')}`
        : `Unit ${units[0] || '—'}`
      survivors.push({
        ...first,
        id:    `${first.kind}:${plate}`,  // stable across the group
        title: `${unitPhrase} · ${plate}`,
        body:  first.body + ` (same plate registered under ${units.length} unit spellings — resolve the collision first.)`,
        // Keep the earliest sortAnchor for consistent placement.
        sortAnchor: bucket.reduce((s, w) => w.sortAnchor < s ? w.sortAnchor : s, first.sortAnchor),
      })
    }
    warnings.length = 0
    warnings.push(...survivors)
  }

  // ── POST-PROCESS: suppress collision rows subsumed by dupe-resident ──
  //
  // Aug 8 fix (Mateo relay #): if a unit-spelling collision is fully
  // explained by ONE resident registered under multiple unit
  // spellings (Sayra: same person at "117", "#117", "Apt 117"), the
  // duplicate-resident row already surfaces the same problem with a
  // human name attached. Rendering both is one problem, two
  // warnings.
  //
  // Suppress when: every raw variant in the collision comes from
  // rows belonging to a SINGLE resident email (the emails set for
  // that normalized unit has size 1). Preserve when different
  // residents contribute — that's the case a manager can't see from
  // the duplicate-resident view.
  {
    const survivors: PropertyWarning[] = []
    for (const w of warnings) {
      if (w.kind !== 'unit_spelling_collision') { survivors.push(w); continue }
      // Extract normalized unit from the ID (shape "unit_spelling_collision:<norm>").
      const norm = w.id.slice('unit_spelling_collision:'.length)
      const emails = emailsByNormalizedUnit.get(norm) ?? new Set<string>()
      if (emails.size <= 1) continue  // fully explained by the resident's dupe row
      survivors.push(w)
    }
    warnings.length = 0
    warnings.push(...survivors)
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
