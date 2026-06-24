'use client'
import { useState } from 'react'
import { useResolvedLogo } from './lib/logo'
// 3-tier rebuild (Jose 2026-06-24): the landing page now renders the
// single 3-card OFFERINGS view (PM-Only / Enforcement-Only / Legacy).
// Two-track tab UI dropped; ?track= deep-link removed; FEATURE_COMPARISON
// table added between Features and Pricing.
import { OFFERINGS, FEATURE_COMPARISON } from './lib/tier-display'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export default function Landing() {
  const [contact, setContact] = useState({ name: '', email: '', type: 'General inquiry', message: '' })
  const logoUrl = useResolvedLogo()

  function sendContact() {
    const subject = encodeURIComponent(`[${contact.type}] from ${contact.name}`)
    const body = encodeURIComponent(`Name: ${contact.name}\nEmail: ${contact.email}\nType: ${contact.type}\n\n${contact.message}`)
    window.location.href = `mailto:support@shieldmylot.com?subject=${subject}&body=${body}`
  }

  const inputStyle: React.CSSProperties = {
    background: '#0a0d14', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    padding: '12px 16px', color: '#fff', width: '100%', fontSize: 14,
    marginBottom: 12, boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  }
  const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 6 }

  // Feature tiles — capability-focused (offering availability shown in the
  // Comparison table below, not duplicated per tile). Honest copy; no
  // overpromised claims (B55 discipline preserved).
  const features = [
    { icon: '🚗', title: 'Plate-based enforcement', body: 'Every registered vehicle gets a digital permit tied to their plate. Drivers verify against the live registry in seconds.', tier: 'Enforcement-Only · Legacy' },
    { icon: '📱', title: 'QR code self-registration', body: 'Residents scan a property QR code, register their vehicles in minutes, and get manager approval.', tier: 'PM-Only · Legacy' },
    { icon: '🎫', title: 'Visitor pass system', body: 'Residents issue digital visitor passes to guests. Passes auto-expire. Manager-issued passes also available.', tier: 'PM-Only · Legacy (self-serve); Enforcement-Only (QR only)' },
    { icon: '📊', title: 'Detailed analytics', body: 'Track violations, pass usage, tow events, and trends across all your properties.', tier: 'PM-Only · Legacy (basic on Enforcement-Only)' },
    { icon: '🏗️', title: 'Multi-property management', body: 'Manage your entire portfolio from one login. Each property has its own rules, managers, and resident database.', tier: 'All offerings' },
    { icon: '🅿️', title: 'Reserved space management', body: 'Track who has which spot, with cap-aware roommate tying. Pay-per-use ($0.50 per reserved space, zero included).', tier: 'All offerings' },
  ]

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif' }}>

      {/* B62.4: JSON-LD structured data. Inline in page.tsx rather than
          layout.tsx so the schema lives next to the content it describes.
          Service schema (not SoftwareApplication) to avoid the offers/
          price requirement — schema stays consistent with page copy: no
          pricing claims, no ratings, no review counts. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Service",
            "name": "ShieldMyLot™",
            "description": "Texas-only parking enforcement platform modeled around Texas Chapter 2308. Resident registration, visitor passes, violation tracking, and tow ticketing for towing companies and property managers.",
            "provider": {
              "@type": "Organization",
              "name": "Alvarado Legacy Consulting LLC",
              "alternateName": "ShieldMyLot",
              "url": "https://shieldmylot.com"
            },
            "serviceType": "Parking Enforcement & Property Management Platform",
            "areaServed": { "@type": "State", "name": "Texas" },
            "url": "https://shieldmylot.com"
          })
        }}
      />

      {/* ── NAV ── */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(10,13,20,0.92)', backdropFilter: 'blur(12px)', borderBottom: `1px solid ${BORDER}`, padding: '0 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src={logoUrl} alt="ShieldMyLot" style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${GOLD}` }} onError={e => (e.currentTarget.style.display = 'none')} />
            <span style={{ color: GOLD, fontWeight: 'bold', fontSize: 18, letterSpacing: '-0.02em' }}>ShieldMyLot</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <a href="#features" style={{ color: MUTED, fontSize: 14, textDecoration: 'none' }}>Features</a>
            <a href="#pricing" style={{ color: MUTED, fontSize: 14, textDecoration: 'none' }}>Pricing</a>
            <a href="#contact" style={{ color: MUTED, fontSize: 14, textDecoration: 'none' }}>Contact</a>
            <a href="/login" style={{ background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 13, padding: '8px 18px', borderRadius: 8, textDecoration: 'none' }}>Sign in</a>
          </div>
        </div>
      </nav>

      {/* ── HERO ──
          B62.1 (2026-05-19): updated headline + subhead + primary CTA label.
          Secondary CTA stays on #features until B62.2 lands #how-it-works.
          Logo prominence + accent line + breathing room added. */}
      <section style={{ maxWidth: 1100, margin: '0 auto', padding: '120px 24px 100px', textAlign: 'center' }}>
        <img src={logoUrl} alt="ShieldMyLot" onError={e => (e.currentTarget.style.display = 'none')}
          style={{ width: 72, height: 72, borderRadius: 14, border: `1px solid ${GOLD}`, marginBottom: 28 }} />
        <div style={{ display: 'inline-block', background: 'rgba(201,162,39,0.1)', border: `1px solid rgba(201,162,39,0.3)`, borderRadius: 20, padding: '6px 16px', fontSize: 12, color: GOLD, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 28 }}>
          Texas Parking Management Platform
        </div>
        <h1 style={{ fontSize: 'clamp(36px, 6vw, 64px)', fontWeight: 800, lineHeight: 1.15, margin: '0 0 16px', letterSpacing: '-0.03em' }}>
          One platform. <span style={{ color: GOLD }}>Manage, enforce, or both.</span>
        </h1>
        <div style={{ width: 60, height: 2, background: GOLD, margin: '0 auto 28px', opacity: 0.7 }} />
        <p style={{ fontSize: 18, color: MUTED, maxWidth: 640, margin: '0 auto 44px', lineHeight: 1.7 }}>
          Resident registration, visitor passes, reserved-space management, plate enforcement, and tow ticketing — for Texas operators working under Chapter 2308. Three offerings: PM-Only, Enforcement-Only, and Legacy.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/signup" style={{ background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 15, padding: '14px 28px', borderRadius: 10, textDecoration: 'none' }}>Sign up →</a>
          <a href="#contact" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, color: TEXT, fontSize: 15, padding: '14px 28px', borderRadius: 10, textDecoration: 'none' }}>Request Access →</a>
          <a href="#how-it-works" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, color: TEXT, fontSize: 15, padding: '14px 28px', borderRadius: 10, textDecoration: 'none' }}>See how it works</a>
        </div>
        <p style={{ color: MUTED, fontSize: 13, marginTop: 20 }}>
          Have a proposal code? <a href="/signup/redeem" style={{ color: GOLD, textDecoration: 'none', fontWeight: 600 }}>Activate here →</a>
        </p>
        <p style={{ color: MUTED, fontSize: 12, marginTop: 12 }}>Licensed for Texas operations · Harris County jurisdiction</p>
      </section>

      {/* ── ONE PRODUCT, THREE OFFERINGS — audience-mapped intro ──
          Replaces the B62.2 "two kinds of operators" split. Each offering
          has a clear buyer persona; cards anchor-scroll to the matching
          Pricing card below. */}
      <section id="audiences" style={{ background: 'rgba(255,255,255,0.01)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '104px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>One product, three offerings</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: '12px auto 0', maxWidth: 640, lineHeight: 1.65 }}>
              Pick the offering that fits how you operate. Same platform underneath; what differs is which workflows are turned on.
            </p>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '20px auto 0' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
            {[
              {
                icon: '🏢',
                offering: 'PM-Only',
                tagline: 'For self-managed properties + HOAs',
                blurb: 'Resident registration, visitor passes, reserved space management, and analytics — without enforcement. Coordinate with whoever does your towing.',
                anchor: '#pricing',
              },
              {
                icon: '🚛',
                offering: 'Enforcement-Only',
                tagline: 'For cost-conscious tow operators',
                blurb: 'Full plate enforcement, video evidence, tow tickets, and driver workflow. Barebones PM features so residents can self-register the basics.',
                anchor: '#pricing',
              },
              {
                icon: '🏆',
                offering: 'Legacy',
                tagline: 'For bid-winning operators',
                blurb: 'Full PM + full enforcement. Offer your serviced properties a complete resident platform as part of your bid — you recover the cost in enforcement.',
                anchor: '#pricing',
              },
            ].map((p, i) => (
              <div key={i} style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 20, padding: 28 }}>
                <div style={{ fontSize: 36, marginBottom: 14 }}>{p.icon}</div>
                <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, margin: '0 0 4px' }}>{p.offering}</p>
                <h3 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 12px', lineHeight: 1.35 }}>{p.tagline}</h3>
                <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.7, margin: '0 0 18px' }}>{p.blurb}</p>
                <a href={p.anchor} style={{ color: GOLD, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                  See pricing for {p.offering} →
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS — unified narrative ──
          Track-toggle dropped in the 3-tier rebuild. Same steps work for
          any offering; what differs is which steps are emphasized in
          your day-to-day (PM-Only doesn't run a driver workflow;
          Enforcement-Only doesn't run a self-serve visitor pass system). */}
      <section id="how-it-works" style={{ padding: '104px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>How it works</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: '0 0 12px', maxWidth: 640, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.65 }}>
              From signup to operating in days, not weeks. The same four steps regardless of offering — your enforcement / PM features turn on based on the offering you pick.
            </p>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '20px auto 0' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
            {[
              { title: 'Set up your account', body: 'Configure company profile, add admin + manager users, pick your offering.' },
              { title: 'Add properties', body: 'Configure per-property rules, exempt plate lists, and reserved spaces if you assign parking.' },
              { title: 'Provision people', body: 'Enforcement: add field drivers. PM: distribute resident QR codes for self-registration.' },
              { title: 'Start operating', body: 'Enforcement: drivers submit violations with photo/video evidence; tickets generate automatically. PM: approve residents, manage visitor passes, coordinate with your towing partner.' },
            ].map((step, i) => (
              <div key={i} style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 24, position: 'relative' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(201,162,39,0.15)', border: `1px solid ${GOLD}`, color: GOLD, fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                  {i + 1}
                </div>
                <h3 style={{ color: TEXT, fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{step.title}</h3>
                <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.65, margin: 0 }}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES (refined in B62.3) ── */}
      <section id="features" style={{ background: 'rgba(255,255,255,0.01)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '104px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Everything you need</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: 0 }}>Built around the workflows of Texas towing operators and property managers.</p>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '16px auto 0' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
            {features.map((f, i) => (
              <div key={i} className="b62-feature-tile" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 28, display: 'flex', flexDirection: 'column', transition: 'transform 0.2s, border-color 0.2s' }}>
                <div style={{ fontSize: 32, marginBottom: 14, color: GOLD }}>{f.icon}</div>
                <h3 style={{ color: TEXT, fontSize: 17, fontWeight: 700, margin: '0 0 10px' }}>{f.title}</h3>
                <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.7, margin: 0, flex: 1 }}>{f.body}</p>
                {f.tier && (
                  <p style={{ color: GOLD, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 0', paddingTop: 14, borderTop: `1px solid ${BORDER}` }}>
                    {f.tier}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'center', marginTop: 32 }}>
            <a href="#pricing" style={{ color: GOLD, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>
              See full feature comparison by tier →
            </a>
          </div>
        </div>
        {/* B62.3: hover state for feature tiles. Inline style can't express
            :hover, so a small style tag scoped by className lifts + gold-borders
            on hover. Cheaper than dragging in a CSS module for one rule. */}
        <style>{`
          .b62-feature-tile:hover {
            transform: translateY(-2px);
            border-color: rgba(201,162,39,0.4) !important;
          }
        `}</style>
      </section>

      {/* ── FEATURE COMPARISON TABLE — feature-split spec from Jose 2026-06-24.
          Capability-by-capability matrix across the 3 offerings. Lives
          between Features (per-feature tiles) and Pricing (per-offering
          cards) so a buyer can map "this is what I need" → offering before
          looking at price. */}
      <section id="comparison" style={{ padding: '80px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <h2 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Compare offerings</h2>
            <p style={{ color: MUTED, fontSize: 15, margin: '8px 0 0', maxWidth: 600, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.65 }}>
              Same platform underneath. Pick the offering whose capability set fits how you operate.
            </p>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '20px auto 0' }} />
          </div>
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr style={{ background: 'rgba(201,162,39,0.06)', borderBottom: `1px solid ${BORDER}` }}>
                    <th style={{ textAlign: 'left',  padding: '14px 18px', color: MUTED, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Capability</th>
                    <th style={{ textAlign: 'center', padding: '14px 18px', color: TEXT,  fontSize: 13, fontWeight: 700 }}>PM-Only</th>
                    <th style={{ textAlign: 'center', padding: '14px 18px', color: TEXT,  fontSize: 13, fontWeight: 700 }}>Enforcement-Only</th>
                    <th style={{ textAlign: 'center', padding: '14px 18px', color: GOLD,  fontSize: 13, fontWeight: 700 }}>Legacy</th>
                  </tr>
                </thead>
                <tbody>
                  {FEATURE_COMPARISON.map((row, i) => (
                    <tr key={i} style={{ borderBottom: i === FEATURE_COMPARISON.length - 1 ? 'none' : `1px solid ${BORDER}` }}>
                      <td style={{ padding: '12px 18px', color: TEXT,  fontSize: 14 }}>{row.capability}</td>
                      <td style={{ padding: '12px 18px', color: row.pmOnly          === '—' ? '#4a5568' : '#94a3b8', fontSize: 13, textAlign: 'center' }}>{row.pmOnly}</td>
                      <td style={{ padding: '12px 18px', color: row.enforcementOnly === '—' ? '#4a5568' : '#94a3b8', fontSize: 13, textAlign: 'center' }}>{row.enforcementOnly}</td>
                      <td style={{ padding: '12px 18px', color: row.legacy          === '—' ? '#4a5568' : '#94a3b8', fontSize: 13, textAlign: 'center' }}>{row.legacy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* ── PRICING — 3-card view (Jose lock 2026-06-24).
          Drops the two-track tab UI; renders OFFERINGS array directly.
          Each card shows base + per-property + per-space + (per-driver
          when applicable). Legacy card includes the operator-focused
          pitch quote. CTAs are "Contact us" / "Get started" only —
          self-serve checkout HOLDs until billing slice ships. */}
      <section id="pricing" style={{ padding: '104px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Three offerings, one platform</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: '0 0 8px', maxWidth: 640, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.65 }}>
              Base + per-property + per-reserved-space ($0.50, zero included — pay only for spaces you use). Drivers billed on enforcement offerings.
            </p>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '20px auto 0' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {OFFERINGS.map((tier, i) => (
              <div key={i} style={{ background: tier.popular ? 'rgba(201,162,39,0.08)' : CARD_BG, border: `1px solid ${tier.popular ? 'rgba(201,162,39,0.5)' : BORDER}`, borderRadius: 20, padding: 36, position: 'relative', boxShadow: tier.popular ? '0 0 0 1px rgba(201,162,39,0.25), 0 8px 32px rgba(201,162,39,0.06)' : 'none' }}>
                {tier.popular && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, background: GOLD, color: '#0a0d14', fontSize: 11, fontWeight: 700, padding: '6px 12px', borderTopLeftRadius: 20, borderTopRightRadius: 20, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: 'center' }}>
                    ★ Most Popular
                  </div>
                )}
                <p style={{ color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', margin: `${tier.popular ? '14px' : '0'} 0 6px` }}>
                  {tier.includesEnforcement && tier.includesPM ? 'PM + Enforcement' : tier.includesEnforcement ? 'Enforcement' : 'Property Management'}
                </p>
                <h3 style={{ color: TEXT, fontSize: 24, fontWeight: 700, margin: '0 0 16px' }}>{tier.name}</h3>

                <div style={{ marginBottom: 8 }}>
                  <span style={{ color: GOLD, fontSize: 36, fontWeight: 800 }}>${tier.base}</span>
                  <span style={{ color: MUTED, fontSize: 14 }}>/mo base</span>
                </div>
                <p style={{ color: MUTED, fontSize: 12, margin: '0 0 4px' }}>+ ${tier.perProp}/mo per property</p>
                <p style={{ color: MUTED, fontSize: 12, margin: '0 0 4px' }}>+ ${tier.perSpace?.toFixed(2)}/mo per reserved space <span style={{ color: '#4a5568' }}>(zero included)</span></p>
                {tier.perDriver
                  ? <p style={{ color: MUTED, fontSize: 12, margin: '0 0 20px' }}>+ ${tier.perDriver}/mo per driver</p>
                  : <p style={{ color: '#4a5568', fontSize: 12, margin: '0 0 20px', fontStyle: 'italic' }}>No driver fee (PM-only)</p>}

                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 20, marginBottom: tier.pitchLine ? 16 : 24 }}>
                  {tier.features.map((f, j) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                      <span style={{ color: GOLD, fontSize: 14, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ color: '#94a3b8', fontSize: 14 }}>{f}</span>
                    </div>
                  ))}
                </div>

                {tier.pitchLine && (
                  <blockquote style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.25)`, borderLeft: `3px solid ${GOLD}`, borderRadius: 8, padding: '12px 14px', margin: '0 0 22px', color: '#cbd5e1', fontSize: 13, lineHeight: 1.6, fontStyle: 'italic' }}>
                    {tier.pitchLine}
                  </blockquote>
                )}

                <a href="#contact" style={{ display: 'block', textAlign: 'center', background: tier.popular ? GOLD : CARD_BG, color: tier.popular ? '#0a0d14' : TEXT, fontWeight: 'bold', fontSize: 14, padding: '12px', borderRadius: 10, textDecoration: 'none', border: `1px solid ${tier.popular ? GOLD : BORDER}` }}>
                  {tier.popular ? 'Get started' : 'Contact us'} →
                </a>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', color: MUTED, fontSize: 13, marginTop: 28 }}>
            Working numbers — finalized before public launch. Self-serve checkout opens when billing wires; for now, reach out via Contact below to start.
          </p>
        </div>
      </section>

      {/* ── CREDIBILITY (B62.3) ──
          Replaces the B55 Phase 1 testimonials placeholder. No customer
          testimonials until real customers exist + have written authorization
          to be quoted with company attribution. */}
      <section id="about" style={{ background: 'rgba(255,255,255,0.025)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '104px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Built in Texas, for Texas</h2>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '12px auto 0' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, marginBottom: 40 }}>
            {/* Block 1 — About the company */}
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 20, padding: 32 }}>
              <h3 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 14px' }}>Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™</h3>
              <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.7, margin: '0 0 14px' }}>
                ShieldMyLot is built and operated by Alvarado Legacy Consulting LLC, a Houston-based consulting firm specializing in operational software for Texas businesses.
              </p>
              <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.7, margin: 0 }}>
                We work directly with Texas towing operators and property managers to understand the realities of parking enforcement under Chapter 2308 — and we built ShieldMyLot to fit how the work actually happens.
              </p>
            </div>
            {/* Block 2 — Texas focus */}
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 20, padding: 32 }}>
              <h3 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 14px' }}>Designed around Chapter 2308 workflows</h3>
              <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.7, margin: '0 0 14px' }}>
                ShieldMyLot is shaped by the realities of Texas towing operations under Texas Occupations Code Chapter 2308 — the Texas Towing and Booting Act.
              </p>
              <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.7, margin: '0 0 14px' }}>
                From tow ticket content fields to evidence capture to audit trails, the platform is modeled around how the work actually happens under Texas law. Operator compliance with Chapter 2308 remains your responsibility; ShieldMyLot is the operational support layer.
              </p>
              <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.7, margin: 0 }}>
                Operating outside Texas? ShieldMyLot isn&apos;t the right fit for you yet — we focus on doing one state exceptionally well rather than many states adequately.
              </p>
            </div>
          </div>
          {/* Trust signals — emoji per the locked icon-vocabulary decision */}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12 }}>
            {[
              { icon: '🛡️', label: 'Texas-only operations' },
              { icon: '📋', label: 'Chapter 2308 framework' },
              { icon: '🔒', label: 'Encrypted data, audit-trailed actions' },
              { icon: '👥', label: 'B2B support model' },
            ].map(b => (
              <div key={b.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: CARD_BG, border: `1px solid rgba(201,162,39,0.25)`, borderRadius: 999, padding: '8px 16px' }}>
                <span style={{ fontSize: 16 }}>{b.icon}</span>
                <span style={{ color: GOLD, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHAT TO EXPECT (B62.4) ── */}
      <section id="what-to-expect" style={{ background: 'rgba(255,255,255,0.025)', borderTop: `1px solid ${BORDER}`, padding: '104px 24px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>What happens after you reach out</h2>
            <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '12px auto 0' }} />
          </div>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              { title: 'We respond within one business day', body: 'You’ll hear back from us at the email you provide. Most initial responses include a few clarifying questions about your operation and a suggested next step.' },
              { title: 'We learn about your operation (15–30 min call)', body: 'A short conversation by video or phone to understand your size, properties, current workflow, and what success looks like for you. No sales pressure — this is mutual fit-checking.' },
              { title: 'We send a service agreement', body: 'If we’re a good match, you’ll receive a service agreement with pricing tailored to your operation. Standard tier pricing for most customers; custom pricing for unusual situations.' },
              { title: 'We activate your account', body: 'Once the agreement is signed and your account is ready, we provision your team and walk you through setup. You’re typically operating within a week.' },
            ].map((step, i) => (
              <li key={i} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: '18px 22px' }}>
                <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,162,39,0.15)', border: `1px solid ${GOLD}`, color: GOLD, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {i + 1}
                </div>
                <div>
                  <h3 style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 6px' }}>{step.title}</h3>
                  <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.65, margin: 0 }}>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          {/* B54: self-serve video callout goes here when HeyGen videos ship */}
        </div>
      </section>

      {/* ── CONTACT FORM ── */}
      <section id="contact" style={{ padding: '104px 24px' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Get in touch</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: 0 }}>Tell us about your operation and we&apos;ll respond within one business day.</p>
          </div>
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 20, padding: 40 }}>
            <label style={labelStyle}>Name</label>
            <input value={contact.name} onChange={e => setContact({ ...contact, name: e.target.value })} placeholder="Your name" style={inputStyle} />

            <label style={labelStyle}>Email</label>
            <input type="email" value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} placeholder="you@company.com" style={inputStyle} />

            <label style={labelStyle}>Type</label>
            <select value={contact.type} onChange={e => setContact({ ...contact, type: e.target.value })}
              style={{ ...inputStyle, appearance: 'none' as const }}>
              {['General inquiry', 'Sales question', 'Feature request', 'Report an issue'].map(o => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>

            <label style={labelStyle}>Message</label>
            <textarea value={contact.message} onChange={e => setContact({ ...contact, message: e.target.value })}
              placeholder="Tell us how we can help..."
              style={{ ...inputStyle, minHeight: 120, resize: 'vertical', marginBottom: 24 }} />

            <button onClick={sendContact} disabled={!contact.name || !contact.email || !contact.message}
              style={{ width: '100%', padding: '14px', background: (!contact.name || !contact.email || !contact.message) ? '#2a2f3d' : GOLD, color: (!contact.name || !contact.email || !contact.message) ? MUTED : '#0a0d14', fontWeight: 'bold', fontSize: 15, border: 'none', borderRadius: 10, cursor: (!contact.name || !contact.email || !contact.message) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
              Request Access
            </button>
            <p style={{ color: MUTED, fontSize: 13, textAlign: 'center', margin: '16px 0 0' }}>
              Prefer to email directly? Reach us at <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none', fontWeight: 600 }}>support@shieldmylot.com</a>
            </p>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, padding: '40px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 32, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <img src={logoUrl} alt="ShieldMyLot" style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${GOLD}` }} onError={e => (e.currentTarget.style.display = 'none')} />
              <span style={{ color: GOLD, fontWeight: 'bold', fontSize: 15 }}>ShieldMyLot</span>
            </div>
            <p style={{ color: MUTED, fontSize: 13, margin: 0, maxWidth: 220, lineHeight: 1.6 }}>
              Parking enforcement & management platform. Texas only.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap' }}>
            <div>
              <p style={{ color: TEXT, fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Product</p>
              {[['Features', '#features'], ['Pricing', '#pricing'], ['Terms of Service', '/terms'], ['Privacy Policy', '/privacy']].map(([label, href]) => (
                <a key={label} href={href} style={{ display: 'block', color: MUTED, fontSize: 13, textDecoration: 'none', marginBottom: 8 }}>{label}</a>
              ))}
            </div>
            <div>
              <p style={{ color: TEXT, fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Support</p>
              {[
                ['Help Center', '/help'],
                ['Video Guides', '/help/videos'],
                ['Contact', '#contact'],
              ].map(([label, href]) => (
                <a key={label} href={href} style={{ display: 'block', color: MUTED, fontSize: 13, textDecoration: 'none', marginBottom: 8 }}>{label}</a>
              ))}
            </div>
            <div>
              <p style={{ color: TEXT, fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Account</p>
              {[['Sign in', '/login'], ['Sign up', '/signup']].map(([label, href]) => (
                <a key={label} href={href} style={{ display: 'block', color: MUTED, fontSize: 13, textDecoration: 'none', marginBottom: 8 }}>{label}</a>
              ))}
            </div>
          </div>
        </div>
        <div style={{ maxWidth: 1100, margin: '28px auto 0', paddingTop: 20, borderTop: `1px solid ${BORDER}`, display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>© 2026 Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ · All rights reserved</p>
          <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>Licensed for Texas operations · Harris County jurisdiction</p>
        </div>
      </footer>

    </main>
  )
}
