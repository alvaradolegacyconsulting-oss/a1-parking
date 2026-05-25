import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import {
  TEXAS_ATTESTATION_VERSION,
  TOS_VERSION,
  PRIVACY_VERSION,
} from '../../../lib/legal-versions'

// B118 — multi-document consent capture at signup time.
//
// Called from /signup/verify immediately after the PKCE exchange
// completes (user is authenticated by then). Records ToS + Privacy +
// Texas attestation rows in tos_acceptances AND stamps user_roles
// version columns — atomically, via the accept_signup_consents()
// SECURITY DEFINER RPC (B118 commit 1 migration).
//
// ── HISTORY ─────────────────────────────────────────────────────────
// B66.3 (initial): wrote ONE row (texas_attestation only). Self-serve
//   subscribers only consented to Texas terms; ToS + Privacy were
//   never captured at moment-of-purchase. Identified as launch
//   blocker (B118).
// B118 (this commit): switches from inline 3-INSERTs (counter-proposal
//   E.1 alternative) to a single RPC call. Atomicity guaranteed by
//   the RPC's transaction. The RPC handles per-document idempotency
//   via SELECT-then-INSERT internally (counter-proposal E.2) AND
//   stamps user_roles.tos_accepted_at + tos_accepted_version +
//   privacy_accepted_version so the version-aware /login modal
//   (commit 3) suppresses correctly for B118-signed-up users.
//
// ── SECURITY MODEL ──────────────────────────────────────────────────
// • Requires authenticated session (cookie-bound supabase client via
//   createSupabaseServerClient → auth.getUser()). Verified user is
//   one whose email is confirmed.
// • Uses the AUTHENTICATED user's session for the RPC call — never
//   accepts user_id from the request body (the RPC reads auth.uid()
//   internally; no parameter spoofing surface).
// • RPC is SECURITY DEFINER with GRANT EXECUTE TO authenticated only
//   (REVOKE FROM PUBLIC, anon per B118 commit 1 PART 6).
// • The route uses the authenticated session client to invoke the RPC
//   (not service-role) — RPC's SECURITY DEFINER context handles the
//   tos_acceptances + user_roles writes that RLS would otherwise
//   block.

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

  // ip_address: best-effort from the request headers. Behind Vercel,
  // x-forwarded-for has the original client IP as the first entry.
  const xff = req.headers.get('x-forwarded-for')
  const ipAddress = xff ? xff.split(',')[0]?.trim() || null : null
  const userAgent = req.headers.get('user-agent')

  // Server-side version pins are the source of truth — never trust
  // user_metadata version strings (a sophisticated caller could spoof
  // them at signup to record consent against an old/fake version).
  // The form ships these from legal-versions.ts; the route validates
  // by using the same import.
  const { error: rpcErr } = await supabase.rpc('accept_signup_consents', {
    p_attestation_version: TEXAS_ATTESTATION_VERSION,
    p_tos_version: TOS_VERSION,
    p_privacy_version: PRIVACY_VERSION,
    p_ip_address: ipAddress,
    p_user_agent: userAgent,
  })

  if (rpcErr) {
    return NextResponse.json(
      { error: 'accept_signup_consents RPC failed: ' + rpcErr.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true })
}
