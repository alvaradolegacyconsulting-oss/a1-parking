'use client'
// B66.3 — post-email-verification landing for self-serve signup.
// User clicks the verification link → lands here → PKCE auto-exchange
// happens client-side → page detects the verified session → POSTs to
// /api/signup/attest (records Texas attestation) → renders tier summary
// + cost preview + "Continue to Checkout" button. Click triggers a
// POST to /api/signup/create-checkout-session which 303-redirects to
// the Stripe-hosted Checkout URL.
//
// PKCE detection pattern mirrors /signup/redeem/verify (B65.4): listen
// to onAuthStateChange + initial getSession() in parallel; 4s fallback
// timeout to surface "unverified" state if no session minted.
//
// ── B117 C-TOKEN PHASE 1 (dual handler — hybrid-template window) ─────
// This page now handles BOTH:
//   • PKCE link click — existing path. Auto-exchange via
//     detectSessionInUrl + onAuthStateChange. Required for in-flight
//     emails carrying {{ .ConfirmationURL }}.
//   • Token-only OTP entry — new path. User pastes the 6-8 digit token
//     from the email; we call supabase.auth.verifyOtp({email, token,
//     type: 'signup'}) and feed the returned User through the same
//     downstream flow (attestation + ready card).
//
// Both paths converge on the same processVerifiedUser() function below;
// the OTP path bypasses the useEffect's `resolved` flag by calling
// processVerifiedUser directly with the User object verifyOtp returned.
//
// Pre-flight proof (C1 + C2, 10/10 green): intended_tier user_metadata
// survives verifyOtp intact; email_confirmed_at populated identically
// to PKCE path. Downstream gates (B66.3 create-checkout-session,
// /api/signup/attest) accept either path.
//
// Rollout: pattern (1) hybrid-template window. Deploy this dual-handler
// build → 1h wait for PKCE links to TTL out → Supabase template switches
// to hybrid (link + token in same body) → 24-72h soak → switch to token-
// only → cleanup commit removes PKCE handler. PKCE handler stays in
// place for in-flight emails through the soak.
//
// Security framing: keeping both paths during rollout is safe; the
// low-value-surface justification for OTP-on-signup (compromised OTP
// yields half-created account with no data) holds independently of
// which path the user actually takes.

import { useCallback, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../supabase'
import { TIER_PRICING } from '../../lib/tier-config'
import { ENFORCEMENT_TIERS, PROPERTY_MANAGEMENT_TIERS } from '../../lib/tier-display'
import { isOtpExpiredOrUsed } from '../../lib/otp-errors'
import { SAAS_VERSION, SAAS_DISPLAY_DATE } from '../../lib/legal-versions'
import SaasReadthroughGate from '../../components/SaasReadthroughGate'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: string
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

type Status =
  | { kind: 'loading' }
  | { kind: 'unverified' }
  | { kind: 'missing_tier' }
  | { kind: 'ready'; user: User; tier: IntendedTier }
  | { kind: 'attest_error'; message: string }
  | { kind: 'checkout_error'; message: string }
  | { kind: 'already_verified' }   // B162: verifyOtp returned otp_expired (already-used OR truly-expired; indistinguishable client-side)

export default function SignupVerify() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [attesting, setAttesting] = useState(false)
  const [proceeding, setProceeding] = useState(false)

  // B117 C-token OTP form state. Email pre-fills from ?email= URL param
  // (set by the new email template), but user can override.
  const [otpEmail, setOtpEmail] = useState('')
  const [otpToken, setOtpToken] = useState('')
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpError, setOtpError] = useState('')

  // Shared post-verification flow — used by both PKCE auto-exchange
  // (via useEffect) and OTP submit (via submitOtp). Single source of
  // truth for: tier metadata read, attestation POST, ready transition.
  const processVerifiedUser = useCallback(async (user: User): Promise<void> => {
    // B205: re-fetch the canonical user from /auth/v1/user before reading
    // user_metadata. On the cross-browser path (B198's /auth/accept →
    // verifyOtp({token_hash, type:'signup'}) → redirect here), the session
    // landing in localStorage carries the JWT-claim-derived user shape —
    // sometimes without user_metadata fully populated. Reading meta off
    // `session.user` directly surfaced as "missing_tier" cross-context.
    // getUser() hits /auth/v1/user and returns the full user row including
    // metadata. Falls back to session.user on transport error (preserves
    // same-browser case where session.user is already rich).
    const { data: userResp, error: userErr } = await supabase.auth.getUser()
    const u = userResp?.user ?? user
    if (userErr) {
      console.warn('[signup/verify] getUser() failed, falling back to session.user:', userErr.message)
    }
    const meta = (u.user_metadata || {}) as Record<string, unknown>
    const intendedRaw = meta.intended_tier
    if (!intendedRaw || typeof intendedRaw !== 'object') {
      setStatus({ kind: 'missing_tier' })
      return
    }
    const intended = intendedRaw as IntendedTier

    // Record the Texas attestation. /api/signup/attest is idempotent
    // (matches on user_id + document_type + version) so a refresh OR
    // a PKCE-then-OTP retry doesn't duplicate.
    setAttesting(true)
    try {
      const res = await fetch('/api/signup/attest', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setStatus({ kind: 'attest_error', message: body.error || res.statusText })
        setAttesting(false)
        return
      }
    } catch (e) {
      setStatus({ kind: 'attest_error', message: (e as Error).message })
      setAttesting(false)
      return
    }
    setAttesting(false)
    setStatus({ kind: 'ready', user: u, tier: intended })
  }, [])

  // PKCE path — auto-exchange via detectSessionInUrl + onAuthStateChange.
  useEffect(() => {
    let resolved = false
    let cancelled = false

    // Pre-fill OTP email from URL param if present (new template includes it).
    try {
      const url = new URL(window.location.href)
      const e = url.searchParams.get('email')
      if (e) setOtpEmail(e.trim().toLowerCase())
    } catch { /* SSR safety */ }

    async function onSession(session: Session | null) {
      if (resolved || cancelled) return
      const user = session?.user
      if (!user?.email_confirmed_at) return
      resolved = true
      await processVerifiedUser(user)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void onSession(session)
    })
    supabase.auth.getSession().then(({ data }) => onSession(data.session))

    const timeoutId = window.setTimeout(() => {
      if (!resolved && !cancelled) {
        resolved = true
        setStatus({ kind: 'unverified' })
      }
    }, 4000)

    return () => {
      cancelled = true
      subscription.unsubscribe()
      window.clearTimeout(timeoutId)
    }
  }, [processVerifiedUser])

  // OTP path — user pastes the token from the verification email. Calls
  // verifyOtp directly with the user-entered email + token, then feeds
  // the returned User through processVerifiedUser (bypassing the useEffect
  // `resolved` lockout, which has already fired with kind: 'unverified').
  async function submitOtp() {
    if (!otpEmail.trim() || !otpToken.trim()) return
    setOtpSubmitting(true)
    setOtpError('')
    const { data, error } = await supabase.auth.verifyOtp({
      email: otpEmail.trim().toLowerCase(),
      token: otpToken.trim(),
      type: 'signup',
    })
    setOtpSubmitting(false)
    if (error) {
      // B162 — Supabase returns 'otp_expired' for both "token already used
      // by another tab/device" AND "token genuinely expired (24h elapsed)."
      // No client-side distinguisher. Surface a single recovery card that
      // serves both cases honestly.
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
    setStatus({ kind: 'loading' })
    await processVerifiedUser(data.user)
  }

  async function proceedToCheckout() {
    setProceeding(true)
    // /api/signup/create-checkout-session 303-redirects to Stripe's
    // hosted checkout URL. fetch() follows redirects by default;
    // assign window.location to the final URL by reading the redirect
    // chain. Simpler: use a form POST with action=route + method=POST
    // so the browser handles the redirect natively.
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = '/api/signup/create-checkout-session'
    document.body.appendChild(form)
    form.submit()
  }

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '48px 24px' }}>
      <div style={{ maxWidth: 540, margin: '0 auto' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>One step left</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>Review your selection and continue to payment.</p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '14px auto 0' }} />
        </div>

        {(status.kind === 'loading' || attesting) && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>{attesting ? 'Recording your attestation…' : 'Confirming your email…'}</p>
          </div>
        )}

        {status.kind === 'unverified' && (
          <UnverifiedCard
            otpEmail={otpEmail}
            otpToken={otpToken}
            otpSubmitting={otpSubmitting}
            otpError={otpError}
            onEmailChange={setOtpEmail}
            onTokenChange={setOtpToken}
            onSubmit={submitOtp}
          />
        )}

        {status.kind === 'missing_tier' && (
          <ErrorCard
            title="We couldn't find your tier selection"
            body="Your signup is missing tier details. Restart the signup flow to choose your plan."
            primaryLabel="Restart signup"
            primaryHref="/signup"
          />
        )}

        {status.kind === 'attest_error' && (
          <ErrorCard
            title="We couldn't record your attestation"
            body={`Something went wrong recording your Texas attestation: ${status.message}. Refresh to retry, or contact support if it persists.`}
            primaryLabel="Refresh"
            primaryHref="/signup/verify"
          />
        )}

        {/* B162 — recovery card for verifyOtp 'otp_expired' (already used OR
            truly expired; same code, no distinguisher). Two honest paths:
            restart signup (gold primary, works for the expired case AND lets
            the already-used user start fresh if they don't have a session)
            + Sign in (outline secondary, works if the user verified
            elsewhere). Same shape as B158-A button-primacy rationale: the
            always-works path is primary. */}
        {status.kind === 'already_verified' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>This code can&apos;t be used</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              It may have already been used, or expired. If you finished verifying on another device
              or tab, sign in to continue with your account setup. Otherwise, restart signup to get a
              fresh verification email.
            </p>
            <a href="/signup" style={{ display: 'block', width: '100%', padding: 13, background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, marginBottom: 12, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Restart signup
            </a>
            <a href="/login" style={{ display: 'block', width: '100%', padding: 13, background: 'transparent', color: TEXT, fontWeight: 'bold', fontSize: 14, border: `1px solid ${BORDER}`, borderRadius: 8, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Sign in
            </a>
            <p style={{ color: MUTED, fontSize: 11, textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>
              The same code can&apos;t be reused — restarting issues a fresh email.
            </p>
          </div>
        )}

        {status.kind === 'ready' && (
          <ReadyCard user={status.user} tier={status.tier} proceeding={proceeding} onProceed={proceedToCheckout} />
        )}

      </div>
    </main>
  )
}

// ── Sub-components ───────────────────────────────────────────────────

interface UnverifiedCardProps {
  otpEmail: string
  otpToken: string
  otpSubmitting: boolean
  otpError: string
  onEmailChange: (v: string) => void
  onTokenChange: (v: string) => void
  onSubmit: () => void
}

function UnverifiedCard({ otpEmail, otpToken, otpSubmitting, otpError, onEmailChange, onTokenChange, onSubmit }: UnverifiedCardProps) {
  const formOk = !!otpEmail.trim() && !!otpToken.trim() && !otpSubmitting
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>📧</div>
      <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Verify your email to continue</h2>
      {/* B117 C-token Phase 1 regression-repair: bridges the pre-template
          window (email contains only a PKCE link, no code) AND the post-
          template window (email contains a numeric code). Reads sensibly
          in either era; preserves the Rec A same-browser context for the
          cross-browser PKCE failure mode (this card's most common cause). */}
      <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 18px' }}>
        If your email includes a verification code, enter it below — the code path works from any
        browser. If you only see a link, it must be opened in the same browser you used to sign up
        (switching browsers, or using incognito after a regular window, breaks the link). Don&apos;t see a
        code and your link didn&apos;t work? Click <strong>Restart signup</strong> below.
      </p>

      {/* B117 C-token Phase 1 — OTP entry form. Token-only path; works from
          any browser (no code_verifier dependency). Email pre-fills from
          ?email= URL param when present. */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email</label>
        <input type="email" value={otpEmail} autoComplete="email"
          onChange={e => onEmailChange(e.target.value)}
          placeholder="you@example.com"
          style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Verification code</label>
        <input type="text" inputMode="numeric" autoComplete="one-time-code" value={otpToken}
          onChange={e => onTokenChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && formOk && onSubmit()}
          placeholder="6–8 digit code"
          style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box', letterSpacing: '0.1em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
      </div>
      {otpError && (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{otpError}</p>
        </div>
      )}
      <button onClick={onSubmit} disabled={!formOk}
        style={{ width: '100%', padding: 13, background: !formOk ? '#555' : GOLD, color: !formOk ? '#888' : '#0a0d14', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, cursor: !formOk ? 'not-allowed' : 'pointer', marginBottom: 18 }}>
        {otpSubmitting ? 'Verifying…' : 'Verify and continue'}
      </button>

      <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <a href="/signup" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Restart signup</a>
        <span style={{ color: MUTED, fontSize: 12 }}>·</span>
        <a href="/login" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Sign in</a>
      </div>
    </div>
  )
}

function ErrorCard({ title, body, primaryLabel, primaryHref }: { title: string; body: string; primaryLabel: string; primaryHref: string }) {
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
      <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>{title}</h2>
      <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>{body}</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <a href={primaryHref} style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>{primaryLabel}</a>
        <a href="mailto:support@shieldmylot.com" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Contact support</a>
      </div>
    </div>
  )
}

function ReadyCard({ user, tier, proceeding, onProceed }: { user: User; tier: IntendedTier; proceeding: boolean; onProceed: () => void }) {
  const trackLabel = tier.track === 'enforcement' ? 'Enforcement' : 'Property Management'
  const tierTitle = tier.tier.charAt(0).toUpperCase() + tier.tier.slice(1)

  // B118 Layer 2 Commit 3 — SaaS acceptance state for self-serve.
  // Fires the accept_saas_agreement RPC via /api/signup/accept-saas
  // BEFORE the Stripe Checkout redirect. Gate must complete first;
  // otherwise the tos_acceptances.saas row is never written and the
  // user_roles.saas_accepted_version stays NULL for this signup.
  //
  // Self-serve is behind public_signup_open=false throughout Bar-1.
  // This wiring exists for parity + Bar-2 readiness; A1 doesn't use
  // this path (A1 = redeem).
  const [saasSubmitting, setSaasSubmitting] = useState(false)
  const [saasError,      setSaasError]      = useState<string | null>(null)
  const [saasSigned,     setSaasSigned]     = useState(false)

  const handleSaasSigned = async (info: { version: string, reviewedAt: string }) => {
    setSaasError(null)
    setSaasSubmitting(true)
    try {
      const res = await fetch('/api/signup/accept-saas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedAt: info.reviewedAt }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }))
        setSaasError(body.error || `Server returned ${res.status}. Refresh to retry.`)
        return
      }
      setSaasSigned(true)
    } catch (e) {
      setSaasError((e as Error).message || 'Network error recording your SaaS acceptance.')
    } finally {
      setSaasSubmitting(false)
    }
  }

  // Recompute preview from display constants (matches /signup form).
  const tiers = tier.track === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS
  const td = tiers.find(t => t.name.toLowerCase() === tier.tier)
  const baseMonthly = TIER_PRICING[tier.track]?.[tier.tier] ?? td?.base ?? 0
  const perProp = td?.perProp ?? 0
  const perDriver = td?.perDriver ?? 0
  const monthlyTotal = baseMonthly + (perProp * tier.property_count) + (perDriver * tier.driver_count)
  const totalThisCycle = tier.cycle === 'monthly' ? monthlyTotal : monthlyTotal * 10

  return (
    <>
      <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 14, padding: 18, marginBottom: 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ fontSize: 20, lineHeight: 1.2 }}>✓</span>
        <div>
          <p style={{ color: '#86efac', fontSize: 14, fontWeight: 700, margin: 0 }}>Email verified · attestation recorded</p>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0 0', wordBreak: 'break-all' }}>{user.email}</p>
        </div>
      </div>

      <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
        <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>Your selection</p>
        <p style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>{trackLabel} · {tierTitle}</p>
        <p style={{ color: MUTED, fontSize: 13, margin: '0 0 4px' }}>
          {tier.cycle === 'monthly' ? 'Monthly billing' : 'Annual billing (~17% off)'} · {tier.property_count} {tier.property_count === 1 ? 'property' : 'properties'}{tier.track === 'enforcement' && ` · ${tier.driver_count} ${tier.driver_count === 1 ? 'driver' : 'drivers'}`}
        </p>
        <p style={{ color: TEXT, fontSize: 13, margin: '0 0 14px' }}>Company: <strong>{tier.company_name}</strong></p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
          <span style={{ color: MUTED, fontSize: 13 }}>{tier.cycle === 'monthly' ? 'Monthly' : 'Annual'} total</span>
          <span style={{ color: GOLD, fontSize: 24, fontWeight: 800 }}>${totalThisCycle.toFixed(2)}</span>
        </div>
      </div>

      <SaasReadthroughGate
        version={SAAS_VERSION}
        displayDate={SAAS_DISPLAY_DATE}
        disabled={saasSubmitting || saasSigned}
        onSigned={handleSaasSigned}
      />

      {saasError && (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 12px', marginTop: 10 }}>
          <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{saasError}</p>
        </div>
      )}

      <button onClick={onProceed} disabled={proceeding || !saasSigned || saasSubmitting}
        style={{
          width: '100%', padding: '16px', marginTop: 14,
          background: (proceeding || !saasSigned) ? '#1e2535' : GOLD,
          color: (proceeding || !saasSigned) ? '#555' : '#0a0d14', fontWeight: 700, fontSize: 15,
          border: 'none', borderRadius: 10, cursor: (proceeding || !saasSigned || saasSubmitting) ? 'not-allowed' : 'pointer',
        }}>
        {proceeding ? 'Redirecting to checkout…' : (saasSigned ? 'Continue → Stripe Checkout' : 'Sign the SaaS Agreement to continue')}
      </button>
      <p style={{ color: MUTED, fontSize: 12, textAlign: 'center', margin: '14px 0 0' }}>
        Payment is securely handled by Stripe. You&apos;ll return to this site after completing checkout.
      </p>
    </>
  )
}
