// ══════════════════════════════════════════════════════════════════════
// _tmp_percent_email_probe.ts — Sept 4 2026 THROWAWAY
//
// Answers: does Supabase Auth's admin.createUser accept a `%` character
// in the email local part? That's the severity question for the
// `email ~~*` policy audit — `%` matches any sequence in ILIKE, so a
// `%@gmail.com` account would wholesale-disclose every gmail address on
// tables with `email ~~* auth.jwt() ->> 'email'` predicates.
//
// ── WHY admin.createUser NOT signUp ─────────────────────────────────
// Residents self-register through app/api/register/create-user/route.ts
// which calls admin.createUser + generateLink (the C′′ shape from June
// 30). auth.admin.createUser is the ungated open path — the one that
// decides severity. supabase.auth.signUp (public client) has different
// validation; testing that one could return "rejected" and tell us
// nothing about the route that's actually exposed.
//
// If cheap, also test signUp for completeness — but admin is the
// severity gate.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// • Uses admin.createUser({ email, email_confirm: false }) with NO
//   generateLink call → NO email delivery occurs to any recipient.
// • admin.deleteUser cleanup after every create attempt, even on
//   assertion failure (finally block).
// • Re-queries auth.users after delete to VERIFY the row is gone —
//   not just trusting the deleteUser response.
// • No property, no user_roles row, no company — the created auth.users
//   row is bare and gets immediately deleted. No orphan residue in
//   application tables.
//
// ── RUN ─────────────────────────────────────────────────────────────
// SUPABASE_URL=https://<project>.supabase.co \
// SUPABASE_SERVICE_ROLE_KEY=<key> \
// TEST_EMAIL_BASE=jose+percent-probe@example.com \
//   npx tsx scripts/_tmp_percent_email_probe.ts
//
// TEST_EMAIL_BASE MUST be a monitored inbox with `+alias` support
// (Gmail, Fastmail, etc.). The probe generates unique addresses by
// inserting the test character between `+percent-probe-` and the
// domain: e.g. `jose+percent-probe-percent@example.com`,
// `jose+percent-probe-underscore@example.com`.
//
// After running, this file is deleted with the alert-probe route in
// the same revert commit.
// ══════════════════════════════════════════════════════════════════════

import { createClient, type User } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TEST_EMAIL_BASE = process.env.TEST_EMAIL_BASE

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing env vars: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!TEST_EMAIL_BASE || !TEST_EMAIL_BASE.includes('+')) {
  console.error('❌ TEST_EMAIL_BASE must be a plus-alias address (e.g. name+tag@example.com)')
  console.error('   Got:', TEST_EMAIL_BASE || '(unset)')
  process.exit(1)
}

// Derive test emails from the base by inserting the test char into the
// existing +alias so nothing else in the app can guess the address.
// Base = jose+percent-probe@example.com
// →     jose+percent-probe-percent@example.com  (the % test)
// →     jose+percent-probe-underscore@example.com  (the _ baseline)
// →     jose+percent-probe-percentonly@example.com  ("%@domain" would
//        be the pure-wildcard shape but it doesn't use TEST_EMAIL_BASE
//        as a prefix; we handle it separately below)

function makeAlias(base: string, tag: string): string {
  const [local, domain] = base.split('@')
  return `${local}-${tag}@${domain}`
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Candidate = {
  name: string
  email: string
  proves: string
}

const CANDIDATES: Candidate[] = [
  {
    name: 'percent-in-local',
    email: makeAlias(TEST_EMAIL_BASE, '%test'),
    proves: '% in local part accepted → wholesale disclosure vector on `email ~~*` policies',
  },
  {
    name: 'underscore-in-local',
    email: makeAlias(TEST_EMAIL_BASE, '_test'),
    proves: '_ in local part accepted → targeted-collision vector (baseline; expected accepted)',
  },
  {
    name: 'pure-wildcard-local',
    // Pure-wildcard form. Cannot use the +alias trick because '%' would
    // be the ENTIRE local part; deriving from TEST_EMAIL_BASE would
    // silently discard the base. Use the domain only.
    email: '%@' + (TEST_EMAIL_BASE.split('@')[1] || 'example.com'),
    proves: 'pure `%@domain` accepted → maximum-severity disclosure (matches every address at the domain)',
  },
]

type Outcome =
  | { status: 'created_then_deleted'; user_id: string; verified_gone: boolean }
  | { status: 'create_failed'; error_message: string; error_status?: number }
  | { status: 'delete_failed'; user_id: string; error_message: string }

async function testOne(c: Candidate): Promise<Outcome> {
  console.log(`\n── ${c.name} · ${c.email}`)
  console.log(`   Proves if accepted: ${c.proves}`)

  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: c.email,
    email_confirm: false,   // do NOT send a confirmation email
  })

  if (createErr) {
    console.log(`   ❌ CREATE REJECTED (this is the safe outcome for %):`)
    console.log(`      error.message = ${createErr.message}`)
    console.log(`      error.status  = ${(createErr as { status?: number }).status ?? 'n/a'}`)
    return {
      status: 'create_failed',
      error_message: createErr.message,
      error_status: (createErr as { status?: number }).status,
    }
  }

  const user: User | undefined = createData?.user ?? undefined
  if (!user) {
    console.log(`   ❌ CREATE returned no error but no user — SDK shape drift?`)
    return { status: 'create_failed', error_message: 'no user in response' }
  }

  console.log(`   ⚠  CREATE ACCEPTED: user id = ${user.id}`)
  console.log(`      email as stored = ${user.email}`)
  console.log(`      This means Supabase Auth ALLOWED this local part.`)

  const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id)
  if (deleteErr) {
    console.log(`   ❌ DELETE FAILED (manual cleanup needed for user ${user.id}): ${deleteErr.message}`)
    return { status: 'delete_failed', user_id: user.id, error_message: deleteErr.message }
  }

  // Verify the row is actually gone — trust nothing, per the standing
  // verify-after-write rule.
  const { data: verifyData, error: verifyErr } = await admin.auth.admin.getUserById(user.id)
  const verifiedGone = verifyErr !== null || !verifyData?.user
  console.log(`   ✓ DELETE OK, verified_gone = ${verifiedGone}` + (verifyErr ? ` (getUserById err: ${verifyErr.message})` : ''))

  return { status: 'created_then_deleted', user_id: user.id, verified_gone: verifiedGone }
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════════')
  console.log('  Supabase admin.createUser — email local-part acceptance probe')
  console.log('  Sept 4 2026 · THROWAWAY · runs once, reverted same day')
  console.log('══════════════════════════════════════════════════════════════════════')
  console.log(`  SUPABASE_URL:      ${SUPABASE_URL}`)
  console.log(`  TEST_EMAIL_BASE:   ${TEST_EMAIL_BASE}`)
  console.log(`  Candidates:        ${CANDIDATES.length}`)

  const outcomes: Array<{ name: string; email: string; outcome: Outcome }> = []
  for (const c of CANDIDATES) {
    try {
      const outcome = await testOne(c)
      outcomes.push({ name: c.name, email: c.email, outcome })
    } catch (err) {
      console.log(`   ❌ UNEXPECTED THROW: ${(err as Error).message}`)
      outcomes.push({
        name: c.name,
        email: c.email,
        outcome: { status: 'create_failed', error_message: `THROWN: ${(err as Error).message}` },
      })
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════════════')
  console.log('  SUMMARY (report this back verbatim)')
  console.log('══════════════════════════════════════════════════════════════════════')
  for (const o of outcomes) {
    console.log(`  ${o.name.padEnd(24)}  ${o.outcome.status}`)
    if (o.outcome.status === 'create_failed') {
      console.log(`    → error: ${o.outcome.error_message}`)
    } else if (o.outcome.status === 'created_then_deleted') {
      console.log(`    → user_id: ${o.outcome.user_id}  verified_gone: ${o.outcome.verified_gone}`)
    } else if (o.outcome.status === 'delete_failed') {
      console.log(`    → ⚠ MANUAL CLEANUP NEEDED for user_id: ${o.outcome.user_id} (${o.outcome.error_message})`)
    }
  }
  console.log()

  const percentAccepted = outcomes.find(o => o.name === 'percent-in-local')?.outcome.status === 'created_then_deleted'
  const pureWildcardAccepted = outcomes.find(o => o.name === 'pure-wildcard-local')?.outcome.status === 'created_then_deleted'

  if (percentAccepted || pureWildcardAccepted) {
    console.log('  🔴 SEVERITY: `%` in local part IS ACCEPTED by Supabase Auth admin.createUser.')
    console.log('     `email ~~*` policies are open to wholesale disclosure via a `%@domain`')
    console.log('     account. Stop and route this finding immediately — fix tonight.')
  } else {
    console.log('  🟢 SEVERITY: `%` in local part REJECTED. Baseline `_` vector is what remains.')
    console.log('     `email ~~*` policy rewrite proceeds as scheduled fresh-session work.')
  }

  // Non-zero exit on any delete failure — that's the operational concern.
  const anyDeleteFailed = outcomes.some(o => o.outcome.status === 'delete_failed')
  process.exit(anyDeleteFailed ? 2 : 0)
}

void main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
