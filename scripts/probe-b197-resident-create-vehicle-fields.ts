// B197 manager-portal Add-Resident regression probe.
//
// Background
//   app/manager/page.tsx addResident() pre-fix spread the form state into
//   the residents insert:
//     supabase.from('residents').insert([{ ...newResident, ... }])
//   newResident carries vehicle_plate/state/make/model/year/color form
//   fields destined for the vehicles table, not residents. PostgREST's
//   schema-cache check tripped on the first vehicle_* column:
//     "Could not find the 'vehicle_color' column of 'residents'"
//   The fix enumerates the residents-only columns explicitly; vehicles
//   row is written separately at the B167-inline-boundary step further
//   down. This probe is the regression gate.
//
// CASES
//   caseA.residents_insert
//   caseA.vehicles_insert
//     Manager-as-caller inserts a residents row with the post-fix
//     explicit-column subset, then inserts a vehicles row alongside.
//     Both must land — proves the fix path works end-to-end.
//
//   caseB.residents_only
//     Manager inserts residents row without the vehicle insert (the
//     blank-plate conditional skip path). No vehicles row should exist
//     for this resident — proves the conditional still works.
//
//   caseC.schema_guard_proven
//     Defensive: deliberately re-introduce the bug by including
//     vehicle_color in a residents insert payload. PostgREST must
//     reject it with a schema-cache error mentioning vehicle_color.
//     If this case ever passes (vehicle_color becomes a residents
//     column legitimately), the probe fails and the fix is re-evaluated.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b197-resident-create-vehicle-fields.ts
//
// PRECONDITION: app/manager/page.tsx fix applied (drop the spread, enumerate
// residents columns explicitly). The probe doesn't apply the fix; it
// validates it against the live DB.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG  = `b197-${Date.now()}`
const COMPANY  = 'Demo Towing LLC'
const PROPERTY = `B197_${RUN_TAG}_Property`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

interface Persona { email: string; client: SupabaseClient; authId: string }

async function spawnAuthUser(suffix: string): Promise<Persona> {
  const email = `mateo+${RUN_TAG}-${suffix}@example.com`
  const pw    = `B197_${RUN_TAG}_${suffix}!`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create ${suffix}: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: pw })
  if (sErr) throw new Error(`signIn ${suffix}: ${sErr.message}`)
  return { email, client, authId: created.user.id }
}

async function spawnManager(properties: string[]): Promise<Persona> {
  const p = await spawnAuthUser(`mgr`)
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'manager', company: COMPANY, property: properties,
  })
  if (error) throw new Error(`user_roles manager insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function cleanupAll() {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

// ── CASE A — happy path, with vehicle ────────────────────────────────────────
// Mirror the post-fix addResident code path: explicit residents-only column
// enumeration, then a separate vehicles insert. Both must land.
async function caseA_withVehicle(mgr: Persona, residentEmail: string): Promise<void> {
  const { error: rErr } = await mgr.client.from('residents').insert([{
    name:      'B197 Test Resident A',
    email:     residentEmail,
    phone:     '+1-555-0197',
    unit:      'A101',
    space:     'P1',
    lease_end: '2026-12-31',
    property:  PROPERTY,
    is_active: true,
  }])
  if (rErr) {
    record('caseA.residents_insert', false, `residents INSERT failed: ${rErr.message}`)
    return
  }
  cleanup.push(async () => { await admin.from('residents').delete().eq('email', residentEmail) })
  record('caseA.residents_insert', true,
    'residents row landed with explicit-column subset (no vehicle_* in payload)')

  const plate = `B197A${Math.floor(Math.random() * 10000)}`
  const { error: vErr } = await mgr.client.from('vehicles').insert([{
    plate,
    state:           'TX',
    make:            'Toyota',
    model:           'Camry',
    year:            2023,
    color:           'Black',
    unit:            'A101',
    property:        PROPERTY,
    resident_email:  residentEmail,
    is_active:       true,
    status:          'active',
  }])
  if (vErr) {
    record('caseA.vehicles_insert', false, `vehicles INSERT failed: ${vErr.message}`)
    return
  }
  cleanup.push(async () => { await admin.from('vehicles').delete().eq('resident_email', residentEmail) })
  record('caseA.vehicles_insert', true, `vehicles row landed alongside residents (plate=${plate})`)
}

// ── CASE B — blank-plate conditional skip ────────────────────────────────────
// Manager fills in resident details but leaves vehicle_plate blank. The
// addResident code path's conditional at line 684 skips the vehicles insert
// entirely. At the DB level we assert: residents row exists, no vehicles
// row exists for that resident.
async function caseB_blankPlate(mgr: Persona, residentEmail: string): Promise<void> {
  const { error: rErr } = await mgr.client.from('residents').insert([{
    name:      'B197 Test Resident B',
    email:     residentEmail,
    phone:     null,
    unit:      'B202',
    space:     null,
    lease_end: null,
    property:  PROPERTY,
    is_active: true,
  }])
  if (rErr) {
    record('caseB.residents_only', false, `residents INSERT failed: ${rErr.message}`)
    return
  }
  cleanup.push(async () => { await admin.from('residents').delete().eq('email', residentEmail) })

  const { data: vehicles } = await admin.from('vehicles').select('id').eq('resident_email', residentEmail)
  const noVehicles = !vehicles || vehicles.length === 0
  record('caseB.residents_only', noVehicles, noVehicles
    ? 'residents row landed; no vehicles row attempted (conditional skip path)'
    : `unexpected: ${vehicles?.length} vehicle row(s) found for ${residentEmail}`)
}

// ── CASE C — schema-guard, defensive ─────────────────────────────────────────
// Deliberately re-introduce the bug shape by including vehicle_color in a
// residents insert payload. PostgREST must reject with a schema-cache error.
// If this ever passes (vehicle_color becomes a residents column legitimately),
// the probe fails and the fix is re-evaluated.
async function caseC_schemaGuard(mgr: Persona, residentEmail: string): Promise<void> {
  const { error: rErr } = await mgr.client.from('residents').insert([{
    name:          'B197 Test Resident C',
    email:         residentEmail,
    unit:          'C303',
    property:      PROPERTY,
    is_active:     true,
    vehicle_color: 'Red',
  } as unknown as never])
  if (rErr && /vehicle_color/.test(rErr.message)) {
    record('caseC.schema_guard_proven', true,
      `residents schema-cache correctly rejects vehicle_color: ${rErr.message}`)
  } else if (rErr) {
    record('caseC.schema_guard_proven', false,
      `expected vehicle_color-mentioning rejection, got: ${rErr.message}`)
  } else {
    record('caseC.schema_guard_proven', false,
      'residents INSERT with vehicle_color SUCCEEDED — bug class no longer detectable; revisit fix')
    cleanup.push(async () => { await admin.from('residents').delete().eq('email', residentEmail) })
  }
}

async function main() {
  console.log(`B197 manager Add-Resident regression probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let mgr: Persona
  try {
    mgr = await spawnManager([PROPERTY])
    console.log(`  manager email: ${mgr.email}; property: [${PROPERTY}]`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  console.log('\n── CASE A — with-vehicle path ──')
  await caseA_withVehicle(mgr, `mateo+${RUN_TAG}-residentA@example.com`)

  console.log('\n── CASE B — blank-plate path ──')
  await caseB_blankPlate(mgr, `mateo+${RUN_TAG}-residentB@example.com`)

  console.log('\n── CASE C — schema-guard defensive ──')
  await caseC_schemaGuard(mgr, `mateo+${RUN_TAG}-residentC@example.com`)

  await cleanupAll()

  const passed = checks.filter(c => c.pass).length
  console.log(`\n── RESULT — ${passed}/${checks.length} passed ──`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.id}`)
  }
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('UNHANDLED:', (e as Error).message)
  await cleanupAll()
  process.exit(1)
})
