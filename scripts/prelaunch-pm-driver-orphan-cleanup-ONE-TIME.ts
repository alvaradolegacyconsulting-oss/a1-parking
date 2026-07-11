#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// One-off orphan cleanup — pm-driver@test.shieldmylot.com
// 2026-07-11
//
// CONTEXT
//   seed_test_tenants() v1 created a pm-driver@ user_roles + auth.users
//   row. That account is structurally invalid: pm_only tier has
//   MAX_DRIVERS=0 (product design — PM is management-only). The
//   drivers-table INSERT correctly refused (enforce_driver_limit
//   trigger fired), but the auth.users + user_roles rows landed
//   before that. seed_test_tenants v1.1 removed pm-driver@ from the
//   seed entirely; this script cleans up the orphan from prior runs.
//
// SCOPE
//   • DELETE user_roles row for pm-driver@test.shieldmylot.com
//   • admin.auth.admin.deleteUser(uid) for the same email
//   • Nothing else. Positive-target discipline: hard-coded email,
//     no glob, no wildcard.
//
// USAGE
//   PRELAUNCH_PM_DRIVER_CLEANUP_OK=1 \
//     npx tsx --env-file=.env.local \
//     scripts/prelaunch-pm-driver-orphan-cleanup-ONE-TIME.ts
//
// SAFETY
//   • Pre-flight assert: aegis exists (proves service key is live).
//   • Idempotent: if pm-driver@ is already gone, script logs and exits 0.
//   • Verifies both surfaces (auth.users + user_roles) end at 0 for
//     this email before exiting.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const OK      = process.env.PRELAUNCH_PM_DRIVER_CLEANUP_OK

const TARGET_EMAIL = 'pm-driver@test.shieldmylot.com'
const AEGIS_UUID   = 'a767da27-b452-475a-adda-1b75ae393c59'

async function main() {
  if (!URL || !SERVICE) { console.error('❌ missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(2) }
  if (OK !== '1')       { console.error('❌ PRELAUNCH_PM_DRIVER_CLEANUP_OK must be "1"'); process.exit(2) }

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('─── Pre-flight ───────────────────────────────────────────────────')
  const { data: aegis, error: aegisErr } = await admin.auth.admin.getUserById(AEGIS_UUID)
  if (aegisErr || !aegis?.user) { console.error(`❌ aegis check failed: ${aegisErr?.message ?? 'null user'}`); process.exit(3) }
  console.log(`  ✓ aegis reachable: ${aegis.user.email}`)
  console.log(`  Target email: ${TARGET_EMAIL}`)

  // ── Find pm-driver@ in auth.users ───────────────────────────────
  // Supabase admin listUsers doesn't have an email filter; page-scan.
  console.log('\n─── Locate in auth.users ─────────────────────────────────────────')
  const found: string[] = []
  let page = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) { console.error(`❌ listUsers page ${page} failed: ${error.message}`); process.exit(3) }
    const users = (data as any).users ?? []
    for (const u of users) {
      if (u.email && u.email.toLowerCase() === TARGET_EMAIL.toLowerCase()) found.push(u.id)
    }
    if (users.length < 1000) break
    page++
    if (page > 20) { console.error('❌ pagination overflow'); process.exit(3) }
  }
  console.log(`  auth.users rows matching: ${found.length}`)

  if (found.length === 0) {
    console.log(`  (already gone — idempotent success)`)
  } else if (found.length > 1) {
    console.error(`❌ multiple auth.users rows for ${TARGET_EMAIL} — investigate manually`)
    console.error(`   ids: ${found.join(', ')}`)
    process.exit(3)
  } else {
    const uid = found[0]
    console.log(`  auth.users id: ${uid}`)

    console.log('\n─── DELETE auth.users row ────────────────────────────────────────')
    const { error: delErr } = await admin.auth.admin.deleteUser(uid)
    if (delErr) { console.error(`❌ deleteUser(${uid}) failed: ${delErr.message}`); process.exit(3) }
    console.log(`  ✓ deleted ${uid}`)
  }

  // ── DELETE user_roles row (independent of auth.users) ────────────
  console.log('\n─── DELETE user_roles row ────────────────────────────────────────')
  const { error: urErr, count: urCount } = await admin
    .from('user_roles')
    .delete({ count: 'exact' })
    .eq('email', TARGET_EMAIL)
  if (urErr) { console.error(`❌ user_roles delete failed: ${urErr.message}`); process.exit(3) }
  console.log(`  user_roles rows deleted: ${urCount ?? 0}`)

  // ── Post-verify ──────────────────────────────────────────────────
  console.log('\n─── Post-verify ──────────────────────────────────────────────────')
  let stillPresent = 0
  page = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) { console.error(`❌ post-verify listUsers failed: ${error.message}`); process.exit(3) }
    const users = (data as any).users ?? []
    for (const u of users) {
      if (u.email && u.email.toLowerCase() === TARGET_EMAIL.toLowerCase()) stillPresent++
    }
    if (users.length < 1000) break
    page++
    if (page > 20) break
  }
  if (stillPresent !== 0) { console.error(`❌ auth.users still contains ${stillPresent} row(s) for ${TARGET_EMAIL}`); process.exit(3) }
  console.log(`  ✓ auth.users: 0 rows for ${TARGET_EMAIL}`)

  const { count: urFinal } = await admin.from('user_roles').select('*', { count: 'exact', head: true }).eq('email', TARGET_EMAIL)
  if ((urFinal ?? 0) !== 0) { console.error(`❌ user_roles still contains ${urFinal} row(s)`); process.exit(3) }
  console.log(`  ✓ user_roles: 0 rows for ${TARGET_EMAIL}`)

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(`  🟢 pm-driver@ orphan cleanup complete.`)
  console.log(`     auth.users deleted: ${found.length}   user_roles deleted: ${urCount ?? 0}`)
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(e => { console.error('❌ unhandled error:', e); process.exit(3) })
