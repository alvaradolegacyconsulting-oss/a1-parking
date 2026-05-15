'use client'
// B65.2: hard-redirect target for account_state='cancelled' (spec §3.4).
// Placeholder: no path currently produces a cancelled state in B65.2 — the
// state only becomes reachable when admin tooling to cancel accounts ships
// (post-B65). Kept minimal so the gate has a real route to land on; full
// reactivation copy + flow lands when cancellations are actually possible.

const GOLD = '#C9A227'

export default function AccountCancelled() {
  return (
    <main style={{ minHeight: '100vh', background: '#0a0d14', color: '#e2e8f0', fontFamily: 'system-ui, Arial, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ maxWidth: 480, width: '100%', textAlign: 'center', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 16, padding: 36 }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 30 }}>🛑</div>
        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 700, margin: '0 0 10px' }}>Account Cancelled</h1>
        <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 24px', lineHeight: 1.6 }}>
          This account has been cancelled. To reactivate, please contact support.
        </p>
        <a href="mailto:support@shieldmylot.com?subject=Reactivate%20cancelled%20account"
          style={{ display: 'inline-block', background: GOLD, color: '#0a0d14', fontWeight: 700, fontSize: 14, padding: '12px 24px', borderRadius: 10, textDecoration: 'none' }}>
          Contact support →
        </a>
      </div>
    </main>
  )
}
