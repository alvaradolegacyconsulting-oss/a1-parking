import 'server-only'

// Cloudflare Turnstile server-side verification helper.
//
// Used by the two CAPTCHA wrapper routes (the non-native paths):
//   • /api/register/captcha-verify   — gates /register before swift-handler
//   • /api/visitor/create-pass       — gates /visitor before create_visitor_pass RPC
//
// The native paths (/signup, /signup/redeem via supabase.auth.signUp + Supabase
// Dashboard CAPTCHA toggle) do NOT use this helper — Supabase verifies the token
// server-side itself.
//
// FAIL-CLOSED DISCIPLINE
//   Every non-{ok:true} path is a refusal. Caller MUST treat anything other than
//   ok:true as "do not proceed to the protected action." The wrappers return 4xx/5xx
//   accordingly and surface a friendly retry message to the client.
//
// 5-SECOND TIMEOUT (load-bearing)
//   Cloudflare's /siteverify endpoint is normally <500ms. A slowdown without a
//   timeout would hang the entire submit (form-submit fetch awaits this verify).
//   AbortController bounds the wait; timeout lands in the 'network_error' branch
//   so it stays fail-closed — caller returns 503 + friendly "try again in a
//   moment" message, NOT an unhandled throw, NOT a silent pass-through.
//
// MISSING SECRET = FAIL-CLOSED (deploy-time watch)
//   If TURNSTILE_SECRET_KEY is unset on the Vercel env (Production scope), every
//   verify returns {ok:false, reason:'missing_secret'} → wrappers 500 → signup/
//   visitor are entirely broken. This is the RIGHT posture (same as B66.1's
//   STRIPE_MODE fail-closed) — clear failure mode at deploy time vs letting bot
//   traffic through silently. First post-deploy smoke must be a valid-token
//   submit; if it 500s with missing_secret, fix Vercel before debugging further.

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_token' | 'missing_secret' | 'rejected' | 'network_error'; detail?: string }

const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5_000

export async function verifyTurnstile(token: string | null | undefined, remoteIp?: string): Promise<VerifyResult> {
  if (!token || token.trim().length === 0) {
    return { ok: false, reason: 'missing_token' }
  }
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY env var not set — fail-closed')
    return { ok: false, reason: 'missing_secret' }
  }

  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp) body.set('remoteip', remoteIp)

  // 5s AbortController timeout — Cloudflare slowdown must NOT hang the entire
  // form submit. Timeout falls through to the catch block below, lands in the
  // network_error branch, fail-closed (caller returns 503 + friendly retry).
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    if (json?.success === true) return { ok: true }
    return {
      ok: false,
      reason: 'rejected',
      detail: JSON.stringify(json?.['error-codes'] ?? []),
    }
  } catch (e) {
    const err = e as Error
    const isAbort = err.name === 'AbortError'
    return {
      ok: false,
      reason: 'network_error',
      detail: isAbort ? `timeout after ${TIMEOUT_MS}ms` : err.message,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
