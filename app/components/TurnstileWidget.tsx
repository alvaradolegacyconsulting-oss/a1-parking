'use client'

import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react'
import Script from 'next/script'

// Cloudflare Turnstile client widget.
//
// Mode is determined by the Cloudflare DASHBOARD site-key config (Jose set it
// to "Managed" per the 2026-06-19 CAPTCHA preflight). This component is mode-
// agnostic — same code works for managed/non-interactive/invisible site keys.
//
// USAGE
//   const widgetRef = useRef<TurnstileHandle>(null)
//   const [token, setToken] = useState<string | null>(null)
//   <TurnstileWidget ref={widgetRef} onVerify={setToken} onExpire={() => setToken(null)} />
//   // ... later, on submit error:
//   widgetRef.current?.reset()
//   setToken(null)
//
// IMPERATIVE RESET
//   Parent calls ref.current.reset() after submit failure so the user can re-
//   challenge without a page reload. Turnstile tokens are single-use — every
//   submit attempt needs a fresh token, so reset-on-error is load-bearing UX.
//
// SCRIPT DEDUP
//   next/script with the same src dedupes globally. Multiple TurnstileWidget
//   instances on one page share one script load.

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileRenderOptions) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
      getResponse: (widgetId: string) => string | undefined
    }
  }
}

interface TurnstileRenderOptions {
  sitekey: string
  callback?: (token: string) => void
  'error-callback'?: (error?: string) => void
  'expired-callback'?: () => void
  'timeout-callback'?: () => void
  theme?: 'auto' | 'light' | 'dark'
  size?: 'normal' | 'compact' | 'flexible'
  action?: string
  cData?: string
}

export interface TurnstileHandle {
  reset: () => void
  /**
   * Force a fresh challenge and return a Promise that resolves with the
   * newly-minted token. Bug 1 Option B (2026-07-14): visitor page calls
   * this immediately before submit so the token reaching /siteverify is
   * <1s old rather than N minutes old from the initial page-load solve.
   *
   * Cloudflare tokens are single-use AND time-bounded (~5min effective
   * accept window on /siteverify). The failure surface addressed here is
   * the visitor who solves the checkbox, gets distracted, then hits Get
   * Visitor Pass 6+ min later — the token is stale by then; /siteverify
   * returns invalid-input-response; the user is stranded on the form.
   *
   * Managed mode usually completes in <500ms (transparent checkbox
   * re-issue). Interactive challenges may take up to a few seconds.
   * Timeout: 15s. On timeout OR Turnstile error-callback, the promise
   * rejects; parent should surface a "please solve CAPTCHA again" error.
   */
  refresh: () => Promise<string>
  /**
   * Current token if the widget has one (post-solve, pre-expiry), else
   * null. Reads a ref directly, not React state — useful when a submit
   * handler needs to decide whether to refresh() or reuse. Not needed
   * for the visitor-page flow (which always refreshes) but exposed for
   * future callers.
   */
  getCurrentToken: () => string | null
}

interface Props {
  onVerify: (token: string) => void
  onError?: (error?: string) => void
  onExpire?: () => void
  theme?: 'auto' | 'light' | 'dark'
  size?: 'normal' | 'compact' | 'flexible'
  // Optional purpose tag passed to Cloudflare analytics ('signup', 'register', 'visitor')
  action?: string
}

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

// B213 remount fix 2026-06-29 — wrapped in memo so unrelated parent
// re-renders (typing into adjacent form fields, etc.) don't churn this
// component. Combined with the latest-ref callback pattern below, the
// widget mounts ONCE and survives the parent's render storm.
//
// Before this fix: parents pass inline arrow handlers (onExpire={() =>
// setX(null)}, etc.); the previous effect's dep array included those
// props, so every parent re-render triggered the cleanup +
// turnstile.remove() + re-render path, tearing down the iframe on each
// keystroke. Symptoms: page "bounces" while typing, the just-solved
// checkmark visually unchecks after parent state updates, and on
// /resident the token captured pre-render gets invalidated mid-flow
// so the re-auth signInWithPassword hangs on a stale token.
//
// Fix shape: latest-ref pattern. Callbacks live in refs that are kept
// current via a separate effect; render-effect deps drop the callback
// identities entirely (now [scriptReady, sitekey, theme, size, action]
// — all stable). turnstile.render's callbacks read .current at call
// time, so the widget always invokes the freshest parent handler
// without re-mounting.
export const TurnstileWidget = memo(forwardRef<TurnstileHandle, Props>(function TurnstileWidget(
  { onVerify, onError, onExpire, theme = 'auto', size = 'flexible', action },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [scriptReady, setScriptReady] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  // Bug 1 Option B (2026-07-14) — token/pending-refresh plumbing.
  // latestTokenRef mirrors the most recent value handed to onVerify so
  // getCurrentToken() can read it without going through React state.
  // pendingResolversRef holds outstanding refresh() promises; the render-
  // effect callback resolves them when the next token arrives, or rejects
  // them on error-callback / 15s timeout. Kept as refs so extending the
  // render effect's dep array is not required.
  const latestTokenRef = useRef<string | null>(null)
  const pendingResolversRef = useRef<Array<{
    resolve: (t: string) => void
    reject:  (e: Error) => void
    timer:   ReturnType<typeof setTimeout>
  }>>([])

  function flushResolvers(kind: 'resolve', payload: string): void
  function flushResolvers(kind: 'reject',  payload: Error): void
  function flushResolvers(kind: 'resolve' | 'reject', payload: string | Error): void {
    const pending = pendingResolversRef.current
    pendingResolversRef.current = []
    for (const { resolve, reject, timer } of pending) {
      clearTimeout(timer)
      if (kind === 'resolve') resolve(payload as string)
      else                    reject(payload as Error)
    }
  }

  // Read sitekey at render time. NEXT_PUBLIC_TURNSTILE_SITE_KEY is the locked
  // env var name per the preflight; single site key for all 4 forms.
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  // B213 remount fix — latest-ref shells for the 3 callback props. The
  // render-effect below references these via .current (call-time read)
  // instead of capturing the prop directly, so callback identity churn
  // from parent re-renders doesn't trigger the mount/unmount path.
  const onVerifyRef = useRef(onVerify)
  const onErrorRef = useRef(onError)
  const onExpireRef = useRef(onExpire)
  // Keep refs in sync with the latest props on every render. Runs after
  // every render unconditionally — no dep array. Cheap (3 assignments).
  useEffect(() => {
    onVerifyRef.current = onVerify
    onErrorRef.current = onError
    onExpireRef.current = onExpire
  })

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current && typeof window !== 'undefined' && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current)
        } catch (e) {
          console.error('[TurnstileWidget] reset failed:', (e as Error).message)
        }
      }
      // Clear the mirror ref too — a callback-less reset invalidates the
      // token even if the callback never fires (e.g. user navigates away).
      latestTokenRef.current = null
    },
    refresh: () => new Promise<string>((resolve, reject) => {
      if (
        !widgetIdRef.current
        || typeof window === 'undefined'
        || !window.turnstile
      ) {
        reject(new Error('Turnstile widget not ready'))
        return
      }
      const timer = setTimeout(() => {
        // Timed out — pull our resolver out of the pending list so the
        // next natural token doesn't accidentally resolve it, then reject.
        const idx = pendingResolversRef.current.findIndex(r => r.resolve === resolve)
        if (idx >= 0) pendingResolversRef.current.splice(idx, 1)
        reject(new Error('Turnstile refresh timed out after 15s'))
      }, 15000)
      pendingResolversRef.current.push({ resolve, reject, timer })
      latestTokenRef.current = null
      try {
        window.turnstile.reset(widgetIdRef.current)
      } catch (e) {
        // Reset itself threw — pull our resolver back out and reject.
        clearTimeout(timer)
        const idx = pendingResolversRef.current.findIndex(r => r.resolve === resolve)
        if (idx >= 0) pendingResolversRef.current.splice(idx, 1)
        reject(new Error(`Turnstile reset failed: ${(e as Error).message}`))
      }
    }),
    getCurrentToken: () => latestTokenRef.current,
  }), [])

  useEffect(() => {
    // Render once script is ready AND container exists AND we haven't rendered yet.
    if (!scriptReady) return
    if (!containerRef.current) return
    if (widgetIdRef.current) return
    if (!sitekey) {
      setRenderError('NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set in the environment.')
      return
    }
    if (typeof window === 'undefined' || !window.turnstile) {
      // Script load completed but turnstile global isn't there — unexpected.
      setRenderError('Turnstile script loaded but window.turnstile is undefined.')
      return
    }
    try {
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey,
        // B213 remount fix — .current reads at call-time pick up the
        // freshest parent handler without re-triggering this effect.
        callback: (token: string) => {
          // Bug 1 Option B (2026-07-14) — mirror the token in a ref
          // (for getCurrentToken()) and resolve any pending refresh()
          // promises. Order matters: mirror BEFORE onVerify so a parent
          // that synchronously reads getCurrentToken() inside onVerify
          // sees the same value.
          latestTokenRef.current = token
          onVerifyRef.current(token)
          flushResolvers('resolve', token)
        },
        'error-callback': (error?: string) => {
          // Reject any pending refresh() so the parent's submit handler
          // gets a real failure instead of hanging until the 15s timeout.
          latestTokenRef.current = null
          if (onErrorRef.current) onErrorRef.current(error)
          flushResolvers('reject', new Error(`Turnstile challenge error: ${error ?? 'unknown'}`))
          // Don't auto-reset on error; let the parent decide so it can clear
          // its captchaToken state in the same render pass.
        },
        'expired-callback': () => {
          // Expiry ≠ new token. Clear the mirror ref (getCurrentToken()
          // must not lie) but LEAVE any pending refresh() alone — the
          // reset it kicked off is still in flight and will complete via
          // the callback path above.
          latestTokenRef.current = null
          if (onExpireRef.current) onExpireRef.current()
        },
        theme,
        size,
        action,
      })
    } catch (e) {
      setRenderError(`Turnstile render failed: ${(e as Error).message}`)
    }
    // Cleanup: remove the widget on unmount so navigations don't leak DOM nodes.
    return () => {
      if (widgetIdRef.current && typeof window !== 'undefined' && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current)
        } catch { /* best-effort */ }
        widgetIdRef.current = null
      }
    }
    // B213 remount fix — onVerify/onError/onExpire deliberately OMITTED
    // from this dep array (handled via the latest-ref pattern above).
    // Remaining deps are all stable: scriptReady toggles once on script
    // load; sitekey is from env (constant); theme/size/action have
    // defaults at the destructure and no caller overrides them. Net:
    // this effect runs exactly once per mount.
  }, [scriptReady, sitekey, theme, size, action])

  if (renderError) {
    return (
      <div style={{ padding: 12, background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, color: '#fca5a5', fontSize: 12 }}>
        CAPTCHA load error: {renderError}. Please refresh and try again.
      </div>
    )
  }

  return (
    <>
      <Script
        src={TURNSTILE_SCRIPT_SRC}
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
        onError={() => setRenderError('Could not load Cloudflare Turnstile script.')}
      />
      <div ref={containerRef} />
    </>
  )
}))
