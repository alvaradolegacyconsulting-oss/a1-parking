'use client'
// B66.3 — post-Stripe-Checkout success landing. Stripe redirects here
// with ?session_id=<CHECKOUT_SESSION_ID>. The webhook
// (checkout.session.completed) fires asynchronously and creates the
// company + user_role; we poll user_roles for the current user_id and
// redirect to /company_admin once it appears (pre-flight ask 10
// Option A — poll user_roles, NOT companies, because user_roles is the
// LAST insert in the webhook transaction so its existence guarantees
// full atomic completion).
//
// Poll: 1s interval, 30s max, then fallback "still processing" UI
// with a manual refresh button.

import { useEffect, useState } from 'react'
import { supabase } from '../../supabase'
import { bootstrapCompanyContext, type CompanyBootstrapRow } from '../../lib/company-bootstrap'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

const POLL_INTERVAL_MS = 1000
const POLL_MAX_MS = 30000

type Status =
  | { kind: 'polling'; elapsed: number }
  | { kind: 'timeout' }
  | { kind: 'redirecting' }
  | { kind: 'unauthenticated' }

export default function SignupSuccess() {
  const [status, setStatus] = useState<Status>({ kind: 'polling', elapsed: 0 })

  useEffect(() => {
    let cancelled = false
    let elapsed = 0

    async function poll() {
      if (cancelled) return
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setStatus({ kind: 'unauthenticated' })
        return
      }
      // user_roles is keyed by email (case-insensitive) per existing
      // schema (see /login dispatcher pattern). Webhook handler INSERTs
      // role row with lowercase email.
      const { data: roleRow } = await supabase
        .from('user_roles')
        .select('role, company')
        .ilike('email', user.email!)
        .maybeSingle()
      if (roleRow) {
        // B140 Item 1 — populate company-context localStorage from the
        // just-created companies row BEFORE redirecting to /company_admin.
        // Without this, the dashboard renders with empty localStorage —
        // header badge missing + Plan tab fallback to misleading default
        // (B123 D.1 finding: self-serve subscribers see the wrong tier
        // badge until they manually sign out + back in).
        //
        // The user_roles row guarantees the companies row exists (B66.3
        // Option A invariant — user_roles is the LAST insert in the
        // webhook transaction). On the unexpected "companies missing OR
        // multi-match" case, log + skip bootstrap + proceed to redirect:
        // the B140 Item 2 Plan tab empty-localStorage check shows the
        // "Refresh account info" CTA as a one-click recovery path.
        if (roleRow.company) {
          try {
            const { data: companyRow } = await supabase
              .from('companies')
              .select('id, logo_url, display_name, support_phone, support_email, support_website, tier, tier_type, theme')
              .eq('name', roleRow.company)
              .single()
            await bootstrapCompanyContext(companyRow as CompanyBootstrapRow | null)
          } catch (err) {
            console.error('[signup-success] bootstrap fetch failed; redirecting without bootstrap', {
              company: roleRow.company,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        setStatus({ kind: 'redirecting' })
        // Tiny delay so the success state flashes briefly (UX feedback).
        setTimeout(() => { window.location.href = '/company_admin' }, 400)
        return
      }
      elapsed += POLL_INTERVAL_MS
      if (elapsed >= POLL_MAX_MS) {
        setStatus({ kind: 'timeout' })
        return
      }
      setStatus({ kind: 'polling', elapsed })
      setTimeout(poll, POLL_INTERVAL_MS)
    }
    void poll()

    return () => { cancelled = true }
  }, [])

  return (
    <main style={{ minHeight: '100vh', background: BG, color: TEXT, fontFamily: 'system-ui, Arial, sans-serif', padding: '80px 24px' }}>
      <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>

        {(status.kind === 'polling' || status.kind === 'redirecting') && (
          <>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', fontSize: 28 }}>✓</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px' }}>Payment received</h1>
            <p style={{ color: '#94a3b8', fontSize: 15, lineHeight: 1.6, margin: '0 0 6px' }}>
              {status.kind === 'redirecting' ? 'Loading your dashboard…' : 'Setting up your account…'}
            </p>
            <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
              This usually takes a few seconds.
            </p>
            {status.kind === 'polling' && status.elapsed > 5000 && (
              <p style={{ color: MUTED, fontSize: 12, marginTop: 18 }}>
                Still working… {Math.floor((POLL_MAX_MS - status.elapsed) / 1000)}s remaining.
              </p>
            )}
          </>
        )}

        {status.kind === 'timeout' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>Still processing</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 20px' }}>
              Your payment cleared but your account isn&apos;t ready yet. This is unusual — refresh in a moment, or contact support if it persists.
            </p>
            <button onClick={() => window.location.reload()}
              style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginRight: 10 }}>
              Refresh
            </button>
            <a href="mailto:support@shieldmylot.com" style={{ color: GOLD, fontSize: 13, textDecoration: 'none' }}>
              Contact support →
            </a>
          </div>
        )}

        {status.kind === 'unauthenticated' && (
          <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
            <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>Sign in to continue</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6, margin: '0 0 20px' }}>
              Your session expired after returning from Stripe. Sign in with the email and password you used at signup.
            </p>
            <a href="/login" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Sign in</a>
          </div>
        )}

      </div>
    </main>
  )
}
