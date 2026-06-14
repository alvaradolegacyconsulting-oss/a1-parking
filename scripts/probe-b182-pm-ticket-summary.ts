// B182 PM-view DEFINER RPC regression gate.
//
// get_pm_ticket_summary is an auth-surface SECURITY DEFINER function —
// same class as the insert_user_role hole closed by B155.2 RPC-path
// migration. Standing rule from Jose (A2 discipline starts here): no
// DEFINER function ships without a behavioral probe.
//
// This probe runs SEVEN scenarios against the live DB:
//   pm.own_property_priced_stripped — manager sees own-property ticket
//     with payload that has no tow_fee / tow_storage_* fields
//   pm.cross_property_denied         — manager scoped to property A
//     cannot read a violation on property B (out_of_scope)
//   pm.voided_denied                 — voided ticket refused even when
//     it would otherwise be visible to the manager
//   pm.not_ticketed_denied           — confirmed violation without a
//     generated ticket refuses (defensive)
//   pm.leasing_agent_works           — leasing_agent has the same
//     access pattern as manager (control)
//   pm.driver_denied                 — driver role refused (CA/driver
//     use the public capability URL, not this RPC)
//   pm.anon_denied                   — anonymous client cannot call
//     the RPC (REVOKE from anon enforced)
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b182-pm-ticket-summary.ts
//
// PRECONDITION: migration 20260614_b182_pm_ticket_summary.sql applied.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG = `b182-pm-${Date.now()}`
const COMPANY = 'Demo Towing LLC'
const PROP_OWN  = `B182_${RUN_TAG}_PropA`
const PROP_OOS  = `B182_${RUN_TAG}_PropB`

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
  const pw    = `B182_${RUN_TAG}_${suffix}!`
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

async function spawnLeasingAgent(properties: string[]): Promise<Persona> {
  const p = await spawnAuthUser(`leasing`)
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'leasing_agent', company: COMPANY, property: properties,
  })
  if (error) throw new Error(`user_roles leasing_agent insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnDriver(): Promise<Persona> {
  const p = await spawnAuthUser(`drv`)
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'driver', company: COMPANY,
  })
  if (error) throw new Error(`user_roles driver insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function createViolation(args: {
  property: string
  ticketed: boolean
  voided: boolean
  withMoney: boolean
}): Promise<number> {
  const row = {
    plate: `B182${Math.floor(Math.random() * 10000)}`,
    property: args.property,
    violation_type: 'B182 Probe Smoke',
    location: 'Test Spot',
    notes: 'B182 probe-managed throwaway',
    driver_name: 'mateo+b182-probe@example.com',
    is_confirmed: true,
    tow_ticket_generated: args.ticketed,
    tow_ticket_generated_at: args.ticketed ? new Date().toISOString() : null,
    tow_fee: args.withMoney ? 250.00 : null,
    tow_storage_name: args.withMoney ? 'B182 Probe Yard' : null,
    tow_storage_address: args.withMoney ? '999 Probe Lane' : null,
    tow_storage_phone: args.withMoney ? '+1-555-0182' : null,
    voided_at: args.voided ? new Date().toISOString() : null,
    voided_by_email: args.voided ? 'mateo+b182-probe@example.com' : null,
    voided_by_role: args.voided ? 'company_admin' : null,
    void_reason: args.voided ? 'B182 probe — testing voided refusal' : null,
  }
  const { data, error } = await admin.from('violations').insert(row).select('id').single()
  if (error || !data) throw new Error(`violation insert: ${error?.message}`)
  cleanup.push(async () => { await admin.from('violations').delete().eq('id', data.id) })
  return data.id as number
}

async function callRpc(c: SupabaseClient, violationId: number) {
  return await c.rpc('get_pm_ticket_summary', { p_violation_id: violationId })
}

async function main() {
  console.log(`B182 PM-view probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let mgr: Persona, leasing: Persona, drv: Persona
  let V_OWN_LIVE: number, V_OOS_LIVE: number, V_OWN_VOIDED: number, V_OWN_NOT_TICKETED: number
  try {
    mgr = await spawnManager([PROP_OWN])
    leasing = await spawnLeasingAgent([PROP_OWN])
    drv = await spawnDriver()
    V_OWN_LIVE         = await createViolation({ property: PROP_OWN, ticketed: true, voided: false, withMoney: true })
    V_OOS_LIVE         = await createViolation({ property: PROP_OOS, ticketed: true, voided: false, withMoney: true })
    V_OWN_VOIDED       = await createViolation({ property: PROP_OWN, ticketed: true, voided: true,  withMoney: true })
    V_OWN_NOT_TICKETED = await createViolation({ property: PROP_OWN, ticketed: false, voided: false, withMoney: false })
    console.log(`  manager email: ${mgr.email}; scoped to [${PROP_OWN}]`)
    console.log(`  V_OWN_LIVE=${V_OWN_LIVE}  V_OOS_LIVE=${V_OOS_LIVE}  V_OWN_VOIDED=${V_OWN_VOIDED}  V_OWN_NOT_TICKETED=${V_OWN_NOT_TICKETED}`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  // 1. Manager + own property + ticketed + not voided → price-stripped payload
  console.log('\n── PRICE-STRIPPED PAYLOAD TEST ──')
  const r1 = await callRpc(mgr.client, V_OWN_LIVE)
  const d1 = r1.data as { ok?: boolean; violation?: Record<string, unknown>; photos?: unknown; error?: string } | null
  if (d1?.ok && d1.violation && typeof d1.violation === 'object') {
    const viol = d1.violation
    const omittedFields = ['tow_fee', 'tow_storage_name', 'tow_storage_address', 'tow_storage_phone', 'view_token', 'view_token_expires_at', 'voided_at', 'void_reason']
    const leaked = omittedFields.filter(f => f in viol)
    if (leaked.length === 0) {
      record('pm.own_property_priced_stripped', true,
        `payload keys=[${Object.keys(viol).join(',')}] — no money/storage leak`)
    } else {
      record('pm.own_property_priced_stripped', false,
        `MONEY/STORAGE LEAK — fields [${leaked.join(', ')}] present in payload`)
    }
  } else {
    record('pm.own_property_priced_stripped', false,
      `expected ok=true with violation payload, got ${JSON.stringify(d1)} error=${r1.error?.message ?? 'null'}`)
  }

  // 2-4. Denial tests
  console.log('\n── DENIAL TESTS ──')
  const r2 = await callRpc(mgr.client, V_OOS_LIVE)
  const d2 = r2.data as { error?: string } | null
  if (d2?.error === 'out_of_scope') {
    record('pm.cross_property_denied', true, `Denied: error="out_of_scope"`)
  } else {
    record('pm.cross_property_denied', false,
      `expected error="out_of_scope", got ${JSON.stringify(d2)}`)
  }

  const r3 = await callRpc(mgr.client, V_OWN_VOIDED)
  const d3 = r3.data as { error?: string } | null
  if (d3?.error === 'voided') {
    record('pm.voided_denied', true, `Denied: error="voided"`)
  } else {
    record('pm.voided_denied', false,
      `expected error="voided", got ${JSON.stringify(d3)}`)
  }

  const r4 = await callRpc(mgr.client, V_OWN_NOT_TICKETED)
  const d4 = r4.data as { error?: string } | null
  if (d4?.error === 'not_ticketed') {
    record('pm.not_ticketed_denied', true, `Denied: error="not_ticketed"`)
  } else {
    record('pm.not_ticketed_denied', false,
      `expected error="not_ticketed", got ${JSON.stringify(d4)}`)
  }

  // 5. Leasing_agent + own property → same access pattern
  const r5 = await callRpc(leasing.client, V_OWN_LIVE)
  const d5 = r5.data as { ok?: boolean; violation?: Record<string, unknown>; error?: string } | null
  if (d5?.ok && d5.violation && !('tow_fee' in d5.violation)) {
    record('pm.leasing_agent_works', true, `OK + tow_fee absent (id=${V_OWN_LIVE})`)
  } else {
    record('pm.leasing_agent_works', false,
      `expected ok=true with price-stripped payload, got ${JSON.stringify(d5)} error=${r5.error?.message ?? 'null'}`)
  }

  // 6. Driver role → role_not_authorized
  const r6 = await callRpc(drv.client, V_OWN_LIVE)
  const d6 = r6.data as { error?: string } | null
  if (d6?.error === 'role_not_authorized') {
    record('pm.driver_denied', true, `Denied: error="role_not_authorized"`)
  } else {
    record('pm.driver_denied', false,
      `expected error="role_not_authorized", got ${JSON.stringify(d6)}`)
  }

  // 7. Anonymous client → REVOKE from anon enforced
  const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const r7 = await anonClient.rpc('get_pm_ticket_summary', { p_violation_id: V_OWN_LIVE })
  if (r7.error || (r7.data as { error?: string })?.error) {
    const errMsg = r7.error?.message ?? (r7.data as { error?: string }).error
    record('pm.anon_denied', true, `Denied: ${errMsg}`)
  } else {
    record('pm.anon_denied', false,
      `ANON ACCESS ALLOWED — got ${JSON.stringify(r7.data)}`)
  }

  await cleanupAll()

  console.log('\n── SUMMARY ──')
  const passed = checks.filter(c => c.pass).length
  console.log(`${passed}/${checks.length} PASS (${checks.length - passed} FAIL)`)
  process.exit(passed < checks.length ? 1 : 0)
}

async function cleanupAll() {
  console.log('\n── CLEANUP ──')
  for (const op of cleanup.reverse()) {
    try { await op() } catch (e) { console.error('cleanup:', (e as Error).message) }
  }
  console.log('Cleanup complete.')
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })
