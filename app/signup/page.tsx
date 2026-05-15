'use client'
// B65.2: public /signup placeholder. Self-serve Stripe-paid signup is
// deferred to B66 — this page lives as a "we're working on it, leave your
// info" surface so the marketing-side CTAs have a target.
//
// Customers WITH a negotiated proposal code go through /signup/redeem
// (built in B65.3+). This page deliberately does NOT link to /signup/redeem;
// proposal codes are distributed via PDF + email by the admin, not advertised
// here.
//
// Email capture reuses the existing mailto: contact mechanism from the
// landing page (sendContact equivalent). No backend write — the form opens
// the user's mail client with a pre-filled message.

import { useState } from 'react'
import { ENFORCEMENT_TIERS, PROPERTY_MANAGEMENT_TIERS, TierTrack, TierDisplay } from '../lib/tier-display'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export default function SignupPlaceholder() {
  const [activeTrack, setActiveTrack] = useState<TierTrack>('enforcement')
  const [contact, setContact] = useState({ name: '', email: '', company: '' })

  function sendInterest() {
    const trackLabel = activeTrack === 'enforcement' ? 'Enforcement' : 'Property Management'
    const subject = encodeURIComponent(`[Self-serve signup interest] ${contact.company || contact.name}`)
    const body = encodeURIComponent(
      `Name: ${contact.name}\nEmail: ${contact.email}\nCompany: ${contact.company}\nTrack: ${trackLabel}\n\n` +
      `Interest in self-serve signup. Please reach out when it launches.`
    )
    window.location.href = `mailto:support@shieldmylot.com?subject=${subject}&body=${body}`
  }

  const tiers: TierDisplay[] = activeTrack === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS

  const inputStyle: React.CSSProperties = {
    background: '#0a0d14', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    padding: '12px 16px', color: '#fff', width: '100%', fontSize: 14,
    marginBottom: 12, boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  }
  const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 6 }

  const canSubmit = contact.name.trim().length > 0 && contact.email.trim().length > 0

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif' }}>

      {/* HERO */}
      <section style={{ padding: '80px 24px 56px' }}>
        <div style={{ maxWidth: 880, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', background: 'rgba(201,162,39,0.10)', border: `1px solid rgba(201,162,39,0.4)`, color: GOLD, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 14px', borderRadius: 999, marginBottom: 20 }}>
            Coming soon
          </div>
          <h1 style={{ fontSize: 42, fontWeight: 800, margin: '0 0 16px', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
            Self-serve signup is launching soon
          </h1>
          <p style={{ color: '#94a3b8', fontSize: 17, lineHeight: 1.6, margin: '0 auto 8px', maxWidth: 640 }}>
            We&apos;re finishing the self-serve onboarding flow now. Leave your details below and we&apos;ll reach out personally when it&apos;s ready — or sooner if you&apos;d like to start now.
          </p>
          <p style={{ color: MUTED, fontSize: 14, margin: '0 auto', maxWidth: 640 }}>
            Already have a proposal code from us? Use the link in your proposal email to activate your account.
          </p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '20px auto 0' }} />
        </div>
      </section>

      {/* PRICING (preview of what self-serve will offer) */}
      <section style={{ padding: '24px 24px 80px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <h2 style={{ fontSize: 30, fontWeight: 700, margin: '0 0 10px', letterSpacing: '-0.02em' }}>What you&apos;ll get</h2>
            <p style={{ color: MUTED, fontSize: 15, margin: '0 0 24px' }}>Pricing at launch — base fee + per-property + per-driver.</p>
            <div style={{ display: 'inline-flex', background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 4 }}>
              <button onClick={() => setActiveTrack('enforcement')}
                style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: activeTrack === 'enforcement' ? GOLD : 'transparent', color: activeTrack === 'enforcement' ? '#0a0d14' : MUTED }}>
                Enforcement
              </button>
              <button onClick={() => setActiveTrack('pm')}
                style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', background: activeTrack === 'pm' ? GOLD : 'transparent', color: activeTrack === 'pm' ? '#0a0d14' : MUTED }}>
                Property Management
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {tiers.map((tier, i) => (
              <div key={i} style={{ background: tier.popular ? 'rgba(201,162,39,0.08)' : CARD_BG, border: `1px solid ${tier.popular ? 'rgba(201,162,39,0.5)' : BORDER}`, borderRadius: 20, padding: 32, position: 'relative', boxShadow: tier.popular ? '0 0 0 1px rgba(201,162,39,0.25), 0 8px 32px rgba(201,162,39,0.06)' : 'none' }}>
                {tier.popular && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, background: GOLD, color: '#0a0d14', fontSize: 11, fontWeight: 700, padding: '6px 12px', borderTopLeftRadius: 20, borderTopRightRadius: 20, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'center' }}>
                    ★ Most Popular
                  </div>
                )}
                <p style={{ color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', margin: `${tier.popular ? '14px' : '0'} 0 6px` }}>{activeTrack === 'enforcement' ? 'Enforcement' : 'Property Mgmt'}</p>
                <h3 style={{ color: TEXT, fontSize: 22, fontWeight: 700, margin: '0 0 16px' }}>{tier.name}</h3>
                <div style={{ marginBottom: 8 }}>
                  <span style={{ color: GOLD, fontSize: 32, fontWeight: 800 }}>${tier.base}</span>
                  <span style={{ color: MUTED, fontSize: 14 }}>/mo base</span>
                </div>
                <p style={{ color: MUTED, fontSize: 12, margin: '0 0 4px' }}>+ ${tier.perProp}/mo per property</p>
                {tier.perDriver
                  ? <p style={{ color: MUTED, fontSize: 12, margin: '0 0 20px' }}>+ ${tier.perDriver}/mo per driver</p>
                  : <div style={{ marginBottom: 20 }} />}
                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 18 }}>
                  {tier.features.map((f, j) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                      <span style={{ color: GOLD, fontSize: 14, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ color: '#94a3b8', fontSize: 14 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', color: MUTED, fontSize: 13, marginTop: 24 }}>
            Final pricing may shift slightly at launch. Founding Member pricing is locked once you onboard.
          </p>
        </div>
      </section>

      {/* INTEREST FORM */}
      <section id="notify" style={{ background: 'rgba(255,255,255,0.025)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '64px 24px' }}>
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 10px', letterSpacing: '-0.02em' }}>Get notified at launch</h2>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
              We&apos;ll email you the moment self-serve signup goes live. No spam, ever.
            </p>
          </div>
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 28 }}>
            <label style={labelStyle}>Your name</label>
            <input style={inputStyle} value={contact.name} onChange={e => setContact({ ...contact, name: e.target.value })} placeholder="Jane Operator" />
            <label style={labelStyle}>Email</label>
            <input type="email" style={inputStyle} value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} placeholder="jane@example.com" />
            <label style={labelStyle}>Company (optional)</label>
            <input style={inputStyle} value={contact.company} onChange={e => setContact({ ...contact, company: e.target.value })} placeholder="A1 Towing & Recovery" />
            <button
              onClick={sendInterest}
              disabled={!canSubmit}
              style={{ width: '100%', background: canSubmit ? GOLD : '#1e2535', color: canSubmit ? '#0a0d14' : '#555', fontWeight: 700, fontSize: 15, padding: '14px', border: 'none', borderRadius: 10, cursor: canSubmit ? 'pointer' : 'not-allowed', marginTop: 8 }}
            >
              Notify me at launch
            </button>
            <p style={{ color: MUTED, fontSize: 12, margin: '14px 0 0', textAlign: 'center', lineHeight: 1.5 }}>
              Submitting opens your mail client with a pre-filled message to support@shieldmylot.com.
            </p>
          </div>
          <p style={{ textAlign: 'center', color: MUTED, fontSize: 13, marginTop: 24 }}>
            Want to talk now? <a href="/#contact" style={{ color: GOLD, textDecoration: 'none' }}>Use the contact form on the main site →</a>
          </p>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, padding: '32px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', textAlign: 'center' }}>
          <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>© 2026 ShieldMyLot™ · A product of Alvarado Legacy Consulting LLC · All rights reserved</p>
        </div>
      </footer>
    </main>
  )
}
