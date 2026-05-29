'use client'
// B66.5 commit 4.3 — /account-suspended landing page.
//
// Hard-redirect target for account_state='suspended'. Reachable via
// gateAccountState in all 4 portal mount logics + /login dispatch.
// Mirrors /account-cancelled structure with different copy + icon +
// CTA shape (Update payment vs Contact support).
//
// Auth-required per Q2 lock — page reads logged-in user's company
// state to show personalized content (company name + days remaining
// in suspension grace if available). Anonymous visitors get redirected
// to /login by middleware (NOT in publicPaths allowlist).
//
// Copy alignment with Day 7 dunning email (DunningDay7.tsx).
// Same tone discipline per [[feedback-template-empathetic-tone-pattern]]:
// informational, not punitive; "your data remains intact and ready
// for restoration" framing; clear restoration path; support escalation.

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const GOLD = '#C9A227'

interface CompanyState {
  name: string
  display_name: string | null
  suspension_grace_until: string | null
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'no_company' }
  | { kind: 'ready'; company: CompanyState; daysRemaining: number | null }

export default function AccountSuspended() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) {
        if (!cancelled) setState({ kind: 'unauthenticated' })
        return
      }
      const { data: roleRow } = await supabase
        .from('user_roles')
        .select('company')
        .ilike('email', user.email)
        .maybeSingle()
      if (!roleRow?.company) {
        if (!cancelled) setState({ kind: 'no_company' })
        return
      }
      const { data: companyRow } = await supabase
        .from('companies')
        .select('name, display_name, suspension_grace_until')
        .ilike('name', roleRow.company)
        .maybeSingle()
      if (!companyRow) {
        if (!cancelled) setState({ kind: 'no_company' })
        return
      }
      const daysRemaining = companyRow.suspension_grace_until
        ? Math.max(0, Math.ceil(
            (new Date(companyRow.suspension_grace_until).getTime() - Date.now()) /
            (24 * 60 * 60 * 1000)
          ))
        : null
      if (!cancelled) {
        setState({
          kind: 'ready',
          company: companyRow as CompanyState,
          daysRemaining,
        })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const displayName = state.kind === 'ready'
    ? (state.company.display_name ?? state.company.name)
    : 'Your company'

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
        }}>🔒</div>

        <h1 style={{ color: GOLD, fontSize: 24, fontWeight: 700, margin: '0 0 14px', textAlign: 'center' }}>
          Account Suspended
        </h1>

        <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 16px', lineHeight: 1.6 }}>
          {displayName}&apos;s ShieldMyLot subscription has been suspended because the past due
          payment wasn&apos;t resolved within the 7-day grace period. Portals are temporarily
          inaccessible while the subscription is being restored.
        </p>

        <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, margin: '0 0 18px' }}>
          <div style={{ fontWeight: 700, color: GOLD, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            What this means
          </div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>Drivers, residents, and managers temporarily can&apos;t access their portals</li>
            <li>Your data remains intact and ready for restoration</li>
            <li>
              You have {state.kind === 'ready' && state.daysRemaining !== null
                ? `${state.daysRemaining} day${state.daysRemaining === 1 ? '' : 's'}`
                : 'up to 7 days'}
              {' '}from suspension to restore the account
            </li>
          </ul>
        </div>

        <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, margin: '0 0 18px' }}>
          <div style={{ fontWeight: 700, color: GOLD, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            How to restore access
          </div>
          <a href="/company_admin?tab=billing"
            style={{
              display: 'inline-block',
              background: GOLD,
              color: '#0a0d14',
              fontWeight: 700,
              fontSize: 14,
              padding: '11px 22px',
              borderRadius: 10,
              textDecoration: 'none',
              marginBottom: 10,
            }}>
            Update payment →
          </a>
          <p style={{ color: '#94a3b8', fontSize: 12, margin: '8px 0 0', lineHeight: 1.6 }}>
            Once payment clears, all portal access is restored automatically.
          </p>
        </div>

        <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6, margin: '20px 0 0', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 16 }}>
          If you&apos;d like to discuss your situation before paying, contact{' '}
          <a href="mailto:support@shieldmylot.com?subject=Account%20suspended%20-%20need%20assistance"
            style={{ color: GOLD, textDecoration: 'none' }}>
            support@shieldmylot.com
          </a>.
        </p>
      </div>
    </main>
  )
}
