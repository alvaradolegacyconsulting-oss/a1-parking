'use client'
// Cascading Deactivation — role-scoped escalation screen.
//
// Lands here when /api/.../portal-gate determines effective-active is
// false. The ?role= param drives messaging: residents are routed to
// their PM, PMs to their CA, CAs to ShieldMyLot support, etc.
//
// This page is INTENTIONALLY public (added to middleware publicPaths)
// because the visitor here has just been redirected from an
// authenticated portal — their session may or may not be fully
// usable. The page itself doesn't expose any data; it shows messaging
// and a sign-out button.
//
// Reactivation auto-restore: the moment the deactivating party flips
// the relevant is_active flag back, the next portal mount's
// get_my_effective_active call returns true and the user is past the
// gate. No cache to clear, no second flag to flip.

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const GOLD = '#C9A227'
const BG = '#0a0d14'

type Role = 'resident' | 'manager' | 'leasing_agent' | 'company_admin' | 'driver' | 'admin' | 'unknown'

interface EscalationCopy {
  title: string
  body: string
  contact: string
}

function escalationFor(role: Role): EscalationCopy {
  switch (role) {
    case 'resident':
      return {
        title: 'Account access paused',
        body: 'Your resident account or your property has been deactivated. Contact your property manager to be reactivated.',
        contact: 'If you need help reaching your property manager, contact support@shieldmylot.com.',
      }
    case 'manager':
    case 'leasing_agent':
      return {
        title: 'Account access paused',
        body: 'Your account, your property assignment, or your company has been deactivated. Contact your company administrator (CA) to be reactivated.',
        contact: 'If you need help reaching your CA, contact support@shieldmylot.com.',
      }
    case 'driver':
      return {
        title: 'Account access paused',
        body: 'Your driver account or your company has been deactivated. Contact your company administrator (CA) to be reactivated.',
        contact: 'If you need help reaching your CA, contact support@shieldmylot.com.',
      }
    case 'company_admin':
      return {
        title: 'Account access paused',
        body: 'Your company administrator account or your company has been suspended/cancelled. Contact ShieldMyLot support to restore access.',
        contact: 'Contact support@shieldmylot.com to restore access.',
      }
    case 'admin':
      // Admin chain-point reaching this page is unusual (admin role
      // short-circuits the helper). Most likely a stale session post-
      // role-change. Show a generic message.
      return {
        title: 'Access check failed',
        body: 'Your platform-admin session could not be validated. Sign out and back in.',
        contact: 'If the issue persists, contact engineering.',
      }
    case 'unknown':
    default:
      return {
        title: 'Account access paused',
        body: 'Your access to the platform has been paused.',
        contact: 'Contact support@shieldmylot.com if you need help.',
      }
  }
}

export default function DeactivatedPage() {
  const [role, setRole] = useState<Role>('unknown')

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const r = (url.searchParams.get('role') ?? '').toLowerCase()
      const valid: Role[] = ['resident', 'manager', 'leasing_agent', 'company_admin', 'driver', 'admin']
      if (valid.includes(r as Role)) {
        setRole(r as Role)
      }
    } catch { /* SSR / malformed URL — fall through to 'unknown' */ }
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const copy = escalationFor(role)

  return (
    <main style={{ minHeight: '100vh', background: BG, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 420, width: '100%' }}>
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>{copy.title}</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot&trade;</p>
        </div>

        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#1e1a0a', border: `2px solid ${GOLD}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>⏸</div>
          <p style={{ color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 1.6, margin: '0 0 18px' }}>
            {copy.body}
          </p>
          <p style={{ color: '#666', fontSize: 12, textAlign: 'center', lineHeight: 1.5, margin: '0 0 22px' }}>
            {copy.contact}
          </p>
          <button onClick={signOut}
            style={{ width: '100%', padding: 13, background: GOLD, color: '#0f1117', fontWeight: 'bold', fontSize: 14, border: 'none', borderRadius: 8, cursor: 'pointer' }}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  )
}
