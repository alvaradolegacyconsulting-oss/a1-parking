// ════════════════════════════════════════════════════════════════════
// Pre-launch scorched RESET — ONE-TIME coordinator script
//
// Phase 4 of a1_go_live_sequence_consolidated_july8_2026.md.
//
// ⚠️  Retire this script (delete from repo) after the run. Do not
//     leave a general "wipe all tenants" tool live post-A1.
//
// TWO-PHASE STRUCTURE (single-transaction on DB side)
//   Phase A — JS pre-flight + interactive confirms
//     • Env-var gates + snapshot staleness
//     • getUserById(NEW_SUPERADMIN_ID) resolves aegis's email
//     • Assert aegis's user_roles.role = 'admin' (super-admin)
//     • Interactive type-back of URL + snapshot id + "WIPE PROD"
//   Phase B — SQL migration paste (Jose in SQL Editor)
//     • migrations/20260709_prelaunch_wipe_TENANT_DATA.sql
//     • BEGIN + null-out + refuse-if-live guard + DELETE cascade +
//       user_roles preserve + audit marker + COMMIT
//     • Any RAISE inside DO block → auto-ROLLBACK, zero partial state
//   Phase C — JS post-apply verification + auth.users delete
//     • Verify tenant counts == 0, user_roles == 1, catalog == 20,
//       audit_logs == 1 (the wipe marker)
//     • Enumerate auth.users, delete all but aegis (by UUID)
//     • Summary print for runbook log
//
// USAGE
//   Dry-run (default, no writes):
//     PRELAUNCH_WIPE_OK=1 \
//     PRELAUNCH_SNAPSHOT_ID=<placeholder-for-dry-run> \
//     PRELAUNCH_SNAPSHOT_CREATED_AT=<ISO-8601-timestamp> \
//     NEW_SUPERADMIN_ID=a767da27-b452-475a-adda-1b75ae393c59 \
//     npx tsx --env-file=.env.local scripts/prelaunch-reset-ONE-TIME.ts
//
//   Apply (destructive; requires SQL Editor step in the middle):
//     ... same env ... --apply
// ════════════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as readline from 'readline'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const NEW_SUPERADMIN_ID = process.env.NEW_SUPERADMIN_ID
const PRELAUNCH_WIPE_OK = process.env.PRELAUNCH_WIPE_OK
const PRELAUNCH_SNAPSHOT_ID         = process.env.PRELAUNCH_SNAPSHOT_ID
const PRELAUNCH_SNAPSHOT_CREATED_AT = process.env.PRELAUNCH_SNAPSHOT_CREATED_AT

const OLD_ADMIN_ID = '2066921f-edaf-45db-a29c-4129eee4a1d2'
const STRIPE_LEFTOVER_IDS = [52, 53, 56, 58, 80]
const MIGRATION_PATH = 'migrations/20260709_prelaunch_wipe_TENANT_DATA.sql'

const APPLY = process.argv.includes('--apply')
const DRY_RUN = !APPLY

// Tenant tables — all EXPECTED to be 0 post-wipe. Also used for the
// dry-run's "would delete" count readout.
const TENANT_TABLES = [
  'companies', 'properties', 'residents', 'vehicles', 'drivers',
  'violations', 'visitor_passes', 'guest_authorizations',
  'space_requests', 'space_residents', 'space_assignment_history', 'spaces',
  'storage_facilities', 'flag_acknowledgments', 'dispute_requests',
  'proposal_codes', 'tos_acceptances', 'stripe_events',
  'vehicle_plate_changes', 'violation_photos', 'violation_videos',
] as const

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())))
}

async function tableCount(admin: SupabaseClient, table: string, filter?: (q: any) => any): Promise<number> {
  let q = admin.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count, error } = await q
  if (error) return -1
  return count ?? 0
}

function fmt(n: number): string { return n < 0 ? '(err)' : String(n).padStart(7) }

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  PRE-LAUNCH SCORCHED RESET — ONE-TIME')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  Mode: ${APPLY ? '🔴 APPLY (SQL Editor paste required mid-run)' : '🟢 DRY-RUN (no writes; no SQL paste)'}`)
  console.log('')

  // ── PHASE A: JS pre-flight ───────────────────────────────────────
  const missingEnv: string[] = []
  if (!URL) missingEnv.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!SERVICE) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!NEW_SUPERADMIN_ID) missingEnv.push('NEW_SUPERADMIN_ID')
  if (PRELAUNCH_WIPE_OK !== '1') missingEnv.push('PRELAUNCH_WIPE_OK (must be "1")')
  if (!PRELAUNCH_SNAPSHOT_ID) missingEnv.push('PRELAUNCH_SNAPSHOT_ID')
  if (!PRELAUNCH_SNAPSHOT_CREATED_AT) missingEnv.push('PRELAUNCH_SNAPSHOT_CREATED_AT')
  if (missingEnv.length) {
    console.error('❌ Missing required env vars: ' + missingEnv.join(', '))
    process.exit(2)
  }

  const snapshotAge = Date.now() - Date.parse(PRELAUNCH_SNAPSHOT_CREATED_AT!)
  if (isNaN(snapshotAge)) {
    console.error(`❌ PRELAUNCH_SNAPSHOT_CREATED_AT is not valid ISO 8601: "${PRELAUNCH_SNAPSHOT_CREATED_AT}"`)
    process.exit(2)
  }
  const snapshotAgeMin = Math.floor(snapshotAge / 60000)
  if (APPLY && snapshotAgeMin > 60) {
    console.error(`❌ Snapshot is ${snapshotAgeMin} min old — must be ≤ 60 for --apply. Take a fresh one.`)
    process.exit(2)
  }
  console.log(`  Snapshot ID:   ${PRELAUNCH_SNAPSHOT_ID}`)
  console.log(`  Snapshot age:  ${snapshotAgeMin} min ${APPLY ? '(staleness limit: 60 min)' : '(dry-run: staleness not enforced)'}`)
  console.log(`  Supabase URL:  ${URL}`)
  console.log(`  NEW super-admin UUID: ${NEW_SUPERADMIN_ID}`)
  console.log(`  Migration file: ${MIGRATION_PATH}`)
  console.log('')

  const admin = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false } })

  // ── Pre-flight safety asserts ────────────────────────────────────
  console.log('─── Pre-flight safety asserts ────────────────────────────────────')
  if (NEW_SUPERADMIN_ID === OLD_ADMIN_ID) {
    console.error(`❌ NEW_SUPERADMIN_ID equals the OLD admin id (${OLD_ADMIN_ID}) — Phase 3 not run.`)
    process.exit(2)
  }
  console.log(`  ✓ NEW_SUPERADMIN_ID != OLD_ADMIN_ID`)

  const { data: preserveUser, error: peErr } = await admin.auth.admin.getUserById(NEW_SUPERADMIN_ID!)
  if (peErr || !preserveUser?.user) {
    console.error(`❌ NEW_SUPERADMIN_ID does not exist in auth.users: ${peErr?.message ?? 'null user'}`)
    process.exit(2)
  }
  const aegisEmail = preserveUser.user.email!
  console.log(`  ✓ auth.users row exists for aegis: ${aegisEmail}`)

  const { data: aegisRole, error: arErr } = await admin
    .from('user_roles').select('id, email, role, company').ilike('email', aegisEmail).maybeSingle()
  if (arErr || !aegisRole) {
    console.error(`❌ No user_roles row for aegis (${aegisEmail}): ${arErr?.message ?? 'not found'}`)
    process.exit(2)
  }
  if (aegisRole.role !== 'admin') {
    console.error(`❌ aegis user_roles.role='${aegisRole.role}' (expected 'admin'). Refuse.`)
    process.exit(2)
  }
  console.log(`  ✓ aegis's user_roles.role = 'admin' [user_roles.id=${aegisRole.id}]`)
  console.log('')

  // ── Informational: pre-null-out Stripe-ID count + env breakdown ──
  console.log('─── Live-DB informational readout ────────────────────────────────')
  const { data: preStripeRows, count: preStripeCount } = await admin
    .from('companies')
    .select('id, name, stripe_customer_id, stripe_subscription_id, company_env', { count: 'exact' })
    .or('stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null')
  console.log(`  Companies carrying non-null Stripe IDs (pre-null-out): ${preStripeCount}`)
  ;(preStripeRows ?? []).forEach(r => {
    console.log(`    - id=${r.id} ${r.name}  env=${r.company_env}  cus=${r.stripe_customer_id ?? '-'}  sub=${r.stripe_subscription_id ?? '-'}`)
  })
  const { data: envRows } = await admin.from('companies').select('company_env')
  const envCounts: Record<string, number> = {}
  ;(envRows ?? []).forEach((r: any) => { envCounts[String(r.company_env ?? 'NULL')] = (envCounts[String(r.company_env ?? 'NULL')] ?? 0) + 1 })
  console.log(`  company_env breakdown: ${JSON.stringify(envCounts)}`)
  console.log('')

  // ── Would-delete counts (dry-run readout) ────────────────────────
  console.log('─── Would-delete counts (per table) ──────────────────────────────')
  console.log(`   #  table                                  count`)
  console.log(`  --  -------------------------------------- ${'-'.repeat(7)}`)
  const preCounts: Record<string, number> = {}
  // Custom stripe_prices only (proposal_code_id NOT NULL)
  const stripeCustomCount = await tableCount(admin, 'stripe_prices', q => q.not('proposal_code_id', 'is', null))
  preCounts['stripe_prices (custom rows)'] = stripeCustomCount
  console.log(`  ${'1'.padStart(2)}  ${'stripe_prices (custom rows)'.padEnd(38)} ${fmt(stripeCustomCount)}`)
  for (let i = 0; i < TENANT_TABLES.length; i++) {
    const t = TENANT_TABLES[i]
    const c = await tableCount(admin, t)
    preCounts[t] = c
    console.log(`  ${String(i+2).padStart(2)}  ${String(t).padEnd(38)} ${fmt(c)}`)
  }
  const urPre = await tableCount(admin, 'user_roles')
  console.log(`  ${String(TENANT_TABLES.length+2).padStart(2)}  ${'user_roles (all but aegis)'.padEnd(38)} ${fmt(urPre-1)}  [preserve id=${aegisRole.id}]`)
  const catalogPre = await tableCount(admin, 'stripe_prices', q => q.is('proposal_code_id', null))
  console.log(`      ${'stripe_prices (catalog KEPT)'.padEnd(38)} ${fmt(catalogPre)}  ← preserved`)
  console.log(`      ${'platform_settings (UNTOUCHED)'.padEnd(38)}      -   ← preserved`)
  console.log('')

  // ── auth.users enumeration (informational, no writes yet) ────────
  console.log('─── auth.users enumeration ───────────────────────────────────────')
  let page = 1
  const allUsers: any[] = []
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) { console.error(`  ❌ listUsers failed: ${error.message}`); process.exit(3) }
    const users = (data as any).users ?? []
    allUsers.push(...users)
    if (users.length < 1000) break
    page++
    if (page > 20) break
  }
  const toDelete = allUsers.filter(u => u.id !== NEW_SUPERADMIN_ID)
  const oldAdminInDelete = toDelete.find(u => u.id === OLD_ADMIN_ID)
  console.log(`  Total auth.users: ${allUsers.length}`)
  console.log(`  Preserve: 1 (${aegisEmail}, id=${NEW_SUPERADMIN_ID})`)
  console.log(`  Delete:   ${toDelete.length}${oldAdminInDelete ? ' (includes old admin@alc.com ✓)' : ' (⚠ old admin id NOT in delete set — expected but flag)'}`)
  console.log('')

  // ── DRY-RUN: stop here ───────────────────────────────────────────
  if (DRY_RUN) {
    console.log('══════════════════════════════════════════════════════════════════')
    console.log('  🟢 DRY-RUN complete. Zero writes made.')
    console.log('')
    console.log('  Next: report this output to Jose. Re-run with --apply to proceed.')
    console.log(`  Apply flow: pre-flight → SQL Editor paste of ${MIGRATION_PATH} →`)
    console.log(`  post-apply verification → auth.users delete → summary.`)
    console.log('══════════════════════════════════════════════════════════════════')
    return
  }

  // ══════════════════════════════════════════════════════════════════
  // ── APPLY MODE from here on ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // ── Interactive confirm ──────────────────────────────────────────
  console.log('─── Interactive confirmation (APPLY MODE) ────────────────────────')
  console.log(`  You are about to WIPE production DB at: ${URL}`)
  const urlBack = await prompt(rl, `\n  Type the URL back verbatim to confirm: `)
  if (urlBack !== URL) { console.error(`\n❌ URL mismatch. Refuse.`); rl.close(); process.exit(3) }
  const snapBack = await prompt(rl, `\n  Type the snapshot id back to confirm: `)
  if (snapBack !== PRELAUNCH_SNAPSHOT_ID) { console.error(`\n❌ Snapshot mismatch. Refuse.`); rl.close(); process.exit(3) }
  const finalYes = await prompt(rl, `\n  Type "WIPE PROD" to proceed: `)
  if (finalYes !== 'WIPE PROD') { console.error(`\n❌ Final confirm mismatch. Refuse.`); rl.close(); process.exit(3) }
  console.log('  ✓ interactive confirmations passed\n')

  // ── PHASE B: SQL Editor paste ────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  PHASE B — PASTE THE SQL MIGRATION IN SUPABASE SQL EDITOR')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  Open Supabase Dashboard → SQL Editor.`)
  console.log(`  Paste the ENTIRE contents of:`)
  console.log(`    ${MIGRATION_PATH}`)
  console.log(`  as ONE block (single-paste discipline). Run.`)
  console.log('')
  console.log(`  The migration wraps everything in BEGIN/COMMIT:`)
  console.log(`    • null-out on 5 leftover companies rows`)
  console.log(`    • refuse-if-live guard (RAISE if Stripe IDs remain)`)
  console.log(`    • DELETE cascade (22 tables, reverse-topological)`)
  console.log(`    • user_roles preserve aegis (RAISE if count != 1)`)
  console.log(`    • audit_logs marker row (PRELAUNCH_WIPE_APPLIED)`)
  console.log('')
  console.log(`  Any RAISE inside triggers auto-ROLLBACK. Zero partial state.`)
  console.log('')

  const pasted = await prompt(rl, `  Confirm you applied the migration and it succeeded (type "APPLIED"): `)
  if (pasted !== 'APPLIED') { console.error(`\n❌ Did not confirm SQL Editor apply. Refuse.`); rl.close(); process.exit(4) }
  console.log('')

  // ── PHASE C: Post-apply verification ─────────────────────────────
  console.log('─── Post-apply verification ──────────────────────────────────────')
  const postCounts: Record<string, number> = {}
  let drift = false

  // Every tenant table must be 0
  for (const t of TENANT_TABLES) {
    const c = await tableCount(admin, t)
    postCounts[t] = c
    if (c !== 0) { console.error(`  ❌ ${t} = ${c} (expected 0)`); drift = true }
    else console.log(`  ✓ ${t} = 0`)
  }
  // Custom stripe_prices = 0
  const stripeCustomPost = await tableCount(admin, 'stripe_prices', q => q.not('proposal_code_id', 'is', null))
  if (stripeCustomPost !== 0) { console.error(`  ❌ stripe_prices (custom) = ${stripeCustomPost} (expected 0)`); drift = true }
  else console.log(`  ✓ stripe_prices (custom) = 0`)
  // Catalog UNCHANGED
  const catalogPost = await tableCount(admin, 'stripe_prices', q => q.is('proposal_code_id', null))
  if (catalogPost !== catalogPre) { console.error(`  ❌ stripe_prices (catalog) = ${catalogPost} (expected ${catalogPre})`); drift = true }
  else console.log(`  ✓ stripe_prices (catalog) = ${catalogPost} (unchanged)`)
  // user_roles = 1 (aegis)
  const urPost = await tableCount(admin, 'user_roles')
  if (urPost !== 1) { console.error(`  ❌ user_roles = ${urPost} (expected 1)`); drift = true }
  else console.log(`  ✓ user_roles = 1 (aegis)`)
  // audit_logs = 1 (the wipe marker)
  const auditPost = await tableCount(admin, 'audit_logs')
  if (auditPost !== 1) { console.error(`  ⚠ audit_logs = ${auditPost} (expected 1 = wipe marker)`); }
  else console.log(`  ✓ audit_logs = 1 (wipe marker)`)

  if (drift) {
    console.error(`\n  ❌ Post-apply drift detected. Snapshot restore recommended before proceeding.`)
    rl.close(); process.exit(5)
  }
  console.log('')

  // ── PHASE C: auth.users delete (id-only, aegis preserved) ────────
  console.log('─── auth.users delete (preserve aegis by UUID) ───────────────────')
  console.log(`  Deleting ${toDelete.length} auth.users (may take a couple minutes)...`)
  let succeeded = 0, failed = 0
  for (const u of toDelete) {
    const { error } = await admin.auth.admin.deleteUser(u.id)
    if (error) { console.error(`    ⚠ deleteUser(${u.id}) failed: ${error.message}`); failed++ }
    else succeeded++
    if (succeeded % 50 === 0) console.log(`    progress: ${succeeded}/${toDelete.length} deleted`)
  }
  console.log(`  ✓ deleted ${succeeded} auth.users; ${failed} failures`)

  // Sanity: aegis still exists
  const { data: postPreserve, error: ppErr } = await admin.auth.admin.getUserById(NEW_SUPERADMIN_ID!)
  if (ppErr || !postPreserve?.user) {
    console.error(`  ❌ CRITICAL: preserved super-admin id ${NEW_SUPERADMIN_ID} NOT resolvable post-wipe. Restore from snapshot.`)
    rl.close(); process.exit(6)
  }
  console.log(`  ✓ preserved super-admin still resolves: ${postPreserve.user.email}`)
  // Sanity: old admin gone
  const { data: oldGone } = await admin.auth.admin.getUserById(OLD_ADMIN_ID)
  if (oldGone?.user) console.error(`  ⚠ Old admin ${OLD_ADMIN_ID} STILL exists — deleteUser may have failed`)
  else console.log(`  ✓ old admin@alc.com (${OLD_ADMIN_ID}) gone`)
  console.log('')

  // ── UNIQUE(lower(email)) migration reminder ──────────────────────
  console.log('─── UNIQUE(lower(email)) migration reminder ──────────────────────')
  console.log(`  Now paste in SQL Editor:`)
  console.log(`    migrations/20260704_user_roles_unique_lower_email.sql`)
  console.log(`  Safe now: only the aegis row remains in user_roles (no dups possible).`)
  console.log('')

  // ── Summary ──────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  APPLY SUMMARY`)
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  Snapshot ID:            ${PRELAUNCH_SNAPSHOT_ID}`)
  console.log(`  Snapshot age at start:  ${snapshotAgeMin} min`)
  console.log(`  Preserved super-admin:  ${NEW_SUPERADMIN_ID} (${aegisEmail})`)
  console.log(`  auth.users deleted:     ${succeeded} (${failed} failures)`)
  console.log(`  Catalog stripe_prices:  ${catalogPost} rows (unchanged)`)
  console.log(`  audit_logs marker:      1 (PRELAUNCH_WIPE_APPLIED)`)
  console.log('')
  console.log(`  Next steps:`)
  console.log(`    1. Apply migrations/20260704_user_roles_unique_lower_email.sql in SQL Editor`)
  console.log(`    2. Verify aegis login + /admin loads`)
  console.log(`    3. Verify old admin@alc.com login FAILS`)
  console.log(`    4. RETIRE THIS SCRIPT — delete scripts/prelaunch-reset-ONE-TIME.ts`)
  console.log(`       AND migrations/20260709_prelaunch_wipe_TENANT_DATA.sql from the repo`)
  console.log(`    5. Proceed to Phase 5 (Stripe archival) + Phase 6 (issue A1's real code)`)
  console.log('══════════════════════════════════════════════════════════════════')
  rl.close()
}

main().catch(e => {
  console.error('\n❌ Script threw:', e)
  console.error('   Snapshot is your rollback point.')
  process.exit(99)
})
