'use client'

// ════════════════════════════════════════════════════════════════════
// /consent — authenticated post-login gate for missing legal consents
// P1 CONSENT HARD-GATE Commit 2 of 5 · 2026-07-16
//
// ── ROLE IN THE ARC ─────────────────────────────────────────────────
// On any authenticated portal request, Commit 3's server-side gate
// (in each portal's layout.tsx) computes missing consents via
// hasCurrentConsents() from app/lib/consent-gate.ts. If the user is
// missing ANY required doc at current version, the gate redirects
// to this page with ?missing=tos,privacy,saas,texas_attestation.
//
// This page:
//   1. Reads authenticated user + role.
//   2. Recomputes missing docs (never trusts the ?missing= query — a
//      user in the middle of a version bump could arrive with a stale
//      query while their actual missing-set changed on the DB).
//   3. Renders the missing docs as LegalGateAccordion (scroll-to-sign
//      per doc) + Texas checkbox for company_admin.
//   4. On all-gates-signed → call accept_all_pending_consents RPC.
//   5. On RPC success → redirectByRole to the user's portal.
//
// If already consented (missing.length === 0), redirects immediately
// to the user's portal. This makes /consent idempotent as a URL — a
// direct hit doesn't force redundant signing.
//
// ── WHY THIS ROUTE NEEDS TO EXIST ───────────────────────────────────
// The prior consent mechanism was a client-side modal on /login only.
// Bypassable by refresh / direct-nav / new-tab. Amanda (company_admin)
// landed with zero consent rows as evidence. A dedicated authenticated
// route + portal-layout server gate closes the bypass class entirely:
// consent lives at its own URL, gated on server, versioned, atomic.
//
// ── NOT IN THIS COMMIT ──────────────────────────────────────────────
// • The portal-layout gates that REDIRECT users here (that's Commit 3).
// • Retiring the /login modal (Commit 4).
// • Middleware allowlist change for /consent (already default: middleware
//   allows authenticated users everywhere; no publicPaths entry needed).
// ════════════════════════════════════════════════════════════════════

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import LegalGateAccordion, { type GateSpec } from '../components/LegalGateAccordion'
import TermsBody from '../components/TermsBody'
import PrivacyBody from '../components/PrivacyBody'
import SaasAgreementBody from '../components/SaasAgreementBody'
import {
  TOS_VERSION,
  TOS_DISPLAY_DATE,
  PRIVACY_VERSION,
  PRIVACY_DISPLAY_DATE,
  SAAS_VERSION,
  SAAS_DISPLAY_DATE,
  TEXAS_ATTESTATION_VERSION,
  TEXAS_ATTESTATION_TEXT,
} from '../lib/legal-versions'
import {
  hasCurrentConsents,
  redirectByRole,
  type DocKey,
  type Role,
} from '../lib/consent-gate'

function ConsentForm() {
  const searchParams = useSearchParams()
  const missingHint = searchParams.get('missing') // informational only; source-of-truth is fresh DB read

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [role, setRole] = useState<Role | null>(null)
  const [missing, setMissing] = useState<DocKey[]>([])

  // Per-doc reviewed_at latches (T1 stamps captured by LegalGateAccordion
  // when the user finishes the scroll-to-sign gate). Passed to the RPC
  // so it can persist reviewed_at on each tos_acceptances row (evidence
  // of readthrough — attorney requirement).
  const [tosReviewedAt,     setTosReviewedAt]     = useState<string | null>(null)
  const [privacyReviewedAt, setPrivacyReviewedAt] = useState<string | null>(null)
  const [saasReviewedAt,    setSaasReviewedAt]    = useState<string | null>(null)

  // Texas is an attestation checkbox (not a readthrough gate). No
  // reviewed_at stamp; just a boolean. Version passed to the RPC when
  // checked.
  const [texasChecked, setTexasChecked] = useState(false)

  // On mount: fetch user, role, missing docs. Fail-open only on
  // unauthenticated (redirect to /login); fail-closed on any read
  // error (show error, let user retry — don't silently redirect).
  useEffect(() => {
    let cancelled = false
    async function loadStatus() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        window.location.href = '/login'
        return
      }
      const { data: userRole, error: roleErr } = await supabase
        .from('user_roles')
        .select('role')
        .eq('email', user.email!)
        .maybeSingle()
      if (cancelled) return
      if (roleErr || !userRole?.role) {
        setError('Could not load your account role. Please refresh; contact support if it persists.')
        setLoading(false)
        return
      }
      const status = await hasCurrentConsents(supabase, user.id, userRole.role as Role)
      if (cancelled) return
      if (status.consented) {
        // Already fully consented — nothing to do. Redirect to portal.
        window.location.href = redirectByRole(status.role)
        return
      }
      setRole(status.role)
      setMissing(status.missing)
      setLoading(false)
    }
    loadStatus()
    return () => { cancelled = true }
  }, [])

  const needsTos     = missing.includes('tos')
  const needsPrivacy = missing.includes('privacy')
  const needsSaas    = missing.includes('saas')
  const needsTexas   = missing.includes('texas_attestation')

  // Ready-to-submit predicate. Each missing doc must have its reviewed_at
  // stamp; Texas (if missing) must have the checkbox checked.
  const allSigned =
      (!needsTos     || !!tosReviewedAt)
   && (!needsPrivacy || !!privacyReviewedAt)
   && (!needsSaas    || !!saasReviewedAt)
   && (!needsTexas   || texasChecked)

  async function submitConsents() {
    if (!allSigned) return
    setSubmitting(true)
    setError('')

    // Pass every version + reviewed_at we HAVE — RPC decides which to
    // insert based on caller's role + the IF NOT EXISTS guards per doc.
    // For missing docs the client didn't render (already-consented at
    // current version), we still pass their versions/reviewed_ats as
    // null-safe defaults; RPC's IF NOT EXISTS skips them.
    const { data, error: rpcErr } = await supabase.rpc('accept_all_pending_consents', {
      p_tos_version:         TOS_VERSION,
      p_tos_reviewed_at:     tosReviewedAt ?? new Date().toISOString(),
      p_privacy_version:     PRIVACY_VERSION,
      p_privacy_reviewed_at: privacyReviewedAt ?? new Date().toISOString(),
      p_saas_version:        role === 'company_admin' ? SAAS_VERSION : null,
      p_saas_reviewed_at:    role === 'company_admin' ? (saasReviewedAt ?? new Date().toISOString()) : null,
      p_texas_version:       role === 'company_admin' ? TEXAS_ATTESTATION_VERSION : null,
      p_ip_address:          null,
      p_user_agent:          typeof navigator !== 'undefined' ? navigator.userAgent : null,
    })

    if (rpcErr) {
      setError(`Could not save your consent. Please try again. (${rpcErr.message})`)
      setSubmitting(false)
      return
    }
    // RPC returns { ok, role, ... }. Trust our resolved role (it's the
    // same one; we're not going to differ) and redirect.
    if (!role) {
      setError('Consent saved but redirect failed — please refresh.')
      setSubmitting(false)
      return
    }
    window.location.href = redirectByRole(role)
  }

  if (loading) {
    return (
      <main style={pageStyle}>
        <div style={{ color: '#888', fontSize: 13 }}>Loading…</div>
      </main>
    )
  }

  if (error && !role) {
    return (
      <main style={pageStyle}>
        <div style={cardStyle}>
          <p style={{ color: '#f44336', fontSize: 13 }}>{error}</p>
          <button onClick={() => window.location.reload()} style={buttonStyle}>Retry</button>
        </div>
      </main>
    )
  }

  // Build the accordion gate list from missing set. LegalGateAccordion
  // is the same component /register + /signup use; consistent UX.
  const gates: GateSpec[] = []
  if (needsTos) {
    gates.push({
      key: 'tos',
      title: 'Terms of Use',
      version: TOS_VERSION,
      displayDate: TOS_DISPLAY_DATE,
      body: <TermsBody />,
      signButtonLabel: 'Sign & Accept Terms of Use',
    })
  }
  if (needsPrivacy) {
    gates.push({
      key: 'privacy',
      title: 'Privacy Policy',
      version: PRIVACY_VERSION,
      displayDate: PRIVACY_DISPLAY_DATE,
      body: <PrivacyBody />,
      signButtonLabel: 'Sign & Accept Privacy Policy',
    })
  }
  if (needsSaas) {
    gates.push({
      key: 'saas',
      title: 'SaaS Subscription Agreement',
      version: SAAS_VERSION,
      displayDate: SAAS_DISPLAY_DATE,
      body: <SaasAgreementBody />,
      signButtonLabel: 'Sign & Accept SaaS Agreement',
    })
  }

  return (
    <main style={pageStyle}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div style={{ marginBottom: 20, textAlign: 'center' }}>
          <h1 style={{ color: '#C9A227', fontSize: 22, fontWeight: 'bold', margin: '0 0 6px' }}>Complete your account</h1>
          <p style={{ color: '#aaa', fontSize: 13, margin: 0 }}>
            {missing.length === 1
              ? 'One document needs your review before you can continue.'
              : `${missing.length} documents need your review before you can continue.`}
          </p>
          {missingHint && (
            <p style={{ color: '#555', fontSize: 10, marginTop: 6 }}>
              Redirected from a protected page. This is a one-time step per document version.
            </p>
          )}
        </div>

        <div style={cardStyle}>
          {gates.length > 0 && (
            <LegalGateAccordion
              signedKeys={[
                ...(tosReviewedAt     ? ['tos']     : []),
                ...(privacyReviewedAt ? ['privacy'] : []),
                ...(saasReviewedAt    ? ['saas']    : []),
              ]}
              onGateSigned={(key, { reviewedAt }) => {
                if      (key === 'tos')     setTosReviewedAt(reviewedAt)
                else if (key === 'privacy') setPrivacyReviewedAt(reviewedAt)
                else if (key === 'saas')    setSaasReviewedAt(reviewedAt)
              }}
              gates={gates}
            />
          )}

          {needsTexas && (
            <div style={{ marginTop: 14, padding: '14px 16px', background: 'rgba(201,162,39,0.04)', border: '1px solid rgba(201,162,39,0.18)', borderRadius: 10 }}>
              <p style={{ color: '#C9A227', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px', fontWeight: 700 }}>Texas operations attestation</p>
              <pre style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{TEXAS_ATTESTATION_TEXT}</pre>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={texasChecked} onChange={e => setTexasChecked(e.target.checked)}
                  style={{ marginTop: 3, accentColor: '#C9A227', cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.6 }}>
                  I attest to the Texas operations terms above (required).
                </span>
              </label>
            </div>
          )}

          {error && (
            <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 12px', marginTop: 14 }}>
              <p style={{ color: '#f44336', fontSize: 12, margin: 0, lineHeight: 1.5 }}>{error}</p>
            </div>
          )}

          <button
            onClick={submitConsents}
            disabled={!allSigned || submitting}
            style={{
              ...buttonStyle,
              marginTop: 16,
              background: (allSigned && !submitting) ? '#C9A227' : '#555',
              color:      (allSigned && !submitting) ? '#0f1117' : '#888',
              cursor:     (allSigned && !submitting) ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </main>
  )
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  background: '#0f1117',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'Arial, sans-serif',
  padding: 20,
}

const cardStyle: React.CSSProperties = {
  background: '#161b26',
  border: '1px solid #2a2f3d',
  borderRadius: 12,
  padding: 20,
}

const buttonStyle: React.CSSProperties = {
  width: '100%',
  padding: 12,
  fontWeight: 'bold',
  fontSize: 14,
  border: 'none',
  borderRadius: 8,
  fontFamily: 'Arial',
}

export default function ConsentPage() {
  return (
    <Suspense fallback={
      <main style={pageStyle}>
        <div style={{ color: '#888' }}>Loading…</div>
      </main>
    }>
      <ConsentForm />
    </Suspense>
  )
}
