'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useResolvedLogo } from '../lib/logo'
// B65.2: account_state gate. Login dispatch is the primary stop for non-active
// states (CA portal entry has the same gate as defense in depth).
import { gateAccountState, AccountState } from '../lib/account-state'
// B76: shared bootstrap — same helper used by /signup/redeem/verify
// after activation so the post-activation dashboard isn't stuck with
// null localStorage + 'Legacy Enforcement' fallback rendering.
import { bootstrapCompanyContext, CompanyBootstrapRow } from '../lib/company-bootstrap'
// B118: version-aware modal predicate + accept_tos(versions) call.
import { TOS_VERSION, PRIVACY_VERSION } from '../lib/legal-versions'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [logoFailed, setLogoFailed] = useState(false)
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const resolvedLogo = useResolvedLogo(companyLogo)
  const [showTosModal, setShowTosModal] = useState(false)
  const [tosChecked, setTosChecked] = useState(false)
  const [privacyChecked, setPrivacyChecked] = useState(false)
  const [tosLoading, setTosLoading] = useState(false)
  const [pendingRole, setPendingRole] = useState('')
  const [pendingEmail, setPendingEmail] = useState('')
  const [pendingForcePwReset, setPendingForcePwReset] = useState(false)
  const [suspendedCompany, setSuspendedCompany] = useState<{ display_name: string; support_phone: string | null; support_email: string | null; support_website: string | null; message?: string } | null>(null)

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

  async function acceptTos() {
    setTosLoading(true)
    const now = new Date().toISOString()
    // B118: version-aware accept_tos call. RPC atomically writes
    // tos_acceptances rows (tos + privacy) + stamps user_roles
    // tos_accepted_at + tos_accepted_version + privacy_accepted_version
    // — so the modal correctly suppresses on subsequent logins until
    // either TOS_VERSION or PRIVACY_VERSION bumps (at which point it
    // re-fires per the predicate at line ~205).
    //
    // SECURITY DEFINER + GRANT TO authenticated only. Graceful degrade
    // preserved: if RPC fails, log and continue — user re-sees modal
    // next login, which is not catastrophic.
    const { error: tosErr } = await supabase.rpc('accept_tos', {
      p_tos_version: TOS_VERSION,
      p_privacy_version: PRIVACY_VERSION,
    })
    if (tosErr) console.error('accept_tos RPC failed:', tosErr)
    await supabase.from('audit_logs').insert([{
      action: 'TOS_ACCEPTED',
      table_name: 'user_roles',
      new_values: { email: pendingEmail, accepted_at: now, tos_version: TOS_VERSION, privacy_version: PRIVACY_VERSION },
    }])
    redirectByRole(pendingRole, pendingForcePwReset)
  }

  async function handleLogin() {
    setLoading(true)
    setError('')

    // B65.4: capture authData so the recovery branch below can read
    // user_metadata.proposal_code + email_confirmed_at off the signed-in user.
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) {
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
      const { data: companyData } = await supabase
        .from('companies')
        .select('id, is_active, logo_url, display_name, support_phone, support_email, support_website, tier, tier_type, theme, account_state')
        .ilike('name', roleData.company)
        .single()

      if (companyData && companyData.is_active === false) {
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

      // B65.2: account_state gate (spec §3.4). All existing companies were
      // backfilled to 'active' in B65.1, so no current user hits the non-allow
      // branches. Wired now so B65.4's atomic activation can produce the
      // 'configuring' state and have a real landing target.
      const gate = gateAccountState(companyData?.account_state as AccountState | null | undefined)
      if (gate.kind === 'redirect') {
        setLoading(false)
        if (gate.reason === 'configuring') {
          // Don't sign out — user must stay authed to finish activation.
          window.location.href = gate.href
          return
        }
        // 'cancelled' — bounce out of the session and hand off to the
        // contact-support route.
        await supabase.auth.signOut()
        window.location.href = gate.href
        return
      }
      if (gate.kind === 'allow_with_banner') {
        // 'suspended' — mirror the existing is_active=false UX with a
        // different message. The CA portal's banner is the secondary layer
        // for sessions that bypass login.
        setLoading(false)
        await supabase.auth.signOut()
        setSuspendedCompany({
          display_name: companyData?.display_name || 'Your Company',
          support_phone: companyData?.support_phone || null,
          support_email: companyData?.support_email || null,
          support_website: companyData?.support_website || null,
          message: 'Your account has been suspended. Please contact support to resolve this.',
        })
        return
      }

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

    const { data: { user: freshUser } } = await supabase.auth.getUser()
    // Belt + suspenders: honor either the user_metadata flag (legacy /
    // future Supabase admin path) OR the user_roles.must_change_password
    // column (set during manager/admin/company_admin temp-password creation).
    const metaForce = freshUser?.user_metadata?.force_password_reset === true
    const dbForce = roleData.must_change_password === true
    const forcePwReset = metaForce || dbForce

    // B118: version-aware modal predicate. Modal fires when:
    //   • User has never consented (legacy blanket-existence check), OR
    //   • Stored tos_accepted_version is missing/stale vs current TOS_VERSION, OR
    //   • Stored privacy_accepted_version is missing/stale vs current PRIVACY_VERSION
    // This correctly re-fires on doc version bumps + fires for B113
    // bulk-uploaded users + suppresses for B118-signed-up users whose
    // accept_signup_consents() RPC populated all three columns at signup.
    const needsConsent = !roleData.tos_accepted_at
      || roleData.tos_accepted_version !== TOS_VERSION
      || roleData.privacy_accepted_version !== PRIVACY_VERSION
    if (needsConsent) {
      setPendingRole(roleData.role)
      setPendingEmail(email.trim())
      setPendingForcePwReset(forcePwReset)
      setShowTosModal(true)
      return
    }

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

          <button
            onClick={handleLogin}
            disabled={loading || !email || !password}
            style={{ width:'100%', padding:'13px', background: (!email || !password) ? '#555' : '#C9A227', color: (!email || !password) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!email || !password) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

        </div>

        <div style={{ marginTop:'16px', textAlign:'center' }}>
          <a href="/visitor-select" style={{ color:'#C9A227', fontSize:'12px', textDecoration:'none' }}>
            Visitor? Get a parking pass here →
          </a>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'12px' }}>Powered by ShieldMyLot</p>
      </div>

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

      {showTosModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'16px', padding:'28px', maxWidth:'480px', width:'100%', display:'flex', flexDirection:'column' }}>
            <h2 style={{ color:'#C9A227', fontSize:'20px', fontWeight:'bold', margin:'0 0 12px', textAlign:'center' }}>Terms of Service &amp; Privacy Policy</h2>
            {/* B118: replaced the inline scroll-to-bottom ToS prose with a
                link-out pattern matching /signup commit 2. The user reviews
                each document in a new tab (full text lives at /terms and
                /privacy — single source of truth) and checks both boxes
                to acknowledge. Same legal effect (clickwrap with
                affirmative action); cleaner maintenance when wording bumps. */}
            <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.6', margin:'0 0 18px', textAlign:'center' }}>
              Please review and agree to both documents to continue.
            </p>
            <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', cursor:'pointer', marginBottom:'10px' }}>
              <input type="checkbox" checked={tosChecked} onChange={e => setTosChecked(e.target.checked)}
                style={{ marginTop:'3px', accentColor:'#C9A227', cursor:'pointer' }} />
              <span style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.5' }}>
                I have read and agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color:'#C9A227', textDecoration:'underline' }}>Terms of Service</a>
                .
              </span>
            </label>
            <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', cursor:'pointer', marginBottom:'16px' }}>
              <input type="checkbox" checked={privacyChecked} onChange={e => setPrivacyChecked(e.target.checked)}
                style={{ marginTop:'3px', accentColor:'#C9A227', cursor:'pointer' }} />
              <span style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.5' }}>
                I have read and agree to the{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color:'#C9A227', textDecoration:'underline' }}>Privacy Policy</a>
                .
              </span>
            </label>
            <button onClick={acceptTos} disabled={!tosChecked || !privacyChecked || tosLoading}
              style={{ width:'100%', padding:'13px', background: (!tosChecked || !privacyChecked) ? '#555' : '#C9A227', color: (!tosChecked || !privacyChecked) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!tosChecked || !privacyChecked) ? 'not-allowed' : 'pointer' }}>
              {tosLoading ? 'Please wait...' : 'Continue'}
            </button>
          </div>
        </div>
      )}
    </main>
  )
}