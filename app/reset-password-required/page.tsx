'use client'
// B113 — first-login force-reset landing for bulk-uploaded users.
// Companion to /reset-password (B99); the two flows are now SYMMETRIC
// (both auto-login post-updateUser + rely on the portal-layout consent
// gate → /consent to enforce missing legal consents). See notes (2) +
// (2a) below for the history.
//
//   (1) Auth source: Supabase Auth invite (inviteUserByEmail) instead
//       of password-reset email. Both flows mint a session via the
//       URL hash on landing (detectSessionInUrl=true); architecturally
//       same from this page's perspective.
//
//   (2) 🔴 SUPERSEDED 2026-08-21 (B199 fix, Mateo Option 3) — the
//       original H.2 tradeoff was "sign out + redirect to /login" so
//       bulk-uploaded users hit the ToS modal that used to live on
//       /login. That tradeoff assumed the friction cost was "one extra
//       credential entry"; a live A1 support call (Amanda Canchola,
//       manager, 2026-08-21) showed the actual delivered cost was
//       "password appears not to have worked" — the 700ms success flash
//       + login-screen-appears reads as failure to the user, no auth
//       error to distinguish from a real password miss.
//
//   (2a) 🟢 CURRENT — post-success: redirect straight to /consent.
//       /consent (P1 CONSENT HARD-GATE Commit 2, 2026-07-16) is a
//       dedicated authenticated route that recomputes missing docs
//       server-side, renders LegalGateAccordion, and calls
//       accept_all_pending_consents + redirectByRole on accept. If the
//       user has no missing consents, /consent redirects immediately
//       to the portal (idempotent as a URL). The consent enforcement
//       moved from "deny the session so /login fires the modal" to
//       "grant the session and route to a page whose entire job is
//       the gate" — a stronger guarantee than the /login modal it
//       replaced, since Commit 3 wired portal-layout server gates on
//       every authenticated page (see app/*/layout.tsx uses of
//       hasCurrentConsents) so consent cannot be bypassed by direct
//       navigation regardless of how the user arrived authenticated.
//       Closes the flow asymmetry with /reset-password.
//
//   (3) Clears must_change_password=true on user_roles via the
//       set_must_change_password SECURITY DEFINER RPC (B82 retrofit
//       grants EXECUTE TO authenticated only). Bulk-uploaded users
//       arrive with must_change_password=true set by the bulk-invite
//       flow (commit 2 work); clearing here avoids the post-login
//       /change-password redirect (line 36-37 of app/login/page.tsx)
//       on any later manual sign-in.
//
// Graceful-degrade pattern matches /login's accept_tos() RPC call: if
// set_must_change_password fails, the user sees /change-password on
// next login + can set the same password again. Mild wart, not
// catastrophic.

import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { validatePassword } from '../lib/password-rules'
import { isOtpExpiredOrUsed } from '../lib/otp-errors'

const GOLD = '#C9A227'

type Status =
  | { kind: 'loading' }
  | { kind: 'no_session' }
  | { kind: 'ready'; user: User }
  | { kind: 'updating' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }
  | { kind: 'already_verified' }   // B162: verifyOtp returned otp_expired (already-used OR truly-expired; indistinguishable client-side)

export default function ResetPasswordRequired() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // B117 Phase 2 — OTP fallback state. Email pre-fills from ?email=
  // URL param (set by the new Invite-user template); user can override.
  const [otpEmail, setOtpEmail] = useState('')
  const [otpToken, setOtpToken] = useState('')
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpError, setOtpError] = useState('')

  // Detect the invite-minted session. Same shape as /reset-password +
  // /signup/verify: onAuthStateChange + getSession in parallel with 4s
  // fallback timeout. Supabase Auth invite sends a hash-fragment URL;
  // detectSessionInUrl=true (default) picks it up on mount.
  useEffect(() => {
    let resolved = false
    let cancelled = false

    // B117 Phase 2 — pre-fill OTP email from URL param (new template
    // includes ?email={{ .Email }} appended to ConfirmationURL).
    try {
      const url = new URL(window.location.href)
      const e = url.searchParams.get('email')
      if (e) setOtpEmail(e.trim().toLowerCase())
    } catch { /* SSR safety */ }

    function onUser(user: User | null) {
      if (resolved || cancelled) return
      if (!user) return
      resolved = true
      setStatus({ kind: 'ready', user })
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      onUser(session?.user ?? null)
    })
    supabase.auth.getSession().then(({ data }) => onUser(data.session?.user ?? null))

    // 2026-08-21 (Mateo B199 fold-in) — extended 4s → 15s.
    // A1's managers are on phones, often cellular, often in a parking
    // lot. 4s to detect a session was optimistic there, and the OTP
    // fallback card ("Verify your invite") would read as *another*
    // failure on top of the invite one. 15s is closer to "the request
    // actually resolves" without going indefinite; the OTP fallback
    // remains a last-resort recovery rather than an on-timer surprise.
    const timeoutId = window.setTimeout(() => {
      if (!resolved && !cancelled) {
        resolved = true
        setStatus({ kind: 'no_session' })
      }
    }, 15000)

    return () => {
      cancelled = true
      subscription.unsubscribe()
      window.clearTimeout(timeoutId)
    }
  }, [])

  const pwErr = validatePassword(password)
  const matchErr = password && confirmPassword && password !== confirmPassword ? 'Passwords do not match.' : null
  const formOk = !pwErr && !matchErr && password.length > 0 && confirmPassword.length > 0

  // B117 Phase 2 — OTP fallback. User pastes the code from the invite
  // email; verifyOtp({type:'invite'}) mints a session like the link path.
  // After success, the ready-state block renders the set-password form.
  // Bypasses the useEffect `resolved` lockout since the no_session card
  // only shows after the 4s timeout fires.
  async function submitOtp() {
    if (!otpEmail.trim() || !otpToken.trim()) return
    setOtpSubmitting(true)
    setOtpError('')
    const { data, error } = await supabase.auth.verifyOtp({
      email: otpEmail.trim().toLowerCase(),
      token: otpToken.trim(),
      type: 'invite',
    })
    setOtpSubmitting(false)
    if (error) {
      // B162 — Supabase returns 'otp_expired' for both "already used by
      // another tab/device" AND "truly expired (24h elapsed)." No client-
      // side distinguisher. Recovery card serves both cases honestly.
      if (isOtpExpiredOrUsed(error)) {
        setStatus({ kind: 'already_verified' })
        return
      }
      setOtpError(error.message || 'Verification failed. Check the code and try again.')
      return
    }
    if (!data?.user) {
      setOtpError('Verification succeeded but no user was returned. Try refreshing.')
      return
    }
    setStatus({ kind: 'ready', user: data.user })
  }

  async function submit() {
    if (status.kind !== 'ready' || !formOk) return
    setStatus({ kind: 'updating' })

    const { error: updErr } = await supabase.auth.updateUser({ password })
    if (updErr) {
      setStatus({ kind: 'error', message: updErr.message || 'Password update failed.' })
      return
    }

    // Clear must_change_password flag so the next login doesn't
    // redirect to /change-password unnecessarily. Graceful degrade:
    // if the RPC fails, log + continue. The user just sees
    // /change-password on next login and sets the same password again.
    // SECURITY DEFINER RPC; authenticated-only per B82 retrofit.
    const email = status.user.email
    if (email) {
      const { error: clearErr } = await supabase.rpc('set_must_change_password', {
        p_email: email,
        p_value: false,
      })
      if (clearErr) console.error('set_must_change_password RPC failed:', clearErr)
    }

    setStatus({ kind: 'success' })

    // 🟢 2026-08-21 B199 fix — auto-login + redirect to /consent.
    // 🔴 SUPERSEDES the prior H.2 signOut + /login redirect (see
    //    header note (2)). Amanda Canchola (A1 manager) 2026-08-21
    //    call proved the friction cost of that path was mis-priced.
    //
    // /consent handles the consent-gate. If the user has no missing
    // consents (impossible for bulk-invited/first-time-set-password
    // users, but possible in future), /consent redirects immediately
    // to the portal — idempotent as a URL. On accept, /consent calls
    // accept_all_pending_consents + redirectByRole. The portal-layout
    // consent gate on every authenticated portal (app/*/layout.tsx
    // hasCurrentConsents) is the additional defense-in-depth: even if
    // a user landed on the portal directly with missing consents, they
    // would be redirected to /consent from there.
    //
    // 700ms delay preserved so the success flash registers before nav.
    setTimeout(() => {
      window.location.href = '/consent'
    }, 700)
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 380, width: '100%' }}>

        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>Welcome — set your password</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot™</p>
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Verifying your invite link…</p>
          </div>
        )}

        {status.kind === 'no_session' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>📧</div>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Verify your invite</h2>
            {/* B117 Phase 2 — dual recovery: PKCE link OR OTP code. The link
                is browser-context-bound (code_verifier in localStorage); the
                code works from any browser. Invite path uses type='invite'
                per Supabase docs (inviteUserByEmail tokens). */}
            <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 1.6, margin: '0 0 18px' }}>
              If your invite email includes a verification code, enter it below — the code works from
              any browser. If you only see a link, it must be opened in the same browser session
              (switching browsers breaks the link). If your link has expired, contact your
              administrator for a new invite.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email</label>
              <input type="email" value={otpEmail} autoComplete="email"
                onChange={e => setOtpEmail(e.target.value)}
                placeholder="you@example.com"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Verification code</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" value={otpToken}
                onChange={e => setOtpToken(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && otpEmail.trim() && otpToken.trim() && !otpSubmitting && submitOtp()}
                placeholder="6–8 digit code"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box', letterSpacing: '0.1em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
            </div>
            {otpError && (
              <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
                <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{otpError}</p>
              </div>
            )}
            <button onClick={submitOtp} disabled={!otpEmail.trim() || !otpToken.trim() || otpSubmitting}
              style={{ width: '100%', padding: 13, background: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#555' : GOLD, color: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, cursor: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? 'not-allowed' : 'pointer', marginBottom: 18 }}>
              {otpSubmitting ? 'Verifying…' : 'Verify and continue'}
            </button>

            <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="/login" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Sign in</a>
            </div>
          </div>
        )}

        {/* B162 — recovery card for verifyOtp 'otp_expired' on the invite
            flow. THIS PAGE IS THE EXCEPTION: no self-serve restart (admin
            owns inviteUserByEmail; user can't re-trigger). Per Confirm 2,
            the mailto: contact-admin/support is the LOAD-BEARING primary
            action — it's the only working path for the truly-expired case.
            Sign in stays secondary for the cross-device-set-password case.
            This is the B113 bulk-invite landing — highest-traffic surface
            for this exact error during UAT. */}
        {status.kind === 'already_verified' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>This invite can&apos;t be used</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              It may have already been used, or expired. If you set up your account on another device
              or tab, sign in below. If your invite expired, request a fresh invite — only an admin can
              re-send.
            </p>
            <a href="mailto:support@shieldmylot.com?subject=Invite%20expired%20%E2%80%94%20need%20new%20invite"
              style={{ display: 'block', width: '100%', padding: 13, background: GOLD, color: '#0f1117', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, marginBottom: 12, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Contact your administrator
            </a>
            <a href="/login" style={{ display: 'block', width: '100%', padding: 13, background: 'transparent', color: 'white', fontWeight: 'bold', fontSize: 14, border: '1px solid #3a4055', borderRadius: 8, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Sign in
            </a>
            <p style={{ color: '#666', fontSize: 11, textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>
              Contacting support routes your request to whoever sent the invite.
            </p>
          </div>
        )}

        {(status.kind === 'ready' || status.kind === 'updating' || status.kind === 'error') && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' }}>
              Set a new password for your account. You&apos;ll then be asked to sign in with the password you just chose.
            </p>
            {status.kind === 'error' && (
              <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{status.message}</p>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>New password</label>
              <input type="password" autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
              {password && pwErr && <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>{pwErr}</p>}
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Confirm password</label>
              <input type="password" autoComplete="new-password" value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && formOk && submit()}
                placeholder="Re-enter password"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
              {matchErr && <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>{matchErr}</p>}
            </div>
            <button onClick={submit} disabled={!formOk || status.kind === 'updating'}
              style={{ width: '100%', padding: 13, background: !formOk || status.kind === 'updating' ? '#555' : GOLD, color: !formOk || status.kind === 'updating' ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: 15, border: 'none', borderRadius: 8, cursor: !formOk || status.kind === 'updating' ? 'not-allowed' : 'pointer' }}>
              {status.kind === 'updating' ? 'Setting password…' : 'Set password'}
            </button>
          </div>
        )}

        {status.kind === 'success' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>✓</div>
            <h2 style={{ color: '#86efac', fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>Password set</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: 0 }}>Redirecting you to sign in…</p>
          </div>
        )}

      </div>
    </main>
  )
}
