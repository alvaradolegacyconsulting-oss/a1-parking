#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Probe — Commit A behavioural gate (five assertions, self-cleaning)
// 2026-07-26 · Test-LEGACY + Test-PM · READ + WRITE (throwaway)
//
// WHY THIS EXISTS
//   Commit A rewrites five ~~* company checks + one ~~* property check
//   in three A1-live tow-path functions. Structural verification (12 VQs)
//   confirmed the source. This probe proves the fix behaviourally:
//     • Normal-flow doesn't break single-company callers (A1 + A4)
//     • Cross-company attempts are refused (proves the fix bites)
//     • Manager branch (A6) refuses too — A6 is dead code as far as
//       current UI callers go (no manager client caller of
//       stamp_tow_ticket per grep), but pm-manager attempting a
//       Test-LEGACY stamp still hits A6 through the RPC layer, which
//       is the only way to prove A6 behaviourally.
//
// A2/A3/A5 SHIPPED-BY-SYMMETRY
//   A2 (regenerate violation-scope), A3 (regenerate storage-scope),
//   A5 (stamp storage-scope) share identical fix shape with A1/A4.
//   The count-VQ (zero ~~* across the three functions) + preservation
//   VQs cover them. Not behaviourally probed — regenerate requires an
//   already-stamped violation which is more setup than the fix's
//   symmetry warrants.
//
// FIVE ASSERTIONS
//   T1  legacy-driver stamps vA          → succeeds (A4 + A5 happy path)
//   T2  legacy-ca sets vB → 'resolved'   → succeeds (A1 happy path)
//   T3  pm-ca stamps vC (Test-LEGACY)    → refused violation_out_of_scope (A4 bite)
//   T4  pm-ca sets vC → 'resolved'       → refused cross_company_denied (A1 bite)
//   T5  pm-manager stamps vC             → refused violation_out_of_scope (A6 bite)
//
// FOUR STRUCTURAL LOCKS
//   L1  allowlist — every resolved company must be company_env='test'
//   L2  denylist  — refuse company_id=91 (A1 Wrecker llc)
//   L3  zero-argv — no arguments
//   L4  byte-exact — Test-LEGACY / Test-PM by hardcoded id + name assertion
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-six-site-commit-a-behavioural-ONE-TIME.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { sessionAs } from './lib/smoke-auth'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const LEGACY_ID    = 89
const LEGACY_NAME  = 'Test-LEGACY'
const LEGACY_PROP  = 'Test Legacy Property'
const PM_ID        = 87
const PM_NAME      = 'Test-PM'
const FORBIDDEN_ID = 91

const LEGACY_DRIVER = 'legacy-driver@test.shieldmylot.com'
const LEGACY_CA     = 'legacy-ca@test.shieldmylot.com'
const PM_CA         = 'pm-ca@test.shieldmylot.com'
const PM_MANAGER    = 'pm-manager@test.shieldmylot.com'

const PROBE_PLATE_PREFIX = 'PROBEA'  // vA/vB/vC will be PROBEA01/02/03
const PROBE_STORAGE_NAME = 'PROBE Storage Facility (Test-LEGACY)'

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  probe-six-site-commit-a-behavioural-ONE-TIME')
  console.log('══════════════════════════════════════════════════════════════════')

  if (!URL || !SERVICE) { console.error('❌ missing env'); process.exit(2) }
  if (process.argv.length > 2) { console.error('❌ L3: zero argv'); process.exit(3) }

  const admin = createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── L1 + L2 + byte-exact resolution ──
  for (const [id, expectedName] of [[LEGACY_ID, LEGACY_NAME], [PM_ID, PM_NAME]] as const) {
    const { data: co } = await admin.from('companies').select('id, name, company_env').eq('id', id)
    if (!co || co.length !== 1) { console.error(`❌ L1: company id=${id} not found`); process.exit(4) }
    if (co[0].id === FORBIDDEN_ID) { console.error('❌ L2: FORBIDDEN_ID'); process.exit(5) }
    if (co[0].company_env !== 'test') { console.error(`❌ L1: id=${id} env='${co[0].company_env}' not test`); process.exit(6) }
    if (co[0].name !== expectedName) { console.error(`❌ L1: id=${id} name='${co[0].name}' expected '${expectedName}'`); process.exit(7) }
  }
  console.log(`  ✓ locks OK — Test-LEGACY (${LEGACY_ID}) + Test-PM (${PM_ID}), both env='test'`)

  // ── L4 — property byte-exact ──
  const { data: prop } = await admin
    .from('properties').select('id, name, company')
    .eq('company', LEGACY_NAME).eq('name', LEGACY_PROP)
  if (!prop || prop.length !== 1) { console.error('❌ L4: Test Legacy Property'); process.exit(8) }
  console.log(`  ✓ L4: property '${LEGACY_PROP}' at ${LEGACY_NAME}`)

  console.log('')
  console.log('  MANUAL CLEANUP (paste-ready if the probe crashes):')
  console.log(`    DELETE FROM violations WHERE plate LIKE '${PROBE_PLATE_PREFIX}%' AND property = '${LEGACY_PROP}';`)
  console.log(`    DELETE FROM storage_facilities WHERE name = '${PROBE_STORAGE_NAME}';`)
  console.log('')

  // ── Storage facility: use existing Test-LEGACY row or seed a probe row ──
  let seededStorageId: number | null = null
  const { data: existingStorage } = await admin
    .from('storage_facilities').select('id, name, company')
    .eq('company', LEGACY_NAME).limit(1).maybeSingle()
  let storageId: number
  if (existingStorage?.id) {
    storageId = existingStorage.id as number
    console.log(`  ✓ storage: reusing existing '${existingStorage.name}' id=${storageId}`)
  } else {
    const { data: seededStorage, error: sErr } = await admin.from('storage_facilities').insert([{
      name: PROBE_STORAGE_NAME,
      company: LEGACY_NAME,
      address: '123 Probe Way, Test City TX',
      phone: '555-0000',
    }]).select('id').single()
    if (sErr || !seededStorage) { console.error('❌ seed storage:', sErr?.message); process.exit(10) }
    storageId = seededStorage.id as number
    seededStorageId = storageId
    console.log(`  ✓ storage: seeded probe row id=${storageId}`)
  }

  // ── Seed three violations at Test Legacy Property ──
  const seedViolation = async (plate: string) => {
    const { data, error } = await admin.from('violations').insert([{
      plate,
      violation_type: 'no_permit',
      location: 'PROBE',
      notes: 'commit A behavioural probe',
      property: LEGACY_PROP,
      driver_name: 'Probe Driver',
      driver_license: 'PROBE-LIC',
      is_confirmed: true,   // stamp_tow_ticket requires is_confirmed=true
      status: 'new',
    }]).select('id').single()
    if (error || !data) throw new Error(`seed violation ${plate}: ${error?.message}`)
    return data.id as number
  }

  let vA: number | null = null
  let vB: number | null = null
  let vC: number | null = null
  const results: { test: string; expected: string; got: string; pass: boolean }[] = []

  try {
    vA = await seedViolation(`${PROBE_PLATE_PREFIX}01`)
    vB = await seedViolation(`${PROBE_PLATE_PREFIX}02`)
    vC = await seedViolation(`${PROBE_PLATE_PREFIX}03`)
    console.log(`  ✓ seeded violations: vA=${vA} vB=${vB} vC=${vC}`)
    console.log('')

    // ── T1 — legacy-driver stamps vA → expect success (A4 + A5) ──
    {
      const s = await sessionAs(LEGACY_DRIVER, { targetEnv: 'test' })
      const { data, error } = await s.client.rpc('stamp_tow_ticket', {
        p_violation_id: vA,
        p_storage_facility_id: storageId,
        p_tow_fee: 250,
      })
      const rpcErr = error?.message
      const bodyErr = (data as { error?: string })?.error
      const okOk   = (data as { ok?: boolean })?.ok === true
      results.push({
        test: 'T1  legacy-driver stamps vA (A4+A5 happy path)',
        expected: 'ok=true (no rpc error, no body error)',
        got: rpcErr ? `RPC error: ${rpcErr}` : bodyErr ? `body error: ${bodyErr}` : okOk ? 'ok=true' : `unexpected: ${JSON.stringify(data)}`,
        pass: !rpcErr && !bodyErr && okOk,
      })
    }

    // ── T2 — legacy-ca sets vB to 'resolved' → expect success (A1) ──
    {
      const s = await sessionAs(LEGACY_CA, { targetEnv: 'test' })
      const { data, error } = await s.client.rpc('set_violation_status', {
        p_violation_id: vB,
        p_new_status: 'resolved',
      })
      const rpcErr = error?.message
      const bodyErr = (data as { error?: string })?.error
      const okOk   = (data as { ok?: boolean })?.ok === true
      results.push({
        test: 'T2  legacy-ca sets vB → resolved (A1 happy path)',
        expected: 'ok=true (no rpc error, no body error)',
        got: rpcErr ? `RPC error: ${rpcErr}` : bodyErr ? `body error: ${bodyErr}` : okOk ? 'ok=true' : `unexpected: ${JSON.stringify(data)}`,
        pass: !rpcErr && !bodyErr && okOk,
      })
    }

    // ── T3 — pm-ca stamps vC (Test-LEGACY) → expect refused (A4 bite) ──
    {
      const s = await sessionAs(PM_CA, { targetEnv: 'test' })
      const { data, error } = await s.client.rpc('stamp_tow_ticket', {
        p_violation_id: vC,
        p_storage_facility_id: storageId,
        p_tow_fee: 250,
      })
      const bodyErr = (data as { error?: string })?.error
      const isRefusedCorrectly = bodyErr === 'violation_out_of_scope' && !error
      results.push({
        test: 'T3  pm-ca stamps vC (cross-company; A4 bite)',
        expected: 'body error violation_out_of_scope',
        got: error?.message ? `RPC error: ${error.message}` : bodyErr ? `body error: ${bodyErr}` : `unexpected: ${JSON.stringify(data)}`,
        pass: isRefusedCorrectly,
      })
    }

    // ── T4 — pm-ca sets vC → 'resolved' → expect refused (A1 bite) ──
    {
      const s = await sessionAs(PM_CA, { targetEnv: 'test' })
      const { data, error } = await s.client.rpc('set_violation_status', {
        p_violation_id: vC,
        p_new_status: 'resolved',
      })
      const bodyErr = (data as { error?: string })?.error
      const isRefusedCorrectly = bodyErr === 'cross_company_denied' && !error
      results.push({
        test: 'T4  pm-ca sets vC → resolved (cross-company; A1 bite)',
        expected: 'body error cross_company_denied',
        got: error?.message ? `RPC error: ${error.message}` : bodyErr ? `body error: ${bodyErr}` : `unexpected: ${JSON.stringify(data)}`,
        pass: isRefusedCorrectly,
      })
    }

    // ── T5 — pm-manager stamps vC → expect refused (A6 bite) ──
    // A6 is dead code as far as client callers go (no manager caller of
    // stamp_tow_ticket per grep). Reaching it via direct RPC proves the
    // fix bites through the manager branch.
    {
      const s = await sessionAs(PM_MANAGER, { targetEnv: 'test' })
      const { data, error } = await s.client.rpc('stamp_tow_ticket', {
        p_violation_id: vC,
        p_storage_facility_id: storageId,
        p_tow_fee: 250,
      })
      const bodyErr = (data as { error?: string })?.error
      const isRefusedCorrectly = bodyErr === 'violation_out_of_scope' && !error
      results.push({
        test: 'T5  pm-manager stamps vC (manager branch; A6 bite)',
        expected: 'body error violation_out_of_scope',
        got: error?.message ? `RPC error: ${error.message}` : bodyErr ? `body error: ${bodyErr}` : `unexpected: ${JSON.stringify(data)}`,
        pass: isRefusedCorrectly,
      })
    }
  } finally {
    // ── CLEANUP ──
    console.log('')
    console.log('  cleanup:')
    if (vA || vB || vC) {
      const { data: delViolRows, error: delErr } = await admin
        .from('violations').delete().like('plate', `${PROBE_PLATE_PREFIX}%`).eq('property', LEGACY_PROP)
        .select('id, plate')
      console.log(`    violations delete: ${delErr ? '❌ ' + delErr.message : `✓ ${delViolRows?.length ?? 0} rows`}`)
    }
    if (seededStorageId) {
      const { error: sDelErr } = await admin.from('storage_facilities').delete().eq('id', seededStorageId)
      console.log(`    storage delete:    ${sDelErr ? '❌ ' + sDelErr.message : '✓ probe storage removed'}`)
    } else {
      console.log(`    storage delete:    skipped (reused existing Test-LEGACY row)`)
    }
  }

  // ── REPORT ──
  console.log('')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  RESULTS')
  console.log('══════════════════════════════════════════════════════════════════')
  results.forEach(r => {
    const badge = r.pass ? '✓' : '❌'
    console.log(`  ${badge} ${r.test}`)
    console.log(`      expected: ${r.expected}`)
    console.log(`      got:      ${r.got}`)
  })

  const allPass = results.every(r => r.pass)
  console.log('')
  if (allPass) {
    console.log('  ✓ VERDICT: Commit A behavioural gate CLEAR.')
    console.log('             T1+T2 — single-company callers still succeed (fix did not break normal path)')
    console.log('             T3+T4 — cross-company CA refused for both stamp and status (A1+A4 bite)')
    console.log('             T5    — cross-company manager refused for stamp (A6 bite, though unreachable via UI)')
    console.log('             A2/A3/A5 shipped by symmetry (identical fix shape, count-VQ + preservation VQs cover).')
    console.log('             Commit A ready to push.')
  } else {
    const fails = results.filter(r => !r.pass)
    console.log(`  🔴 VERDICT: ${fails.length} behavioural failure(s) — HALT.`)
    fails.forEach(r => console.log(`      ${r.test}`))
    console.log('  Commit A NOT ready. Investigate.')
  }
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
