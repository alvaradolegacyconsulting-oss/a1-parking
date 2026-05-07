'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

type Role = 'admin' | 'company_admin' | 'manager' | 'leasing_agent' | 'driver' | 'resident'

type Props = {
  role: Role | string
  company?: string | null
  managerName?: string | null
  managerEmail?: string | null
  style?: React.CSSProperties
}

const PLATFORM_SUPPORT = 'support@shieldmylot.com'

export default function SupportContact({ role, company, managerName, managerEmail, style }: Props) {
  const [adminEmails, setAdminEmails] = useState<string[]>([])
  const [queryErrored, setQueryErrored] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const needsAdmins = role === 'manager' || role === 'leasing_agent' || role === 'driver' || role === 'resident'

  useEffect(() => {
    if (!needsAdmins) { setLoaded(true); return }
    if (!company) { setLoaded(true); return }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .rpc('get_company_admin_emails', { target_company: company })
      if (cancelled) return
      if (error) {
        console.error('[SupportContact] get_company_admin_emails RPC failed:', error)
        setQueryErrored(true)
        setLoaded(true)
        return
      }
      const emails = ((data as { email: string | null }[] | null) || [])
        .map(r => r.email)
        .filter((e): e is string => !!e)
        .sort((a: string, b: string) => a.localeCompare(b))
      setAdminEmails(emails)
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
  const labelCol: React.CSSProperties = { color: '#888', fontWeight: 600 }

  if (role === 'admin') return null

  if (role === 'company_admin') {
    return (
      <div style={wrap}>
        Need help with ShieldMyLot? Contact{' '}
        <a href={`mailto:${PLATFORM_SUPPORT}`} style={link}>{PLATFORM_SUPPORT}</a>
      </div>
    )
  }

  const adminFallback = <span>your administrator.</span>
  const hasAdmins = adminEmails.length > 0

  if (role === 'manager' || role === 'leasing_agent' || role === 'driver') {
    if (!hasAdmins) {
      return <div style={wrap}>Need help? Contact {adminFallback}</div>
    }
    if (adminEmails.length === 1) {
      return (
        <div style={wrap}>
          Need help? Contact your company administrator at{' '}
          <a href={`mailto:${adminEmails[0]}`} style={link}>{adminEmails[0]}</a>
        </div>
      )
    }
    return (
      <div style={wrap}>
        <div style={{ marginBottom: 4 }}>Need help? Contact your company administrator:</div>
        {adminEmails.map(email => (
          <div key={email} style={{ marginLeft: 8 }}>
            <a href={`mailto:${email}`} style={link}>{email}</a>
          </div>
        ))}
      </div>
    )
  }

  if (role === 'resident') {
    const showPm = !!managerEmail || !!managerName
    return (
      <div style={wrap}>
        <div style={{ marginBottom: 6 }}>
          For questions about your vehicles, visitor passes, or account, contact:
        </div>
        {showPm && (
          <div style={{ marginLeft: 8, marginBottom: 4 }}>
            <span style={labelCol}>Property Manager:</span>{' '}
            {managerEmail ? (
              <>
                {managerName ? `${managerName} at ` : ''}
                <a href={`mailto:${managerEmail}`} style={link}>{managerEmail}</a>
              </>
            ) : (
              <span>{managerName}</span>
            )}
          </div>
        )}
        {hasAdmins ? (
          adminEmails.map(email => (
            <div key={email} style={{ marginLeft: 8 }}>
              <span style={labelCol}>Company Administrator:</span>{' '}
              <a href={`mailto:${email}`} style={link}>{email}</a>
            </div>
          ))
        ) : (
          !showPm && <div style={{ marginLeft: 8 }}>{adminFallback}</div>
        )}
        {queryErrored && !showPm && !hasAdmins && (
          <div style={{ marginLeft: 8 }}>{adminFallback}</div>
        )}
      </div>
    )
  }

  return null
}
