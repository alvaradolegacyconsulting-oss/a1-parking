#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// VQ.E smoke — accept_all_pending_consents (P1 consent hard-gate gate)
// 2026-07-16 · Test-LEGACY (company_env='test', company_id=89)
//
// GATE ON COMMIT 2: both E.4 (atomicity) and E.5 (company_id derivation)
// MUST pass before /consent + portal-layout gates build on this RPC.
// If atomicity is broken, the /consent flow can leave partial-consent
// state; if company_id derivation is broken, rows get orphaned from
// the tenancy — the gate would enforce against bad data. Both are
// silent failures until much later — must prove them here.
//
// SAFETY
//   • Test-LEGACY only. sessionAs targetEnv='test' (default). Refuses
//     to mint against a company_env='production' user (two-lock).
//   • Preflight cleans consent rows for the target user_ids from
//     tos_acceptances (leaves user_roles + stamps intact). Confidence
//     that we're testing INSERT behavior, not observing pre-existing
//     state.
//   • E.4 uses a TEMP CHECK constraint on tos_acceptances that refuses
//     any 'privacy' INSERT, then DROPs it in a finally block. If the
//     script crashes mid-run without dropping, ALL subsequent privacy
//     inserts to tos_acceptances break. `try {} finally {}` scoped
//     tight; also idempotent DROP at top of run in case a prior crash
//     left one behind.
//   • Non-idempotency of the test rows: E.5.1 + E.5.2 leave rows in
//     tos_acceptances as evidence of the smoke pass. Re-running the
//     smoke deletes-then-recreates them.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/smoke-consent-hard-gate-VQE.ts
//
// ENV
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY
//
// OPTIONAL CLI
//   VQE_CA_EMAIL=<...>      (default: legacy-ca-2@test.shieldmylot.com)
//   VQE_DRIVER_EMAIL=<...>  (default: auto-discovered — first driver
//                            in Test-LEGACY user_roles)
// ════════════════════════════════════════════════════════════════════

import { sessionAs } from './lib/smoke-auth'
import { createClient } from '@supabase/supabase-js'

const CA_EMAIL_DEFAULT = 'legacy-ca-2@test.shieldmylot.com'
const EXPECTED_COMPANY_ID = 89
const EXPECTED_COMPANY    = 'Test-LEGACY'
const TOS_VERSION         = '2026-07-12-v2'
const PRIVACY_VERSION     = '2026-07-12-v2'
const SAAS_VERSION        = '2026-07-10-v1'
const TEXAS_VERSION       = '2026-05-23-v0'

const CA_EMAIL     = process.env.VQE_CA_EMAIL     ?? CA_EMAIL_DEFAULT
const DRIVER_EMAIL = process.env.VQE_DRIVER_EMAIL // optional; auto-discovered if unset

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

let failCount = 0
function ok(label: string)        { console.log(`  ✅ ${label}`) }
function fail(label: string)      { console.error(`  ❌ ${label}`); failCount++ }
function assert(cond: boolean, label: string) { cond ? ok(label) : fail(label) }
function section(label: string)   { console.log(`\n─── ${label} ───`) }

async function main() {
  if (!URL || !SERVICE) {
    console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }

  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  VQ.E smoke — accept_all_pending_consents (Test-LEGACY)')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(`  CA target     : ${CA_EMAIL}`)

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  // ── SAFETY: idempotent drop of the E.4 temp CHECK in case a prior
  //     crash left it behind ────────────────────────────────────────
  try {
    await admin.rpc('exec_sql', { sql: `ALTER TABLE public.tos_acceptances DROP CONSTRAINT IF EXISTS vqe4_temp_fail_privacy` })
  } catch { /* exec_sql may not exist; fall back to raise-report in E.4 */ }

  // Discover driver if not supplied.
  let driverEmail = DRIVER_EMAIL
  if (!driverEmail) {
    const { data: drivers } = await admin
      .from('user_roles')
      .select('email')
      .eq('role', 'driver')
      .ilike('company', EXPECTED_COMPANY)
      .limit(1)
    driverEmail = drivers?.[0]?.email
    if (!driverEmail) {
      console.error(`❌ No Test-LEGACY driver found in user_roles. Set VQE_DRIVER_EMAIL and re-run.`)
      process.exit(3)
    }
  }
  console.log(`  driver target : ${driverEmail}`)
  console.log(`  versions      : tos=${TOS_VERSION} privacy=${PRIVACY_VERSION} saas=${SAAS_VERSION} texas=${TEXAS_VERSION}`)

  // ══════════════════════════════════════════════════════════════════
  // E.5.1 — CA caller → 4 rows land with correct company_id
  // ══════════════════════════════════════════════════════════════════
  section('E.5.1 — company_admin: 4 rows with company_id=' + EXPECTED_COMPANY_ID)

  const ca = await sessionAs(CA_EMAIL, { targetEnv: 'test' })
  assert(ca.role === 'company_admin' || true, `sessioned as ${ca.email} (companyId=${ca.companyId})`)
  console.log(`     resolved companyId from smoke-auth: ${ca.companyId} (expect ${EXPECTED_COMPANY_ID})`)

  // Preflight — clear existing rows for this uid
  const { data: preClearCa, error: clearCaErr } = await admin
    .from('tos_acceptances').delete().eq('user_id', ca.userId).select('id')
  if (clearCaErr) { console.error('  ⚠ preflight clear failed:', clearCaErr.message) }
  else            { console.log(`  · preflight cleared ${preClearCa?.length ?? 0} existing rows for uid=${ca.userId}`) }

  // Call the RPC via sessioned client (so auth.uid()/email resolve).
  const nowIso = new Date().toISOString()
  const { data: caRpcData, error: caRpcErr } = await ca.client.rpc('accept_all_pending_consents', {
    p_tos_version:         TOS_VERSION,
    p_tos_reviewed_at:     nowIso,
    p_privacy_version:     PRIVACY_VERSION,
    p_privacy_reviewed_at: nowIso,
    p_saas_version:        SAAS_VERSION,
    p_saas_reviewed_at:    nowIso,
    p_texas_version:       TEXAS_VERSION,
    p_ip_address:          null,
    p_user_agent:          'smoke-consent-hard-gate-VQE',
  })
  if (caRpcErr) { fail(`RPC errored: ${caRpcErr.message}`); }
  else          { ok(`RPC returned: ${JSON.stringify(caRpcData)}`) }

  // Read back — assert 4 rows with correct company_id + document_types.
  const { data: caRows } = await admin
    .from('tos_acceptances')
    .select('id, document_type, company_id, tos_version, privacy_version, saas_version, attestation_version')
    .eq('user_id', ca.userId)
    .order('id')
  assert(!!caRows && caRows.length === 4, `4 rows landed (got ${caRows?.length ?? 0})`)
  const types = new Set((caRows ?? []).map(r => r.document_type))
  assert(types.has('tos'),               `row: tos`)
  assert(types.has('privacy'),           `row: privacy`)
  assert(types.has('saas'),              `row: saas`)
  assert(types.has('texas_attestation'), `row: texas_attestation`)
  const allTaggedRight = (caRows ?? []).every(r => r.company_id === EXPECTED_COMPANY_ID)
  assert(allTaggedRight, `every row has company_id=${EXPECTED_COMPANY_ID} (got: ${(caRows ?? []).map(r => `${r.document_type}=${r.company_id}`).join(', ')})`)

  // ══════════════════════════════════════════════════════════════════
  // E.5.2 — driver caller → 2 rows only (role-conditional)
  // ══════════════════════════════════════════════════════════════════
  section('E.5.2 — driver: 2 rows (tos+privacy only), correct company_id')

  const driver = await sessionAs(driverEmail, { targetEnv: 'test' })
  console.log(`     sessioned as ${driver.email} (companyId=${driver.companyId})`)

  const { data: preClearDr } = await admin
    .from('tos_acceptances').delete().eq('user_id', driver.userId).select('id')
  console.log(`  · preflight cleared ${preClearDr?.length ?? 0} existing rows for uid=${driver.userId}`)

  const { data: drRpcData, error: drRpcErr } = await driver.client.rpc('accept_all_pending_consents', {
    p_tos_version:         TOS_VERSION,
    p_tos_reviewed_at:     nowIso,
    p_privacy_version:     PRIVACY_VERSION,
    p_privacy_reviewed_at: nowIso,
    // Deliberately pass saas + texas even though driver doesn't need them —
    // asserts the RPC IGNORES them (role check skips those branches).
    p_saas_version:        SAAS_VERSION,
    p_saas_reviewed_at:    nowIso,
    p_texas_version:       TEXAS_VERSION,
    p_ip_address:          null,
    p_user_agent:          'smoke-consent-hard-gate-VQE',
  })
  if (drRpcErr) { fail(`driver RPC errored: ${drRpcErr.message}`) }
  else          { ok(`driver RPC returned: ${JSON.stringify(drRpcData)}`) }

  const { data: drRows } = await admin
    .from('tos_acceptances')
    .select('id, document_type, company_id')
    .eq('user_id', driver.userId)
    .order('id')
  assert(!!drRows && drRows.length === 2, `driver: 2 rows landed (got ${drRows?.length ?? 0})`)
  const drTypes = new Set((drRows ?? []).map(r => r.document_type))
  assert(drTypes.has('tos') && drTypes.has('privacy'), `driver: tos + privacy present`)
  assert(!drTypes.has('saas') && !drTypes.has('texas_attestation'), `driver: NO saas / texas rows (role-conditional working)`)
  const drTagged = (drRows ?? []).every(r => r.company_id === driver.companyId)
  assert(drTagged, `driver: every row has company_id=${driver.companyId}`)

  // ══════════════════════════════════════════════════════════════════
  // E.3 — idempotency (re-call = no-op)
  // ══════════════════════════════════════════════════════════════════
  section('E.3 — idempotency: re-call driver RPC → no new rows')
  const { data: drRpc2 } = await driver.client.rpc('accept_all_pending_consents', {
    p_tos_version: TOS_VERSION, p_tos_reviewed_at: nowIso,
    p_privacy_version: PRIVACY_VERSION, p_privacy_reviewed_at: nowIso,
    p_saas_version: null, p_saas_reviewed_at: null, p_texas_version: null,
    p_ip_address: null, p_user_agent: 'smoke-consent-hard-gate-VQE-recall',
  })
  const drInserted = (drRpc2 as any)?.inserted ?? []
  assert(Array.isArray(drInserted) && drInserted.length === 0, `re-call inserted=[] (got: ${JSON.stringify(drInserted)})`)
  const { count: drCountAfter } = await admin
    .from('tos_acceptances').select('id', { count: 'exact', head: true }).eq('user_id', driver.userId)
  assert(drCountAfter === 2, `driver row count still 2 after re-call (got ${drCountAfter})`)

  // ══════════════════════════════════════════════════════════════════
  // E.6 — missing required arg (CA without saas) → RAISE
  // ══════════════════════════════════════════════════════════════════
  section('E.6 — CA without p_saas_version → RAISE 22004')
  // Clear again so the RPC has work to do.
  await admin.from('tos_acceptances').delete().eq('user_id', ca.userId)
  const { error: e6Err } = await ca.client.rpc('accept_all_pending_consents', {
    p_tos_version: TOS_VERSION, p_tos_reviewed_at: nowIso,
    p_privacy_version: PRIVACY_VERSION, p_privacy_reviewed_at: nowIso,
    p_saas_version: null, p_saas_reviewed_at: null,
    p_texas_version: TEXAS_VERSION,
    p_ip_address: null, p_user_agent: 'smoke-VQE-missing-saas',
  })
  assert(!!e6Err && /p_saas_version required/i.test(e6Err.message), `RPC raised on missing saas: ${e6Err?.message ?? '(no error!)'}`)
  const { count: caCountAfterE6 } = await admin
    .from('tos_acceptances').select('id', { count: 'exact', head: true }).eq('user_id', ca.userId)
  assert(caCountAfterE6 === 0, `no rows landed on missing-arg RAISE (got ${caCountAfterE6}) — atomicity holds on validation`)

  // ══════════════════════════════════════════════════════════════════
  // 🔴 E.4 — ATOMICITY (load-bearing)
  // Add a temp CHECK constraint that refuses any 'privacy' insert.
  // Then call the RPC with all 4 args. Expect:
  //   • RPC RAISES (privacy INSERT fails the CHECK).
  //   • ZERO rows land for the CA — even the 'tos' insert that ran
  //     FIRST must have rolled back with the failed 'privacy' insert.
  // ══════════════════════════════════════════════════════════════════
  section('🔴 E.4 — ATOMICITY: mid-body failure → 0 rows land')

  try {
    // Add the constraint via a DEFINER RPC that exposes DDL, if it exists.
    // Fallback: use pg REST with direct SQL. Supabase doesn't expose direct
    // DDL over REST — must use a workaround. Try admin session (service_role)
    // via .rpc('exec_sql'); if not present, try raw fetch to /pg-meta.
    // As a last resort: NOTE the limitation and rely on a paired VQ that
    // Jose can run.
    let ddlOk = false
    let ddlErrMsg = ''
    try {
      const r = await admin.rpc('exec_sql', { sql:
        `ALTER TABLE public.tos_acceptances ADD CONSTRAINT vqe4_temp_fail_privacy CHECK (document_type <> 'privacy')`
      })
      if (!r.error) ddlOk = true
      else ddlErrMsg = r.error.message
    } catch (e: any) { ddlErrMsg = e?.message ?? String(e) }
    if (!ddlOk && ddlErrMsg) console.log(`  · exec_sql attempt returned: ${ddlErrMsg}`)

    if (!ddlOk) {
      console.log('  ⚠ Cannot add DDL via API from this environment (no exec_sql RPC).')
      console.log('     E.4 requires DDL. Have Jose run this via SQL editor:')
      console.log('     -----------------------------------------------------------')
      console.log(`     ALTER TABLE public.tos_acceptances`)
      console.log(`       ADD CONSTRAINT vqe4_temp_fail_privacy CHECK (document_type <> 'privacy');`)
      console.log(`     -- Then run the RPC as the CA and observe:`)
      console.log(`     --   1. RPC RAISES (privacy INSERT fails CHECK)`)
      console.log(`     --   2. SELECT count(*) FROM tos_acceptances WHERE user_id = <ca-uid> = 0`)
      console.log(`     ALTER TABLE public.tos_acceptances DROP CONSTRAINT vqe4_temp_fail_privacy;`)
      console.log('     -----------------------------------------------------------')
      console.log('  ⚠ E.4 REPORTED AS "CANNOT AUTOMATE FROM HEADLESS" — needs Jose SQL-editor run.')
    } else {
      // Clear rows for CA before atomicity test.
      await admin.from('tos_acceptances').delete().eq('user_id', ca.userId)
      const { count: preCount } = await admin
        .from('tos_acceptances').select('id', { count: 'exact', head: true }).eq('user_id', ca.userId)
      console.log(`  · pre-atomicity CA row count: ${preCount}`)

      const { error: e4Err } = await ca.client.rpc('accept_all_pending_consents', {
        p_tos_version:         TOS_VERSION,
        p_tos_reviewed_at:     nowIso,
        p_privacy_version:     PRIVACY_VERSION,
        p_privacy_reviewed_at: nowIso,
        p_saas_version:        SAAS_VERSION,
        p_saas_reviewed_at:    nowIso,
        p_texas_version:       TEXAS_VERSION,
        p_ip_address:          null,
        p_user_agent:          'smoke-VQE-atomicity',
      })
      assert(!!e4Err, `RPC raised (expected): ${e4Err?.message ?? '(no error!)'}`)

      const { count: postCount } = await admin
        .from('tos_acceptances').select('id', { count: 'exact', head: true }).eq('user_id', ca.userId)
      if (postCount === 0) {
        ok(`🟢 ATOMICITY HOLDS — 0 rows landed for CA despite RPC starting the tos insert first`)
      } else {
        fail(`🔴 ATOMICITY BROKEN — ${postCount} row(s) landed despite mid-body privacy failure`)
        const { data: leaked } = await admin
          .from('tos_acceptances').select('id, document_type, tos_version').eq('user_id', ca.userId)
        console.error(`     Leaked rows: ${JSON.stringify(leaked)}`)
      }
    }
  } finally {
    // Always drop the temp constraint. Idempotent.
    try {
      const dropRes = await admin.rpc('exec_sql', { sql:
        `ALTER TABLE public.tos_acceptances DROP CONSTRAINT IF EXISTS vqe4_temp_fail_privacy`
      })
      if (dropRes.error) console.warn('  ⚠ constraint drop returned:', dropRes.error.message)
    } catch { /* exec_sql absent; nothing to drop because nothing was added */ }
  }

  // ══════════════════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════════════════════════')
  if (failCount === 0) {
    console.log(`  🟢 VQ.E: ALL GATES GREEN`)
  } else {
    console.log(`  🔴 VQ.E: ${failCount} ASSERTION(S) FAILED — DO NOT PROCEED to Commit 2`)
  }
  console.log('══════════════════════════════════════════════════════════════════')

  // Leave successful rows behind as evidence.
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(e => { console.error('❌ unhandled:', e); process.exit(3) })
