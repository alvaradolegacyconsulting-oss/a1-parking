// gate-vehicles-company-postgrest.ts
//
// 🔴 vehicles.company arc — PostgREST schema-cache visibility gate
//
// Runs BETWEEN Commit 1 (ADD COLUMN) and any Commit 2 writer push. The
// Postgres-side verification (migrations/20260828_vehicles_add_company_
// column_verification.sql) confirms the column exists in
// information_schema. That proves POSTGRES has it. It proves nothing
// about whether POSTGREST has reloaded its schema cache — a stale
// PostgREST cache produces PGRST204 "column not found in schema cache"
// on every insert, regardless of what Postgres thinks.
//
// Mateo Aug 28 § "New gate": every writer goes through PostgREST. A
// stale cache when Commit 2 lands means the fragile writer (/register
// companion-vehicle route) fails, gets logged loudly (thanks to the
// B209-fix error capture), but the resident's vehicle still doesn't
// land and they see a gap_message on what should be a clean
// registration.
//
// This script does two REST-side checks:
//   1. SELECT — `.from('vehicles').select('company').limit(0)`
//      Cheap probe: doesn't need a real row, just needs PostgREST to
//      resolve the column reference. Success proves the cache sees it.
//   2. INSERT-then-rollback — insert a probe row into a Test Legacy
//      property with company='__gate-probe__', assert it landed with
//      the value stamped, DELETE it. Proves the column is writable
//      through REST, not just readable.
//
// Runs at Test Legacy only. Deletes the probe row on completion
// regardless of pass/fail (throw + finally). A throwaway
// company_env='production' company inflates production_company_count().
//
// Run:
//   npx tsx --env-file=.env.local scripts/gate-vehicles-company-postgrest.ts
//
// Exit codes:
//   0 — all checks passed; safe to proceed with Commit 2 writers
//   1 — env or setup failure
//   2 — SELECT probe failed (schema cache stale — wait for reload, re-run)
//   3 — INSERT probe failed (schema cache, or other write error)
//   4 — cleanup failed (probe row may still exist — check G6.CLEANUP output)
//   5 — INSERT probe hit 23505 (constraint collision) — GATE DID NOT ACTUALLY RUN.
//       Not a schema-cache failure. Check for leftover probe rows or a plate
//       collision at the test property. Distinct from exit 3 per Mateo Aug 28.
//
// The intentional probe shape (is_active=false, status='pending') falls OUTSIDE
// the partial vehicles_plate_norm_uniq index predicate
// (WHERE is_active=true AND status IN ('active','under_review')), so an ordinary
// re-run should not collide. Exit 5 still exists because any OTHER unique
// constraint (present or future) collision must not be reported as a schema-
// cache issue — the gate has not actually run in that case.
//
// Corrected index name: vehicles_plate_norm_uniq (NOT vehicles_authorized_plate_uidx
// as some project notes claim; Mateo Aug 28 correction). It's partial, keyed on
// normalize_plate(plate) not upper(plate), and only enforces uniqueness for
// active+approved rows.

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !SERVICE) {
  console.error('Missing env — need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

// Test-Legacy tenant name literal — mirror probe scripts' convention of
// naming the tenant explicitly rather than looking up by company_env
// so a config mistake surfaces at run time, not silently.
const TEST_LEGACY_COMPANY_NAME = 'Test-LEGACY'
const PROBE_PROPERTY_NAME_HINT = 'test'   // ILIKE match — first test property

const PROBE_PLATE       = `GATE${Date.now().toString().slice(-6)}`
const PROBE_COMPANY_TAG = '__gate-probe__'
const PROBE_EMAIL       = 'gate-probe@test.shieldmylot.com'

async function main() {
  console.log('════════════════════════════════════════════════════════')
  console.log('vehicles.company arc — PostgREST cache-visibility gate')
  console.log('════════════════════════════════════════════════════════\n')

  const admin = createClient(URL!, SERVICE!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── SANITY: confirm we're pointed at a test tenant ─────────────
  console.log('0) Resolving Test-LEGACY property for probe scope...')
  const { data: propRow, error: propErr } = await admin
    .from('properties')
    .select('id, name, company')
    .ilike('company', `${TEST_LEGACY_COMPANY_NAME}%`)
    .ilike('name', `%${PROBE_PROPERTY_NAME_HINT}%`)
    .limit(1)
    .maybeSingle()
  if (propErr || !propRow) {
    console.error(`   ✗ Could not resolve a ${TEST_LEGACY_COMPANY_NAME} property: ${propErr?.message ?? 'none matched'}`)
    console.error('     Adjust TEST_LEGACY_COMPANY_NAME / PROBE_PROPERTY_NAME_HINT to match your test tenant.')
    process.exit(1)
  }
  console.log(`   ✓ Test property resolved: id=${propRow.id} name="${propRow.name}" company="${propRow.company}"`)

  // ── CHECK 1: SELECT probe ──────────────────────────────────────
  console.log('\n1) SELECT probe — .from(\'vehicles\').select(\'company\').limit(0)')
  const { error: selErr } = await admin
    .from('vehicles')
    .select('company')
    .limit(0)
  if (selErr) {
    console.error(`   ✗ FAIL: ${selErr.code ?? 'unknown'} — ${selErr.message}`)
    if (selErr.code === 'PGRST204' || /schema cache/i.test(selErr.message)) {
      console.error('     PostgREST schema cache is STALE. Wait ~10s for reload and re-run.')
      console.error('     If persistent, issue `NOTIFY pgrst, \'reload schema\';` and re-run.')
      process.exit(2)
    }
    process.exit(2)
  }
  console.log('   ✓ SELECT probe passed — PostgREST resolves the column.')

  // ── CHECK 2: INSERT probe ─────────────────────────────────────
  console.log('\n2) INSERT probe — write a real row with company populated')
  let inserted = false
  try {
    const { error: insErr } = await admin
      .from('vehicles')
      .insert([{
        plate:          PROBE_PLATE,
        state:          'TX',
        property:       propRow.name,       // NOT NULL per constraint 2a
        unit:           'GATE',
        resident_email: PROBE_EMAIL,
        company:        PROBE_COMPANY_TAG,  // the load-bearing column
        is_active:      false,
        status:         'pending',
      }])
    if (insErr) {
      console.error(`   ✗ FAIL: ${insErr.code ?? 'unknown'} — ${insErr.message}`)
      // 23505 first — distinct exit code + explicit "gate did not run"
      // per Mateo Aug 28 §2. A constraint collision does not tell us
      // anything about the schema cache, and reporting exit 3 for it
      // would read as "PostgREST can't write the column" when the real
      // cause is unrelated. Give it its own signal.
      if (insErr.code === '23505' || /duplicate key/i.test(insErr.message)) {
        console.error('     23505 unique-constraint violation. This is NOT a schema-cache issue —')
        console.error('     the gate did not actually run against PostgREST\'s ability to write')
        console.error('     the column. Possible causes:')
        console.error('       (a) A prior probe run left a row with the same plate at the test property')
        console.error('       (b) A leftover probe row anywhere in vehicles carrying company=__gate-probe__')
        console.error('     Diagnostic:')
        console.error('       SELECT * FROM public.vehicles WHERE company = \'__gate-probe__\';')
        console.error('       SELECT * FROM public.vehicles WHERE plate ILIKE \'GATE%\' AND property = \'' + propRow.name + '\';')
        console.error('     Delete leftovers manually and re-run.')
        process.exit(5)
      }
      if (insErr.code === 'PGRST204' || /schema cache/i.test(insErr.message)) {
        console.error('     PostgREST cache saw the column on SELECT but rejected it on INSERT?')
        console.error('     This is unusual. Wait for reload and re-run.')
      }
      process.exit(3)
    }
    inserted = true

    // Verify the probe row landed with company populated
    const { data: probeRow, error: readErr } = await admin
      .from('vehicles')
      .select('id, company')
      .eq('plate', PROBE_PLATE)
      .eq('property', propRow.name)
      .maybeSingle()
    if (readErr || !probeRow) {
      console.error(`   ✗ FAIL: probe row not readable back: ${readErr?.message ?? 'not found'}`)
      process.exit(3)
    }
    if (probeRow.company !== PROBE_COMPANY_TAG) {
      console.error(`   ✗ FAIL: probe row landed but company="${probeRow.company}" (expected "${PROBE_COMPANY_TAG}")`)
      process.exit(3)
    }
    console.log(`   ✓ INSERT probe passed — company written and read back as "${PROBE_COMPANY_TAG}"`)
  } finally {
    // ── CLEANUP: delete probe row ───────────────────────────────
    if (inserted) {
      console.log('\n3) Cleanup — deleting probe row')
      const { error: delErr, count: delCount } = await admin
        .from('vehicles')
        .delete({ count: 'exact' })
        .eq('plate', PROBE_PLATE)
        .eq('property', propRow.name)
        .eq('company', PROBE_COMPANY_TAG)   // extra scope guard
      if (delErr) {
        console.error(`   ✗ Cleanup FAILED: ${delErr.message}`)
        console.error(`     Probe row may still exist at ${propRow.name} — plate ${PROBE_PLATE}. Delete manually.`)
        process.exit(4)
      }
      console.log(`   ✓ Cleanup: ${delCount ?? '?'} probe row(s) deleted`)
    }
  }

  // ── G6.CLEANUP — belt-and-braces read across the FULL table ────
  // Per Mateo Aug 28 §2: the finally block above deletes the row we
  // just inserted, but a scoped delete might miss a leftover from an
  // earlier run that failed mid-flight. Commit 3's V3.BACKFILL asserts
  // v.company matches p.company; a stray row with company='__gate-
  // probe__' would surface as a mismatched=1 several commits later
  // with no obvious connection back here. Read for zero explicitly.
  console.log('\n4) G6.CLEANUP — verifying zero probe rows remain across the full table')
  const { count: leftoverCount, error: leftoverErr } = await admin
    .from('vehicles')
    .select('*', { count: 'exact', head: true })
    .eq('company', PROBE_COMPANY_TAG)
  if (leftoverErr) {
    console.error(`   ✗ G6.CLEANUP read failed: ${leftoverErr.message}`)
    console.error('     Cannot verify cleanup. Run the diagnostic manually:')
    console.error(`       SELECT count(*) FROM public.vehicles WHERE company = '${PROBE_COMPANY_TAG}';`)
    process.exit(4)
  }
  if ((leftoverCount ?? 0) !== 0) {
    console.error(`   ✗ G6.CLEANUP FAIL: ${leftoverCount} row(s) with company='${PROBE_COMPANY_TAG}' remain`)
    console.error('     Delete these NOW, before Commit 3 — they would flag as backfill mismatches.')
    console.error(`     Diagnostic: SELECT * FROM public.vehicles WHERE company = '${PROBE_COMPANY_TAG}';`)
    process.exit(4)
  }
  console.log(`   ✓ G6.CLEANUP: 0 probe rows remain (full-table read)`)

  console.log('\n════════════════════════════════════════════════════════')
  console.log('🟢 PASS — PostgREST schema cache sees vehicles.company.')
  console.log('   Safe to proceed with Commit 2 writer pushes.')
  console.log('════════════════════════════════════════════════════════')
  process.exit(0)
}

main().catch((e) => {
  console.error('\n✗ Unhandled error:', e)
  process.exit(1)
})
