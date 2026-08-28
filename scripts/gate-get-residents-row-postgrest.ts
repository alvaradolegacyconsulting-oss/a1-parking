// gate-get-residents-row-postgrest.ts
//
// 🔴 vehicles.company arc — PostgREST FUNCTION-signature cache gate
//
// Runs BETWEEN the DDL migration
// (20260828_get_residents_row_by_precedence_add_company.sql) and any
// consumer push that expects the 4-column return shape. The Postgres-
// side verification asserts the function exists with the new return
// shape in pg_proc. That proves POSTGRES has it. PostgREST caches
// function signatures too and may still return the OLD 3-column shape
// via .rpc() for a short window after DDL — same class of hazard as
// the G6 column-cache gate for Commit 1.
//
// Mateo Aug 28 §1.1: "PostgREST caches function signatures too. Before
// the consumer change ships, confirm through REST that the call
// returns four columns. A SQL-side check that the function has the
// new signature proves Postgres knows; it proves nothing about
// PostgREST."
//
// Check: call get_residents_row_by_precedence via .rpc() with a real
// email (any residents row), assert the response object includes a
// `company` key. If missing → PostgREST cache is stale, wait for
// reload and re-run. No writes, no cleanup — this function is a
// pure SELECT.
//
// Run:
//   npx tsx --env-file=.env.local scripts/gate-get-residents-row-postgrest.ts
//
// Exit codes:
//   0 — cache sees the new signature; safe to push consumers
//   1 — env or setup failure
//   2 — cache stale (response has no company key) — wait ~10s, re-run
//   3 — RPC call errored for reasons other than cache staleness

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !SERVICE) {
  console.error('Missing env — need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

async function main() {
  console.log('════════════════════════════════════════════════════════')
  console.log('vehicles.company arc — PostgREST function-signature gate')
  console.log('  target: get_residents_row_by_precedence(TEXT)')
  console.log('════════════════════════════════════════════════════════\n')

  const admin = createClient(URL!, SERVICE!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── 1. Resolve a probe email from residents ─────────────────────
  // Any residents row will do; we just need something the function
  // resolves to non-empty so the returned row's keys are inspectable.
  console.log('1) Resolving a probe email from residents')
  const { data: probeRow, error: probeErr } = await admin
    .from('residents')
    .select('email, company')
    .not('email', 'is', null)
    .not('company', 'is', null)
    .limit(1)
    .maybeSingle()
  if (probeErr || !probeRow?.email) {
    console.error(`   ✗ Could not resolve a probe residents row: ${probeErr?.message ?? 'no row'}`)
    process.exit(1)
  }
  const probeEmail = probeRow.email.toLowerCase()
  console.log(`   ✓ Probe email resolved (company="${probeRow.company}")`)

  // ── 2. Call the function via .rpc() and inspect the response shape
  console.log('\n2) .rpc(\'get_residents_row_by_precedence\', { p_email })')
  const { data, error } = await admin.rpc('get_residents_row_by_precedence', { p_email: probeEmail })
  if (error) {
    console.error(`   ✗ RPC FAIL: ${error.code ?? 'unknown'} — ${error.message}`)
    if (error.code === 'PGRST202' || /Could not find the function/i.test(error.message)) {
      console.error('     PostgREST cache does not see the function at all.')
      console.error('     Wait for reload and re-run. If persistent, issue:')
      console.error('       NOTIFY pgrst, \'reload schema\';')
      process.exit(2)
    }
    process.exit(3)
  }
  if (!Array.isArray(data) || data.length === 0) {
    console.error('   ✗ RPC returned no rows for a probe email that has a residents row.')
    console.error('     Body-side bug (unrelated to cache) — verify against the SQL verification file first.')
    process.exit(3)
  }
  const row = data[0] as Record<string, unknown>
  console.log(`   ✓ RPC returned 1 row. Keys: [${Object.keys(row).join(', ')}]`)

  // ── 3. THE gate: response includes `company` key ────────────────
  console.log('\n3) Cache-visibility check — response must include `company`')
  if (!('company' in row)) {
    console.error('   ✗ FAIL: response has no `company` key.')
    console.error('     PostgREST is returning the OLD 3-column signature. Cache is stale.')
    console.error('     Wait ~10s and re-run. If persistent, re-issue:')
    console.error('       NOTIFY pgrst, \'reload schema\';')
    process.exit(2)
  }
  if (row.company === null || row.company === undefined || String(row.company).trim() === '') {
    console.error(`   ✗ FAIL: response has \`company\` key but value is empty (got: ${JSON.stringify(row.company)}).`)
    console.error('     Cache sees the column but the function is returning NULL for it.')
    console.error('     Verify Postgres-side execution gate (G8) also passed — that would have caught this.')
    process.exit(3)
  }
  console.log(`   ✓ Response includes company="${row.company}" — new signature is live in PostgREST.`)

  console.log('\n════════════════════════════════════════════════════════')
  console.log('🟢 PASS — PostgREST cache sees get_residents_row_by_precedence\'s new 4-column shape.')
  console.log('   Safe to push consumers that expect the `company` field.')
  console.log('════════════════════════════════════════════════════════')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n✗ Unhandled error:', e)
  process.exit(1)
})
