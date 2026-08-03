'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { useResolvedLogo } from '../lib/logo'
// B213 — Turnstile widget for native captcha-gated signInWithPassword.
// Supabase's captcha toggle (when ON) rejects sign-in without a token;
// the 6/19 lockout root cause was this site missing the widget.
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
// B65.2: account_state gate. Login dispatch is the primary stop for non-active
// states (CA portal entry has the same gate as defense in depth).
import { gateAccountState, AccountState } from '../lib/account-state'
// B76: shared bootstrap — same helper used by /signup/redeem/verify
// after activation so the post-activation dashboard isn't stuck with
// null localStorage + 'Legacy Enforcement' fallback rendering.
import { bootstrapCompanyContext, CompanyBootstrapRow } from '../lib/company-bootstrap'
// P1 CONSENT HARD-GATE Commit 4 (2026-07-16) — login-modal consent path
// retired. TOS_VERSION / PRIVACY_VERSION / LegalGateAccordion / TermsBody /
// PrivacyBody imports removed — nothing on /login renders or checks legal
// docs anymore. Enforcement lives in the portal-layout gates (Commits
// 3a/3b: 613b045, 1ca8940) + /consent route (Commit 2: da981d5), backed
// by the atomic role-conditional accept_all_pending_consents RPC
// (Commit 1: 255313f). Single enforcement path — no soft-modal that can
// disagree with the server gate.
//
// The force-password-change path is INDEPENDENT of consent and is
// preserved intact — see handleLogin below and the redirectByRole helper.
// B147 3a: hardened company-by-name resolution replacing naked
// .ilike().single() pattern that silently degrades on 0/2+-rows (B76 class).
import { resolveCompanyByName } from '../lib/company-resolve'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [logoFailed, setLogoFailed] = useState(false)
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const resolvedLogo = useResolvedLogo(companyLogo)
  // Commit 4 (2026-07-16) — removed with the login-modal retirement:
  //   showTosModal, tosReviewedAt, privacyReviewedAt, tosLoading,
  //   pendingRole, pendingEmail, pendingForcePwReset.
  // pendingForcePwReset existed ONLY to survive the modal show-then-
  // continue round-trip; forcePwReset now lives as a local const inside
  // handleLogin, passed directly to redirectByRole with no round-trip.
  // Force-password-change survival is unchanged — see handleLogin's
  // final redirectByRole(roleData.role, forcePwReset) call.
  const [suspendedCompany, setSuspendedCompany] = useState<{ display_name: string; support_phone: string | null; support_email: string | null; support_website: string | null; message?: string } | null>(null)
  // B147 3a — resolve-failure state. Captures the company name for
  // display in the error card. Single-string body copy regardless of
  // which resolve reason fired (no info leak); tagged-log in
  // resolveCompanyByName differentiates by reason for ops.
  const [resolveFailed, setResolveFailed] = useState<{ companyName: string } | null>(null)
  // B213 — captcha token + widget ref. Reset-on-failure pattern matches
  // the 4 existing widgeted forms; tokens are single-use so any failed
  // login attempt needs a fresh re-challenge.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  useEffect(() => {
    setCompanyLogo(localStorage.getItem('company_logo'))
    setCompanyName(localStorage.getItem('company_name'))
  }, [])

  function redirectByRole(role: string, forcePwReset: boolean) {
    if (forcePwReset) { window.location.href = '/change-password'; return }
    if (role === 'admin') window.location.href = '/'
    else if (role === 'company_admin') window.location.href = '/company_admin'
    else if (role === 'manager' || role === 'leasing_agent') window.location.href = '/manager'
    else if (role === 'driver') window.location.href = '/driver'
    else if (role === 'resident') window.location.href = '/resident'
    else window.location.href = '/'
  }

  // Commit 4 (2026-07-16) — acceptTos() removed with the login-modal
  // retirement. Consent writes now go through accept_all_pending_consents
  // (RPC shipped 255313f) via /consent (route shipped da981d5) after the
  // portal-layout gate (Commits 3a/3b) redirects unconsented users there.

  async function handleLogin() {
    setLoading(true)
    setError('')

    // B213 — explicit captcha guard before the signInWithPassword call.
    // Matches the defensive shape in /signup, /signup/redeem, /register,
    // /visitor: button-disabled covers the happy path, this guard makes
    // the requirement legible to readers + surfaces a clear message
    // instead of a generic auth error if someone bypasses the disable.
    if (!captchaToken) {
      setLoading(false)
      setError('Please complete the CAPTCHA challenge below before signing in.')
      return
    }

    // B65.4: capture authData so the recovery branch below can read
    // user_metadata.proposal_code + email_confirmed_at off the signed-in user.
    // B213: threading captchaToken into options — Supabase ignores when
    // toggle OFF (deploy-before-toggle stays safe).
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken },
    })
    if (authError) {
      // B213 — token is single-use; reset widget on any failure (wrong
      // password OR captcha rejection both surface as authError here)
      // so the user can re-challenge without a page reload.
      turnstileRef.current?.reset()
      setCaptchaToken(null)
      setLoading(false)
      setError('Invalid email or password. Please try again.')
      return
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('*')
      .ilike('email', email.trim())
      .single()

    if (!roleData) {
      // Mid-state recovery: a user who completed signUp + email
      // verification but never finished activation has NO user_roles
      // row yet. Two flavors:
      //   • B65.4 proposal-code path: user_metadata.proposal_code set
      //     → continue to /signup/redeem/verify
      //   • B66.3 self-serve path: user_metadata.intended_tier set
      //     → continue to /signup/verify (which knows how to resume
      //       the attest + Checkout flow)
      // Keep the user authenticated in both branches — both /verify
      // pages need the session for their PKCE-driven state.
      const meta = (authData?.user?.user_metadata || {}) as Record<string, unknown>
      const emailConfirmed = Boolean(authData?.user?.email_confirmed_at)
      const pendingCode = typeof meta.proposal_code === 'string' && meta.proposal_code.length > 0
        ? meta.proposal_code
        : null
      const pendingTier = meta.intended_tier && typeof meta.intended_tier === 'object'
      if (pendingCode && emailConfirmed) {
        setLoading(false)
        window.location.href = '/signup/redeem/verify'
        return
      }
      if (pendingTier && emailConfirmed) {
        setLoading(false)
        window.location.href = '/signup/verify'
        return
      }
      setLoading(false)
      setError('No role assigned. Please contact your administrator to get access.')
      await supabase.auth.signOut()
      return
    }

    if (roleData.role !== 'admin' && roleData.company) {
      // B147 3a — hardened resolve. Replaces the naked
      // .ilike(roleData.company).single() pattern which silently
      // swallowed 0-row + 2+-row errors → context-less portal degrade
      // (B76 class). Failure path: signOut completes BEFORE
      // setResolveFailed so the card never renders against a still-
      // authenticated session. Success path is byte-equivalent to today
      // — companyData feeds the existing is_active check +
      // gateAccountState + bootstrap.
      const resolveResult = await resolveCompanyByName(supabase, roleData.company)
      if (!resolveResult.ok) {
        setLoading(false)
        await supabase.auth.signOut()
        setResolveFailed({ companyName: String(roleData.company ?? '') })
        return
      }
      const companyData = resolveResult.company

      if (companyData.is_active === false) {
        setLoading(false)
        await supabase.auth.signOut()
        setSuspendedCompany({
          display_name: companyData.display_name || 'Your Company',
          support_phone: companyData.support_phone || null,
          support_email: companyData.support_email || null,
          support_website: companyData.support_website || null,
        })
        return
      }

      // B65.2 → B66.5.2: account_state gate (spec §3.4) with 3-arm explicit
      // routing logic. Era-shift: the original B65.2 wiring assumed
      // gateAccountState returned 'allow_with_banner' ONLY for suspended
      // (and the inline setSuspendedCompany legacy page was the surface).
      // B66.5 commit 4.3 changed the gate contract:
      //   • past_due (NEW) → allow_with_banner — let dispatch continue;
      //     portal mount renders PastDueBanner above content
      //   • suspended (CHANGED) → redirect to /account-suspended; STAY
      //     AUTHED because that page is auth-required (Q2 of 4.3 lock)
      //     and reads user state for personalization (signing out here
      //     creates a redirect loop — /account-suspended not in middleware
      //     publicPaths, so anon access bounces to /login → re-login →
      //     re-sign-out → infinite loop)
      //   • cancelled — redirect to /account-cancelled WITH sign-out
      //     (terminal state; /account-cancelled IS in publicPaths so
      //     anon access is fine post-sign-out)
      //   • configuring — redirect to /signup/redeem/verify, stay authed
      //
      // Note: setSuspendedCompany legacy state (declared at line 31) is
      // still used by two OTHER paths (is_active=false at line ~136 and
      // property-level inactive at line ~190). The account_state-driven
      // path that used to setSuspendedCompany here is dead, but the
      // state itself isn't fully dead — kept alive by those other callers.
      const gate = gateAccountState(companyData?.account_state as AccountState | null | undefined)
      if (gate.kind === 'redirect') {
        setLoading(false)
        if (gate.reason === 'configuring') {
          // Stay authed — user must complete activation.
          window.location.href = gate.href
          return
        }
        if (gate.reason === 'suspended') {
          // B66.5.2: stay authed — /account-suspended needs the session.
          window.location.href = gate.href
          return
        }
        // 'cancelled' — terminal; bounce out + redirect.
        await supabase.auth.signOut()
        window.location.href = gate.href
        return
      }
      // B66.5.2: allow_with_banner (past_due) intentionally falls through
      // to the rest of the dispatch (bootstrap + redirectByRole). Portal
      // mount renders the PastDueBanner above content. Do not block here.

      if ((roleData.role === 'manager' || roleData.role === 'leasing_agent') && roleData.property?.length) {
        const propNames: string[] = Array.isArray(roleData.property) ? roleData.property : [roleData.property]
        const { data: propRows } = await supabase
          .from('properties')
          .select('is_active, pm_phone, pm_email, name')
          .in('name', propNames)
        const hasActive = (propRows || []).some((r: any) => r.is_active)
        if (!hasActive && (propRows || []).length > 0) {
          const anyProp = propRows![0]
          setLoading(false)
          await supabase.auth.signOut()
          setSuspendedCompany({
            display_name: anyProp.name,
            support_phone: anyProp.pm_phone || null,
            support_email: anyProp.pm_email || null,
            support_website: null,
            message: 'Your property access has been suspended. Please contact your property manager.',
          })
          return
        }
      }

      // B76: shared bootstrap. Was an inline block before extraction;
      // logic is byte-equivalent — same field resolution + platform_settings
      // fallback fetch + proposal_codes_summary lookup + applyTheme().
      await bootstrapCompanyContext(companyData as CompanyBootstrapRow)
    } else {
      // Admin path / no company association — helper clears the same 9 keys.
      await bootstrapCompanyContext(null)
    }

    setLoading(false)

    // Force-password-reset gate (2026-06-11 — self-reg fix).
    // user_roles.must_change_password (dbForce) is the AUTHORITATIVE
    // discriminator: set TRUE only by the temp-password paths via
    // set_must_change_password(email, true) (manager addResident,
    // admin add user, bulk-invite). Self-reg residents never call
    // that RPC → dbForce stays false → not forced.
    //
    // The prior metaForce half (user_metadata.force_password_reset)
    // produced a false positive: swift-handler stamps that flag on
    // EVERY create_user call (including self-reg via register/page.tsx).
    // Self-reg residents set their own password at signup; the metadata
    // flag misclassified them as needing a forced change. Dropped from
    // the OR. Nothing reads metaForce after this change, so the stale
    // flag is harmless (cleaning it up at the swift-handler root cause
    // is a separate low-priority tech-debt item).
    //
    // Bulk/manager/admin temp-password paths are UNCHANGED: they still
    // set must_change_password=true via the RPC; the login redirect
    // (line 47) still fires for them via dbForce.
    const forcePwReset = roleData.must_change_password === true

    // Commit 4 (2026-07-16) — version-aware modal predicate + soft-gate
    // branch retired. Consent is enforced HARD by the portal-layout gate
    // + /consent route: redirectByRole below sends the user to their
    // portal, whose layout.tsx server-checks hasCurrentConsents() and
    // redirects to /consent if anything is missing at current version.
    // Single enforcement path — no chance of the login predicate and the
    // portal predicate disagreeing.
    //
    // Force-password-change path preserved: redirectByRole short-circuits
    // to /change-password when forcePwReset is true, BEFORE any portal
    // is reached. The consent gate only fires on portal routes, so a
    // user routed to /change-password bypasses the consent check until
    // they've completed password change (then they hit their portal,
    // and the gate correctly fires there if they're unconsented).
    redirectByRole(roleData.role, forcePwReset)
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'380px', width:'100%' }}>

        <div style={{ marginBottom:'32px', textAlign:'center' }}>
          {logoFailed
            ? <div style={{ width:'80px', height:'80px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px', background:'#1e2535', color:'#C9A227', fontSize:'28px', fontWeight:'bold', display:'flex', alignItems:'center', justifyContent:'center' }}>A1</div>
            : <img src={resolvedLogo} alt={companyName || 'ShieldMyLot'} style={{ width:'80px', height:'80px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px' }} onError={() => setLogoFailed(true)} />
          }
          <h1 style={{ color:'#C9A227', fontSize:'26px', fontWeight:'bold', margin:'0' }}>{companyName || 'ShieldMyLot™'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Parking Management · Sign In</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px' }}>

          {error && (
            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 14px', marginBottom:'16px' }}>
              <p style={{ color:'#f44336', fontSize:'13px', margin:'0' }}>{error}</p>
            </div>
          )}

          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="you@example.com"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ marginBottom:'20px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="••••••••"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ textAlign: 'right', marginBottom: 14 }}>
            <a href="/forgot-password" style={{ color: '#C9A227', fontSize: 12, textDecoration: 'none' }}>
              Forgot password?
            </a>
          </div>

          {/* B213 — Turnstile widget. onVerify sets captchaToken; expiry
              + error callbacks clear it so Sign In re-disables. Submit
              button gates on captchaToken so user can't fire the call
              with no token (defense in depth alongside the handleLogin
              guard). */}
          <div style={{ marginBottom:'14px' }}>
            <TurnstileWidget ref={turnstileRef}
                             onVerify={setCaptchaToken}
                             onExpire={() => setCaptchaToken(null)}
                             onError={() => setCaptchaToken(null)} />
          </div>

          <button
            onClick={handleLogin}
            disabled={loading || !email || !password || !captchaToken}
            style={{ width:'100%', padding:'13px', background: (!email || !password || !captchaToken) ? '#555' : '#C9A227', color: (!email || !password || !captchaToken) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!email || !password || !captchaToken) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'12px' }}>Powered by ShieldMyLot</p>
      </div>

      {resolveFailed && (
        <div style={{ position:'fixed', inset:0, background:'#0f1117', zIndex:9999, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'24px', fontFamily:'Arial, sans-serif' }}>
          <div style={{ maxWidth:'420px', width:'100%', textAlign:'center' }}>
            <div style={{ width:'72px', height:'72px', borderRadius:'50%', background:'#1e1a0a', border:'2px solid #C9A227', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 24px', fontSize:'32px' }}>⚠️</div>
            <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0 0 8px' }}>We couldn&apos;t load your company</h1>
            <p style={{ color:'#888', fontSize:'13px', margin:'0 0 28px', lineHeight:'1.6' }}>
              Your sign-in succeeded, but we couldn&apos;t find a unique company record for{' '}
              <strong style={{ color:'#ccc' }}>{resolveFailed.companyName}</strong>. This is usually a name-mismatch
              issue (extra spaces or a duplicate). Contact <a href="mailto:support@shieldmylot.com" style={{ color:'#C9A227' }}>support@shieldmylot.com</a> and we&apos;ll fix it.
            </p>
            <a href={`mailto:support@shieldmylot.com?subject=${encodeURIComponent("Couldn't load company")}`}
              style={{ display:'block', width:'100%', padding:'13px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'14px', border:'none', borderRadius:'8px', marginBottom:'12px', textAlign:'center', textDecoration:'none', boxSizing:'border-box' }}>
              Contact support
            </a>
            <button
              onClick={() => { setResolveFailed(null); window.location.reload() }}
              style={{ width:'100%', padding:'13px', background:'#1e2535', color:'#aaa', fontWeight:'bold', fontSize:'14px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer' }}>
              Try signing in again
            </button>
          </div>
        </div>
      )}

      {suspendedCompany && (
        <div style={{ position:'fixed', inset:0, background:'#0f1117', zIndex:9999, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'24px', fontFamily:'Arial, sans-serif' }}>
          <div style={{ maxWidth:'420px', width:'100%', textAlign:'center' }}>
            <div style={{ width:'72px', height:'72px', borderRadius:'50%', background:'#1e1a0a', border:'2px solid #C9A227', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 24px', fontSize:'32px' }}>⚠️</div>
            <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0 0 8px' }}>Account Suspended</h1>
            <p style={{ color:'#888', fontSize:'13px', margin:'0 0 28px', lineHeight:'1.6' }}>
              {suspendedCompany.message
                ? suspendedCompany.message
                : <><strong style={{ color:'#ccc' }}>{suspendedCompany.display_name}</strong> has been deactivated.<br />Please contact your property management company to resolve this.</>}
            </p>

            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', marginBottom:'24px', textAlign:'left' }}>
              <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 14px', fontWeight:'bold' }}>Contact Information</p>
              {suspendedCompany.support_phone && (
                <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'10px' }}>
                  <span style={{ color:'#C9A227', fontSize:'16px' }}>📞</span>
                  <a href={`tel:${suspendedCompany.support_phone}`} style={{ color:'#ccc', fontSize:'14px', textDecoration:'none' }}>{suspendedCompany.support_phone}</a>
                </div>
              )}
              {suspendedCompany.support_email && (
                <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'10px' }}>
                  <span style={{ color:'#C9A227', fontSize:'16px' }}>✉️</span>
                  <a href={`mailto:${suspendedCompany.support_email}`} style={{ color:'#ccc', fontSize:'14px', textDecoration:'none' }}>{suspendedCompany.support_email}</a>
                </div>
              )}
              {suspendedCompany.support_website && (
                <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                  <span style={{ color:'#C9A227', fontSize:'16px' }}>🌐</span>
                  <a href={suspendedCompany.support_website.startsWith('http') ? suspendedCompany.support_website : 'https://' + suspendedCompany.support_website} target="_blank" rel="noopener noreferrer" style={{ color:'#ccc', fontSize:'14px', textDecoration:'none' }}>{suspendedCompany.support_website}</a>
                </div>
              )}
              {!suspendedCompany.support_phone && !suspendedCompany.support_email && !suspendedCompany.support_website && (
                <p style={{ color:'#666', fontSize:'13px', margin:'0' }}>No contact info on file. Please reach out directly to your property manager.</p>
              )}
            </div>

            <button
              onClick={() => setSuspendedCompany(null)}
              style={{ width:'100%', padding:'13px', background:'#1e2535', color:'#aaa', fontWeight:'bold', fontSize:'14px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer' }}
            >
              ← Back to Sign In
            </button>
          </div>
        </div>
      )}

      {/* Commit 4 (2026-07-16) — login-modal consent block removed.
          Enforcement is now the portal-layout gate + /consent route
          (Commits 3a/3b + Commit 2). Single enforcement path. */}
    </main>
  )
}