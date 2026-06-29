import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { verifyTurnstile } from '../../../lib/turnstile-verify'

// /api/register/create-user — public resident self-registration creator
// (C′′, 2026-06-29). Replaces the /register path's call chain of
// (/api/register/captcha-verify → swift-handler create_user →
// signInWithPassword) with a single round-trip: this route does its
// own Cloudflare siteverify (ADD 1 — bot-rejection is the security
// boundary, must live server-side, not client-orchestrated), admin-
// creates the auth.users row, generates a one-time magic-link token,
// and returns the token to the client. Client then calls
// supabase.auth.verifyOtp({email, token_hash, type:'magiclink'}) to
// establish the session — verifyOtp is UNGATED (confirmed by the
// 2026-06-29 prod probe), so no second captcha is needed.
//
// SCOPE: ONLY the /register surface. swift-handler stays in use for
// admin / company_admin / manager create_user calls (7 other call
// sites) — they remain untouched. Same security model overall: a
// service-role admin-create gated by a captcha token verified server-
// side.
//
// RESIDENT SIDE EFFECTS (ADD 2): swift-handler's create_user does ONLY
// admin.createUser — it does NOT create the user_roles row or any
// other side effects. Those happen client-side AFTER swift-handler
// returns: residents INSERT (RLS-gated), insert_user_role RPC, and
// companion-vehicle route call. Under the new flow those steps happen
// AFTER verifyOtp establishes the session — exactly as today, just
// with a different session-acquisition mechanism. So no role-row trap.
//
// FAIL-CLOSED: any non-OK siteverify or admin-create error returns 4xx
// before any DB write. A direct tokenless / forged POST to this route
// is rejected at the verifyTurnstile call.

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // ── 1. Parse body ───────────────────────────────────────────────
  let body: { captchaToken?: string; email?: string; password?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
  }
  const captchaToken = (body.captchaToken ?? '').trim()
  const email        = (body.email ?? '').trim().toLowerCase()
  const password     =  body.password ?? ''
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Email and password are required.' }, { status: 400 })
  }

  // ── 2. CAPTCHA siteverify (ADD 1 — the security boundary) ─────
  // Done server-side INSIDE this route, not by a client-orchestrated
  // upstream call. A bot that skips the client sequence and POSTs
  // straight here gets rejected before any admin.createUser call.
  // The IP forwarded to Cloudflare improves their bot signal.
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
  const verify = await verifyTurnstile(captchaToken, remoteIp)
  if (!verify.ok) {
    const status =
      verify.reason === 'missing_token'  ? 400 :
      verify.reason === 'missing_secret' ? 500 :
      verify.reason === 'network_error'  ? 503 :
                                            403
    return NextResponse.json(
      { ok: false, error: 'CAPTCHA verification failed. Please try again.', reason: verify.reason },
      { status },
    )
  }

  // ── 3. Service-role admin client ───────────────────────────────
  const supabase = createSupabaseServiceClient()

  // ── 4. Admin-create the auth user (mirrors swift-handler create_user) ──
  // email_confirm:true so the user can verifyOtp immediately + sign in
  // later with password (matches swift-handler's behavior). Same fail
  // shape as swift-handler so /register's existing error-handling line
  // (`json.error || json.message`) keeps working.
  const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) {
    // Most common case: email already exists. Surface the message verbatim
    // so /register's "The email may already be registered." fallback copy
    // stays accurate.
    return NextResponse.json(
      { ok: false, error: createErr.message },
      { status: 400 },
    )
  }

  // ── 5. Generate a magic-link token for ungated session acquisition ──
  // admin.generateLink does NOT send the email (Supabase admin-API
  // behavior — the email is only sent by user-facing methods like
  // signInWithOtp). The route returns the hashed_token to the client,
  // which calls verifyOtp({token_hash}) to establish the session.
  // verifyOtp is UNGATED — confirmed by the 2026-06-29 prod probe —
  // so no second captcha solve is required on the client.
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    // User was created but link generation failed. Surface as a partial
    // failure — /register should display "Account created but session
    // setup failed" so the user knows their account exists; they can
    // sign in via /login after manager approval. Email was already
    // confirmed via email_confirm:true so the password they entered
    // is the working credential.
    return NextResponse.json(
      { ok: false, error: 'Account created but session-link generation failed: ' + (linkErr?.message ?? 'no hashed_token returned') },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    user_id:    createData?.user?.id ?? null,
    email,
    token_hash: linkData.properties.hashed_token,
  })
}
