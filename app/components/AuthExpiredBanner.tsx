'use client'
// ══════════════════════════════════════════════════════════════════════
// AuthExpiredBanner — client-side consumer of supabase-fetch-
// interceptor events. Mount once in app/layout.tsx.
// ══════════════════════════════════════════════════════════════════════
//
// Two events, two behaviours (Mateo lock 2026-08-03):
//
//   supabase-auth-expired         → sign out, route to /login?reason=expired
//   supabase-refresh-rate-limited → show overlay with retry countdown, NO redirect
//                                   (redirect would trigger another refresh
//                                    which would trigger another 429)
//
// Also listens to supabase.auth.onAuthStateChange for SIGNED_IN /
// TOKEN_REFRESHED — those events clear the session-dead flag so
// the app is usable again without a hard reload.

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { markSessionAlive } from '../lib/supabase-fetch-interceptor'

const SKIP_PATHS = [
  '/login', '/signup', '/register', '/visitor', '/visitor-select', '/forgot-password',
  '/reset-password', '/auth/accept', '/terms', '/privacy', '/change-password',
  '/help', '/help/videos', '/deactivated', '/account-cancelled',
]

function shouldSkipCurrentPath(): boolean {
  if (typeof window === 'undefined') return true
  const path = window.location.pathname
  if (path === '/') return true
  return SKIP_PATHS.some(p => path === p || path.startsWith(p + '/'))
}

export default function AuthExpiredBanner() {
  const [rateLimited, setRateLimited] = useState<{ retryAfterSec: number | null } | null>(null)

  // ── SIGNED_IN / TOKEN_REFRESHED → clear session-dead flag ──────
  // Otherwise a user who signs back in after an expired-routing is
  // stuck against a dead flag until they hard-reload. The symptom
  // would be "the app silently does nothing" — the exact failure
  // mode this weekend has been eliminating.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        markSessionAlive()
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  // ── Route on auth-expired ──────────────────────────────────────
  // Skip on already-public paths (SKIP_PATHS) so a stale token
  // signalled while the user is already on /login doesn't
  // infinite-loop. Sign out to clear cookies + local session, then
  // redirect. Use window.location instead of router.push — a
  // full navigation guarantees the target page loads without any
  // stale React state from the failing surface.
  useEffect(() => {
    const onExpired = () => {
      if (shouldSkipCurrentPath()) {
        console.info('[AuthExpiredBanner] auth-expired on public path — ignoring', { path: window.location.pathname })
        return
      }
      console.error('[AuthExpiredBanner] auth-expired — signing out + routing to /login?reason=expired')
      // Sign out is best-effort (may itself 401 — that's fine, cookies
      // still get cleared by the client). Route regardless.
      supabase.auth.signOut().catch(err => {
        console.warn('[AuthExpiredBanner] signOut errored (ignoring)', err)
      }).finally(() => {
        window.location.href = '/login?reason=expired'
      })
    }
    window.addEventListener('supabase-auth-expired', onExpired)
    return () => window.removeEventListener('supabase-auth-expired', onExpired)
  }, [])

  // ── Show rate-limited overlay ──────────────────────────────────
  // No redirect. The overlay is what the user sees; they wait for
  // the countdown, then the overlay clears itself and normal
  // interaction resumes. Retry-after header hint used if present.
  useEffect(() => {
    const onRateLimited = (e: Event) => {
      const detail = (e as CustomEvent).detail as { retryAfter?: string | null } | undefined
      const raw = detail?.retryAfter
      const retryAfterSec = raw && !Number.isNaN(Number(raw)) ? Number(raw) : null
      setRateLimited({ retryAfterSec })
    }
    window.addEventListener('supabase-refresh-rate-limited', onRateLimited)
    return () => window.removeEventListener('supabase-refresh-rate-limited', onRateLimited)
  }, [])

  // Countdown ticker — auto-dismisses overlay when retry-after elapses.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!rateLimited?.retryAfterSec) { setSecondsLeft(null); return }
    setSecondsLeft(rateLimited.retryAfterSec)
    const id = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev === null) return null
        const next = prev - 1
        if (next <= 0) {
          setRateLimited(null)
          return null
        }
        return next
      })
    }, 1000)
    return () => clearInterval(id)
  }, [rateLimited])

  if (!rateLimited) return null

  // Full-screen dimmer + centered message. Not dismissible — the
  // countdown decides when it clears. Prevents the user from
  // interacting with the app during the rate-limit window
  // (interactions would trigger more refresh attempts).
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        fontFamily: 'system-ui, Arial, sans-serif',
      }}
    >
      <div style={{ background: '#161b26', border: '1px solid #a16207', borderRadius: '12px', padding: '24px', maxWidth: '440px', width: '100%', textAlign: 'center' }}>
        <p style={{ color: '#fbbf24', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 'bold' }}>
          Too many sign-in attempts
        </p>
        <p style={{ color: 'white', fontSize: '15px', fontWeight: 'bold', margin: '0 0 12px', lineHeight: '1.5' }}>
          Wait a few minutes before signing in again.
        </p>
        <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 8px', lineHeight: '1.6' }}>
          Your session refresh was rate-limited. Signing in immediately would trigger another failed attempt.
        </p>
        {secondsLeft !== null && secondsLeft > 0 && (
          <p style={{ color: '#fbbf24', fontSize: '13px', margin: '12px 0 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            Retry available in {secondsLeft}s
          </p>
        )}
        {secondsLeft === null && (
          <p style={{ color: '#666', fontSize: '11px', margin: '12px 0 0', fontStyle: 'italic' }}>
            Try again in about 5 minutes.
          </p>
        )}
      </div>
    </div>
  )
}
