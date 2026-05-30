'use client'
// B99 — anonymous "set new password" landing. Supabase Auth's reset
// email redirects here with a PKCE code in the URL; the browser
// client auto-exchanges via detectSessionInUrl on mount. Once the
// session is live, the user enters a new password; on success we run
// gateAccountState (suspended/cancelled → bounce out cleanly) and
// dispatch by role to the correct portal.
//
// Auto-login after reset (pre-flight ask 15 — accepted lean): PKCE
// exchange already minted a session; a forced re-login adds friction
// without security benefit.
//
// must_change_password clearing on user_roles is deferred to a small
// follow-up commit (would require an authenticated UPDATE that current
// RLS doesn't permit + new helper). Until then, users whose admin had
// flagged force-change will still see /change-password on their next
// login after reset — they enter the just-set password again. Mild
// wart, not blocking.

import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { gateAccountState, AccountState } from '../lib/account-state'
import { validatePassword } from '../lib/password-rules'

const GOLD = '#C9A227'

type Status =
  | { kind: 'loading' }
  | { kind: 'no_session' }
  | { kind: 'ready'; user: User }
  | { kind: 'updating' }
  | { kind: 'success'; user: User }
  | { kind: 'error'; message: string }

function redirectByRole(role: string) {
  if (role === 'admin') window.location.href = '/'
  else if (role === 'company_admin') window.location.href = '/company_admin'
  else if (role === 'manager' || role === 'leasing_agent') window.location.href = '/manager'
  else if (role === 'driver') window.location.href = '/driver'
  else if (role === 'resident') window.location.href = '/resident'
  else window.location.href = '/'
}

export default function ResetPassword() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Detect the PKCE-minted session. Same pattern as /signup/redeem/verify
  // and /signup/verify: listen for onAuthStateChange + getSession in
  // parallel, with a 4s fallback for the no-session case.
  useEffect(() => {
    let resolved = false
    let cancelled = false

    function onUser(user: User | null) {
      if (resolved || cancelled) return
      if (!user) return
      resolved = true
      setStatus({ kind: 'ready', user })
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      onUser(session?.user ?? null)
    })
    supabase.auth.getSession().then(({ data }) => onUser(data.session?.user ?? null))

    const timeoutId = window.setTimeout(() => {
      if (!resolved && !cancelled) {
        resolved = true
        setStatus({ kind: 'no_session' })
      }
    }, 4000)

    return () => {
      cancelled = true
      subscription.unsubscribe()
      window.clearTimeout(timeoutId)
    }
  }, [])

  const pwErr = validatePassword(password)
  const matchErr = password && confirmPassword && password !== confirmPassword ? 'Passwords do not match.' : null
  const formOk = !pwErr && !matchErr && password.length > 0 && confirmPassword.length > 0

  async function submit() {
    if (status.kind !== 'ready' || !formOk) return
    setStatus({ kind: 'updating' })

    const { error: updErr } = await supabase.auth.updateUser({ password })
    if (updErr) {
      setStatus({ kind: 'error', message: updErr.message || 'Password update failed.' })
      return
    }

    setStatus({ kind: 'success', user: status.user })

    // Dispatch by role — same logic as /login. Run gateAccountState
    // for the user's company (if they have one) to handle the
    // suspended/cancelled cases cleanly.
    const { data: { user: freshUser } } = await supabase.auth.getUser()
    if (!freshUser) {
      window.location.href = '/login'
      return
    }
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role, company')
      .ilike('email', freshUser.email!)
      .single()
    if (!roleData) {
      // User without a role row — bounce to /login which has B65.4
      // recovery logic for mid-state signup users.
      window.location.href = '/login'
      return
    }

    if (roleData.role !== 'admin' && roleData.company) {
      const { data: companyData } = await supabase
        .from('companies')
        .select('account_state, is_active')
        .ilike('name', roleData.company)
        .single()
      if (companyData?.is_active === false) {
        await supabase.auth.signOut()
        window.location.href = '/login'
        return
      }
      // B66.5.2 audit note: this reset-password gate handling SURVIVED the
      // 4.3 gateAccountState contract change cleanly, unlike login/page.tsx
      // which needed a 3-arm refactor (B66.5.2 fix). Why this code is
      // correct under the new contract:
      //   • past_due (NEW allow_with_banner) → falls through (no kind
      //     handler) → redirectByRole → portal mount renders banner ✓
      //   • suspended (NEW redirect reason) → redirect branch fires,
      //     signOut conditional is FALSE (cancelled-only), so user stays
      //     authed for /account-suspended ✓
      //   • cancelled (unchanged) → redirect branch fires, signOut TRUE,
      //     bounce to /account-cancelled ✓
      //   • configuring (unchanged) → redirect branch fires, signOut FALSE,
      //     redirect to /signup/redeem/verify ✓
      //
      // The defensive `if (gate.reason === 'cancelled') signOut` pattern
      // is correct: terminal states sign out, recoverable states stay
      // authed. Login's pre-B66.5.2 broken pattern was the inverse — sign
      // out for everything-non-configuring — which conflated all non-
      // recoverable states with cancelled. See
      // [[pattern-defensive-conditional-signout-in-auth-flows]].
      const gate = gateAccountState(companyData?.account_state as AccountState | null | undefined)
      if (gate.kind === 'redirect') {
        if (gate.reason === 'cancelled') await supabase.auth.signOut()
        window.location.href = gate.href
        return
      }
    }

    setTimeout(() => redirectByRole(roleData.role), 700)
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 380, width: '100%' }}>

        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>Set a new password</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot™</p>
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Verifying your reset link…</p>
          </div>
        )}

        {status.kind === 'no_session' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>Reset link expired or invalid</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
              The reset link couldn&apos;t be verified. It may have expired (links are valid for a limited time) or already been used.
            </p>
            <a href="/forgot-password" style={{ display: 'inline-block', background: GOLD, color: '#0a0d14', borderRadius: 8, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 700, marginRight: 10 }}>Request a new link</a>
            <a href="/login" style={{ color: GOLD, fontSize: 12, textDecoration: 'none' }}>Sign in</a>
          </div>
        )}

        {(status.kind === 'ready' || status.kind === 'updating' || status.kind === 'error') && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            {status.kind === 'error' && (
              <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{status.message}</p>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>New password</label>
              <input type="password" autoComplete="new-password" value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
              {password && pwErr && <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>{pwErr}</p>}
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ color: '#aaa', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Confirm password</label>
              <input type="password" autoComplete="new-password" value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && formOk && submit()}
                placeholder="Re-enter password"
                style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 12px', fontSize: 13, background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, color: 'white', outline: 'none', boxSizing: 'border-box' }} />
              {matchErr && <p style={{ color: '#f44336', fontSize: 11, margin: '6px 0 0' }}>{matchErr}</p>}
            </div>
            <button onClick={submit} disabled={!formOk || status.kind === 'updating'}
              style={{ width: '100%', padding: 13, background: !formOk || status.kind === 'updating' ? '#555' : GOLD, color: !formOk || status.kind === 'updating' ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: 15, border: 'none', borderRadius: 8, cursor: !formOk || status.kind === 'updating' ? 'not-allowed' : 'pointer' }}>
              {status.kind === 'updating' ? 'Updating password…' : 'Set new password'}
            </button>
          </div>
        )}

        {status.kind === 'success' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>✓</div>
            <h2 style={{ color: '#86efac', fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>Password updated</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: 0 }}>Signing you in…</p>
          </div>
        )}

      </div>
    </main>
  )
}
