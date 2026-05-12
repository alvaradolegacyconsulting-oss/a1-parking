// B19 visitor pass per-plate limit helper. Used by /visitor (anon)
// and /resident (authenticated) before submit so the user sees how
// many passes the entered plate already has at this property, and
// the submit button can be disabled at the UI layer before the DB
// trigger fires.
//
// Powered by the SECURITY DEFINER RPC get_plate_pass_status(p_property,
// p_plate). The RPC bypasses RLS in a controlled way — it returns only
// counts + a state string, never raw visitor_passes rows.

import { supabase } from '../supabase'

export type PlateLimitStatus =
  | { state: 'unlimited' }
  | { state: 'exempt' }
  | { state: 'within'; used: number; limit: number }
  | { state: 'at_limit'; used: number; limit: number }

export async function getPlateLimitStatus(
  property: string,
  plate: string,
): Promise<PlateLimitStatus | null> {
  if (!property || !plate) return null
  const { data, error } = await supabase.rpc('get_plate_pass_status', {
    p_property: property,
    p_plate: plate,
  })
  if (error || !data) {
    console.error('[get_plate_pass_status] RPC failed:', error)
    return null
  }
  return data as PlateLimitStatus
}

// True when the user shouldn't be allowed to submit because the plate
// already has the maximum number of active passes. exempt and unlimited
// are NOT at_limit.
export function isAtLimit(status: PlateLimitStatus | null): boolean {
  return status?.state === 'at_limit'
}

// Parses a Postgres error returned from a visitor_passes INSERT and
// returns a user-friendly message if it matches the B19 trigger.
// Returns null if the error is something else (caller should fall back
// to generic error handling).
export function parseLimitTriggerError(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { code?: string; message?: string; hint?: string }
  if (e.code !== '23514') return null
  if (!e.message?.includes('Visitor pass limit exceeded')) return null
  const hint = e.hint ? `\n${e.hint}` : ''
  return `${e.message}${hint}`
}
