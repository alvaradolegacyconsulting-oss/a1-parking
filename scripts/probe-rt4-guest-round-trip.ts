// RT-4 — Guest Authorization Resident-Submit + PM-Approve round-trip probe.
//
// HYGIENE RULE (feedback_probe_hygiene_rule.md, 2026-07-03): probes
// MUST NOT mutate a shared eyeball account's user_roles row. This
// probe creates a DEDICATED DISPOSABLE manager + resident + driver
// for the run and tears everything down at end. `+happy` is never
// touched.
//
// Assertions (enforcement-integrity spine + functional round-trip):
//   [1] Pending guest → NOT authorized. Enforcement-cascade query
//       (WHERE status='active' AND today ∈ [start,end]) finds ZERO
//       rows for a pending row. THE CRITICAL ONE.
//   [2] Approved guest → authorized. Same query finds the row.
//   [3] Expired guest → NOT authorized. Row with end_date < today
//       excluded by the date-range gate.
//   [4] Revoked guest → NOT authorized. revoke_guest_authorization
//       sets status='revoked' → row excluded.
//   [5] Meter-zero on approve. countActiveRecords().permits unchanged
//       before/after approve (queries `vehicles`, not
//       `guest_authorizations`).
//   [6] Cap — 4th pending request → pending_cap_reached.
//   [7] 60-day cap — >60d range → DB CHECK rejection.
//   [8] RLS — resident sees own only (0 rows for other resident's
//       row); manager at a different property cannot approve
//       (property_not_in_scope).
//   [9] Round-trip E2E — submit → pending; approve → active +
//       window; decline path also verified.
//
// Run: npx tsx --env-file=.env.local scripts/probe-rt4-guest-round-trip.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TAG = `__probe_rt4_${process.env.USER || 'run'}__`
const COMPANY_A = `${TAG}_co_a`
const COMPANY_B = `${TAG}_co_b`  // for cross-scope RLS
const PROP_A = `${TAG}_prop_a`
const PROP_B = `${TAG}_prop_b`
const MGR_A = `${TAG}_mgr_a@example.com`   // manager at prop A
const MGR_B = `${TAG}_mgr_b@example.com`   // manager at prop B (cross-scope)
const RES_1 = `${TAG}_res1@example.com`    // resident at prop A
const RES_2 = `${TAG}_res2@example.com`    // resident at prop A (for RLS isolation)
const UNIT_1 = 'U1'
const UNIT_2 = 'U2'

const today = new Date()
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => { const c = new Date(d); c.setDate(c.getDate() + n); return c }

async function cleanup(admin: SupabaseClient) {
  await admin.from('audit_logs').delete().or(
    'action.eq.SUBMIT_GUEST_AUTH_REQUEST,action.eq.APPROVE_GUEST_AUTH_REQUEST,action.eq.DECLINE_GUEST_AUTH_REQUEST'
  ).gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString())
  await admin.from('guest_authorizations').delete().ilike('property', `${TAG}%`)
  await admin.from('vehicles').delete().ilike('property', `${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 })
  for (const u of users?.users ?? []) {
    if (u.email && u.email.includes(TAG)) await admin.auth.admin.deleteUser(u.id).catch(() => {})
  }
}

// Replicates the driver enforcement-cascade query for guest_authorizations
// (matching the WHERE clause of guest_auth_enforcement_lookup index).
// If it returns >=1 row for the (property, plate, today) tuple, the plate
// is guest-authorized (do-not-tow). Zero rows = not authorized.
async function isGuestAuthorized(admin: SupabaseClient, property: string, plate: string): Promise<boolean> {
  const t = isoDay(today)
  const { data } = await admin
    .from('guest_authorizations')
    .select('id')
    .ilike('property', property)
    .ilike('plate', plate.toUpperCase())
    .eq('is_active', true)
    .eq('status', 'active')
    .lte('start_date', t)
    .gte('end_date', t)
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function countPermitsForCompany(admin: SupabaseClient, companyName: string): Promise<number> {
  // Replicates countActiveRecords().permits — vehicles active at any
  // property of the company. This is the meter's definition.
  const { data: props } = await admin.from('properties').select('name').ilike('company', companyName).eq('is_active', true)
  const names = (props ?? []).map(p => p.name as string)
  if (names.length === 0) return 0
  const { count } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .in('property', names)
    .eq('status', 'active').eq('is_active', true)
  return count ?? 0
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ RT-4 GUEST AUTHORIZATION ROUND-TRIP PROBE ══════════════════')
  console.log(`Disposable accounts: ${MGR_A}, ${MGR_B}, ${RES_1}, ${RES_2}`)
  console.log(`+happy NEVER touched (per feedback_probe_hygiene_rule.md).\n`)

  await cleanup(admin)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  await admin.from('properties').insert([
    { name: PROP_A, company: COMPANY_A, is_active: true },
    { name: PROP_B, company: COMPANY_B, is_active: true },
  ])
  console.log(`  ✓ properties: ${PROP_A} (co_a) + ${PROP_B} (co_b)`)

  await admin.auth.admin.createUser({ email: MGR_A, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.auth.admin.createUser({ email: MGR_B, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.auth.admin.createUser({ email: RES_1, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.auth.admin.createUser({ email: RES_2, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})

  await admin.from('user_roles').insert([
    { email: MGR_A, role: 'manager', company: COMPANY_A, property: [PROP_A], can_approve_vehicles: true },
    { email: MGR_B, role: 'manager', company: COMPANY_B, property: [PROP_B], can_approve_vehicles: true },
    { email: RES_1, role: 'resident', company: COMPANY_A, property: [PROP_A], can_approve_vehicles: false },
    { email: RES_2, role: 'resident', company: COMPANY_A, property: [PROP_A], can_approve_vehicles: false },
  ])
  await admin.from('residents').insert([
    { email: RES_1, name: 'Probe Resident 1', unit: UNIT_1, phone: '713-555-0001', property: PROP_A, company: COMPANY_A, status: 'active', is_active: true, lease_end: '2026-12-31' },
    { email: RES_2, name: 'Probe Resident 2', unit: UNIT_2, phone: '713-555-0002', property: PROP_A, company: COMPANY_A, status: 'active', is_active: true, lease_end: '2026-12-31' },
  ])
  console.log(`  ✓ 2 managers + 2 residents seeded\n`)

  // Meter baseline: no vehicles at all, permits should be 0.
  const permitsBefore = await countPermitsForCompany(admin, COMPANY_A)
  console.log(`  meter baseline for ${COMPANY_A}: permits=${permitsBefore}\n`)

  // Sign RES_1 in
  const linkR1 = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_1 })
  const clientR1 = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpR1 = await clientR1.auth.verifyOtp({ token_hash: (linkR1.data!.properties as any).hashed_token, type: 'magiclink' })
  if (otpR1.error) { console.error('  🔴 RES_1 sign-in failed:', otpR1.error.message); await cleanup(admin); process.exit(2) }

  // ── [9a] Round-trip: resident submits, expects pending ────────────
  console.log('─── [9a] Resident submit → pending ─────────────────────────')
  const startD = isoDay(addDays(today, 1))
  const endD = isoDay(addDays(today, 8))
  const { data: submit1 } = await clientR1.rpc('submit_guest_authorization_request', {
    p_plate: 'GUEST123', p_state: 'TX', p_vehicle_make: 'Toyota', p_vehicle_model: 'RAV4',
    p_vehicle_color: 'White', p_guest_name: 'Aunt Rose',
    p_start_date: startD, p_end_date: endD,
  })
  const submit1Id = (submit1 as any)?.id
  const test9a = (submit1 as any)?.ok === true && (submit1 as any)?.status === 'pending' && !!submit1Id
  console.log(`  submit → ${JSON.stringify(submit1)}`)
  console.log(`  [9a] ${test9a ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [1] Pending → NOT authorized (CRITICAL SAFETY SPINE) ──────────
  console.log('─── [1] Pending guest → NOT authorized (safety spine) ───────')
  const authed1 = await isGuestAuthorized(admin, PROP_A, 'GUEST123')
  const test1 = authed1 === false
  console.log(`  enforcement cascade found the plate? ${authed1} (expected false)`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL — bypass exists before approval!'}\n`)

  // ── [7] 60-day cap — DB CHECK rejection ─────────────────────────
  console.log('─── [7] 60-day cap enforced by DB CHECK ────────────────────')
  const startBig = isoDay(addDays(today, 1))
  const endBig = isoDay(addDays(today, 100))
  const { error: e7 } = await clientR1.rpc('submit_guest_authorization_request', {
    p_plate: 'BIG100', p_state: 'TX', p_vehicle_make: null, p_vehicle_model: null,
    p_vehicle_color: null, p_guest_name: 'Long Stay',
    p_start_date: startBig, p_end_date: endBig,
  })
  const test7 = !!e7 && /60day|60|check/i.test(e7.message)
  console.log(`  error: ${e7?.message ?? '(none)'}`)
  console.log(`  [7] ${test7 ? '🟢 PASS — CHECK rejected' : '🔴 FAIL — 100-day window slipped past DB CHECK'}\n`)

  // ── [6] Cap — 4th pending → pending_cap_reached ────────────────
  console.log('─── [6] Cap — 4th pending refused ───────────────────────────')
  // Submit 2 more so we have 3 pending; then attempt 4th.
  for (let i = 2; i <= 3; i++) {
    await clientR1.rpc('submit_guest_authorization_request', {
      p_plate: `CAPTST${i}`, p_state: 'TX', p_vehicle_make: null, p_vehicle_model: null,
      p_vehicle_color: null, p_guest_name: `Guest ${i}`,
      p_start_date: startD, p_end_date: endD,
    })
  }
  const { data: submit4 } = await clientR1.rpc('submit_guest_authorization_request', {
    p_plate: 'OVERCAP', p_state: 'TX', p_vehicle_make: null, p_vehicle_model: null,
    p_vehicle_color: null, p_guest_name: 'Fourth',
    p_start_date: startD, p_end_date: endD,
  })
  const test6 = (submit4 as any)?.error === 'pending_cap_reached'
  console.log(`  4th submit → ${JSON.stringify(submit4)}`)
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  await clientR1.auth.signOut()

  // ── Sign RES_2 in ── verify RLS isolation ─────────────────────────
  console.log('─── [8a] RLS — resident sees own only ───────────────────────')
  const linkR2 = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_2 })
  const clientR2 = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientR2.auth.verifyOtp({ token_hash: (linkR2.data!.properties as any).hashed_token, type: 'magiclink' })
  // RES_2 should see ZERO rows since RES_1 owns all rows.
  const { data: r2Sees } = await clientR2.from('guest_authorizations').select('id, plate')
  const test8a = (r2Sees?.length ?? 0) === 0
  console.log(`  RES_2 sees ${r2Sees?.length ?? 0} rows (expected 0)`)
  console.log(`  [8a] ${test8a ? '🟢 PASS' : '🔴 FAIL — resident sees another resident\'s rows'}\n`)
  await clientR2.auth.signOut()

  // ── Sign MGR_B in ── verify cross-property approve blocked ────────
  console.log('─── [8b] RLS — cross-property manager cannot approve ────────')
  const linkMB = await admin.auth.admin.generateLink({ type: 'magiclink', email: MGR_B })
  const clientMB = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientMB.auth.verifyOtp({ token_hash: (linkMB.data!.properties as any).hashed_token, type: 'magiclink' })
  const { data: mbApprove } = await clientMB.rpc('approve_guest_authorization_request', {
    p_id: submit1Id, p_start_date: null, p_end_date: null,
  })
  const test8b = (mbApprove as any)?.error === 'property_not_in_scope'
  console.log(`  MGR_B approve → ${JSON.stringify(mbApprove)}`)
  console.log(`  [8b] ${test8b ? '🟢 PASS' : '🔴 FAIL — cross-scope approve went through'}\n`)
  await clientMB.auth.signOut()

  // ── Sign MGR_A in ── the correct approver ─────────────────────────
  const linkMA = await admin.auth.admin.generateLink({ type: 'magiclink', email: MGR_A })
  const clientMA = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientMA.auth.verifyOtp({ token_hash: (linkMA.data!.properties as any).hashed_token, type: 'magiclink' })

  // ── [5] Meter-zero before approve ─────────────────────────────────
  const permitsBeforeApprove = await countPermitsForCompany(admin, COMPANY_A)

  // ── [9b] Approve → active + window ────────────────────────────────
  console.log('─── [9b] PM approves → active + window ─────────────────────')
  const { data: approve1 } = await clientMA.rpc('approve_guest_authorization_request', {
    p_id: submit1Id, p_start_date: null, p_end_date: null,
  })
  const test9b = (approve1 as any)?.ok === true && (approve1 as any)?.status === 'active' &&
    (approve1 as any)?.start_date === startD && (approve1 as any)?.end_date === endD
  console.log(`  approve → ${JSON.stringify(approve1)}`)
  console.log(`  [9b] ${test9b ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] Meter-zero after approve ──────────────────────────────────
  console.log('─── [5] Meter-zero on approve ──────────────────────────────')
  const permitsAfterApprove = await countPermitsForCompany(admin, COMPANY_A)
  const test5 = permitsBeforeApprove === permitsAfterApprove
  console.log(`  permits before=${permitsBeforeApprove} after=${permitsAfterApprove}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL — approve fired a meter!'}\n`)

  // ── [2] Approved → authorized ─────────────────────────────────────
  console.log('─── [2] Approved guest → authorized ────────────────────────')
  // start_date is tomorrow, so today's query wouldn't match yet. Backdate to today for the check.
  await admin.from('guest_authorizations').update({ start_date: isoDay(addDays(today, -1)) }).eq('id', submit1Id)
  const authed2 = await isGuestAuthorized(admin, PROP_A, 'GUEST123')
  const test2 = authed2 === true
  console.log(`  cascade found the plate? ${authed2} (expected true)`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Expired guest → NOT authorized ────────────────────────────
  console.log('─── [3] Expired guest → NOT authorized ─────────────────────')
  // Push end_date into the past.
  await admin.from('guest_authorizations').update({
    start_date: isoDay(addDays(today, -30)),
    end_date: isoDay(addDays(today, -1)),
  }).eq('id', submit1Id)
  const authed3 = await isGuestAuthorized(admin, PROP_A, 'GUEST123')
  const test3 = authed3 === false
  console.log(`  cascade found the plate? ${authed3} (expected false)`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // Restore window for the revoke test
  await admin.from('guest_authorizations').update({
    start_date: isoDay(addDays(today, -1)),
    end_date: isoDay(addDays(today, 8)),
  }).eq('id', submit1Id)

  // ── [4] Revoked → NOT authorized ─────────────────────────────────
  console.log('─── [4] Revoked guest → NOT authorized ─────────────────────')
  const { error: revErr } = await clientMA.rpc('revoke_guest_authorization', {
    p_id: submit1Id,
    p_reason: 'probe test',
  })
  if (revErr) console.log(`  revoke error: ${revErr.message}`)
  const authed4 = await isGuestAuthorized(admin, PROP_A, 'GUEST123')
  const test4 = authed4 === false
  console.log(`  cascade found the plate? ${authed4} (expected false)`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [9c] Decline round-trip ──────────────────────────────────────
  console.log('─── [9c] PM decline path → declined + reason ───────────────')
  // Use one of the remaining pending rows for the decline path.
  const { data: pendingRows } = await admin.from('guest_authorizations').select('id, plate')
    .eq('status', 'pending').ilike('property', PROP_A).limit(1)
  const declineId = pendingRows?.[0]?.id
  let test9c = false
  if (declineId) {
    const { data: dec } = await clientMA.rpc('decline_guest_authorization_request', {
      p_id: declineId, p_reason: 'Wrong plate format',
    })
    const { data: after } = await admin.from('guest_authorizations').select('status, declined_reason').eq('id', declineId).single()
    test9c = (dec as any)?.ok === true && after?.status === 'declined' && after?.declined_reason === 'Wrong plate format'
    console.log(`  decline → ${JSON.stringify(dec)}; row: status=${after?.status} reason=${after?.declined_reason}`)
  } else {
    console.log(`  no pending row available to decline`)
  }
  console.log(`  [9c] ${test9c ? '🟢 PASS' : '🔴 FAIL'}\n`)

  await clientMA.auth.signOut()

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('\n─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin)
  console.log('  ✓ cleaned up (all disposable accounts + probe rows removed)\n')

  const allPass = test9a && test1 && test7 && test6 && test8a && test8b && test9b && test5 && test2 && test3 && test4 && test9c
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] pending!authz: ${test1 ? '🟢' : '🔴'}  [2] active=authz: ${test2 ? '🟢' : '🔴'}  [3] expired!authz: ${test3 ? '🟢' : '🔴'}  [4] revoked!authz: ${test4 ? '🟢' : '🔴'}  [5] meter-zero: ${test5 ? '🟢' : '🔴'}`)
  console.log(`[6] cap: ${test6 ? '🟢' : '🔴'}  [7] 60d: ${test7 ? '🟢' : '🔴'}  [8a] rls-resident: ${test8a ? '🟢' : '🔴'}  [8b] rls-cross-mgr: ${test8b ? '🟢' : '🔴'}  [9a] submit: ${test9a ? '🟢' : '🔴'}  [9b] approve: ${test9b ? '🟢' : '🔴'}  [9c] decline: ${test9c ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
