// ════════════════════════════════════════════════════════════════════
// GATE — /operators form logic (2026-09-23), Commit 3 of 4
// ════════════════════════════════════════════════════════════════════
//
// The two rules this page can get wrong in ways nobody would notice:
// attribution capture, and the unticked-checkbox collapse.
//
// 🔴 NOT COVERED HERE — the D6 deploy-time list, printed at the end
// rather than implied: an anonymous GET of /operators, a real submit
// through a real challenge, the row landing with source populated, and
// the alert arriving with alert_email_sent true.
import { readAttribution, buildLeadPayload, type AskedFields } from '../app/lib/lead-attribution'
import { normalizeSource } from '../app/lib/leads'

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── A1 — the recommended QR destination actually captures ───────────
{
  const got = readAttribution('src=swto-print')
  if (eq(got, { src: 'swto-print' })) pass('A1', '/morethantruck?src=swto-print → {"src":"swto-print"}')
  else fail('A1', `got ${JSON.stringify(got)}`)
}
{
  const got = readAttribution('utm_source=assoc&utm_medium=email&utm_campaign=fall26&src=swto')
  if (eq(got, { utm_source: 'assoc', utm_medium: 'email', utm_campaign: 'fall26', src: 'swto' }))
    pass('A1b', 'all four parameters captured from a full campaign URL')
  else fail('A1b', `got ${JSON.stringify(got)}`)
}

// ── A2 — 🔴 no parameters writes NULL, never a guess and never {} ───
for (const [label, qs] of [
  ['typed the URL directly', ''],
  ['unrelated parameters only', 'ref=twitter&fbclid=abc'],
  ['a recognised key left empty', 'src='],
  ['whitespace only', 'src=%20%20'],
] as [string, string][]) {
  const got = readAttribution(qs)
  if (got === null) pass('A2', `${label} → null (arrived with no attribution)`)
  else fail('A2', `${label} → ${JSON.stringify(got)}; must be null`)
}

// ── A3 — unknown keys never ride along ──────────────────────────────
{
  const got = readAttribution('src=ok&evil=payload&utm_term=x&gclid=y')
  if (eq(got, { src: 'ok' })) pass('A3', 'unknown parameters dropped; the recognised one survives')
  else fail('A3', `got ${JSON.stringify(got)}`)
}

// ── A4 — what the page captures must survive the route unchanged ────
// If the client and server filters disagree, attribution silently
// changes between the URL and the row.
{
  const cases = ['src=swto-print', 'utm_source=a&utm_medium=b&utm_campaign=c&src=d', 'evil=x', '', 'src=' + 'z'.repeat(200)]
  const bad = cases.filter(qs => !eq(normalizeSource(readAttribution(qs)), readAttribution(qs)))
  if (bad.length === 0) pass('A4', 'every client capture passes through the server filter unchanged — no silent drift')
  else fail('A4', `client and server disagree on: ${JSON.stringify(bad)}`)
}

// ── C1 — 🔴 THE UNTICKED-CHECKBOX TRAP ──────────────────────────────
// This surface PRESENTS both boxes, so leaving one alone must send an
// explicit false. Sending nothing would arrive as null = "the form did
// not ask", and "they declined a demo" would become indistinguishable
// from "we never offered one".
const ASKED: AskedFields = { texas_confirmed: true, wants_demo: true }
const base = {
  company_name: 'Acme', contact_name: 'Pat', email: 'p@acme.com', phone: '', property_count: '',
  texas_confirmed: false, wants_demo: false,
}
{
  const p = buildLeadPayload({ asked: ASKED, values: base, track: 'enforcement', source: null, captchaToken: 't' })
  if ('wants_demo' in p && p.wants_demo === false && 'texas_confirmed' in p && p.texas_confirmed === false)
    pass('C1', 'boxes presented and left unticked are sent as explicit false, not omitted')
  else fail('C1', `🔴 unticked boxes did not arrive as false: ${JSON.stringify({ wd: p.wants_demo, tx: p.texas_confirmed })}`)
}
{
  const p = buildLeadPayload({
    asked: ASKED, values: { ...base, wants_demo: true, texas_confirmed: true },
    track: 'enforcement', source: null, captchaToken: 't',
  })
  if (p.wants_demo === true && p.texas_confirmed === true) pass('C1b', 'ticked boxes are sent as true')
  else fail('C1b', `got ${JSON.stringify({ wd: p.wants_demo, tx: p.texas_confirmed })}`)
}
{
  // The other half of the rule: a surface that genuinely does NOT ask
  // must omit the field, so the column stays NULL rather than claiming
  // a decision the visitor was never offered.
  const p = buildLeadPayload({
    asked: { texas_confirmed: false, wants_demo: true }, values: base,
    track: 'enforcement', source: null, captchaToken: 't',
  })
  if (!('texas_confirmed' in p) && 'wants_demo' in p)
    pass('C1c', 'a field the surface does NOT ask is omitted entirely → column stays NULL')
  else fail('C1c', `unasked field was sent anyway: ${JSON.stringify(p)}`)
}

// ── T1 — track is pre-set and never taken from the visitor ──────────
{
  const p = buildLeadPayload({ asked: ASKED, values: base, track: 'enforcement', source: null, captchaToken: 't' })
  if (p.track === 'enforcement') pass('T1', "track is pre-set to 'enforcement'; the page never shows the question")
  else fail('T1', `track was ${JSON.stringify(p.track)}`)
}

// ── P1 — the payload carries what the route needs, and nothing odd ──
{
  const p = buildLeadPayload({
    asked: ASKED, values: { ...base, property_count: '12' },
    track: 'enforcement', source: { src: 'swto-print' }, captchaToken: 'tok',
  })
  const expected = ['captchaToken', 'track', 'company_name', 'contact_name', 'email', 'phone', 'property_count', 'source', 'texas_confirmed', 'wants_demo']
  const extra = Object.keys(p).filter(k => !expected.includes(k))
  if (extra.length === 0 && p.captchaToken === 'tok' && eq(p.source, { src: 'swto-print' }))
    pass('P1', 'payload carries exactly the expected fields, token and attribution included')
  else fail('P1', `extra=${JSON.stringify(extra)} token=${p.captchaToken} source=${JSON.stringify(p.source)}`)
}

console.log('')
console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
console.log('')
console.log('── D6 deploy-time list, NOT covered here ───────────────────')
console.log('   1. anonymous GET /operators returns the page, not /login')
console.log('   2. a real submit through a real Turnstile challenge succeeds')
console.log('   3. the row lands in leads with source populated from the URL')
console.log('   4. the alert arrives AND alert_email_sent is true on that row')
console.log('   Any one of those without the others is not a pass.')
process.exit(failures === 0 ? 0 : 1)
