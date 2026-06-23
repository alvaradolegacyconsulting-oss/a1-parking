// Spaces v1 — shared client helpers (manager + CA portals).
//
// Why this exists: dashboard aggregate + filtered/paginated list + RPC
// invocations are about to be shared between the manager portal (commit 3)
// and the CA cross-property portal (commit 4). Inline duplication would
// drift (same trap as the violation-type dropdown 2-file drift, or the
// pre-Spaces-v1 saveSpace() direct-write). One source of truth here.
//
// ARCHITECTURAL COMMITMENTS (Jose locked 2026-06-21):
//   • Dashboard reads are AGGREGATE queries (GROUP BY), NOT full row loads
//   • List reads are FILTERED + PAGINATED with a HARDCODED LIMIT —
//     pageSize comes from this file's constants, NOT a user-facing input
//   • Resident search is SERVER-SIDE via a residents-table query whose
//     emails feed an IN clause on the spaces query — NOT client-side
//     filtering over a residents-state array (which would silently miss
//     residents outside the loaded slice)
//   • Visitor metric uses the B19 predicate verbatim — head:true COUNT
//     query (metadata only, no row data crosses wire)
//   • Capacity reads properties.visitor_capacity (NOT total_spaces — the
//     legacy column is dual-written during the deploy window but the
//     read source-of-truth is the new column)
//   • NO fetchAllSpaces() overload exists. All list reads go through
//     fetchSpacesList with explicit pageSize.

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Type taxonomy ───────────────────────────────────────────────────

export const SPACE_TYPES = ['regular', 'carport', 'garage', 'covered', 'handicap', 'employee'] as const
export type SpaceType = typeof SPACE_TYPES[number]

export const TYPE_LABELS: Record<SpaceType, string> = {
  regular:  'Regular',
  carport:  'Carport',
  garage:   'Garage',
  covered:  'Covered',
  handicap: 'Handicap',
  employee: 'Employee',
}

// Default label prefix per type — matches generate_spaces_from_pool RPC's
// CASE expression. Keep in sync if the RPC's prefix map changes.
export const TYPE_PREFIXES: Record<SpaceType, string> = {
  regular:  'R',
  carport:  'CP',
  garage:   'G',
  covered:  'C',
  handicap: 'H',
  employee: 'E',
}

// ── Row shape ───────────────────────────────────────────────────────

export interface Space {
  id: number
  company: string
  property: string
  label: string
  type: SpaceType
  description: string | null
  status: string  // 'available' | 'assigned' (+ transient 'occupied'/'reserved' tolerated by CHECK during rollout)
  is_active: boolean
  // v1.1 multi-resident: ties live in space_residents join table. The legacy
  // assigned_to_resident_email column is dual-written by the new RPCs during
  // the deprecation window (commit-1 migration 20260622_spaces_v1_1_...) —
  // populated when the set has exactly 1 resident, NULL when 0 or 2+. Do
  // NOT read this column for new code; use the `residents` array below
  // (sourced from space_residents). The column drops in a follow-on cleanup
  // after v1.1 readers prove moved.
  assigned_to_resident_email: string | null  // DEPRECATED v1.1
  assigned_at: string | null                  // legacy (single-assignment timestamp)
  assigned_by_email: string | null            // legacy (single-assignment actor)
  is_bundled: boolean
  created_at: string
  created_by_email: string
  migration_note: string | null

  // v1.1 multi-resident — the explicit-tie set, loaded via space_residents
  // join. Attached by fetchSpacesList per row (batch query: one round-trip
  // per page of spaces, ≤pageSize lookups). Order: alphabetical by name.
  // EMPTY ARRAY is a valid state (space has 0 ties → status='available').
  residents: ResidentOption[]
}

// ── Pagination ──────────────────────────────────────────────────────
// Adaptive sizing chosen at component mount via window.matchMedia.
// Both constants are HARDCODED here — there is no user-facing "show all"
// control that could bypass the LIMIT (Jose Check 2 lock 2026-06-21).

export const PAGE_SIZE_MOBILE  = 25
export const PAGE_SIZE_DESKTOP = 50

// ── Dashboard read (aggregate, ~6-24 rows max) ──────────────────────

export interface OccupancyDashboard {
  byType: Record<SpaceType, { total: number; assigned: number; available: number }>
  visitorCapacity: number | null
  activeVisitorPasses: number
}

export async function fetchOccupancyDashboard(
  supabase: SupabaseClient,
  property: string,
): Promise<OccupancyDashboard> {
  // Reserved aggregate — single SELECT, server returns one row per active
  // space; we group client-side because the result set is small (typically
  // ≤ 6 types × 4 statuses = 24 rows even at scale; no need for a GROUP BY
  // RPC). Filters is_active=TRUE to exclude decommissioned (history-only).
  const { data: aggRows } = await supabase
    .from('spaces')
    .select('type, status')
    .ilike('property', property)
    .eq('is_active', true)

  const byType = SPACE_TYPES.reduce((acc, t) => {
    acc[t] = { total: 0, assigned: 0, available: 0 }
    return acc
  }, {} as OccupancyDashboard['byType'])

  for (const row of (aggRows ?? [])) {
    const t = (row.type as SpaceType) ?? 'regular'
    if (!byType[t]) byType[t] = { total: 0, assigned: 0, available: 0 }
    byType[t].total += 1
    if (row.status === 'assigned' || row.status === 'occupied') byType[t].assigned += 1
    else if (row.status === 'available') byType[t].available += 1
  }

  // Visitor capacity — NEW column properties.visitor_capacity (NOT
  // legacy total_spaces). Both coexist during the deploy window; commit 4
  // dual-writes; this read is the source-of-truth path going forward.
  const { data: prop } = await supabase
    .from('properties')
    .select('visitor_capacity')
    .ilike('name', property)
    .single()

  // Active visitor passes count — B19 predicate verbatim:
  //   is_active = TRUE AND expires_at > now()
  // head:true returns metadata only (NO row data crosses the wire) so this
  // scales fine even on properties with thousands of historical passes.
  const { count } = await supabase
    .from('visitor_passes')
    .select('*', { count: 'exact', head: true })
    .ilike('property', property)
    .eq('is_active', true)
    .gte('expires_at', new Date().toISOString())

  return {
    byType,
    visitorCapacity: prop?.visitor_capacity ?? null,
    activeVisitorPasses: count ?? 0,
  }
}

// ── List read (filtered + paginated; never returns >pageSize rows) ──

export interface ListFilters {
  type:         SpaceType | null   // null = All
  status:       'available' | 'assigned' | null  // null = All
  showInactive: boolean
  search:       string             // label OR resident name/email
}

export interface ListResult {
  rows:       Space[]
  totalCount: number   // for pagination "Page X of Y"
}

// Strip PostgREST .or() special chars from the user search string. Manager
// search rarely includes these but stripping prevents query-parse breakage.
function sanitizeSearch(q: string): string {
  return q.replace(/[,()*%]/g, '').trim()
}

export async function fetchSpacesList(
  supabase: SupabaseClient,
  property: string,
  filters: ListFilters,
  page: number,
  pageSize: number,
): Promise<ListResult> {
  // Base query — filters applied server-side. count:'exact' for pagination.
  let q = supabase
    .from('spaces')
    .select('*', { count: 'exact' })
    .ilike('property', property)

  if (!filters.showInactive) {
    q = q.eq('is_active', true)
  }
  if (filters.type) {
    q = q.eq('type', filters.type)
  }
  if (filters.status) {
    q = q.eq('status', filters.status)
  }

  const safeSearch = sanitizeSearch(filters.search)
  if (safeSearch) {
    // Server-side resident-name search: query residents table at THIS
    // property for name/email matches, collect their emails, then OR
    // those emails into the spaces query alongside the label match.
    // Cap matching residents at 100 to keep the IN clause URL-safe.
    const { data: matchingResidents } = await supabase
      .from('residents')
      .select('email')
      .ilike('property', property)
      .or(`name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`)
      .limit(100)
    const emails = (matchingResidents ?? [])
      .map(r => (r.email ?? '').toLowerCase())
      .filter(Boolean)

    let orClause = `label.ilike.%${safeSearch}%`
    if (emails.length > 0) {
      // PostgREST IN syntax: column.in.(value1,value2,...)
      // Quote each email so commas/dots inside addresses are tolerated.
      const emailList = emails.map(e => `"${e}"`).join(',')
      orClause += `,assigned_to_resident_email.in.(${emailList})`
    }
    q = q.or(orClause)
  }

  q = q
    .order('label', { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1)

  const { data, count } = await q
  const rawRows = (data ?? []) as Omit<Space, 'residents'>[]

  // v1.1 multi-resident: batch-load the residents array for every space on
  // this page. ONE round-trip via space_residents .in(space_id, ...) then a
  // SECOND round-trip via residents .in(email, ...) to resolve display
  // info. Worst case: 2 extra queries returning ≤ pageSize × cap rows
  // (pageSize=50, cap=2 → max 100 rows). Cheap.
  const residentsBySpaceId = await fetchSpaceResidentsForList(
    supabase,
    property,
    rawRows.map(s => s.id),
  )
  const rows: Space[] = rawRows.map(s => ({
    ...s,
    residents: residentsBySpaceId.get(s.id) ?? [],
  }))

  return {
    rows,
    totalCount: count ?? 0,
  }
}

// ── v1.1 multi-resident: space_residents helpers ────────────────────

// Batch-load residents for a page of spaces. Returns a Map keyed by
// space_id with the resolved ResidentOption[] (alphabetical by name).
// Used by fetchSpacesList. Two round-trips: (1) space_residents to find
// the email-set per space, (2) residents to resolve display info.
//
// INVARIANT REMINDER: this is REFERENCE-DATA loading. An empty array
// for a space means "no ties" (render dash); it does NOT signal
// unauthorized — authorization is vehicle-level, independent of space.
async function fetchSpaceResidentsForList(
  supabase: SupabaseClient,
  property: string,
  spaceIds: number[],
): Promise<Map<number, ResidentOption[]>> {
  const result = new Map<number, ResidentOption[]>()
  if (spaceIds.length === 0) return result

  // (1) Get all (space_id, resident_email) pairs for these spaces.
  const { data: ties } = await supabase
    .from('space_residents')
    .select('space_id, resident_email')
    .in('space_id', spaceIds)
  if (!ties || ties.length === 0) return result

  // (2) Resolve each unique email to a full ResidentOption via the
  // residents table, scoped to this property (defensive — should match
  // by construction since the space.property = resident.property invariant
  // is enforced by assign_space).
  const uniqueEmails = Array.from(new Set(ties.map(t => (t.resident_email ?? '').toLowerCase()).filter(Boolean)))
  const { data: residentRows } = await supabase
    .from('residents')
    .select('email, name, unit, is_active')
    .ilike('property', property)
    .in('email', uniqueEmails)
  const residentByEmail = new Map<string, ResidentOption>()
  for (const r of (residentRows ?? [])) {
    const email = (r.email ?? '').toLowerCase()
    residentByEmail.set(email, {
      email,
      name:      r.name ?? '',
      unit:      r.unit ?? '',
      is_active: r.is_active ?? true,
    })
  }

  // (3) Compose: for each space_id, list its resolved residents (alpha by name).
  // is_active=true default on unresolved (trigger should have pruned ties to
  // deleted residents; missing row is treated as active for safety).
  for (const tie of ties) {
    const email = (tie.resident_email ?? '').toLowerCase()
    if (!email) continue
    const resolved = residentByEmail.get(email) ?? { email, name: '', unit: '', is_active: true }
    const list = result.get(tie.space_id) ?? []
    list.push(resolved)
    result.set(tie.space_id, list)
  }
  for (const [k, list] of result) {
    list.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
    result.set(k, list)
  }
  return result
}

// Fetch the residents tied to a single space (used by modals that
// operate on one space at a time — assign/free/reassign-via-2-clicks).
// Returns the resolved ResidentOption[] (alphabetical by name).
export async function fetchSpaceResidents(
  supabase: SupabaseClient,
  spaceId: number,
  property: string,
): Promise<ResidentOption[]> {
  const map = await fetchSpaceResidentsForList(supabase, property, [spaceId])
  return map.get(spaceId) ?? []
}

// ── Residents-at-property helper (used by assign/reassign dropdowns) ──

export interface ResidentOption {
  email:     string
  name:      string
  unit:      string
  // v1.1 commit 6: is_active surfaced for the SpaceDetailModal so it can
  // render an "(inactive)" tag in the rare race window where the
  // residents_deactivate_free_spaces trigger hasn't yet pruned a tie to
  // a freshly-deactivated resident. Non-breaking addition — existing
  // callers (residentDisplay, residentDisplayList, SearchableResidentPicker)
  // ignore the field. Defaults to true when the source row lacks it.
  is_active: boolean
}

export async function fetchActiveResidentsAtProperty(
  supabase: SupabaseClient,
  property: string,
): Promise<ResidentOption[]> {
  const { data } = await supabase
    .from('residents')
    .select('email, name, unit')
    .ilike('property', property)
    .eq('is_active', true)
    .order('unit')
  return (data ?? []).map(r => ({
    email:     (r.email ?? '').toLowerCase(),
    name:      r.name ?? '',
    unit:      r.unit ?? '',
    is_active: true,  // helper filters to active only; field still typed
  }))
}

// v1.1 commit 6 — vehicles tied to the given resident emails at the property.
// Used by SpaceDetailModal to render each tied resident's approved vehicles.
// Returns a Map<lowercase-email, VehicleSummary[]> so the modal can group
// without a second pass. Empty list returned for residents with zero matches
// (caller handles the "no active vehicles" render branch).
export interface VehicleSummary {
  plate: string
  year:  string | null
  color: string | null
  make:  string | null
  model: string | null
}

export async function fetchSpaceVehicles(
  supabase: SupabaseClient,
  property: string,
  residentEmails: string[],
): Promise<Map<string, VehicleSummary[]>> {
  const result = new Map<string, VehicleSummary[]>()
  const lowered = residentEmails.map(e => e.toLowerCase()).filter(Boolean)
  if (lowered.length === 0) return result
  // Pre-seed every requested email so callers can rely on Map.get() for
  // empty-result residents (returns [] rather than undefined).
  for (const e of lowered) result.set(e, [])
  const { data } = await supabase
    .from('vehicles')
    .select('plate, year, color, make, model, resident_email')
    .ilike('property', property)
    .eq('is_active', true)
    .eq('status', 'active')
    .in('resident_email', lowered)
  for (const v of (data ?? [])) {
    const email = (v.resident_email ?? '').toLowerCase()
    if (!email) continue
    const list = result.get(email) ?? []
    list.push({
      plate: v.plate ?? '',
      year:  v.year  ?? null,
      color: v.color ?? null,
      make:  v.make  ?? null,
      model: v.model ?? null,
    })
    result.set(email, list)
  }
  // Plate-asc within each resident's list (stable display order).
  for (const [k, list] of result) {
    list.sort((a, b) => a.plate.localeCompare(b.plate))
    result.set(k, list)
  }
  return result
}

// ── Resident display helpers ────────────────────────────────────────
//
// v1.1 multi-resident: residentDisplayList is the NEW primary helper.
// Renders an array of resolved ResidentOption[] (the shape attached to
// every Space row by fetchSpacesList). Commits 3+4 migrate the 9 reader
// sites from the legacy email-based residentDisplay → residentDisplayList.
//
// Empty array → "—" (dash). EMPTY-ARRAY STATE IS A VALID REFERENCE-DATA
// ABSENCE per the locked invariant — NOT a deauthorization signal.
//
// Single resident → "Sarah Chen · Unit 207"
// Multi resident (cap=2) → "Sarah Chen · Unit 207, Marco Diaz · Unit 207"
//   (alphabetical by name; sort happens in fetchSpaceResidentsForList)
export function residentDisplayList(residents: ResidentOption[]): string {
  if (!residents || residents.length === 0) return '—'
  return residents
    .map(r => `${r.name || r.email}${r.unit ? ` · Unit ${r.unit}` : ''}`)
    .join(', ')
}

// Legacy single-email helper. Pre-v1.1 callers in manager + CA portals
// still use this; commits 3+4 migrate them to residentDisplayList. The
// helper stays available through the deprecation window so commit 2
// ships standalone without breaking existing callers. Drops in the
// cleanup migration that removes spaces.assigned_to_resident_email.
export function residentDisplay(email: string | null, residents: ResidentOption[]): string {
  if (!email) return '—'
  const r = residents.find(x => x.email === email.toLowerCase())
  if (!r) return email  // resident not in loaded slice — show email as fallback
  return `${r.name || r.email}${r.unit ? ` · Unit ${r.unit}` : ''}`
}
