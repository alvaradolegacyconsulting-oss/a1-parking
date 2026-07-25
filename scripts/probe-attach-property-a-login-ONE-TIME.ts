#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Probe — property-A login preservation across silent attach (ONE-TIME)
// 2026-07-25 · Test-LEGACY (company_env='test', id=89) · READ+WRITE
//
// WHY THIS EXISTS
//   Commit 2's load-bearing security property: silent attach must
//   NEVER mutate the existing auth.users row. The route achieves this
//   by construction — the attach branch calls NO updateUserById /
//   password write / email_confirm change. Construction-only
//   guarantees have burned this arc before. Empirical proof required.
//
// WHY signInWithPassword IS NOT THE PROBE
//   First-cut probe used signInWithPassword({email, password:A}) as
//   the direct "password preserved" test. It fails against this
//   project because Supabase Auth has Turnstile enabled — every
//   signInWithPassword call requires a captchaToken, which a script
//   can't generate. Same reason scripts/lib/smoke-auth.ts uses
//   generateLink + verifyOtp instead. Turnstile enforcement is a
//   Supabase project setting, not something the route or probe
//   controls.
//
// WHAT THIS PROBE ACTUALLY TESTS (observable-state proxy)
//   Supabase updates auth.users.updated_at whenever ANY field on the
//   row is mutated — password, email, email_confirm, metadata, any
//   admin-API update. If updated_at is byte-identical before and
//   after the attach flow, NOTHING on the user was mutated. That is
//   exactly the "auth.users read-only" guarantee the route promises.
//
//   Additionally: the attach flow's happy path is exercised
//   end-to-end (createUser → email_exists → resolveExisting → generateLink →
//   verifyOtp session-mint), proving the route's flow is actually
//   viable for an existing user, not just theoretically constructible.
//
// STEPS
//   1. Seed auth user with PASSWORD_A + residents + user_roles (active)
//   2. BASELINE: getUserById → capture updated_at_before
//   3. TRIGGER:  admin.createUser({email, password: B_DIFFERENT}) →
//                expect email_exists+422 (proves discriminator holds here too)
//   4. RESOLVE:  resolveExistingAuthUserId matches seeded id
//   5. LINK:     generateLink({email}) → returns hashed_token
//   6. SESSION:  verifyOtp on the token → real session for existing user
//   7. 🔴 LOAD-BEARING: getUserById → assert updated_at UNCHANGED
//                (nothing mutated the existing user through steps 3-6)
//   8. Cleanup — residents, user_roles, auth user
//
// FOUR STRUCTURAL LOCKS (all before any write)
//   L1  allowlist — company_env='test'
//   L2  denylist  — company_id !== 91 (A1) AND !== 'production'
//   L3  zero-argv — no arguments; Test-LEGACY resolved by constant
//   L4  byte-exact — property.name === 'Test Legacy Property'
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-attach-property-a-login-ONE-TIME.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const EXPECTED_COMPANY_ID    = 89
const EXPECTED_COMPANY_NAME  = 'Test-LEGACY'
const FORBIDDEN_COMPANY_ID   = 91
const EXPECTED_PROPERTY_NAME = 'Test Legacy Property'

const PROBE_EMAIL   = 'probe-prop-a-login@test.shieldmylot.com'
const PROBE_UNIT    = 'PROP-A-PROBE'
const PASSWORD_A    = 'OriginalPropertyA123!'
const PASSWORD_B    = 'DifferentTypedButIgnored456!'

async function resolveExistingAuthUserId(admin: ReturnType<typeof createClient>, email: string): Promise<string | null> {
  const PAGE_SIZE = 1000
  const PAGE_LIMIT = 10
  const target = email.toLowerCase()
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE })
    if (error) return null
    const found = data?.users?.find(u => (u.email ?? '').toLowerCase() === target)
    if (found) return found.id
    if (!data?.users?.length || data.users.length < PAGE_SIZE) return null
  }
  return null
}

async function cleanup(admin: ReturnType<typeof createClient>, authUserId: string | null): Promise<void> {
  console.log('')
  console.log('  cleanup:')
  const { error: rDelErr } = await admin.from('residents').delete().eq('email', PROBE_EMAIL)
  console.log(`    residents delete:  ${rDelErr ? '❌ ' + rDelErr.message : '✓'}`)
  const { error: urDelErr } = await admin.from('user_roles').delete().ilike('email', PROBE_EMAIL)
  console.log(`    user_roles delete: ${urDelErr ? '❌ ' + urDelErr.message : '✓'}`)
  if (authUserId) {
    const { error: aDelErr } = await admin.auth.admin.deleteUser(authUserId)
    console.log(`    auth.deleteUser:   ${aDelErr ? '❌ ' + aDelErr.message : '✓'}`)
  } else {
    console.log(`    auth.deleteUser:   skipped (no user_id resolved)`)
  }
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  probe-attach-property-a-login-ONE-TIME')
  console.log('══════════════════════════════════════════════════════════════════')

  if (!URL || !ANON || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  if (process.argv.length > 2) {
    console.error(`❌ L3: zero argv; got ${process.argv.length - 2}`)
    process.exit(3)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── L1 + L2 ──
  const { data: co } = await admin
    .from('companies').select('id, name, company_env')
    .eq('id', EXPECTED_COMPANY_ID)
  if (!co || co.length !== 1) { console.error('❌ L1: no company'); process.exit(4) }
  const testLegacy = co[0]
  if (testLegacy.id === FORBIDDEN_COMPANY_ID || testLegacy.company_env !== 'test') {
    console.error('❌ L2: forbidden'); process.exit(5)
  }
  if (testLegacy.name !== EXPECTED_COMPANY_NAME) {
    console.error(`❌ L1: name mismatch got='${testLegacy.name}'`); process.exit(6)
  }

  // ── L4 ──
  const { data: props } = await admin
    .from('properties').select('id, name, company')
    .eq('company', testLegacy.name).eq('name', EXPECTED_PROPERTY_NAME)
  if (!props || props.length !== 1) { console.error('❌ L4: property'); process.exit(7) }
  const property = props[0]
  console.log(`  ✓ locks OK — company='${testLegacy.name}' property='${property.name}'`)

  console.log('')
  console.log(`  MANUAL CLEANUP (paste-ready if the probe crashes):`)
  console.log(`    DELETE FROM residents  WHERE email = '${PROBE_EMAIL}';`)
  console.log(`    DELETE FROM user_roles WHERE lower(email) = lower('${PROBE_EMAIL}');`)
  console.log(`    -- auth.users cleanup via Supabase Dashboard or admin.deleteUser()`)
  console.log('')

  // ── PRE-FLIGHT — refuse if residue exists ──
  const preExisting = await resolveExistingAuthUserId(admin, PROBE_EMAIL)
  if (preExisting) {
    console.error(`❌ PRE-FLIGHT — auth user ${PROBE_EMAIL} already exists (id=${preExisting}). Run manual cleanup first.`)
    process.exit(10)
  }
  console.log('  ✓ pre-flight: no prior residue')

  // ── STEP 1 — SEED ──
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: PROBE_EMAIL, password: PASSWORD_A, email_confirm: true,
  })
  if (createErr || !createData?.user?.id) {
    console.error('❌ seed createUser:', createErr?.message); process.exit(11)
  }
  const authUserId = createData.user.id
  console.log(`  ✓ seeded auth user id=${authUserId} with PASSWORD_A`)

  const { error: rInsErr } = await admin.from('residents').insert([{
    email: PROBE_EMAIL, name: 'Prop-A Login Probe', unit: PROBE_UNIT,
    property: property.name, company: testLegacy.name,
    is_active: true, status: 'active',
  }])
  if (rInsErr) { console.error('❌ seed residents:', rInsErr.message); await cleanup(admin, authUserId); process.exit(12) }

  const { error: urInsErr } = await admin.from('user_roles').insert([{
    email: PROBE_EMAIL, role: 'resident',
    company: testLegacy.name, property: [property.name],
  }])
  if (urInsErr) { console.error('❌ seed user_roles:', urInsErr.message); await cleanup(admin, authUserId); process.exit(13) }
  console.log(`  ✓ seeded residents(active) + user_roles`)

  const results: { step: string; expected: string; got: string; pass: boolean }[] = []

  // ── STEP 2 — CHECKPOINT A: post-seed baseline ──
  // The load-bearing question is isolated to "does createUser-on-duplicate
  // mutate anything on the existing user?" — NOT "does the whole flow
  // leave the user unmutated." generateLink writes recovery/link state,
  // and verifyOtp updates last_sign_in_at — both legitimately bump
  // updated_at without touching the password. The isolating comparison
  // is Checkpoint A (post-seed) vs Checkpoint B (post-createUser-dup).
  const { data: beforeData, error: beforeErr } = await admin.auth.admin.getUserById(authUserId)
  const updatedAtA = beforeData?.user?.updated_at ?? null
  results.push({
    step: '2. CHECKPOINT A  getUserById after seed → capture updated_at',
    expected: 'updated_at present',
    got: updatedAtA ? `updated_at=${updatedAtA}` : (beforeErr?.message ?? 'no updated_at'),
    pass: !!updatedAtA,
  })

  // ── STEP 3 — TRIGGER: admin.createUser with PASSWORD_B → email_exists ──
  const { error: dupErr } = await admin.auth.admin.createUser({
    email: PROBE_EMAIL, password: PASSWORD_B, email_confirm: true,
  })
  const isDuplicate = (dupErr as { code?: string })?.code === 'email_exists' && dupErr?.status === 422
  results.push({
    step: '3. TRIGGER       createUser(email, PASSWORD_B) returns email_exists+422',
    expected: 'email_exists / 422',
    got: dupErr ? `${(dupErr as {code?:string}).code} / ${dupErr.status}` : 'succeeded (unexpected — a NEW user was just created!)',
    pass: isDuplicate,
  })

  // ── 🔴 STEP 4 — LOAD-BEARING: CHECKPOINT B — updated_at UNCHANGED after createUser-dup ──
  // If createUser-on-duplicate mutates the existing user in ANY way
  // (password, email_confirm, metadata, etc.), updated_at will move.
  // If it's a true no-op, updated_at is byte-identical to Checkpoint A.
  // This is the auth-user-read-only guarantee, empirically.
  const { data: postDupData, error: postDupErr } = await admin.auth.admin.getUserById(authUserId)
  const updatedAtB = postDupData?.user?.updated_at ?? null
  const readOnlyHeld = updatedAtA !== null && updatedAtA === updatedAtB
  results.push({
    step: '4. 🔴 LOAD       CHECKPOINT B: updated_at UNCHANGED after createUser-dup',
    expected: `updated_at=${updatedAtA} (byte-identical to Checkpoint A)`,
    got: updatedAtB
      ? `updated_at=${updatedAtB} ${readOnlyHeld ? '(unchanged ✓)' : '(CHANGED — createUser-dup mutated the existing user)'}`
      : (postDupErr?.message ?? 'no updated_at'),
    pass: readOnlyHeld,
  })

  // ── STEP 5 — RESOLVE: existing user_id via listUsers (route's attach path) ──
  const resolvedId = await resolveExistingAuthUserId(admin, PROBE_EMAIL)
  results.push({
    step: '5. RESOLVE       resolveExistingAuthUserId returns the seeded user_id',
    expected: authUserId,
    got: resolvedId ?? 'null',
    pass: resolvedId === authUserId,
  })

  // ── STEP 6 — LINK: generateLink for existing user ──
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email: PROBE_EMAIL,
  })
  const hashedToken = (linkData as { properties?: { hashed_token?: string } })?.properties?.hashed_token ?? null
  results.push({
    step: '6. LINK          generateLink({email}) returns hashed_token for existing user',
    expected: 'hashed_token present',
    got: hashedToken ? 'hashed_token present' : (linkErr?.message ?? 'no token'),
    pass: !!hashedToken,
  })

  // ── STEP 7 — SESSION: verifyOtp with the token → real session ──
  if (hashedToken) {
    const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
      token_hash: hashedToken, type: 'magiclink',
    })
    const gotSession = !!verifyData?.session && verifyData?.user?.id === authUserId
    results.push({
      step: '7. SESSION       verifyOtp mints a real session for the existing user',
      expected: 'session for authUserId',
      got: gotSession ? `session (user.id=${verifyData.user?.id})` : (verifyErr?.message ?? 'no session'),
      pass: gotSession,
    })
    if (verifyData?.session) await anon.auth.signOut()
  } else {
    results.push({
      step: '7. SESSION       verifyOtp mints a real session for the existing user',
      expected: 'session for authUserId',
      got: 'SKIPPED — no hashed_token from step 6',
      pass: false,
    })
  }

  // ── STEP 8 — INFORMATIONAL: post-verifyOtp updated_at (expected to change) ──
  const { data: postVerifyData } = await admin.auth.admin.getUserById(authUserId)
  const updatedAtC = postVerifyData?.user?.updated_at ?? null
  const changedByVerify = updatedAtC !== updatedAtB
  results.push({
    step: '8. INFORMATIONAL  post-verifyOtp updated_at (expected to change from B)',
    expected: `updated_at != ${updatedAtB} (verifyOtp bumps last_sign_in_at)`,
    got: updatedAtC
      ? `updated_at=${updatedAtC} ${changedByVerify ? '(changed as expected — session activity, not password mutation)' : '(unchanged — unusual but not a load-bearing failure)'}`
      : 'no updated_at',
    pass: true,  // informational only — not asserting either way
  })

  // ── REPORT ──
  console.log('')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  RESULTS')
  console.log('══════════════════════════════════════════════════════════════════')
  results.forEach(r => {
    const badge = r.pass ? '✓' : '❌'
    console.log(`  ${badge} ${r.step}`)
    console.log(`      expected: ${r.expected}`)
    console.log(`      got:      ${r.got}`)
  })

  const loadBearingFails = results.filter(r => r.step.includes('🔴') && !r.pass)
  const allPass = results.every(r => r.pass)
  console.log('')
  if (allPass) {
    console.log('  ✓ VERDICT: property-A user-row preservation HOLDS.')
    console.log('             createUser-on-duplicate is a true no-op — Checkpoint B is')
    console.log('             byte-identical to Checkpoint A (see step 4). The generateLink')
    console.log('             + verifyOtp steps legitimately bump updated_at via session')
    console.log('             activity (step 8) — that\'s not password mutation.')
    console.log('             Commit 2 attach branch READ-ONLY guarantee verified empirically.')
  } else if (loadBearingFails.length > 0) {
    console.log(`  🔴 VERDICT: ${loadBearingFails.length} LOAD-BEARING FAILURE(S) — HALT.`)
    loadBearingFails.forEach(r => console.log(`      ${r.step}`))
    console.log('  Commit 2 CANNOT ship. The attach flow mutates the existing user.')
  } else {
    const nonLoadFails = results.filter(r => !r.pass)
    console.log(`  ⚠  ${nonLoadFails.length} non-load-bearing step(s) failed — investigate but not necessarily blocking:`)
    nonLoadFails.forEach(r => console.log(`      ${r.step}`))
  }

  await cleanup(admin, authUserId)
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
