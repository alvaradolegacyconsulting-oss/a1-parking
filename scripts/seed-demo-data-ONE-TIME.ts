#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// seed-demo-data — TS companion to migrations/20260711_seed_demo_data
// _rpc.sql. Calls the DB seed RPC to extend Demo Company from 1 sparse
// property into a 3-property portfolio with 30 residents, 68 spaces,
// 45 vehicles, 30 violations, 15 visitor passes, 1 storage facility.
// 2026-07-11 · Post-launch seed/wipe Layer 2 (Demo extension)
//
// USAGE
//   SEED_DEMO_DATA_OK=1 \
//     npx tsx --env-file=.env.local \
//     scripts/seed-demo-data-ONE-TIME.ts
//
// PRECONDITIONS (asserted before any writes)
//   • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env
//   • SEED_DEMO_DATA_OK=1 (belt-and-suspenders confirm)
//   • seed_test_tenants() has already run — Demo Company must exist
//     with company_env='demo' (RPC pre-flight refuses otherwise)
//
// SAFETY
//   • No auth.users writes here — this is a pure DB-side extension.
//     All 29 new residents are db-only (no login accounts). The
//     existing demo-resident@ (created by seed_test_tenants + its TS
//     companion) is preserved and moved to Sunset Ridge unit 101.
//   • RPC is idempotent — safe to re-run. All counters return 0 on
//     the second call.
//   • RPC is service_role-only.
//   • Critical assertion: no Stripe artifacts on any test/demo tenant.
//
// RETIRE
//   Keep as long as the demo pattern is useful. If retiring, drop
//   alongside seed_test_tenants + reset_test_tenants (Layer 3).
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const OK      = process.env.SEED_DEMO_DATA_OK

// Expected post-state row counts — match the RPC's counters exactly.
// If any diverges, the RPC's guard failed silently or the schema
// drifted; abort loudly so we notice.
const EXPECTED = {
  properties: 3,
  spaces: 68,
  residents: 30,
  space_residents: 15,
  vehicles: 45,
  vehicles_active: 39,
  vehicles_pending: 4,
  vehicles_declined: 2,
  visitor_passes: 15,
  storage_facilities: 1,
  violations: 30,
  violations_open: 13,
  violations_resolved: 15,
  violations_disputed: 2,
  violations_voided: 2,
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  seed-demo-data — seed_demo_data() RPC + Demo Company extension')
  console.log('══════════════════════════════════════════════════════════════════\n')

  // ── Pre-flight ────────────────────────────────────────────────────
  if (!URL || !SERVICE) {
    console.error('❌ missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  if (OK !== '1') {
    console.error('❌ SEED_DEMO_DATA_OK must be "1"')
    process.exit(2)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log('─── Pre-flight ───────────────────────────────────────────────────')

  // Verify Demo Company exists with company_env='demo' before calling.
  // The RPC also guards this, but surface it early with a clearer message.
  const { data: demoRow, error: demoErr } = await admin
    .from('companies')
    .select('id, name, company_env, stripe_customer_id, stripe_subscription_id')
    .eq('name', 'Demo Company')
    .maybeSingle()
  if (demoErr) {
    console.error(`❌ companies lookup failed: ${demoErr.message}`)
    process.exit(3)
  }
  if (!demoRow) {
    console.error('❌ Demo Company not found. Run scripts/seed-test-tenants-ONE-TIME.ts first.')
    process.exit(3)
  }
  if (demoRow.company_env !== 'demo') {
    console.error(`❌ Demo Company company_env=${demoRow.company_env}, expected demo. Refuse.`)
    process.exit(3)
  }
  if (demoRow.stripe_customer_id || demoRow.stripe_subscription_id) {
    console.error(`❌ Demo Company carries Stripe artifacts (customer=${demoRow.stripe_customer_id}, subscription=${demoRow.stripe_subscription_id}). Refuse — demo tenants must be Stripe-invisible.`)
    process.exit(3)
  }
  console.log(`  ✓ Demo Company exists: id=${demoRow.id} company_env=demo, no Stripe artifacts`)

  // Snapshot the pre-state production company count so we can assert
  // it stays identical after the seed (RPC touches only demo rows).
  const { count: prodBefore } = await admin
    .from('companies')
    .select('*', { count: 'exact', head: true })
    .eq('company_env', 'production')
  console.log(`  Pre-state: production companies=${prodBefore ?? 0}\n`)

  // ── Call the seed RPC ────────────────────────────────────────────
  console.log('─── seed_demo_data() RPC ─────────────────────────────────────────')
  const { data: seedResult, error: seedErr } = await admin.rpc('seed_demo_data')
  if (seedErr) {
    console.error(`❌ seed_demo_data RPC failed: ${seedErr.message}`)
    process.exit(3)
  }
  console.log('  Result:')
  console.log('   ', JSON.stringify(seedResult, null, 2).replace(/\n/g, '\n    '))
  console.log('')

  // ── Post-verify: counts ─────────────────────────────────────────
  console.log('─── Post-verify — row counts ─────────────────────────────────────')

  const assertEq = (label: string, actual: number | null | undefined, expected: number) => {
    if (actual !== expected) {
      console.error(`❌ ${label}: expected ${expected}, got ${actual}`)
      process.exit(3)
    }
    console.log(`  ✓ ${label}: ${actual}`)
  }

  const { count: propCount } = await admin.from('properties').select('*', { count: 'exact', head: true }).eq('company', 'Demo Company')
  assertEq('properties (Demo Company)', propCount, EXPECTED.properties)

  const { count: spaceCount } = await admin.from('spaces').select('*', { count: 'exact', head: true }).eq('company', 'Demo Company')
  assertEq('spaces (Demo Company)', spaceCount, EXPECTED.spaces)

  const { count: residentCount } = await admin.from('residents').select('*', { count: 'exact', head: true }).eq('company', 'Demo Company')
  assertEq('residents (Demo Company)', residentCount, EXPECTED.residents)

  // space_residents count via a fetch-ids-first pattern rather than an
  // embedded !inner join — PostgREST count semantics on embedded joins
  // are finicky, and 68 space IDs is a trivial payload.
  const { data: demoSpaceIds } = await admin
    .from('spaces').select('id').eq('company', 'Demo Company')
  const spaceIds = (demoSpaceIds ?? []).map((s: any) => s.id)
  const { count: srCount } = await admin
    .from('space_residents')
    .select('*', { count: 'exact', head: true })
    .in('space_id', spaceIds)
  assertEq('space_residents (Demo Company)', srCount, EXPECTED.space_residents)

  // vehicles has no company column — scope through the properties join.
  const { data: demoProps } = await admin
    .from('properties')
    .select('name')
    .eq('company', 'Demo Company')
  const propNames = (demoProps ?? []).map((p: any) => p.name)

  const { count: vehCount } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .in('property', propNames)
  assertEq('vehicles (Demo Company)', vehCount, EXPECTED.vehicles)

  const { count: vehActive } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .in('property', propNames).eq('status', 'active')
  assertEq('vehicles active (Demo Company)', vehActive, EXPECTED.vehicles_active)

  const { count: vehPending } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .in('property', propNames).eq('status', 'pending')
  assertEq('vehicles pending (Demo Company)', vehPending, EXPECTED.vehicles_pending)

  const { count: vehDeclined } = await admin
    .from('vehicles').select('*', { count: 'exact', head: true })
    .in('property', propNames).eq('status', 'declined')
  assertEq('vehicles declined (Demo Company)', vehDeclined, EXPECTED.vehicles_declined)

  const { count: vpCount } = await admin
    .from('visitor_passes').select('*', { count: 'exact', head: true })
    .in('property', propNames)
  assertEq('visitor_passes (Demo Company)', vpCount, EXPECTED.visitor_passes)

  const { count: facCount } = await admin
    .from('storage_facilities').select('*', { count: 'exact', head: true })
    .eq('company', 'Demo Company')
  assertEq('storage_facilities (Demo Company)', facCount, EXPECTED.storage_facilities)

  const { count: violCount } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames)
  assertEq('violations (Demo Company)', violCount, EXPECTED.violations)

  const { count: violOpen } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames).in('status', ['new', 'tow_ticket']).is('voided_at', null)
  assertEq('violations OPEN (Demo Company)', violOpen, EXPECTED.violations_open)

  const { count: violResolved } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames).eq('status', 'resolved')
  assertEq('violations resolved (Demo Company)', violResolved, EXPECTED.violations_resolved)

  const { count: violDisputed } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames).eq('status', 'disputed')
  assertEq('violations disputed (Demo Company)', violDisputed, EXPECTED.violations_disputed)

  const { count: violVoided } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames).not('voided_at', 'is', null)
  assertEq('violations voided (Demo Company)', violVoided, EXPECTED.violations_voided)

  // ── Post-verify: no legacy "Demo Property" name lingering ────────
  const { count: legacyProp } = await admin
    .from('properties').select('*', { count: 'exact', head: true })
    .eq('company', 'Demo Company').eq('name', 'Demo Property')
  if (legacyProp !== 0) {
    console.error(`❌ 'Demo Property' still exists (${legacyProp} rows) — rename failed`)
    process.exit(3)
  }
  console.log(`  ✓ 'Demo Property' rename to 'Sunset Ridge Apartments' complete`)

  // ── Post-verify: driver attribution on every violation (Fix E) ───
  const { count: violWithDriver } = await admin
    .from('violations').select('*', { count: 'exact', head: true })
    .in('property', propNames)
    .eq('driver_name', 'Demo Driver')
    .eq('driver_license', 'TX-A2947153')
  assertEq('violations w/ Demo Driver attribution', violWithDriver, EXPECTED.violations)

  // ── Post-verify: production untouched ────────────────────────────
  const { count: prodAfter } = await admin
    .from('companies').select('*', { count: 'exact', head: true })
    .eq('company_env', 'production')
  if (prodAfter !== prodBefore) {
    console.error(`❌ production companies changed: ${prodBefore} → ${prodAfter}`)
    process.exit(3)
  }
  console.log(`  ✓ production companies unchanged: ${prodAfter}`)

  // ── Critical: no Stripe artifacts on any test/demo company ──────
  const { data: stripeLeaks } = await admin
    .from('companies')
    .select('name, company_env, stripe_customer_id, stripe_subscription_id')
    .in('company_env', ['test', 'demo'])
  const leaks = (stripeLeaks ?? []).filter(
    (r: any) => r.stripe_customer_id != null || r.stripe_subscription_id != null,
  )
  if (leaks.length > 0) {
    console.error(`❌ CRITICAL: ${leaks.length} test/demo companies carry Stripe IDs`)
    console.error(JSON.stringify(leaks, null, 2))
    process.exit(3)
  }
  console.log(`  ✓ no Stripe IDs on any test/demo company`)

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(`  🟢 Demo seed complete.`)
  console.log(`  properties: 3 (Sunset Ridge · Willowbrook · Northgate)`)
  console.log(`  spaces: 68 · residents: 30 · vehicles: 45 (39/4/2)`)
  console.log(`  space_residents: 15 · visitor_passes: 15 · facilities: 1`)
  console.log(`  violations: 30 (13 open / 15 resolved / 2 disputed / 2 voided)`)
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(e => {
  console.error('❌ unhandled error:', e)
  process.exit(3)
})
