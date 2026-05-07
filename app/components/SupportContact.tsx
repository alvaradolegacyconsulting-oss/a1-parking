'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

type Role = 'admin' | 'company_admin' | 'manager' | 'leasing_agent' | 'driver' | 'resident'

type Contact = { name: string | null; email: string | null }

type Props = {
  role: Role | string
  company?: string | null
  managerName?: string | null
  managerEmail?: string | null
  style?: React.CSSProperties
}

const PLATFORM_SUPPORT = 'support@shieldmylot.com'

export default function SupportContact({ role, company, managerName, managerEmail, style }: Props) {
  const [admins, setAdmins] = useState<Contact[]>([])
  const [loaded, setLoaded] = useState(false)

  const needsAdmins = role === 'manager' || role === 'leasing_agent' || role === 'driver' || role === 'resident'

  useEffect(() => {
    if (!needsAdmins) { setLoaded(true); return }
    if (!company) { setLoaded(true); return }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('name, email')
        .eq('role', 'company_admin')
        .ilike('company', company)
        .order('email')
      if (cancelled) return
      setAdmins((data || []).map((r: any) => ({ name: r.name || null, email: r.email || null })))
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [role, company, needsAdmins])

  if (!loaded) return null

  const wrap: React.CSSProperties = {
    background: '#161b26',
    border: '1px solid #2a2f3d',
    borderRadius: 8,
    padding: '12px 14px',
    color: '#aaa',
    fontSize: 12,
    lineHeight: 1.6,
    ...style,
  }
  const link: React.CSSProperties = { color: '#C9A227', textDecoration: 'none' }

  if (role === 'admin') return null

  if (role === 'company_admin') {
    return (
      <div style={wrap}>
        Need help with ShieldMyLot? Contact{' '}
        <a href={`mailto:${PLATFORM_SUPPORT}`} style={link}>{PLATFORM_SUPPORT}</a>
      </div>
    )
  }

  const renderAdmins = () => {
    if (admins.length === 0) return <span>your administrator.</span>
    return (
      <>
        {admins.map((a, i) => {
          const label = a.name || a.email || 'administrator'
          return (
            <span key={i}>
              {a.email ? (
                <a href={`mailto:${a.email}`} style={link}>{label}{a.name && a.email ? ` (${a.email})` : ''}</a>
              ) : (
                <span>{label}</span>
              )}
              {i < admins.length - 1 ? '; ' : ''}
            </span>
          )
        })}
      </>
    )
  }

  if (role === 'manager' || role === 'leasing_agent' || role === 'driver') {
    return (
      <div style={wrap}>
        Need help? Contact your company administrator: {renderAdmins()}
      </div>
    )
  }

  if (role === 'resident') {
    const mgr = managerName || managerEmail
    return (
      <div style={wrap}>
        For questions about your vehicles, visitor passes, or account, contact your property manager
        {mgr ? (
          <>
            {' '}
            {managerEmail ? (
              <a href={`mailto:${managerEmail}`} style={link}>{managerName || managerEmail}</a>
            ) : (
              <span>{managerName}</span>
            )}
          </>
        ) : null}
        {' '}or your company administrator: {renderAdmins()}
      </div>
    )
  }

  return null
}
