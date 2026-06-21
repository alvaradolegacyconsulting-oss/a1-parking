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
  assigned_to_resident_email: string | null
  assigned_at: string | null
  assigned_by_email: string | null
  is_bundled: boolean
  created_at: string
  created_by_email: string
  migration_note: string | null
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
  return {
    rows: (data ?? []) as Space[],
    totalCount: count ?? 0,
  }
}

// ── Residents-at-property helper (used by assign/reassign dropdowns) ──

export interface ResidentOption {
  email: string
  name:  string
  unit:  string
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
    email: (r.email ?? '').toLowerCase(),
    name:  r.name ?? '',
    unit:  r.unit ?? '',
  }))
}

// ── Resident display helper for list rows ───────────────────────────
// Given a space's assigned_to_resident_email + the loaded residents list,
// return a display string ("Sarah Chen · Unit 207"). Used in the list
// table's ASSIGNED RESIDENT column. The residents list is already loaded
// for the assign/reassign dropdowns — this helper just lookups, doesn't
// fetch.

export function residentDisplay(email: string | null, residents: ResidentOption[]): string {
  if (!email) return '—'
  const r = residents.find(x => x.email === email.toLowerCase())
  if (!r) return email  // resident not in loaded slice — show email as fallback
  return `${r.name || r.email}${r.unit ? ` · Unit ${r.unit}` : ''}`
}
