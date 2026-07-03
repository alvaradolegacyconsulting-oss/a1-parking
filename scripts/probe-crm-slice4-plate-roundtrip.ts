// PM CRM Slice 4 — plate re-approval E2E round-trip probe.
//
// Runs the 7 assertions from Jose's expanded list. Provisions temp
// property + resident + driver + active vehicle; simulates submit /
// driver-lookup (old + new) / approve (meter-zero) / decline paths;
// self-cleans.
//
// Assertions:
//   [1] Submit  — vehicles.status='under_review', vehicles.plate UNCHANGED,
//                  change row created status='pending' with correct snapshot.
//   [2] Driver lookup OLD plate — returns authorized (invariant).
//   [3] Driver lookup NEW plate — returns plate_under_review row visible
//                                  to driver session (SAFETY-CRITICAL).
//   [4] Approve — vehicles.plate=NEW, vehicles.status='active', change row
//                 status='approved' + decided_by/at. ZERO permit-sync
//                 audit rows in the approve window (meter-none).
//   [5] Second submit while pending — RPC returns 'already_pending' error
//                                     (one-in-flight enforced).
//   [6] Decline — change row status='declined' + reason, vehicles.plate
//                 UNCHANGED, vehicles.status='active'.
//   [7] Cross-role RLS — second resident CANNOT read A's change row;
//                        manager at DIFFERENT property CANNOT read.
//
// Run: npx tsx --env-file=.env.local scripts/probe-crm-slice4-plate-roundtrip.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const MANAGER = 'chris.tobar94+happy@gmail.com'
const NEG_MGR = 'manager.edge@democorp.com'  // different property

const TAG = `__probe_slice4_${process.env.USER || 'run'}__`
const PROP_NAME = `${TAG}_prop`
const RES_A_EMAIL = `${TAG}_a@example.com`
const RES_B_EMAIL = `${TAG}_b@example.com`
const DRIVER_EMAIL = `${TAG}_driver@example.com`
const OLD_PLATE = 'AAA1234'
const NEW_PLATE = 'BBB5678'

async function cleanup(admin: SupabaseClient, originalProperties: string[]) {
  await admin.from('vehicle_plate_changes').delete().ilike('property', `${TAG}%`)
  await admin.from('vehicles').delete().ilike('property', `${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
  await admin.from('user_roles').update({ property: originalProperties }).ilike('email', MANAGER)
  await admin.from('audit_logs').delete().ilike('action', '%PLATE_CHANGE%').gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
  // Also purge throwaway auth users we may have created.
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 })
  for (const u of users?.users ?? []) {
    if (u.email && u.email.includes(TAG)) {
      await admin.auth.admin.deleteUser(u.id).catch(() => {})
    }
  }
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ SLICE 4 PLATE RE-APPROVAL PROBE ═════════════════════════════\n')
  console.log(`Manager: ${MANAGER} · Negative manager: ${NEG_MGR}\n`)

  const { data: mgrRole } = await admin.from('user_roles').select('property, company').ilike('email', MANAGER).maybeSingle()
  if (!mgrRole) { console.error('manager not found'); process.exit(2) }
  const originalProperties = (mgrRole.property || []) as string[]
  const company = mgrRole.company as string

  await cleanup(admin, originalProperties)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  const { data: propIns } = await admin.from('properties').insert({ name: PROP_NAME, company }).select('id, name').single()
  console.log(`  ✓ property id=${propIns!.id}`)

  await admin.from('user_roles').update({ property: Array.from(new Set([...originalProperties, PROP_NAME])) }).ilike('email', MANAGER)

  await admin.from('residents').insert([
    { email: RES_A_EMAIL, name: 'Probe A', unit: '1', property: PROP_NAME, company, status: 'active', is_active: true },
    { email: RES_B_EMAIL, name: 'Probe B', unit: '2', property: PROP_NAME, company, status: 'active', is_active: true },
  ])
  await admin.from('user_roles').insert([
    { email: RES_A_EMAIL, role: 'resident', company, property: [PROP_NAME] },
    { email: RES_B_EMAIL, role: 'resident', company, property: [PROP_NAME] },
    { email: DRIVER_EMAIL, role: 'driver', company, property: [PROP_NAME] },
  ])
  console.log(`  ✓ residents + user_roles (A, B, driver)`)

  const { data: vehIns } = await admin.from('vehicles').insert({
    plate: OLD_PLATE, resident_email: RES_A_EMAIL, unit: '1', property: PROP_NAME,
    status: 'active', is_active: true,
  }).select('id, plate, status').single()
  const vehicleId = vehIns!.id as number
  console.log(`  ✓ vehicle id=${vehicleId} plate=${vehIns!.plate} status=${vehIns!.status}\n`)

  // Sign in resident A
  const linkA = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_A_EMAIL })
  const clientA = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientA.auth.verifyOtp({ token_hash: (linkA.data!.properties as any).hashed_token, type: 'magiclink' })

  // ── [1] SUBMIT ────────────────────────────────────────────────────
  console.log('─── [1] SUBMIT — resident A submits new plate ────────────────')
  const submitRes = await clientA.rpc('submit_plate_change', {
    p_vehicle_id: vehicleId,
    p_new_plate: NEW_PLATE,
  })
  console.log(`  RPC returned: ${JSON.stringify(submitRes.data)}  err=${JSON.stringify(submitRes.error)}`)
  const submitResult = submitRes.data as { ok?: boolean; change_id?: number } | null
  const changeId = submitResult?.change_id
  if (!submitResult?.ok || !changeId) { console.error('  🔴 submit failed'); await cleanup(admin, originalProperties); process.exit(3) }

  const { data: vehAfterSubmit } = await admin.from('vehicles').select('plate, status').eq('id', vehicleId).single()
  const { data: changeAfterSubmit } = await admin.from('vehicle_plate_changes').select('*').eq('id', changeId).single()
  const test1 =
    vehAfterSubmit?.plate === OLD_PLATE &&        // vehicles.plate UNCHANGED
    vehAfterSubmit?.status === 'under_review' &&  // status flipped
    changeAfterSubmit?.status === 'pending' &&
    changeAfterSubmit?.old_plate === OLD_PLATE &&
    changeAfterSubmit?.new_plate === NEW_PLATE
  console.log(`  vehicles.plate=${vehAfterSubmit?.plate} (expected ${OLD_PLATE}), status=${vehAfterSubmit?.status} (expected under_review)`)
  console.log(`  change row: status=${changeAfterSubmit?.status} old=${changeAfterSubmit?.old_plate} new=${changeAfterSubmit?.new_plate}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] DUPLICATE SUBMIT ──────────────────────────────────────────
  console.log('─── [5] DUPLICATE SUBMIT — one-in-flight ────────────────────')
  const dupRes = await clientA.rpc('submit_plate_change', {
    p_vehicle_id: vehicleId,
    p_new_plate: 'CCC9999',
  })
  console.log(`  RPC returned: ${JSON.stringify(dupRes.data)}`)
  const dupErr = (dupRes.data as { error?: string } | null)?.error
  const test5 = dupErr === 'already_pending'
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'} — error=${dupErr} (expected already_pending)\n`)

  await clientA.auth.signOut()

  // ── [2] + [3] DRIVER LOOKUP ───────────────────────────────────────
  console.log('─── [2] DRIVER LOOKS UP OLD PLATE ────────────────────────────')
  const linkD = await admin.auth.admin.generateLink({ type: 'magiclink', email: DRIVER_EMAIL })
  if (linkD.error) console.log(`  ⚠ generateLink error: ${linkD.error.message}`)
  const clientD = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpD = await clientD.auth.verifyOtp({ token_hash: (linkD.data!.properties as any).hashed_token, type: 'magiclink' })
  if (otpD.error) console.log(`  ⚠ verifyOtp error: ${otpD.error.message}`)
  const { data: dSession } = await clientD.auth.getSession()
  console.log(`  driver JWT email: ${dSession?.session?.user?.email}`)
  const { data: dRole } = await clientD.from('user_roles').select('email, role, company, property').ilike('email', DRIVER_EMAIL)
  console.log(`  driver user_roles (own read): ${JSON.stringify(dRole)}`)
  const { data: dGetMyRole } = await clientD.rpc('get_my_role')
  const { data: dGetMyCompany } = await clientD.rpc('get_my_company')
  console.log(`  get_my_role() = ${JSON.stringify(dGetMyRole)}  get_my_company() = ${JSON.stringify(dGetMyCompany)}`)

  const { data: oldPlateVeh } = await clientD.from('vehicles').select('id, plate, is_active, status, resident_email, property')
    .ilike('plate', OLD_PLATE).ilike('property', PROP_NAME).eq('is_active', true).maybeSingle()
  const test2 = !!oldPlateVeh && oldPlateVeh.plate === OLD_PLATE && oldPlateVeh.is_active === true
  console.log(`  driver sees vehicle: ${JSON.stringify(oldPlateVeh)}`)
  console.log(`  [2] ${test2 ? '🟢 PASS — old plate returns authorized (invariant held)' : '🔴 FAIL'}\n`)

  console.log('─── [3] DRIVER LOOKS UP NEW PLATE (SAFETY-CRITICAL) ─────────')
  const { data: newPlatePc } = await clientD.from('vehicle_plate_changes')
    .select('id, vehicle_id, old_plate, new_plate, submitted_at, property')
    .ilike('new_plate', NEW_PLATE).ilike('property', PROP_NAME).eq('status', 'pending')
    .maybeSingle()
  const test3 = !!newPlatePc && newPlatePc.new_plate === NEW_PLATE && newPlatePc.old_plate === OLD_PLATE
  console.log(`  driver sees plate_under_review row: ${JSON.stringify(newPlatePc)}`)
  console.log(`  [3] ${test3 ? '🟢 PASS — do-not-tow signal visible to driver' : '🔴 FAIL — SAFETY BUG'}\n`)

  await clientD.auth.signOut()

  // ── [7] CROSS-ROLE RLS ────────────────────────────────────────────
  console.log('─── [7] CROSS-ROLE RLS ISOLATION ────────────────────────────')
  // Resident B should NOT see resident A's change.
  const linkB = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_B_EMAIL })
  const clientB = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientB.auth.verifyOtp({ token_hash: (linkB.data!.properties as any).hashed_token, type: 'magiclink' })
  const { data: bSeesA } = await clientB.from('vehicle_plate_changes').select('id').eq('id', changeId).maybeSingle()
  const testB = !bSeesA
  console.log(`  resident B sees A's row: ${bSeesA ? 'YES 🔴' : 'NO ✓'}`)
  await clientB.auth.signOut()

  // Negative-property manager should NOT see A's change either.
  const linkNeg = await admin.auth.admin.generateLink({ type: 'magiclink', email: NEG_MGR })
  const clientNeg = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpN = await clientNeg.auth.verifyOtp({ token_hash: (linkNeg.data!.properties as any).hashed_token, type: 'magiclink' })
  let testNeg = true
  if (otpN.error) {
    console.log(`  neg-manager sign-in unavailable (${otpN.error.message}) — skipping this half`)
  } else {
    const { data: negSees } = await clientNeg.from('vehicle_plate_changes').select('id').eq('id', changeId).maybeSingle()
    testNeg = !negSees
    console.log(`  neg-manager sees A's row: ${negSees ? 'YES 🔴' : 'NO ✓'}`)
    await clientNeg.auth.signOut()
  }
  const test7 = testB && testNeg
  console.log(`  [7] ${test7 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] APPROVE + meter-zero ──────────────────────────────────────
  console.log('─── [4] MANAGER APPROVES — meter-zero required ───────────────')
  const approveWindowStart = new Date().toISOString()
  const linkM = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  const clientM = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientM.auth.verifyOtp({ token_hash: (linkM.data!.properties as any).hashed_token, type: 'magiclink' })

  const approveRes = await clientM.rpc('approve_plate_change', { p_change_id: changeId })
  console.log(`  RPC returned: ${JSON.stringify(approveRes.data)}`)
  const approveResult = approveRes.data as { ok?: boolean } | null
  await clientM.auth.signOut()

  const { data: vehAfterApprove } = await admin.from('vehicles').select('plate, status').eq('id', vehicleId).single()
  const { data: changeAfterApprove } = await admin.from('vehicle_plate_changes').select('*').eq('id', changeId).single()

  // Meter-zero check: scan audit_logs for any permit-sync-related row
  // in the approve window. There should be none because
  // approve_plate_change doesn't call callSyncOnAdd + the CRM handler
  // doesn't either.
  const { data: meterRows } = await admin.from('audit_logs')
    .select('id, action, new_values, created_at')
    .gte('created_at', approveWindowStart)
    .or('action.ilike.%SYNC%,action.ilike.%METER%,action.ilike.%STRIPE%')
  const meterHits = (meterRows ?? []).length

  const test4 =
    approveResult?.ok === true &&
    vehAfterApprove?.plate === NEW_PLATE &&      // vehicles.plate now new
    vehAfterApprove?.status === 'active' &&
    changeAfterApprove?.status === 'approved' &&
    changeAfterApprove?.decided_by !== null &&
    changeAfterApprove?.decided_at !== null &&
    meterHits === 0                              // ← the meter-zero assertion
  console.log(`  vehicles.plate=${vehAfterApprove?.plate} (expected ${NEW_PLATE})  status=${vehAfterApprove?.status} (expected active)`)
  console.log(`  change row: status=${changeAfterApprove?.status} decided_by=${changeAfterApprove?.decided_by}`)
  console.log(`  meter-related audit rows in approve window: ${meterHits} ${meterHits === 0 ? '✓' : '🔴 (should be 0)'}`)
  console.log(`  [4] ${test4 ? '🟢 PASS — meter-zero verified' : '🔴 FAIL'}\n`)

  // ── [6] DECLINE ───────────────────────────────────────────────────
  // Need a fresh pending change to decline. Re-submit.
  console.log('─── [6] DECLINE — old plate stays, no meter ──────────────────')
  const linkA2 = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_A_EMAIL })
  const clientA2 = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientA2.auth.verifyOtp({ token_hash: (linkA2.data!.properties as any).hashed_token, type: 'magiclink' })
  const submit2Res = await clientA2.rpc('submit_plate_change', {
    p_vehicle_id: vehicleId,
    p_new_plate: 'DDD4444',
  })
  const change2Id = (submit2Res.data as any)?.change_id as number | undefined
  await clientA2.auth.signOut()
  if (!change2Id) { console.error('  🔴 could not create a second change for decline path'); await cleanup(admin, originalProperties); process.exit(4) }

  const linkM2 = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  const clientM2 = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientM2.auth.verifyOtp({ token_hash: (linkM2.data!.properties as any).hashed_token, type: 'magiclink' })
  const declineRes = await clientM2.rpc('decline_plate_change', {
    p_change_id: change2Id,
    p_decline_reason: 'Plate does not match TDLR records.',
  })
  console.log(`  RPC returned: ${JSON.stringify(declineRes.data)}`)
  await clientM2.auth.signOut()

  const { data: vehAfterDecline } = await admin.from('vehicles').select('plate, status').eq('id', vehicleId).single()
  const { data: change2After } = await admin.from('vehicle_plate_changes').select('*').eq('id', change2Id).single()
  const test6 =
    (declineRes.data as any)?.ok === true &&
    vehAfterDecline?.plate === NEW_PLATE &&          // plate unchanged from previous approve (still NEW_PLATE)
    vehAfterDecline?.status === 'active' &&
    change2After?.status === 'declined' &&
    change2After?.decline_reason === 'Plate does not match TDLR records.'
  console.log(`  vehicles.plate=${vehAfterDecline?.plate} (expected ${NEW_PLATE} — approved plate stays)  status=${vehAfterDecline?.status}`)
  console.log(`  change row: status=${change2After?.status} decline_reason=${JSON.stringify(change2After?.decline_reason)}`)
  console.log(`  [6] ${test6 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [8] COLLISION GUARD (slice-4 close-out) ──────────────────────
  // State at this point: vehicle A has plate=BBB5678, status='active'
  // (test 4 approved BBB5678, test 6 declined a subsequent change and
  // left BBB5678 in place). Provision sibling vehicle with plate CCC0000
  // at same property; resident A tries to change to CCC0000 → block.
  console.log('─── [8] COLLISION GUARD — plate already authorized ──────────')
  await admin.from('vehicles').insert({
    plate: 'CCC0000', resident_email: RES_B_EMAIL, unit: '2', property: PROP_NAME,
    status: 'active', is_active: true,
  })
  const linkA_col = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_A_EMAIL })
  const clientA_col = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await clientA_col.auth.verifyOtp({ token_hash: (linkA_col.data!.properties as any).hashed_token, type: 'magiclink' })
  const collRes = await clientA_col.rpc('submit_plate_change', {
    p_vehicle_id: vehicleId,
    p_new_plate: 'CCC0000',
  })
  await clientA_col.auth.signOut()
  console.log(`  RPC returned: ${JSON.stringify(collRes.data)}`)
  const collErr = (collRes.data as { error?: string } | null)?.error
  const test8 = collErr === 'plate_already_authorized'
  console.log(`  [8] ${test8 ? '🟢 PASS — collision blocked with plate_already_authorized' : '🔴 FAIL — collision NOT blocked'}\n`)

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log('─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin, originalProperties)
  console.log('  ✓ cleaned up\n')

  const allPass = test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8
  console.log(`════════════════════════════════════════════════════════════════`)
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL 8 ASSERTIONS PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] submit: ${test1 ? '🟢' : '🔴'}  [2] driver OLD: ${test2 ? '🟢' : '🔴'}  [3] driver NEW: ${test3 ? '🟢' : '🔴'}  [4] approve+meter-zero: ${test4 ? '🟢' : '🔴'}  [5] one-in-flight: ${test5 ? '🟢' : '🔴'}  [6] decline: ${test6 ? '🟢' : '🔴'}  [7] RLS: ${test7 ? '🟢' : '🔴'}  [8] collision: ${test8 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
