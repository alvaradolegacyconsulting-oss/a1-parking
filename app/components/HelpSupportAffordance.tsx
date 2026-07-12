'use client'
// /help contact affordance — role-conditional support.
//
// Delegation model (per 2026-07-12 /help gate spec, Option A):
//   admin → local branch → mailto:support@shieldmylot.com (SupportContact
//     returns null for admin; /help still needs a contact for supers).
//   everything else → delegate to <SupportContact/>, which owns the
//     routing table. Residents get PM + CA (β) via a residents→properties
//     lookup done here so SupportContact's props match the resident portal.
//
// Missing residents row (unactivated, race, self-registration in-flight)
// → PM info stays null; SupportContact's resident branch degrades to
// CA-only. Graceful path, no crash, no support@ leak.

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import SupportContact from './SupportContact'

const PLATFORM_SUPPORT = 'support@shieldmylot.com'

type Role = 'admin' | 'company_admin' | 'manager' | 'leasing_agent' | 'driver' | 'resident'

type State =
  | { kind: 'loading' }
  | { kind: 'admin' }
  | { kind: 'delegate'; role: Role; company: string | null; managerName: string | null; managerEmail: string | null }
  | { kind: 'text-fallback' }

type Props = {
  linkText: string       // e.g. "Contact support" (footer) or "contact support" (mid-sentence)
  fallbackText: string   // e.g. "Contact your company administrator" (no trailing period; component adds it)
  style?: React.CSSProperties
}

export default function HelpSupportAffordance({ linkText, fallbackText, style }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (cancelled) return
      if (!user) { setState({ kind: 'text-fallback' }); return }

      const { data: role } = await supabase
        .from('user_roles').select('role, company').ilike('email', user.email!).single()
      if (cancelled) return
      if (!role) { setState({ kind: 'text-fallback' }); return }

      const r = role.role as Role
      if (r === 'admin') { setState({ kind: 'admin' }); return }

      let managerName: string | null = null
      let managerEmail: string | null = null
      if (r === 'resident') {
        const { data: residentRow } = await supabase
          .from('residents').select('property').ilike('email', user.email!).limit(1).maybeSingle()
        if (cancelled) return
        if (residentRow?.property) {
          const { data: propRow } = await supabase
            .from('properties').select('pm_name, pm_email').ilike('name', residentRow.property).maybeSingle()
          if (cancelled) return
          managerName  = propRow?.pm_name  ?? null
          managerEmail = propRow?.pm_email ?? null
        }
      }

      setState({ kind: 'delegate', role: r, company: role.company, managerName, managerEmail })
    })()
    return () => { cancelled = true }
  }, [])

  if (state.kind === 'loading') return null  // no wrong-address flash

  if (state.kind === 'admin') {
    return <><a href={`mailto:${PLATFORM_SUPPORT}`} style={style}>{linkText}</a>.</>
  }

  if (state.kind === 'text-fallback') {
    return <span style={style}>{fallbackText}.</span>
  }

  return (
    <SupportContact
      role={state.role}
      company={state.company}
      managerName={state.managerName}
      managerEmail={state.managerEmail}
    />
  )
}
