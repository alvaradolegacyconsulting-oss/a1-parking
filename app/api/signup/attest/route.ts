import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { TEXAS_ATTESTATION_VERSION } from '../../../lib/legal-versions'

// B66.3 + B95 — Texas attestation INSERT (Option D from pre-flight).
// Called from /signup/verify immediately after the PKCE exchange
// completes (user is authenticated by then). Records the attestation
// row BEFORE the user clicks "Continue to Checkout" — preserves the
// "moment of intent" semantics without requiring a SECURITY DEFINER
// RPC or schema change.
//
// ── DEVIATION FROM PRE-FLIGHT OPTION A ──────────────────────────────
// Pre-flight Option A had attestation INSERT at form-submit time
// (immediately after supabase.auth.signUp returns). At implementation,
// that's not possible: Supabase email confirmation is ON, so signUp
// returns NO session — the user isn't authenticated. tos_acceptances
// RLS doesn't permit client-side INSERTs (only redeem_proposal_code()
// SECURITY DEFINER writes today). Alternatives all required schema
// changes or anon-callable RPCs with spoofing risk; Option D records
// at /signup/verify after PKCE auth, which is still pre-Checkout,
// still pre-payment, and authenticated.
//
// ── SECURITY MODEL ──────────────────────────────────────────────────
// • Requires an authenticated session (cookie-bound supabase client
//   via createSupabaseServerClient → auth.getUser()). Verified user
//   is one whose email is confirmed.
// • Uses the AUTHENTICATED user's id from session — never accepts
//   user_id from the request body (no parameter spoofing surface).
// • Service-role client for the INSERT (bypasses RLS — tos_acceptances
//   has no client-side INSERT policy).
// • Idempotent: re-running for the same (user_id, document_type)
//   returns existing row id rather than inserting a duplicate. Future
//   re-attest at wording bump will use a different version string so
//   the dedup key may evolve.

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'email not verified' }, { status: 403 })
  }

  const service = createSupabaseServiceClient()

  // Idempotency probe — re-call after page refresh shouldn't duplicate.
  const { data: existing, error: probeErr } = await service
    .from('tos_acceptances')
    .select('id')
    .eq('user_id', user.id)
    .eq('document_type', 'texas_attestation')
    .eq('attestation_version', TEXAS_ATTESTATION_VERSION)
    .maybeSingle()
  if (probeErr) {
    return NextResponse.json({ error: 'probe failed: ' + probeErr.message }, { status: 500 })
  }
  if (existing) {
    return NextResponse.json({ id: existing.id, action: 'recovered' })
  }

  // ip_address: best-effort from the request headers. Behind Vercel,
  // x-forwarded-for has the original client IP as the first entry.
  const xff = req.headers.get('x-forwarded-for')
  const ipAddress = xff ? xff.split(',')[0]?.trim() || null : null
  const userAgent = req.headers.get('user-agent')

  const { data: inserted, error: insertErr } = await service
    .from('tos_acceptances')
    .insert({
      user_id: user.id,
      document_type: 'texas_attestation',
      attestation_version: TEXAS_ATTESTATION_VERSION,
      tos_version: null,
      privacy_version: null,
      ip_address: ipAddress,
      user_agent: userAgent,
      // company_id remains NULL — company doesn't exist yet (created
      // later by checkout.session.completed webhook).
    })
    .select('id')
    .single()
  if (insertErr) {
    return NextResponse.json({ error: 'insert failed: ' + insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ id: inserted.id, action: 'created' })
}
