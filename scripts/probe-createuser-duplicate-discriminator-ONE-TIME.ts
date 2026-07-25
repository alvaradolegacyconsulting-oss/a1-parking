#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Probe — exact error shape from admin.createUser on a KNOWN duplicate
// 2026-07-25 · Test-LEGACY (legacy-manager@test.shieldmylot.com)
//
// WHY THIS EXISTS
//   Re-registration attach depends on catching the "email already
//   exists" case from admin.createUser and branching to attach.
//   The discriminator must be an EXACT error code/status, not a
//   message substring — Supabase can reword messages any release
//   and a message-match would silently fail-open (attach never
//   fires, existing emails get "create failed" errors).
//
//   The exact shape has never been observed against this project's
//   Supabase version. This probe captures it once so the attach
//   branch keys on the real value.
//
// SAFETY
//   • Read-only in effect: calls admin.createUser on an email that
//     already exists → 4xx error returned, NO auth.users row created,
//     NO existing user mutated.
//   • Target email hardcoded to a known Test-LEGACY user. No argv,
//     no env-driven target. Cannot be redirected.
//   • ALLOW_SMOKE_ON_PRODUCTION not consulted — this probe cannot
//     touch production regardless because the target email is
//     hardcoded to a test-tenant address.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-createuser-duplicate-discriminator-ONE-TIME.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

// Hardcoded — known Test-LEGACY user, exists in auth.users.
const KNOWN_DUP_EMAIL = 'legacy-manager@test.shieldmylot.com'

async function main() {
  if (!URL || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  if (process.argv.length > 2) {
    console.error(`❌ zero argv; got ${process.argv.length - 2}`)
    process.exit(3)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  probe-createuser-duplicate-discriminator-ONE-TIME')
  console.log(`  target: ${KNOWN_DUP_EMAIL} (known existing Test-LEGACY user)`)
  console.log('══════════════════════════════════════════════════════════════════')

  const { data, error } = await admin.auth.admin.createUser({
    email:         KNOWN_DUP_EMAIL,
    password:      'x'.repeat(24),   // never used — createUser fails on dup before consuming
    email_confirm: true,
  })

  if (!error) {
    console.error('')
    console.error('❌ UNEXPECTED — createUser SUCCEEDED. That means:')
    console.error('   - the target email did NOT already exist, OR')
    console.error('   - a NEW auth.users row was just created')
    console.error(`   returned user id: ${data?.user?.id}`)
    console.error('')
    console.error('   Fetch + delete this user via Supabase Dashboard before retrying:')
    console.error(`     SELECT id FROM auth.users WHERE email = '${KNOWN_DUP_EMAIL}';`)
    process.exit(10)
  }

  console.log('')
  console.log('  ✓ createUser returned an error (expected — duplicate)')
  console.log('')
  console.log('  Discriminator readout:')
  console.log('  ┌──────────────────────────────────────────────────────────────')
  console.log(JSON.stringify({
    name:    error.name,
    status:  error.status,
    code:    (error as { code?: unknown }).code,
    message: error.message,
  }, null, 2).split('\n').map(l => '  │  ' + l).join('\n'))
  console.log('  └──────────────────────────────────────────────────────────────')
  console.log('')
  console.log('  Preferred discriminator (in order):')
  console.log('    1. error.code === "email_exists"        (SDK v2.40+)')
  console.log('    2. error.status === 422                 (typical)')
  console.log('    3. error.status === 400 + message match (fallback only)')
  console.log('')
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
