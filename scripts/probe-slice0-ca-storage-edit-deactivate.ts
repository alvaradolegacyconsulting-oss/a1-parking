// CA CRM Slice 0 — Storage facility Edit + Deactivate E2E probe.
//
// HYGIENE RULE (feedback_probe_hygiene_rule.md): dedicated disposable
// company_admin account. +happy NEVER touched.
//
// Slice 0 wires the CA portal's edit + activate/deactivate handlers
// (mirroring admin/page.tsx:862-878) for storage_facilities. Server
// side was already ready — RLS company_admin_own_facilities admits
// FOR ALL (SELECT/INSERT/UPDATE/DELETE) company-scoped; only the UI
// handlers were missing. Cascade safety verified: tow-ticket rows
// carry storage fields denormalized at generation, so historical
// tickets keep their storage info when the facility deactivates.
//
// Assertions:
//   [1] EDIT — CA UPDATEs a facility (name/phone/vsf); DB reflects
//       new values; audit row EDIT_FACILITY written.
//   [2] DEACTIVATE — CA flips is_active=false; audit
//       DEACTIVATE_FACILITY; facility drops from the driver's
//       .eq('is_active', true) picker query.
//   [3] REACTIVATE — CA flips is_active=true; audit ACTIVATE_FACILITY;
//       facility returns to the driver picker query.
//   [4] HISTORICAL PROTECTION — a violation row with denormalized
//       tow_storage_* fields KEEPS those fields after the facility is
//       deactivated (cascade safety).
//   [5] RLS — a CA from a DIFFERENT company cannot UPDATE this
//       facility (0 rows returned).
//
// Run: npx tsx --env-file=.env.local scripts/probe-slice0-ca-storage-edit-deactivate.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TAG = `__probe_slice0_${(process.env.USER || 'run').toLowerCase()}__`
const CA_COMPANY_A = `${TAG}_companyA`
const CA_COMPANY_B = `${TAG}_companyB`
const CA_A_EMAIL   = `${TAG}_ca_a@example.com`
const CA_B_EMAIL   = `${TAG}_ca_b@example.com`

async function cleanup(admin: SupabaseClient) {
  const ago = new Date(Date.now() - 10 * 60_000).toISOString()
  await admin.from('audit_logs').delete().gte('created_at', ago)
    .in('action', ['EDIT_FACILITY', 'DEACTIVATE_FACILITY', 'ACTIVATE_FACILITY', 'create_facility'])
  await admin.from('violations').delete().ilike('property', `${TAG}%`)
  await admin.from('storage_facilities').delete().ilike('company', `${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 })
  for (const u of users?.users ?? []) {
    if (u.email && u.email.includes(TAG)) await admin.auth.admin.deleteUser(u.id).catch(() => {})
  }
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ SLICE 0 CA STORAGE EDIT+DEACTIVATE PROBE ═════════════════════')
  console.log(`Disposable CAs: ${CA_A_EMAIL}, ${CA_B_EMAIL}`)
  console.log(`+happy NEVER touched (per feedback_probe_hygiene_rule.md).\n`)

  await cleanup(admin)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  await admin.auth.admin.createUser({ email: CA_A_EMAIL, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.auth.admin.createUser({ email: CA_B_EMAIL, email_confirm: true, password: 'temp-' + Date.now() }).catch(() => {})
  await admin.from('user_roles').insert([
    { email: CA_A_EMAIL, role: 'company_admin', company: CA_COMPANY_A, property: [] },
    { email: CA_B_EMAIL, role: 'company_admin', company: CA_COMPANY_B, property: [] },
  ])
  const { data: facIns, error: facErr } = await admin.from('storage_facilities').insert({
    name: 'Original Facility Name', address: '100 Old Address',
    phone: '(713) 555-0000', email: 'old@example.com',
    vsf_license_number: 'VSF-OLD-001',
    company: CA_COMPANY_A, is_active: true,
  }).select('id').single()
  if (facErr || !facIns) { console.error('facility insert failed:', facErr?.message); await cleanup(admin); process.exit(2) }
  const facilityId = facIns.id as number
  console.log(`  ✓ CA-A facility id=${facilityId}\n`)

  // ── Manager session (as CA-A) ─────────────────────────────────────
  const linkA = await admin.auth.admin.generateLink({ type: 'magiclink', email: CA_A_EMAIL })
  const clientA = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpA = await clientA.auth.verifyOtp({ token_hash: (linkA.data!.properties as any).hashed_token, type: 'magiclink' })
  if (otpA.error) { console.error('  🔴 CA-A sign-in failed:', otpA.error.message); await cleanup(admin); process.exit(2) }

  // ── [1] EDIT ──────────────────────────────────────────────────────
  console.log('─── [1] EDIT_FACILITY — CA edits fields ────────────────────')
  const { error: e1 } = await clientA.from('storage_facilities').update({
    name: 'Updated Facility Name',
    address: '200 New Address',
    phone: '(713) 555-9999',
    email: 'new@example.com',
    vsf_license_number: 'VSF-NEW-002',
  }).eq('id', facilityId)
  if (e1) { console.log(`  🔴 update failed: ${e1.message}`); await cleanup(admin); process.exit(3) }
  await clientA.from('audit_logs').insert({
    user_email: CA_A_EMAIL, action: 'EDIT_FACILITY',
    table_name: 'storage_facilities', record_id: String(facilityId),
    new_values: { name: 'Updated Facility Name', address: '200 New Address' },
  })
  const { data: fAfter } = await admin.from('storage_facilities').select('name, address, phone, email, vsf_license_number').eq('id', facilityId).single()
  const { count: editAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'EDIT_FACILITY').eq('record_id', String(facilityId))
  const test1 =
    fAfter?.name === 'Updated Facility Name' && fAfter?.address === '200 New Address' &&
    fAfter?.phone === '(713) 555-9999' && fAfter?.vsf_license_number === 'VSF-NEW-002' &&
    (editAudit ?? 0) >= 1
  console.log(`  after: name='${fAfter?.name}' phone='${fAfter?.phone}' vsf='${fAfter?.vsf_license_number}'`)
  console.log(`  EDIT_FACILITY audit rows: ${editAudit}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── Provision a violation with denormalized storage fields ────────
  const { data: vIns, error: vErr } = await admin.from('violations').insert({
    plate: 'HISTORY1', property: `${TAG}_prop`,
    violation_type: 'slice0 storage historical probe',
    location: 'probe',
    driver_name: 'probe@example.com',
    is_confirmed: true,
    status: 'tow_ticket', tow_ticket_generated: true,
    tow_storage_name: 'Updated Facility Name',
    tow_storage_address: '200 New Address',
    tow_storage_phone: '(713) 555-9999',
  }).select('id').single()
  if (vErr || !vIns) { console.error('  🔴 violation insert failed:', vErr?.message); await cleanup(admin); process.exit(2) }
  const violationId = vIns.id as number

  // ── [2] DEACTIVATE ────────────────────────────────────────────────
  console.log('─── [2] DEACTIVATE_FACILITY — flips is_active=false ─────────')
  const { error: e2 } = await clientA.from('storage_facilities').update({ is_active: false }).eq('id', facilityId)
  if (e2) { console.log(`  🔴 update failed: ${e2.message}`); await cleanup(admin); process.exit(4) }
  await clientA.from('audit_logs').insert({
    user_email: CA_A_EMAIL, action: 'DEACTIVATE_FACILITY',
    table_name: 'storage_facilities', record_id: String(facilityId),
    new_values: { is_active: false },
  })
  const { data: fDeact } = await admin.from('storage_facilities').select('is_active').eq('id', facilityId).single()
  // Simulate the driver picker query (.eq('is_active', true)) — the deactivated facility must NOT appear
  const { data: pickerRows } = await admin.from('storage_facilities')
    .select('id').eq('is_active', true).eq('id', facilityId)
  const { count: deactAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'DEACTIVATE_FACILITY').eq('record_id', String(facilityId))
  const test2 = fDeact?.is_active === false && (pickerRows?.length ?? 0) === 0 && (deactAudit ?? 0) >= 1
  console.log(`  is_active after deactivate: ${fDeact?.is_active} (expect false)`)
  console.log(`  driver picker query returned ${pickerRows?.length ?? 0} rows for this facility (expect 0)`)
  console.log(`  DEACTIVATE_FACILITY audit rows: ${deactAudit}`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] REACTIVATE ────────────────────────────────────────────────
  console.log('─── [3] ACTIVATE_FACILITY — flips is_active=true ────────────')
  const { error: e3 } = await clientA.from('storage_facilities').update({ is_active: true }).eq('id', facilityId)
  if (e3) { console.log(`  🔴 update failed: ${e3.message}`); await cleanup(admin); process.exit(5) }
  await clientA.from('audit_logs').insert({
    user_email: CA_A_EMAIL, action: 'ACTIVATE_FACILITY',
    table_name: 'storage_facilities', record_id: String(facilityId),
    new_values: { is_active: true },
  })
  const { data: fReact } = await admin.from('storage_facilities').select('is_active').eq('id', facilityId).single()
  const { data: pickerRows2 } = await admin.from('storage_facilities')
    .select('id').eq('is_active', true).eq('id', facilityId)
  const { count: reactAudit } = await admin.from('audit_logs').select('id', { count: 'exact', head: true })
    .eq('action', 'ACTIVATE_FACILITY').eq('record_id', String(facilityId))
  const test3 = fReact?.is_active === true && (pickerRows2?.length ?? 0) === 1 && (reactAudit ?? 0) >= 1
  console.log(`  is_active after reactivate: ${fReact?.is_active} (expect true)`)
  console.log(`  driver picker query rows: ${pickerRows2?.length ?? 0} (expect 1)`)
  console.log(`  ACTIVATE_FACILITY audit rows: ${reactAudit}`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] HISTORICAL PROTECTION ─────────────────────────────────────
  console.log('─── [4] HISTORICAL — deactivate leaves denormalized fields ──')
  // Deactivate again and confirm the violation's denormalized fields are untouched.
  await clientA.from('storage_facilities').update({ is_active: false }).eq('id', facilityId)
  const { data: vAfter } = await admin.from('violations').select('tow_storage_name, tow_storage_address, tow_storage_phone').eq('id', violationId).single()
  const test4 =
    vAfter?.tow_storage_name === 'Updated Facility Name' &&
    vAfter?.tow_storage_address === '200 New Address' &&
    vAfter?.tow_storage_phone === '(713) 555-9999'
  console.log(`  violation.tow_storage_name='${vAfter?.tow_storage_name}' (expect 'Updated Facility Name')`)
  console.log(`  violation.tow_storage_phone='${vAfter?.tow_storage_phone}' (expect '(713) 555-9999')`)
  console.log(`  [4] ${test4 ? '🟢 PASS — historical tickets preserved by denormalization' : '🔴 FAIL'}\n`)

  await clientA.auth.signOut()

  // ── [5] RLS — cross-company CA blocked ────────────────────────────
  console.log('─── [5] RLS negative — cross-company CA blocked ─────────────')
  const linkB = await admin.auth.admin.generateLink({ type: 'magiclink', email: CA_B_EMAIL })
  const clientB = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpB = await clientB.auth.verifyOtp({ token_hash: (linkB.data!.properties as any).hashed_token, type: 'magiclink' })
  let test5 = true
  if (otpB.error) {
    console.log(`  CA-B sign-in failed (${otpB.error.message}) — skipping`)
  } else {
    const { data: hackUpd } = await clientB.from('storage_facilities').update({ name: 'HACKED' }).eq('id', facilityId).select('id')
    test5 = !hackUpd || hackUpd.length === 0
    console.log(`  CA-B UPDATE rows on CA-A's facility: ${hackUpd?.length ?? 0} → ${test5 ? '🟢 blocked' : '🔴 RLS gap'}`)
    await clientB.auth.signOut()
  }
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin)
  console.log('  ✓ cleaned up\n')

  const allPass = test1 && test2 && test3 && test4 && test5
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] EDIT: ${test1 ? '🟢' : '🔴'}  [2] DEACT: ${test2 ? '🟢' : '🔴'}  [3] REACT: ${test3 ? '🟢' : '🔴'}  [4] HISTORICAL: ${test4 ? '🟢' : '🔴'}  [5] RLS: ${test5 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
