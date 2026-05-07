'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useResolvedLogo } from '../lib/logo'

const inp: React.CSSProperties = { display:'block', width:'100%', marginTop:'6px', marginBottom:'14px', padding:'11px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box', fontFamily:'Arial' }
const lbl: React.CSSProperties = { color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }

export default function ChangePassword() {
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [logoFailed, setLogoFailed] = useState(false)
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const resolvedLogo = useResolvedLogo(companyLogo)

  useEffect(() => {
    setCompanyLogo(localStorage.getItem('company_logo'))
    setCompanyName(localStorage.getItem('company_name'))
  }, [])

  async function submit() {
    setError('')
    if (newPw.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return }
    setLoading(true)

    const { error: pwErr } = await supabase.auth.updateUser({ password: newPw })
    if (pwErr) { setError(pwErr.message); setLoading(false); return }

    await supabase.auth.updateUser({ data: { force_password_reset: false } })

    const { data: { user } } = await supabase.auth.getUser()
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .ilike('email', user?.email || '')
      .single()

    setLoading(false)
    const role = roleData?.role
    if (role === 'admin') window.location.href = '/'
    else if (role === 'company_admin') window.location.href = '/company_admin'
    else if (role === 'manager' || role === 'leasing_agent') window.location.href = '/manager'
    else if (role === 'driver') window.location.href = '/driver'
    else if (role === 'resident') window.location.href = '/resident'
    else window.location.href = '/'
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'380px', width:'100%' }}>

        <div style={{ marginBottom:'32px', textAlign:'center' }}>
          {logoFailed
            ? <div style={{ width:'72px', height:'72px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px', background:'#1e2535', color:'#C9A227', fontSize:'22px', fontWeight:'bold', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>SML</div>
            : <img src={resolvedLogo} alt={companyName || 'ShieldMyLot'} style={{ width:'72px', height:'72px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px', display:'block', margin:'0 auto 12px' }} onError={() => setLogoFailed(true)} />
          }
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0 0 6px' }}>Set Your Password</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'0', lineHeight:'1.6' }}>Welcome! Please set a new password before continuing.</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px' }}>
          {error && (
            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 14px', marginBottom:'16px' }}>
              <p style={{ color:'#f44336', fontSize:'13px', margin:'0' }}>{error}</p>
            </div>
          )}

          <label style={lbl}>New Password (min 8 characters)</label>
          <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} placeholder="••••••••" style={inp} />

          <label style={lbl}>Confirm New Password</label>
          <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} placeholder="••••••••" style={inp} />

          <button onClick={submit} disabled={loading || !newPw || !confirmPw}
            style={{ width:'100%', padding:'13px', background: (!newPw || !confirmPw) ? '#555' : '#C9A227', color: (!newPw || !confirmPw) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!newPw || !confirmPw) ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Saving...' : 'Set Password & Continue'}
          </button>
        </div>
      </div>
    </main>
  )
}
