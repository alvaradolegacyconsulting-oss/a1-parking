'use client'
// B65.3 → B65.4: post-verification landing now hosts the live activation
// form. PKCE auto-exchange from the verification-email link still runs as
// before (B65.3 — flowType='pkce', detectSessionInUrl=true). Once the
// session is confirmed we re-validate the proposal code (Finding 8 — UX
// surfaces a stale-code error BEFORE the user fills the form; the atomic
// RPC's row-locked re-check is still the authoritative correctness gate),
// then render the company-info form + ToS click-accept. Submission calls
// redeem_proposal_code() which atomically creates the company, user_roles
// row, links + flips the code, records ToS acceptance, and activates the
// account in a single transaction. Success → redirect to /company_admin.

import { useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../../supabase'
import { TOS_VERSION, TOS_DISPLAY_DATE, PRIVACY_VERSION, PRIVACY_DISPLAY_DATE } from '../../../lib/legal-versions'

const GOLD = '#C9A227'
const BG = '#0a0d14'
const CARD_BG = 'rgba(255,255,255,0.02)'
const BORDER = 'rgba(255,255,255,0.06)'
const TEXT = '#e2e8f0'
const MUTED = '#64748b'

type Status =
  | { kind: 'loading' }
  | { kind: 'unverified' }                                                    // no session / email not confirmed
  | { kind: 'invalid_code'; reason: string }                                  // session ok, but code can't be redeemed (expired since signup, revoked, etc.)
  | { kind: 'ready'; user: User; proposalCode: string; tierLabel: string }    // form-ready

type Submission =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }

function invalidCopy(reason: string): { title: string; body: string } {
  // Verify-time variants — the user has already signed up, so the framing
  // assumes state shifted between signup and activation rather than
  // a typo'd code.
  switch (reason) {
    case 'missing_code':
      return { title: 'We can’t find your proposal code', body: 'Your account doesn’t have a proposal code attached. Contact support@shieldmylot.com and we’ll sort it out.' }
    case 'redeemed':
      return { title: 'This code was already redeemed', body: 'It looks like activation completed in another session. Try signing in — if that doesn’t work, contact support@shieldmylot.com.' }
    case 'expired':
      return { title: 'Your proposal code expired', body: 'The window for activating this code has closed. Contact support@shieldmylot.com and we’ll issue a new one.' }
    case 'revoked':
    case 'not_issued':
    case 'tier_not_set':
    case 'not_found':
    default:
      return { title: 'This code can’t be redeemed right now', body: 'Something about your proposal code changed since signup. Contact support@shieldmylot.com and we’ll get you set up.' }
  }
}

function tierLabelFor(tierType: string, tier: string): string {
  const trackLabel = tierType === 'enforcement' ? 'Enforcement' : 'Property Management'
  const tierTitle = tier.charAt(0).toUpperCase() + tier.slice(1)
  return `${trackLabel} · ${tierTitle}`
}

export default function VerifyLanding() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  // Form state — only meaningful when status.kind === 'ready'
  const [companyName, setCompanyName] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [address, setAddress] = useState('')
  const [tosChecked, setTosChecked] = useState(false)
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })

  useEffect(() => {
    let resolved = false
    let cancelled = false

    async function continueFromSession(session: Session | null) {
      if (resolved || cancelled) return
      const user = session?.user
      if (!user?.email_confirmed_at) return
      resolved = true

      const meta = (user.user_metadata || {}) as Record<string, unknown>
      const code = typeof meta.proposal_code === 'string' && meta.proposal_code.length > 0
        ? meta.proposal_code
        : null

      if (!code) {
        setStatus({ kind: 'invalid_code', reason: 'missing_code' })
        return
      }

      // Finding 8: re-validate the code with the live state before showing
      // the form. The RPC re-checks under FOR UPDATE at submit time too —
      // this call is for UX, not correctness.
      const { data: vData, error: vErr } = await supabase.rpc('validate_proposal_code', { p_code: code })
      if (cancelled) return
      if (vErr || !vData) {
        setStatus({ kind: 'invalid_code', reason: 'not_found' })
        return
      }
      const result = vData as Record<string, unknown>
      if (result.valid !== true) {
        setStatus({ kind: 'invalid_code', reason: String(result.reason || 'not_found') })
        return
      }

      setStatus({
        kind: 'ready',
        user,
        proposalCode: code,
        tierLabel: tierLabelFor(String(result.tier_type), String(result.tier)),
      })
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void continueFromSession(session)
    })
    supabase.auth.getSession().then(({ data }) => continueFromSession(data.session))

    const timeoutId = window.setTimeout(() => {
      if (!resolved && !cancelled) {
        resolved = true
        setStatus({ kind: 'unverified' })
      }
    }, 4000)

    return () => {
      cancelled = true
      subscription.unsubscribe()
      window.clearTimeout(timeoutId)
    }
  }, [])

  function formError(): string | null {
    if (!companyName.trim()) return 'Company name is required.'
    if (!contactName.trim()) return 'Primary contact name is required.'
    if (!contactPhone.trim()) return 'Primary contact phone is required.'
    if (!address.trim()) return 'Billing address is required.'
    if (!tosChecked) return 'You must agree to the Terms of Service and Privacy Policy.'
    return null
  }

  async function activate() {
    if (status.kind !== 'ready') return
    const err = formError()
    if (err) {
      setSubmission({ kind: 'error', message: err })
      return
    }
    setSubmission({ kind: 'submitting' })

    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null

    const { data, error } = await supabase.rpc('redeem_proposal_code', {
      p_code: status.proposalCode,
      p_user_id: status.user.id,
      p_company_name: companyName.trim(),
      p_primary_contact_name: contactName.trim(),
      p_primary_contact_phone: contactPhone.trim(),
      p_tos_version: TOS_VERSION,
      p_privacy_version: PRIVACY_VERSION,
      p_address: address.trim(),
      // p_ip_address omitted — browser can't reliably know its own IP
      // (Finding 7). Server-side proxy is a future commit if legal asks.
      p_user_agent: userAgent,
    })

    if (error) {
      // Surface a friendly version of the RPC's RAISE message. The raw
      // text is fine for ops debugging but we strip schema-leaky details.
      const raw = error.message || 'Activation failed. Please try again.'
      const friendly =
        raw.includes('company name already in use') ? 'That company name is already in use. Try a slight variation.'
        : raw.includes('code not redeemable') ? 'This code is no longer redeemable. Contact support@shieldmylot.com.'
        : raw.includes('code expired') ? 'This code expired while you were filling out the form. Contact support@shieldmylot.com.'
        : raw.includes('unauthenticated') || raw.includes('auth.uid mismatch') ? 'Your session expired. Please sign in again.'
        : raw
      setSubmission({ kind: 'error', message: friendly })
      return
    }

    if (typeof data !== 'number' && typeof data !== 'string') {
      setSubmission({ kind: 'error', message: 'Activation succeeded but the response was unexpected. Try signing in.' })
      return
    }

    // Success — atomic RPC has already flipped account_state to 'active',
    // so login dispatch will route cleanly to the dashboard.
    window.location.href = '/company_admin'
  }

  // ── RENDER ─────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background: '#0a0d14', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    padding: '12px 16px', color: '#fff', width: '100%', fontSize: 14,
    boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit',
  }
  const labelStyle: React.CSSProperties = { color: MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 6, marginTop: 14 }

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

        {status.kind === 'invalid_code' && (() => {
          const copy = invalidCopy(status.reason)
          return (
            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 28 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⚠️</div>
              <h2 style={{ color: GOLD, fontSize: 20, fontWeight: 700, textAlign: 'center', margin: '0 0 10px' }}>{copy.title}</h2>
              <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 22px' }}>{copy.body}</p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a href="mailto:support@shieldmylot.com" style={{ background: GOLD, color: '#0a0d14', borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Contact support</a>
                <a href="/login" style={{ background: CARD_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>Sign in</a>
              </div>
            </div>
          )
        })()}

        {status.kind === 'ready' && (
          <>
            <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.35)', borderRadius: 14, padding: 18, marginBottom: 18, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ fontSize: 20, lineHeight: 1.2 }}>✓</span>
              <div>
                <p style={{ color: '#86efac', fontSize: 14, fontWeight: 700, margin: 0 }}>Email verified</p>
                <p style={{ color: '#94a3b8', fontSize: 13, margin: '4px 0 0', wordBreak: 'break-all' }}>{status.user.email}</p>
              </div>
            </div>

            <div style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid rgba(201,162,39,0.35)`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
              <p style={{ color: GOLD, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 700 }}>Activating</p>
              <p style={{ color: TEXT, fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>{status.tierLabel}</p>
              <p style={{ color: MUTED, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0, wordBreak: 'break-all' }}>{status.proposalCode}</p>
            </div>

            <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24 }}>
              <h2 style={{ color: TEXT, fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>Tell us about your company</h2>
              <p style={{ color: MUTED, fontSize: 13, margin: '0 0 6px' }}>This information sets up your company profile. You can fine-tune it later from the dashboard.</p>

              <label style={{ ...labelStyle, marginTop: 14 }}>Company name</label>
              <input type="text" style={inputStyle} value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="A1 Wrecker LLC" />

              <label style={labelStyle}>Primary contact name</label>
              <input type="text" autoComplete="name" style={inputStyle} value={contactName}
                onChange={e => setContactName(e.target.value)}
                placeholder="Your full name" />

              <label style={labelStyle}>Primary contact phone</label>
              <input type="tel" autoComplete="tel" style={inputStyle} value={contactPhone}
                onChange={e => setContactPhone(e.target.value)}
                placeholder="713-555-0100" />

              <label style={labelStyle}>Billing address (street, city, state, zip)</label>
              <textarea style={{ ...inputStyle, minHeight: 72, resize: 'vertical', lineHeight: 1.5 }} value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="123 Main St, Houston, TX 77001" />

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 22, cursor: 'pointer' }}>
                <input type="checkbox" checked={tosChecked} onChange={e => setTosChecked(e.target.checked)}
                  style={{ marginTop: 3, accentColor: GOLD, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>
                  I agree to the{' '}
                  <a href="/terms" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Terms of Service</a>
                  {' '}({TOS_DISPLAY_DATE}) and{' '}
                  <a href="/privacy" target="_blank" rel="noopener" style={{ color: GOLD, textDecoration: 'none' }}>Privacy Policy</a>
                  {' '}({PRIVACY_DISPLAY_DATE}).
                </span>
              </label>

              {submission.kind === 'error' && (
                <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
                  <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{submission.message}</p>
                </div>
              )}

              <button onClick={activate} disabled={submission.kind === 'submitting'}
                style={{ width: '100%', marginTop: 18, background: submission.kind === 'submitting' ? '#555' : GOLD, color: submission.kind === 'submitting' ? '#888' : '#0a0d14', fontWeight: 700, fontSize: 15, padding: '13px', border: 'none', borderRadius: 10, cursor: submission.kind === 'submitting' ? 'not-allowed' : 'pointer' }}>
                {submission.kind === 'submitting' ? 'Activating…' : 'Activate account'}
              </button>

              <p style={{ color: MUTED, fontSize: 11, margin: '14px 0 0', textAlign: 'center' }}>
                Activation creates your company workspace and lands you on the dashboard.
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
