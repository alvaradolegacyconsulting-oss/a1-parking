// B90 v2 — resident vehicle DEFINER-RPC regression probe.
//
// Validates the post-migration state for the v2 architecture
// (DEFINER RPCs + DROPped resident_update_vehicles policy):
//
//   • Resident CAN edit cosmetic columns via update_my_vehicle_cosmetic
//     RPC, AND the row reads back updated (LOAD-BEARING — proves the
//     write path actually works end-to-end, not just that bypasses are
//     blocked).
//   • Resident CAN flip resident_read=TRUE via mark_my_vehicle_declined_read
//     RPC on a declined vehicle they own.
//   • Resident CANNOT use direct REST PATCH against /rest/v1/vehicles —
//     the resident_update_vehicles policy is gone, so any
//     supabase.from('vehicles').update({...}) returns 0 rows / permission-
//     denied regardless of payload. THIS is what closes the original
//     workflow-bypass concern (declined→pending via crafted PATCH).
//   • Resident calls EITHER RPC on a vehicle they don't own → "vehicle
//     not found or not yours" (no ownership oracle).
//   • Non-resident roles calling the RPCs → "caller is not a resident".
//   • anon calling either RPC → permission denied (REVOKE FROM anon).
//   • Admin/CA UPDATE policies untouched — legitimate workflow writes
//     preserved.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b90-resident-vehicle-definer-rpc.ts
//
// PRECONDITION: migration 20260615_b90_resident_vehicle_definer_rpc.sql
// applied to the target project.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG  = `b90v2-${Date.now()}`
const COMPANY  = 'Demo Towing LLC'
const PROPERTY = `B90v2_${RUN_TAG}_Property`
const UNIT     = `B90U-${Math.floor(Math.random() * 10000)}`

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
  const pw    = `B90v2_${RUN_TAG}_${suffix}!`
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

async function spawnResidentIn(
  property: string, unit: string, suffix: string,
): Promise<Persona> {
  const p = await spawnAuthUser(suffix)
  const { error: urErr } = await admin.from('user_roles').insert({
    email: p.email, role: 'resident', company: COMPANY, property: [property],
  })
  if (urErr) throw new Error(`user_roles resident insert ${suffix}: ${urErr.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  const { error: rErr } = await admin.from('residents').insert({
    email: p.email, name: `B90v2 ${suffix}`, property, unit, is_active: true,
  })
  if (rErr) throw new Error(`residents insert ${suffix}: ${rErr.message}`)
  cleanup.push(async () => { await admin.from('residents').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnAdmin(): Promise<Persona> {
  const p = await spawnAuthUser('admin')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'admin', company: COMPANY,
  })
  if (error) throw new Error(`user_roles admin insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnCompanyAdmin(): Promise<Persona> {
  const p = await spawnAuthUser('ca')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'company_admin', company: COMPANY,
  })
  if (error) throw new Error(`user_roles company_admin insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnDriver(): Promise<Persona> {
  // For the non-resident RPC test — driver calling resident-only RPC
  // should hit the caller-is-resident guard.
  const p = await spawnAuthUser('drv')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'driver', company: COMPANY,
  })
  if (error) throw new Error(`user_roles driver insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

// Service-role seeds a properties row so company_admin_update_vehicles
// policy resolves (its USING subquery joins properties on company).
async function seedProperty(name: string): Promise<void> {
  const { error } = await admin.from('properties').insert({
    name, company: COMPANY, address: 'B90v2 probe property',
  })
  if (error) {
    // properties may already exist for this name across runs — tolerate.
    if (!error.message.toLowerCase().includes('duplicate')) {
      throw new Error(`properties insert: ${error.message}`)
    }
  }
  cleanup.push(async () => { await admin.from('properties').delete().eq('name', name) })
}

interface VehicleSeed { id: number; plate: string }

async function seedVehicle(
  ownerEmail: string, property: string, unit: string,
  status: 'pending' | 'declined' | 'active', isActive: boolean,
): Promise<VehicleSeed> {
  const plate = `B90V2${Math.floor(Math.random() * 100000)}`
  const { data, error } = await admin.from('vehicles').insert({
    plate, state: 'TX', make: 'Toyota', model: 'Camry', year: 2023, color: 'Black',
    unit, property, resident_email: ownerEmail,
    status, is_active: isActive,
    resident_read: status === 'declined' ? false : null,
  }).select('id, plate').single()
  if (error || !data) throw new Error(`vehicles insert: ${error?.message}`)
  cleanup.push(async () => { await admin.from('vehicles').delete().eq('id', data.id) })
  return { id: data.id as number, plate: data.plate as string }
}

async function readVehicle(vehicleId: number): Promise<Record<string, unknown> | null> {
  const { data } = await admin.from('vehicles').select('*').eq('id', vehicleId).maybeSingle()
  return data as Record<string, unknown> | null
}

async function cleanupAll(): Promise<void> {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

async function main(): Promise<void> {
  console.log(`B90 v2 resident vehicle DEFINER-RPC probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let resident: Persona, otherResident: Persona, sysAdmin: Persona, ca: Persona, driver: Persona
  let activeVehicle: VehicleSeed, declinedVehicle: VehicleSeed, otherResidentVehicle: VehicleSeed
  try {
    await seedProperty(PROPERTY)
    resident      = await spawnResidentIn(PROPERTY, UNIT,       'resident')
    otherResident = await spawnResidentIn(PROPERTY, `${UNIT}b`, 'other')
    sysAdmin      = await spawnAdmin()
    ca            = await spawnCompanyAdmin()
    driver        = await spawnDriver()
    activeVehicle        = await seedVehicle(resident.email,      PROPERTY, UNIT,       'active',   true)
    declinedVehicle      = await seedVehicle(resident.email,      PROPERTY, UNIT,       'declined', false)
    otherResidentVehicle = await seedVehicle(otherResident.email, PROPERTY, `${UNIT}b`, 'active',   true)
    console.log(`  resident:        ${resident.email} (${PROPERTY}, ${UNIT})`)
    console.log(`  other resident:  ${otherResident.email} (${PROPERTY}, ${UNIT}b)`)
    console.log(`  admin:           ${sysAdmin.email}`)
    console.log(`  company_admin:   ${ca.email}`)
    console.log(`  driver:          ${driver.email}`)
    console.log(`  activeVehicle:   id=${activeVehicle.id} (resident's)`)
    console.log(`  declinedVehicle: id=${declinedVehicle.id} (resident's)`)
    console.log(`  otherResident's: id=${otherResidentVehicle.id}`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LOAD-BEARING CASE — RPC succeeds + row reads back updated.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 1 (LOAD-BEARING) — resident RPC update_my_vehicle_cosmetic on own vehicle ──')
  const { error: e1, data: d1 } = await resident.client.rpc('update_my_vehicle_cosmetic', {
    p_id:    activeVehicle.id,
    p_state: 'CA',
    p_make:  'Honda',
    p_model: 'Civic',
    p_year:  2024,
    p_color: 'Red',
  })
  if (e1) {
    record('b90v2.rpc_cosmetic_succeeds_load_bearing', false,
      `RPC errored: ${e1.message}`)
  } else {
    const row = await readVehicle(activeVehicle.id)
    const allFive = row?.state === 'CA' && row?.make === 'Honda' && row?.model === 'Civic'
      && row?.year === 2024 && row?.color === 'Red'
    record('b90v2.rpc_cosmetic_succeeds_load_bearing', !!allFive,
      allFive
        ? `RPC returned id=${d1}; row reads back with all 5 cols updated`
        : `partial — got ${JSON.stringify({state: row?.state, make: row?.make, model: row?.model, year: row?.year, color: row?.color})}`)
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CASES 2-3 — mark_my_vehicle_declined_read RPC
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 2 — resident RPC mark_my_vehicle_declined_read on declined own vehicle ──')
  const { error: e2 } = await resident.client.rpc('mark_my_vehicle_declined_read', {
    p_id: declinedVehicle.id,
  })
  if (e2) {
    record('b90v2.rpc_mark_declined_read_succeeds', false,
      `RPC errored: ${e2.message}`)
  } else {
    const row = await readVehicle(declinedVehicle.id)
    const flipped = row?.resident_read === true
    record('b90v2.rpc_mark_declined_read_succeeds', flipped,
      flipped ? 'resident_read flipped to TRUE'
              : `resident_read still ${row?.resident_read}`)
  }

  console.log('\n── CASE 3 — resident RPC mark_my_vehicle_declined_read on OTHER resident\'s vehicle ──')
  const { error: e3 } = await resident.client.rpc('mark_my_vehicle_declined_read', {
    p_id: otherResidentVehicle.id,
  })
  if (e3 && e3.message.toLowerCase().includes('not yours')) {
    record('b90v2.rpc_mark_declined_read_unowned_rejected', true,
      `REJECTED with ownership message: ${e3.message}`)
  } else if (e3) {
    record('b90v2.rpc_mark_declined_read_unowned_rejected', false,
      `unexpected error shape: ${e3.message}`)
  } else {
    record('b90v2.rpc_mark_declined_read_unowned_rejected', false,
      'BYPASS — RPC succeeded against unowned vehicle')
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CASES 4-7 — Direct REST PATCH bypass attempts. Policy is DROPped,
  //  so each direct .from('vehicles').update() should return 0 rows
  //  (silent no-op) — supabase-js doesn't surface RLS-zero-rows as an
  //  error; we verify via row read-back that nothing changed.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 4 — resident direct PATCH status declined → pending (bypass attempt) ──')
  const decBefore4 = await readVehicle(declinedVehicle.id)
  await resident.client.from('vehicles').update({
    status: 'pending',
  } as unknown as never).eq('id', declinedVehicle.id)
  const decAfter4 = await readVehicle(declinedVehicle.id)
  if (decAfter4?.status === decBefore4?.status) {
    record('b90v2.direct_patch_status_blocked', true,
      `BLOCKED — status still '${decAfter4?.status}' (no UPDATE policy for resident)`)
  } else {
    record('b90v2.direct_patch_status_blocked', false,
      `WORKFLOW BYPASS REOPENED — status flipped from '${decBefore4?.status}' to '${decAfter4?.status}'`)
  }

  console.log('\n── CASE 5 — resident direct PATCH is_active false → true ──')
  await resident.client.from('vehicles').update({
    is_active: true,
  } as unknown as never).eq('id', declinedVehicle.id)
  const decAfter5 = await readVehicle(declinedVehicle.id)
  if (decAfter5?.is_active === false) {
    record('b90v2.direct_patch_is_active_blocked', true,
      'BLOCKED — is_active still false')
  } else {
    record('b90v2.direct_patch_is_active_blocked', false,
      `BYPASS — is_active=${decAfter5?.is_active}`)
  }

  console.log('\n── CASE 6 — resident direct PATCH plate ──')
  const plateBefore = (await readVehicle(activeVehicle.id))?.plate
  await resident.client.from('vehicles').update({
    plate: 'HIJACKD',
  } as unknown as never).eq('id', activeVehicle.id)
  const plateAfter = (await readVehicle(activeVehicle.id))?.plate
  if (plateAfter === plateBefore) {
    record('b90v2.direct_patch_plate_blocked', true, `BLOCKED — plate still ${plateAfter}`)
  } else {
    record('b90v2.direct_patch_plate_blocked', false, `BYPASS — plate=${plateAfter}`)
  }

  console.log('\n── CASE 7 — resident direct PATCH cosmetic-only (state) — also blocked ──')
  // Even cosmetic changes can no longer go through direct PATCH; they
  // MUST go through the RPC. Confirms the policy drop is complete.
  const stateBefore = (await readVehicle(activeVehicle.id))?.state
  await resident.client.from('vehicles').update({
    state: 'NV',
  } as unknown as never).eq('id', activeVehicle.id)
  const stateAfter = (await readVehicle(activeVehicle.id))?.state
  if (stateAfter === stateBefore) {
    record('b90v2.direct_patch_cosmetic_blocked', true,
      `BLOCKED — state still ${stateAfter} (direct PATCH gone; RPC is the only path)`)
  } else {
    record('b90v2.direct_patch_cosmetic_blocked', false,
      `policy still permits direct PATCH — state=${stateAfter}; check DROP applied`)
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CASES 8-9 — RPC ownership oracle + non-resident guard.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 8 — resident RPC cosmetic on OTHER resident\'s vehicle ──')
  const { error: e8 } = await resident.client.rpc('update_my_vehicle_cosmetic', {
    p_id: otherResidentVehicle.id,
    p_state: 'CA', p_make: 'Tesla', p_model: 'M3', p_year: 2024, p_color: 'White',
  })
  if (e8 && e8.message.toLowerCase().includes('not yours')) {
    record('b90v2.rpc_cosmetic_unowned_rejected', true,
      `REJECTED: ${e8.message}`)
  } else if (e8) {
    record('b90v2.rpc_cosmetic_unowned_rejected', false,
      `unexpected error: ${e8.message}`)
  } else {
    const r = await readVehicle(otherResidentVehicle.id)
    if (r?.state === 'CA') {
      record('b90v2.rpc_cosmetic_unowned_rejected', false,
        'BYPASS — RPC wrote to unowned vehicle')
    } else {
      record('b90v2.rpc_cosmetic_unowned_rejected', true,
        'no error returned but row unchanged (ownership clamp held)')
    }
  }

  console.log('\n── CASE 9 — driver (non-resident) RPC update_my_vehicle_cosmetic ──')
  const { error: e9 } = await driver.client.rpc('update_my_vehicle_cosmetic', {
    p_id: activeVehicle.id,
    p_state: 'WA', p_make: 'BMW', p_model: '3', p_year: 2024, p_color: 'Blue',
  })
  if (e9 && e9.message.toLowerCase().includes('not a resident')) {
    record('b90v2.non_resident_rpc_rejected', true, `REJECTED: ${e9.message}`)
  } else if (e9) {
    record('b90v2.non_resident_rpc_rejected', false, `unexpected: ${e9.message}`)
  } else {
    record('b90v2.non_resident_rpc_rejected', false,
      'BYPASS — driver called resident RPC and it succeeded')
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CASE 10 — anon RPC denied (REVOKE FROM anon).
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 10 — anon RPC update_my_vehicle_cosmetic denied ──')
  const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: e10 } = await anonClient.rpc('update_my_vehicle_cosmetic', {
    p_id: activeVehicle.id,
    p_state: 'OR', p_make: 'Ford', p_model: 'F150', p_year: 2024, p_color: 'Green',
  })
  if (e10) {
    const msg = e10.message.toLowerCase()
    const isPermDenied = msg.includes('permission denied') || (e10 as { code?: string }).code === '42501'
    record('b90v2.anon_rpc_denied', isPermDenied,
      isPermDenied ? `REVOKE anon enforced: ${e10.message}`
                   : `unexpected error: ${e10.message}`)
  } else {
    record('b90v2.anon_rpc_denied', false,
      'BYPASS — anon RPC succeeded; REVOKE anon NOT enforced')
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CASES 11-12 — No-regression on admin/CA UPDATE policies.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── CASE 11 — admin direct UPDATE status (no-regression) ──')
  const { error: e11 } = await sysAdmin.client.from('vehicles').update({
    status: 'pending',
  } as unknown as never).eq('id', declinedVehicle.id)
  const adminAfter = await readVehicle(declinedVehicle.id)
  if (e11) {
    record('b90v2.admin_status_write_preserved', false, `admin write errored: ${e11.message}`)
  } else if (adminAfter?.status === 'pending') {
    record('b90v2.admin_status_write_preserved', true, 'admin status write succeeded')
  } else {
    record('b90v2.admin_status_write_preserved', false,
      `admin write did not apply (status=${adminAfter?.status})`)
  }

  console.log('\n── CASE 12 — company_admin direct UPDATE status (no-regression) ──')
  const { error: e12 } = await ca.client.from('vehicles').update({
    status: 'active',
  } as unknown as never).eq('id', declinedVehicle.id)
  const caAfter = await readVehicle(declinedVehicle.id)
  if (e12) {
    record('b90v2.ca_status_write_preserved', false, `CA write errored: ${e12.message}`)
  } else if (caAfter?.status === 'active') {
    record('b90v2.ca_status_write_preserved', true, 'CA status write succeeded')
  } else {
    record('b90v2.ca_status_write_preserved', false,
      `CA write did not apply (status=${caAfter?.status})`)
  }

  await cleanupAll()

  const passed = checks.filter(c => c.pass).length
  console.log(`\n── RESULT — ${passed}/${checks.length} passed ──`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.id}`)
  }
  // The load-bearing check is highlighted in the summary so a partial
  // pass with a failed Case 1 doesn't get glossed over (per Jose's
  // explicit reporting requirement on the v1 probe run).
  const loadBearing = checks.find(c => c.id === 'b90v2.rpc_cosmetic_succeeds_load_bearing')
  console.log(`\n── LOAD-BEARING CHECK: ${loadBearing?.pass ? 'PASS' : 'FAIL'} — b90v2.rpc_cosmetic_succeeds_load_bearing ──`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('UNHANDLED:', (e as Error).message)
  await cleanupAll()
  process.exit(1)
})
