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

import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../supabase'
import { TIER_PRICING } from '../../lib/tier-config'
import { ENFORCEMENT_TIERS, PROPERTY_MANAGEMENT_TIERS } from '../../lib/tier-display'

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

export default function SignupVerify() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [attesting, setAttesting] = useState(false)
  const [proceeding, setProceeding] = useState(false)

  useEffect(() => {
    let resolved = false
    let cancelled = false

    async function onSession(session: Session | null) {
      if (resolved || cancelled) return
      const user = session?.user
      if (!user?.email_confirmed_at) return
      resolved = true

      const meta = (user.user_metadata || {}) as Record<string, unknown>
      const intendedRaw = meta.intended_tier
      if (!intendedRaw || typeof intendedRaw !== 'object') {
        setStatus({ kind: 'missing_tier' })
        return
      }
      const intended = intendedRaw as IntendedTier

      // Record the Texas attestation. /api/signup/attest is idempotent
      // (matches on user_id + document_type + version) so a refresh
      // doesn't duplicate. Failures bubble to attest_error state — the
      // user can retry by refreshing the page.
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

      if (!cancelled) {
        setStatus({ kind: 'ready', user, tier: intended })
      }
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
  }, [])

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
          <UnverifiedCard />
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

        {status.kind === 'ready' && (
          <ReadyCard user={status.user} tier={status.tier} proceeding={proceeding} onProceed={proceedToCheckout} />
        )}

      </div>
    </main>
  )
}

// ── Sub-components ───────────────────────────────────────────────────

function UnverifiedCard() {
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>📧</div>
      <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Verify your email to continue</h2>
      <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
        We couldn&apos;t pick up your verified session. The verification email link must be opened
        in the <strong>same browser</strong> you used to sign up — switching browsers (or using
        incognito after starting in a regular window) breaks the link. If you opened it elsewhere,
        restart signup below.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <a href="/signup" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Restart signup</a>
        <a href="/login" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Sign in</a>
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

      <button onClick={onProceed} disabled={proceeding}
        style={{
          width: '100%', padding: '16px', background: proceeding ? '#1e2535' : GOLD,
          color: proceeding ? '#555' : '#0a0d14', fontWeight: 700, fontSize: 15,
          border: 'none', borderRadius: 10, cursor: proceeding ? 'not-allowed' : 'pointer',
        }}>
        {proceeding ? 'Redirecting to checkout…' : 'Continue → Stripe Checkout'}
      </button>
      <p style={{ color: MUTED, fontSize: 12, textAlign: 'center', margin: '14px 0 0' }}>
        Payment is securely handled by Stripe. You&apos;ll return to this site after completing checkout.
      </p>
    </>
  )
}
