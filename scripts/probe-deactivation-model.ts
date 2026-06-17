// Cascading Deactivation — full chain probe.
//
// Validates the post-migration state across three layers:
//   • get_my_effective_active helper — every chain point
//   • request_my_vehicle RPC — DEFINER pattern + body guards
//   • resident_insert_vehicles policy DROPped — single write path
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-deactivation-model.ts
//
// PRECONDITION: migrations/20260617_deactivation_model.sql applied.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG  = `deact-${Date.now()}`
const COMPANY  = 'Demo Towing LLC'
const PROP_A   = `Deact_${RUN_TAG}_PropA`
const PROP_B   = `Deact_${RUN_TAG}_PropB`
const UNIT     = `D-${Math.floor(Math.random() * 10000)}`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

interface Persona { email: string; client: SupabaseClient }

async function spawnAuthUser(suffix: string): Promise<Persona> {
  const email = `mateo+${RUN_TAG}-${suffix}@example.com`
  const pw    = `Deact_${RUN_TAG}_${suffix}!`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create ${suffix}: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: pw })
  if (sErr) throw new Error(`signIn ${suffix}: ${sErr.message}`)
  return { email, client }
}

async function spawnResident(suffix: string, property: string): Promise<Persona> {
  const p = await spawnAuthUser(suffix)
  await admin.from('user_roles').insert({ email: p.email, role: 'resident', company: COMPANY, property: [property], is_active: true })
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await admin.from('residents').insert({ email: p.email, name: `Resident ${suffix}`, property, unit: UNIT, is_active: true })
  cleanup.push(async () => { await admin.from('residents').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnPM(suffix: string, properties: string[]): Promise<Persona> {
  const p = await spawnAuthUser(suffix)
  await admin.from('user_roles').insert({ email: p.email, role: 'manager', company: COMPANY, property: properties, is_active: true })
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnAdmin(): Promise<Persona> {
  const p = await spawnAuthUser('adm')
  await admin.from('user_roles').insert({ email: p.email, role: 'admin', company: COMPANY, is_active: true })
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function seedProperty(name: string, isActive: boolean): Promise<void> {
  await admin.from('properties').insert({ name, company: COMPANY, address: 'probe', is_active: isActive })
  cleanup.push(async () => { await admin.from('properties').delete().eq('name', name) })
}

async function ensureCompanyActive(): Promise<void> {
  // Ensure Demo Towing LLC exists and is account_state='active'. Don't
  // create new — assume it exists from prior probes. Only verify state.
  const { data: c } = await admin.from('companies').select('id, account_state').ilike('name', COMPANY).maybeSingle()
  if (!c) throw new Error(`Demo Towing LLC not found — seed first`)
  if (c.account_state !== 'active') {
    await admin.from('companies').update({ account_state: 'active' }).eq('id', c.id)
  }
}

async function callEffective(c: SupabaseClient, scope?: string | null): Promise<{ active: boolean | null; err: string | null }> {
  const { data, error } = await c.rpc('get_my_effective_active', scope !== undefined ? { scope_property: scope } : {})
  if (error) return { active: null, err: error.message }
  return { active: data as boolean, err: null }
}

async function cleanupAll(): Promise<void> {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

async function main(): Promise<void> {
  console.log(`Deactivation chain probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let res: Persona, pmAB: Persona, sysAdmin: Persona
  try {
    await ensureCompanyActive()
    await seedProperty(PROP_A, true)
    await seedProperty(PROP_B, true)
    res     = await spawnResident('res', PROP_A)
    pmAB    = await spawnPM('pm-ab', [PROP_A, PROP_B])
    sysAdmin = await spawnAdmin()
    console.log(`  resident:    ${res.email} (property=${PROP_A})`)
    console.log(`  pm A+B:      ${pmAB.email} (properties=[${PROP_A}, ${PROP_B}])`)
    console.log(`  admin:       ${sysAdmin.email}`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  // ── HELPER chain points ────────────────────────────────────────────
  console.log('\n── 1. Admin short-circuit ──')
  let r = await callEffective(sysAdmin.client)
  record('chain.admin_short_circuit', r.active === true, `admin returns ${r.active} (expect true)`)

  console.log('\n── 2. Resident happy path ──')
  r = await callEffective(res.client)
  record('chain.resident_happy_path', r.active === true, `effective=${r.active} (expect true)`)

  console.log('\n── 3. Resident with residents.is_active=false ──')
  await admin.from('residents').update({ is_active: false }).eq('email', res.email)
  r = await callEffective(res.client)
  record('chain.resident_residents_inactive', r.active === false, `effective=${r.active} (expect false)`)
  // Restore for next checks
  await admin.from('residents').update({ is_active: true }).eq('email', res.email)

  console.log('\n── 4. Resident with property.is_active=false ──')
  await admin.from('properties').update({ is_active: false }).eq('name', PROP_A)
  r = await callEffective(res.client)
  record('chain.resident_property_inactive', r.active === false, `effective=${r.active} (expect false)`)
  await admin.from('properties').update({ is_active: true }).eq('name', PROP_A)

  console.log('\n── 5. Resident with user_roles.is_active=false ──')
  await admin.from('user_roles').update({ is_active: false }).eq('email', res.email)
  r = await callEffective(res.client)
  record('chain.resident_user_roles_inactive', r.active === false, `effective=${r.active} (expect false)`)
  await admin.from('user_roles').update({ is_active: true }).eq('email', res.email)

  console.log('\n── 6. Resident reactivation auto-restore ──')
  // Deactivate then reactivate; effective-active should immediately restore.
  await admin.from('residents').update({ is_active: false }).eq('email', res.email)
  const rDuring = await callEffective(res.client)
  await admin.from('residents').update({ is_active: true }).eq('email', res.email)
  const rAfter = await callEffective(res.client)
  record('chain.reactivation_auto_restore',
    rDuring.active === false && rAfter.active === true,
    `during-deactivation=${rDuring.active} after-reactivation=${rAfter.active} (expect false then true)`)

  console.log('\n── 7. PM with scope=A (assigned + active) ──')
  r = await callEffective(pmAB.client, PROP_A)
  record('chain.pm_scope_assigned_active', r.active === true, `effective=${r.active} (expect true)`)

  console.log('\n── 8. PM with scope=PROP_A but PROP_A is_active=false (per-property cascade) ──')
  await admin.from('properties').update({ is_active: false }).eq('name', PROP_A)
  r = await callEffective(pmAB.client, PROP_A)
  const propAOff = r.active
  // Confirm PM is still active on PROP_B (PM-≠-property decision #2).
  const rOnB = await callEffective(pmAB.client, PROP_B)
  await admin.from('properties').update({ is_active: true }).eq('name', PROP_A)
  record('chain.pm_per_property_scoping',
    propAOff === false && rOnB.active === true,
    `PROP_A=${propAOff} (expect false), PROP_B=${rOnB.active} (expect true) — per-property scope holds`)

  console.log('\n── 9. PM with own user_roles.is_active=false ──')
  await admin.from('user_roles').update({ is_active: false }).eq('email', pmAB.email)
  r = await callEffective(pmAB.client, PROP_A)
  record('chain.pm_user_roles_inactive', r.active === false, `effective=${r.active} (expect false)`)
  await admin.from('user_roles').update({ is_active: true }).eq('email', pmAB.email)

  console.log('\n── 10. PM scope=non-assigned property (B if PM only on A) ──')
  const pmOnlyA = await spawnPM('pm-a-only', [PROP_A])
  r = await callEffective(pmOnlyA.client, PROP_B)
  record('chain.pm_unassigned_property_blocked',
    r.active === false,
    `PM on PROP_A only, scope=PROP_B → effective=${r.active} (expect false)`)

  // ── 11. PM-global write-round-trip: deactivate flips PM user_roles.is_active
  //         → gate returns false for ALL scopes (semantic distinction vs
  //         per-property scoping in cases 7-8). Mirrors the end-state of
  //         CA toggleUserActive deactivating a PM globally.
  console.log('\n── 11. PM user_roles.is_active=false → effective-active=FALSE for ALL scopes ──')
  await admin.from('user_roles').update({ is_active: false }).eq('email', pmAB.email)
  const pmGlobalA = await callEffective(pmAB.client, PROP_A)
  const pmGlobalB = await callEffective(pmAB.client, PROP_B)
  await admin.from('user_roles').update({ is_active: true }).eq('email', pmAB.email)
  record('chain.pm_global_deactivation_blocks_all_scopes',
    pmGlobalA.active === false && pmGlobalB.active === false,
    `scope=PROP_A=${pmGlobalA.active}, scope=PROP_B=${pmGlobalB.active} (expect false, false — global flag overrides per-property)`)

  // ── RPC: request_my_vehicle ──────────────────────────────────────
  console.log('\n── 12. request_my_vehicle — resident active → success ──')
  const { data: vid, error: vErr } = await res.client.rpc('request_my_vehicle', {
    p_plate: 'TEST123', p_state: 'TX', p_make: 'Toyota', p_model: 'Camry', p_year: 2024, p_color: 'Black',
  })
  if (vid) cleanup.push(async () => { await admin.from('vehicles').delete().eq('id', vid as number) })
  record('rpc.request_succeeds_when_active',
    !vErr && vid != null,
    vErr ? `unexpected error: ${vErr.message}` : `vehicle id=${vid} created`)

  console.log('\n── 13. request_my_vehicle — resident deactivated → rejected ──')
  await admin.from('residents').update({ is_active: false }).eq('email', res.email)
  const { error: vErr2 } = await res.client.rpc('request_my_vehicle', {
    p_plate: 'DENIED1', p_state: 'TX', p_make: 'Honda', p_model: 'Civic', p_year: 2024, p_color: 'Red',
  })
  await admin.from('residents').update({ is_active: true }).eq('email', res.email)
  record('rpc.request_rejects_when_inactive',
    vErr2 != null && (vErr2.message.includes('account_deactivated') || vErr2.message.includes('not effectively')),
    vErr2 ? `REJECTED: ${vErr2.message}` : 'BYPASS — request succeeded while deactivated')

  console.log('\n── 14. request_my_vehicle — non-resident (PM) → rejected ──')
  const { error: vErr3 } = await pmAB.client.rpc('request_my_vehicle', {
    p_plate: 'PMTRY1', p_state: 'TX', p_make: 'Ford', p_model: 'F150', p_year: 2024, p_color: 'Blue',
  })
  record('rpc.request_rejects_non_resident',
    vErr3 != null && vErr3.message.includes('not a resident'),
    vErr3 ? `REJECTED: ${vErr3.message}` : 'BYPASS — PM submitted vehicle as resident')

  console.log('\n── 15. request_my_vehicle — anon → permission denied ──')
  const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: vErr4 } = await anonClient.rpc('request_my_vehicle', {
    p_plate: 'ANON1', p_state: 'TX', p_make: 'X', p_model: 'X', p_year: 2024, p_color: 'X',
  })
  record('rpc.anon_denied',
    vErr4 != null && (vErr4.message.toLowerCase().includes('permission') || (vErr4 as { code?: string }).code === '42501'),
    vErr4 ? `REVOKE anon enforced: ${vErr4.message}` : 'BYPASS — anon called RPC')

  // ── Direct PATCH — resident INSERT path DROPped ──────────────────
  console.log('\n── 16. Direct REST POST to vehicles by resident → blocked (policy DROPped) ──')
  const plateBeforeDirect = `CRAFTED${Math.floor(Math.random() * 10000)}`
  await res.client.from('vehicles').insert([{
    plate: plateBeforeDirect, state: 'TX', make: 'Tesla', model: 'M3', year: 2024, color: 'White',
    unit: UNIT, property: PROP_A, resident_email: res.email, is_active: false, status: 'pending',
  }])
  const { data: foundCrafted } = await admin.from('vehicles').select('id').eq('plate', plateBeforeDirect).maybeSingle()
  record('policy.direct_insert_blocked',
    foundCrafted == null,
    foundCrafted ? `BYPASS — vehicle id=${foundCrafted.id} created via direct PATCH` : 'BLOCKED — direct PATCH did not land (no resident INSERT policy)')

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
