'use client'
// B65.3: post-verification landing. Supabase's PKCE flow auto-exchanges
// the ?code=<flow_code> param that arrives from the verification-email
// link (createBrowserClient defaults: flowType='pkce', detectSessionInUrl=
// true). We listen for the session via onAuthStateChange + a one-shot
// getUser() and react to the outcome.
//
// Holding state for B65.3: when the user has a confirmed session, we
// render a "Continue setup" skeleton that displays the proposal code
// they signed up with (from user_metadata) and tells them the activation
// form is coming. B65.4 replaces the skeleton with the actual company-
// info form + ToS checkbox + redeem_proposal_code() RPC call.
//
// Scope guard: no activation logic here. No company writes. The user
// isn't stranded — they see their progress + a clear next step.

import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../../supabase'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Status =
  | { kind: 'loading' }
  | { kind: 'unverified' }                 // no session, or email not confirmed
  | { kind: 'ready'; user: User; proposalCode: string | null }

export default function VerifyLanding() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let resolved = false

    function applySession(session: Session | null) {
      if (resolved) return
      const user = session?.user
      if (user?.email_confirmed_at) {
        resolved = true
        const meta = (user.user_metadata || {}) as Record<string, unknown>
        const code = typeof meta.proposal_code === 'string' && meta.proposal_code.length > 0
          ? meta.proposal_code
          : null
        setStatus({ kind: 'ready', user, proposalCode: code })
      }
    }

    // Subscribe first so we don't miss the SIGNED_IN event that follows
    // the PKCE auto-exchange triggered by detectSessionInUrl.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session)
    })

    // Belt + suspenders: also check the current session in case the
    // exchange already finished before this effect ran.
    supabase.auth.getSession().then(({ data }) => applySession(data.session))

    // Fallback: if no confirmed session appears within 4 seconds, drop
    // into the unverified state so the user isn't stuck on "Loading".
    const timeoutId = window.setTimeout(() => {
      if (!resolved) {
        resolved = true
        setStatus({ kind: 'unverified' })
      }
    }, 4000)

    return () => {
      subscription.unsubscribe()
      window.clearTimeout(timeoutId)
    }
  }, [])

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '48px 24px' }}>
      <div style={{ maxWidth: 540, margin: '0 auto' }}>

        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Account setup</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>ShieldMyLot™ · Texas parking enforcement</p>
          <div style={{ width: 60, height: 2, background: GOLD, opacity: 0.7, margin: '14px auto 0' }} />
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28, textAlign: 'center' }}>
            <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>Confirming your email…</p>
          </div>
        )}

        {status.kind === 'unverified' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>📧</div>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>Verify your email to continue</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 18px' }}>
              We couldn’t pick up your verified session. Click the link in the verification email we sent — it’ll bring you back here ready to finish setup.
            </p>
            <p style={{ color: MUTED, fontSize: 13, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>
              Lost the email or signed up on a different device? Start the redemption again.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href="/signup/redeem" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Restart redemption</a>
              <a href="/login" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Sign in</a>
            </div>
          </div>
        )}

        {status.kind === 'ready' && (
          <>
            <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 14, padding: 18, marginBottom: 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ fontSize: 20, lineHeight: 1.2 }}>✓</span>
              <div>
                <p style={{ color: '#86efac', fontSize: 14, fontWeight: 700, margin: 0 }}>Email verified</p>
                <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0 0', wordBreak: 'break-all' }}>{status.user.email}</p>
              </div>
            </div>

            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
              <h2 style={{ color: TEXT, fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>Almost ready</h2>
              <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 16px' }}>
                Your email is verified. The next step is a short company-info form, agreeing to our terms, and activating your account.
              </p>

              {status.proposalCode && (
                <div style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 14px', margin: '0 0 18px' }}>
                  <p style={{ color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px', fontWeight: 700 }}>Your proposal code</p>
                  <p style={{ color: GOLD, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0, wordBreak: 'break-all' }}>{status.proposalCode}</p>
                </div>
              )}

              {/* B65.3 holding state — B65.4 replaces this card with the live
                  company-info form, ToS click-accept, and the
                  redeem_proposal_code() RPC call (which also re-validates the
                  code at activation time). */}
              <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px dashed rgba(201,162,39,0.4)`, borderRadius: 10, padding: 18 }}>
                <p style={{ color: GOLD, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 700 }}>Coming next</p>
                <p style={{ color: '#cbd5e1', fontSize: 14, margin: '0 0 4px', fontWeight: 600 }}>Continue setup</p>
                <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                  We’re putting the final touches on the activation form. It’ll appear here shortly — no further action needed from you right now. If you’d like to be walked through setup live, email{' '}
                  <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, textDecoration: 'none' }}>support@shieldmylot.com</a>{' '}and we’ll book a call.
                </p>
              </div>

              <p style={{ color: MUTED, fontSize: 12, margin: '18px 0 0', lineHeight: 1.6 }}>
                You can safely close this tab — when activation is ready, signing back in with the email above will land you here.
              </p>
            </div>
          </>
        )}

        <p style={{ textAlign: 'center', color: MUTED, fontSize: 11, marginTop: 28 }}>
          © 2026 ShieldMyLot™ · A product of Alvarado Legacy Consulting LLC
        </p>
      </div>
    </main>
  )
}
