// CLARIFY — "Plates authorized on this space" derivation E2E probe.
//
// The space's plate list must mirror what actually scans as authorized
// for the residents tied to that space. Not a new auth source — a
// display that reflects reality.
//
// Rules (per Jose 2026-07-04):
//   Q1 — YES include all approved plates for EVERY tied resident (roommates)
//   Q2 — YES show the OLD plate w/ "plate change under review" marker
//        during plate-change review; do NOT show the pending NEW plate
//   Guardrails:
//     · deactivated tied resident → their plates DO NOT appear
//     · deactivated vehicles → excluded
//     · pending/declined vehicles → excluded
//
// Assertions:
//   [1] Roommate space — 2 active tied residents each with an approved
//       vehicle → both plates appear, each attributed to its owner.
//   [2] Under-review plate → OLD plate shows with plateChangeUnderReview=
//       true; NEW plate is absent from the space list.
//   [3] Deactivated tied resident → their plates DO NOT appear on the
//       space list (belt-and-suspenders: even before the RT-D auto-free
//       trigger removes the tie).
//   [4] Pending / declined vehicles do NOT appear on the space list.
//
// Disposable manager + 4 disposable residents per hygiene rule.
// Run: npx tsx --env-file=.env.local scripts/probe-clarify-plates-on-space.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { buildCrmResidents } from '../app/lib/pm-crm'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TAG = `__probe_plates_${(process.env.USER || 'run').toLowerCase()}__`
const PROP_NAME    = `${TAG}_prop`
const COMPANY_NAME = `${TAG}_company`
const DISPOSABLE_MGR_EMAIL = `${TAG}_mgr@example.com`
// Roommate scenario: A + B on the shared space, each with own vehicles
const RES_A_EMAIL = `${TAG}_a@example.com`
const RES_B_EMAIL = `${TAG}_b@example.com`
// Scenario for deactivated: D also tied to the shared space
const RES_D_EMAIL = `${TAG}_d@example.com`
// Scenario for pending/declined vehicle: P tied to a solo space
const RES_P_EMAIL = `${TAG}_p@example.com`

const PLATE_A_OK   = 'PLTA0001'
const PLATE_B_OK   = 'PLTB0001'
const PLATE_B_OLD  = 'PLTBOLD1'   // will have plate-change under review
const PLATE_B_NEW  = 'PLTBNEW1'   // new plate — must NOT appear
const PLATE_D      = 'PLTD0001'   // deactivated resident's plate
const PLATE_P_PEND = 'PLTP0001'   // pending vehicle
const PLATE_P_DECL = 'PLTP0002'   // declined vehicle

async function cleanup(admin: SupabaseClient) {
  await admin.from('vehicle_plate_changes').delete().ilike('property', `${TAG}%`)
  await admin.from('space_residents').delete().ilike('resident_email', `%${TAG}%`)
  await admin.from('spaces').delete().ilike('property', `${TAG}%`)
  await admin.from('vehicles').delete().ilike('property', `${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ CLARIFY PLATES-ON-SPACE PROBE ═════════════════════════════════')
  console.log(`Disposable manager: ${DISPOSABLE_MGR_EMAIL}`)
  console.log(`+happy NEVER touched (per feedback_probe_hygiene_rule.md).\n`)

  await cleanup(admin)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  await admin.from('properties').insert({ name: PROP_NAME, company: COMPANY_NAME, is_active: true })
  await admin.from('user_roles').insert([
    { email: DISPOSABLE_MGR_EMAIL, role: 'manager',  company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: true },
    { email: RES_A_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_B_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_D_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_P_EMAIL,          role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
  ])
  // Res A + B active; Res D DEACTIVATED (is_active=false); Res P active.
  await admin.from('residents').insert([
    { email: RES_A_EMAIL, name: 'Alice A', unit: '101', property: PROP_NAME, company: COMPANY_NAME, status: 'active',  is_active: true,  lease_end: '2026-12-31' },
    { email: RES_B_EMAIL, name: 'Bob B',   unit: '101', property: PROP_NAME, company: COMPANY_NAME, status: 'active',  is_active: true,  lease_end: '2026-12-31' },
    { email: RES_D_EMAIL, name: 'Dan D',   unit: '101', property: PROP_NAME, company: COMPANY_NAME, status: 'active',  is_active: false, lease_end: '2026-12-31' },
    { email: RES_P_EMAIL, name: 'Pat P',   unit: '202', property: PROP_NAME, company: COMPANY_NAME, status: 'active',  is_active: true,  lease_end: '2026-12-31' },
  ])

  // Vehicles
  //   A: PLATE_A_OK  (active, is_active=true)
  //   B: PLATE_B_OLD (under_review, is_active=true) ← has pendingPlateChange with new=PLATE_B_NEW
  //   D: PLATE_D     (active, is_active=false — deactivated by RT-D cascade shape)
  //   P: PLATE_P_PEND(pending, is_active=true)   ← never approved
  //      PLATE_P_DECL(declined, is_active=false) ← declined
  const vIns = await admin.from('vehicles').insert([
    { plate: PLATE_A_OK,   resident_email: RES_A_EMAIL, unit: '101', property: PROP_NAME, status: 'active',       is_active: true,  state: 'TX' },
    { plate: PLATE_B_OLD,  resident_email: RES_B_EMAIL, unit: '101', property: PROP_NAME, status: 'under_review', is_active: true,  state: 'TX' },
    { plate: PLATE_D,      resident_email: RES_D_EMAIL, unit: '101', property: PROP_NAME, status: 'active',       is_active: false, state: 'TX' },
    { plate: PLATE_P_PEND, resident_email: RES_P_EMAIL, unit: '202', property: PROP_NAME, status: 'pending',      is_active: true,  state: 'TX' },
    { plate: PLATE_P_DECL, resident_email: RES_P_EMAIL, unit: '202', property: PROP_NAME, status: 'declined',     is_active: false, state: 'TX' },
  ]).select('id, plate')
  const bOldId = (vIns.data ?? []).find(v => v.plate === PLATE_B_OLD)!.id as number

  // Pending plate change on Res B's vehicle
  await admin.from('vehicle_plate_changes').insert({
    vehicle_id: bOldId,
    old_plate: PLATE_B_OLD,
    new_plate: PLATE_B_NEW,
    submitted_by: RES_B_EMAIL,
    property: PROP_NAME,
    status: 'pending',
  })

  // Spaces
  //   SHARED — tied to A + B + D (D is deactivated → auto-freed in prod
  //     via trigger, but for probe purposes we deliberately leave D's
  //     tie in place to prove the belt-and-suspenders filter fires)
  //   SOLO   — tied to P (whose only vehicles are pending/declined)
  const { data: sharedIns } = await admin.from('spaces').insert({
    label: 'SHARED', type: 'garage', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: null,  // multi-resident state
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id').single()
  const sharedId = sharedIns!.id as number

  const { data: soloIns } = await admin.from('spaces').insert({
    label: 'SOLO', type: 'covered', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: RES_P_EMAIL,
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id').single()
  const soloId = soloIns!.id as number

  await admin.from('space_residents').insert([
    { space_id: sharedId, resident_email: RES_A_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: sharedId, resident_email: RES_B_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: sharedId, resident_email: RES_D_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: soloId,   resident_email: RES_P_EMAIL.toLowerCase(), added_by_email: DISPOSABLE_MGR_EMAIL },
  ])
  console.log(`  ✓ SHARED space (A + B + D-deactivated) id=${sharedId}`)
  console.log(`  ✓ SOLO space (P only, pending/declined vehicles) id=${soloId}`)
  console.log(`  ✓ vehicle_plate_changes pending on B: old=${PLATE_B_OLD} new=${PLATE_B_NEW}\n`)

  // ── Fetch and run the builder ─────────────────────────────────────
  const { data: residents } = await admin.from('residents').select('id, name, email, unit, property, phone, status, is_active, lease_end, created_at, manager_note').ilike('email', `%${TAG}%`).order('id')
  const { data: vehicles } = await admin.from('vehicles').select('id, plate, resident_email, unit, property, status, is_active').ilike('property', `${TAG}%`)
  const { data: spaces } = await admin.from('spaces').select('id, label, type, status, is_active, assigned_to_resident_email, property').ilike('property', `${TAG}%`)
  const { data: ties } = await admin.from('space_residents').select('space_id, resident_email').in('space_id', [sharedId, soloId])
  const { data: plateChanges } = await admin.from('vehicle_plate_changes').select('id, vehicle_id, old_plate, new_plate, submitted_by, submitted_at, status').eq('property', PROP_NAME).eq('status', 'pending')

  const rows = buildCrmResidents({
    residents: residents ?? [], pendingResidents: [], vehicles: vehicles ?? [],
    spaces: spaces ?? [], spaceResidentTies: ties ?? [],
    guestAuths: [], spaceRequests: [],
    pendingPlateChanges: (plateChanges ?? []).map(pc => ({
      id: pc.id as number, vehicle_id: pc.vehicle_id as number,
      old_plate: pc.old_plate as string, new_plate: pc.new_plate as string,
      submitted_by: pc.submitted_by as string, submitted_at: pc.submitted_at as string,
    })),
  })

  // We inspect the SHARED space via Res A's row (any tied resident's row
  // renders the same authorizedPlates for that space).
  const aRow = rows.find(r => r.email.toLowerCase() === RES_A_EMAIL)!
  const pRow = rows.find(r => r.email.toLowerCase() === RES_P_EMAIL)!
  const sharedFromA = aRow.assignedSpaces.find(s => s.id === sharedId)!
  const soloFromP = pRow.assignedSpaces.find(s => s.id === soloId)!
  const sharedPlates = sharedFromA.authorizedPlates
  const soloPlates = soloFromP.authorizedPlates

  console.log(`SHARED authorizedPlates: ${JSON.stringify(sharedPlates.map(p => ({ plate: p.plate, owner: p.owner_name, urev: p.plateChangeUnderReview })))}`)
  console.log(`SOLO   authorizedPlates: ${JSON.stringify(soloPlates.map(p => ({ plate: p.plate, owner: p.owner_name, urev: p.plateChangeUnderReview })))}\n`)

  // ── [1] Roommate — both residents' plates listed w/ attribution ──
  console.log('─── [1] Roommate space — both plates listed ──────────────────')
  const aPlateOnShared = sharedPlates.find(p => p.plate === PLATE_A_OK)
  const bOldOnShared   = sharedPlates.find(p => p.plate === PLATE_B_OLD)
  const test1 = !!aPlateOnShared && aPlateOnShared.owner_name === 'Alice A' &&
                !!bOldOnShared && bOldOnShared.owner_name === 'Bob B'
  console.log(`  A's approved plate present + attributed: ${!!aPlateOnShared} owner=${aPlateOnShared?.owner_name}`)
  console.log(`  B's under-review OLD plate present + attributed: ${!!bOldOnShared} owner=${bOldOnShared?.owner_name}`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Under-review — OLD plate w/ marker; NEW plate absent ─────
  console.log('─── [2] Under-review OLD plate marker + NEW plate absent ─────')
  const bNewOnShared = sharedPlates.find(p => p.plate === PLATE_B_NEW)
  const test2 = !!bOldOnShared && bOldOnShared.plateChangeUnderReview === true && !bNewOnShared
  console.log(`  OLD plate (${PLATE_B_OLD}) plateChangeUnderReview: ${bOldOnShared?.plateChangeUnderReview} (expect true)`)
  console.log(`  NEW plate (${PLATE_B_NEW}) absent from SHARED: ${!bNewOnShared} (expect true)`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Deactivated resident — plates absent ─────────────────────
  console.log('─── [3] Deactivated resident D — plates DO NOT appear ────────')
  const dPlateOnShared = sharedPlates.find(p => p.plate === PLATE_D)
  const test3 = !dPlateOnShared
  console.log(`  D's plate (${PLATE_D}) absent from SHARED: ${!dPlateOnShared} (expect true — D is deactivated)`)
  console.log(`  [3] ${test3 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [4] Pending / declined vehicles absent ───────────────────────
  console.log('─── [4] Pending + declined vehicles — DO NOT appear ──────────')
  const pPendOnSolo = soloPlates.find(p => p.plate === PLATE_P_PEND)
  const pDeclOnSolo = soloPlates.find(p => p.plate === PLATE_P_DECL)
  const test4 = !pPendOnSolo && !pDeclOnSolo && soloPlates.length === 0
  console.log(`  Pending plate absent: ${!pPendOnSolo}, Declined plate absent: ${!pDeclOnSolo}`)
  console.log(`  SOLO plates count: ${soloPlates.length} (expect 0 — P has no enforce-valid plates)`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin)
  console.log('  ✓ cleaned up\n')

  const allPass = test1 && test2 && test3 && test4
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] roommate: ${test1 ? '🟢' : '🔴'}  [2] under-review OLD+marker: ${test2 ? '🟢' : '🔴'}  [3] deactivated resident excluded: ${test3 ? '🟢' : '🔴'}  [4] pending/declined excluded: ${test4 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
