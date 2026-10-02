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

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { OFFERINGS, TierTrack } from '../lib/tier-display'
import { TIER_CONFIG, TIER_PRICING, getTierPricing } from '../lib/tier-config'
import { resolveInitialToken, DEFAULT_TOKEN, planFor, PICKER_TOKENS, FORMERLY_LABELS_ON, type PlanToken } from '../lib/signup-tier-param'

// Card copy. Prices here are DISPLAY ONLY — what a customer is actually
// charged comes from stripe_prices server-side. Kept beside the picker
// so the four cards read as one table rather than four scattered
// strings.
const PLAN_CARD_COPY: Record<string, { who: string; price: string; note: string }> = {
  pm_starter:       { who: 'For a single property',                   price: '$149/mo flat',           note: '500 permits included, then $1.25 each' },
  pm_pro:           { who: 'For property management companies',        price: '$249/mo + $15/property', note: 'Properties 21–50 included · unlimited permits' },
  operator_starter: { who: 'Driver and office tools for towing operators', price: '$199/mo + $15/property', note: 'Properties 21–50 included' },
  operator_pro:     { who: 'The full platform for towing operators',   price: '$299/mo + $20/property', note: 'Properties 21–50 included' },
}
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
import { nameMetacharError } from '../lib/supabase-query-escape'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
import LegalGateAccordion, { type GateSpec } from '../components/LegalGateAccordion'
import TermsBody from '../components/TermsBody'
import PrivacyBody from '../components/PrivacyBody'
import { guardEmail } from '../lib/email-guard'

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

// 2026-09-03 (Picker §3): track derives from tier — the tier IS the track.
// pm_starter → PM, enforcement_only → Enforcement. custom_quote routes
// away (contact form) so never reaches this derivation.
function trackForTier(slug: string): TierTrack {
  return slug === 'pm_starter' ? 'pm' : 'enforcement'
}

// 2026-09-03 (Picker §3): runtime type guard for the self-serve slugs.
// Used at the tier-card onClick boundary to narrow OFFERINGS' full
// slug union ('legacy' | 'pm_only' | 'pm_starter' | 'enforcement_only'
// | 'custom_quote') to the two the picker can send. Per
// feedback_cast_at_vocabulary_boundary — use a runtime discriminator,
// not `as`. Custom_quote is handled separately (routes to /#contact
// before reaching this guard). If OFFERINGS ever gains a new self-
// serve slug, add it here explicitly — TS won't tell you.
type SelfServeSlug = 'pm_starter' | 'enforcement_only'
function isSelfServeSlug(s: string): s is SelfServeSlug {
  return s === 'pm_starter' || s === 'enforcement_only'
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
  // 2026-09-03 (Picker §3): tier is the primary choice; track derived.
  // Default = enforcement_only matches prior default. Only self-serve
  // slugs valid here: 'pm_starter' or 'enforcement_only'. custom_quote
  // is a routing card (never sets this state; navigates to /#contact).
  // 2026-09-28 — ?tier= preselect, allowlisted. 2026-10-02 — the value
  // is now a PLAN TOKEN, not a bare tier: `legacy` is the backend tier
  // for both PM Pro and Operator Pro, so a tier alone no longer says
  // which track it is on. The token does, and resolves to the same
  // (track, tier) pair the rest of the system has always used.
  //
  // 🔴 A LAZY INITIALIZER, NOT AN EFFECT. Two reasons, both load-bearing:
  //   1. No flash and no clobber. Setting it in an effect would paint
  //      one card selected, then swap — and the `[token]` effect below
  //      would fire a SECOND time and reset propertyCount, potentially
  //      over something the visitor had already typed.
  //   2. No hydration mismatch, because the picker never server-renders:
  //      dormancy starts 'loading' and both the loading and closed
  //      branches return before this markup.
  //
  // useSearchParams() is deliberately not used; it would bail this page
  // out of static rendering, which is the /operators R5 defect.
  const [token, setToken] = useState<PlanToken>(
    () => (typeof window === 'undefined' ? DEFAULT_TOKEN : resolveInitialToken(window.location.search)),
  )
  const plan = planFor(token)
  const tier = plan.tier
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly')
  const [propertyCount, setPropertyCount] = useState<string>('1')
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // 🟢 2026-08-29 Entry 3 — password visibility toggle. Default hidden;
  // never persisted; type="button" on the toggle so it doesn't submit.
  const [showPassword, setShowPassword] = useState(false)
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

  // 2026-10-02: the track comes from the PLAN, not from the tier. A
  // tier no longer implies a track — `legacy` is both PM Pro and
  // Operator Pro — so the derivation moved into the token map.
  const track: TierTrack = plan.track === 'property_management' ? 'pm' : 'enforcement'
  useEffect(() => {
    // PM Starter is one property by definition (the DB cap enforces it
    // too). Every other plan keeps whatever the visitor typed.
    if (plan.tier === 'pm_starter') setPropertyCount('1')
    // Intentionally no dep on propertyCount — this is the "plan just
    // changed" reset, not a live guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // ── Pricing preview (display source: TIER_PRICING + OFFERINGS) ────
  // Authoritative prices used for the actual Stripe Checkout line items
  // come from stripe_prices.unit_amount_cents (server-side). This is
  // for the in-form preview only.
  const tk = trackKey(track)
  const selectedTier = OFFERINGS.find(o => o.slug === tier)
  // 2026-09-04 TIER_PRICING shape change: { base, perProperty }.
  // getTierPricing() widens the union-keyed map at the call site
  // (runtime lookup — signup can pass any string tier).
  const baseMonthly = getTierPricing(tk, tier)?.base ?? selectedTier?.base ?? 0
  const perPropMonthly = selectedTier?.perProp ?? 0
  const perDriverMonthly = selectedTier?.perDriver ?? 0

  const pCount = Math.max(0, parseInt(propertyCount, 10) || 0)
  // 🔴 ALWAYS 0. The Drivers field is removed: per-driver charging was
  // retired with the 3-tier move and the catalog creates no per_driver
  // price, so asking for a count implied a charge that does not exist.
  // The field is still SENT, as 0, because order_forms.driver_count is
  // NOT NULL and create-checkout-session requires the key to be a
  // number — omitting it would 400 as "intended_tier malformed".
  const dCount = 0
  const monthlyTotal = baseMonthly + (perPropMonthly * pCount) + (perDriverMonthly * dCount)
  const annualTotal = monthlyTotal * 10  // ~17% discount (matches B66.2a multiplier)
  const totalThisCycle = cycle === 'monthly' ? monthlyTotal : annualTotal

  // ── Tier limit guardrails ────────────────────────────────────────
  const tierCfg = TIER_CONFIG[tk]?.[tier]
  const maxProperties = (tierCfg?.[FEATURE_FLAGS.MAX_PROPERTIES] as number) ?? -1
  const propertyLimitReached = maxProperties !== -1 && pCount > maxProperties

  // ── Validation ───────────────────────────────────────────────────
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const passwordErr = validatePassword(password)
  const propertyCountOk = pCount >= 1 && !propertyLimitReached
  const companyNameOk = companyName.trim().length > 0
  // Metachar rejection lives in the shared write-time helper — same
  // characters (%, _, \) blocked by the DB CHECK constraint (migration
  // 20260901_companies_and_properties_name_metachar_check). Client
  // check surfaces the error inline BEFORE submit; server CHECK is
  // the enforcement boundary.
  const companyNameMetacharErr = nameMetacharError(companyName, 'company')
  // captchaToken added to allOk so Submit disables until the widget callback fires.
  // ToS + Privacy are now gate-signed (accordion) — signed = non-null reviewed_at.
  const allOk = companyNameOk && !companyNameMetacharErr && emailOk && !passwordErr && propertyCountOk
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


    // ⚠ TOURNIQUET, CLIENT-SIDE — see app/lib/email-guard.ts.
    // This page calls supabase.auth.signUp() DIRECTLY against GoTrue;
    // there is no API route in between, so this check is UX and
    // consistency, NOT a control — an attacker POSTs straight to the
    // auth endpoint and never runs it. It is here so an honest user
    // doesn't create an account the rest of the product will refuse.
    // Treat /signup as OPEN until the policy rewrite lands.
    const emailGuard = guardEmail(trimmedEmail)
    if (!emailGuard.ok) {
      setSubmission({ kind: 'error', message: emailGuard.message })
      return
    }
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

        {/* ── PLAN CARDS — the Oct 2026 lineup ────────────────────────
            Four self-serve plans plus an Elite card.

            🔴 Elite is NOT self-serve and must not look like it is. It
            routes to the existing lead form — same form, same Turnstile,
            same table — with ?src=elite so the row and the alert say
            what it was. No new form, no new endpoint.

            "Starter" means different things per track and the
            one-liners carry it: PM Starter is ONE PROPERTY; Operator
            Starter is fewer FEATURES across up to 50. Shortening those
            away would make the ladder look like a simple price step. */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>1. Choose your plan</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            {PICKER_TOKENS.map((t) => {
              const p = planFor(t)
              const selected = token === t
              const copy = PLAN_CARD_COPY[t]
              return (
                <button key={t} onClick={() => setToken(t)} style={{
                  textAlign: 'left', padding: 14, borderRadius: 10,
                  border: selected ? `2px solid ${GOLD}` : `1px solid ${BORDER}`,
                  background: selected ? 'rgba(201,162,39,0.10)' : 'transparent',
                  color: TEXT, cursor: 'pointer', fontFamily: 'inherit',
                  textDecoration: 'none', display: 'block',
                }}>
                  <div style={{ color: selected ? GOLD : TEXT, fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{p.label}</div>
                  {FORMERLY_LABELS_ON && p.formerly && (
                    <div style={{ color: MUTED, fontSize: 10, marginBottom: 4 }}>formerly {p.formerly}</div>
                  )}
                  <div style={{ color: MUTED, fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>{copy.who}</div>
                  <div style={{ color: MUTED, fontSize: 12 }}>{copy.price}</div>
                  <div style={{ color: MUTED, fontSize: 11 }}>{copy.note}</div>
                </button>
              )
            })}
          </div>

          {/* ELITE — a lead, not a checkout. Two doors so the lead lands
              on the right track's form; src=elite is an existing allowed
              key, so it reaches leads.source and the alert unchanged. */}
          <div style={{ marginTop: 14, padding: 14, borderRadius: 10, border: `1px solid ${BORDER}`, background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ color: TEXT, fontWeight: 700, fontSize: 14 }}>More than 50 properties?</div>
            <div style={{ color: MUTED, fontSize: 12, margin: '4px 0 10px', lineHeight: 1.5 }}>
              Large portfolios, universities and large fleets get pricing built around them.
              Tell us about your business and we&apos;ll be in touch.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href="/property-managers?src=elite#start" style={{ color: GOLD, fontSize: 12, fontWeight: 700, textDecoration: 'none', border: `1px solid ${GOLD}`, borderRadius: 8, padding: '8px 12px' }}>
                I manage properties — talk to us →
              </a>
              <a href="/operators?src=elite#start" style={{ color: GOLD, fontSize: 12, fontWeight: 700, textDecoration: 'none', border: `1px solid ${GOLD}`, borderRadius: 8, padding: '8px 12px' }}>
                I run a towing company — talk to us →
              </a>
            </div>
          </div>
        </div>

        {/* CYCLE TOGGLE */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>2. Billing cycle</p>
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

        {/* COUNTS — for enforcement_only only. pm_starter is 1-property
            by definition (forced by tier-change useEffect); the count
            section is skipped rather than shown as a locked field. */}
        {/* ── Property count ──────────────────────────────────────────
            Shown for every plan EXCEPT PM Starter, which is one
            property by definition. It used to be gated on
            enforcement_only; PM Pro and Operator Pro charge per
            property too, so that gate would have hidden the field from
            two of the four plans and billed them at one property.

            🔴 THE DRIVERS FIELD IS GONE. Per-driver charging was retired
            with the 3-tier move and the catalog creates no per_driver
            price, so asking for a count implied a charge that does not
            exist. driver_count is still SENT as 0 — order_forms.
            driver_count is NOT NULL and create-checkout-session requires
            the key to be a number, so omitting it would 400 as
            "intended_tier malformed". */}
        {tier !== 'pm_starter' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
            <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>3. Properties</p>
            <div style={{ maxWidth: 320 }}>
              <label style={labelStyle}>How many properties?</label>
              <input type="number" min={1} max={maxProperties === -1 ? undefined : maxProperties} value={propertyCount}
                onChange={e => setPropertyCount(e.target.value)} style={inputStyle} />
              {propertyLimitReached && (
                <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>
                  More than {maxProperties} properties is an Elite plan — use &ldquo;Talk to us&rdquo; above.
                </p>
              )}
              <p style={{ color: MUTED, fontSize: 11, margin: '6px 0 0' }}>
                You pay per property up to 20. Properties 21&ndash;50 are included.
              </p>
            </div>
          </div>
        )}

        {/* COMPANY + ACCOUNT */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px', fontWeight: 700 }}>{tier === 'pm_starter' ? '3' : '4'}. Account details</p>
          <label style={labelStyle}>Company name</label>
          <input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Towing LLC" style={inputStyle} />
          {companyName && companyNameMetacharErr && <p style={{ color: '#f44336', fontSize: 11, margin: '4px 0 0' }}>{companyNameMetacharErr}</p>}
          <label style={labelStyle}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} />
          {email && !emailOk && <p style={{ color: '#f44336', fontSize: 11, margin: '4px 0 0' }}>Enter a valid email address.</p>}
          <label style={labelStyle}>Password</label>
          <div style={{ position: 'relative' }}>
            <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters"
              style={{ ...inputStyle, paddingRight: 60 }} />
            <button type="button" onClick={() => setShowPassword(v => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer', padding: '6px 8px', fontFamily: 'inherit' }}
            >{showPassword ? 'Hide' : 'Show'}</button>
          </div>
          {password && passwordErr && <p style={{ color: '#f44336', fontSize: 11, margin: '4px 0 0' }}>{passwordErr}</p>}
        </div>

        {/* LEGAL ACCEPTANCE — Texas attestation stays a checkbox (informational
            wording without a document body). ToS + Privacy each get a
            <LegalReadthroughGate> inside the accordion — scroll-through
            required to enable Sign, reviewed_at captured at unlock (T1) and
            passed to accept_signup_consents via user_metadata. */}
        <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 24, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>{tier === 'pm_starter' ? '4' : '5'}. Legal acceptance</p>
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

        {/* COST PREVIEW — different shape per tier:
              pm_starter        → "$149.00 (500 permits included, then $1.25 each)"
              enforcement_only  → "$199 base + $15/property × N" (+ annual note)
            perProp:null on Starter would previously have rendered as
            "$null/property"; the tier branch here + the tier-cards
            render both handle the missing per-property axis correctly. */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ color: MUTED, fontSize: 13 }}>Estimated {cycle === 'monthly' ? 'monthly' : 'annual'} cost</span>
            <span style={{ color: GOLD, fontSize: 26, fontWeight: 800 }}>${totalThisCycle.toFixed(2)}</span>
          </div>
          {tier === 'pm_starter' && selectedTier?.permitAllowance ? (
            <p style={{ color: MUTED, fontSize: 11, margin: 0 }}>
              ${baseMonthly}/mo flat for one property
              {' — '}
              {selectedTier.permitAllowance.includedUpTo} permits included, then ${selectedTier.permitAllowance.overageRate.toFixed(2)} each
              {cycle === 'annual' && ' · × 10 months (annual prepay)'}
            </p>
          ) : (
            <p style={{ color: MUTED, fontSize: 11, margin: 0 }}>
              ${baseMonthly}/mo base + ${perPropMonthly}/property × {pCount}
              {track === 'enforcement' && perDriverMonthly > 0 && ` + $${perDriverMonthly}/driver × ${dCount}`}
              {cycle === 'annual' && ' × 10 months (annual prepay)'}
            </p>
          )}
        </div>

        {/* CAPTCHA — Cloudflare Turnstile (Managed). Sits above Submit so the
            user clears the challenge before they can click. Widget callback
            sets captchaToken; expiry/error clears it so Submit re-disables. */}
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
          <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>{tier === 'pm_starter' ? '5' : '6'}. Confirm you&apos;re human</p>
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
        <a href="mailto:hello@shieldmylot.com" style={{ display: 'inline-block', marginTop: 24, color: GOLD, fontSize: 14, textDecoration: 'none' }}>Contact support →</a>
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
