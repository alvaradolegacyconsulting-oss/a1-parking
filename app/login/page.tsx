'use client'
import { useState } from 'react'
import { supabase } from '../supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [logoFailed, setLogoFailed] = useState(false)

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
      setError('No role assigned. Please contact A1 Wrecker to get access.')
      await supabase.auth.signOut()
      return
    }

    if (roleData.role !== 'admin' && roleData.company) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('is_active')
        .ilike('name', roleData.company)
        .single()

      if (companyData && companyData.is_active === false) {
        setLoading(false)
        setError('Your account has been deactivated. Contact A1 Wrecker, LLC at a1wreckerllc.net')
        await supabase.auth.signOut()
        return
      }
    }

    setLoading(false)

   if (roleData.role === 'admin') {
      window.location.href = '/'
    } else if (roleData.role === 'company_admin') {
      window.location.href = '/company_admin'
    } else if (roleData.role === 'manager') {
      window.location.href = '/manager'
    } else if (roleData.role === 'leasing_agent') {
      window.location.href = '/manager'
    } else if (roleData.role === 'driver') {
      window.location.href = '/driver'
    } else if (roleData.role === 'resident') {
      window.location.href = '/resident'
    } else {
      window.location.href = '/'
    }
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'380px', width:'100%' }}>

        <div style={{ marginBottom:'32px', textAlign:'center' }}>
          {logoFailed
            ? <div style={{ width:'80px', height:'80px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px', background:'#1e2535', color:'#C9A227', fontSize:'28px', fontWeight:'bold', display:'flex', alignItems:'center', justifyContent:'center' }}>A1</div>
            : <img src="/logo.jpeg" alt="A1 Wrecker" style={{ width:'80px', height:'80px', borderRadius:'12px', border:'2px solid #C9A227', marginBottom:'12px' }} onError={() => setLogoFailed(true)} />
          }
          <h1 style={{ color:'#C9A227', fontSize:'26px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
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
          <a href="/visitor" style={{ color:'#C9A227', fontSize:'12px', textDecoration:'none' }}>
            Visitor? Get a parking pass here →
          </a>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'12px' }}>A1 Wrecker, LLC · Parking Management Platform</p>
      </div>
    </main>
  )
}