'use client'
// B66.3 — self-serve signup tier picker form. Replaces the B65.2
// placeholder. Renders the "Coming soon" placeholder branch when the
// platform_settings dormancy flags are off (stripe_billing_enabled OR
// public_signup_open false); renders the form when both are true.
// Flag flip is a launch-day decision; pre-launch UAT can flip them
// briefly to exercise the path then flip back.
//
// Flow Shape 1 (verify-first): collects tier + counts + company name +
// email + password + Texas attestation on this page → calls auth.signUp
// with intended_tier in user_metadata → user receives email → clicks
// link → /signup/verify resumes the flow.

import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { ENFORCEMENT_TIERS, PROPERTY_MANAGEMENT_TIERS, TierTrack, TierDisplay } from '../lib/tier-display'
import { TIER_CONFIG, TIER_PRICING } from '../lib/tier-config'
import { FEATURE_FLAGS } from '../lib/feature-flags'
import {
  TEXAS_ATTESTATION_VERSION,
  TEXAS_ATTESTATION_TEXT,
  TOS_VERSION,
  TOS_DISPLAY_DATE,
  PRIVACY_VERSION,
  PRIVACY_DISPLAY_DATE,
} from '../lib/legal-versions'
import { validatePassword } from '../lib/password-rules'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
import LegalGateAccordion, { type GateSpec } from '../components/LegalGateAccordion'
import TermsBody from '../components/TermsBody'
import PrivacyBody from '../components/PrivacyBody'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

// tier-display uses 'pm', tier-config uses 'property_management'. Map.
function trackKey(t: TierTrack): 'enforcement' | 'property_management' {
  return t === 'enforcement' ? 'enforcement' : 'property_management'
}

// Premium is contact-sales (B89); never appears in the self-serve picker.
function selfServeTiers(t: TierTrack): TierDisplay[] {
  const all = t === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS
  return all.filter(tier => !tier.enterprise)  // contact-sales render branch flag
}

// B2-5 C2 (2026-07-21) — tierSlug(name.toLowerCase()) removed. Was
// producing "pm-only" (hyphen); stripe_prices.tier_name CHECK requires
// 'pm_only' / 'enforcement_only' / 'legacy' (underscore). Consumers now
// read t.slug directly off the TierDisplay entry — canonical values
// live in one place, and the union type prevents typos.

type DormancyState = { kind: 'loading' } | { kind: 'closed' } | { kind: 'open' }
type Submission =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'sent'; email: string }
  | { kind: 'already_registered' }
  | { kind: 'error'; message: string }

export default function SignupTierPicker() {
  // ── Dormancy gate ────────────────────────────────────────────────
  const [dormancy, setDormancy] = useState<DormancyState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetch('/api/signup/dormancy')
      .then(r => r.ok ? r.json() : { open: false })
      .then(body => { if (!cancelled) setDormancy({ kind: body.open ? 'open' : 'closed' }) })
      .catch(() => { if (!cancelled) setDormancy({ kind: 'closed' }) })
    return () => { cancelled = true }
  }, [])

  // ── Form state ───────────────────────────────────────────────────
  const [track, setTrack] = useState<TierTrack>('enforcement')
  const [tier, setTier] = useState<string>('legacy')
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly')
  const [propertyCount, setPropertyCount] = useState<string>('1')
  const [driverCount, setDriverCount] = useState<string>('1')
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [attestChecked, setAttestChecked] = useState(false)
  // B118 Layer 2 Commit 3 — replace ToS + Privacy checkboxes with the
  // <LegalGateAccordion> (scroll-to-sign gate per document). reviewed_at
  // stamps flow into user_metadata at auth.signUp, then get consumed by
  // /api/signup/attest → accept_signup_consents(p_tos_reviewed_at,
  // p_privacy_reviewed_at) after email verification.
  const [tosReviewedAt, setTosReviewedAt] = useState<string | null>(null)
  const [privacyReviewedAt, setPrivacyReviewedAt] = useState<string | null>(null)
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })

  // CAPTCHA (Cloudflare Turnstile, Managed mode). Token set by widget callback;
  // cleared on expire or post-submit-error. Token is single-use — every submit
  // attempt needs a fresh challenge, which is why we reset the widget on error.
  // Supabase verifies the token server-side via the Dashboard CAPTCHA toggle
  // (Jose flips after deploy) — no /siteverify call from this page.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  const tiers = useMemo(() => selfServeTiers(track), [track])
  useEffect(() => {
    // Reset tier when track changes to avoid carrying a stale tier across tracks.
    setTier(tiers[0]?.slug ?? 'legacy')
    if (track === 'pm') setDriverCount('0')
  }, [track, tiers])

  // ── Pricing preview (display source: TIER_PRICING + tier-display) ─
  // Authoritative prices used for the actual Stripe Checkout line items
  // come from stripe_prices.unit_amount_cents (server-side). This is
  // for the in-form preview only; admin-edited platform_settings might
  // drift slightly from tier-display.ts numbers between launches.
  const tk = trackKey(track)
  const selectedTier = tiers.find(t => t.slug === tier)
  const baseMonthly = TIER_PRICING[tk]?.[tier] ?? selectedTier?.base ?? 0
  const perPropMonthly = selectedTier?.perProp ?? 0
  const perDriverMonthly = selectedTier?.perDriver ?? 0

  const pCount = Math.max(0, parseInt(propertyCount, 10) || 0)
  const dCount = track === 'enforcement' ? Math.max(0, parseInt(driverCount, 10) || 0) : 0
  const monthlyTotal = baseMonthly + (perPropMonthly * pCount) + (perDriverMonthly * dCount)
  const annualTotal = monthlyTotal * 10  // ~17% discount (matches B66.2a multiplier)
  const totalThisCycle = cycle === 'monthly' ? monthlyTotal : annualTotal

  // ── Tier limit guardrails ────────────────────────────────────────
  const tierCfg = TIER_CONFIG[tk]?.[tier]
  const maxProperties = (tierCfg?.[FEATURE_FLAGS.MAX_PROPERTIES] as number) ?? -1
  const maxDrivers = (tierCfg?.[FEATURE_FLAGS.MAX_DRIVERS] as number) ?? -1
  const propertyLimitReached = maxProperties !== -1 && pCount > maxProperties
  const driverLimitReached = track === 'enforcement' && maxDrivers !== -1 && dCount > maxDrivers

  // ── Validation ───────────────────────────────────────────────────
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const passwordErr = validatePassword(password)
  const propertyCountOk = pCount >= 1 && !propertyLimitReached
  const driverCountOk = track === 'pm' || (dCount >= 1 && !driverLimitReached)
  const companyNameOk = companyName.trim().length > 0
  // captchaToken added to allOk so Submit disables until the widget callback fires.
  // ToS + Privacy are now gate-signed (accordion) — signed = non-null reviewed_at.
  const allOk = companyNameOk && emailOk && !passwordErr && propertyCountOk && driverCountOk
    && attestChecked && !!tosReviewedAt && !!privacyReviewedAt && !!captchaToken

  // ── Submit ────────────────────────────────────────────────────────
  async function submit() {
    if (!allOk) return
    // Explicit captchaToken guard — matches the defensive shape used by
    // /signup/redeem, /register, and /visitor. allOk's !!captchaToken
    // already covers the disabled button, but an explicit guard inside
    // submit() means all four forms read the same way (no "why is
    // /signup defensively shaped differently?" question for the next
    // reader). Also lets us surface a clear error message rather than
    // relying on the captchaToken! non-null assertion below.
    if (!captchaToken) {
      setSubmission({ kind: 'error', message: 'Please complete the CAPTCHA challenge below before submitting.' })
      return
    }
    setSubmission({ kind: 'submitting' })
    const trimmedEmail = email.trim().toLowerCase()
    const intendedTier = {
      track: tk,
      tier,
      cycle,
      property_count: pCount,
      driver_count: dCount,
      company_name: companyName.trim(),
    }
    const emailRedirectTo = typeof window === 'undefined'
      ? 'https://shieldmylot.com/signup/verify'
      : `${window.location.origin}/signup/verify`

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        emailRedirectTo,
        // CAPTCHA — Supabase verifies the token against Cloudflare server-side
        // before creating auth.users. Requires the Supabase Dashboard CAPTCHA
        // toggle to be ON (Jose flips after this deploy lands). With the toggle
        // OFF, Supabase ignores captchaToken — same code works pre- and post-
        // toggle, so the deploy → toggle ordering is safe.
        captchaToken,
        // intended_tier rides in user_metadata (mirrors B65's
        // proposal_code pattern). /signup/verify reads this to render
        // the tier summary + drive the create-checkout-session call.
        // All 3 consent versions stashed alongside so /signup/verify
        // can call /api/signup/attest with the exact version strings
        // the user saw + checked at form-submit time (per B118 multi-
        // doc consent capture).
        data: {
          intended_tier: intendedTier,
          attestation_version: TEXAS_ATTESTATION_VERSION,
          tos_version: TOS_VERSION,
          privacy_version: PRIVACY_VERSION,
          // B118 Layer 2 Commit 3 — reviewed_at stamps captured by the
          // <LegalGateAccordion> gates on this page. Read by
          // /api/signup/attest post-verify and passed to the 7-arg
          // accept_signup_consents RPC.
          tos_reviewed_at: tosReviewedAt,
          privacy_reviewed_at: privacyReviewedAt,
          acquisition_channel: 'self_serve',
        },
      },
    })

    if (error) {
      // CAPTCHA failure surfaces with a captcha-related message from Supabase.
      // Reset the widget so the user can re-challenge without a page reload
      // (Turnstile tokens are single-use; every submit needs a fresh token).
      const msg = error.message || 'Sign-up failed. Please try again.'
      const isCaptcha = /captcha|verification/i.test(msg)
      if (isCaptcha) {
        turnstileRef.current?.reset()
        setCaptchaToken(null)
        setSubmission({ kind: 'error', message: 'CAPTCHA verification failed. Please complete the challenge below and try again.' })
      } else {
        setSubmission({ kind: 'error', message: msg })
      }
      return
    }
    // B65 pattern: empty identities array means email is already confirmed
    // (anti-enumeration). Surface a friendly non-leaking message.
    if (data.user?.identities && data.user.identities.length === 0) {
      setSubmission({ kind: 'already_registered' })
      return
    }
    setSubmission({ kind: 'sent', email: trimmedEmail })
  }

  // ── Render: dormancy placeholder (unchanged B65.2 messaging) ─────
  if (dormancy.kind === 'loading') {
    return (
      <main style={{ minHeight: '100vh', background: BG, color: MUTED, fontFamily: 'system-ui, Arial, sans-serif', padding: 48, textAlign: 'center' }}>
        Loading…
      </main>
    )
  }
  if (dormancy.kind === 'closed') {
    return <SignupClosedPlaceholder />
  }

  // ── Render: submission state branches ────────────────────────────
  if (submission.kind === 'sent') {
    return <CheckYourEmail email={submission.email} />
  }
  if (submission.kind === 'already_registered') {
    return <AlreadyRegistered />
  }

  // ── Render: tier picker form (dormancy open + editing/submitting/error) ─
  const inputStyle: React.CSSProperties = {
    background: '#0a0d14', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    padding: '12px 16px', color: '#fff', width: '100%', fontSize: 14,
    boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  }
  const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 6, marginTop: 14 }

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '48px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Sign up for ShieldMyLot</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>Texas parking enforcement &amp; property management</p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '14px auto 0' }} />
        </div>

        {/* TRACK SELECTOR */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>1. Choose your track</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['enforcement', 'pm'] as const).map(t => (
              <button key={t}
                onClick={() => setTrack(t)}
                style={{
                  flex: 1, padding: '12px 16px', borderRadius: 10, border: track === t ? `2px solid ${GOLD}` : `1px solid ${BORDER}`,
                  background: track === t ? 'rgba(201,162,39,0.10)' : 'transparent',
                  color: track === t ? GOLD : TEXT, fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}>
                {t === 'enforcement' ? 'Enforcement' : 'Property Management'}
              </button>
            ))}
          </div>
        </div>

        {/* TIER CARDS */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>2. Choose your tier</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {tiers.map((t) => {
              const selected = tier === t.slug
              return (
                <button key={t.slug}
                  onClick={() => setTier(t.slug)}
                  style={{
                    textAlign: 'left', padding: 14, borderRadius: 10,
                    border: selected ? `2px solid ${GOLD}` : `1px solid ${BORDER}`,
                    background: selected ? 'rgba(201,162,39,0.10)' : 'transparent',
                    color: TEXT, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                  <div style={{ color: selected ? GOLD : TEXT, fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{t.name}</div>
                  <div style={{ color: MUTED, fontSize: 12 }}>${t.base}/mo base</div>
                  <div style={{ color: MUTED, fontSize: 11 }}>+ ${t.perProp}/property{t.perDriver ? ` + $${t.perDriver}/driver` : ''}</div>
                </button>
              )
            })}
          </div>
        </div>

        {/* CYCLE TOGGLE */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>3. Billing cycle</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['monthly', 'annual'] as const).map(c => (
              <button key={c}
                onClick={() => setCycle(c)}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 10,
                  border: cycle === c ? `2px solid ${GOLD}` : `1px solid ${BORDER}`,
                  background: cycle === c ? 'rgba(201,162,39,0.10)' : 'transparent',
                  color: cycle === c ? GOLD : TEXT, fontWeight: 600, fontSize: 13, cursor: 'pointer',
                }}>
                {c === 'monthly' ? 'Monthly' : 'Annual (~17% off)'}
              </button>
            ))}
          </div>
        </div>

        {/* COUNTS */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>4. Initial counts</p>
          <div style={{ display: 'grid', gridTemplateColumns: track === 'enforcement' ? '1fr 1fr' : '1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Properties{maxProperties !== -1 && ` (max ${maxProperties} on ${selectedTier?.name})`}</label>
              <input type="number" min={1} max={maxProperties === -1 ? undefined : maxProperties} value={propertyCount}
                onChange={e => setPropertyCount(e.target.value)} style={inputStyle} />
              {propertyLimitReached && (
                <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>Exceeds {selectedTier?.name} limit ({maxProperties}). Upgrade tier or reduce.</p>
              )}
            </div>
            {track === 'enforcement' && (
              <div>
                <label style={labelStyle}>Drivers{maxDrivers !== -1 && ` (max ${maxDrivers})`}</label>
                <input type="number" min={1} max={maxDrivers === -1 ? undefined : maxDrivers} value={driverCount}
                  onChange={e => setDriverCount(e.target.value)} style={inputStyle} />
                {driverLimitReached && (
                  <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>Exceeds {selectedTier?.name} limit ({maxDrivers}).</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* COMPANY + ACCOUNT */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>5. Account details</p>
          <label style={labelStyle}>Company name</label>
          <input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Towing LLC" style={inputStyle} />
          <label style={labelStyle}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} />
          {email && !emailOk && <p style={{ color: '#f44336', fontSize: 11, margin: '4px 0 0' }}>Enter a valid email address.</p>}
          <label style={labelStyle}>Password</label>
          <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" style={inputStyle} />
          {password && passwordErr && <p style={{ color: '#f44336', fontSize: 11, margin: '4px 0 0' }}>{passwordErr}</p>}
        </div>

        {/* LEGAL ACCEPTANCE — Texas attestation stays a checkbox (informational
            wording without a document body). ToS + Privacy each get a
            <LegalReadthroughGate> inside the accordion — scroll-through
            required to enable Sign, reviewed_at captured at unlock (T1) and
            passed to accept_signup_consents via user_metadata. */}
        <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>6. Legal acceptance</p>
          <div style={{ background: '#0a0d14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 14, marginBottom: 14, fontSize: 13, color: '#94a3b8', whiteSpace: 'pre-line', lineHeight: 1.6 }}>
            {TEXAS_ATTESTATION_TEXT}
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 14 }}>
            <input type="checkbox" checked={attestChecked} onChange={e => setAttestChecked(e.target.checked)} style={{ marginTop: 3, accentColor: GOLD, cursor: 'pointer' }} />
            <span style={{ color: TEXT, fontSize: 13, lineHeight: 1.5 }}>I attest to the Texas operations terms above (required).</span>
          </label>
          <LegalGateAccordion
            disabled={!attestChecked}
            signedKeys={[
              ...(tosReviewedAt ? ['tos'] : []),
              ...(privacyReviewedAt ? ['privacy'] : []),
            ]}
            onGateSigned={(key, { reviewedAt }) => {
              if (key === 'tos') setTosReviewedAt(reviewedAt)
              else if (key === 'privacy') setPrivacyReviewedAt(reviewedAt)
            }}
            gates={[
              {
                key: 'tos',
                title: 'Terms of Use',
                version: TOS_VERSION,
                displayDate: TOS_DISPLAY_DATE,
                body: <TermsBody />,
                signButtonLabel: 'Sign & Accept Terms of Use',
              },
              {
                key: 'privacy',
                title: 'Privacy Policy',
                version: PRIVACY_VERSION,
                displayDate: PRIVACY_DISPLAY_DATE,
                body: <PrivacyBody />,
                signButtonLabel: 'Sign & Accept Privacy Policy',
              },
            ] satisfies GateSpec[]}
          />
        </div>

        {/* COST PREVIEW */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ color: MUTED, fontSize: 13 }}>Estimated {cycle === 'monthly' ? 'monthly' : 'annual'} cost</span>
            <span style={{ color: GOLD, fontSize: 26, fontWeight: 800 }}>${totalThisCycle.toFixed(2)}</span>
          </div>
          <p style={{ color: MUTED, fontSize: 11, margin: 0 }}>
            ${baseMonthly}/mo base + ${perPropMonthly}/property × {pCount}
            {track === 'enforcement' && ` + $${perDriverMonthly}/driver × ${dCount}`}
            {cycle === 'annual' && ' × 10 months (annual prepay)'}
          </p>
        </div>

        {/* CAPTCHA — Cloudflare Turnstile (Managed). Sits above Submit so the
            user clears the challenge before they can click. Widget callback
            sets captchaToken; expiry/error clears it so Submit re-disables. */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>7. Confirm you&apos;re human</p>
          <TurnstileWidget
            ref={turnstileRef}
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            onError={() => setCaptchaToken(null)}
            action="signup"
          />
        </div>

        {/* SUBMIT */}
        {submission.kind === 'error' && (
          <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
            <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{submission.message}</p>
          </div>
        )}
        <button onClick={submit} disabled={!allOk || submission.kind === 'submitting'}
          style={{
            width: '100%', padding: '16px', background: !allOk || submission.kind === 'submitting' ? '#1e2535' : GOLD,
            color: !allOk || submission.kind === 'submitting' ? '#555' : '#0a0d14',
            fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 10,
            cursor: !allOk || submission.kind === 'submitting' ? 'not-allowed' : 'pointer',
          }}>
          {submission.kind === 'submitting' ? 'Sending verification email…' : 'Continue → Verify email'}
        </button>
        <p style={{ color: MUTED, fontSize: 12, textAlign: 'center', margin: '14px 0 0' }}>
          We&apos;ll email you a verification link before charging anything. No payment is collected on this page.
        </p>
        {/* B117 Recommendation A: pre-link-issuance inline guidance. */}
        <p style={{ color: '#fbbf24', fontSize: 12, textAlign: 'center', margin: '10px 0 0', lineHeight: 1.5 }}>
          ⓘ Open the verification link in <strong>this same browser</strong> — links don&apos;t
          work across browsers (or in incognito if you started in a regular window).
        </p>

      </div>
    </main>
  )
}

// ── Sub-components ───────────────────────────────────────────────────

function SignupClosedPlaceholder() {
  // Mirrors B65.2 messaging for the dormant state. When dormancy flags
  // flip on at launch day, this branch stops rendering and the form
  // takes over.
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '80px 24px', textAlign: 'center' }}>
      <div style={{ maxWidth: 540, margin: '0 auto' }}>
        <div style={{ display: 'inline-block', background: 'rgba(201,162,39,0.10)', border: `1px solid rgba(201,162,39,0.4)`, color: GOLD, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 14px', borderRadius: 999, marginBottom: 20 }}>
          Coming soon
        </div>
        <h1 style={{ fontSize: 36, fontWeight: 800, margin: '0 0 14px', letterSpacing: '-0.02em' }}>Self-serve signup is launching soon</h1>
        <p style={{ color: '#94a3b8', fontSize: 16, lineHeight: 1.6, margin: '0 0 12px' }}>
          We&apos;re finishing the self-serve onboarding flow now. Check back shortly, or contact us if you&apos;d like to start sooner.
        </p>
        <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
          Already have a proposal code? Use the link in your proposal email to activate your account.
        </p>
        <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '24px auto 0' }} />
        <a href="mailto:support@shieldmylot.com" style={{ display: 'inline-block', marginTop: 24, color: GOLD, fontSize: 14, textDecoration: 'none' }}>Contact support →</a>
      </div>
    </main>
  )
}

function CheckYourEmail({ email }: { email: string }) {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '80px 24px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>📧</div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.01em' }}>Check your email</h1>
        <p style={{ color: '#94a3b8', fontSize: 15, lineHeight: 1.6, margin: '0 0 6px' }}>
          We sent a verification link to <strong style={{ color: TEXT, wordBreak: 'break-all' }}>{email}</strong>.
        </p>
        <p style={{ color: MUTED, fontSize: 14, margin: '0 0 24px' }}>
          Click the link to continue with payment. The link is valid for 24 hours.
        </p>
        <p style={{ color: MUTED, fontSize: 12 }}>
          Wrong email? <a href="/signup" style={{ color: GOLD, textDecoration: 'none' }}>Start over</a>
        </p>
      </div>
    </main>
  )
}

function AlreadyRegistered() {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '80px 24px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 12px' }}>That email is already registered</h1>
        <p style={{ color: '#94a3b8', fontSize: 15, lineHeight: 1.6, margin: '0 0 24px' }}>
          If you forgot your password, <a href="/forgot-password" style={{ color: GOLD, textDecoration: 'none' }}>reset it here</a>.
          Otherwise, <a href="/login" style={{ color: GOLD, textDecoration: 'none' }}>sign in</a>.
        </p>
      </div>
    </main>
  )
}
