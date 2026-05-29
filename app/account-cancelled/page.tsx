'use client'
// B66.5 commit 4.3 — /account-cancelled landing page (expanded).
//
// Hard-redirect target for account_state='cancelled'. Reachable via
// gateAccountState in all 4 portal mount logics + /login dispatch +
// the defensive null-check in customer portals (fail-closed to here
// when companies row can't be SELECTed — see commit 4.3 audit-pass
// Item 6 + RLS analysis).
//
// Original B65.2-era placeholder was 1-paragraph "contact support"
// minimal page (kept the gate target real). B66.5 commit 4.3 expands
// per the Cancellation email tone (DunningCancellation.tsx) + the 30-
// day data retention messaging + both restoration paths (within 30
// days → support; after → fresh signup).
//
// Auth-required (NOT in middleware publicPaths). Users reach here
// post-login via portal redirect; anonymous visitors get bounced to
// /login by middleware.

import { useState } from 'react'

const GOLD = '#C9A227'

export default function AccountCancelled() {
  const [showRetentionDetails, setShowRetentionDetails] = useState(false)

  return (
    <main style={{
      minHeight: '100vh',
      background: '#0a0d14',
      color: '#e2e8f0',
      fontFamily: 'system-ui, Arial, sans-serif',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      <div style={{
        maxWidth: 540,
        width: '100%',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 16,
        padding: 36,
      }}>
        <div style={{
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: '#1e1a0a',
          border: `2px solid ${GOLD}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px',
          fontSize: 30,
        }}>🛑</div>

        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 700, margin: '0 0 14px', textAlign: 'center' }}>
          Account Cancelled
        </h1>

        <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 16px', lineHeight: 1.6 }}>
          Your company&apos;s ShieldMyLot subscription has been cancelled. This happened because
          the past due payment wasn&apos;t resolved within the 14-day grace period (7 days past
          due + 7 days suspended).
        </p>

        <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, margin: '0 0 18px' }}>
          <div style={{ fontWeight: 700, color: GOLD, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            What this means
          </div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>All portals are no longer accessible</li>
            <li>Your data is retained for 30 days from cancellation date</li>
            <li>After 30 days, account data is removed per our standard retention policy</li>
          </ul>
        </div>

        <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, margin: '0 0 18px' }}>
          <div style={{ fontWeight: 700, color: GOLD, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            If you&apos;d like to come back
          </div>
          <p style={{ margin: '0 0 8px' }}>
            <strong style={{ color: '#e2e8f0' }}>Within 30 days:</strong> contact{' '}
            <a href="mailto:support@shieldmylot.com?subject=Restore%20cancelled%20account"
              style={{ color: GOLD, textDecoration: 'none' }}>
              support@shieldmylot.com
            </a>
            {' '}and we&apos;ll help you restore your account without losing existing data.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: '#e2e8f0' }}>After 30 days:</strong> you can sign up
            again as a new account, but historical data won&apos;t carry over.
          </p>
        </div>

        <button
          onClick={() => setShowRetentionDetails(v => !v)}
          style={{
            background: 'transparent',
            border: `1px solid ${GOLD}`,
            color: GOLD,
            fontSize: 12,
            fontWeight: 600,
            padding: '8px 14px',
            borderRadius: 8,
            cursor: 'pointer',
            marginTop: 8,
          }}
        >
          {showRetentionDetails ? '− Hide data retention details' : '+ What about my data?'}
        </button>

        {showRetentionDetails && (
          <div style={{
            background: '#0a0d14',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 14,
            marginTop: 10,
            color: '#94a3b8',
            fontSize: 12,
            lineHeight: 1.7,
          }}>
            <p style={{ margin: '0 0 8px' }}>
              Cancelled accounts have a 30-day data retention window. Within this window:
            </p>
            <ul style={{ paddingLeft: 18, margin: '0 0 8px' }}>
              <li>All driver, resident, and property data is preserved</li>
              <li>Historical violations and tow tickets remain in our records</li>
              <li>
                To restore: contact{' '}
                <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none' }}>
                  support@shieldmylot.com
                </a>
                {' '}from your company admin email
              </li>
            </ul>
            <p style={{ margin: 0 }}>
              After 30 days, data is removed per our standard retention practices.
            </p>
          </div>
        )}

        <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6, margin: '20px 0 0', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 16, textAlign: 'center' }}>
          Thank you for being part of ShieldMyLot.
        </p>
      </div>
    </main>
  )
}
