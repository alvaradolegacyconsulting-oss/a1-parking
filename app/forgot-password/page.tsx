'use client'
// B99 — anonymous "forgot my password" form. Single email input;
// triggers supabase.auth.resetPasswordForEmail. Supabase Auth has
// anti-enumeration baked in (always returns success regardless of
// whether the email exists), so our messaging matches: "If an account
// with that email exists, you'll receive a reset link shortly."
//
// The actual email is sent by Supabase Auth via the Resend SMTP pipe
// wired May 22. Template configured in Supabase Dashboard (Auth →
// Email Templates → Reset Password) to use {{ .ConfirmationURL }}
// which redirects to https://shieldmylot.com/reset-password with a
// PKCE token in the query string.

import { useRef, useState } from 'react'
import { supabase } from '../supabase'
// B213 — Turnstile widget for native captcha-gated resetPasswordForEmail.
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'

const GOLD = '#C9A227'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // B213 — captcha token + widget ref (reset-on-failure pattern).
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  async function submit() {
    if (!email.trim()) return
    // B213 — explicit captcha guard before resetPasswordForEmail.
    if (!captchaToken) {
      setError('Please complete the CAPTCHA challenge below before submitting.')
      return
    }
    setSubmitting(true)
    setError('')
    const redirectTo = typeof window === 'undefined'
      ? 'https://shieldmylot.com/reset-password'
      : `${window.location.origin}/reset-password`
    // B213 — threading captchaToken into options; ignored when toggle OFF.
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo, captchaToken })
    setSubmitting(false)
    if (error) {
      // B213 — token single-use; reset on any failure so user can retry.
      turnstileRef.current?.reset()
      setCaptchaToken(null)
      // Surface the error in case it's something other than enumeration
      // (e.g. rate limit). Otherwise success branch covers the happy + the
      // "no such email" cases identically per anti-enumeration policy.
      setError(error.message || 'Unable to send reset link. Try again in a moment.')
      return
    }
    setSubmitted(true)
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 380, width: '100%' }}>

        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>Reset your password</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot™</p>
        </div>

        {submitted ? (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>✓</div>
            <h2 style={{ color: '#86efac', fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Check your email</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
              If an account with that email exists, you&apos;ll receive a password reset link shortly.
            </p>
            <a href="/login" style={{ color: GOLD, fontSize: 13, textDecoration: 'none' }}>← Back to sign in</a>
          </div>
        ) : (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            {error && (
              <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{error}</p>
              </div>
            )}
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 12px' }}>
              Enter your account email and we&apos;ll send you a link to reset your password.
            </p>
            {/* B117 Rec A (reset-password variant) — same-browser guidance.
                Pre-link-issuance preemption: tells the user upfront that the
                recovery link is browser-context-bound (PKCE code_verifier),
                avoiding the most common B117 failure mode where the user
                clicks the link in a different browser than they started in. */}
            <p style={{ color: '#fbbf24', fontSize: 12, lineHeight: 1.5, margin: '0 0 16px', padding: '8px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6 }}>
              Open the reset link in this same browser — links don&apos;t work across browsers or after switching to incognito.
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email</label>
              <input type="email" value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
                placeholder="you@example.com"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            {/* B213 — Turnstile widget; submit gates on captchaToken. */}
            <div style={{ marginBottom: 14 }}>
              <TurnstileWidget ref={turnstileRef}
                               onVerify={setCaptchaToken}
                               onExpire={() => setCaptchaToken(null)}
                               onError={() => setCaptchaToken(null)} />
            </div>
            <button onClick={submit} disabled={!email.trim() || submitting || !captchaToken}
              style={{ width: '100%', padding: 13, background: (!email.trim() || submitting || !captchaToken) ? '#555' : GOLD, color: (!email.trim() || submitting || !captchaToken) ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: 15, border: 'none', borderRadius: 8, cursor: (!email.trim() || submitting || !captchaToken) ? 'not-allowed' : 'pointer' }}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <a href="/login" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>← Back to sign in</a>
            </div>
          </div>
        )}

      </div>
    </main>
  )
}
