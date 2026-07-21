#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Smoke — B2-1 C1: company_name_available under real user JWT +
//                  route-wiring inspection + Stripe non-invocation
// 2026-07-21 · Filed after Mateo's route-layer smoke request
//
// WHY THIS SHAPE (Option D per the C1 smoke-approach discussion)
//   The route /api/signup/create-checkout-session cannot be hit
//   end-to-end without either (A) flipping stripe_billing_enabled +
//   public_signup_open true on the ONE shared Supabase project
//   (opens real self-serve on prod for the flip window — A1 is
//   live), (B) adding a bypass token to the route (production code
//   change for testing), or (C) standing up a scratch Supabase
//   project (multi-hour infra). None are appropriate for a
//   fast-follow smoke.
//
//   D covers what CAN be proven with zero prod risk:
//     • The RPC works under a real user JWT (not just service_role
//       as VQ.D proved).
//     • The route source code correctly wires:
//         - calls the RPC with intended.company_name unchanged
//         - checks nameAvailable === false
//         - 303-redirects to /signup/verify?error=name_taken
//         - returns BEFORE any Stripe API call
//     • No Stripe test-mode Checkout Session was created by us
//       (guardrail — we didn't hit the route, so nothing should be
//       there; this proves the smoke itself created nothing).
//
//   What D does NOT prove:
//     • That the deployed route runtime actually invokes the RPC.
//       Source-code inspection catches wiring bugs at development
//       time; runtime proof would require A/B/C.
//
// APPROACH
//   1. As service_role, pick any existing companies.name to use as
//      the "duplicate" test case. Deterministic + safe (no writes).
//   2. sessionAs(TEST_USER_EMAIL) — real user JWT via magic-link
//      dance (matches smoke-accept-saas-agreement pattern).
//   3. Under the user JWT, call company_name_available() with 7
//      variants (exact / lowercase / uppercase / whitespace-padded /
//      novel random / NULL / empty). Assert each expected result.
//   4. Read route source; assert:
//        - .rpc('company_name_available' present
//        - p_name: intended.company_name — no .trim() or .toLowerCase()
//          transform between intended and the RPC call
//        - /signup/verify?error=name_taken literal present
//        - redirect appears BEFORE any stripe.checkout.sessions.create
//   5. Query test-mode Stripe: sessions.list created within last 60s
//      whose metadata.company_name matches any of our probe strings.
//      Assert none.
//
// SAFETY
//   • Reads only (RPC is STABLE + read-only; source-file readFileSync;
//     Stripe list query).
//   • No test-mode Stripe object creation. No auth.users creation.
//   • No user_roles / companies writes.
//   • Session against an existing test user (Test-LEGACY CA), same
//     account used by smoke-accept-saas-agreement.
//
// USAGE
//   STRIPE_MODE=test npx tsx --env-file=.env.local scripts/smoke-b2-1-c1-name-available.ts
//
// ENV
//   NEXT_PUBLIC_SUPABASE_URL      — target project
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — for the session-carrying client
//   SUPABASE_SERVICE_ROLE_KEY     — for sessionAs internal + read-back
//   STRIPE_TEST_SECRET_KEY        — for the Stripe non-invocation query
// ════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Stripe from 'stripe'
import { sessionAs } from './lib/smoke-auth'

const TEST_USER_EMAIL = 'legacy-ca-2@test.shieldmylot.com'  // Test-LEGACY CA — pre-existing test user
const ROUTE_PATH      = resolve(process.cwd(), 'app/api/signup/create-checkout-session/route.ts')

// Probe strings computed at run-time from an existing companies row.
interface ProbeCase {
  label:    string
  input:    string | null
  expected: boolean
  reason:   string
}

// ────────────────────────────────────────────────────────────────────
// Utility — colored console output for at-a-glance pass/fail scanning.
// ────────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const DIM   = '\x1b[2m'
const RESET = '\x1b[0m'

let failures = 0
function pass(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`) }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); failures++ }

// ════════════════════════════════════════════════════════════════════
// STAGE 1 — Setup: pick an existing companies row as the duplicate probe
// ════════════════════════════════════════════════════════════════════

async function pickProbeCompany(admin: import('@supabase/supabase-js').SupabaseClient): Promise<string> {
  // Any row will do. LIMIT 1 with ORDER for determinism across runs.
  // Prefer a non-A1 row to keep the probe visibly distinct from the
  // live customer, though it doesn't matter functionally.
  const { data, error } = await admin
    .from('companies')
    .select('id, name, company_env')
    .neq('company_env', 'production')  // prefer test/demo rows
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`pickProbeCompany: ${error.message}`)
  if (!data) {
    // Fallback: any row at all
    const { data: any, error: anyErr } = await admin
      .from('companies')
      .select('name')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (anyErr || !any) throw new Error(`pickProbeCompany: no companies rows found`)
    return any.name as string
  }
  return data.name as string
}

// ════════════════════════════════════════════════════════════════════
// STAGE 2 — RPC-layer smoke under real user JWT
// ════════════════════════════════════════════════════════════════════

async function runRpcSmoke(
  session: Awaited<ReturnType<typeof sessionAs>>,
  existingName: string,
): Promise<ProbeCase[]> {
  const cases: ProbeCase[] = [
    { label: 'exact_existing',           input: existingName,                                                     expected: false, reason: 'row exists — must block' },
    { label: 'lowercase_variant',        input: existingName.toLowerCase(),                                       expected: false, reason: 'index normalizes lower() — must block' },
    { label: 'uppercase_variant',        input: existingName.toUpperCase(),                                       expected: false, reason: 'index normalizes lower() — must block' },
    { label: 'whitespace_padded',        input: `  ${existingName}  `,                                            expected: false, reason: 'index normalizes trim() — must block' },
    { label: 'novel_random_uuid',        input: `__c1_probe_${Math.random().toString(36).slice(2)}_${Date.now()}`, expected: true,  reason: 'not in table — must allow' },
    { label: 'null_input',               input: null,                                                             expected: false, reason: 'malformed — must block' },
    { label: 'empty_string',             input: '',                                                               expected: false, reason: 'malformed — must block' },
  ]

  console.log(`\n${DIM}─── Stage 2: RPC-layer smoke (${cases.length} cases, under real user JWT) ───${RESET}`)
  console.log(`${DIM}    caller: ${session.email} (userId=${session.userId})${RESET}`)
  console.log(`${DIM}    probe:  "${existingName}"${RESET}\n`)

  for (const c of cases) {
    const { data, error } = await session.client.rpc('company_name_available', { p_name: c.input })
    if (error) {
      fail(`  [${c.label}] RPC error: ${error.message}`)
      continue
    }
    if (data === c.expected) {
      pass(`  [${c.label}] returned ${JSON.stringify(data)} · ${c.reason}`)
    } else {
      fail(`  [${c.label}] expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(data)} · ${c.reason}`)
    }
  }
  return cases
}

// ════════════════════════════════════════════════════════════════════
// STAGE 3 — Code-inspection assertions on the route source
// ════════════════════════════════════════════════════════════════════

function runRouteSourceInspection(): void {
  console.log(`\n${DIM}─── Stage 3: route source inspection (${ROUTE_PATH}) ───${RESET}\n`)

  let src: string
  try {
    src = readFileSync(ROUTE_PATH, 'utf8')
  } catch (e) {
    fail(`  cannot read route source: ${(e as Error).message}`)
    return
  }

  // 3a — the RPC is called
  if (src.includes(`.rpc('company_name_available'`)) {
    pass(`  route source calls .rpc('company_name_available')`)
  } else {
    fail(`  route source does NOT call .rpc('company_name_available') — did the pre-flight get removed?`)
  }

  // 3b — the raw intended.company_name is passed through (no pre-mangling)
  //      grep for the exact literal pattern; if someone adds .trim() or
  //      .toLowerCase() between intended and the RPC arg, this fails.
  if (src.includes(`p_name: intended.company_name`)) {
    pass(`  route passes intended.company_name to RPC unchanged (no .trim() / .toLowerCase() drift)`)
  } else {
    fail(`  route does NOT pass intended.company_name directly — check for pre-mangling that would break the whitespace-padded case`)
  }

  // 3c — the redirect URL literal is present
  if (src.includes(`/signup/verify?error=name_taken`)) {
    pass(`  route contains literal /signup/verify?error=name_taken redirect target`)
  } else {
    fail(`  route does NOT contain the expected redirect target — Verify page's ?error=name_taken handler won't fire`)
  }

  // 3d — the redirect appears BEFORE any stripe.checkout.sessions.create.
  //      Line-number ordering test; source order matters here because the
  //      redirect is an early return.
  const lines = src.split('\n')
  let redirectLine = -1
  let stripeLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (redirectLine === -1 && lines[i].includes(`/signup/verify?error=name_taken`)) redirectLine = i + 1
    if (stripeLine === -1 && lines[i].includes(`stripe.checkout.sessions.create`)) stripeLine = i + 1
  }
  if (redirectLine === -1) {
    fail(`  cannot locate redirect line for source-order check`)
  } else if (stripeLine === -1) {
    // If stripe.checkout.sessions.create isn't in the file at all, that's
    // ALSO suspicious (route must eventually call Stripe on success).
    fail(`  cannot locate stripe.checkout.sessions.create line — expected the route to still call Stripe on success`)
  } else if (redirectLine < stripeLine) {
    pass(`  source order OK: redirect at L${redirectLine} appears before stripe.checkout.sessions.create at L${stripeLine}`)
  } else {
    fail(`  source order WRONG: redirect at L${redirectLine} appears AFTER stripe.checkout.sessions.create at L${stripeLine} — early-return invariant broken`)
  }
}

// ════════════════════════════════════════════════════════════════════
// STAGE 4 — Stripe test-mode: no session created by this smoke
// ════════════════════════════════════════════════════════════════════

async function runStripeNonInvocationCheck(
  probeStrings: string[],
  probeStartUnix: number,
): Promise<void> {
  console.log(`\n${DIM}─── Stage 4: Stripe test-mode non-invocation guardrail ───${RESET}\n`)

  const stripeKey = process.env.STRIPE_TEST_SECRET_KEY
  if (!stripeKey) {
    fail(`  STRIPE_TEST_SECRET_KEY not in env — cannot query Stripe. Set it before re-running.`)
    return
  }
  if (!stripeKey.startsWith('sk_test_')) {
    fail(`  STRIPE_TEST_SECRET_KEY does not begin with sk_test_ — refusing to hit Stripe with a possibly-live key.`)
    return
  }

  const stripe = new Stripe(stripeKey)
  const list = await stripe.checkout.sessions.list({
    limit: 100,
    created: { gte: probeStartUnix },
  })
  const probeSet = new Set(probeStrings.filter(s => s != null && s.length > 0).map(s => s.toLowerCase()))
  const matches = list.data.filter(sess => {
    const meta = sess.metadata ?? {}
    const md = sess.subscription_details?.metadata ?? {}
    const fields = [
      typeof sess.customer_email === 'string' ? sess.customer_email : null,
      typeof meta.intended_tier_json === 'string' ? meta.intended_tier_json : null,
      typeof md.company_name === 'string' ? md.company_name : null,
    ].filter(Boolean) as string[]
    return fields.some(f => probeSet.has(f.toLowerCase()) || Array.from(probeSet).some(p => f.toLowerCase().includes(p.toLowerCase())))
  })
  if (matches.length === 0) {
    pass(`  no test-mode Checkout Sessions created since smoke start whose metadata mentions any probe string (${probeSet.size} unique probes checked, ${list.data.length} sessions since ${new Date(probeStartUnix * 1000).toISOString()})`)
  } else {
    fail(`  ${matches.length} test-mode Checkout Session(s) reference a probe string:`)
    for (const s of matches) console.log(`      · ${s.id}  status=${s.status}  email=${s.customer_email}  metadata=${JSON.stringify(s.metadata)}`)
  }
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  smoke — B2-1 C1 company_name_available (route wiring proof, D)')
  console.log('══════════════════════════════════════════════════════════════════')

  const probeStartUnix = Math.floor(Date.now() / 1000)

  // Stage 1
  const session = await sessionAs(TEST_USER_EMAIL, { targetEnv: 'test' })
  const existingName = await pickProbeCompany(session.admin)
  console.log(`\n${DIM}Setup: probe company (existing row) = "${existingName}"${RESET}`)
  console.log(`${DIM}       probe start (unix) = ${probeStartUnix}${RESET}`)

  // Stage 2
  const cases = await runRpcSmoke(session, existingName)

  // Stage 3
  runRouteSourceInspection()

  // Stage 4
  const probeStrings = cases.map(c => c.input).filter((s): s is string => s !== null && s.length > 0)
  await runStripeNonInvocationCheck(probeStrings, probeStartUnix)

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${DIM}══════════════════════════════════════════════════════════════════${RESET}`)
  if (failures === 0) {
    console.log(`${GREEN}✓ ALL CHECKS PASSED${RESET} — B2-1 C1 route wiring proven under Option D scope.`)
    console.log(`${DIM}  Un-proven by D (would require A/B/C): deployed-route runtime RPC invocation.${RESET}`)
    process.exit(0)
  } else {
    console.log(`${RED}✗ ${failures} CHECK(S) FAILED${RESET} — investigate before proceeding to B2-1 C2.`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`\n${RED}FATAL${RESET}: ${(e as Error).message}`)
  console.error(e)
  process.exit(2)
})
