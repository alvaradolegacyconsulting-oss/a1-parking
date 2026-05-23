'use client'
// B66.3 — Stripe Checkout cancel landing. User clicked "back" in
// Stripe Checkout or closed the tab and returned. Their tier selection
// is preserved in user_metadata; /signup/verify can resume the flow.

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

export default function SignupCancelled() {
  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '80px 24px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>↩️</div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px' }}>Checkout cancelled</h1>
        <p style={{ color: '#94a3b8', fontSize: 15, lineHeight: 1.6, margin: '0 0 8px' }}>
          No payment was taken. Your tier selection is saved — you can pick up where you left off.
        </p>
        <p style={{ color: MUTED, fontSize: 14, margin: '0 0 28px' }}>
          Need to change your selection? Start over from the signup page.
        </p>
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
          <a href="/signup/verify" style={{ display: 'block', background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '12px 18px', textDecoration: 'none', fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Resume checkout
          </a>
          <a href="/signup" style={{ display: 'block', color: GOLD, padding: '10px', textDecoration: 'none', fontSize: 13 }}>
            Change my selection
          </a>
        </div>
        <a href="mailto:support@shieldmylot.com" style={{ color: MUTED, fontSize: 12, textDecoration: 'none' }}>
          Need help? Contact support
        </a>
      </div>
    </main>
  )
}
