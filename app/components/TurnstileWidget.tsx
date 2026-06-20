'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
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

export const TurnstileWidget = forwardRef<TurnstileHandle, Props>(function TurnstileWidget(
  { onVerify, onError, onExpire, theme = 'auto', size = 'flexible', action },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [scriptReady, setScriptReady] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  // Read sitekey at render time. NEXT_PUBLIC_TURNSTILE_SITE_KEY is the locked
  // env var name per the preflight; single site key for all 4 forms.
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current && typeof window !== 'undefined' && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current)
        } catch (e) {
          console.error('[TurnstileWidget] reset failed:', (e as Error).message)
        }
      }
    },
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
        callback: (token: string) => onVerify(token),
        'error-callback': (error?: string) => {
          if (onError) onError(error)
          // Don't auto-reset on error; let the parent decide so it can clear
          // its captchaToken state in the same render pass.
        },
        'expired-callback': () => {
          if (onExpire) onExpire()
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
  }, [scriptReady, sitekey, theme, size, action, onVerify, onError, onExpire])

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
})
