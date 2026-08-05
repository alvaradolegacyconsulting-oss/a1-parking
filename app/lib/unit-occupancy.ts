// ══════════════════════════════════════════════════════════════════════
// unit-occupancy — manager-portal unit occupancy context
// ══════════════════════════════════════════════════════════════════════
//
// One batch call to the get_unit_occupancy_summaries DEFINER RPC feeds
// four surfaces in PmResidentCrm (list-row red flag, amber-panel line,
// vehicle-card neutral context, bulk-lane aggregate) plus the audit
// stamp on APPROVE_RESIDENT / APPROVE_VEHICLE. Single source of truth
// so the number the manager sees, the number the audit records, and
// the enforcement predicate all agree.
//
// The RPC pins on the ENFORCEMENT predicate (`vehicles.is_active =
// TRUE`), matching check_resident_plate exactly. Counting on the same
// set enforcement authorizes on is the feature's one job.
//
// ── FAIL-QUIET CONTRACT ──────────────────────────────────────────────
//
// Mateo lock 2026-08-04: "A failed or missing occupancy payload
// renders NOTHING — no badge, no line, no zero. Absence of information
// must look like absence, not like a clean unit." The client half of
// the RPC's out-of-scope RAISE.
//
// fetchUnitOccupancy returns null on ANY error (RPC error, network
// failure, malformed response, out-of-scope). Callers never invent a
// zero. Helper accessors (getUnitOccupancy, hasOtherActiveResidents)
// also return null / false on missing data — the rendering side reads
// null and skips the affordance.

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Types (mirror the RPC's jsonb response) ──────────────────────────
export interface UnitOccupancyResident {
  email:       string
  name:        string | null
  plate_count: number
}

export interface UnitOccupancy {
  residents:              UnitOccupancyResident[]
  total_active_residents: number
  total_active_plates:    number
}

// RPC response: { property, units: { [unit]: UnitOccupancy } }
// Callers work with the units map directly (property is echo).
export type UnitOccupancyMap = Record<string, UnitOccupancy>

// ── Fetcher — fail-quiet ─────────────────────────────────────────────

/**
 * Batch-fetches unit occupancy for a property. Returns null on any
 * failure (RPC error, malformed response, empty inputs). Callers MUST
 * treat null as "render nothing" — never as an empty map.
 *
 * De-dupes and trims the units array before the RPC call; the RPC
 * also normalizes internally but the client-side dedup keeps the
 * argument tight.
 */
export async function fetchUnitOccupancy(
  supabase:     SupabaseClient,
  propertyName: string,
  units:        Array<string | null | undefined>,
): Promise<UnitOccupancyMap | null> {
  if (!propertyName || !propertyName.trim()) return null
  const trimmedUnits = Array.from(new Set(
    (units ?? [])
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map(u => u.trim())
  ))
  if (trimmedUnits.length === 0) return {}

  const { data, error } = await supabase.rpc('get_unit_occupancy_summaries', {
    p_property: propertyName,
    p_units:    trimmedUnits,
  })

  if (error) {
    // Fail-quiet: log for diagnostics; caller renders nothing.
    // eslint-disable-next-line no-console
    console.error('[unit-occupancy] fetch failed:', error.message)
    return null
  }
  if (!data || typeof data !== 'object') return null
  const units_map = (data as any).units
  if (!units_map || typeof units_map !== 'object') return null
  return units_map as UnitOccupancyMap
}

// ── Accessors ────────────────────────────────────────────────────────

/**
 * Look up occupancy for a unit. Returns null if the map is null, the
 * unit isn't in the map, or the payload is malformed. Never returns
 * an "empty" occupancy — an absent unit is absent.
 *
 * `excludeEmail` optionally filters that email out of the residents
 * array. Use when computing "OTHER active residents at this unit"
 * (the list-row flag excludes the row's own resident so the badge
 * doesn't fire on a solo tenant).
 */
export function getUnitOccupancy(
  map:          UnitOccupancyMap | null,
  unit:         string | null | undefined,
  excludeEmail?: string,
): UnitOccupancy | null {
  if (!map || !unit || !unit.trim()) return null
  // The RPC keys the units map by the raw input string, deduped +
  // trimmed. Client passes the resident's unit verbatim after the
  // same trim — matches the RPC's dedup keying.
  const key = unit.trim()
  const raw = map[key]
  if (!raw || typeof raw !== 'object') return null
  const residents = Array.isArray(raw.residents) ? raw.residents : []

  if (!excludeEmail) return {
    residents,
    total_active_residents: raw.total_active_residents ?? residents.length,
    total_active_plates:    raw.total_active_plates    ?? 0,
  }

  const el = excludeEmail.toLowerCase()
  const filtered = residents.filter(r =>
    typeof r.email === 'string' && r.email.toLowerCase() !== el
  )
  const excluded = residents.find(r =>
    typeof r.email === 'string' && r.email.toLowerCase() === el
  )
  return {
    residents:              filtered,
    total_active_residents: Math.max(0, (raw.total_active_residents ?? residents.length) - (excluded ? 1 : 0)),
    total_active_plates:    Math.max(0, (raw.total_active_plates    ?? 0)                - (excluded?.plate_count ?? 0)),
  }
}

/**
 * True if the unit has ≥1 active resident OTHER than the given email.
 * Used by the list-row flag to fire only when approving would add a
 * second-or-later resident.
 */
export function hasOtherActiveResidents(
  map:            UnitOccupancyMap | null,
  unit:           string | null | undefined,
  currentEmail:   string,
): boolean {
  const occ = getUnitOccupancy(map, unit, currentEmail)
  if (!occ) return false
  return occ.total_active_residents > 0
}

/**
 * Sum of per-resident plate_counts. When less than total_active_plates,
 * the delta is orphan plates (vehicles at the unit with no matching
 * residents row). Client renders that delta as "(N not linked to a
 * resident)" so the panel's arithmetic doesn't read as a bug.
 */
export function sumResidentPlates(occ: UnitOccupancy | null): number {
  if (!occ) return 0
  return occ.residents.reduce((n, r) => n + (r.plate_count || 0), 0)
}

// ── Audit-stamp shape ────────────────────────────────────────────────
//
// Written into audit_logs.new_values on APPROVE_RESIDENT / APPROVE_
// VEHICLE — the first "context at decision" key in the codebase.
// Records the counts + resident names AT CLICK TIME so a later dispute
// answers *"the approving manager saw N residents and M plates when
// they decided"* rather than requiring reconstruction. Fail-quiet: if
// the unit isn't in the batch payload (unitOccupancy null, RPC error,
// out-of-scope), no key is written — the audit row falls back to its
// existing shape.

export interface OccupancyStamp {
  unit:                   string
  total_active_residents: number
  total_active_plates:    number
  resident_names:         string[]  // names for readability; email is elsewhere in the row's context
}

/**
 * Build the audit-stamp payload for a unit. Returns null when the
 * occupancy is unavailable (map null / unit absent) — writers must
 * treat null as "omit the key entirely" rather than writing zeros
 * or nulls that would misrepresent the manager's actual view.
 */
export function buildOccupancyStamp(
  map:  UnitOccupancyMap | null,
  unit: string | null | undefined,
): OccupancyStamp | null {
  const occ = getUnitOccupancy(map, unit)
  if (!occ || !unit) return null
  return {
    unit:                   String(unit),
    total_active_residents: occ.total_active_residents,
    total_active_plates:    occ.total_active_plates,
    resident_names:         occ.residents.map(r => (r.name && r.name.trim()) || r.email),
  }
}
