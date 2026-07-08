import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { SAAS_VERSION } from '../../../lib/legal-versions'

// B118 Layer 2 Commit 3 — self-serve SaaS acceptance route.
//
// Called from /signup/verify AFTER the user has signed the SaaS gate,
// BEFORE the Stripe Checkout POST. Records a document_type='saas' row
// in tos_acceptances via the accept_saas_agreement() RPC (built in
// Commit 1's migration 20260707_b118_layer2_saas_schema.sql) and
// stamps user_roles.saas_accepted_version.
//
// Redeem path uses redeem_proposal_code's 13-arg signature instead
// (Commit 3 migration extended it) — the SaaS row lands atomically
// with the company/user_roles creation + tos/privacy/texas rows in
// one transaction. This route is the self-serve equivalent, invoked
// when there's no proposal code and no company row yet.
//
// company_id is NULL on the row (self-serve company doesn't exist
// yet — it's created later at Stripe checkout completion). user_id
// is the evidence key. Acceptable per Jose 2026-07-07 lock.
//
// ── SECURITY MODEL ──────────────────────────────────────────────────
// • Requires authenticated session (cookie-bound supabase client via
//   createSupabaseServerClient → auth.getUser()).
// • email_confirmed_at gate — mirrors the /api/signup/attest posture.
// • Uses the authenticated user's session for the RPC call — never
//   accepts user_id from the request body.
// • RPC is SECURITY DEFINER with GRANT EXECUTE TO authenticated only
//   (REVOKE FROM PUBLIC + anon per Commit 1 migration).
//
// ── SERVER-SIDE VERSION PINNING ─────────────────────────────────────
// SAAS_VERSION is read from the server-side import (build-bundled
// static constant) — never trusted from the request body or client
// state. Same discipline as /api/signup/attest. See
// [[feedback_legal_version_pinning]].

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

  const body = await req.json().catch(() => null) as { reviewedAt?: string } | null
  const reviewedAt = body?.reviewedAt
  if (!reviewedAt || typeof reviewedAt !== 'string') {
    return NextResponse.json({ error: 'reviewedAt required (client-stamped unlock moment)' }, { status: 400 })
  }

  const xff = req.headers.get('x-forwarded-for')
  const ipAddress = xff ? xff.split(',')[0]?.trim() || null : null
  const userAgent = req.headers.get('user-agent')

  const { error: rpcErr } = await supabase.rpc('accept_saas_agreement', {
    p_saas_version: SAAS_VERSION,
    p_reviewed_at:  reviewedAt,
    p_ip_address:   ipAddress,
    p_user_agent:   userAgent,
  })

  if (rpcErr) {
    return NextResponse.json(
      { error: 'accept_saas_agreement RPC failed: ' + rpcErr.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true })
}
