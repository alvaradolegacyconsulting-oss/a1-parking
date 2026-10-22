// ════════════════════════════════════════════════════════════════════
// GATE — every /register submit leaves a trace, and none of them hang
// ════════════════════════════════════════════════════════════════════
//
// THE INCIDENT (2026-10-17). A resident at Green Acres #9 reached
// "Step 3 of 3 — Review & Submit", tapped Submit, and the page froze.
// Afterwards there was no auth user, no resident, no vehicle AND NO
// AUDIT ROW — so there was no way to tell whether the request ever
// arrived. The registration path wrote its only audit row
// (REGISTRATION_TOS_ACCEPTED) late, from the client, and on the success
// path alone; an anonymous client cannot write audit_logs at all, so
// the pre-session outcomes could never have been recorded from there.
// Vercel's runtime logs serve a 30-minute window and were long gone.
//
// 🔴 TWO THINGS ARE ASSERTED, AND THE FIRST IS THE ONE THAT MATTERS.
// A pessimistic-default funnel means a branch added later cannot be
// silently unlogged: it records 'server_error', which is loud in the
// data rather than absent from it. The gate checks that the funnel is
// in place, that every return path marks an outcome, and that the
// count of marks matches the count of returns — so a new branch
// without a mark fails here rather than in an incident review.
//
// The timeout half is exercised for real against a server that never
// answers.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-register-attempt-audit.ts

import fs from 'fs'
import http from 'http'
import { createClient } from '@supabase/supabase-js'
import { fetchWithTimeout, isFetchTimeout, FetchTimeoutError } from '../app/lib/fetch-timeout'

const ROUTE = 'app/api/register/create-user/route.ts'
const PAGE = 'app/register/page.tsx'
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

async function main() {
  console.log('\n══ /register submit: one audit row per attempt, and no hang ══\n')
  const route = strip(fs.readFileSync(ROUTE, 'utf8'))
  const page = strip(fs.readFileSync(PAGE, 'utf8'))

  // ── the funnel ───────────────────────────────────────────────────
  chk('the attempt audit is written server-side, with service_role',
    /auditAttempt/.test(route) && /createSupabaseServiceClient/.test(route),
    'the interesting outcomes happen before any session exists, so a client insert could never cover them')
  chk('🔴 the default outcome is pessimistic',
    /let outcome = 'server_error'/.test(route),
    "a branch that forgets to mark records 'server_error' — loud in the data, not absent from it")
  chk('🔴 the audit write is in a finally, so every return funnels through it',
    /finally\s*\{[\s\S]{0,200}auditAttempt/.test(route),
    'one write site; a new early return cannot skip it')
  chk('the logger cannot fail a registration',
    /catch[\s\S]{0,120}attempt audit failed/.test(route),
    'wrapped in try/catch — a failure to log must not refuse a resident')

  // 🔴 EVERY return path marks. Counted, so a branch added without a
  // mark fails here. This is the assertion that would have been
  // missing from a "does it audit?" check that only looked for one row.
  const returns = (route.match(/return NextResponse\.json/g) ?? []).length
  const marks = (route.match(/mark\('/g) ?? []).length
  chk(`🔴 every return path marks an outcome (${marks} marks for ${returns} returns)`,
    marks >= returns,
    marks >= returns
      ? 'including the branches that answer ok:true to prevent account enumeration — the audit row is not visible to the caller, so it records what really happened'
      : `🔴 ${returns - marks} return path(s) would record 'server_error' without being one`)

  // The outcome vocabulary actually present.
  const outcomes = [...route.matchAll(/mark\('([a-z_]+)'/g)].map(m => m[1])
  const want = ['captcha_failed', 'created', 'email_rejected', 'invalid_body', 'missing_fields']
  const missing = want.filter(w => !outcomes.includes(w))
  chk('   ...and the named outcomes are all present',
    missing.length === 0,
    missing.length === 0 ? [...new Set(outcomes)].sort().join(', ') : `🔴 missing: ${missing.join(', ')}`)

  // ── the success screen still requires server confirmation ────────
  // 🔴 This was the HOLD condition in the brief. It must stay true.
  const doneIdx = page.indexOf('setDone(true)')
  const catchIdx = page.indexOf('} catch (e: any) {')
  chk('🔴 setDone(true) is still inside the try, before the catch',
    doneIdx > 0 && catchIdx > doneIdx,
    'the success screen cannot render unless every server write returned')

  // ── the timeout, exercised ───────────────────────────────────────
  console.log('\n── the submit cannot hang ──')
  chk('the submit goes through fetchWithTimeout',
    /fetchWithTimeout\('\/api\/register\/create-user'/.test(page),
    'fetch() has no default timeout; a dropped connection left the promise unsettled')
  chk('   ...and a timeout gets its own message, not the generic one',
    /isFetchTimeout\(e\)/.test(page) && /couldn't reach the server/.test(page),
    '"We couldn\'t reach the server. Check your connection and try again."')

  // A server that accepts the connection and never answers.
  const server = http.createServer(() => { /* deliberately no response */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const t0 = Date.now()
  let caught: unknown = null
  try {
    await fetchWithTimeout(`http://127.0.0.1:${port}/never`, {}, 1200)
  } catch (e) { caught = e }
  const elapsed = Date.now() - t0
  server.close()

  chk('🔴 a server that never answers produces a timeout, not a hang',
    caught instanceof FetchTimeoutError && isFetchTimeout(caught),
    caught ? `${(caught as Error).name} after ${elapsed}ms` : '🔴 the call resolved or hung')
  chk('   ...and it gives up close to the deadline',
    elapsed >= 1100 && elapsed < 4000, `${elapsed}ms for a 1200ms budget`)
  chk('   ...and the default budget is 20s',
    /ms = 20_000/.test(strip(fs.readFileSync('app/lib/fetch-timeout.ts', 'utf8'))),
    'long enough for CAPTCHA verification plus an admin create on mobile')

  // ── the audit action is queryable ────────────────────────────────
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } })
  const { error } = await db.from('audit_logs').select('id').eq('action', 'REGISTRATION_SUBMIT_ATTEMPT').limit(1)
  chk('the new audit action is readable (the column shape accepts it)',
    !error, error ? `🔴 ${error.message}` : "action='REGISTRATION_SUBMIT_ATTEMPT'")

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('🔴', (e as Error).message); process.exit(2) })
