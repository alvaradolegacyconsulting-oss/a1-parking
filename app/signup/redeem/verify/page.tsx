'use client'
// B65.3 → B65.4: post-verification landing now hosts the live activation
// form. PKCE auto-exchange from the verification-email link still runs as
// before (B65.3 — flowType='pkce', detectSessionInUrl=true). Once the
// session is confirmed we re-validate the proposal code (Finding 8 — UX
// surfaces a stale-code error BEFORE the user fills the form; the atomic
// RPC's row-locked re-check is still the authoritative correctness gate),
// then render the company-info form + ToS click-accept. Submission calls
// redeem_proposal_code() which atomically creates the company, user_roles
// row, links + flips the code, records ToS acceptance, and activates the
// account in a single transaction. Success → redirect to /company_admin.

import { useCallback, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../../supabase'
import { TOS_VERSION, TOS_DISPLAY_DATE, PRIVACY_VERSION, PRIVACY_DISPLAY_DATE, TEXAS_ATTESTATION_VERSION, TEXAS_ATTESTATION_TEXT, SAAS_VERSION, SAAS_DISPLAY_DATE } from '../../../lib/legal-versions'
import SaasReadthroughGate from '../../../components/SaasReadthroughGate'
// B76: post-activation bootstrap. Without this, /company_admin renders
// with null localStorage and falls back to the 'Legacy Enforcement'
// default until the user signs out and back in. See project_b76.
import { bootstrapCompanyContext, fetchCompanyBootstrapRowById } from '../../../lib/company-bootstrap'
import { isOtpExpiredOrUsed } from '../../../lib/otp-errors'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Status =
  | { kind: 'loading' }
  | { kind: 'unverified' }                                                    // no session / email not confirmed
  | { kind: 'invalid_code'; reason: string }                                  // session ok, but code can't be redeemed (expired since signup, revoked, etc.)
  | { kind: 'ready'; user: User; proposalCode: string; tierLabel: string }    // form-ready
  | { kind: 'billing_error'; companyId: number | string; message: string }    // B158-A: start-billing failed post-redeem; show recoverable error card
  | { kind: 'already_verified' }                                              // B162: verifyOtp returned otp_expired (already-used OR truly-expired; indistinguishable client-side)

// B158-A: shared start-billing invocation. Returns navigation target on
// success, error message on failure. Used by both activate() (initial
// kickoff after redeem_proposal_code RPC) and retryBilling() (recovery
// from the billing_error state). Pure I/O wrapper — no component state
// access, intentional module-level scope.
type StartBillingResult = { navigateTo: string } | { errorMessage: string }

async function invokeStartBilling(companyIdValue: number | string): Promise<StartBillingResult> {
  try {
    const res = await fetch('/api/proposal-codes/start-billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: Number(companyIdValue) }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      if (json.checkout_url) return { navigateTo: json.checkout_url }
      if (json.success_redirect) return { navigateTo: json.success_redirect }
      if (json.already_billed) return { navigateTo: '/company_admin' }
      return { errorMessage: 'Billing service returned an unrecognized response. Try again or contact support.' }
    }
    const serverMessage = typeof json.error === 'string' ? json.error : null
    return { errorMessage: serverMessage || `Billing setup couldn't start (HTTP ${res.status}).` }
  } catch {
    return { errorMessage: "Billing setup couldn't start — network error. Check your connection and try again." }
  }
}

type Submission =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

function invalidCopy(reason: string): { title: string; body: string } {
  // Verify-time variants — the user has already signed up, so the framing
  // assumes state shifted between signup and activation rather than
  // a typo'd code.
  switch (reason) {
    case 'missing_code':
      return { title: 'We can’t find your proposal code', body: 'Your account doesn’t have a proposal code attached. Contact support@shieldmylot.com and we’ll sort it out.' }
    case 'redeemed':
      return { title: 'This code was already redeemed', body: 'It looks like activation completed in another session. Try signing in — if that doesn’t work, contact support@shieldmylot.com.' }
    case 'expired':
      return { title: 'Your proposal code expired', body: 'The window for activating this code has closed. Contact support@shieldmylot.com and we’ll issue a new one.' }
    case 'revoked':
    case 'not_issued':
    case 'tier_not_set':
    case 'not_found':
    default:
      return { title: 'This code can’t be redeemed right now', body: 'Something about your proposal code changed since signup. Contact support@shieldmylot.com and we’ll get you set up.' }
  }
}

function tierLabelFor(tierType: string, tier: string): string {
  const trackLabel = tierType === 'enforcement' ? 'Enforcement' : 'Property Management'
  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1)
  return `${trackLabel} · ${tierTitle}`
}

export default function VerifyLanding() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  // Form state — only meaningful when status.kind === 'ready'
  const [companyName, setCompanyName] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [address, setAddress] = useState('')
  // B118 Layer 2 Commit 2 (2026-07-07): split the single combined
  // "I agree to ToS and Privacy" checkbox into two independent required
  // checkboxes. Matches the two-row shape self-serve /signup + the
  // first-login modal already use; RPC now writes two sibling rows
  // (document_type='tos' + 'privacy') via
  // 20260707_b118_layer2_redeem_two_click_and_stamp.sql. Legal effect
  // unchanged (clickwrap + affirmative per-document action).
  const [tosChecked, setTosChecked] = useState(false)
  const [privacyChecked, setPrivacyChecked] = useState(false)
  // B118 Layer 2 Commit 3 — SaaS scroll-to-sign gate state.
  // saasReviewedAt is set BY THE GATE at unlock moment (canSign
  // false→true, whichever OR-signal fires first). saasSigned flips
  // true when the user clicks the gate's "Sign & Accept" button.
  // Both flow into activate() → redeem_proposal_code RPC's new
  // p_saas_version + p_saas_reviewed_at params.
  const [saasReviewedAt, setSaasReviewedAt] = useState<string | null>(null)
  const [saasSigned,     setSaasSigned]     = useState(false)
  // 2026-06-30 — Texas operator attestation on the redeem path
  // (parity with /signup). A1 onboards here and needs the same
  // attestation as the self-serve path. Recorded via the new
  // p_attestation_version arg on redeem_proposal_code → sibling row
  // with document_type='texas_attestation' alongside the tos_and_privacy
  // row, atomic with the rest of the redeem.
  const [attestChecked, setAttestChecked] = useState(false)
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })

  // B117 Phase 2 — OTP fallback state. Email pre-fills from ?email=
  // URL param (set by the new Confirm-signup template); user can override.
  const [otpEmail, setOtpEmail] = useState('')
  const [otpToken, setOtpToken] = useState('')
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpError, setOtpError] = useState('')

  // Shared post-verification flow — used by both PKCE auto-exchange
  // (via continueFromSession in useEffect) and OTP submit (via submitOtp).
  // Single source of truth for: proposal-code metadata read,
  // validate_proposal_code re-check (Finding 8 — UX-only correctness),
  // ready-state transition. Mirrors /signup/verify's Phase 1 pattern.
  const processVerifiedUser = useCallback(async (user: User): Promise<void> => {
    // B205: re-fetch the canonical user from /auth/v1/user before reading
    // user_metadata. On the cross-browser path (B198's /auth/accept →
    // verifyOtp({token_hash, type:'signup'}) → redirect here), the session
    // landing in localStorage carries the JWT-claim-derived user shape —
    // sometimes without user_metadata fully populated. Reading meta off
    // `session.user` directly surfaced as 'missing_code' cross-context.
    // getUser() hits /auth/v1/user and returns the full user row including
    // metadata. Falls back to session.user on transport error (preserves
    // same-browser case where session.user is already rich). The canonical
    // user is also threaded into the ready state — its id powers the
    // redeem_proposal_code RPC at activate() (p_user_id: status.user.id).
    const { data: userResp, error: userErr } = await supabase.auth.getUser()
    const u = userResp?.user ?? user
    if (userErr) {
      console.warn('[signup/redeem/verify] getUser() failed, falling back to session.user:', userErr.message)
    }
    const meta = (u.user_metadata || {}) as Record<string, unknown>
    const code = typeof meta.proposal_code === 'string' && meta.proposal_code.length > 0
      ? meta.proposal_code
      : null

    if (!code) {
      setStatus({ kind: 'invalid_code', reason: 'missing_code' })
      return
    }

    const { data: vData, error: vErr } = await supabase.rpc('validate_proposal_code', { p_code: code })
    if (vErr || !vData) {
      setStatus({ kind: 'invalid_code', reason: 'not_found' })
      return
    }
    const result = vData as Record<string, unknown>
    if (result.valid !== true) {
      setStatus({ kind: 'invalid_code', reason: String(result.reason || 'not_found') })
      return
    }

    setStatus({
      kind: 'ready',
      user: u,
      proposalCode: code,
      tierLabel: tierLabelFor(String(result.tier_type), String(result.tier)),
    })
  }, [])

  useEffect(() => {
    let resolved = false
    let cancelled = false

    // B117 Phase 2 — pre-fill OTP email from URL param (new template
    // includes ?email={{ .Email }} appended to ConfirmationURL). User
    // can override in the OTP card.
    try {
      const url = new URL(window.location.href)
      const e = url.searchParams.get('email')
      if (e) setOtpEmail(e.trim().toLowerCase())
    } catch { /* SSR safety */ }

    async function continueFromSession(session: Session | null) {
      if (resolved || cancelled) return
      const user = session?.user
      if (!user?.email_confirmed_at) return
      resolved = true
      await processVerifiedUser(user)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void continueFromSession(session)
    })
    supabase.auth.getSession().then(({ data }) => continueFromSession(data.session))

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

  // B158-A: retry handler for the billing_error state. Re-invokes
  // start-billing for the existing companyId; on success navigates to
  // Checkout / success-redirect; on failure refreshes the error message.
  // Idempotent per start-billing route's already_billed shortcut (line
  // 117-119 of the route) — a prior-successful sub creates short-circuit
  // back to /company_admin rather than a duplicate subscription.
  async function retryBilling(companyIdValue: number | string) {
    setStatus({ kind: 'loading' })
    const result = await invokeStartBilling(companyIdValue)
    if ('navigateTo' in result) {
      window.location.href = result.navigateTo
      return
    }
    setStatus({
      kind: 'billing_error',
      companyId: companyIdValue,
      message: result.errorMessage,
    })
  }

  // B117 Phase 2 — OTP fallback handler. User pastes the code from the
  // verification email; we call verifyOtp({type:'signup'}) directly and
  // feed the returned User through processVerifiedUser (bypassing the
  // useEffect `resolved` lockout, which has already fired with
  // kind: 'unverified' by the time this runs).
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
    setStatus({ kind: 'loading' })
    await processVerifiedUser(data.user)
  }

  function formError(): string | null {
    if (!companyName.trim()) return 'Company name is required.'
    if (!contactName.trim()) return 'Primary contact name is required.'
    if (!contactPhone.trim()) return 'Primary contact phone is required.'
    if (!address.trim()) return 'Billing address is required.'
    if (!tosChecked) return 'You must agree to the Terms of Service.'
    if (!privacyChecked) return 'You must agree to the Privacy Policy.'
    if (!attestChecked) return 'You must attest to the Texas operations terms.'
    if (!saasSigned || !saasReviewedAt) return 'You must sign the SaaS Subscription Agreement.'
    return null
  }

  async function activate() {
    if (status.kind !== 'ready') return
    const err = formError()
    if (err) {
      setSubmission({ kind: 'error', message: err })
      return
    }
    setSubmission({ kind: 'submitting' })

    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null

    const { data, error } = await supabase.rpc('redeem_proposal_code', {
      p_code: status.proposalCode,
      p_user_id: status.user.id,
      p_company_name: companyName.trim(),
      p_primary_contact_name: contactName.trim(),
      p_primary_contact_phone: contactPhone.trim(),
      p_tos_version: TOS_VERSION,
      p_privacy_version: PRIVACY_VERSION,
      p_attestation_version: TEXAS_ATTESTATION_VERSION,
      // B118 Layer 2 Commit 3 — SaaS acceptance capture. Version is
      // the SERVER-owned static import (never trusted from client
      // storage), reviewed_at is client-stamped at the gate's unlock
      // moment (T1 — see SaasReadthroughGate; guaranteed < T2 =
      // accepted_at because the sign click can't fire before unlock).
      // Both required by the RPC's SaaS INSERT guard; formError()
      // above prevents activate() from firing without them.
      p_saas_version: SAAS_VERSION,
      p_saas_reviewed_at: saasReviewedAt,
      p_address: address.trim(),
      // p_ip_address omitted — browser can't reliably know its own IP
      // (Finding 7). Server-side proxy is a future commit if legal asks.
      p_user_agent: userAgent,
    })

    if (error) {
      // Surface a friendly version of the RPC's RAISE message. The raw
      // text is fine for ops debugging but we strip schema-leaky details.
      const raw = error.message || 'Activation failed. Please try again.'
      const friendly =
        raw.includes('company name already in use') ? 'That company name is already in use. Try a slight variation.'
        : raw.includes('code not redeemable') ? 'This code is no longer redeemable. Contact support@shieldmylot.com.'
        : raw.includes('code expired') ? 'This code expired while you were filling out the form. Contact support@shieldmylot.com.'
        : raw.includes('unauthenticated') || raw.includes('auth.uid mismatch') ? 'Your session expired. Please sign in again.'
        : raw
      setSubmission({ kind: 'error', message: friendly })
      return
    }

    if (typeof data !== 'number' && typeof data !== 'string') {
      setSubmission({ kind: 'error', message: 'Activation succeeded but the response was unexpected. Try signing in.' })
      return
    }

    // B76: bootstrap company-context localStorage before redirecting.
    // Without this, /company_admin renders with null company_tier /
    // company_tier_type / theme / proposal_code and falls back to the
    // 'Legacy Enforcement' default until the user signs out + back in.
    // The atomic RPC returned the new company_id; fetch the populated
    // row and hand it to the shared bootstrap helper.
    const companyId = data as number | string
    const companyRow = await fetchCompanyBootstrapRowById(companyId)
    await bootstrapCompanyContext(companyRow)

    // B66.7 — kick off Stripe billing via the start-billing route.
    // Success branches: charge_automatically → { checkout_url } (Stripe
    // Checkout); send_invoice → { success_redirect } (inline customer +
    // subscription create). B158-A: failures now surface a visible
    // billing_error state instead of silently navigating to /company_admin
    // — the company IS active either way (redeem RPC flipped
    // account_state), but a silent fallback strands the customer mid-
    // onboarding with no signal that billing didn't complete. The error
    // card offers Retry (idempotent: already_billed shortcut catches a
    // prior successful sub) + support contact + Continue-to-dashboard
    // escape hatch.
    const billingResult = await invokeStartBilling(companyId)
    if ('navigateTo' in billingResult) {
      window.location.href = billingResult.navigateTo
      return
    }
    // Surface the failure. Company is already active per the redeem RPC;
    // the user can still use the dashboard, but billing needs retry or
    // support backfill.
    setStatus({
      kind: 'billing_error',
      companyId,
      message: billingResult.errorMessage,
    })
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
      <div style={{ maxWidth: 540, margin: '0 auto' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Account setup</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>ShieldMyLot™ · Texas parking enforcement</p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '14px auto 0' }} />
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>Confirming your email…</p>
          </div>
        )}

        {status.kind === 'unverified' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>📧</div>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Verify your email to continue</h2>
            {/* B117 Phase 2 — dual recovery: PKCE link OR OTP code. The
                link path is browser-context-bound (code_verifier in
                localStorage); the code path works from any browser/device.
                Matches /signup/verify's Phase 1 card. */}
            <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 18px' }}>
              If your email includes a verification code, enter it below — the code path works from any
              browser. If you only see a link, it must be opened in the same browser you used to sign up
              (switching browsers, or using incognito after a regular window, breaks the link). Don&apos;t see a
              code and your link didn&apos;t work? Click <strong>Restart redemption</strong> below.
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
              style={{ width: '100%', padding: 13, background: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#555' : GOLD, color: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? '#888' : '#0a0d14', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, cursor: !otpEmail.trim() || !otpToken.trim() || otpSubmitting ? 'not-allowed' : 'pointer', marginBottom: 18 }}>
              {otpSubmitting ? 'Verifying…' : 'Verify and continue'}
            </button>

            <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="/signup/redeem" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Restart redemption</a>
              <span style={{ color: MUTED, fontSize: 12 }}>·</span>
              <a href="/login" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Sign in</a>
            </div>
          </div>
        )}

        {status.kind === 'billing_error' && (
          <div style={{ background: CARD_BG, border: '1px solid rgba(220, 53, 69, 0.45)', borderRadius: 14, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#3a1a1a', border: '2px solid #dc3545', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: '#f87171', fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Billing setup couldn&apos;t start</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 14px' }}>
              Your account is active and you can use the dashboard, but the payment-method step
              didn&apos;t complete. Continue to your dashboard now, or contact{' '}
              <a href="mailto:support@shieldmylot.com" style={{ color: GOLD }}>support@shieldmylot.com</a>
              {' '}and we&apos;ll finish the billing setup for you.
            </p>
            <p style={{ color: MUTED, fontSize: 12, lineHeight: 1.5, margin: '0 0 22px', padding: '10px 14px', background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.25)', borderRadius: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-word' }}>
              {status.message}
            </p>
            {/* B158-A button order: Continue (primary/gold) is the working
                path; Retry (secondary/outline) will fail until the
                underlying B158-B fix lands. Visual emphasis matches what
                actually works today. */}
            <button onClick={() => { window.location.href = '/company_admin' }}
              style={{ width: '100%', padding: 13, background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, cursor: 'pointer', marginBottom: 12 }}>
              Continue to dashboard
            </button>
            <button onClick={() => retryBilling(status.companyId)}
              style={{ width: '100%', padding: 13, background: 'transparent', color: TEXT, fontWeight: 'bold', fontSize: 14, border: `1px solid ${BORDER}`, borderRadius: 8, cursor: 'pointer' }}>
              Retry billing setup
            </button>
            <p style={{ color: MUTED, fontSize: 11, textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>
              Your account is active either way — billing can be reconnected at any time.
            </p>
          </div>
        )}

        {/* B162 — recovery card for verifyOtp 'otp_expired'. The proposal
            code is NOT recoverable at this state (no session, no
            user_metadata available). Bare /signup/redeem is a dead-end
            (lands on "No code in this link"). So primary action is
            contact-support mailto: to get a fresh proposal link issued.
            Sign in stays secondary for the cross-device-verified case. */}
        {status.kind === 'already_verified' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>This code can&apos;t be used</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              It may have already been used, or expired. If you finished verifying on another device
              or tab, sign in to continue activating your company. Otherwise, contact support — your
              proposal code can only be re-issued by our team.
            </p>
            <a href="mailto:support@shieldmylot.com?subject=Need%20new%20proposal%20link"
              style={{ display: 'block', width: '100%', padding: 13, background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, marginBottom: 12, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Contact support
            </a>
            <a href="/login" style={{ display: 'block', width: '100%', padding: 13, background: 'transparent', color: TEXT, fontWeight: 'bold', fontSize: 14, border: `1px solid ${BORDER}`, borderRadius: 8, textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Sign in
            </a>
            <p style={{ color: MUTED, fontSize: 11, textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>
              We&apos;ll send you a fresh link tied to your original proposal terms.
            </p>
          </div>
        )}

        {status.kind === 'invalid_code' && (() => {
          const copy = invalidCopy(status.reason)
          return (
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
              <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>{copy.title}</h2>
              <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>{copy.body}</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a href="mailto:support@shieldmylot.com" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Contact support</a>
                <a href="/login" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Sign in</a>
              </div>
            </div>
          )
        })()}

        {status.kind === 'ready' && (
          <>
            <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 14, padding: 18, marginBottom: 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ fontSize: 20, lineHeight: 1.2 }}>✓</span>
              <div>
                <p style={{ color: '#86efac', fontSize: 14, fontWeight: 700, margin: 0 }}>Email verified</p>
                <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0 0', wordBreak: 'break-all' }}>{status.user.email}</p>
              </div>
            </div>

            <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
              <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 700 }}>Activating</p>
              <p style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>{status.tierLabel}</p>
              <p style={{ color: MUTED, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0, wordBreak: 'break-all' }}>{status.proposalCode}</p>
            </div>

            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24 }}>
              <h2 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>Tell us about your company</h2>
              <p style={{ color: MUTED, fontSize: 13, margin: '0 0 6px' }}>This information sets up your company profile. You can fine-tune it later from the dashboard.</p>

              <label style={{ ...labelStyle, marginTop: 14 }}>Company name</label>
              <input type="text" style={inputStyle} value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="A1 Wrecker LLC" />

              <label style={labelStyle}>Primary contact name</label>
              <input type="text" autoComplete="name" style={inputStyle} value={contactName}
                onChange={e => setContactName(e.target.value)}
                placeholder="Your full name" />

              <label style={labelStyle}>Primary contact phone</label>
              <input type="tel" autoComplete="tel" style={inputStyle} value={contactPhone}
                onChange={e => setContactPhone(e.target.value)}
                placeholder="713-555-0100" />

              <label style={labelStyle}>Billing address (street, city, state, zip)</label>
              <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical', lineHeight: 1.5 }} value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="123 Main St, Houston, TX 77001" />

              {/* 2026-06-30 — Texas operator attestation. Renders the
                  same TEXAS_ATTESTATION_TEXT block /signup uses, then
                  the attestation checkbox. Required to enable Activate. */}
              <div style={{ marginTop: 22, padding: '14px 16px', background: 'rgba(201,162,39,0.04)', border: `1px solid rgba(201,162,39,0.18)`, borderRadius: 10 }}>
                <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px', fontWeight: 700 }}>Texas operations attestation</p>
                <pre style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{TEXAS_ATTESTATION_TEXT}</pre>
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={attestChecked} onChange={e => setAttestChecked(e.target.checked)}
                  style={{ marginTop: 3, accentColor: GOLD, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>
                  I attest to the Texas operations terms above (required).
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={tosChecked} onChange={e => setTosChecked(e.target.checked)}
                  style={{ marginTop: 3, accentColor: GOLD, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>
                  I have read and agree to the{' '}
                  <a href="/terms" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Terms of Service</a>
                  {' '}({TOS_DISPLAY_DATE}).
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={privacyChecked} onChange={e => setPrivacyChecked(e.target.checked)}
                  style={{ marginTop: 3, accentColor: GOLD, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>
                  I have read and agree to the{' '}
                  <a href="/privacy" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Privacy Policy</a>
                  {' '}({PRIVACY_DISPLAY_DATE}).
                </span>
              </label>

              {/* B118 Layer 2 Commit 3 — SaaS scroll-to-sign gate.
                  Rendered after the three checkboxes (Texas, ToS,
                  Privacy) but before the Activate button — it's the
                  final approval step. `disabled` prop grays the sign
                  button until the other three consents are granted,
                  matching the same-order gating that formError()
                  enforces. onSigned captures reviewedAt (stamped at
                  the gate's unlock moment, T1) into state; the
                  activate() call passes it to p_saas_reviewed_at.  */}
              <SaasReadthroughGate
                version={SAAS_VERSION}
                displayDate={SAAS_DISPLAY_DATE}
                disabled={!tosChecked || !privacyChecked || !attestChecked}
                onSigned={({ reviewedAt }) => {
                  setSaasReviewedAt(reviewedAt)
                  setSaasSigned(true)
                }}
              />

              {submission.kind === 'error' && (
                <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
                  <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{submission.message}</p>
                </div>
              )}

              <button onClick={activate} disabled={submission.kind === 'submitting'}
                style={{ width: '100%', marginTop: 18, background: submission.kind === 'submitting' ? '#555' : GOLD, color: submission.kind === 'submitting' ? '#888' : '#0a0d14', fontWeight: 700, fontSize: 15, padding: '13px', border: 'none', borderRadius: 10, cursor: submission.kind === 'submitting' ? 'not-allowed' : 'pointer' }}>
                {submission.kind === 'submitting' ? 'Activating…' : 'Activate account'}
              </button>

              <p style={{ color: MUTED, fontSize: 11, margin: '14px 0 0', textAlign: 'center' }}>
                Activation creates your company workspace and lands you on the dashboard.
              </p>
            </div>
          </>
        )}

        <p style={{ textAlign: 'center', color: MUTED, fontSize: 11, marginTop: 28 }}>
          © 2026 Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™
        </p>
      </div>
    </main>
  )
}
