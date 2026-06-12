// A1 Bar 1 verification probes — manager-resident lifecycle,
// manager-add-vehicle (incl. permit_expiry boundary), driver-single-create.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-a1-bar1.ts
//
// DESIGN (per Jose's brief)
//   • Step 0 — pull live column inventory via .select('*').limit(1) (names
//     only; data_type/nullability come from the SQL companion dump).
//   • Each probe: baseline → write → SELECT ground truth → sanity → negative.
//   • "success ≠ verified" — every write is followed by a SELECT and an
//     actual-value assertion. error: null is NOT proof.
//   • Self-cleaning: throwaway records deleted at end, RETURNING-style.
//   • Tenant context: throwaway manager created via service-role then
//     signed in via anon-key client — RLS gates are LIVE for those probes.
//     (Deviation from "manager.bayou literal": the RLS chain is property
//     + role + email; a throwaway-manager-on-the-same-property exercises
//     the identical chain. Flagged in the report.)

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  console.error('Missing env (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY)')
  process.exit(2)
}

const RUN_TAG = `probe-a1-bar1-${Date.now()}`
const THROWAWAY_MGR_EMAIL    = `mateo+a1bar1-mgr-${Date.now()}@example.com`
const THROWAWAY_MGR_PASSWORD = `B1_${RUN_TAG}_pw!`
const THROWAWAY_RES_EMAIL    = `mateo+a1bar1-res-${Date.now()}@example.com`
const THROWAWAY_DRV_EMAIL    = `mateo+a1bar1-drv-${Date.now()}@example.com`
const THROWAWAY_DRV_PASSWORD = `B1_${RUN_TAG}_drv_pw!`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
// anon client is created per-tenant in setupThrowawayManager so each
// sign-in gets its own session (no shared-state leakage between probes).

// ── Test ledger ─────────────────────────────────────────────────────
type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

const cleanupOps: Array<() => Promise<void>> = []

// ── Step 0: catalog dump (column names from a 1-row sample) ─────────
async function catalogDump() {
  console.log('\n── STEP 0: Live column inventory ──────────────────────')
  const tables = ['residents', 'vehicles', 'drivers', 'user_roles']
  for (const t of tables) {
    const { data, error } = await admin.from(t).select('*').limit(1)
    if (error) {
      console.log(`${t}: ERROR ${error.message}`)
      continue
    }
    if (!data || data.length === 0) {
      console.log(`${t}: (empty table — column inventory unavailable via sample read)`)
      continue
    }
    const cols = Object.keys(data[0]).sort()
    console.log(`${t} (${cols.length} columns):`)
    console.log('  ' + cols.join(', '))
  }
  console.log('')
}

// ── Anchor lookup — Demo Towing property for the throwaway manager ──
async function findDemoTowingProperty(): Promise<string> {
  const { data, error } = await admin
    .from('properties')
    .select('name, company')
    .ilike('company', 'Demo Towing LLC')
    .limit(1)
    .maybeSingle()
  if (error || !data) {
    throw new Error(`Couldn't find a Demo Towing LLC property: ${error?.message || 'none returned'}`)
  }
  return data.name as string
}

// ── Setup: throwaway manager on the Demo Towing property ────────────
async function setupThrowawayManager(propertyName: string): Promise<SupabaseClient> {
  console.log('\n── SETUP: throwaway manager ──────────────────────────')
  console.log(`Property: ${propertyName}`)
  console.log(`Email:    ${THROWAWAY_MGR_EMAIL}`)

  // 1. auth.users via admin API.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: THROWAWAY_MGR_EMAIL,
    password: THROWAWAY_MGR_PASSWORD,
    email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`auth createUser failed: ${createErr?.message}`)
  const authUserId = created.user.id
  cleanupOps.push(async () => {
    await admin.auth.admin.deleteUser(authUserId)
  })

  // 2. user_roles row. NOTE: user_roles has NO `name` column (caught via
  // Step 0 catalog dump — production-vs-source drift). Name lives on
  // residents/drivers rows where applicable.
  const { error: roleErr } = await admin.from('user_roles').insert({
    email: THROWAWAY_MGR_EMAIL,
    role: 'manager',
    property: [propertyName],
    company: 'Demo Towing LLC',
  })
  if (roleErr) throw new Error(`user_roles insert failed: ${roleErr.message}`)
  cleanupOps.push(async () => {
    await admin.from('user_roles').delete().eq('email', THROWAWAY_MGR_EMAIL)
  })

  // 3. Sign in via anon client → returns the tenant session.
  const tenant = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signErr } = await tenant.auth.signInWithPassword({
    email: THROWAWAY_MGR_EMAIL,
    password: THROWAWAY_MGR_PASSWORD,
  })
  if (signErr) throw new Error(`tenant signIn failed: ${signErr.message}`)

  console.log('Tenant session established.')
  return tenant
}

// ── Probe 1: Manager add/edit resident lifecycle ────────────────────
async function probe1(tenant: SupabaseClient, propertyName: string) {
  console.log('\n── PROBE 1: Manager add/edit resident lifecycle ──────')

  // 1a. ADD as tenant (RLS gated).
  const resPayload = {
    email: THROWAWAY_RES_EMAIL,
    name: 'A1 Bar 1 Throwaway Resident',
    property: propertyName,
    company: 'Demo Towing LLC',
    unit: '101',
    status: 'pending',
    is_active: false,
  }
  const { data: inserted, error: insErr } = await tenant
    .from('residents')
    .insert([resPayload])
    .select('id, email, name, property, company, unit, status, is_active')
    .single()

  if (insErr || !inserted) {
    record('P1.1 add', false, `INSERT errored: ${insErr?.message || 'no row returned'}`)
    return
  }
  cleanupOps.push(async () => {
    await admin.from('residents').delete().eq('id', inserted.id)
  })

  // 1b. READ BACK via service-role (ground truth, RLS-bypass).
  const { data: groundTruth } = await admin
    .from('residents')
    .select('email, name, property, company, unit, status, is_active')
    .eq('id', inserted.id)
    .single()
  if (!groundTruth) {
    record('P1.1 add', false, 'Ground-truth read returned no row')
    return
  }

  // 1c. Assert persisted values.
  const expected = { email: THROWAWAY_RES_EMAIL, name: resPayload.name, property: propertyName, company: 'Demo Towing LLC', unit: '101', status: 'pending', is_active: false }
  const mismatches: string[] = []
  for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
    if (groundTruth[k] !== expected[k]) {
      mismatches.push(`${k}=${JSON.stringify(groundTruth[k])} (expected ${JSON.stringify(expected[k])})`)
    }
  }
  record('P1.1 add', mismatches.length === 0,
    mismatches.length === 0
      ? `Row id=${inserted.id} persisted with all 7 fields matching`
      : `Persisted-value mismatches: ${mismatches.join('; ')}`)

  // 1d. SANITY — read via tenant (the RLS-chain that surfaces it in the UI).
  const { data: tenantRead } = await tenant
    .from('residents')
    .select('id')
    .eq('id', inserted.id)
    .maybeSingle()
  record('P1.1 RLS chain', tenantRead?.id === inserted.id,
    tenantRead?.id === inserted.id
      ? 'Resident surfaces to the inserting manager via the SELECT RLS chain'
      : 'Resident NOT visible to the inserting manager via SELECT (RLS misalignment)')

  // 2a. EDIT — rename + new unit.
  const newName = 'A1 Bar 1 Throwaway Resident — RENAMED'
  const newUnit = '202'
  const { error: updErr, count } = await tenant
    .from('residents')
    .update({ name: newName, unit: newUnit }, { count: 'exact' })
    .eq('id', inserted.id)
  if (updErr) {
    record('P1.2 edit', false, `UPDATE errored: ${updErr.message}`)
  } else {
    // 2b. READ BACK + assert.
    const { data: postEdit } = await admin
      .from('residents')
      .select('name, unit')
      .eq('id', inserted.id)
      .single()
    record('P1.2 edit', postEdit?.name === newName && postEdit?.unit === newUnit,
      postEdit?.name === newName && postEdit?.unit === newUnit
        ? `Persisted: name+unit updated to "${newName}" / "${newUnit}" (count: ${count ?? '?'})`
        : `Persisted mismatch: name=${postEdit?.name} unit=${postEdit?.unit}`)
  }

  // 3a. NEGATIVE — try to insert a resident on a property the manager does NOT manage.
  const FAKE_PROP = `___fake_property_${RUN_TAG}`
  const { data: badInsert, error: badErr } = await tenant
    .from('residents')
    .insert([{
      email: `mateo+a1bar1-neg-${Date.now()}@example.com`,
      name: 'Should Not Land',
      property: FAKE_PROP,
      company: 'Demo Towing LLC',
      unit: '999',
      status: 'pending',
      is_active: false,
    }])
    .select('id')
  // RLS-denied INSERT typically returns error with PostgrestError code 42501 OR
  // an empty array depending on whether .select() chains differ. Either is a
  // pass; a non-empty data array is a fail.
  if (badInsert && badInsert.length > 0) {
    // Row landed despite being out-of-scope — clean it up + FAIL.
    cleanupOps.push(async () => {
      await admin.from('residents').delete().eq('id', badInsert[0].id)
    })
    record('P1.3 negative', false,
      `OUT-OF-SCOPE INSERT LANDED row id=${badInsert[0].id} property="${FAKE_PROP}" — RLS gap`)
  } else {
    record('P1.3 negative', true,
      `Out-of-scope INSERT denied: error="${badErr?.message ?? '(no error, empty data)'}"`)
  }
}

// ── Probe 2: Manager add-vehicle + permit_expiry boundary ───────────
async function probe2(tenant: SupabaseClient, propertyName: string, residentEmail: string) {
  console.log('\n── PROBE 2: Manager add-vehicle + permit_expiry boundary ─')

  const plate1 = `P2A${Date.now().toString().slice(-6)}`
  // 2.1 — happy path: full vehicle WITH a real permit_expiry.
  const { data: v1, error: v1Err } = await tenant
    .from('vehicles')
    .insert([{
      plate: plate1, state: 'TX', make: 'Probe', model: 'A',
      color: 'Black', year: 2024, unit: '101',
      property: propertyName, resident_email: residentEmail,
      is_active: true, permit_expiry: '2026-12-31',
    }])
    .select('id, plate, property, resident_email, is_active, permit_expiry')
    .single()
  if (v1Err || !v1) {
    record('P2.1 happy', false, `INSERT errored: ${v1Err?.message || 'no row'}`)
  } else {
    cleanupOps.push(async () => { await admin.from('vehicles').delete().eq('id', v1.id) })
    const { data: gt } = await admin.from('vehicles')
      .select('plate, property, resident_email, is_active, permit_expiry')
      .eq('id', v1.id).single()
    const ok = gt?.plate === plate1
      && gt?.property === propertyName
      && gt?.resident_email === residentEmail
      && gt?.is_active === true
      && gt?.permit_expiry === '2026-12-31'
    record('P2.1 happy', !!ok,
      ok
        ? `Vehicle id=${v1.id} plate=${plate1} owner-stamped + permit_expiry=2026-12-31`
        : `Ground-truth mismatch: ${JSON.stringify(gt)}`)
  }

  // 2.2 — BOUNDARY: empty-string permit_expiry. Manager portal coerces
  // `'' || null` at the submit site (manager/page.tsx:606). Probe submits
  // raw '' to confirm whether the path errors OR Postgres rejects.
  const plate2 = `P2B${Date.now().toString().slice(-6)}`
  const { data: v2, error: v2Err } = await tenant
    .from('vehicles')
    .insert([{
      plate: plate2, state: 'TX', make: 'Probe', model: 'B',
      color: 'Red', year: 2024, unit: '101',
      property: propertyName, resident_email: residentEmail,
      is_active: true, permit_expiry: '' as unknown as string,
    }])
    .select('id, plate, permit_expiry')
    .single()

  if (v2Err) {
    // Error path: this is the latent Class-B bug surfacing at the DB layer.
    record('P2.2 boundary empty-str', false,
      `Empty-string permit_expiry rejected at DB: "${v2Err.message}" — Class-B bug confirmed (UI must coerce '' → null before submit; manager/page.tsx:606 already does, but admin/CA paths may not).`)
  } else if (v2) {
    cleanupOps.push(async () => { await admin.from('vehicles').delete().eq('id', v2.id) })
    const { data: gt2 } = await admin.from('vehicles')
      .select('permit_expiry').eq('id', v2.id).single()
    if (gt2?.permit_expiry === null) {
      record('P2.2 boundary empty-str', true,
        `Empty-string coerced to NULL at the DB / driver layer (id=${v2.id})`)
    } else {
      record('P2.2 boundary empty-str', false,
        `Empty-string permit_expiry persisted as ${JSON.stringify(gt2?.permit_expiry)} (expected NULL)`)
    }
  }

  // 2.3 — NEGATIVE: vehicle on a property the manager doesn't manage.
  const FAKE_PROP = `___fake_property_${RUN_TAG}`
  const { data: badV, error: badVErr } = await tenant
    .from('vehicles')
    .insert([{
      plate: `P2N${Date.now().toString().slice(-6)}`, state: 'TX',
      property: FAKE_PROP, resident_email: residentEmail,
      is_active: true, unit: '999',
    }])
    .select('id')
  if (badV && badV.length > 0) {
    cleanupOps.push(async () => { await admin.from('vehicles').delete().eq('id', badV[0].id) })
    record('P2.3 negative', false, `OUT-OF-SCOPE vehicle landed id=${badV[0].id}`)
  } else {
    record('P2.3 negative', true,
      `Out-of-scope vehicle INSERT denied: "${badVErr?.message ?? '(no error, empty data)'}"`)
  }
}

// ── Probe 3: Driver single-create (admin path) ──────────────────────
async function probe3() {
  console.log('\n── PROBE 3: Driver single-create (admin path) ───────')

  // 3.1 — auth.users via admin API (the A1-novel path that's known to break).
  let authUserId: string | null = null
  let authErrMsg: string | null = null
  try {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: THROWAWAY_DRV_EMAIL,
      password: THROWAWAY_DRV_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'A1 Bar 1 Throwaway Driver' },
    })
    if (createErr) {
      authErrMsg = createErr.message
    } else if (!created.user) {
      authErrMsg = 'created.user was null'
    } else {
      authUserId = created.user.id
      cleanupOps.push(async () => { await admin.auth.admin.deleteUser(authUserId!) })
    }
  } catch (e) {
    authErrMsg = (e as Error).message
  }

  if (authErrMsg) {
    record('P3.1 auth.admin.createUser', false,
      `Auth admin createUser FAILED: "${authErrMsg}" — the B113-class smoke failure Jose flagged; auth.users row NOT created.`)
  } else {
    record('P3.1 auth.admin.createUser', true,
      `auth.users row created id=${authUserId}`)
  }

  // 3.2 — drivers row (best-effort even if auth failed, to observe partial-row pattern).
  const { data: driverRow, error: driverErr } = await admin
    .from('drivers')
    .insert([{
      email: THROWAWAY_DRV_EMAIL,
      name: 'A1 Bar 1 Throwaway Driver',
      company: 'Demo Towing LLC',
      is_active: true,
    }])
    .select('id, email, name, company, is_active')
    .single()
  if (driverErr || !driverRow) {
    record('P3.2 drivers row', false, `drivers INSERT errored: ${driverErr?.message || 'no row'}`)
  } else {
    cleanupOps.push(async () => { await admin.from('drivers').delete().eq('id', driverRow.id) })
    record('P3.2 drivers row', true, `drivers id=${driverRow.id} persisted (${JSON.stringify(driverRow)})`)
  }

  // 3.3 — user_roles row. NOTE: no `name` column (see catalog dump).
  const { error: urErr } = await admin.from('user_roles').insert({
    email: THROWAWAY_DRV_EMAIL,
    role: 'driver',
    company: 'Demo Towing LLC',
  })
  if (urErr) {
    record('P3.3 user_roles', false, `user_roles INSERT errored: ${urErr.message}`)
  } else {
    cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', THROWAWAY_DRV_EMAIL) })
    record('P3.3 user_roles', true, `user_roles row persisted for ${THROWAWAY_DRV_EMAIL}`)
  }

  // 3.4 — partial-row consistency check (F6 pattern).
  const { data: drvAfter } = await admin.from('drivers').select('id').eq('email', THROWAWAY_DRV_EMAIL).maybeSingle()
  const { data: urAfter }  = await admin.from('user_roles').select('email').eq('email', THROWAWAY_DRV_EMAIL).maybeSingle()
  const authPresent = !!authUserId
  const drvPresent  = !!drvAfter
  const urPresent   = !!urAfter
  const allThree    = authPresent && drvPresent && urPresent
  record('P3.4 three-table consistency', allThree,
    `auth.users=${authPresent ? 'YES' : 'NO'} · drivers=${drvPresent ? 'YES' : 'NO'} · user_roles=${urPresent ? 'YES' : 'NO'}` +
    (allThree ? '' : ' — PARTIAL LANDING (F6 pattern; orphans need cleanup at the admin route)'))
}

// ── Cleanup ─────────────────────────────────────────────────────────
async function cleanupAll() {
  console.log('\n── CLEANUP ───────────────────────────────────────────')
  for (const op of cleanupOps.reverse()) {
    try { await op() } catch (e) { console.error('cleanup op failed:', (e as Error).message) }
  }
  console.log('Cleanup complete.')
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`A1 Bar 1 probe run · ${RUN_TAG}`)
  console.log(`Project: ${url}`)

  await catalogDump()

  let propertyName: string
  try {
    propertyName = await findDemoTowingProperty()
  } catch (e) {
    console.error('FATAL:', (e as Error).message)
    process.exit(1)
  }

  let tenant: SupabaseClient
  try {
    tenant = await setupThrowawayManager(propertyName)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  try {
    await probe1(tenant, propertyName)
    await probe2(tenant, propertyName, THROWAWAY_RES_EMAIL)
    await probe3()
  } catch (e) {
    console.error('Probe execution threw:', (e as Error).message)
  } finally {
    await cleanupAll()
  }

  console.log('\n── SUMMARY ────────────────────────────────────────────')
  const passed = checks.filter(c => c.pass).length
  const failed = checks.length - passed
  console.log(`${passed}/${checks.length} checks passed (${failed} failed)`)
  for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.id} — ${c.detail}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })
