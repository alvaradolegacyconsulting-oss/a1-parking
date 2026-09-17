// ════════════════════════════════════════════════════════════════════
// CA plate activity — the client side of ca_plate_activity().
//
// Thin on purpose. Every decision that matters — CA-only, company
// scoping, the day clamp, which violation columns are returned — is in
// the RPC (20260917_ca_plate_activity.sql), because a render condition
// is not a control. This file calls it and shapes errors for a human.
//
// ── 🔴 THE RPC IS ALREADY REACHABLE ─────────────────────────────────
// It is applied, so any authenticated caller can hit it through
// PostgREST today, tab or no tab. Nothing here is what stops a manager
// or another company's CA reading rows — the RPC's own role and company
// gates are, and E2/E3 in the paired verification are what prove it.
// If those gates were wrong, this UI would not be the exposure.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'

export type PlateActivityPass = {
  id: number
  issued_at: string
  duration_hours: number | null
  expires_at: string | null
  is_live: boolean
  visiting_unit: string | null
}

export type PlateActivityViolation = {
  id: number
  issued_at: string
  reason: string | null
  status: string | null
  voided_at: string | null
}

export type PlateActivity = {
  ok: true
  property: string
  plate: string
  window_days: number
  passes: PlateActivityPass[]
  violations: PlateActivityViolation[]
  pass_count: number
  violation_count: number
}

export type PlateActivityFailure = { ok: false; message: string; code: string }

// Engineer-facing codes never reach a CA. Same rule as the tow log's
// error map (feedback_raw_error_never_reaches_user).
const FRIENDLY: Record<string, string> = {
  unauthenticated:      'Your session has expired. Sign in again and retry.',
  role_not_authorized:  'Plate activity is available to company administrators only.',
  no_company_context:   'We could not tell which company your account belongs to. Ask support to check your access.',
  property_required:    'Pick a property first.',
  plate_required:       'Enter a plate with at least one letter or number.',
  // The RPC deliberately returns the same code for "does not exist" and
  // "belongs to another company" — distinguishing them would let a CA
  // probe for property names across tenants. The copy must not
  // reintroduce that distinction either.
  property_not_found:   'That property is not available on your account.',
  network_error:        'We could not reach the server. Check your connection and try again.',
  unexpected_error:     'Something went wrong looking that up. Try again.',
}

export async function fetchPlateActivity(
  supabase: SupabaseClient,
  input: { property: string; plate: string; days?: number },
): Promise<PlateActivity | PlateActivityFailure> {
  const { data, error } = await supabase.rpc('ca_plate_activity', {
    p_property: input.property,
    p_plate:    input.plate,
    // Omitted rather than defaulted client-side, so the window lives in
    // ONE place. The RPC's DEFAULT 30 is the source of truth and its
    // clamp is what bounds it.
    ...(input.days != null ? { p_days: input.days } : {}),
  })

  if (error) {
    console.error('[ca-plate-activity] rpc failed', { code: error.code, message: error.message })
    return { ok: false, code: error.code ?? 'network_error', message: FRIENDLY.network_error }
  }
  if (data && typeof data === 'object' && 'error' in data) {
    const code = String((data as any).error)
    console.error('[ca-plate-activity] rejected', { code })
    return { ok: false, code, message: FRIENDLY[code] ?? FRIENDLY.unexpected_error }
  }
  return data as PlateActivity
}
