'use client'
// B113 — first-login force-reset landing for bulk-uploaded users.
// Companion to /reset-password (B99) with three important differences:
//
//   (1) Auth source: Supabase Auth invite (inviteUserByEmail) instead
//       of password-reset email. Both flows mint a session via the
//       URL hash on landing (detectSessionInUrl=true); architecturally
//       same from this page's perspective.
//
//   (2) Post-success: sign out + redirect to /login (NOT auto-login
//       like /reset-password). Reason: bulk-uploaded users have NULL
//       tos_accepted_at + NULL version columns on user_roles. The ToS
//       modal at /login is the only place the modal-decision flow
//       fires; auto-redirecting by role would bypass it entirely.
//       The credential-re-entry friction is the cost of not
//       duplicating B118 modal logic in this page. Counter-proposal
//       H.2 ("password reset FIRST, then ToS modal on next session")
//       accepted at greenlight.
//
//   (3) Clears must_change_password=true on user_roles via the
//       set_must_change_password SECURITY DEFINER RPC (B82 retrofit
//       grants EXECUTE TO authenticated only). Bulk-uploaded users
//       arrive with must_change_password=true set by the bulk-invite
//       flow (commit 2 work); clearing here avoids the post-login
//       /change-password redirect (line 36-37 of app/login/page.tsx)
//       since the user already set their password here.
//
// Graceful-degrade pattern matches /login's accept_tos() RPC call: if
// set_must_change_password fails, the user sees /change-password on
// next login + can set the same password again. Mild wart, not
// catastrophic.

import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { validatePassword } from '../lib/password-rules'

const GOLD = '#C9A227'

type Status =
  | { kind: 'loading' }
  | { kind: 'no_session' }
  | { kind: 'ready'; user: User }
  | { kind: 'updating' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }

export default function ResetPasswordRequired() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Detect the invite-minted session. Same shape as /reset-password +
  // /signup/verify: onAuthStateChange + getSession in parallel with 4s
  // fallback timeout. Supabase Auth invite sends a hash-fragment URL;
  // detectSessionInUrl=true (default) picks it up on mount.
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

    // Clear must_change_password flag so the next login doesn't
    // redirect to /change-password unnecessarily. Graceful degrade:
    // if the RPC fails, log + continue. The user just sees
    // /change-password on next login and sets the same password again.
    // SECURITY DEFINER RPC; authenticated-only per B82 retrofit.
    const email = status.user.email
    if (email) {
      const { error: clearErr } = await supabase.rpc('set_must_change_password', {
        p_email: email,
        p_value: false,
      })
      if (clearErr) console.error('set_must_change_password RPC failed:', clearErr)
    }

    setStatus({ kind: 'success' })

    // Sign out + redirect to /login. Forces the user through the
    // /login dispatch + B118 modal-decision flow so bulk-uploaded
    // users (who have NULL tos_accepted_at + NULL version columns)
    // get the ToS + Privacy modal fired on next session per H.2.
    // 700ms delay lets the success state flash briefly for UX feedback.
    setTimeout(async () => {
      await supabase.auth.signOut()
      window.location.href = '/login'
    }, 700)
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: 20 }}>
      <div style={{ maxWidth: 380, width: '100%' }}>

        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ color: GOLD, fontSize: 26, fontWeight: 'bold', margin: 0 }}>Welcome — set your password</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '6px 0 0' }}>ShieldMyLot™</p>
        </div>

        {status.kind === 'loading' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Verifying your invite link…</p>
          </div>
        )}

        {status.kind === 'no_session' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <h2 style={{ color: GOLD, fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>Invite link expired or invalid</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
              The invite link couldn&apos;t be verified. It may have expired (links are valid for a limited time) or already been used.
              Contact your administrator to send a new invite.
            </p>
            <a href="/login" style={{ display: 'inline-block', background: GOLD, color: '#0a0d14', borderRadius: 8, padding: '10px 16px', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Sign in</a>
          </div>
        )}

        {(status.kind === 'ready' || status.kind === 'updating' || status.kind === 'error') && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28 }}>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' }}>
              Set a new password for your account. You&apos;ll then be asked to sign in with the password you just chose.
            </p>
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
              {status.kind === 'updating' ? 'Setting password…' : 'Set password'}
            </button>
          </div>
        )}

        {status.kind === 'success' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#0d1f0d', border: '2px solid #2e7d32', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24 }}>✓</div>
            <h2 style={{ color: '#86efac', fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>Password set</h2>
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.6, margin: 0 }}>Redirecting you to sign in…</p>
          </div>
        )}

      </div>
    </main>
  )
}
