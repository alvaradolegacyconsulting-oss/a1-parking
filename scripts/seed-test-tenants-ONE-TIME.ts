#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// seed-test-tenants — TS companion to migrations/20260711_seed_
// test_tenants_rpc.sql. Creates auth.users (shared password) then
// calls the DB seed RPC to populate companies + user_roles +
// properties. Idempotent — safe to re-run.
// 2026-07-11 · Post-launch seed/wipe Layer 2
//
// USAGE
//   SEED_TEST_TENANTS_OK=1 \
//     SEED_TEST_PASSWORD='<the-shared-password>' \
//     npx tsx --env-file=.env.local \
//     scripts/seed-test-tenants-ONE-TIME.ts
//
// PRECONDITIONS (asserted before any writes)
//   • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env
//   • SEED_TEST_TENANTS_OK=1 (belt-and-suspenders confirm)
//   • SEED_TEST_PASSWORD non-empty (min 12 chars — Supabase's default)
//   • aegis (a767da27-…) already exists in auth.users
//
// SAFETY
//   • Emails all lowercase, all @test.shieldmylot.com (no collision
//     with any real customer domain).
//   • email_confirm=true — no email verification round-trip.
//   • Shared password NEVER logged, NEVER in commit history.
//   • DB RPC has its own 3 production-safety guards (Q5 report).
//
// RETIRE
//   Keep as long as the seed pattern is useful. If retiring,
//   remove alongside the migration + Layer 3 (reset_test_tenants).
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL      = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY
const OK       = process.env.SEED_TEST_TENANTS_OK
const PASSWORD = process.env.SEED_TEST_PASSWORD

const AEGIS_UUID = 'a767da27-b452-475a-adda-1b75ae393c59'

// 18 seeded users — matches the RPC's user_roles inserts 1:1.
type SeedUser = { email: string; role: string; company: string }
const SEED_USERS: SeedUser[] = [
  // Test-PM (5)
  { email: 'pm-ca@test.shieldmylot.com',       role: 'company_admin', company: 'Test-PM' },
  { email: 'pm-manager@test.shieldmylot.com',  role: 'manager',       company: 'Test-PM' },
  { email: 'pm-leasing@test.shieldmylot.com',  role: 'leasing_agent', company: 'Test-PM' },
  { email: 'pm-driver@test.shieldmylot.com',   role: 'driver',        company: 'Test-PM' },
  { email: 'pm-resident@test.shieldmylot.com', role: 'resident',      company: 'Test-PM' },
  // Test-ENF (3)
  { email: 'enf-ca@test.shieldmylot.com',      role: 'company_admin', company: 'Test-ENF' },
  { email: 'enf-manager@test.shieldmylot.com', role: 'manager',       company: 'Test-ENF' },
  { email: 'enf-driver@test.shieldmylot.com',  role: 'driver',        company: 'Test-ENF' },
  // Test-LEGACY (5)
  { email: 'legacy-ca@test.shieldmylot.com',       role: 'company_admin', company: 'Test-LEGACY' },
  { email: 'legacy-manager@test.shieldmylot.com',  role: 'manager',       company: 'Test-LEGACY' },
  { email: 'legacy-leasing@test.shieldmylot.com',  role: 'leasing_agent', company: 'Test-LEGACY' },
  { email: 'legacy-driver@test.shieldmylot.com',   role: 'driver',        company: 'Test-LEGACY' },
  { email: 'legacy-resident@test.shieldmylot.com', role: 'resident',      company: 'Test-LEGACY' },
  // Demo Company (5)
  { email: 'demo-ca@test.shieldmylot.com',       role: 'company_admin', company: 'Demo Company' },
  { email: 'demo-manager@test.shieldmylot.com',  role: 'manager',       company: 'Demo Company' },
  { email: 'demo-leasing@test.shieldmylot.com',  role: 'leasing_agent', company: 'Demo Company' },
  { email: 'demo-driver@test.shieldmylot.com',   role: 'driver',        company: 'Demo Company' },
  { email: 'demo-resident@test.shieldmylot.com', role: 'resident',      company: 'Demo Company' },
]

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  seed-test-tenants — auth.users + seed_test_tenants() RPC')
  console.log('══════════════════════════════════════════════════════════════════\n')

  // ── Pre-flight ────────────────────────────────────────────────────
  if (!URL || !SERVICE) {
    console.error('❌ missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  if (OK !== '1') {
    console.error('❌ SEED_TEST_TENANTS_OK must be "1"')
    process.exit(2)
  }
  if (!PASSWORD || PASSWORD.length < 12) {
    console.error('❌ SEED_TEST_PASSWORD must be non-empty and >= 12 chars')
    process.exit(2)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log('─── Pre-flight ───────────────────────────────────────────────────')
  const { data: aegis, error: aegisErr } = await admin.auth.admin.getUserById(AEGIS_UUID)
  if (aegisErr || !aegis?.user) {
    console.error(`❌ aegis (${AEGIS_UUID}) NOT in auth.users: ${aegisErr?.message ?? 'null user'}`)
    process.exit(3)
  }
  console.log(`  ✓ aegis exists: ${aegis.user.email}`)
  console.log(`  Seeded users: ${SEED_USERS.length}`)
  console.log(`  Password: (${PASSWORD.length} chars, not logged)\n`)

  // ── Create auth.users (idempotent per-user via listUsers scan) ─
  console.log('─── auth.users create (idempotent) ────────────────────────────────')
  const { data: pageA, error: enumErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (enumErr) {
    console.error(`❌ listUsers failed: ${enumErr.message}`)
    process.exit(3)
  }
  const existing = new Map<string, string>()
  for (const u of ((pageA as any).users ?? [])) {
    if (u.email) existing.set(u.email.toLowerCase(), u.id)
  }

  let created = 0
  let skipped = 0
  let failed = 0
  for (const u of SEED_USERS) {
    if (existing.has(u.email.toLowerCase())) {
      console.log(`  · skip existing: ${u.email}`)
      skipped++
      continue
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,
    })
    if (error) {
      console.error(`  ⚠ createUser(${u.email}) failed: ${error.message}`)
      failed++
    } else {
      console.log(`  ✓ created: ${u.email} (${(data as any).user?.id ?? '<no id>'})`)
      created++
    }
  }
  console.log(`  auth.users: created=${created} skipped=${skipped} failed=${failed}\n`)

  if (failed > 0) {
    console.error('❌ one or more auth.users creates failed — refuse to proceed to DB seed')
    process.exit(3)
  }

  // ── Call the seed RPC ────────────────────────────────────────────
  console.log('─── seed_test_tenants() RPC ───────────────────────────────────────')
  const { data: seedResult, error: seedErr } = await admin.rpc('seed_test_tenants')
  if (seedErr) {
    console.error(`❌ seed_test_tenants RPC failed: ${seedErr.message}`)
    process.exit(3)
  }
  console.log('  Result:')
  console.log('   ', JSON.stringify(seedResult, null, 2).replace(/\n/g, '\n    '))
  console.log('')

  // ── Post-verify ─────────────────────────────────────────────────
  console.log('─── Post-verify ──────────────────────────────────────────────────')

  const { count: prodCount } = await admin.from('companies').select('*', { count: 'exact', head: true }).eq('company_env', 'production')
  const { count: testCount } = await admin.from('companies').select('*', { count: 'exact', head: true }).eq('company_env', 'test')
  const { count: demoCount } = await admin.from('companies').select('*', { count: 'exact', head: true }).eq('company_env', 'demo')
  console.log(`  companies: production=${prodCount ?? 0} test=${testCount ?? 0} demo=${demoCount ?? 0}`)
  if (testCount !== 3) { console.error(`❌ expected 3 test companies, got ${testCount}`); process.exit(3) }
  if (demoCount !== 1) { console.error(`❌ expected 1 demo company, got ${demoCount}`); process.exit(3) }

  const { count: userRolesCount } = await admin.from('user_roles').select('*', { count: 'exact', head: true }).like('email', '%@test.shieldmylot.com')
  console.log(`  user_roles @test.shieldmylot.com: ${userRolesCount ?? 0}`)
  if (userRolesCount !== 18) { console.error(`❌ expected 18 seeded user_roles, got ${userRolesCount}`); process.exit(3) }

  const { count: propCount } = await admin.from('properties').select('*', { count: 'exact', head: true }).in('company', ['Test-PM', 'Test-ENF', 'Test-LEGACY', 'Demo Company'])
  console.log(`  seeded properties: ${propCount ?? 0}`)
  if (propCount !== 4) { console.error(`❌ expected 4 seeded properties, got ${propCount}`); process.exit(3) }

  // Critical: no Stripe artifacts on seeded companies.
  const { data: stripeLeaks } = await admin.from('companies').select('name, stripe_customer_id, stripe_subscription_id').in('company_env', ['test', 'demo'])
  const leaks = (stripeLeaks ?? []).filter((r: any) => r.stripe_customer_id != null || r.stripe_subscription_id != null)
  if (leaks.length > 0) {
    console.error(`❌ CRITICAL: ${leaks.length} test/demo companies carry Stripe IDs`)
    console.error(JSON.stringify(leaks, null, 2))
    process.exit(3)
  }
  console.log(`  ✓ no Stripe IDs on any test/demo company`)

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(`  🟢 Seed complete.`)
  console.log(`  auth.users: created=${created} skipped=${skipped}`)
  console.log(`  companies: 3 test + 1 demo (${prodCount ?? 0} production untouched)`)
  console.log(`  user_roles: 18 @test.shieldmylot.com`)
  console.log(`  properties: 4 seeded`)
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(e => {
  console.error('❌ unhandled error:', e)
  process.exit(3)
})
