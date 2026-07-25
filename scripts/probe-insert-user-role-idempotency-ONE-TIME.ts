#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Probe — insert_user_role idempotency, both paths (ONE-TIME)
// 2026-07-25 · Test-LEGACY (company_env='test', id=89) · READ+WRITE
//
// WHY THIS EXISTS
//   Verifies the 2026-07-25 idempotency migration for the RPC. Two
//   paths tested, row-counted:
//
//   CREATE-PATH (LOAD-BEARING GATE):
//     Brand-new email → sessionAs (magiclink verify) → invoke the RPC →
//     count user_roles rows for that email. MUST be 1.
//
//     Failure mode: idempotency branch accidentally short-circuits the
//     self-reg-NULL branch → new resident gets no role row → RLS locks
//     them out of their own data. This is the 23-residents-risk gate
//     Mateo flagged.
//
//   ATTACH-PATH (redundant-write elimination):
//     Existing resident → invoke the RPC (own email, resident role) →
//     idempotency branch short-circuits → no new row → count remains 1.
//     Then invoke with DIFFERENT company/property to prove the
//     idempotency doesn't discriminate on p_company/p_property.
//
// FOUR STRUCTURAL LOCKS
//   L1  allowlist — company_env='test'
//   L2  denylist  — company_id !== 91 (A1)
//   L3  zero-argv — no arguments
//   L4  byte-exact — property.name === 'Test Legacy Property'
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-insert-user-role-idempotency-ONE-TIME.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { sessionAs } from './lib/smoke-auth'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const EXPECTED_COMPANY_ID    = 89
const EXPECTED_COMPANY_NAME  = 'Test-LEGACY'
const FORBIDDEN_COMPANY_ID   = 91
const EXPECTED_PROPERTY_NAME = 'Test Legacy Property'

const CREATE_EMAIL  = 'probe-idem-create@test.shieldmylot.com'
const ATTACH_EMAIL  = 'probe-idem-attach@test.shieldmylot.com'

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  probe-insert-user-role-idempotency-ONE-TIME')
  console.log('══════════════════════════════════════════════════════════════════')

  if (!URL || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
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
  console.log(`    DELETE FROM user_roles WHERE lower(email) IN (lower('${CREATE_EMAIL}'), lower('${ATTACH_EMAIL}'));`)
  console.log(`    DELETE FROM residents  WHERE email IN ('${CREATE_EMAIL}', '${ATTACH_EMAIL}');`)
  console.log(`    -- auth.users cleanup via admin.deleteUser()`)
  console.log('')

  const results: { step: string; expected: string; got: string; pass: boolean; loadBearing?: boolean }[] = []
  let createAuthId: string | null = null
  let attachAuthId: string | null = null

  try {
    // ══════════════════════════════════════════════════════════════
    // CREATE PATH — brand-new email, no prior user_roles row
    // ══════════════════════════════════════════════════════════════

    // Seed: create auth user (no residents/user_roles rows yet).
    const { data: cData, error: cErr } = await admin.auth.admin.createUser({
      email: CREATE_EMAIL, password: 'x'.repeat(24), email_confirm: true,
    })
    if (cErr || !cData?.user?.id) { console.error('❌ create seed:', cErr?.message); process.exit(10) }
    createAuthId = cData.user.id
    console.log(`  ✓ CREATE SEED — new auth user id=${createAuthId} (NO user_roles row seeded)`)

    // sessionAs needs a user_roles row (throws otherwise) — so this path
    // can't use sessionAs directly. Instead, mint a session manually via
    // generateLink + verifyOtp, matching sessionAs internals.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink', email: CREATE_EMAIL,
    })
    const hashedToken = (linkData as { properties?: { hashed_token?: string } })?.properties?.hashed_token
    if (!hashedToken) { console.error('❌ create generateLink:', linkErr?.message); process.exit(11) }

    const anon = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
      token_hash: hashedToken, type: 'magiclink',
    })
    if (verifyErr || !verifyData?.session) { console.error('❌ create verifyOtp:', verifyErr?.message); process.exit(12) }

    const createSess = createClient(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${verifyData.session.access_token}` } },
    })

    // Call insert_user_role AS the new user — self-reg-NULL branch admits.
    const { error: cRpcErr } = await createSess.rpc('insert_user_role', {
      p_email: CREATE_EMAIL, p_role: 'resident',
      p_company: testLegacy.name, p_property: [property.name],
    })
    results.push({
      step: 'CREATE.1  insert_user_role via self-reg-NULL branch',
      expected: 'succeeds (no error)',
      got: cRpcErr ? `error: ${cRpcErr.message}` : 'succeeded',
      pass: !cRpcErr,
    })

    // ROW COUNT — LOAD-BEARING GATE
    const { count: createCount } = await admin
      .from('user_roles').select('*', { count: 'exact', head: true })
      .ilike('email', CREATE_EMAIL).eq('role', 'resident')
    results.push({
      step: '🔴 CREATE.2  user_roles count WHERE lower(email)=CREATE + role=resident',
      expected: '1 (load-bearing — <1 means new residents locked out of RLS)',
      got: String(createCount),
      pass: createCount === 1,
      loadBearing: true,
    })

    await anon.auth.signOut().catch(() => {})

    // ══════════════════════════════════════════════════════════════
    // ATTACH PATH — existing resident, existing user_roles row
    // ══════════════════════════════════════════════════════════════

    // Seed: full existing-resident state (auth + user_roles + residents).
    const { data: aData, error: aErr } = await admin.auth.admin.createUser({
      email: ATTACH_EMAIL, password: 'x'.repeat(24), email_confirm: true,
    })
    if (aErr || !aData?.user?.id) { console.error('❌ attach seed:', aErr?.message); process.exit(20) }
    attachAuthId = aData.user.id
    await admin.from('residents').insert([{
      email: ATTACH_EMAIL, name: 'Attach Probe', unit: 'PROBE-A',
      property: property.name, company: testLegacy.name,
      is_active: true, status: 'active',
    }])
    await admin.from('user_roles').insert([{
      email: ATTACH_EMAIL, role: 'resident',
      company: testLegacy.name, property: [property.name],
    }])
    console.log(`  ✓ ATTACH SEED — existing user id=${attachAuthId} with 1 existing user_roles row`)

    // sessionAs the existing user
    const session = await sessionAs(ATTACH_EMAIL, { targetEnv: 'test' })

    // Call insert_user_role AS existing resident — idempotency branch fires.
    const { error: aRpcErr } = await session.client.rpc('insert_user_role', {
      p_email: ATTACH_EMAIL, p_role: 'resident',
      p_company: testLegacy.name, p_property: [property.name],
    })
    results.push({
      step: 'ATTACH.1  insert_user_role via new idempotency branch (same company/property)',
      expected: 'succeeds silently (no error, no exception)',
      got: aRpcErr ? `error: ${aRpcErr.message}` : 'succeeded',
      pass: !aRpcErr,
    })

    // Call AGAIN with DIFFERENT company/property — idempotency ignores p_company/p_property.
    const { error: a2RpcErr } = await session.client.rpc('insert_user_role', {
      p_email: ATTACH_EMAIL, p_role: 'resident',
      p_company: 'Fictional Cross-Company', p_property: ['Fictional Property'],
    })
    results.push({
      step: 'ATTACH.2  insert_user_role AGAIN with different p_company/p_property',
      expected: 'still succeeds silently (idempotency does not discriminate on company/property)',
      got: a2RpcErr ? `error: ${a2RpcErr.message}` : 'succeeded',
      pass: !a2RpcErr,
    })

    // ROW COUNT — no redundant rows
    const { count: attachCount } = await admin
      .from('user_roles').select('*', { count: 'exact', head: true })
      .ilike('email', ATTACH_EMAIL).eq('role', 'resident')
    results.push({
      step: '🔴 ATTACH.3  user_roles count WHERE lower(email)=ATTACH + role=resident',
      expected: '1 (unchanged from seed — no redundant write)',
      got: String(attachCount),
      pass: attachCount === 1,
      loadBearing: true,
    })

    // Also confirm nondeterminism-feeding shape didn't get created:
    // no row with the fictional cross-company should exist.
    const { count: fictionalCount } = await admin
      .from('user_roles').select('*', { count: 'exact', head: true })
      .ilike('email', ATTACH_EMAIL).eq('company', 'Fictional Cross-Company')
    results.push({
      step: 'ATTACH.4  no row with Fictional Cross-Company written',
      expected: '0',
      got: String(fictionalCount),
      pass: fictionalCount === 0,
    })
  } finally {
    // ── CLEANUP ──
    console.log('')
    console.log('  cleanup:')
    const { error: r1 } = await admin.from('residents').delete().in('email', [CREATE_EMAIL, ATTACH_EMAIL])
    console.log(`    residents delete:  ${r1 ? '❌ ' + r1.message : '✓'}`)
    const { error: r2 } = await admin.from('user_roles').delete().or(`email.ilike.${CREATE_EMAIL},email.ilike.${ATTACH_EMAIL}`)
    console.log(`    user_roles delete: ${r2 ? '❌ ' + r2.message : '✓'}`)
    if (createAuthId) {
      const { error: r3 } = await admin.auth.admin.deleteUser(createAuthId)
      console.log(`    auth delete create: ${r3 ? '❌ ' + r3.message : '✓'}`)
    }
    if (attachAuthId) {
      const { error: r4 } = await admin.auth.admin.deleteUser(attachAuthId)
      console.log(`    auth delete attach: ${r4 ? '❌ ' + r4.message : '✓'}`)
    }
  }

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

  const loadBearingFails = results.filter(r => r.loadBearing && !r.pass)
  const allPass = results.every(r => r.pass)
  console.log('')
  if (allPass) {
    console.log('  ✓ VERDICT: idempotency HOLDS.')
    console.log('             CREATE path: 1 role row (load-bearing preserved).')
    console.log('             ATTACH path: 1 role row (no redundant write, guard never wrongly invoked).')
    console.log('             Commit 2a ready for push.')
  } else if (loadBearingFails.length > 0) {
    console.log(`  🔴 VERDICT: ${loadBearingFails.length} LOAD-BEARING FAILURE(S) — HALT.`)
    loadBearingFails.forEach(r => console.log(`      ${r.step}`))
  } else {
    const nonLoad = results.filter(r => !r.pass)
    console.log(`  ⚠  ${nonLoad.length} non-load-bearing failure(s):`)
    nonLoad.forEach(r => console.log(`      ${r.step}`))
  }
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
