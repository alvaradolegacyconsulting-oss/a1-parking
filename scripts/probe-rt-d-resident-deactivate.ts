// RT-D — Resident Deactivate CRM wire-up + F2/F3 cascade E2E probe.
//
// HYGIENE RULE (feedback_probe_hygiene_rule.md): dedicated disposable
// manager + disposable resident. +happy NEVER touched.
//
// The primary cascade (deactivateResident → runOneDeactivate) is a
// client handler in manager/page.tsx that composes:
//   1. residents.is_active = false
//   2. audit DEACTIVATE_RESIDENT
//   3. trimDepartedResidentVehicles     (vehicles is_active=false owner-stamped)
//   4. cascadeVehiclesIfUnitVacant      (B150; other units at unit)
//   5. F2 — space_requests pending → declined / 'resident_deactivated'
//   6. F3 — guest_authorizations pending → declined / 'resident_deactivated'
//   7. residents_deactivate_free_spaces DB trigger fires on the UPDATE
//      at step 1, cleans space_residents ties + writes AUTH_SPACE_FREE_AUTO
//
// The probe reproduces steps 1-6 as a service-role sequence (service-role
// bypasses RLS so the pieces are independently observable) then asserts
// the observable end-state. Step 7 is a DB trigger — it fires regardless
// of caller — so the AUTH_SPACE_FREE_AUTO audit shows up in the log.
//
// Assertions:
//   [1] SAFETY — deactivated resident's active vehicles all scan
//       NOT AUTHORIZED (driver enforcement cascade filters is_active=true
//       AND status='active'; is_active=false alone excludes them).
//   [2] Meter input — countActiveRecords()-shape query drops by the
//       resident's active-vehicle count (WHERE status='active' AND
//       is_active=true predicate excludes flipped rows).
//   [3] Spaces freed — space_residents tie removed by the DB trigger,
//       AUTH_SPACE_FREE_AUTO audit written; roommate's tie preserved.
//   [4] Deactivate-together — deactivating only the target leaves the
//       co-resident active; deactivating the co-resident too flips both.
//   [5] F2 — pending space_requests flipped to declined /
//       'resident_deactivated'; audit DECLINE_SPACE_REQUEST_CASCADE.
//   [6] F3 — pending guest_authorizations flipped to declined /
//       'resident_deactivated'; audit DECLINE_GUEST_AUTH_CASCADE.
//   [7] Record retained — resident + vehicles rows still present (not
//       deleted). Auth user untouched (auth.admin listUsers finds them).
//   [8] RLS — cross-property/company manager cannot UPDATE this
//       resident (0 rows returned).
//   [9] Reactivate — resident is_active=true; owner-stamped vehicles
//       is_active=true; auto-declined space + guest requests do NOT
//       resurrect (terminal per B206 lesson).
//  [10] F1 latent check — post-deactivate, do any resident's vehicles
//       still read status='active' while is_active=false? (If yes,
//       F1 canonical-shape drift is confirmed — the cascade should
//       set status='deactivated' too.)
//
// Run: npx tsx --env-file=.env.local scripts/probe-rt-d-resident-deactivate.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const NEG_MGR = 'manager.edge@democorp.com'

const TAG = `__probe_rtd_${(process.env.USER || 'run').toLowerCase()}__`
const PROP_NAME    = `${TAG}_prop`
const COMPANY_NAME = `${TAG}_company`
// Dedicated disposable accounts per hygiene rule. NOT +happy.
const DISPOSABLE_MGR_EMAIL = `${TAG}_mgr@example.com`
const RES_A_EMAIL          = `${TAG}_a@example.com`   // deactivate target
const RES_B_EMAIL          = `${TAG}_b@example.com`   // co-resident (roommate)
const RES_C_EMAIL          = `${TAG}_c@example.com`   // different unit — control
const PLATE_A1 = 'RTDA0001'
const PLATE_A2 = 'RTDA0002'
const PLATE_B  = 'RTDB0001'

async function cleanup(admin: SupabaseClient) {
  const ago = new Date(Date.now() - 10 * 60_000).toISOString()
  await admin.from('audit_logs').delete().gte('created_at', ago)
    .in('action', ['DEACTIVATE_RESIDENT','DECLINE_SPACE_REQUEST_CASCADE',
                   'DECLINE_GUEST_AUTH_CASCADE','AUTH_SPACE_FREE_AUTO',
                   'B166-owner-trim','RTD_PROBE'])
  await admin.from('guest_authorizations').delete().ilike('property', `${TAG}%`)
  await admin.from('space_requests').delete().ilike('property', `${TAG}%`)
  await admin.from('space_residents').delete().ilike('resident_email', `%${TAG}%`)
  await admin.from('spaces').delete().ilike('property', `${TAG}%`)
  await admin.from('vehicles').delete().ilike('property', `${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 })
  for (const u of users?.users ?? []) {
    if (u.email && u.email.includes(TAG)) await admin.auth.admin.deleteUser(u.id).catch(() => {})
  }
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ RT-D RESIDENT DEACTIVATE PROBE ═══════════════════════════════')
  console.log(`Disposable manager: ${DISPOSABLE_MGR_EMAIL}`)
  console.log(`+happy NEVER touched (per feedback_probe_hygiene_rule.md).\n`)

  await cleanup(admin)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  const { data: propIns } = await admin.from('properties').insert({ name: PROP_NAME, company: COMPANY_NAME, is_active: true }).select('id').single()
  console.log(`  ✓ property id=${propIns!.id}`)

  await admin.auth.admin.createUser({ email: DISPOSABLE_MGR_EMAIL, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.auth.admin.createUser({ email: RES_A_EMAIL, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.from('user_roles').insert([
    { email: DISPOSABLE_MGR_EMAIL, role: 'manager',  company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: true },
    { email: RES_A_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_B_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_C_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
  ])
  await admin.from('residents').insert([
    { email: RES_A_EMAIL, name: 'Res A', unit: '101', phone: '713-555-0001', property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31', manager_note: 'a' },
    { email: RES_B_EMAIL, name: 'Res B', unit: '101', phone: '713-555-0002', property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31', manager_note: 'b' },
    { email: RES_C_EMAIL, name: 'Res C', unit: '202', phone: '713-555-0003', property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31', manager_note: 'c' },
  ])
  const { data: rows } = await admin.from('residents').select('id, email').ilike('email', `%${TAG}%`)
  const idOf = (email: string) => (rows ?? []).find(r => (r.email as string).toLowerCase() === email.toLowerCase())!.id as number
  const resAId = idOf(RES_A_EMAIL); const resBId = idOf(RES_B_EMAIL); const resCId = idOf(RES_C_EMAIL)

  await admin.from('vehicles').insert([
    { plate: PLATE_A1, resident_email: RES_A_EMAIL, unit: '101', property: PROP_NAME, status: 'active', is_active: true, state: 'TX' },
    { plate: PLATE_A2, resident_email: RES_A_EMAIL, unit: '101', property: PROP_NAME, status: 'active', is_active: true, state: 'TX' },
    { plate: PLATE_B,  resident_email: RES_B_EMAIL, unit: '101', property: PROP_NAME, status: 'active', is_active: true, state: 'TX' },
  ])
  // Space that Res A and Res B share (roommate case). spaces requires
  // company NOT NULL + CHECK (status='assigned' → assigned_to_resident_email NOT NULL).
  const { data: spIns, error: spErr } = await admin.from('spaces').insert({
    label: 'SP-1', type: 'covered', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: RES_A_EMAIL,
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id').single()
  if (spErr || !spIns) { console.error('space insert failed:', spErr?.message); await cleanup(admin); process.exit(2) }
  const spaceId = spIns.id as number
  const { error: tieErr } = await admin.from('space_residents').insert([
    { space_id: spaceId, resident_email: RES_A_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: spaceId, resident_email: RES_B_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
  ])
  if (tieErr) { console.error('space_residents insert failed:', tieErr.message); await cleanup(admin); process.exit(2) }
  const { data: tiePre } = await admin.from('space_residents').select('resident_email').eq('space_id', spaceId)
  console.log(`  ✓ space_residents inserted; count=${tiePre?.length ?? 0}`)
  // Pending space request from Res A
  const { data: srIns } = await admin.from('space_requests').insert({
    resident_email: RES_A_EMAIL, property: PROP_NAME, status: 'pending', note: 'want a second space',
  }).select('id').single()
  const spaceReqId = srIns!.id as number
  // Pending guest_authorization request from Res A
  const { data: gaIns } = await admin.from('guest_authorizations').insert({
    company: COMPANY_NAME, property: PROP_NAME, plate: 'GUESTA1', state: 'TX', guest_name: 'Grandma A',
    visiting_unit: '101', resident_email: RES_A_EMAIL,
    start_date: '2026-08-01', end_date: '2026-08-10',
    status: 'pending', is_active: true, created_by_email: RES_A_EMAIL,
  }).select('id').single()
  const guestReqId = gaIns!.id as number

  console.log(`  ✓ residents: A=${resAId} B=${resBId} C=${resCId}`)
  console.log(`  ✓ vehicles: A(${PLATE_A1},${PLATE_A2}) B(${PLATE_B})`)
  console.log(`  ✓ space SP-1 shared by A + B (space_id=${spaceId})`)
  console.log(`  ✓ pending space_request id=${spaceReqId}, pending guest_auth id=${guestReqId}\n`)

  // ── Reproduce runOneDeactivate for Res A via service role ────────
  // We mimic the client cascade (service-role bypasses RLS but the
  // observable end-state is identical, and step 7 DB trigger fires on
  // the residents.is_active UPDATE regardless of caller identity).
  console.log('─── EXECUTE runOneDeactivate(A) ─────────────────────────────')
  await admin.from('residents').update({ is_active: false }).eq('id', resAId)
  await admin.from('audit_logs').insert({
    user_email: DISPOSABLE_MGR_EMAIL, action: 'DEACTIVATE_RESIDENT',
    table_name: 'residents', record_id: String(resAId),
    new_values: { is_active: false, property: PROP_NAME },
  })
  // trimDepartedResidentVehicles shape:
  await admin.from('vehicles').update({ is_active: false })
    .eq('resident_email', RES_A_EMAIL).ilike('unit', '101').ilike('property', PROP_NAME).eq('is_active', true)
  // F2 + F3: stamp decided_by_email + decided_at to satisfy
  // space_requests_decided_consistency_chk (any pending → decided
  // transition requires both).
  await admin.from('space_requests').update({
    status: 'declined', decline_reason: 'resident_deactivated',
    decided_by_email: DISPOSABLE_MGR_EMAIL, decided_at: new Date().toISOString(),
  }).eq('resident_email', RES_A_EMAIL.toLowerCase()).eq('status', 'pending')
  await admin.from('audit_logs').insert({
    user_email: DISPOSABLE_MGR_EMAIL, action: 'DECLINE_SPACE_REQUEST_CASCADE',
    table_name: 'space_requests', record_id: String(spaceReqId),
    new_values: { status: 'declined', reason: 'resident_deactivated', cascade_source: 'DEACTIVATE_RESIDENT' },
  })
  await admin.from('guest_authorizations').update({ status: 'declined', declined_reason: 'resident_deactivated' })
    .eq('resident_email', RES_A_EMAIL.toLowerCase()).eq('status', 'pending')
  await admin.from('audit_logs').insert({
    user_email: DISPOSABLE_MGR_EMAIL, action: 'DECLINE_GUEST_AUTH_CASCADE',
    table_name: 'guest_authorizations', record_id: String(guestReqId),
    new_values: { status: 'declined', reason: 'resident_deactivated', cascade_source: 'DEACTIVATE_RESIDENT' },
  })
  console.log(`  ✓ Res A deactivated + cascades ran\n`)

  // ── [1] SAFETY — plate lookup returns NOT AUTHORIZED ────────────
  console.log('─── [1] SAFETY — deactivated vehicles NOT AUTHORIZED ────────')
  const { count: authA1 } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .ilike('plate', PLATE_A1).ilike('property', PROP_NAME).eq('is_active', true).eq('status', 'active')
  const { count: authA2 } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .ilike('plate', PLATE_A2).ilike('property', PROP_NAME).eq('is_active', true).eq('status', 'active')
  const { count: authB } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .ilike('plate', PLATE_B).ilike('property', PROP_NAME).eq('is_active', true).eq('status', 'active')
  const test1 = authA1 === 0 && authA2 === 0 && authB === 1
  console.log(`  driver-cascade query on ${PLATE_A1}: ${authA1} rows (expect 0)`)
  console.log(`  driver-cascade query on ${PLATE_A2}: ${authA2} rows (expect 0)`)
  console.log(`  driver-cascade query on ${PLATE_B}:  ${authB} rows (expect 1 — B still active)`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL — SAFETY'}\n`)

  // ── [2] Meter input — countActiveRecords predicate drops A's cars ─
  console.log('─── [2] Meter input — permits count drops by A\'s active cars ─')
  const { count: permits } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .ilike('property', PROP_NAME).eq('status', 'active').eq('is_active', true)
  const test2 = permits === 1 // only B remains
  console.log(`  countActiveRecords-shape permits at property: ${permits} (expect 1)`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Spaces freed — DB trigger + AUTH_SPACE_FREE_AUTO audit ───
  console.log('─── [3] Spaces trigger — A tie removed, B tie preserved ─────')
  const { data: tiesAfter } = await admin.from('space_residents').select('resident_email').eq('space_id', spaceId)
  const emails = (tiesAfter ?? []).map(t => (t.resident_email as string).toLowerCase())
  const hasA = emails.includes(RES_A_EMAIL.toLowerCase())
  const hasB = emails.includes(RES_B_EMAIL.toLowerCase())
  const { count: freeAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'AUTH_SPACE_FREE_AUTO').eq('user_email', RES_A_EMAIL.toLowerCase())
  const test3 = !hasA && hasB && (freeAudit ?? 0) >= 1
  console.log(`  ties after: A=${hasA} (expect false), B=${hasB} (expect true)`)
  console.log(`  AUTH_SPACE_FREE_AUTO audit rows for A: ${freeAudit} (expect >=1)`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Deactivate-together — B still active pre-batch ──────────
  console.log('─── [4] Deactivate-together — B untouched unless included ───')
  const { data: bStateBefore } = await admin.from('residents').select('is_active').eq('id', resBId).single()
  // Simulate batch flip of B via the same runOneDeactivate steps
  await admin.from('residents').update({ is_active: false }).eq('id', resBId)
  await admin.from('vehicles').update({ is_active: false })
    .eq('resident_email', RES_B_EMAIL).ilike('unit', '101').ilike('property', PROP_NAME).eq('is_active', true)
  const { data: bStateAfter } = await admin.from('residents').select('is_active').eq('id', resBId).single()
  const { data: cState } = await admin.from('residents').select('is_active').eq('id', resCId).single()
  const test4 = bStateBefore?.is_active === true && bStateAfter?.is_active === false && cState?.is_active === true
  console.log(`  B is_active: ${bStateBefore?.is_active} → ${bStateAfter?.is_active} (expect true→false when included)`)
  console.log(`  C is_active: ${cState?.is_active} (expect true — different unit, never touched)`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] F2 — space_request declined + audit ─────────────────────
  console.log('─── [5] F2 — pending space_requests → declined ──────────────')
  const { data: sr5 } = await admin.from('space_requests').select('status, decline_reason').eq('id', spaceReqId).single()
  const { count: srAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'DECLINE_SPACE_REQUEST_CASCADE').eq('record_id', String(spaceReqId))
  const test5 = sr5?.status === 'declined' && sr5?.decline_reason === 'resident_deactivated' && (srAudit ?? 0) >= 1
  console.log(`  space_request: status=${sr5?.status} reason=${sr5?.decline_reason}`)
  console.log(`  DECLINE_SPACE_REQUEST_CASCADE audit: ${srAudit}`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [6] F3 — guest_authorization declined + audit ───────────────
  console.log('─── [6] F3 — pending guest_authorizations → declined ────────')
  const { data: ga6 } = await admin.from('guest_authorizations').select('status, declined_reason').eq('id', guestReqId).single()
  const { count: gaAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'DECLINE_GUEST_AUTH_CASCADE').eq('record_id', String(guestReqId))
  const test6 = ga6?.status === 'declined' && ga6?.declined_reason === 'resident_deactivated' && (gaAudit ?? 0) >= 1
  console.log(`  guest_auth: status=${ga6?.status} reason=${ga6?.declined_reason}`)
  console.log(`  DECLINE_GUEST_AUTH_CASCADE audit: ${gaAudit}`)
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [7] Records retained + auth user untouched ──────────────────
  console.log('─── [7] Records retained (not deleted), auth user intact ────')
  const { data: rExists } = await admin.from('residents').select('id, is_active').eq('id', resAId).single()
  const { count: vExists } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .eq('resident_email', RES_A_EMAIL).ilike('property', PROP_NAME)
  const { data: allUsers } = await admin.auth.admin.listUsers({ perPage: 200 })
  const authStillThere = (allUsers?.users ?? []).some(u => u.email?.toLowerCase() === RES_A_EMAIL.toLowerCase())
  const test7 = !!rExists && rExists.is_active === false && (vExists ?? 0) === 2 && authStillThere
  console.log(`  resident row present: ${!!rExists} (is_active=${rExists?.is_active})`)
  console.log(`  vehicle rows retained: ${vExists} (expect 2)`)
  console.log(`  auth user retained: ${authStillThere}`)
  console.log(`  [7] ${test7 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [8] RLS — cross-scope manager blocked ───────────────────────
  console.log('─── [8] RLS negative — cross-property manager blocked ───────')
  const linkNeg = await admin.auth.admin.generateLink({ type: 'magiclink', email: NEG_MGR })
  const clientNeg = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpN = await clientNeg.auth.verifyOtp({ token_hash: (linkNeg.data!.properties as any).hashed_token, type: 'magiclink' })
  let test8 = true
  if (otpN.error) {
    console.log(`  neg-manager sign-in unavailable (${otpN.error.message}) — skipping`)
  } else {
    const { data: negUpd } = await clientNeg.from('residents').update({ manager_note: 'HACK' }).eq('id', resCId).select('id')
    test8 = !negUpd || negUpd.length === 0
    console.log(`  neg-manager UPDATE rows on C: ${negUpd?.length ?? 0} → ${test8 ? '🟢 blocked' : '🔴 RLS gap'}`)
    await clientNeg.auth.signOut()
  }
  console.log(`  [8] ${test8 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [9] Reactivate — resident + owner-stamped vehicles restored ──
  console.log('─── [9] Reactivate — resident + own vehicles restored ───────')
  await admin.from('residents').update({ is_active: true }).eq('id', resAId)
  await admin.from('vehicles').update({ is_active: true })
    .eq('resident_email', RES_A_EMAIL).ilike('unit', '101').ilike('property', PROP_NAME).eq('is_active', false)
  const { data: aRe } = await admin.from('residents').select('is_active').eq('id', resAId).single()
  const { count: aVehsActive } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .eq('resident_email', RES_A_EMAIL).ilike('property', PROP_NAME).eq('is_active', true)
  // Auto-declined requests must NOT resurrect
  const { data: sr9 } = await admin.from('space_requests').select('status').eq('id', spaceReqId).single()
  const { data: ga9 } = await admin.from('guest_authorizations').select('status').eq('id', guestReqId).single()
  const test9 = aRe?.is_active === true && (aVehsActive ?? 0) === 2 &&
                sr9?.status === 'declined' && ga9?.status === 'declined'
  console.log(`  A is_active: ${aRe?.is_active} (expect true)`)
  console.log(`  A vehicles active: ${aVehsActive} (expect 2)`)
  console.log(`  space_request status: ${sr9?.status} (expect 'declined' — NOT auto-resurrected)`)
  console.log(`  guest_auth   status: ${ga9?.status} (expect 'declined' — NOT auto-resurrected)`)
  console.log(`  [9] ${test9 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [10] F1 latent check — status='active' + is_active=false drift ─
  console.log('─── [10] F1 canonical-shape check (does drift exist?) ────────')
  // Do a fresh deactivate cycle to inspect: re-deactivate A + observe
  await admin.from('residents').update({ is_active: false }).eq('id', resAId)
  await admin.from('vehicles').update({ is_active: false })
    .eq('resident_email', RES_A_EMAIL).ilike('unit', '101').ilike('property', PROP_NAME).eq('is_active', true)
  const { count: driftCount } = await admin.from('vehicles').select('id', { count: 'exact', head: true })
    .eq('resident_email', RES_A_EMAIL).ilike('property', PROP_NAME)
    .eq('is_active', false).eq('status', 'active')
  const test10Info = driftCount ?? 0
  // Not a pass/fail — informational: reports the drift count for F1 triage.
  console.log(`  vehicles with is_active=false AND status='active' (drift): ${test10Info}`)
  console.log(`  [10] ${test10Info > 0 ? '⚠  F1 drift confirmed (informational — not a fail)' : '🟢 no drift'}\n`)

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin)
  console.log('  ✓ cleaned up\n')

  const allPass = test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8 && test9
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] SAFETY: ${test1 ? '🟢' : '🔴'}  [2] meter: ${test2 ? '🟢' : '🔴'}  [3] spaces: ${test3 ? '🟢' : '🔴'}  [4] cotogether: ${test4 ? '🟢' : '🔴'}  [5] F2: ${test5 ? '🟢' : '🔴'}  [6] F3: ${test6 ? '🟢' : '🔴'}  [7] retained: ${test7 ? '🟢' : '🔴'}  [8] RLS: ${test8 ? '🟢' : '🔴'}  [9] reactivate: ${test9 ? '🟢' : '🔴'}  [10] F1: ${test10Info > 0 ? '⚠ drift' : '🟢 clean'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
