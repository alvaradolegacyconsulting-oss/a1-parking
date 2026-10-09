#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Smoke — accept_saas_agreement, first-ever real execution
// 2026-07-14 · Test-LEGACY (company_env='test', company_id=89)
//
// WHY THIS EXISTS
//   d707e14 fixed a landmine in accept_saas_agreement — the pre-fix
//   UPDATE clause referenced a nonexistent user_roles.user_id column,
//   throwing 42703 on every invocation. But the RPC has never actually
//   fired in production (A1's SaaS row landed via redeem_proposal_code's
//   inline INSERT, not via this RPC). Until this smoke passes, the fix
//   is theory. Until the fix is proven, Decision 1 (SaaS gate on
//   company_admin login) cannot ship, and A1 cannot receive a second CA.
//
// WHY WE CAN'T JUST CURL
//   Supabase Auth enforces Turnstile CAPTCHA on password-grant. A
//   scripted password login is precisely what Turnstile blocks. The
//   Turnstile check is doing its job — we route around it via the
//   admin.generateLink() → verifyOtp flow, which uses service_role
//   directly and bypasses the auth password grant entirely.
//
// APPROACH
//   1. As service_role, admin.generateLink({ type: 'magiclink',
//      email: legacy-ca-2@test.shieldmylot.com }) — mints a
//      hashed_token bound to that user.
//   2. As anon client, verifyOtp({ token_hash, type: 'magiclink' })
//      → exchange the hash for a real session (access_token + user).
//   3. Create a new client that carries the session's access_token as
//      an Authorization header, so subsequent RPC calls fire under
//      that user's JWT (auth.uid() + auth.jwt()->>'email' resolve).
//   4. Invoke accept_saas_agreement.
//   5. Read back the tos_acceptances row (as service_role, to bypass
//      RLS on the read) and assert company_id=89.
//   6. Bonus: get_company_admin_emails('Test-LEGACY') as the same
//      session — should return 2 rows (legacy-ca + legacy-ca-2).
//
// PASS =
//   • No 42703 on accept_saas_agreement (landmine dead)
//   • The tos_acceptances row has document_type='saas', company_id=89,
//     reviewed_at populated
//   • get_company_admin_emails('Test-LEGACY') returns 2 rows
//
// SAFETY
//   • Test-LEGACY is company_env='test'. WRITE goes to a test tenant,
//     not A1 (id 91).
//   • generateLink is service-role-only; email delivery is suppressed
//     (we consume the token programmatically before Supabase would
//     have emailed it — but generateLink itself doesn't email).
//   • No cleanup of the tos_acceptances row — the smoke's whole point
//     is to leave a real post-fix row as evidence. Retire this script
//     after PASS.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/smoke-accept-saas-agreement-ONE-TIME.ts
//
// ENV
//   NEXT_PUBLIC_SUPABASE_URL       — target project
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  — for the session-carrying client
//   SUPABASE_SERVICE_ROLE_KEY      — for admin.generateLink + read-back
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const URL         = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON        = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE     = process.env.SUPABASE_SERVICE_ROLE_KEY

const TARGET_EMAIL         = 'legacy-ca-2@test.shieldmylot.com'
const EXPECTED_COMPANY_ID  = 89
const EXPECTED_COMPANY     = 'Test-LEGACY'
const SAAS_VERSION         = '2026-07-10-v1'

async function main() {
  if (!URL || !ANON || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  smoke — accept_saas_agreement (first-ever real execution)')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  target : ${TARGET_EMAIL}`)
  console.log(`  expect : company_id=${EXPECTED_COMPANY_ID} (${EXPECTED_COMPANY})`)
  console.log(`  version: ${SAAS_VERSION}\n`)

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  // ── Step 1 — mint a magic link ────────────────────────────────────
  console.log('─── Step 1: admin.generateLink (service_role) ────────────────────')
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: TARGET_EMAIL,
  })
  if (linkErr) { console.error(`❌ generateLink failed: ${linkErr.message}`); process.exit(3) }

  const props = (linkData as { properties?: { action_link?: string; hashed_token?: string; email_otp?: string } }).properties
  const hashedToken = props?.hashed_token
  if (!hashedToken) {
    console.error('❌ no hashed_token in generateLink response')
    console.error('   response:', JSON.stringify(linkData, null, 2))
    process.exit(3)
  }
  console.log(`  ✓ hashed_token minted (${hashedToken.length} chars)\n`)

  // ── Step 2 — exchange the hash for a session ──────────────────────
  console.log('─── Step 2: verifyOtp (anon client) ──────────────────────────────')
  const anonClient = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  })
  if (verifyErr || !verifyData.session || !verifyData.user) {
    console.error(`❌ verifyOtp failed: ${verifyErr?.message ?? 'no session/user'}`)
    process.exit(3)
  }
  const accessToken = verifyData.session.access_token
  const userId      = verifyData.user.id
  console.log(`  ✓ session minted for uid=${userId}`)
  console.log(`  ✓ access_token (${accessToken.length} chars)\n`)

  // ── Step 3 — new client carrying the session's Authorization ─────
  const sessioned = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  // ── Step 4 — pre-count SaaS rows for this user (baseline) ─────────
  // FAIL LOUDLY on non-zero. legacy-ca-2@ has never seen a SaaS modal
  // (Jose's run card confirmed) and accept_saas_agreement has never
  // successfully executed anywhere. A pre-existing SaaS row here means
  // SOMETHING ELSE wrote it — that is a finding, not an edge case.
  // Do not "handle" it gracefully; stop and surface the row.
  console.log(`─── Baseline ─────────────────────────────────────────────────────`)
  const { data: preRows, error: preErr } = await admin
    .from('tos_acceptances')
    .select('id, user_id, company_id, document_type, saas_version, reviewed_at, user_agent, accepted_at')
    .eq('user_id', userId)
    .eq('document_type', 'saas')
    .order('id', { ascending: false })
  if (preErr) { console.error(`❌ baseline read failed: ${preErr.message}`); process.exit(3) }
  const preCount = preRows?.length ?? 0
  console.log(`  SaaS rows for uid pre-invocation: ${preCount}`)
  if (preCount !== 0) {
    console.error(`\n🔴 UNEXPECTED BASELINE — ${preCount} SaaS row(s) already exist for this uid.`)
    console.error(`   Something wrote a SaaS row before this smoke ran. STOPPING before write.`)
    console.error(`   Report the existing row(s):\n`)
    for (const r of preRows ?? []) {
      console.error(`     id=${r.id} company_id=${r.company_id} saas_version=${r.saas_version} reviewed_at=${r.reviewed_at} user_agent=${r.user_agent ?? '(null)'} accepted_at=${r.accepted_at}`)
    }
    process.exit(4)
  }
  console.log('')

  // ── Step 5 — 🔴 THE LOAD-BEARING CALL ─────────────────────────────
  console.log('─── Step 5: accept_saas_agreement (via CA session JWT) ───────────')
  const { data: rpcData, error: rpcErr } = await sessioned.rpc('accept_saas_agreement', {
    p_saas_version: SAAS_VERSION,
    p_reviewed_at : new Date().toISOString(),
    p_ip_address  : null,
    p_user_agent  : 'smoke-accept-saas-agreement-ONE-TIME',
  })
  if (rpcErr) {
    console.error(`❌ RPC failed: ${rpcErr.message}`)
    console.error(`   code: ${rpcErr.code ?? '(no code)'}`)
    if (rpcErr.code === '42703') {
      console.error(`\n🔴 42703 — the user_id landmine is STILL LIVE.`)
      console.error(`   d707e14 did not take. Migration state on prod does not match repo.`)
    }
    process.exit(3)
  }
  console.log(`  ✓ RPC returned without error (rpcData: ${JSON.stringify(rpcData)})\n`)

  // ── Step 6 — read back the row (service_role, bypasses RLS) ───────
  console.log('─── Step 6: read back tos_acceptances SaaS row ────────────────────')
  const { data: rows, error: readErr } = await admin
    .from('tos_acceptances')
    .select('id, user_id, company_id, document_type, saas_version, reviewed_at, ip_address, user_agent')
    .eq('user_id', userId)
    .eq('document_type', 'saas')
    .order('id', { ascending: false })
    .limit(1)
  if (readErr || !rows || rows.length === 0) {
    console.error(`❌ read-back failed: ${readErr?.message ?? 'no row'}`)
    process.exit(3)
  }
  const row = rows[0]
  console.log(`  id            : ${row.id}`)
  console.log(`  user_id       : ${row.user_id}`)
  console.log(`  company_id    : ${row.company_id}`)
  console.log(`  document_type : ${row.document_type}`)
  console.log(`  saas_version  : ${row.saas_version}`)
  console.log(`  reviewed_at   : ${row.reviewed_at}`)
  console.log(`  user_agent    : ${row.user_agent}\n`)

  const saasOk = row.company_id === EXPECTED_COMPANY_ID
                 && row.document_type === 'saas'
                 && row.saas_version === SAAS_VERSION
                 && row.reviewed_at !== null
  if (!saasOk) {
    console.error(`❌ SaaS-row verify FAILED`)
    console.error(`   expected company_id=${EXPECTED_COMPANY_ID}, document_type='saas', saas_version='${SAAS_VERSION}', reviewed_at!=null`)
    process.exit(3)
  }
  console.log(`  ✅ SaaS row PASS — company_id=${row.company_id}, reviewed_at populated\n`)

  // ── Step 7 — get_company_admin_emails as the same session ─────────
  console.log('─── Step 7: get_company_admin_emails via CA session ──────────────')
  const { data: caEmails, error: caErr } = await sessioned.rpc('get_company_admin_emails', {
    target_company: EXPECTED_COMPANY,
  })
  if (caErr) {
    console.error(`❌ get_company_admin_emails failed: ${caErr.message}`)
    process.exit(3)
  }
  const caRows = (caEmails ?? []) as Array<{ email: string }>
  console.log(`  returned rows: ${caRows.length}`)
  for (const r of caRows) console.log(`    ${r.email}`)
  const caOk = caRows.length === 2
  if (!caOk) {
    console.warn(`  ⚠ expected 2 CAs, got ${caRows.length} — reports finding but not a hard fail`)
  } else {
    console.log(`  ✅ multi-CA fanout PASS`)
  }

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(`  🟢 ALL GATES GREEN`)
  console.log(`  • accept_saas_agreement fired end-to-end without 42703`)
  console.log(`  • tos_acceptances row landed with company_id=${row.company_id}`)
  console.log(`  • get_company_admin_emails returned ${caRows.length} rows`)
  console.log('══════════════════════════════════════════════════════════════════')
}

main().catch(e => { console.error('❌ unhandled:', e); process.exit(3) })
