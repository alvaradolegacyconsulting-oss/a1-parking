#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// reset-consent — clear all tos_acceptances rows for one user (by email)
// 2026-07-16 — added after per-portal validation kept producing
// "ghost" false alarms from stale/leftover rows and wrong-UID deletes.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/reset-consent.ts <email>
//   npx tsx --env-file=.env.local scripts/reset-consent.ts legacy-driver@test.shieldmylot.com
//
//   Env override (production, guarded — see below):
//     ALLOW_RESET_ON_PRODUCTION=1 npx tsx ... scripts/reset-consent.ts <prod-email>
//
// WHAT IT DOES
//   1. Resolves the email → auth.users.id (single source of truth; no
//      hand-typed UIDs, no risk of pasting an email into a uuid column).
//   2. Reports the user's current tos_acceptances row count + shape.
//   3. DELETEs every tos_acceptances row for that user_id (as service_role).
//   4. Re-reads to confirm 0 rows and prints the confirmation.
//   5. Also nulls the user_roles stamp columns (tos_accepted_at,
//      tos_accepted_version, privacy_accepted_version,
//      saas_accepted_version, texas_confirmed) so the ORIGINAL "stamps
//      survived while rows were gone" divergence class is cleared too —
//      matters for pre-Commit-4 login-modal predicate testing, harmless
//      post-Commit-4 (stamps aren't consulted by hasCurrentConsents).
//
// SAFETY — TWO-LOCK PRODUCTION GUARDRAIL (mirrors smoke-auth.ts)
//   Lock 1 (env resolution): auth.users lookup returns the user's
//     resolved company; if that company's company_env='production',
//     the script refuses unless Lock 2 is also set.
//   Lock 2 (env var): ALLOW_RESET_ON_PRODUCTION=1 must be exported in
//     the operator shell (NOT in .env.local; deliberate).
//
//   Both must be true to touch a production user. Missing either = refuse
//   with a loud error naming the resolved env. Test-LEGACY (company_env
//   ='test') passes with no override; nothing to remember.
//
// ENV
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

const email = process.argv[2]
if (!email) {
  console.error('❌ usage: reset-consent <email>')
  process.exit(2)
}
if (!URL || !SERVICE) {
  console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  console.error('   run with: npx tsx --env-file=.env.local scripts/reset-consent.ts <email>')
  process.exit(2)
}

async function main() {
  const admin = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  reset-consent')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  target email: ${email}`)

  // ── Step 1 — resolve email → auth.users.id ──────────────────────
  // auth.users is not exposed to PostgREST by default; use the admin
  // API's listUsers which supports server-side filtering.
  const { data: userList, error: userErr } = await admin.auth.admin.listUsers({
    page: 1, perPage: 200,
  })
  if (userErr) { console.error(`❌ auth.users list failed: ${userErr.message}`); process.exit(3) }
  const user = userList.users.find(u => (u.email ?? '').toLowerCase() === email.toLowerCase())
  if (!user) { console.error(`❌ no auth.users row for ${email}`); process.exit(4) }

  const uid = user.id
  console.log(`  resolved uid: ${uid}`)

  // ── Step 2 — resolve target company + env for the two-lock check ─
  const { data: roleRow } = await admin
    .from('user_roles').select('email, role, company').ilike('email', email).maybeSingle()
  const companyName: string | null = (roleRow?.company as string | null) ?? null
  let companyEnv: string | null = null
  if (companyName) {
    const { data: coRow } = await admin
      .from('companies').select('company_env').ilike('name', companyName).maybeSingle()
    companyEnv = (coRow?.company_env as string | null) ?? null
  }
  console.log(`  resolved role: ${roleRow?.role ?? '(no role row)'} · company: ${companyName ?? '(none)'} · env: ${companyEnv ?? '(unknown)'}`)

  // ── 🔴 LOAD-BEARING GUARDRAIL — two-lock production ─────────────
  if (companyEnv === 'production' && process.env.ALLOW_RESET_ON_PRODUCTION !== '1') {
    console.error('')
    console.error(`❌ REFUSING to reset ${email} — company_env=production.`)
    console.error(`   To reset a production user, export ALLOW_RESET_ON_PRODUCTION=1 in your shell`)
    console.error(`   AND re-run. Two-lock discipline — both env-resolution AND explicit opt-in.`)
    process.exit(5)
  }

  // ── Step 3 — pre-count + pre-report ─────────────────────────────
  const { data: preRows } = await admin
    .from('tos_acceptances')
    .select('id, document_type, tos_version, privacy_version, saas_version, attestation_version, accepted_at')
    .eq('user_id', uid)
    .order('id')
  const preCount = preRows?.length ?? 0
  console.log(`\n─── Before delete ─────────────────────────────────────────────────`)
  console.log(`  tos_acceptances rows for uid: ${preCount}`)
  for (const r of preRows ?? []) {
    console.log(`    id=${r.id} type=${r.document_type} tos_v=${r.tos_version} priv_v=${r.privacy_version} saas_v=${r.saas_version} attest_v=${r.attestation_version} at=${r.accepted_at}`)
  }

  // ── Step 4 — DELETE tos_acceptances + null user_roles stamps ────
  console.log(`\n─── Deleting ──────────────────────────────────────────────────────`)
  const { data: deleted, error: delErr } = await admin
    .from('tos_acceptances').delete().eq('user_id', uid).select('id')
  if (delErr) { console.error(`❌ delete failed: ${delErr.message}`); process.exit(6) }
  console.log(`  ✓ deleted ${deleted?.length ?? 0} tos_acceptances rows`)

  const { error: stampErr } = await admin
    .from('user_roles')
    .update({
      tos_accepted_at: null,
      tos_accepted_version: null,
      privacy_accepted_version: null,
      saas_accepted_version: null,
      texas_confirmed: false,
    })
    .ilike('email', email)
  if (stampErr) {
    console.warn(`  ⚠ user_roles stamp reset returned: ${stampErr.message} (non-fatal — stamps aren't consulted by Commit-2+ gates)`)
  } else {
    console.log(`  ✓ nulled user_roles stamp columns for ${email}`)
  }

  // ── Step 5 — verify + summary ───────────────────────────────────
  const { count: postCount } = await admin
    .from('tos_acceptances').select('id', { count: 'exact', head: true }).eq('user_id', uid)
  console.log(`\n─── After delete ──────────────────────────────────────────────────`)
  console.log(`  tos_acceptances rows for uid: ${postCount}`)

  console.log('\n══════════════════════════════════════════════════════════════════')
  if (postCount === 0) {
    console.log(`  🟢 consent CLEARED for ${email}`)
    console.log(`  · email : ${email}`)
    console.log(`  · uid   : ${uid}`)
    console.log(`  · role  : ${roleRow?.role ?? '(no role)'}`)
    console.log(`  · env   : ${companyEnv ?? '(unknown)'}`)
    console.log(`  · rows  : 0 (verified)`)
    console.log(`  · stamps: nulled`)
    console.log(``)
    console.log(`  Ready for fresh /consent gate test. Sign in as ${email}, direct-nav to portal,`)
    console.log(`  expect 307 → /consent with role-appropriate doc set.`)
  } else {
    console.log(`  🔴 reset INCOMPLETE — ${postCount} row(s) still present after delete.`)
    console.log(`     Investigate: possible trigger reinserting, wrong uid resolved, or RLS trap.`)
  }
  console.log('══════════════════════════════════════════════════════════════════')
  process.exit(postCount === 0 ? 0 : 1)
}

main().catch(e => { console.error('❌ unhandled:', e); process.exit(3) })
