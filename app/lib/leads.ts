// ════════════════════════════════════════════════════════════════════
// leads — intake helpers for /api/leads (2026-09-23)
// ════════════════════════════════════════════════════════════════════
//
// Pure functions, no I/O, so the route stays thin and these can be
// gate-tested without standing up a request. Commit 2 of 4.

// ── D1: the attribution allowlist ───────────────────────────────────
// 🔴 These four keys and nothing else. The value arrives from a URL on a
// PUBLIC UNAUTHENTICATED form, so it is attacker-controlled: anyone who
// can construct a link can propose keys and volume.
//
// 🔴 UNKNOWN KEYS ARE DROPPED SILENTLY, NEVER REJECTED. The table's
// leads_source_allowlisted CHECK rejects the whole INSERT on a bad key,
// and on a lead form a rejected write means a LOST PROSPECT. This filter
// is what keeps the write legal; the CHECK is the backstop for the day
// this filter stops running. If the two ever disagree, the CHECK costs
// us the lead — so this must never pass through anything it is unsure
// of.
export const ALLOWED_SOURCE_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'src'] as const
export type AllowedSourceKey = typeof ALLOWED_SOURCE_KEYS[number]

// 64 is generous for a campaign slug and keeps the whole document well
// inside the CHECK's 400-char total cap even with all four keys present.
export const MAX_SOURCE_VALUE_LEN = 64

export type LeadSource = Partial<Record<AllowedSourceKey, string>>

// Returns NULL, not {}, when nothing recognized arrived.
//
// 🔴 The distinction is the point. `{}` would mean "we looked and found
// an empty set"; null means "this visitor carried no attribution".
// Storing {} for a direct visit would make every direct arrival
// indistinguishable from a campaign whose parameters we failed to parse.
export function normalizeSource(raw: unknown): LeadSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const out: LeadSource = {}
  for (const key of ALLOWED_SOURCE_KEYS) {
    const v = input[key]
    if (typeof v !== 'string') continue          // non-strings dropped, not coerced
    const trimmed = v.trim()
    if (trimmed === '') continue                 // empty is absence, not a value
    out[key] = trimmed.slice(0, MAX_SOURCE_VALUE_LEN)
  }
  return Object.keys(out).length === 0 ? null : out
}

// ── Track ───────────────────────────────────────────────────────────
// 🔴 DERIVED, NEVER SELECTED. The prospect is never asked to classify
// themselves into our vocabulary — that is how a form loses people. The
// public form asks "which describes your business"; /operators pre-sets
// 'enforcement' because the ads driving that traffic aim at operators.
//
// The caller therefore sends a BRANCH, not a tier, and anything we do
// not recognise is refused rather than defaulted. Defaulting would let a
// crafted POST file itself under whichever track we happened to pick.
export type Track = 'enforcement' | 'property_management'

export function resolveTrack(raw: unknown): Track | null {
  if (raw === 'enforcement' || raw === 'property_management') return raw
  return null
}

// ── Three-state booleans ────────────────────────────────────────────
// The column is NULL when the form did not ask. Only an explicit true or
// false from the client becomes a value; anything else stays absent.
export function tristate(raw: unknown): boolean | null {
  if (raw === true) return true
  if (raw === false) return false
  return null
}

export function cleanText(raw: unknown, max = 200): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return t === '' ? null : t.slice(0, max)
}

export function cleanCount(raw: unknown): number | null {
  // 🔴 The empty string is checked BEFORE Number(), because Number('')
  // is 0, not NaN. Without this an unanswered "properties you cover"
  // field would store 0 — asserting the prospect covers zero properties
  // rather than recording that they did not say. Same absence-vs-zero
  // conflation as the three-state booleans, one line lower down.
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '') return null
    n = Number(t)
  } else return null
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10000) return null
  return n
}

// ── The internal alert ──────────────────────────────────────────────
export type LeadAlertInput = {
  id: number | null
  company_name: string | null
  contact_name: string | null
  email: string
  phone: string | null
  track: Track
  property_count: number | null
  scale_note: string | null
  timeline: string | null
  growth_trend: string | null
  texas_confirmed: boolean | null
  wants_demo: boolean | null
  source: LeadSource | null
}

// 🔴 wants_demo leads the SUBJECT, not a field buried in the body. It is
// the difference between a lead to read later and a person who is now
// expecting a call. A subject line that reads the same either way makes
// the operator open every message to find out which one this is.
export function buildLeadAlert(l: LeadAlertInput): { subject: string; text: string } {
  const who = l.company_name ?? l.contact_name ?? l.email
  const subject = l.wants_demo === true
    ? `[ShieldMyLot] DEMO REQUESTED — ${who}`
    : `[ShieldMyLot] New lead — ${who}`

  const line = (label: string, v: unknown) =>
    `${label.padEnd(18)} ${v === null || v === undefined || v === '' ? '(not asked / not given)' : String(v)}`

  const text = [
    l.wants_demo === true
      ? '*** THIS PERSON ASKED FOR A 15-MINUTE DEMO. They are expecting a call. ***'
      : 'New lead — no demo requested.',
    '',
    line('Company', l.company_name),
    line('Contact', l.contact_name),
    line('Email', l.email),
    line('Phone', l.phone),
    '',
    line('Track', l.track),
    line('Properties', l.property_count),
    line('Scale', l.scale_note),
    line('Timeline', l.timeline),
    line('Growth', l.growth_trend),
    // Three-state, spelled out. "no" and "was not asked" are different
    // answers and the operator needs to know which one they are reading.
    line('Texas', l.texas_confirmed === null ? '(form did not ask)' : l.texas_confirmed ? 'yes' : 'NO — said not in Texas'),
    '',
    line('Attribution', l.source ? JSON.stringify(l.source) : '(arrived with no campaign parameters)'),
    line('Lead id', l.id ?? '(row id unavailable)'),
  ].join('\n')

  return { subject, text }
}
