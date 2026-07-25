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

// ── 2026-07-25 attach-hardening ──────────────────────────────────
// The route handles TWO shapes with byte-identical caller-visible output:
//   • create — email is new, admin-create auth user, mint magic-link
//   • attach — email exists (createUser returns email_exists / 422),
//              skip create, resolve existing user_id, mint magic-link
// Response shape is byte-identical across both. No `mode` field. Attach
// path never touches the existing auth user beyond READ-ONLY id
// resolution. Password from the request body is IGNORED on the attach
// path — the existing user's password is preserved. This is the
// load-bearing property-A-login guarantee: silent attach must not damage
// the caller's login at their prior property. Enforce by construction —
// this route calls NO updateUserById / password / email_confirm /
// metadata mutation anywhere on the attach branch.
//
// Discriminator locked (probe 2026-07-25):
//   err.code === 'email_exists' AND err.status === 422 (AuthApiError)
// Never message-match — Supabase reserves the right to reword.
//
// ENUMERATION BAR:
//   • Success paths (create + attach) return identical status + body shape.
//   • The two 500 branches (not-found post-attach-resolve + generateLink
//     failure) return the same message class so a 500 doesn't tell the
//     caller which path produced it.
//   • Non-duplicate createErr returns a generic 400 (not the raw SDK
//     message) — a weak-password on a NEW email must not distinguish
//     from a weak-password on an EXISTING email (the existing one now
//     hits the attach path and returns 200 instead of createUser's 400).
//   • RESIDUAL — timing side-channel: attach path calls listUsers
//     (O(users), paginated) while create path doesn't. Existing emails
//     respond measurably slower. Filed as pre-signup blocker:
//     docs/backlog/attach-endpoint-listusers-timing-enumeration.md.

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

  // ── 4. Admin-create OR resolve-existing (silent attach) ────────
  // Two-shape branch: create for new emails, attach for existing.
  // Discriminator locked to (err.code='email_exists' + err.status=422)
  // per 2026-07-25 probe against this project's SDK version. See
  // scripts/probe-createuser-duplicate-discriminator-ONE-TIME.ts.
  let userId: string | null = null
  const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) {
    const isDuplicate =
      (createErr as { code?: string }).code === 'email_exists' &&
      createErr.status === 422
    if (!isDuplicate) {
      // Non-duplicate createUser failure (weak_password, validation_failed,
      // rate_limit, etc.). Return a GENERIC 400 rather than createErr.message —
      // the raw SDK message would let a caller who submits a bad-password body
      // distinguish "existing email (200 attach)" from "new email
      // (400 weak_password)". Generic message closes that enumeration axis.
      return NextResponse.json(
        { ok: false, error: 'Registration failed. Please check your input and try again.' },
        { status: 400 },
      )
    }
    // Attach path — resolve existing auth user_id via listUsers.
    userId = await resolveExistingAuthUserId(supabase, email)
    if (!userId) {
      // createUser said the email exists but listUsers didn't find it —
      // race with a concurrent delete, or listUsers pagination limit hit.
      // Return the SAME message class as the generateLink 500 below so
      // a 500 doesn't distinguish which code path fired. The message is
      // deliberately inaccurate ("Account created" — nothing was created
      // on this branch) to match the sibling 500's shape; uniformity of
      // 500-message beats precision because the caller can't act on
      // either kind of 500.
      return NextResponse.json(
        { ok: false, error: 'Account created but session-link generation failed: could not resolve session.' },
        { status: 500 },
      )
    }
  } else {
    userId = createData?.user?.id ?? null
  }

  // ── 5. Generate a magic-link token for ungated session acquisition ──
  // admin.generateLink does NOT send the email (Supabase admin-API
  // behavior — the email is only sent by user-facing methods like
  // signInWithOtp). The route returns the hashed_token to the client,
  // which calls verifyOtp({token_hash}) to establish the session.
  // verifyOtp is UNGATED — confirmed by the 2026-06-29 prod probe —
  // so no second captcha solve is required on the client.
  // Works for BOTH new (just-created) and existing (attach) users.
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
    user_id:    userId,
    email,
    token_hash: linkData.properties.hashed_token,
  })
}

/**
 * Resolve an existing auth.users id by email via paginated listUsers.
 * Matches the codebase pattern in prelaunch-pm-driver-orphan-cleanup
 * (Supabase JS Admin API does not support server-side email filtering
 * on listUsers as of the SDK version in use — probe-verified 2026-07-25).
 * Returns null if not found within PAGE_LIMIT * PAGE_SIZE users.
 *
 * READ-ONLY: this function only READS auth.users. Never mutates.
 * Load-bearing for the property-A-login guarantee — see route header.
 */
async function resolveExistingAuthUserId(
  admin: ReturnType<typeof createSupabaseServiceClient>,
  email: string,
): Promise<string | null> {
  const PAGE_SIZE = 1000
  const PAGE_LIMIT = 10   // scale ceiling: 10,000 users; A1-era is < 100
  const target = email.toLowerCase()
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE })
    if (error) return null
    const found = data?.users?.find(u => (u.email ?? '').toLowerCase() === target)
    if (found) return found.id
    if (!data?.users?.length || data.users.length < PAGE_SIZE) return null
  }
  return null   // exceeded PAGE_LIMIT pages; caller treats same as not-found
}
