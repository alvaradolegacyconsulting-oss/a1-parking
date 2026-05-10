'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { applyTheme } from '../lib/theme'
import { useResolvedLogo } from '../lib/logo'

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
  const [tosScrolled, setTosScrolled] = useState(false)
  const [tosChecked, setTosChecked] = useState(false)
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
    await supabase.from('user_roles').update({ tos_accepted_at: now }).ilike('email', pendingEmail)
    await supabase.from('audit_logs').insert([{ action: 'TOS_ACCEPTED', table_name: 'user_roles', new_values: { email: pendingEmail, accepted_at: now } }])
    redirectByRole(pendingRole, pendingForcePwReset)
  }

  async function handleLogin() {
    setLoading(true)
    setError('')

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
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
      setLoading(false)
      setError('No role assigned. Please contact your administrator to get access.')
      await supabase.auth.signOut()
      return
    }

    if (roleData.role !== 'admin' && roleData.company) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('id, is_active, logo_url, display_name, support_phone, support_email, support_website, tier, tier_type, theme')
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

      let platformData: any = null
      if (!companyData?.logo_url || !companyData?.display_name || !companyData?.support_phone || !companyData?.support_email || !companyData?.support_website || !companyData?.theme) {
        const { data: pd } = await supabase.from('platform_settings').select('*').eq('id', 1).single()
        platformData = pd
      }
      const logo = companyData?.logo_url || platformData?.default_logo_url
      const displayName = companyData?.display_name
      const theme = companyData?.theme || platformData?.default_theme || 'gold'
      const phone = companyData?.support_phone || platformData?.default_support_phone
      const email2 = companyData?.support_email || platformData?.default_support_email
      const website = companyData?.support_website || platformData?.default_support_website

      if (logo) localStorage.setItem('company_logo', logo)
      else localStorage.removeItem('company_logo')
      if (displayName) localStorage.setItem('company_name', displayName)
      else localStorage.removeItem('company_name')
      if (phone) localStorage.setItem('company_support_phone', phone)
      else localStorage.removeItem('company_support_phone')
      if (email2) localStorage.setItem('company_support_email', email2)
      else localStorage.removeItem('company_support_email')
      if (website) localStorage.setItem('company_support_website', website)
      else localStorage.removeItem('company_support_website')
      if (companyData?.tier) localStorage.setItem('company_tier', companyData.tier)
      else localStorage.removeItem('company_tier')
      if (companyData?.tier_type) {
        const canonicalTierType = companyData.tier_type === 'pm' ? 'property_management' : companyData.tier_type
        localStorage.setItem('company_tier_type', canonicalTierType)
      } else {
        localStorage.removeItem('company_tier_type')
      }
      localStorage.setItem('company_theme', theme)
      applyTheme()

      if (companyData?.id) {
        const { data: pc } = await supabase
          .from('proposal_codes_summary')
          .select('id, code, status, feature_overrides, redeemed_at, expires_at, client_name, client_email, notes')
          .eq('company_id', companyData.id)
          .eq('status', 'redeemed')
          .maybeSingle()
        if (pc) localStorage.setItem('company_proposal_code', JSON.stringify(pc))
        else localStorage.removeItem('company_proposal_code')
      } else {
        localStorage.removeItem('company_proposal_code')
      }
    } else {
      localStorage.removeItem('company_logo')
      localStorage.removeItem('company_name')
      localStorage.removeItem('company_support_phone')
      localStorage.removeItem('company_support_email')
      localStorage.removeItem('company_support_website')
      localStorage.removeItem('company_tier')
      localStorage.removeItem('company_tier_type')
      localStorage.removeItem('company_theme')
      localStorage.removeItem('company_proposal_code')
    }

    setLoading(false)

    const { data: { user: freshUser } } = await supabase.auth.getUser()
    // Belt + suspenders: honor either the user_metadata flag (legacy /
    // future Supabase admin path) OR the user_roles.must_change_password
    // column (set during manager/admin/company_admin temp-password creation).
    const metaForce = freshUser?.user_metadata?.force_password_reset === true
    const dbForce = roleData.must_change_password === true
    const forcePwReset = metaForce || dbForce

    if (!roleData.tos_accepted_at) {
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
            <h2 style={{ color:'#C9A227', fontSize:'20px', fontWeight:'bold', margin:'0 0 16px', textAlign:'center' }}>Terms of Service</h2>
            <div
              onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop <= el.clientHeight + 10) setTosScrolled(true) }}
              style={{ overflowY:'scroll', maxHeight:'300px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'16px', marginBottom:'16px', fontSize:'13px', lineHeight:'1.7', color:'#aaa' }}
            >
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>1. Platform Use</strong><br />ShieldMyLot™ is a parking management platform provided by Alvarado Legacy Consulting LLC for authorized users only. Unauthorized access or use is strictly prohibited.</p>
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>2. User Responsibilities</strong><br />Users are responsible for the accuracy of all data entered. Towing decisions are made by licensed operators, not the platform. You must not enter false or misleading information.</p>
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>3. Data Collection</strong><br />We collect email, vehicle, and activity data to provide the service. All data is stored securely and used solely for parking management purposes.</p>
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>4. Founding Member Pricing</strong><br />Subscribers onboarded prior to public launch are designated &apos;Founding Members&apos; and are entitled to the pricing in effect at the time of their initial subscription for the lifetime of their continuous subscription. Founding Member pricing does not transfer to new entities or business successors. Founding Member status is documented in writing by Provider and is non-revocable except for material breach of these Terms.</p>
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>5. Limitation of Liability</strong><br />Alvarado Legacy Consulting LLC is not liable for towing decisions, wrongful tow claims, or errors resulting from inaccurate data entry by platform users. The platform is provided as a management aid only.</p>
              <p style={{ margin:'0 0 14px' }}><strong style={{ color:'#C9A227' }}>6. Governing Law</strong><br />These terms are governed by the laws of the State of Texas. Any disputes shall be resolved in a court of competent jurisdiction in Texas.</p>
              <p style={{ margin:'0' }}><strong style={{ color:'#C9A227' }}>7. Contact</strong><br />Questions about ShieldMyLot? Contact support@shieldmylot.com.</p>
            </div>
            {!tosScrolled && <p style={{ color:'#555', fontSize:'11px', textAlign:'center', margin:'0 0 12px' }}>↓ Scroll to the bottom to enable the checkbox</p>}
            <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', cursor: tosScrolled ? 'pointer' : 'default', marginBottom:'16px' }}>
              <input type="checkbox" checked={tosChecked} disabled={!tosScrolled} onChange={e => setTosChecked(e.target.checked)}
                style={{ marginTop:'2px', accentColor:'#C9A227', cursor: tosScrolled ? 'pointer' : 'not-allowed' }} />
              <span style={{ color: tosScrolled ? '#aaa' : '#555', fontSize:'13px', lineHeight:'1.5' }}>I have read and agree to the Terms of Service</span>
            </label>
            <button onClick={acceptTos} disabled={!tosChecked || tosLoading}
              style={{ width:'100%', padding:'13px', background: !tosChecked ? '#555' : '#C9A227', color: !tosChecked ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: !tosChecked ? 'not-allowed' : 'pointer' }}>
              {tosLoading ? 'Please wait...' : 'Continue'}
            </button>
          </div>
        </div>
      )}
    </main>
  )
}