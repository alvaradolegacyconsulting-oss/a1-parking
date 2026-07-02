'use client'

// B211 — auto-logout watcher (v1: single absolute threshold, enforced
// on app-load + visibilitychange/focus). Silent on the on-return
// logout — the gap is long enough that re-login feels natural.
//
// SHAPE (locked at preflight):
//   • Single threshold, ALL roles (drivers included). No active in-tab
//     idle timer, no warning modal, no per-role branching in v1.
//   • Track last-activity timestamp in localStorage. On layout-mount,
//     visibilitychange, and window focus: if now − last_activity >
//     threshold → supabase.auth.signOut() + redirect to /login.
//   • Activity events: mousedown/keydown/click (NOT scroll/mousemove
//     — page focus alone isn't activity). Debounced to at most once
//     per 30s to avoid localStorage thrash.
//   • SKIP_PATHS allowlist: recovery + public flows early-return so
//     an over-threshold landing on /reset-password (etc.) doesn't
//     get signed out mid-flow. Also runs BEFORE portal loadX() so it
//     composes with evaluatePortalGate — no race, no PKCE trip.
//   • Before signOut: getSession() — no session → do nothing (no
//     spurious /login redirect for an unauthed browser).
//
// TUNING (UAT):
//   INACTIVITY_THRESHOLD_MS — bump/reduce in one line. Not a
//   platform_setting yet; can promote if UAT signal warrants it.

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '../supabase'

// ── Named editable constants (Jose 2026-07-02) ──────────────────────
// 12 hours: covers a normal shift + overnight for drivers, single
// working day for desk roles. Bump to 24h if desk staff report
// re-login friction; reduce to 8h if security signal warrants tighter.
const INACTIVITY_THRESHOLD_MS  = 12 * 60 * 60 * 1000
// 30-second write debounce — meaningful activity should touch the
// timestamp at most twice a minute. Prevents storage-event thrash
// across tabs on real typing/clicking sessions.
const ACTIVITY_WRITE_DEBOUNCE_MS = 30 * 1000
// localStorage key. Multi-tab shares the same timestamp — activity
// in tab A counts for tab B, which is what we want.
const STORAGE_KEY = 'shieldmylot_last_activity_at'

// Paths where the watcher must self-disable so an over-threshold
// landing doesn't sign out mid-flow (recovery links, PKCE, public
// forms). If a user comes back to /reset-password from an email
// link days later, they need to complete the reset, not get punted
// to /login. Public pages (/signup, /register, /visitor) don't have
// sessions to protect anyway.
const SKIP_PATH_PREFIXES = [
  '/login',
  '/logout',
  '/forgot-password',
  '/reset-password',
  '/reset-password-required',
  '/auth/accept',
  '/change-password',
  '/signup',
  '/signup/verify',
  '/signup/redeem',
  '/register',
  '/visitor',
  '/account-cancelled',
]

function isSkippedPath(pathname: string): boolean {
  return SKIP_PATH_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
}

function readLastActivity(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeLastActivity(ts: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(ts))
  } catch {
    /* Storage full / disabled — ignore */
  }
}

export default function InactivityWatcher() {
  const pathname = usePathname()
  // Ref-based state so activity handlers don't force re-renders and
  // don't re-attach on every tick.
  const lastWriteRef = useRef<number>(0)
  // Skip flag ref for stable access in listeners.
  const skipRef = useRef<boolean>(false)
  skipRef.current = isSkippedPath(pathname ?? '')

  // Check whether the session is over-threshold and sign out if so.
  // Async because getSession() is async; called from mount + focus +
  // visibilitychange. Idempotent — safe to fire multiple times per
  // second at worst; getSession short-circuits fast on no-session.
  useEffect(() => {
    let cancelled = false

    async function check() {
      if (cancelled) return
      if (skipRef.current) return
      const last = readLastActivity()
      if (last === null) {
        // First visit or storage cleared — seed the timestamp so a
        // future check has a valid delta. Don't sign out on a NULL
        // read (that would boot every fresh browser).
        writeLastActivity(Date.now())
        return
      }
      const delta = Date.now() - last
      if (delta <= INACTIVITY_THRESHOLD_MS) return

      // Over threshold. Guard the signOut on an active session —
      // no session → nothing to do (avoids spurious /login redirect
      // for an unauthed browser that happens to have a stale
      // timestamp).
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      if (!session) return

      // Sign out + redirect. Silent — no query-string notice; the
      // gap is long enough that re-login feels natural (v1 design).
      // Clear the stale timestamp so the next visit doesn't
      // immediately re-fire this branch.
      writeLastActivity(Date.now())
      await supabase.auth.signOut()
      if (cancelled) return
      // Use window.location for a hard nav — cleaner than router.push
      // since the session is now gone and we want any Supabase
      // client state cleared with the reload.
      window.location.href = '/login'
    }

    function onFocus() {
      void check()
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') void check()
    }

    // Run on mount.
    void check()

    // Attach focus/visibility listeners.
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pathname])

  // Debounced activity writer. Fires on mousedown/keydown/click ONLY
  // (not scroll/mousemove — those don't represent meaningful user
  // presence). Debounces to ACTIVITY_WRITE_DEBOUNCE_MS.
  useEffect(() => {
    function bump() {
      if (skipRef.current) return
      const now = Date.now()
      if (now - lastWriteRef.current < ACTIVITY_WRITE_DEBOUNCE_MS) return
      lastWriteRef.current = now
      writeLastActivity(now)
    }
    window.addEventListener('mousedown', bump)
    window.addEventListener('keydown',   bump)
    window.addEventListener('click',     bump)
    return () => {
      window.removeEventListener('mousedown', bump)
      window.removeEventListener('keydown',   bump)
      window.removeEventListener('click',     bump)
    }
  }, [])

  // Renders nothing — pure side-effect component.
  return null
}
