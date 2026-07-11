#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// PRELAUNCH auth.users DELETE — ONE-TIME follow-up
// 2026-07-11
//
// CONTEXT
//   The main script (prelaunch-reset-ONE-TIME.ts) aborted before the
//   auth.users delete because a false-positive drift check flagged
//   the wipe-marker row in audit_logs (audit_logs was in the generic
//   zero-loop; it should have been =1, not =0). DB is clean; only
//   auth.users still holds the 246 orphans + aegis.
//
//   Same-companion fix removes audit_logs from that array so the main
//   script never trips on the marker again.
//
// SCOPE
//   • Delete every auth.users row EXCEPT the aegis UUID.
//   • Preserve by UUID; never by email.
//   • Old admin (2066921f-…) MUST be in the delete set (else abort).
//   • Interactive WIPE AUTH type-back.
//   • Post-delete: aegis still exists, old admin gone, count == 1.
//   • Rows-affected assertion — any drift aborts.
//
// USAGE
//   PRELAUNCH_AUTH_DELETE_OK=1 \
//     npx tsx --env-file=.env.local \
//     scripts/prelaunch-auth-users-delete-ONE-TIME.ts
//
// RETIRE
//   Retire alongside prelaunch-reset-ONE-TIME.ts + the wipe migrations
//   in runbook Phase 6 (after A1 code issued).
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import * as readline from 'readline/promises'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const OK      = process.env.PRELAUNCH_AUTH_DELETE_OK

const AEGIS_UUID     = 'a767da27-b452-475a-adda-1b75ae393c59'
const OLD_ADMIN_UUID = '2066921f-edaf-45db-a29c-4129eee4a1d2'

async function main() {
  if (!URL || !SERVICE) {
    console.error('❌ missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  if (OK !== '1') {
    console.error('❌ PRELAUNCH_AUTH_DELETE_OK must be "1"')
    process.exit(2)
  }

  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log('─── Pre-flight ───────────────────────────────────────────────────')
  const { data: preserve, error: peErr } = await admin.auth.admin.getUserById(AEGIS_UUID)
  if (peErr || !preserve?.user) {
    console.error(`❌ aegis (${AEGIS_UUID}) NOT in auth.users: ${peErr?.message ?? 'null user'} — refuse`)
    process.exit(3)
  }
  console.log(`  ✓ aegis exists: ${preserve.user.email} id=${AEGIS_UUID}`)

  console.log('\n─── Enumerate auth.users ─────────────────────────────────────────')
  const all: any[] = []
  let page = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) {
      console.error(`❌ listUsers page ${page} failed: ${error.message}`)
      process.exit(3)
    }
    const users = (data as any).users ?? []
    all.push(...users)
    if (users.length < 1000) break
    page++
    if (page > 20) {
      console.error('❌ pagination overflow (>20 pages) — refuse')
      process.exit(3)
    }
  }
  console.log(`  Total auth.users: ${all.length}`)

  const toDelete = all.filter(u => u.id !== AEGIS_UUID)
  const oldAdminInSet = toDelete.some(u => u.id === OLD_ADMIN_UUID)
  console.log(`  Preserve: 1 (aegis)`)
  console.log(`  Delete:   ${toDelete.length}`)
  console.log(`  Old admin (${OLD_ADMIN_UUID}) in delete set: ${oldAdminInSet ? '✓' : '⚠ NOT PRESENT'}`)

  // Belt-and-suspenders: aegis must NOT be in the delete set.
  if (toDelete.some(u => u.id === AEGIS_UUID)) {
    console.error('❌ CRITICAL: aegis appears in delete set — refuse')
    process.exit(3)
  }

  // Old admin should be in the delete set — else something odd happened.
  // Might have been deleted by an earlier partial run; verify absence.
  if (!oldAdminInSet) {
    const { data: oldCheck } = await admin.auth.admin.getUserById(OLD_ADMIN_UUID)
    if (oldCheck?.user) {
      console.error('❌ old admin exists in auth.users but not in delete set — refuse')
      process.exit(3)
    }
    console.log(`  (old admin already absent from auth.users — acceptable)`)
  }

  console.log('\n─── Interactive confirm ──────────────────────────────────────────')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const countBack = await rl.question(`  Type the delete count (${toDelete.length}) back to confirm: `)
  if (countBack.trim() !== String(toDelete.length)) {
    console.error('❌ count mismatch — refuse')
    rl.close()
    process.exit(3)
  }
  const yes = await rl.question(`  Type "WIPE AUTH" to proceed: `)
  if (yes.trim() !== 'WIPE AUTH') {
    console.error('❌ refuse')
    rl.close()
    process.exit(3)
  }
  rl.close()

  console.log('\n─── Deleting ─────────────────────────────────────────────────────')
  let succeeded = 0
  let failed = 0
  for (const u of toDelete) {
    const { error } = await admin.auth.admin.deleteUser(u.id)
    if (error) {
      console.error(`  ⚠ deleteUser(${u.id}) failed: ${error.message}`)
      failed++
    } else {
      succeeded++
    }
  }
  console.log(`  Deleted ${succeeded}; failures ${failed}`)

  console.log('\n─── Post-delete verification ─────────────────────────────────────')
  const { data: aegisPost, error: apErr } = await admin.auth.admin.getUserById(AEGIS_UUID)
  if (apErr || !aegisPost?.user) {
    console.error(`❌ CRITICAL: aegis missing post-delete (${apErr?.message ?? 'null'}) — RESTORE`)
    process.exit(3)
  }
  console.log(`  ✓ aegis still present: ${aegisPost.user.email}`)

  const { data: oldGone } = await admin.auth.admin.getUserById(OLD_ADMIN_UUID)
  if (oldGone?.user) {
    console.error(`❌ old admin STILL exists post-delete`)
    process.exit(3)
  }
  console.log(`  ✓ old admin gone`)

  // Final count assertion — the enforcement. If any deleteUser silently
  // failed, the count won't match and we abort loudly.
  const finalPage1 = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (finalPage1.error) {
    console.error(`❌ final listUsers failed: ${finalPage1.error.message}`)
    process.exit(3)
  }
  const finalCount = ((finalPage1.data as any).users ?? []).length
  if (finalCount !== 1) {
    console.error(`❌ auth.users count = ${finalCount} (expected 1); ${failed} deletes failed — investigate`)
    process.exit(3)
  }
  console.log(`  ✓ auth.users count = 1 (aegis only)`)

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(`  🟢 auth.users delete complete.`)
  console.log(`  Deleted: ${succeeded}    Failed: ${failed}    Final: 1 (aegis)`)
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(e => {
  console.error('❌ unhandled error:', e)
  process.exit(3)
})
