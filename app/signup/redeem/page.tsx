'use client'
// B65.3: proposal-code redemption entry. Reads ?code=XXX from URL,
// validates via validate_proposal_code RPC (anon-callable per B65.1),
// shows tier summary, then collects email + password and calls
// supabase.auth.signUp() with the proposal code stashed in user_metadata
// (per pre-flight finding #8 — avoids PKCE ?code= collision at the email
// redirect URL). On success, lands on the "check your email" state.
//
// Scope guard: no ToS checkbox here (pre-flight #4 deferred it to the
// /verify surface that runs the activation RPC). No company-info form
// (B65.4). Re-validation of the code on /verify is also B65.4.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../../supabase'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Validation =
  | { kind: 'loading' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'valid'
      tier_type: string
      tier: string
      client_name: string | null
      expires_at: string | null
      has_custom_pricing: boolean
    }

type Submission =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'sent'; email: string }
  | { kind: 'already_registered' }
  | { kind: 'error'; message: string }

// Reason text for invalid codes. All paths converge on contact support so
// support can verify the user's intent without us leaking which path failed
// to anyone with a guessed code.
function invalidCopy(reason: string): { title: string; body: string } {
  switch (reason) {
    case 'missing_code':
      return { title: 'No code in this link', body: 'Use the link from your proposal email, or contact support if you need a new one.' }
    case 'not_found':
      return { title: 'Code not recognized', body: 'Double-check the link from your proposal email. If it still doesn’t work, contact support@shieldmylot.com.' }
    case 'redeemed':
      return { title: 'This code has already been used', body: 'If you already have an account, sign in. If you think this is a mistake, contact support@shieldmylot.com.' }
    case 'expired':
      return { title: 'This code has expired', body: 'Contact support@shieldmylot.com and we’ll issue a new one.' }
    case 'revoked':
    case 'not_issued':
    case 'tier_not_set':
    default:
      return { title: 'This code can’t be redeemed right now', body: 'Contact support@shieldmylot.com and we’ll get you set up.' }
  }
}

function tierLabel(tierType: string, tier: string): string {
  const trackLabel = tierType === 'enforcement' ? 'Enforcement' : 'Property Management'
  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1)
  return `${trackLabel} · ${tierTitle}`
}

function RedeemInner() {
  const search = useSearchParams()
  const code = (search.get('code') || '').trim()

  const [validation, setValidation] = useState<Validation>({ kind: 'loading' })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })

  // Resend cooldown (pre-flight #5). Starts at 30s after first send to avoid
  // over_email_send_rate_limit. Resets each successful resend.
  const [resendCooldown, setResendCooldown] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function validate() {
      if (!code) {
        setValidation({ kind: 'invalid', reason: 'missing_code' })
        return
      }
      const { data, error } = await supabase.rpc('validate_proposal_code', { p_code: code })
      if (cancelled) return
      if (error || !data) {
        setValidation({ kind: 'invalid', reason: 'not_found' })
        return
      }
      const result = data as Record<string, unknown>
      if (result.valid === true) {
        setValidation({
          kind: 'valid',
          tier_type: String(result.tier_type),
          tier: String(result.tier),
          client_name: (result.client_name as string | null) ?? null,
          expires_at: (result.expires_at as string | null) ?? null,
          has_custom_pricing: Boolean(result.has_custom_pricing),
        })
      } else {
        setValidation({ kind: 'invalid', reason: String(result.reason || 'not_found') })
      }
    }
    validate()
    return () => { cancelled = true }
  }, [code])

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  function passwordError(): string | null {
    if (password.length < 8) return 'Password must be at least 8 characters.'
    return null
  }
  function emailError(): string | null {
    const trimmed = email.trim()
    if (!trimmed) return 'Email is required.'
    if (!trimmed.includes('@') || !trimmed.includes('.')) return 'Enter a valid email address.'
    return null
  }

  const buildRedirectTo = () =>
    typeof window === 'undefined'
      ? 'https://shieldmylot.com/signup/redeem/verify'
      : `${window.location.origin}/signup/redeem/verify`

  async function submit() {
    const eErr = emailError()
    const pErr = passwordError()
    if (eErr || pErr) {
      setSubmission({ kind: 'error', message: eErr || pErr || 'Invalid input.' })
      return
    }
    setSubmission({ kind: 'submitting' })
    const trimmedEmail = email.trim().toLowerCase()

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        emailRedirectTo: buildRedirectTo(),
        // Pre-flight #8: proposal code rides in user_metadata, NOT the
        // emailRedirectTo URL, to avoid colliding with the PKCE flow's own
        // ?code=<flow_code> param that Supabase appends to the redirect.
        data: { proposal_code: code },
      },
    })

    if (error) {
      setSubmission({ kind: 'error', message: error.message || 'Sign-up failed. Please try again.' })
      return
    }
    // Pre-flight #2 — detect the obfuscated "already-confirmed user" response.
    // Supabase returns a fake user with an empty `identities` array as an
    // anti-enumeration measure. We surface a friendly, non-leaking message.
    if (data.user?.identities && data.user.identities.length === 0) {
      setSubmission({ kind: 'already_registered' })
      return
    }
    // Existing UNCONFIRMED user: identities populated, verification email
    // re-sent. UX is identical to a fresh signup.
    setSubmission({ kind: 'sent', email: trimmedEmail })
    setResendCooldown(30)
  }

  async function resend() {
    if (submission.kind !== 'sent' || resendCooldown > 0) return
    setResendCooldown(30)
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: submission.email,
      options: { emailRedirectTo: buildRedirectTo() },
    })
    if (error) {
      // Don't unwind the "sent" view — the email may have gone out anyway and
      // we don't want to confuse the user. Just show a small inline note.
      console.warn('resend failed', error)
    }
  }

  // ── RENDER ─────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background: '#0a0d14', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    padding: '12px 16px', color: '#fff', width: '100%', fontSize: 14,
    boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  }
  const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 6, marginTop: 14 }

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '48px 24px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Activate your account</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>ShieldMyLot™ · Texas parking enforcement</p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '14px auto 0' }} />
        </div>

        {validation.kind === 'loading' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>Checking your code…</p>
          </div>
        )}

        {validation.kind === 'invalid' && (() => {
          const copy = invalidCopy(validation.reason)
          return (
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
              <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>{copy.title}</h2>
              <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 24px' }}>{copy.body}</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a href="/login" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Sign in</a>
                <a href="mailto:support@shieldmylot.com" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Contact support</a>
              </div>
            </div>
          )
        })()}

        {validation.kind === 'valid' && submission.kind !== 'sent' && submission.kind !== 'already_registered' && (
          <>
            {/* Tier summary card — minimum-leak data only */}
            <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
              <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 700 }}>Your proposal</p>
              {validation.client_name && (
                <h2 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>{validation.client_name}</h2>
              )}
              <p style={{ color: '#94a3b8', fontSize: 14, margin: '4px 0 0' }}>{tierLabel(validation.tier_type, validation.tier)}</p>
              {validation.has_custom_pricing && (
                <p style={{ color: MUTED, fontSize: 12, margin: '8px 0 0' }}>Custom pricing applies — details in your proposal.</p>
              )}
              {validation.expires_at && (
                <p style={{ color: MUTED, fontSize: 12, margin: '8px 0 0' }}>
                  Code valid until {new Date(validation.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                </p>
              )}
            </div>

            {/* Signup form */}
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24 }}>
              <h3 style={{ color: TEXT, fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Create your login</h3>
              <p style={{ color: MUTED, fontSize: 13, margin: '0 0 16px' }}>We’ll send a verification link to confirm your email before you finish setup.</p>

              <label style={{ ...labelStyle, marginTop: 0 }}>Work email</label>
              <input type="email" autoComplete="email" style={inputStyle} value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com" />

              <label style={labelStyle}>Password</label>
              <input type="password" autoComplete="new-password" style={inputStyle} value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters" />
              <p style={{ color: MUTED, fontSize: 11, margin: '6px 0 0' }}>Minimum 8 characters.</p>

              {submission.kind === 'error' && (
                <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
                  <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{submission.message}</p>
                </div>
              )}

              <button onClick={submit} disabled={submission.kind === 'submitting'}
                style={{ width: '100%', marginTop: 18, background: submission.kind === 'submitting' ? '#555' : GOLD, color: submission.kind === 'submitting' ? '#888' : '#0a0d14', fontWeight: 700, fontSize: 15, padding: '13px', border: 'none', borderRadius: 10, cursor: submission.kind === 'submitting' ? 'not-allowed' : 'pointer' }}>
                {submission.kind === 'submitting' ? 'Sending verification…' : 'Send verification email'}
              </button>

              <p style={{ color: MUTED, fontSize: 11, margin: '16px 0 0', lineHeight: 1.6, textAlign: 'center' }}>
                By continuing, you’ll be asked to accept our{' '}
                <a href="/terms" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Terms of Service</a>
                {' '}and{' '}
                <a href="/privacy" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Privacy Policy</a>
                {' '}before activating your account.
              </p>
            </div>
          </>
        )}

        {submission.kind === 'sent' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(201,162,39,0.12)', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>📧</div>
            <h2 style={{ color: TEXT, fontSize: 22, fontWeight: 700, margin: '0 0 10px' }}>Check your email</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 6px' }}>
              We sent a verification link to
            </p>
            <p style={{ color: GOLD, fontSize: 15, fontWeight: 700, margin: '0 0 18px', wordBreak: 'break-all' }}>{submission.email}</p>
            <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.6, margin: '0 0 22px' }}>
              Click the link to verify your email and continue setting up your account. The link is valid for one hour.
            </p>
            <button onClick={resend} disabled={resendCooldown > 0}
              style={{ background: resendCooldown > 0 ? '#1e2535' : CARD_BG, color: resendCooldown > 0 ? '#555' : TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer' }}>
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Didn’t receive it? Resend'}
            </button>
            <p style={{ color: MUTED, fontSize: 11, margin: '20px 0 0', lineHeight: 1.6 }}>
              Wrong email? <a href="/signup/redeem" style={{ color: GOLD, textDecoration: 'none' }}>Start over</a>{' '}·{' '}
              Need help? <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none' }}>Contact support</a>
            </p>
          </div>
        )}

        {submission.kind === 'already_registered' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>This email is already registered</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 22px' }}>
              If you already have a ShieldMyLot account, sign in instead. If you’re trying to start a second account, contact support.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="/login" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Sign in</a>
              <a href="mailto:support@shieldmylot.com" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Contact support</a>
            </div>
          </div>
        )}

        <p style={{ textAlign: 'center', color: MUTED, fontSize: 11, marginTop: 28 }}>
          © 2026 ShieldMyLot™ · A product of Alvarado Legacy Consulting LLC
        </p>
      </div>
    </main>
  )
}

export default function RedeemPage() {
  return (
    <Suspense fallback={<main style={{ minHeight: '100vh', background: BG }} />}>
      <RedeemInner />
    </Suspense>
  )
}
