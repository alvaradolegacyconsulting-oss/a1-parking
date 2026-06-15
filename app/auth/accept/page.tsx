'use client'
// B198 — interstitial-before-consume landing for invite + password-reset
// emails. Closes the prefetch-consumption hole: corporate-mail URL
// scanners (Defender Safe Links, Mimecast, Proofpoint, Apple Mail
// Privacy Protection, etc.) GET every link in arriving mail; the
// default {{ .ConfirmationURL }} points at Supabase's /auth/v1/verify
// which CONSUMES the single-use token on first GET. By the time the
// human clicks the link, the token is already spent — the auth log
// shows a 303-success immediately after invite_sent followed by a 403
// already-used when the user actually clicks (confirmed via UAT auth
// logs 2026-06-14).
//
// Option A fix: email template points HERE instead. This page reads
// token_hash from the URL into component state but does NOT call
// verifyOtp on mount. The token survives any number of prefetch GETs.
// Consumption only happens inside the onClick handler — a real human
// action no prefetcher will trigger.
//
// CRITICAL INVARIANT
//   No verifyOtp call may run in useEffect, in module-level code, or
//   anywhere triggered by render. Only inside onClick. The probe at
//   scripts/probe-b198-prefetch-interstitial.ts asserts the token
//   survives a simulated page load (server-side fetch of this URL).
//   If you ever add a verifyOtp-on-mount, that probe fails and prod
//   regresses to the pre-B198 hole.
//
// TWO EMAIL FLOWS THIS HANDLES
//   type=invite   — Supabase Auth inviteUserByEmail (CA Add-User D1,
//                   /api/admin/resend-invite, /api/billing/bulk-invite
//                   all share the same template). On success →
//                   /reset-password-required (existing B113 page).
//   type=recovery — Supabase Auth password-reset (resetPasswordForEmail).
//                   On success → /reset-password (existing B99 page).
//
// Both downstream pages already have their own OTP fallback (B117/B162
// pattern). The OTP fallback also exists ON this page as a secondary
// affordance for the case where the button click itself fails (already-
// consumed by some other prefetch lane, or the token actually expired).
//
// SUPABASE AUTH TEMPLATE CONFIG (Dashboard — Jose applies post-merge)
//   Invite user:
//     {{ .SiteURL }}/auth/accept?token_hash={{ .TokenHash }}&type=invite&next={{ .RedirectTo }}&email={{ .Email }}
//   Reset password:
//     {{ .SiteURL }}/auth/accept?token_hash={{ .TokenHash }}&type=recovery&next={{ .RedirectTo }}&email={{ .Email }}
//
// MIDDLEWARE
//   /auth/accept added to publicPaths so the interstitial renders
//   without an auth gate — the WHOLE point is this loads pre-session.

import { useEffect, useState } from 'react'
import { supabase } from '../../supabase'
import { isOtpExpiredOrUsed } from '../../lib/otp-errors'

const GOLD = '#C9A227'

// All Supabase Auth email-action types that consume a single-use token on
// GET via the default {{ .ConfirmationURL }} / /auth/v1/verify endpoint.
// Five today — invite + recovery shipped with B198; signup added by this
// commit; email_change + magiclink added proactively (inert until those
// templates are ever pointed here — they exist server-side and would
// inherit the prefetch hazard the moment they're activated).
//
// EmailOtpType in @supabase/auth-js types: 'signup' | 'invite' | 'magiclink'
// | 'recovery' | 'email_change' | 'email'. We don't include 'email' here
// because Supabase reserves it for the legacy generic flow; all five
// branded flows above cover production usage.
type AcceptType = 'invite' | 'recovery' | 'signup' | 'email_change' | 'magiclink'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'already_used' }
  | { kind: 'error'; message: string }
  | { kind: 'bad_params'; reason: string }

// Copy varies by type but the page structure is identical. Centralized so
// it's obvious which strings change per type. otpType maps to the verifyOtp
// EmailOtpType — same string for all current types (Supabase uses the same
// taxonomy on both sides), but the indirection keeps room for divergence.
const COPY: Record<AcceptType, {
  title: string
  subtitle: string
  primaryButton: string
  verifyingButton: string
  successHeading: string
  successDetail: string
  alreadyUsedHeading: string
  alreadyUsedDetail: string
  defaultNext: string
  otpType: 'invite' | 'recovery' | 'signup' | 'email_change' | 'magiclink'
}> = {
  invite: {
    title: 'Complete account setup',
    subtitle: 'You’ve been invited to ShieldMyLot. Click below to activate your account and set a password.',
    primaryButton: 'Complete setup',
    verifyingButton: 'Activating…',
    successHeading: 'Account activated',
    successDetail: 'Redirecting you to set your password…',
    alreadyUsedHeading: 'This invite can’t be used',
    alreadyUsedDetail: 'It may have already been activated, or expired. If you set up your account on another device or tab, sign in. If your invite expired, request a fresh invite — only an admin can re-send.',
    defaultNext: '/reset-password-required',
    otpType: 'invite',
  },
  recovery: {
    title: 'Reset your password',
    subtitle: 'Click below to continue with your password reset.',
    primaryButton: 'Continue',
    verifyingButton: 'Verifying…',
    successHeading: 'Verified',
    successDetail: 'Redirecting you to set a new password…',
    alreadyUsedHeading: 'This reset link can’t be used',
    alreadyUsedDetail: 'It may have already been used, or expired. Request a new password-reset email from the Sign In page.',
    defaultNext: '/reset-password',
    otpType: 'recovery',
  },
  signup: {
    // Self-serve flow lands here from the Confirm-signup template. Two
    // downstream pages handle the post-verification work via the `next`
    // URL param: /signup/verify (B66.3 self-serve checkout flow) and
    // /signup/redeem/verify (B65 proposal-code flow). Both already
    // handle "session already minted" through their useEffect getSession()
    // path — see flow-through smoke note in commit message.
    title: 'Confirm your account',
    subtitle: 'Welcome to ShieldMyLot. Click below to confirm your email and continue.',
    primaryButton: 'Confirm account',
    verifyingButton: 'Confirming…',
    successHeading: 'Confirmed',
    successDetail: 'Taking you to the next step…',
    alreadyUsedHeading: 'This confirmation link can’t be used',
    alreadyUsedDetail: 'It may have already been used, or expired. If you confirmed on another device, sign in. If the link expired, restart signup from the homepage.',
    defaultNext: '/signup/verify',
    otpType: 'signup',
  },
  email_change: {
    // Email-change template is not currently dispatched by any app code
    // (no auth.updateUser({ email }) call sites). Wired here so it CANNOT
    // open the prefetch hole if/when an email-change UI ships in the
    // user dashboard. Email-change sends TWO emails (to old + new
    // addresses); both consume single-use tokens. Both should route here.
    title: 'Confirm email change',
    subtitle: 'Click below to confirm your new email address.',
    primaryButton: 'Confirm change',
    verifyingButton: 'Confirming…',
    successHeading: 'Email updated',
    successDetail: 'Redirecting…',
    alreadyUsedHeading: 'This confirmation link can’t be used',
    alreadyUsedDetail: 'It may have already been used, or expired. Sign in to manage your account.',
    defaultNext: '/',
    otpType: 'email_change',
  },
  magiclink: {
    // Magic-link template is not currently dispatched (no signInWithOtp
    // call sites). Wired proactively for the same reason as email_change.
    // If passwordless sign-in ever launches, the template flips here and
    // the prefetch hazard is closed-by-default.
    title: 'Sign in',
    subtitle: 'Click below to sign in to your account.',
    primaryButton: 'Sign in',
    verifyingButton: 'Signing in…',
    successHeading: 'Signed in',
    successDetail: 'Redirecting…',
    alreadyUsedHeading: 'This sign-in link can’t be used',
    alreadyUsedDetail: 'It may have already been used, or expired. Request a new sign-in link.',
    defaultNext: '/',
    otpType: 'magiclink',
  },
}

const ACCEPTED_TYPES: ReadonlySet<AcceptType> = new Set<AcceptType>([
  'invite', 'recovery', 'signup', 'email_change', 'magiclink',
])

function isAllowedNext(next: string): boolean {
  // Same-origin allowlist via WHATWG URL resolution. Reject anything that
  // would navigate off-origin or use a non-web protocol.
  //
  // B205 — the prior implementation rejected ANY input not starting with
  // '/' (only same-origin relative paths). That excluded legitimate
  // Supabase template substitutions: {{ .RedirectTo }} resolves to the
  // full emailRedirectTo URL (e.g. 'https://shieldmylot.com/signup/redeem/verify'),
  // which falls through to the defaultNext fallback → wrong-page landing
  // for redeem signup cross-context (the actual repro that surfaced this).
  //
  // It also missed backslash bypasses: '/\evil.com' starts with '/' and
  // not '//' → the prior check ALLOWED, but the browser's URL parser
  // normalizes '\' → '/' in special-scheme URLs (WHATWG URL spec), so
  // window.location.href = '/\evil.com' actually navigates to
  // https://evil.com/. Empirically verified via
  // scripts/probe-b205-open-redirect.ts: '/\evil.com' and '/\/evil.com'
  // both resolve to https://evil.com/.
  //
  // V3 (this implementation): resolve `next` as a URL against the current
  // page's URL — that's exactly what window.location.href = next does on
  // assignment — then assert (a) the protocol is http/https (excludes
  // javascript:, data:, file:, vbscript:, etc.) and (b) the resolved
  // origin matches the current origin. Matches the browser's actual
  // navigation semantics, so any input that would navigate off-origin is
  // correctly rejected.
  //
  // 23/23 smoke pass on probe-b205-open-redirect.ts (covers relative +
  // absolute same-origin, lookalike subdomains, protocol-relative,
  // backslash variants, non-web schemes, CRLF, fragment-only, query-only).
  if (!next || typeof next !== 'string') return false
  try {
    const resolved = new URL(next, window.location.href)
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return false
    return resolved.origin === window.location.origin
  } catch {
    return false
  }
}

export default function AuthAcceptPage() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [tokenHash, setTokenHash] = useState('')
  const [type, setType] = useState<AcceptType | null>(null)
  const [next, setNext] = useState('')
  const [email, setEmail] = useState('')

  // OTP fallback secondary-affordance state. Pre-fills from ?email= if the
  // template includes it (mirrors /reset-password-required B117 Phase 2).
  const [otpEmail, setOtpEmail] = useState('')
  const [otpToken, setOtpToken] = useState('')
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpError, setOtpError] = useState('')
  const [showOtp, setShowOtp] = useState(false)

  // Mount-time URL parse. CRITICAL: this is the ONLY side effect that runs
  // on mount. It reads URL params into state. It does NOT call verifyOtp.
  // If you ever add a verifyOtp call here, the prefetch hole reopens.
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const th  = url.searchParams.get('token_hash') ?? ''
      const tp  = url.searchParams.get('type')       ?? ''
      const nx  = url.searchParams.get('next')       ?? ''
      const em  = url.searchParams.get('email')      ?? ''

      if (!ACCEPTED_TYPES.has(tp as AcceptType)) {
        setStatus({ kind: 'bad_params', reason: 'Unsupported link type. This URL may have been copied incorrectly.' })
        return
      }
      if (!th) {
        setStatus({ kind: 'bad_params', reason: 'Missing token. This URL may be incomplete.' })
        return
      }

      setTokenHash(th)
      setType(tp as AcceptType)
      setNext(isAllowedNext(nx) ? nx : COPY[tp as AcceptType].defaultNext)
      setEmail(em)
      setOtpEmail(em.trim().toLowerCase())
      setStatus({ kind: 'ready' })
    } catch {
      setStatus({ kind: 'bad_params', reason: 'Could not read URL parameters.' })
    }
  }, [])

  async function handlePrimaryClick() {
    if (status.kind !== 'ready' || !type || !tokenHash) return
    setStatus({ kind: 'verifying' })
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: COPY[type].otpType,
    })
    if (error) {
      if (isOtpExpiredOrUsed(error)) {
        setStatus({ kind: 'already_used' })
        return
      }
      setStatus({ kind: 'error', message: error.message || 'Verification failed.' })
      return
    }
    setStatus({ kind: 'success' })
    setTimeout(() => { window.location.href = next }, 600)
  }

  async function submitOtp() {
    if (!type) return
    if (!otpEmail.trim() || !otpToken.trim()) return
    setOtpSubmitting(true)
    setOtpError('')
    const { data, error } = await supabase.auth.verifyOtp({
      email: otpEmail.trim().toLowerCase(),
      token: otpToken.trim(),
      type: COPY[type].otpType,
    })
    setOtpSubmitting(false)
    if (error) {
      if (isOtpExpiredOrUsed(error)) {
        setStatus({ kind: 'already_used' })
        return
      }
      setOtpError(error.message || 'Verification failed. Check the code and try again.')
      return
    }
    if (!data?.user) {
      setOtpError('Verification succeeded but no user was returned. Try refreshing.')
      return
    }
    setStatus({ kind: 'success' })
    setTimeout(() => { window.location.href = next }, 600)
  }

  const copy = type ? COPY[type] : null

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 420, width: '100%' }}>

        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>
            {copy?.title ?? 'ShieldMyLot'}
          </h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot&trade;</p>
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Loading…</p>
          </div>
        )}

        {status.kind === 'bad_params' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Link not recognized</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              {status.reason} If you arrived here from an email, try opening the link directly from
              your inbox — some mail clients break long URLs when forwarded or copied.
            </p>
            <a href="/login" style={{ display: 'block', width: '100%', padding: 13, background: 'transparent', color: 'white', fontWeight: 'bold', fontSize: 14, border: '1px solid #3a4055', borderRadius: 8, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Sign in
            </a>
          </div>
        )}

        {(status.kind === 'ready' || status.kind === 'verifying' || status.kind === 'error') && copy && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 22px', textAlign: 'center' }}>
              {copy.subtitle}
            </p>
            {email && (
              <p style={{ color: '#666', fontSize: 12, lineHeight: 1.5, margin: '0 0 18px', textAlign: 'center' }}>
                For <span style={{ color: '#94a3b8' }}>{email}</span>
              </p>
            )}
            {status.kind === 'error' && (
              <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{status.message}</p>
              </div>
            )}
            <button onClick={handlePrimaryClick} disabled={status.kind === 'verifying'}
              style={{ width: '100%', padding: 14, background: status.kind === 'verifying' ? '#555' : GOLD, color: status.kind === 'verifying' ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: 15, border: 'none', borderRadius: 8, cursor: status.kind === 'verifying' ? 'not-allowed' : 'pointer' }}>
              {status.kind === 'verifying' ? copy.verifyingButton : copy.primaryButton}
            </button>

            <div style={{ borderTop: '1px solid #2a2f3d', marginTop: 22, paddingTop: 18 }}>
              {!showOtp ? (
                <button onClick={() => setShowOtp(true)}
                  style={{ width: '100%', padding: 10, background: 'transparent', color: '#94a3b8', fontSize: 12, border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  Have a code instead? Enter it here.
                </button>
              ) : (
                <>
                  <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5, margin: '0 0 14px' }}>
                    If the button above doesn’t work (or you’re on a different device than where the email
                    arrived), enter the code from the email below.
                  </p>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email</label>
                    <input type="email" value={otpEmail} autoComplete="email"
                      onChange={e => setOtpEmail(e.target.value)}
                      placeholder="you@example.com"
                      style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Code</label>
                    <input type="text" inputMode="numeric" autoComplete="one-time-code" value={otpToken}
                      onChange={e => setOtpToken(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && otpEmail.trim() && otpToken.trim() && !otpSubmitting && submitOtp()}
                      placeholder="6–8 digit code"
                      style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box', letterSpacing: '0.1em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
                  </div>
                  {otpError && (
                    <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
                      <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{otpError}</p>
                    </div>
                  )}
                  <button onClick={submitOtp} disabled={!otpEmail.trim() || !otpToken.trim() || otpSubmitting}
                    style={{ width: '100%', padding: 12, background: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#555' : '#1e2535', color: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#888' : 'white', fontWeight: 'bold', fontSize: 13, border: '1px solid #3a4055', borderRadius: 8, cursor: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? 'not-allowed' : 'pointer' }}>
                    {otpSubmitting ? 'Verifying…' : 'Verify with code'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {status.kind === 'success' && copy && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>✓</div>
            <h2 style={{ color: '#86efac', fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>{copy.successHeading}</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{copy.successDetail}</p>
          </div>
        )}

        {status.kind === 'already_used' && copy && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>{copy.alreadyUsedHeading}</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              {copy.alreadyUsedDetail}
            </p>
            {type === 'invite' ? (
              <a href="mailto:support@shieldmylot.com?subject=Invite%20expired%20%E2%80%94%20need%20new%20invite"
                style={{ display: 'block', width: '100%', padding: 13, background: GOLD, color: '#0f1117', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, marginBottom: 12, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                Contact your administrator
              </a>
            ) : (
              <a href="/forgot-password"
                style={{ display: 'block', width: '100%', padding: 13, background: GOLD, color: '#0f1117', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, marginBottom: 12, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                Request a new password-reset email
              </a>
            )}
            <a href="/login" style={{ display: 'block', width: '100%', padding: 13, background: 'transparent', color: 'white', fontWeight: 'bold', fontSize: 14, border: '1px solid #3a4055', borderRadius: 8, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Sign in
            </a>
          </div>
        )}

      </div>
    </main>
  )
}
