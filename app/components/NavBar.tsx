'use client'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '../supabase'
import { applyTheme, getThemeColor } from '../lib/theme'
import { useResolvedLogo } from '../lib/logo'

// B85: Help link appended as last item across every role. Help center is
// public (no auth required for the help pages themselves), but the NavBar
// link is visible to authenticated users too as a navigation aid.
const NAV_LINKS: Record<string, { label: string; href: string }[]> = {
  admin: [
    // B228 Phase 1 — admin NavBar trimmed to the super-admin decision
    // surface. Role-portal links (Manager / Driver / Company Admin /
    // History) removed — admin shouldn't be cosplaying as another role
    // in the primary nav. Admin still has direct-URL access to those
    // portals during the deploy window if needed for support work.
    //
    // Console = the new B228 super-admin surface (CRM + usage + cost +
    // health). Admin (legacy) = the existing /admin (CRUD + bulk +
    // pricing + audit) which COEXISTS until later phases migrate its
    // tools into the Console's tabs. Both linked here during the
    // transition.
    { label: 'Console', href: '/admin_console' },
    { label: 'Admin (legacy)', href: '/admin' },
    { label: 'Proposals', href: '/admin/proposal-codes' },
    { label: 'QR Codes', href: '/qr' },
    { label: 'Help', href: '/help' },
  ],
  company_admin: [
    { label: 'Dashboard', href: '/company_admin' },
    { label: 'Help', href: '/help' },
  ],
  manager: [
    { label: 'Dashboard', href: '/manager' },
    { label: 'Help', href: '/help' },
  ],
  driver: [
    { label: 'Driver Portal', href: '/driver' },
    { label: 'Help', href: '/help' },
  ],
  resident: [
    { label: 'My Account', href: '/resident' },
    { label: 'Help', href: '/help' },
  ],
  leasing_agent: [
    { label: 'Dashboard', href: '/manager' },
    { label: 'Help', href: '/help' },
  ],
}

export default function NavBar() {
  const pathname = usePathname()
  const [role, setRole] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  // pendingDisputeCount state removed 2026-06-24 (B210)
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const resolvedLogo = useResolvedLogo(companyLogo)

  // B65.2: /signup (public placeholder) and /signup/redeem* (B65.3+ auth flow)
  // are pre-portal surfaces — hide NavBar so authenticated users browsing back
  // to them don't see their portal nav. /account-cancelled is the gate target
  // for cancelled accounts; hide nav there too.
  const hidden = pathname === '/login' || pathname === '/visitor' || pathname === '/visitor-select'
    || pathname.startsWith('/register')
    || pathname.startsWith('/signup')
    || pathname === '/account-cancelled'

  useEffect(() => {
    if (hidden) return
    setLoaded(false)
    async function load() {
      applyTheme()
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
        // B210 (2026-06-24): dispute_requests pending-count query removed.
        // Single-table query now; Promise.all collapsed to the bare vehicles count.
        const { count: vCount } = await supabase
          .from('vehicles').select('id', { count: 'exact', head: true })
          .ilike('property', data.property).eq('status', 'pending')
        setPendingCount(vCount ?? 0)
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
  const themeColor = getThemeColor()

  return (
    <nav style={{ background: '#1A1F2E', borderBottom: '1px solid #2a2f3d', fontFamily: 'Arial, sans-serif', position: 'sticky', top: 0, zIndex: 50 }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 16px' }}>

        {/* Main row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '52px' }}>

          {/* Logo + brand */}
          <a href={links[0]?.href ?? '/'} style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
            <img src={resolvedLogo} alt={companyName || 'ShieldMyLot'} style={{ width: '30px', height: '30px', borderRadius: '6px', border: `1px solid ${themeColor}` }} />
            <span style={{ color: themeColor, fontWeight: 'bold', fontSize: '13px', letterSpacing: '0.02em' }}>{companyName || 'ShieldMyLot'}</span>
          </a>

          {/* Desktop nav links */}
          <div className="hidden md:flex" style={{ alignItems: 'center', gap: '2px' }}>
            {links.map(l => (
              <a key={l.href} href={l.href} style={{
                padding: '6px 10px',
                color: isActive(l.href) ? themeColor : '#888',
                fontSize: '12px',
                fontWeight: isActive(l.href) ? 'bold' : 'normal',
                textDecoration: 'none',
                borderRadius: '6px',
                background: isActive(l.href) ? `${themeColor}1f` : 'transparent',
                transition: 'color 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}>
                {l.label}
                {l.href === '/manager' && pendingCount > 0 && (
                  <span style={{ background: '#B71C1C', color: 'white', borderRadius: '10px', fontSize: '9px', padding: '1px 6px', fontWeight: 'bold', lineHeight: '1.4' }}>{pendingCount}</span>
                )}
                {/* B210 (2026-06-24): dispute count badge removed */}
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
            color: themeColor, fontSize: '20px', lineHeight: 1, padding: '4px 8px',
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
                color: isActive(l.href) ? themeColor : '#aaa',
                fontWeight: isActive(l.href) ? 'bold' : 'normal',
                fontSize: '13px', textDecoration: 'none',
                borderBottom: '1px solid #1e2535',
              }}>
                {l.label}
                {l.href === '/manager' && pendingCount > 0 && (
                  <span style={{ background: '#B71C1C', color: 'white', borderRadius: '10px', fontSize: '10px', padding: '1px 7px', fontWeight: 'bold', lineHeight: '1.4' }}>{pendingCount}</span>
                )}
                {/* B210 (2026-06-24): mobile dispute count badge removed */}
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
