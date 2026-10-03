'use client'

// ════════════════════════════════════════════════════════════════════
// useQuote — the live estimate, fetched from the catalog Checkout uses
// ════════════════════════════════════════════════════════════════════
//
// Wraps GET /api/signup/quote for the two client pages that show a
// price before Checkout (/signup and /signup/verify). Both used to
// compute the figure locally from TIER_PRICING; both now ask the
// server, so neither holds a price.
//
// 🔴 LAST-WRITE-WINS. The property count is typed, so a visitor going
// 1 → 2 → 20 fires three overlapping requests. Responses can land out
// of order, and the naive `fetch().then(setState)` pair would leave the
// page showing the price for "2" while the field reads "20" — a wrong
// price displayed with total confidence, which is the whole class of
// bug this arc exists to close. Every request carries a sequence
// number and only the newest is allowed to write state; superseded
// responses are dropped, and the in-flight one is aborted.
//
// 🔴 A FAILED FETCH IS NOT A FREE PLAN. On error the hook returns
// quote: null with an error set. Callers must render that as "we
// couldn't price this" — never as $0.00, and never by falling back to
// a local constant, which is where the original defect came from.

import { useEffect, useRef, useState } from 'react'
import type { QuoteBreakdownLine } from './pricing-quote'
import type { PlanToken } from './signup-tier-param'

export interface QuoteResponse {
  token: PlanToken
  label: string
  track: string
  tier: string
  cycle: 'monthly' | 'annual'
  properties: number
  mode: 'test' | 'live'
  total_cents: number
  lines: QuoteBreakdownLine[]
}

export interface UseQuoteResult {
  quote: QuoteResponse | null
  loading: boolean
  error: string | null
}

export function useQuote(
  token: PlanToken | null,
  cycle: 'monthly' | 'annual',
  propertyCount: number,
): UseQuoteResult {
  const valid = !!token && Number.isInteger(propertyCount) && propertyCount >= 0

  // The address being asked about. Doubles as the identity of the
  // answer: a result is only shown when it was fetched for the exact
  // parameters on screen right now.
  const key = valid ? `${token}|${cycle}|${propertyCount}` : ''

  // 🔴 `loading` is DERIVED, not stored. Writing setState in an effect
  // body triggers a cascading render (react-hooks/set-state-in-effect),
  // and a separate loading flag can also disagree with the data it
  // describes. Stamping each settled result with the key it answers
  // makes "stale" and "loading" the same question, asked once.
  const [settled, setSettled] = useState<{ key: string; quote: QuoteResponse | null; error: string | null }>(
    { key: '', quote: null, error: null }
  )
  const seqRef = useRef(0)

  useEffect(() => {
    if (!valid) return

    const seq = ++seqRef.current
    const ac = new AbortController()

    const qs = new URLSearchParams({
      token: token as string,
      cycle,
      properties: String(propertyCount),
    })

    fetch(`/api/signup/quote?${qs.toString()}`, { signal: ac.signal })
      .then(async res => {
        const body = await res.json().catch(() => ({} as { error?: string }))
        if (seq !== seqRef.current) return            // superseded — drop it
        if (!res.ok) {
          setSettled({ key, quote: null, error: (body as { error?: string }).error || `Pricing unavailable (${res.status}).` })
          return
        }
        setSettled({ key, quote: body as QuoteResponse, error: null })
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        if (seq !== seqRef.current) return
        setSettled({ key, quote: null, error: (e as Error)?.message || 'Could not reach pricing.' })
      })

    return () => ac.abort()
  }, [valid, key, token, cycle, propertyCount])

  // An answer to a DIFFERENT question is not an answer. Until the
  // settled key matches the current address, the hook reports loading
  // and hands back no figure — never the previous plan's price.
  const fresh = valid && settled.key === key
  return {
    quote: fresh ? settled.quote : null,
    error: fresh ? settled.error : null,
    loading: valid && !fresh,
  }
}
