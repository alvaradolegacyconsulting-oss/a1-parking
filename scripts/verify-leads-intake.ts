// ════════════════════════════════════════════════════════════════════
// GATE — /api/leads intake helpers (2026-09-23), Commit 2 of 4
// ════════════════════════════════════════════════════════════════════
//
// Covers the pure decision logic: the source allowlist, the derived
// track, the three-state booleans and the alert subject. These are what
// the route branches on, so they are what can be wrong.
//
// 🔴 WHAT THIS DOES NOT COVER, stated rather than implied:
//   • a real POST through Turnstile (needs a live challenge)
//   • the actual INSERT (Commit 1's gates cover the table)
//   • a real Resend send
// Those are the deploy-time checks in the Commit 3 report, per D6.
import {
  normalizeSource, resolveTrack, tristate, cleanCount, cleanText, buildLeadAlert,
  ALLOWED_SOURCE_KEYS, MAX_SOURCE_VALUE_LEN,
} from '../app/lib/leads'

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── S1 — all four allowlisted keys survive ──────────────────────────
{
  const got = normalizeSource({ utm_source: 'assoc', utm_medium: 'print', utm_campaign: 'fall26', src: 'swto-print' })
  if (eq(got, { utm_source: 'assoc', utm_medium: 'print', utm_campaign: 'fall26', src: 'swto-print' }))
    pass('S1', 'all four allowlisted keys kept')
  else fail('S1', `got ${JSON.stringify(got)}`)
}

// ── S2 — 🔴 unknown keys are DROPPED SILENTLY, not rejected ─────────
// A rejected write on a lead form is a lost prospect. This is the whole
// reason the route filters instead of letting the CHECK refuse.
{
  const got = normalizeSource({ utm_source: 'ok', evil: 'x', __proto__: 'y', 'utm source': 'z' })
  if (eq(got, { utm_source: 'ok' })) pass('S2', 'unknown keys dropped, known key survives, nothing thrown')
  else fail('S2', `got ${JSON.stringify(got)}`)
}

// ── S3 — values capped; the whole doc stays inside the CHECK's 400 ──
{
  const long = 'x'.repeat(500)
  const got = normalizeSource({ src: long }) as Record<string, string>
  const docLen = JSON.stringify(got).length
  if (got.src.length === MAX_SOURCE_VALUE_LEN && docLen < 400)
    pass('S3', `value capped at ${MAX_SOURCE_VALUE_LEN}; document ${docLen} chars, inside the CHECK's 400`)
  else fail('S3', `len=${got?.src?.length} docLen=${docLen}`)
}
{
  // All four at max must still fit the CHECK.
  const all: Record<string, string> = {}
  for (const k of ALLOWED_SOURCE_KEYS) all[k] = 'y'.repeat(MAX_SOURCE_VALUE_LEN)
  const docLen = JSON.stringify(normalizeSource(all)).length
  if (docLen <= 400) pass('S3b', `worst case (4 keys x ${MAX_SOURCE_VALUE_LEN}) = ${docLen} chars, still legal`)
  else fail('S3b', `🔴 worst case is ${docLen} chars — the CHECK would REJECT and the lead would be LOST`)
}

// ── S4 — 🔴 nothing recognised writes NULL, never {} ────────────────
for (const [label, input] of [
  ['no parameters at all', {}],
  ['only unknown keys', { foo: 'bar' }],
  ['empty strings', { src: '   ' }],
  ['non-strings', { src: 42, utm_source: null }],
  ['not an object', 'utm_source=x'],
  ['null', null],
] as [string, unknown][]) {
  const got = normalizeSource(input)
  if (got === null) pass('S4', `${label} → null (absence, not an empty set)`)
  else fail('S4', `${label} → ${JSON.stringify(got)}; must be null`)
}

// ── T1 — track is derived and unknown values are REFUSED ────────────
{
  const ok = resolveTrack('enforcement') === 'enforcement' && resolveTrack('property_management') === 'property_management'
  const refused = ['legacy', 'pm_multi', '', null, undefined, 'ENFORCEMENT'].every(v => resolveTrack(v) === null)
  if (ok && refused) pass('T1', 'both branches resolve; legacy/pm_multi/blank/wrong-case all refused, none defaulted')
  else fail('T1', `ok=${ok} refused=${refused}`)
}

// ── B1 — three-state booleans keep all three states ─────────────────
{
  const cases: [unknown, boolean | null][] = [
    [true, true], [false, false], [undefined, null], [null, null],
    ['true', null], ['false', null], [1, null], [0, null], ['', null],
  ]
  const bad = cases.filter(([i, o]) => tristate(i) !== o)
  if (bad.length === 0) pass('B1', 'true/false preserved; everything else is NULL (= form did not ask)')
  else fail('B1', `wrong: ${JSON.stringify(bad)}`)
}
{
  // 🔴 The trap this guards: a string "false" from a form must NOT
  // become boolean false. "they said no" and "we did not ask" are
  // different answers and the column is three-state on purpose.
  if (tristate('false') === null) pass('B1b', '"false" as a STRING is null, not false — no silent coercion')
  else fail('B1b', 'string "false" coerced to boolean false')
}

// ── C1 — counts ─────────────────────────────────────────────────────
{
  const cases: [unknown, number | null][] = [
    [12, 12], ['12', 12], [' 12 ', 12], [0, 0],
    [-1, null], [10001, null], [1.5, null], ['abc', null], [null, null],
    // 🔴 The one that caught a real bug: Number('') is 0, not NaN, so an
    // unanswered optional field was storing "covers 0 properties"
    // instead of "did not say".
    ['', null], ['   ', null], [undefined, null],
  ]
  const bad = cases.filter(([i, o]) => cleanCount(i) !== o)
  if (bad.length === 0) pass('C1', 'counts parsed; blank/negative/fraction/out-of-range/junk all null (blank is NOT 0)')
  else fail('C1', `wrong: ${JSON.stringify(bad)}`)
}
{
  if (cleanText('  Acme Towing  ') === 'Acme Towing' && cleanText('   ') === null && cleanText(7) === null)
    pass('C2', 'text trimmed; blank and non-string are null')
  else fail('C2', 'cleanText wrong')
}

// ── A1 — 🔴 wants_demo LEADS THE SUBJECT ────────────────────────────
{
  const base = {
    id: 10, company_name: 'Acme Towing', contact_name: 'Pat', email: 'pat@acme.com', phone: null,
    track: 'enforcement' as const, property_count: 12, scale_note: null, timeline: null,
    growth_trend: null, texas_confirmed: true, wants_demo: true, source: null,
  }
  const yes = buildLeadAlert(base)
  const no = buildLeadAlert({ ...base, wants_demo: false })
  const notAsked = buildLeadAlert({ ...base, wants_demo: null })
  if (/DEMO REQUESTED/.test(yes.subject) && !/DEMO REQUESTED/.test(no.subject) && !/DEMO REQUESTED/.test(notAsked.subject)) {
    pass('A1', `demo is in the SUBJECT: "${yes.subject}"`)
  } else {
    fail('A1', `subjects do not distinguish a demo request: ${yes.subject} / ${no.subject}`)
  }
  if (yes.subject !== no.subject) pass('A1b', 'a demo request cannot be mistaken for an ordinary lead at a glance')
  else fail('A1b', 'identical subjects')
}
{
  // Texas three-state must read as three distinct things in the body.
  const b = {
    id: 1, company_name: null, contact_name: null, email: 'x@y.com', phone: null,
    track: 'enforcement' as const, property_count: null, scale_note: null, timeline: null,
    growth_trend: null, wants_demo: null, source: null,
  }
  const t = buildLeadAlert({ ...b, texas_confirmed: true }).text
  const f = buildLeadAlert({ ...b, texas_confirmed: false }).text
  const n = buildLeadAlert({ ...b, texas_confirmed: null }).text
  if (t !== f && f !== n && t !== n && /did not ask/.test(n) && /NO —/.test(f))
    pass('A2', 'Texas yes / NO / not-asked read as three different answers in the alert')
  else fail('A2', 'the three Texas states are not distinguishable in the alert body')
}
{
  const withSrc = buildLeadAlert({
    id: 1, company_name: null, contact_name: null, email: 'x@y.com', phone: null,
    track: 'enforcement', property_count: null, scale_note: null, timeline: null,
    growth_trend: null, texas_confirmed: null, wants_demo: null,
    source: { src: 'swto-print' },
  }).text
  const without = buildLeadAlert({
    id: 1, company_name: null, contact_name: null, email: 'x@y.com', phone: null,
    track: 'enforcement', property_count: null, scale_note: null, timeline: null,
    growth_trend: null, texas_confirmed: null, wants_demo: null, source: null,
  }).text
  if (/swto-print/.test(withSrc) && /no campaign parameters/.test(without))
    pass('A3', 'attribution present is shown; absent says so rather than printing nothing')
  else fail('A3', 'attribution not distinguishable')
}

console.log('')
console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
console.log('')
console.log('── deploy-time checks NOT covered here (D6) ────────────────')
console.log('   • anonymous GET /operators returns the page, not a /login redirect')
console.log('   • a real submit with a real Turnstile challenge')
console.log('   • the row lands with source populated from the URL')
console.log('   • the alert arrives AND alert_email_sent is true on that row')
process.exit(failures === 0 ? 0 : 1)
