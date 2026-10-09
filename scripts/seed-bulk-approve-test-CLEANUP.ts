#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Cleanup — remove bulk-approve test cohort from Test-LEGACY
// 2026-07-24 · counterpart to seed-bulk-approve-test-ONE-TIME.ts
//
// Same FOUR LOCKS as the seed — allowlist, denylist, zero-argv,
// byte-exact company + property. RE-VERIFIES before deleting, then
// RE-VERIFIES after with count=0 assertions.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/seed-bulk-approve-test-CLEANUP.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const EXPECTED_COMPANY_ID    = 89
const EXPECTED_COMPANY_NAME  = 'Test-LEGACY'
const FORBIDDEN_COMPANY_ID   = 91
const EXPECTED_PROPERTY_NAME = 'Test Legacy Property'

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  seed-bulk-approve-test-CLEANUP')
  console.log('══════════════════════════════════════════════════════════════════')

  if (!URL || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  console.log(`  target project: ${URL.replace(/^https?:\/\//, '').split('.')[0]}`)

  if (process.argv.length > 2) {
    console.error(`❌ LOCK 3 — zero argv; got ${process.argv.length - 2}`)
    process.exit(9)
  }
  console.log('  ✓ LOCK 3: zero argv')

  const admin = createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // LOCK 1 + 2
  const { data: companies, error: coErr } = await admin
    .from('companies').select('id, name, company_env')
    .eq('id', EXPECTED_COMPANY_ID)
  if (coErr) { console.error('❌ company resolve:', coErr.message); process.exit(3) }
  if (!companies || companies.length !== 1) {
    console.error(`❌ LOCK 1 — expected exactly 1 company at id=${EXPECTED_COMPANY_ID}; got ${companies?.length ?? 0}`)
    process.exit(4)
  }
  const testLegacy = companies[0]
  if (testLegacy.id === FORBIDDEN_COMPANY_ID) { console.error('❌ LOCK 2 — FORBIDDEN'); process.exit(5) }
  if (testLegacy.company_env !== 'test')       { console.error(`❌ LOCK 1 — env='${testLegacy.company_env}'`); process.exit(6) }
  if (testLegacy.name !== EXPECTED_COMPANY_NAME) {
    console.error(`❌ LOCK 1 — name='${testLegacy.name}'`); process.exit(7)
  }
  console.log(`  ✓ LOCK 1/2: company id=${testLegacy.id} '${testLegacy.name}'`)

  // LOCK 4
  const { data: props, error: prErr } = await admin
    .from('properties').select('id, name, company')
    .eq('company', testLegacy.name).eq('name', EXPECTED_PROPERTY_NAME)
  if (prErr) { console.error('❌ property resolve:', prErr.message); process.exit(8) }
  if (!props || props.length !== 1) {
    console.error(`❌ LOCK 4 — expected 1 property; got ${props?.length ?? 0}`); process.exit(10)
  }
  const property = props[0]
  console.log(`  ✓ LOCK 4: property '${property.name}'`)

  // ══════════════════════════════════════════════════════════════════
  // PRE-DELETE REPORT — the actual test result lives HERE.
  //
  // Runs before deletion so the operator sees what the bulk approve
  // actually did. Infers COHORT_SIZE from the residents left in DB
  // (bulk-r% excludes the preseed), so this script doesn't need to
  // know which run just happened.
  //
  // The HEADLINE assertion is on vehicles-still-pending: this is the
  // silent-cascade-failure class the whole test exists to catch. If
  // it exceeds expectedCollisions, residents were approved while their
  // vehicles were left pending — the L1431 / L1551 swallow class in
  // action.
  // ══════════════════════════════════════════════════════════════════
  console.log('')
  console.log('  ── PRE-DELETE REPORT ──────────────────────────────────────')

  const { data: cohortResRows } = await admin
    .from('residents').select('email')
    .like('email', 'bulk-r%@test.shieldmylot.com').eq('property', property.name)
  const cohortSize = cohortResRows?.length ?? 0
  const expectedSameBatchCollisions = 1
  const expectedCrossCollisions     = cohortSize >= 50 ? 1 : 0
  const expectedCollisions          = expectedSameBatchCollisions + expectedCrossCollisions

  // Assert the state we want (active), not the absence of one we thought of.
  // vehicles.status has THREE values — 'active', 'pending', 'declined'.
  // Filtering on .eq('status','pending') would silently pass a row that
  // ended up 'declined' (a real status, produced by declineVehicle and
  // reachable if bulk approve ever rejected+declined). Assert positive:
  // count active, then fetch anything NOT active and dump plate→status
  // so pending vs declined is visible rather than inferred.
  const { count: vActive } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .like('plate', 'TESTBULK%').eq('property', property.name)
    .eq('status', 'active').eq('is_active', true)
  const { data: vNotActive } = await admin
    .from('vehicles').select('plate, status, is_active')
    .like('plate', 'TESTBULK%').eq('property', property.name)
    .neq('status', 'active')
    .order('plate')

  const { count: rActive } = await admin
    .from('residents').select('*', { count: 'exact', head: true })
    .like('email', 'bulk-%@test.shieldmylot.com').eq('property', property.name)
    .eq('status', 'active').eq('is_active', true)
  const { count: rPending } = await admin
    .from('residents').select('*', { count: 'exact', head: true })
    .like('email', 'bulk-%@test.shieldmylot.com').eq('property', property.name)
    .eq('status', 'pending')

  const expectedActive = cohortSize - expectedCollisions + 1  // +1 for preseed
  console.log(`  inferred cohort size:       ${cohortSize}`)
  console.log(`  expected collisions:        ${expectedCollisions} (${expectedSameBatchCollisions} same-batch + ${expectedCrossCollisions} cross)`)
  console.log('')
  console.log(`  vehicles active (incl preseed): ${vActive}   (expected: ${expectedActive})`)
  console.log(`  vehicles NOT active:            ${vNotActive?.length ?? 0}   (expected: ${expectedCollisions})`)
  console.log(`  residents active:               ${rActive}   (expected: ${cohortSize})`)
  console.log(`  residents still pending:        ${rPending}   (expected: 0)`)
  console.log('')

  let failed = false
  if ((vNotActive?.length ?? 0) > expectedCollisions) {
    console.log(`  🔴 CASCADE FAILURE — ${vNotActive?.length} vehicles NOT active, expected ${expectedCollisions}.`)
    console.log('     Anything beyond the known collisions is a cascade failure:')
    console.log('       pending  → cascade did not run for this vehicle')
    console.log('       declined → cascade ran and rejected')
    vNotActive?.forEach(v => console.log(`       ${v.plate}  →  status=${v.status}  is_active=${v.is_active}`))
    failed = true
  }
  if ((rPending ?? 0) > 0) {
    console.log(`  🔴 RESIDENT FAILURE — ${rPending} residents still pending. Promise.all at L1524 may have rejected mid-run.`)
    failed = true
  }
  if ((rActive ?? 0) === 0 && (vActive ?? 0) === 1) {
    // vActive === 1 = only the preseed. Suggests bulk approve was NEVER clicked
    // OR L1524 Promise.all threw before ANY resident update landed.
    console.log('  ⚠  vActive=1, rActive=0 — either bulk approve was not clicked yet, or L1524 threw before any resident update landed. Confirm with operator.')
  }
  if (!failed) {
    console.log('  ✓ counts reconcile with expected outcome')
  }
  console.log('  ─────────────────────────────────────────────────────────')
  console.log('')

  // DELETE + RETURNING for evidence — vehicles first (no FK, but conservative)
  const { data: vehDeleted, error: vDelErr } = await admin
    .from('vehicles').delete()
    .like('plate', 'TESTBULK%').eq('property', property.name)
    .select('id, plate')
  if (vDelErr) { console.error('❌ vehicles delete:', vDelErr.message); process.exit(20) }

  const { data: resDeleted, error: rDelErr } = await admin
    .from('residents').delete()
    .like('email', 'bulk-%@test.shieldmylot.com').eq('property', property.name)
    .select('id, email')
  if (rDelErr) { console.error('❌ residents delete:', rDelErr.message); process.exit(21) }

  console.log(`  ✓ deleted ${vehDeleted?.length ?? 0} vehicles, ${resDeleted?.length ?? 0} residents`)

  // POST-DELETE VERIFY — zero residue
  const { count: vLeft } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .like('plate', 'TESTBULK%').eq('property', property.name)
  const { count: rLeft } = await admin
    .from('residents').select('*', { count: 'exact', head: true })
    .like('email', 'bulk-%@test.shieldmylot.com').eq('property', property.name)
  if ((vLeft ?? 0) !== 0 || (rLeft ?? 0) !== 0) {
    console.error(`❌ RESIDUE — vehicles=${vLeft}, residents=${rLeft}`); process.exit(30)
  }
  console.log('  ✓ post-delete verify: zero residue')

  console.log('')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  CLEAN')
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
