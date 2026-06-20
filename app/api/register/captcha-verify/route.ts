import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { verifyTurnstile } from '../../../lib/turnstile-verify'

// /api/register/captcha-verify — single-responsibility CAPTCHA gate for the
// /register flow (resident self-registration via swift-handler, not native
// supabase.auth.signUp).
//
// CALLED FIRST IN /register
// Order of operations in app/register/page.tsx:
//   1. residents-by-email existence pre-check (client)
//   2. POST { captchaToken } here → 200 if valid, 4xx if not
//   3. POST to swift-handler (create_user) — gated by step 2's 200
//   4. signInWithPassword
//   5. residents row INSERT
//   6. insert_user_role RPC
//   7. /api/register/companion-vehicle (B209 route) — vehicle insert
//   8. audit_logs REGISTRATION_TOS_ACCEPTED
//   9. signOut
// If step 2 fails, the flow aborts. No swift-handler call, no auth.users row.
//
// SINGLE-USE TOKEN DISCIPLINE
// Turnstile tokens are single-use by design (per Cloudflare). This route
// verifies the token ONCE; downstream routes (companion-vehicle) do NOT
// re-verify — they trust that the caller's session exists only because the
// caller cleared this gate first. Belt-and-suspenders verification on the
// same token would fail on the second call.
//
// FAIL-CLOSED
// Any non-{ok:true} from verifyTurnstile blocks the response. The shared
// helper handles missing_token / missing_secret / rejected / network_error;
// this route maps each to an HTTP status + friendly client copy.

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  let body: { captchaToken?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body.', error_class: 'bad_body' },
      { status: 400 },
    )
  }
  const token = body.captchaToken
  // x-forwarded-for is set by Vercel/Cloudflare; first hop is the client.
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()

  const result = await verifyTurnstile(token, remoteIp)
  if (result.ok) {
    return NextResponse.json({ ok: true })
  }

  // Map fail-reason to HTTP status + user-facing message. Engineer-side
  // detail goes in the error_class + (where available) detail field;
  // user-visible message is friendly.
  switch (result.reason) {
    case 'missing_token':
      return NextResponse.json(
        { ok: false, error: 'CAPTCHA challenge was not completed.', error_class: 'missing_token' },
        { status: 400 },
      )
    case 'missing_secret':
      // Vercel env misconfig. Same fail-closed posture as B66.1 STRIPE_MODE —
      // explicit 500 so the engineer sees it, friendly message so the user
      // gets a clear "try again later" without leaking config state.
      console.error('[B-CAPTCHA] /api/register/captcha-verify: TURNSTILE_SECRET_KEY not set on Vercel')
      return NextResponse.json(
        { ok: false, error: 'CAPTCHA service is not configured. Please contact support.', error_class: 'missing_secret' },
        { status: 500 },
      )
    case 'rejected':
      console.warn('[B-CAPTCHA] /api/register/captcha-verify: token rejected', { detail: result.detail })
      return NextResponse.json(
        { ok: false, error: 'CAPTCHA verification failed. Please try again.', error_class: 'rejected' },
        { status: 400 },
      )
    case 'network_error':
      console.error('[B-CAPTCHA] /api/register/captcha-verify: network error', { detail: result.detail })
      return NextResponse.json(
        { ok: false, error: 'CAPTCHA service is temporarily unavailable. Please try again in a moment.', error_class: 'network_error' },
        { status: 503 },
      )
    default:
      // Unreachable — keeps TS exhaustiveness; if reason set grows, this
      // surfaces a generic 500.
      return NextResponse.json(
        { ok: false, error: 'CAPTCHA verification failed.', error_class: 'unknown' },
        { status: 500 },
      )
  }
}
