// B214 — guest_authorizations shared client helpers.
//
// Why a helper file: manager portal + CA portal both implement the same
// active-list query, overlap-pre-check, and date math. Inline duplication
// would drift (the violation_type 8-options inline trap that the recent
// tow-reasons report flagged). One source of truth here.
//
// Server-side writes go through 3 DEFINER RPCs:
//   create_guest_authorization / renew_guest_authorization / revoke_guest_authorization
// This file does NOT wrap the RPCs — call sites use supabase.rpc(...) directly with NAMED params (Jose lock 2026-06-20: positional 12-arg
// create signature is a transposition trap). The helpers below are for the
// non-write surfaces: read queries, date math, display utilities.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePlate } from './plate'

/** RPC cap — kept in sync with the table CHECK constraint and create/renew RPC bodies. */
export const GUEST_AUTH_MAX_DAYS = 60

/** Number of days within which a guest auth's expiry triggers the amber "expires soon" badge on cards. */
export const EXPIRING_SOON_WITHIN_DAYS = 3

export interface GuestAuth {
  id: number
  company: string
  property: string
  plate: string
  state: string
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_color: string | null
  guest_name: string
  visiting_unit: string | null
  resident_email: string | null
  non_resident_reason: string | null
  start_date: string  // 'YYYY-MM-DD'
  end_date: string    // 'YYYY-MM-DD'
  status: 'active' | 'revoked'
  is_active: boolean
  created_by_email: string
  created_at: string
  revoked_at: string | null
  revoked_by_email: string | null
  revoked_reason: string | null
  renewed_from_id: number | null
}

/** Today as a 'YYYY-MM-DD' string in the user's local context (matches how DATE columns compare). */
export function todayIso(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Add `days` to a 'YYYY-MM-DD' string. Returns a new 'YYYY-MM-DD' string. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00')
  d.setDate(d.getDate() + days)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Days from today until end_date (negative if expired). */
export function daysUntilExpiry(endDate: string): number {
  const end = new Date(endDate + 'T00:00:00').getTime()
  const today = new Date(todayIso() + 'T00:00:00').getTime()
  return Math.round((end - today) / (1000 * 60 * 60 * 24))
}

/** True when end_date is within EXPIRING_SOON_WITHIN_DAYS days of today (and not already past). */
export function isExpiringSoon(endDate: string): boolean {
  const d = daysUntilExpiry(endDate)
  return d >= 0 && d <= EXPIRING_SOON_WITHIN_DAYS
}

/** Inclusive day-count of a date range (end - start + 1). Used for cap display. */
export function spanDays(startDate: string, endDate: string): number {
  return daysUntilExpiry(endDate) - daysUntilExpiry(startDate) + 1
}

/**
 * Pre-submit overlap check (Finding 2 from B214 preflight — overlap is allowed
 * by design, no DB unique constraint, but the form surfaces a soft warning so
 * the manager makes a conscious choice). Returns the longest-running matching
 * active auth (by end_date desc) or null. Pass excludeId during renewal to
 * skip the source row.
 */
export async function findOverlappingActiveAuth(
  supabase: SupabaseClient,
  params: { plate: string; property: string; startDate: string; endDate: string; excludeId?: number },
): Promise<GuestAuth | null> {
  const normalized = normalizePlate(params.plate)
  if (!normalized) return null
  // Overlap = (existing.start <= new.end) AND (existing.end >= new.start).
  // Filter to active records; sort by end_date desc so the longest-running
  // overlap surfaces first (matches the driver/CA cascade tie-break shape).
  let query = supabase
    .from('guest_authorizations')
    .select('*')
    .ilike('plate', normalized)
    .ilike('property', params.property)
    .eq('is_active', true)
    .eq('status', 'active')
    .lte('start_date', params.endDate)
    .gte('end_date', params.startDate)
  if (params.excludeId !== undefined) {
    query = query.neq('id', params.excludeId)
  }
  const { data } = await query.order('end_date', { ascending: false }).limit(1).maybeSingle()
  return (data as GuestAuth) || null
}

/**
 * Active-list fetch. Manager portal passes { property: manager.name } for a
 * single-property scoped list; CA portal passes { propertyList: [...] } for
 * the full cross-property list within their company.
 */
export async function fetchActiveGuestAuths(
  supabase: SupabaseClient,
  params: { property?: string; propertyList?: string[] },
): Promise<GuestAuth[]> {
  let query = supabase
    .from('guest_authorizations')
    .select('*')
    .eq('is_active', true)
    .eq('status', 'active')
    .order('end_date', { ascending: true })
  if (params.property) {
    query = query.ilike('property', params.property)
  } else if (params.propertyList && params.propertyList.length > 0) {
    query = query.in('property', params.propertyList)
  } else {
    // No scope provided = return empty (defensive — never fetch all rows globally)
    return []
  }
  const { data } = await query
  return (data as GuestAuth[]) || []
}
