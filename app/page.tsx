'use client'
import { useState } from 'react'
import { useResolvedLogo } from './lib/logo'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export default function Landing() {
  const [contact, setContact] = useState({ name: '', email: '', type: 'General inquiry', message: '' })
  const [activeTrack, setActiveTrack] = useState<'enforcement' | 'pm'>('enforcement')
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

  const enfTiers = [
    {
      name: 'Starter', base: 99, perProp: 15, perDriver: 10,
      features: ['Up to 3 properties', 'Unlimited violations', 'QR code registration', 'Resident portal', 'Visitor pass system', 'Driver app access', 'Email support'],
    },
    {
      name: 'Growth', base: 149, perProp: 12, perDriver: 8, popular: true,
      features: ['Up to 10 properties', 'Everything in Starter', 'Analytics dashboard', 'Bulk CSV upload', 'Camera scan assist', 'Dispute management', 'Priority email support'],
    },
    {
      name: 'Legacy', base: 199, perProp: 10, perDriver: 6,
      features: ['Unlimited properties', 'Everything in Growth', 'White-label branding', 'Advanced analytics', 'Custom integrations', 'Dedicated account manager', 'Priority email support'],
    },
    {
      name: 'Enterprise', base: 'Custom', perProp: 'Custom', perDriver: 'Custom',
      badge: 'Large operations', enterprise: true,
      features: ['Unlimited everything', 'Dedicated support', 'Custom integrations', 'SLA guarantee', 'Volume pricing'],
    },
  ]

  const pmTiers = [
    {
      name: 'Essential', base: 79, perProp: 20,
      features: ['Up to 3 properties', 'Resident portal', 'Visitor pass system', 'QR code registration', 'Manager dashboard', 'Email support'],
    },
    {
      name: 'Professional', base: 129, perProp: 15, popular: true,
      features: ['Up to 10 properties', 'Everything in Essential', 'Analytics dashboard', 'Registration QR codes', 'Dispute management', 'Priority email support'],
    },
    {
      name: 'Enterprise', base: 179, perProp: 10,
      features: ['Unlimited properties', 'Everything in Professional', 'White-label branding', 'Custom integrations', 'Dedicated account manager', 'Priority email support'],
    },
  ]

  const testimonials = [
    { quote: 'ShieldMyLot eliminated our unauthorized parking problem within the first week. Our residents actually thank us for it now.', name: 'Property Manager', company: 'Houston Area Apartment Community' },
    { quote: 'The violation tracking and tow ticket system saves us hours of paperwork every month. Worth every penny.', name: 'Operations Director', company: 'Texas Gulf Coast Property Group' },
    { quote: "We manage 8 communities and the multi-property dashboard is exactly what we needed. Set it up in an afternoon.", name: 'Regional Manager', company: 'Greater Houston Residential Services' },
  ]

  const features = [
    { icon: '🚗', title: 'Plate-based enforcement', body: 'Every registered vehicle gets a digital permit tied to their plate. Drivers verify against the live registry in seconds.' },
    { icon: '📱', title: 'QR code self-registration', body: 'Residents scan a property QR code, register their vehicles in minutes, and get instant manager approval.' },
    { icon: '🎫', title: 'Visitor pass system', body: 'Residents issue digital visitor passes to guests. Passes auto-expire. No paper, no clipboards, no disputes.' },
    { icon: '📊', title: 'Analytics & reporting', body: 'Track violations, pass usage, tow events, and occupancy trends across all your properties from one dashboard.' },
    { icon: '⚖️', title: 'Dispute management', body: 'Built-in dispute workflow lets residents contest violations with evidence. Managers resolve in-app, not over email.' },
    { icon: '🏗️', title: 'Multi-property management', body: 'Manage your entire portfolio from one login. Each property has its own rules, managers, and resident database.' },
  ]

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif' }}>

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

      {/* ── HERO ── */}
      <section style={{ maxWidth: 1100, margin: '0 auto', padding: '100px 24px 80px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', background: 'rgba(201,162,39,0.1)', border: `1px solid rgba(201,162,39,0.3)`, borderRadius: 20, padding: '6px 16px', fontSize: 12, color: GOLD, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 24 }}>
          Texas Parking Management Platform
        </div>
        <h1 style={{ fontSize: 'clamp(36px, 6vw, 64px)', fontWeight: 800, lineHeight: 1.1, margin: '0 0 24px', letterSpacing: '-0.03em' }}>
          Stop unauthorized parking.<br />
          <span style={{ color: GOLD }}>Start enforcing.</span>
        </h1>
        <p style={{ fontSize: 18, color: MUTED, maxWidth: 580, margin: '0 auto 40px', lineHeight: 1.7 }}>
          ShieldMyLot™ gives property managers and towing companies a complete parking enforcement system — resident registration, visitor passes, violation tracking, and tow ticketing in one platform.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="#contact" style={{ background: GOLD, color: '#0a0d14', fontWeight: 'bold', fontSize: 15, padding: '14px 28px', borderRadius: 10, textDecoration: 'none' }}>Get started →</a>
          <a href="#features" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, color: TEXT, fontSize: 15, padding: '14px 28px', borderRadius: 10, textDecoration: 'none' }}>See how it works</a>
        </div>
        <p style={{ color: MUTED, fontSize: 12, marginTop: 20 }}>Licensed for Texas operations · Harris County jurisdiction</p>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" style={{ background: 'rgba(255,255,255,0.01)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '80px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Everything you need</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: 0 }}>One platform for enforcement companies and property managers alike.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
            {features.map((f, i) => (
              <div key={i} style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 28 }}>
                <div style={{ fontSize: 28, marginBottom: 14 }}>{f.icon}</div>
                <h3 style={{ color: TEXT, fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{f.title}</h3>
                <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.7, margin: 0 }}>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" style={{ padding: '80px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Simple, hybrid pricing</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: '0 0 28px' }}>Base fee + per-property + per-driver. Pay for what you actually use.</p>
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
            {(activeTrack === 'enforcement' ? enfTiers : pmTiers).map((tier: any, i) => (
              <div key={i} style={{ background: tier.popular ? 'rgba(201,162,39,0.06)' : CARD_BG, border: `1px solid ${tier.popular ? 'rgba(201,162,39,0.4)' : BORDER}`, borderRadius: 20, padding: 28, position: 'relative' }}>
                {tier.popular && (
                  <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: GOLD, color: '#0a0d14', fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 10, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                    Most popular
                  </div>
                )}
                {tier.badge && !tier.popular && (
                  <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: '#1e2535', color: MUTED, fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 10, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap', border: `1px solid ${BORDER}` }}>
                    {tier.badge}
                  </div>
                )}
                <p style={{ color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>{activeTrack === 'enforcement' ? 'Enforcement' : 'Property Mgmt'}</p>
                <h3 style={{ color: TEXT, fontSize: 22, fontWeight: 700, margin: '0 0 16px' }}>{tier.name}</h3>
                {tier.enterprise ? (
                  <div style={{ marginBottom: 20 }}>
                    <p style={{ color: GOLD, fontSize: 28, fontWeight: 800, margin: '0 0 6px' }}>Let's talk</p>
                    <p style={{ color: MUTED, fontSize: 13, margin: 0, lineHeight: 1.5 }}>Tailored for hospitals, universities, and large property groups</p>
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <span style={{ color: GOLD, fontSize: 32, fontWeight: 800 }}>${tier.base}</span>
                      <span style={{ color: MUTED, fontSize: 14 }}>/mo base</span>
                    </div>
                    <p style={{ color: MUTED, fontSize: 12, margin: '0 0 4px' }}>+ ${tier.perProp}/mo per property</p>
                    {tier.perDriver && <p style={{ color: MUTED, fontSize: 12, margin: '0 0 20px' }}>+ ${tier.perDriver}/mo per driver</p>}
                    {!tier.perDriver && <div style={{ marginBottom: 20 }} />}
                  </>
                )}
                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 20, marginBottom: 24 }}>
                  {tier.features.map((f: string, j: number) => (
                    <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                      <span style={{ color: GOLD, fontSize: 14, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ color: '#94a3b8', fontSize: 14 }}>{f}</span>
                    </div>
                  ))}
                </div>
                {tier.enterprise ? (
                  <a href="mailto:support@shieldmylot.com?subject=ShieldMyLot Enterprise Inquiry"
                    style={{ display: 'block', textAlign: 'center', background: CARD_BG, color: TEXT, fontWeight: 'bold', fontSize: 14, padding: '12px', borderRadius: 10, textDecoration: 'none', border: `1px solid ${BORDER}` }}>
                    Contact us →
                  </a>
                ) : (
                  <a href="#contact" style={{ display: 'block', textAlign: 'center', background: tier.popular ? GOLD : CARD_BG, color: tier.popular ? '#0a0d14' : TEXT, fontWeight: 'bold', fontSize: 14, padding: '12px', borderRadius: 10, textDecoration: 'none', border: `1px solid ${tier.popular ? GOLD : BORDER}` }}>
                    Get started
                  </a>
                )}
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', color: MUTED, fontSize: 13, marginTop: 28 }}>
            Annual billing available — save 2 months. All plans include a 14-day free trial.
          </p>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section style={{ background: 'rgba(255,255,255,0.01)', borderTop: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, padding: '80px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', fontSize: 36, fontWeight: 700, margin: '0 0 48px', letterSpacing: '-0.02em' }}>Trusted by Houston property teams</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
            {testimonials.map((t, i) => (
              <div key={i} style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 28 }}>
                <div style={{ color: GOLD, fontSize: 24, marginBottom: 14, letterSpacing: '-0.05em' }}>"</div>
                <p style={{ color: '#94a3b8', fontSize: 15, lineHeight: 1.7, margin: '0 0 20px' }}>{t.quote}</p>
                <div>
                  <p style={{ color: TEXT, fontWeight: 600, fontSize: 14, margin: '0 0 2px' }}>{t.name}</p>
                  <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>{t.company}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CONTACT FORM ── */}
      <section id="contact" style={{ padding: '80px 24px' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.02em' }}>Get in touch</h2>
            <p style={{ color: MUTED, fontSize: 16, margin: 0 }}>Questions about ShieldMyLot? We'd love to hear from you.</p>
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
              Send message
            </button>
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
              {[['Help Center', '#'], ['Video Guides', '#'], ['Contact', '#contact']].map(([label, href]) => (
                <a key={label} href={href} style={{ display: 'block', color: MUTED, fontSize: 13, textDecoration: 'none', marginBottom: 8 }}>{label}</a>
              ))}
            </div>
            <div>
              <p style={{ color: TEXT, fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Account</p>
              {[['Sign in', '/login'], ['Register', '/register']].map(([label, href]) => (
                <a key={label} href={href} style={{ display: 'block', color: MUTED, fontSize: 13, textDecoration: 'none', marginBottom: 8 }}>{label}</a>
              ))}
            </div>
          </div>
        </div>
        <div style={{ maxWidth: 1100, margin: '28px auto 0', paddingTop: 20, borderTop: `1px solid ${BORDER}`, display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>© 2026 ShieldMyLot™ · A product of Alvarado Legacy Consulting LLC · All rights reserved</p>
          <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>Licensed for Texas operations · Harris County jurisdiction</p>
        </div>
      </footer>

    </main>
  )
}
