'use client'
// B66.5 commit 4.3 — PastDueBanner.
//
// Rendered above main portal content when gateAccountState returns
// { kind: 'allow_with_banner', banner: 'past_due' }. Surfaces the
// billing-critical signal without blocking portal access (past_due is
// the "warn but allow" lifecycle stage — see app/lib/account-state.ts
// for the era-shift commentary).
//
// Dismissibility: per-session via sessionStorage (NOT localStorage).
// Clears on browser close; persists across page navigations within the
// session. Per Jose's I.2 lock: "active dismissal creates psychological
// engagement; banner wallpaper effect is real" — the close button
// makes the user actively acknowledge the state rather than visually
// filtering out a persistent banner.
//
// SSR-safety: sessionStorage access is gated by typeof window check.
// Initial render assumes "visible" (not dismissed); the useEffect on
// mount checks storage + hides if previously dismissed this session.
// This means a brief flash on first paint if the user previously
// dismissed — acceptable trade-off for SSR compatibility.

import { useEffect, useState } from 'react'

const GOLD = '#C9A227'
const AMBER_BG = '#3a2a08'           // dark amber background (matches app dark theme)
const AMBER_BORDER = '#f59e0b'        // bright amber border for attention
const AMBER_TEXT = '#fbbf24'          // bright amber text for the title

export interface PastDueBannerProps {
  companyName: string
  daysRemainingUntilSuspension: number
  updatePaymentUrl: string
  companyId: string | number
  // B66.5.1: role-gated CTA. CA + admin see the Update Payment button;
  // non-CA roles (manager/leasing_agent/driver/resident) see informational
  // copy with CA email mailto link instead. Per Q1 lock — 'admin' (Jose's
  // super-admin singleton) also sees CTA to keep super-admin testing flows
  // working. Per Q3 lock — caEmail falls back to support@shieldmylot.com
  // when company has no CA (orphan edge case).
  userRole?: string
  caEmail?: string  // resolved CA email; falls back to support@shieldmylot.com
}

const SUPPORT_FALLBACK_EMAIL = 'support@shieldmylot.com'

export default function PastDueBanner({
  companyName,
  daysRemainingUntilSuspension,
  updatePaymentUrl,
  companyId,
  userRole,
  caEmail,
}: PastDueBannerProps) {
  const storageKey = `pastDueBannerDismissed_${companyId}`
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem(storageKey) === 'true') {
      setDismissed(true)
    }
  }, [storageKey])

  if (dismissed) return null

  function onClose() {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(storageKey, 'true')
    }
    setDismissed(true)
  }

  // Day-counter phrasing — Math.max guards against negative values if
  // cron is lagging or system clock drift creates a "negative days
  // remaining" calculation. Floor at 0 → reads as "today" or "0 days".
  const daysSafe = Math.max(0, daysRemainingUntilSuspension)
  const daysLabel = daysSafe === 1 ? '1 day' : `${daysSafe} days`

  return (
    <div style={{
      background: AMBER_BG,
      border: `1px solid ${AMBER_BORDER}`,
      borderRadius: 8,
      padding: '12px 16px',
      marginBottom: 14,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      position: 'relative',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{
          color: AMBER_TEXT,
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 6,
        }}>
          Payment past due
        </div>
        {/* B66.5.1: body copy differs by role. CA sees full company-context
            framing; non-CA sees nudge-toward-administrator framing. */}
        {(userRole === 'company_admin' || userRole === 'admin') ? (
          <div style={{ color: '#e2e8f0', fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
            {companyName}&apos;s ShieldMyLot subscription payment hasn&apos;t gone
            through yet. Your account will be suspended in <strong>{daysLabel}</strong>
            {' '}if payment isn&apos;t resolved.
          </div>
        ) : (
          <div style={{ color: '#e2e8f0', fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
            Your account will be suspended in <strong>{daysLabel}</strong> if payment
            isn&apos;t resolved. Please contact your company administrator to update payment.
          </div>
        )}
        {/* B66.5.1: CTA differs by role. CA + admin → Update payment button;
            non-CA → mailto link to CA (falls back to support@shieldmylot.com). */}
        {(userRole === 'company_admin' || userRole === 'admin') ? (
          <a href={updatePaymentUrl}
            style={{
              display: 'inline-block',
              background: GOLD,
              color: '#0a0d14',
              fontWeight: 700,
              fontSize: 13,
              padding: '8px 16px',
              borderRadius: 6,
              textDecoration: 'none',
            }}
          >
            Update payment →
          </a>
        ) : (
          <a href={`mailto:${caEmail || SUPPORT_FALLBACK_EMAIL}?subject=ShieldMyLot%20account%20past%20due`}
            style={{
              display: 'inline-block',
              color: GOLD,
              fontWeight: 600,
              fontSize: 13,
              textDecoration: 'none',
              borderBottom: `1px solid ${GOLD}`,
            }}
          >
            {caEmail || SUPPORT_FALLBACK_EMAIL} →
          </a>
        )}
      </div>
      <button
        onClick={onClose}
        aria-label="Dismiss past due banner"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#94a3b8',
          fontSize: 18,
          cursor: 'pointer',
          lineHeight: 1,
          padding: 4,
          marginLeft: 4,
        }}
      >
        ×
      </button>
    </div>
  )
}
