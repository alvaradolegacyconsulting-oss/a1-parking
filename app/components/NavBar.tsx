'use client'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '../supabase'

const NAV_LINKS: Record<string, { label: string; href: string }[]> = {
  admin: [
    { label: 'Home', href: '/' },
    { label: 'History', href: '/history' },
    { label: 'Manager', href: '/manager' },
    { label: 'Driver', href: '/driver' },
    { label: 'Company Admin', href: '/company_admin' },
    { label: 'Admin', href: '/admin' },
    { label: 'QR Codes', href: '/qr' },
  ],
  company_admin: [
    { label: 'Dashboard', href: '/company_admin' },
  ],
  manager: [
    { label: 'Dashboard', href: '/manager' },
  ],
  driver: [
    { label: 'Driver Portal', href: '/driver' },
  ],
  resident: [
    { label: 'My Account', href: '/resident' },
  ],
  leasing_agent: [
    { label: 'Dashboard', href: '/manager' },
  ],
}

export default function NavBar() {
  const pathname = usePathname()
  const [role, setRole] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)

  const hidden = pathname === '/login' || pathname === '/visitor' || pathname === '/visitor-select' || pathname.startsWith('/register')

  useEffect(() => {
    if (hidden) return
    setLoaded(false)
    async function load() {
      setCompanyLogo(localStorage.getItem('company_logo'))
      setCompanyName(localStorage.getItem('company_name'))
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoaded(true); return }
      const { data } = await supabase
        .from('user_roles').select('role, property').ilike('email', user.email!).single()
      const userRole = data?.role ?? null
      setRole(userRole)
      setEmail(user.email!)
      if ((userRole === 'manager' || userRole === 'leasing_agent') && data?.property) {
        const { count } = await supabase
          .from('vehicles')
          .select('id', { count: 'exact', head: true })
          .ilike('property', data.property)
          .eq('status', 'pending')
        setPendingCount(count ?? 0)
      }
      setLoaded(true)
    }
    load()
  }, [pathname, hidden])

  if (hidden || !loaded || !role || !email) return null

  const links = NAV_LINKS[role] || []

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const isActive = (href: string) => pathname === href

  return (
    <nav style={{ background: '#1A1F2E', borderBottom: '1px solid #2a2f3d', fontFamily: 'Arial, sans-serif', position: 'sticky', top: 0, zIndex: 50 }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 16px' }}>

        {/* Main row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '52px' }}>

          {/* Logo + brand */}
          <a href={links[0]?.href ?? '/'} style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
            <img src={companyLogo || '/logo.jpeg'} alt={companyName || 'A1 Wrecker'} style={{ width: '30px', height: '30px', borderRadius: '6px', border: '1px solid #C9A227' }} />
            <span style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '13px', letterSpacing: '0.02em' }}>{companyName || 'A1 Wrecker'}</span>
          </a>

          {/* Desktop nav links */}
          <div className="hidden md:flex" style={{ alignItems: 'center', gap: '2px' }}>
            {links.map(l => (
              <a key={l.href} href={l.href} style={{
                padding: '6px 10px',
                color: isActive(l.href) ? '#C9A227' : '#888',
                fontSize: '12px',
                fontWeight: isActive(l.href) ? 'bold' : 'normal',
                textDecoration: 'none',
                borderRadius: '6px',
                background: isActive(l.href) ? 'rgba(201,162,39,0.12)' : 'transparent',
                transition: 'color 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}>
                {l.label}
                {l.href === '/manager' && pendingCount > 0 && (
                  <span style={{ background: '#B71C1C', color: 'white', borderRadius: '10px', fontSize: '9px', padding: '1px 6px', fontWeight: 'bold', lineHeight: '1.4' }}>{pendingCount}</span>
                )}
              </a>
            ))}
          </div>

          {/* Desktop: email + sign out */}
          <div className="hidden md:flex" style={{ alignItems: 'center', gap: '10px' }}>
            <span style={{ color: '#555', fontSize: '11px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
            <button onClick={signOut} style={{
              padding: '5px 12px', background: '#1e2535', color: '#aaa',
              border: '1px solid #3a4055', borderRadius: '6px', cursor: 'pointer',
              fontSize: '11px', fontFamily: 'Arial',
            }}>
              Sign Out
            </button>
          </div>

          {/* Mobile hamburger */}
          <button onClick={() => setMenuOpen(o => !o)} className="md:hidden" style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#C9A227', fontSize: '20px', lineHeight: 1, padding: '4px 8px',
          }}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="md:hidden" style={{ borderTop: '1px solid #2a2f3d', paddingBottom: '12px' }}>
            {links.map(l => (
              <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '11px 8px',
                color: isActive(l.href) ? '#C9A227' : '#aaa',
                fontWeight: isActive(l.href) ? 'bold' : 'normal',
                fontSize: '13px', textDecoration: 'none',
                borderBottom: '1px solid #1e2535',
              }}>
                {l.label}
                {l.href === '/manager' && pendingCount > 0 && (
                  <span style={{ background: '#B71C1C', color: 'white', borderRadius: '10px', fontSize: '10px', padding: '1px 7px', fontWeight: 'bold', lineHeight: '1.4' }}>{pendingCount}</span>
                )}
              </a>
            ))}
            <div style={{ padding: '10px 8px 0' }}>
              <p style={{ color: '#555', fontSize: '11px', margin: '0 0 8px' }}>{email}</p>
              <button onClick={signOut} style={{
                width: '100%', padding: '10px', background: '#1e2535', color: '#aaa',
                border: '1px solid #3a4055', borderRadius: '6px', cursor: 'pointer',
                fontSize: '13px', fontFamily: 'Arial', textAlign: 'left',
              }}>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  )
}
