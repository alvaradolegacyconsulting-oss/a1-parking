// ════════════════════════════════════════════════════════════════════
// lead-attribution — client-side capture for /operators (2026-09-23)
// ════════════════════════════════════════════════════════════════════
//
// Pure, so the page stays thin and the rules are gate-testable without
// a browser. Commit 3 of 4.

import { ALLOWED_SOURCE_KEYS, type LeadSource } from './leads'

// Read the campaign parameters off the URL at page load.
//
// 🔴 A lead that arrived with no recognised parameters writes NULL, not
// a guessed value and not {}. "Arrived directly" and "arrived from a
// campaign we failed to parse" must stay different answers — attribution
// is the only way to tell which placement produced a lead, and a guess
// there is worse than an absence.
//
// The route re-filters and re-caps everything this produces. This is the
// courtesy half; the server is the one that counts.
export function readAttribution(search: string): LeadSource | null {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search ?? '')
  } catch {
    return null
  }
  const out: LeadSource = {}
  for (const key of ALLOWED_SOURCE_KEYS) {
    const v = params.get(key)
    if (v === null) continue
    const t = v.trim()
    if (t === '') continue
    out[key] = t.slice(0, 64)
  }
  return Object.keys(out).length === 0 ? null : out
}

// ── 🔴 THE UNTICKED-CHECKBOX RULE ───────────────────────────────────
// An unticked HTML checkbox submits NOTHING. If the form simply spreads
// its state, a box the page PRESENTED and the visitor deliberately left
// alone arrives as absent — and absent means "the form did not ask".
// That is the same absence-collapse as the three-state columns and the
// cleanCount('') bug, arriving through a third door.
//
// So a surface declares what it ASKED, and every asked field is sent
// explicitly — false included. A field is omitted only when the surface
// genuinely does not have it.
export type AskedFields = {
  texas_confirmed: boolean
  wants_demo: boolean
}

export function buildLeadPayload(args: {
  asked: AskedFields
  values: {
    company_name: string
    contact_name: string
    email: string
    phone: string
    property_count: string
    texas_confirmed: boolean
    wants_demo: boolean
  }
  track: 'enforcement' | 'property_management'
  source: LeadSource | null
  captchaToken: string | null
}): Record<string, unknown> {
  const { asked, values, track, source, captchaToken } = args
  const payload: Record<string, unknown> = {
    captchaToken,
    track,
    company_name: values.company_name,
    contact_name: values.contact_name,
    email: values.email,
    phone: values.phone,
    property_count: values.property_count,
    source,
  }
  // Explicit true OR false for anything the surface presented.
  if (asked.texas_confirmed) payload.texas_confirmed = values.texas_confirmed
  if (asked.wants_demo) payload.wants_demo = values.wants_demo
  return payload
}
