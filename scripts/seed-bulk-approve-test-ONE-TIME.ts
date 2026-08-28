#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Seed — bulk-approve test cohort on Test-LEGACY (ONE-TIME)
// 2026-07-24 · Test-LEGACY (company_env='test', id=89, name='Test-LEGACY')
//
// WHY THIS EXISTS
//   Baseline probe for the approve_vehicle silent-swallow class before
//   the six-site fix ships. Cohort of pending residents + pending
//   vehicles on Test Legacy Property, with intentional plate collisions.
//
//   TWO-RUN DESIGN (Jose 2026-07-24)
//   ────────────────────────────────
//   RUN 1 — COHORT_SIZE=10, pilot the harness and exercise ONE 23505
//           collision (rows 9+10 share plate). Confirms:
//             • Four locks fire correctly
//             • Approve-all executes end-to-end
//             • CONCURRENT EMAIL PATH — never exercised before this
//               (audit_logs shows exactly 2 prior APPROVE_RESIDENT rows
//               on Test Legacy Property, both one-at-a-time). Ten
//               parallel Resend sends inside Promise.all at L1524.
//               If any one rejects, the whole Promise.all rejects and
//               the function throws BEFORE any vehicle approve fires —
//               the plate-collision test never executes. That's why
//               the pilot exists.
//   RUN 2 — COHORT_SIZE=50, scale + activate cross-collision (row 50
//           shares plate with the preseed). Captures the silent partial
//           failure the fix will surface.
//
//   Between runs: cleanup, flip COHORT_SIZE 10 → 50, re-seed.
//
// FOUR STRUCTURAL LOCKS (all before any write)
//   L1  allowlist  — resolved company MUST have company_env='test'.
//   L2  denylist   — id !== FORBIDDEN_COMPANY_ID (91).
//   L3  zero-argv  — script takes no arguments.
//   L4  byte-exact — company.name === 'Test-LEGACY' AND
//                    property.name === 'Test Legacy Property' AND
//                    property.company === 'Test-LEGACY'.
//                    The unique index vehicles_authorized_plate_uidx
//                    keys on the RAW property column — a case- or
//                    whitespace-mismatch would silently prevent the
//                    collision test from firing (the test would prove
//                    nothing rather than fail loudly).
//
// SAFETY
//   • service_role writes only; the LOCKS above are the security
//     boundary since RLS won't stop us.
//   • Pre-flight refuses if prior TESTBULK residue exists.
//   • Pre-flight REPORTS (does not refuse) any pre-existing pending
//     residents/vehicles at the property — approveAllPendingCrm sweeps
//     ALL pending at the property, so pre-existing counts shift the
//     expected math and the operator must know before reading results.
//   • Self-cleaning via companion cleanup script; paste-ready SQL
//     also printed to stdout if the script crashes.
//   • Cleanup keys on LIKE 'TESTBULK%' / 'bulk-%@' — will not touch
//     pre-existing Test-LEGACY data.
//
// COLUMNS
//   Read from information_schema.columns 2026-07-24. Everything on
//   residents + vehicles is nullable except identity id + timestamped
//   created_at (both auto-supplied). No defensive defaults — nothing
//   on the approval path reads state/make/model/year/color.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/seed-bulk-approve-test-ONE-TIME.ts
//
// TEARDOWN
//   npx tsx --env-file=.env.local scripts/seed-bulk-approve-test-CLEANUP.ts
//
// ENV
//   NEXT_PUBLIC_SUPABASE_URL       — target project
//   SUPABASE_SERVICE_ROLE_KEY      — for service-role writes
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── FIXED TARGET — no argv, no env-driven redirect ──
const EXPECTED_COMPANY_ID    = 89
const EXPECTED_COMPANY_NAME  = 'Test-LEGACY'
const FORBIDDEN_COMPANY_ID   = 91                       // A1 Wrecker llc
const EXPECTED_PROPERTY_NAME = 'Test Legacy Property'

// ── RUN CONTROLS — flip COHORT_SIZE 10 → 50 between pilot and scale ──
const COHORT_SIZE: 10 | 50 = 10

// Same-batch duplicate rows are keyed to COHORT_SIZE so they:
//   • always live near the end of the cohort (pilot: 9+10)
//   • never overlap the cross-collision row 50 (scale: 47+48)
const DUPLICATE_ROWS: Record<10 | 50, [number, number]> = {
  10: [9, 10],
  50: [47, 48],
}
const [DUPLICATE_ROW_A, DUPLICATE_ROW_B] = DUPLICATE_ROWS[COHORT_SIZE]
const DUPLICATE_PLATE = `TESTBULK${String(DUPLICATE_ROW_A).padStart(3, '0')}`

// Cross-collision — inert while COHORT_SIZE < 50, live when 50.
const CROSS_COLLIDE_ROW = 50
const PRESEED_EMAIL     = 'bulk-preseed@test.shieldmylot.com'
const PRESEED_UNIT      = 'BULK-PRESEED'
const PRESEED_PLATE     = 'TESTBULK050'

function plateForRow(i: number): string {
  if (i === DUPLICATE_ROW_B)   return DUPLICATE_PLATE
  if (i === CROSS_COLLIDE_ROW) return PRESEED_PLATE
  return `TESTBULK${String(i).padStart(3, '0')}`
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  seed-bulk-approve-test-ONE-TIME')
  console.log('══════════════════════════════════════════════════════════════════')

  if (!URL || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  console.log(`  target project: ${URL.replace(/^https?:\/\//, '').split('.')[0]}`)
  console.log(`  cohort size:    ${COHORT_SIZE}   (dup rows ${DUPLICATE_ROW_A}+${DUPLICATE_ROW_B} → plate ${DUPLICATE_PLATE})`)

  const admin = createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── LOCK 3 — zero argv (structural) ──
  if (process.argv.length > 2) {
    console.error(`❌ LOCK 3 — zero argv; got ${process.argv.length - 2}`)
    process.exit(9)
  }
  console.log('  ✓ LOCK 3: zero argv')

  // ── LOCK 1 + 2 — resolve company by id, verify env + name + not forbidden ──
  const { data: companies, error: coErr } = await admin
    .from('companies').select('id, name, company_env')
    .eq('id', EXPECTED_COMPANY_ID)
  if (coErr) { console.error('❌ company resolve:', coErr.message); process.exit(3) }
  if (!companies || companies.length !== 1) {
    console.error(`❌ LOCK 1 — expected exactly 1 company at id=${EXPECTED_COMPANY_ID}; got ${companies?.length ?? 0}`)
    process.exit(4)
  }
  const testLegacy = companies[0]
  if (testLegacy.id === FORBIDDEN_COMPANY_ID) {
    console.error('❌ LOCK 2 — resolved company is FORBIDDEN_COMPANY_ID (91)')
    process.exit(5)
  }
  if (testLegacy.company_env !== 'test') {
    console.error(`❌ LOCK 1 — company_env='${testLegacy.company_env}', expected 'test'`)
    process.exit(6)
  }
  if (testLegacy.name !== EXPECTED_COMPANY_NAME) {
    console.error(`❌ LOCK 1 — byte-exact name mismatch: got '${testLegacy.name}', expected '${EXPECTED_COMPANY_NAME}'`)
    process.exit(7)
  }
  console.log(`  ✓ LOCK 1/2: company id=${testLegacy.id} name='${testLegacy.name}' env='${testLegacy.company_env}'`)

  // ── LOCK 4 — resolve property by byte-exact (name, company) ──
  const { data: props, error: prErr } = await admin
    .from('properties').select('id, name, company')
    .eq('company', testLegacy.name).eq('name', EXPECTED_PROPERTY_NAME)
  if (prErr) { console.error('❌ property resolve:', prErr.message); process.exit(8) }
  if (!props || props.length !== 1) {
    console.error(`❌ LOCK 4 — expected exactly 1 property '${EXPECTED_PROPERTY_NAME}' at '${testLegacy.name}'; got ${props?.length ?? 0}`)
    console.error('   rows:', props)
    process.exit(10)
  }
  const property = props[0]
  if (property.name !== EXPECTED_PROPERTY_NAME || property.company !== testLegacy.name) {
    console.error('❌ LOCK 4 — byte-exact mismatch after resolve')
    process.exit(11)
  }
  console.log(`  ✓ LOCK 4: property id=${property.id} name='${property.name}' company='${property.company}'`)

  // ── PRE-FLIGHT (refuse) — no prior TESTBULK residue ──
  const { count: resResidue } = await admin
    .from('residents').select('*', { count: 'exact', head: true })
    .like('email', 'bulk-%@test.shieldmylot.com').eq('property', property.name)
  const { count: vehResidue } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .like('plate', 'TESTBULK%').eq('property', property.name)
  if ((resResidue ?? 0) > 0 || (vehResidue ?? 0) > 0) {
    console.error(`❌ PRE-FLIGHT — residue: residents=${resResidue}, vehicles=${vehResidue}. Run CLEANUP first.`)
    process.exit(12)
  }
  console.log('  ✓ pre-flight: no prior TESTBULK residue')

  // ── PRE-FLIGHT (report) — all pre-existing pending at property ──
  // approveAllPendingCrm approves ALL pending at property, so pre-existing
  // pending shifts the expected math. Report, don't refuse.
  const { count: allPendingRes } = await admin
    .from('residents').select('*', { count: 'exact', head: true })
    .eq('property', property.name).eq('status', 'pending')
  const { count: allPendingVeh } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .eq('property', property.name).eq('status', 'pending')
  console.log(`  ℹ pre-existing pending at property: ${allPendingRes} residents, ${allPendingVeh} vehicles`)
  if ((allPendingRes ?? 0) > 0 || (allPendingVeh ?? 0) > 0) {
    console.log('    → expected post-approve counts must be adjusted by these values')
  }

  // ── PRE-SEED — 1 active resident + 1 active vehicle at PRESEED_PLATE ──
  // Provides the cross-collision target for CROSS_COLLIDE_ROW=50 (inert
  // while COHORT_SIZE<50; live at 50). Always seeded so cleanup catches
  // both pilot and scale runs uniformly.
  const { error: preResErr } = await admin.from('residents').insert([{
    email: PRESEED_EMAIL, name: 'Preseed Resident', unit: PRESEED_UNIT,
    property: property.name, company: testLegacy.name,
    is_active: true, status: 'active',
  }])
  if (preResErr) { console.error('❌ preseed resident:', preResErr.message); process.exit(13) }

  const { error: preVehErr } = await admin.from('vehicles').insert([{
    plate: PRESEED_PLATE,
    unit: PRESEED_UNIT, property: property.name, resident_email: PRESEED_EMAIL,
    // 🟢 2026-08-28 vehicles.company arc Commit 2 — seed writer.
    // testLegacy.name is the tenant this script seeds against.
    company: testLegacy.name,
    is_active: true, status: 'active',
  }])
  if (preVehErr) { console.error('❌ preseed vehicle:', preVehErr.message); process.exit(14) }
  console.log(`  ✓ preseed: 1 active resident + 1 active vehicle at plate ${PRESEED_PLATE}`)

  // ── COHORT — pending residents + pending vehicles ──
  const residents = Array.from({ length: COHORT_SIZE }, (_, k) => {
    const i = k + 1
    const id = String(i).padStart(3, '0')
    return {
      email:    `bulk-r${id}@test.shieldmylot.com`,
      name:     `Bulk Resident ${id}`,
      unit:     `BULK-${id}`,
      property: property.name,
      company:  testLegacy.name,
      is_active: false,
      status:   'pending',
    }
  })
  const { error: rBulkErr } = await admin.from('residents').insert(residents)
  if (rBulkErr) { console.error('❌ cohort residents:', rBulkErr.message); process.exit(15) }

  const vehicles = residents.map((r, k) => {
    const i = k + 1
    return {
      plate: plateForRow(i),
      unit: r.unit, property: r.property, resident_email: r.email,
      // 🟢 2026-08-28 vehicles.company arc Commit 2 — seed writer.
      // Uses each resident's own company (r.company already set above).
      company: r.company,
      is_active: false, status: 'pending',
    }
  })
  const { error: vBulkErr } = await admin.from('vehicles').insert(vehicles)
  if (vBulkErr) { console.error('❌ cohort vehicles:', vBulkErr.message); process.exit(16) }
  console.log(`  ✓ cohort: ${COHORT_SIZE} pending residents + ${COHORT_SIZE} pending vehicles`)

  // ── SUMMARY ──
  const willActivateXCollide = COHORT_SIZE >= CROSS_COLLIDE_ROW
  console.log('')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  SEEDED — proceed with bulk approve as legacy-manager@test.shieldmylot.com')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  Property:      ${property.name}`)
  console.log(`  Company:       ${testLegacy.name}  (env=${testLegacy.company_env}, id=${testLegacy.id})`)
  console.log(`  Preseed:       ${PRESEED_EMAIL} + plate ${PRESEED_PLATE} (active) — ${willActivateXCollide ? 'LIVE (row 50 will collide)' : 'inert (cohort < 50)'}`)
  console.log(`  Cohort:        ${COHORT_SIZE} pending residents + ${COHORT_SIZE} pending vehicles`)
  console.log(`  Same-batch dup: row ${DUPLICATE_ROW_A} + row ${DUPLICATE_ROW_B} share plate ${DUPLICATE_PLATE}`)
  console.log('')
  if (COHORT_SIZE === 10) {
    console.log('  PILOT — expected on bulk approve (current code, pre-fix):')
    console.log('    • 9 vehicles approve; row 9 XOR row 10 fails 23505 silently')
    console.log('    • concurrent email path (Promise.all at L1524) — NEW territory;')
    console.log('      if any Resend send rejects, function throws before any vehicle')
    console.log('      approve fires. Watch for: button appears to do nothing, some')
    console.log('      residents active, ZERO vehicles active. That is the sharp edge.')
  } else {
    console.log('  SCALE — expected on bulk approve (current code, pre-fix):')
    console.log('    • 48 vehicles approve; row 47 XOR row 48 fails 23505 silently')
    console.log('    • row 50 fails 23505 against preseed silently')
    console.log('    • net: 48 cohort active + 1 preseed = 49 TESTBULK% active')
  }
  console.log('')
  console.log('  MANUAL CLEANUP (paste-ready — in case CLEANUP script fails):')
  console.log('  ┌──────────────────────────────────────────────────────────────')
  console.log(`  │  DELETE FROM vehicles  WHERE plate LIKE 'TESTBULK%' AND property = '${property.name}';`)
  console.log(`  │  DELETE FROM residents WHERE email LIKE 'bulk-%@test.shieldmylot.com' AND property = '${property.name}';`)
  console.log('  └──────────────────────────────────────────────────────────────')
  console.log('')
}

main().catch(err => { console.error('❌ unhandled:', err); process.exit(99) })
