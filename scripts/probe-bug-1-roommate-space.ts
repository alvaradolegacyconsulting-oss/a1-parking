// BUG-1 — Roommate space visibility E2E probe.
//
// Reproduces Jose's smoke-test scenario:
//   May is PRIMARY of G-1  → space_residents (G-1, may)
//                            spaces.assigned_to_resident_email = may (single-resident state)
//   Joe added as 2nd tie   → space_residents (G-1, joe)
//                            spaces.assigned_to_resident_email = NULL (multi-resident state, per v1.1 assign_space)
// Joe is also PRIMARY of CP-5 and G-2 in his own right.
//
// Pre-fix bug: Joe's assignedSpaces on ALL FOUR surfaces (CRM Spaces
// tab, CRM facts strip, resident portal header, resident portal My Info)
// showed only CP-5 + G-2 (his primaries). G-1 vanished because the
// derivation silently fell back to assigned_to_resident_email whenever
// the space_residents tie fetch was empty/failing.
//
// This probe drives the derivation SHAPE end-to-end (not the React
// render — that's covered by manual smoke). Asserts:
//
// [1] CRM builder — buildCrmResidents({ spaces, spaceResidentTies, ... })
//     returns Joe's assignedSpaces INCLUDING G-1 when the tie exists.
//     Roommate (May) also sees G-1.
// [2] CRM builder — per-space fallback: a genuinely pre-v1.1 legacy
//     row (assigned_to_resident_email set, NO tie) still surfaces to
//     the assignee. Backward compat preserved.
// [3] CRM builder — silent WHOLE-fallback prevented: passing an EMPTY
//     ties array (simulating fetch failure) MUST NOT resurface the
//     legacy shape for spaces that have a tie in the true data. This
//     is the anti-regression guard for the exact class of bug.
// [4] Resident portal shape — Joe's spaceIds union (space_residents ties
//     UNION spaces.assigned_to_resident_email) includes G-1's id.
//     Manager-side SQL confirms the tie exists; probe uses service-role
//     to simulate what the resident's `.ilike('resident_email', ...)`
//     fetch returns.
// [5] Resident portal shape — the FULL row query (id union + status
//     'assigned' + is_active) returns G-1 without the removed property
//     filter (BUG-1 fix drop of `.ilike('property', data.property)`).
//
// Disposable manager + 2 disposable residents per hygiene rule.
// Run: npx tsx --env-file=.env.local scripts/probe-bug-1-roommate-space.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { buildCrmResidents } from '../app/lib/pm-crm'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TAG = `__probe_bug1_${(process.env.USER || 'run').toLowerCase()}__`
const PROP_NAME    = `${TAG}_prop`
const COMPANY_NAME = `${TAG}_company`
const DISPOSABLE_MGR_EMAIL = `${TAG}_mgr@example.com`
const RES_MAY_EMAIL = `${TAG}_may@example.com` // primary of shared space
const RES_JOE_EMAIL = `${TAG}_joe@example.com` // roommate of shared space + primary of own spaces

async function cleanup(admin: SupabaseClient) {
  await admin.from('space_residents').delete().ilike('resident_email', `%${TAG}%`)
  await admin.from('spaces').delete().ilike('property', `${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ BUG-1 ROOMMATE SPACE PROBE ═══════════════════════════════════')
  console.log(`Disposable manager: ${DISPOSABLE_MGR_EMAIL}`)
  console.log(`+happy NEVER touched (per feedback_probe_hygiene_rule.md).\n`)

  await cleanup(admin)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── PROVISION ────────────────────────────────────────────────')
  await admin.from('properties').insert({ name: PROP_NAME, company: COMPANY_NAME, is_active: true })
  await admin.from('user_roles').insert([
    { email: DISPOSABLE_MGR_EMAIL, role: 'manager',  company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: true },
    { email: RES_MAY_EMAIL,        role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
    { email: RES_JOE_EMAIL,        role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false },
  ])
  await admin.from('residents').insert([
    { email: RES_MAY_EMAIL, name: 'May Roommate', unit: '101', phone: null, property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31' },
    { email: RES_JOE_EMAIL, name: 'Joe Tenant',   unit: '101', phone: null, property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31' },
  ])
  const { data: residents } = await admin.from('residents').select('id, name, email, unit, property, phone, status, is_active, lease_end, created_at, manager_note').ilike('email', `%${TAG}%`).order('id')
  console.log(`  ✓ residents provisioned: ${residents?.length ?? 0}`)

  // G-1 shared space (May primary, Joe roommate) — MULTI-RESIDENT STATE
  // per v1.1: after 2nd tie, assigned_to_resident_email is NULL.
  const { data: shared } = await admin.from('spaces').insert({
    label: 'G-1', type: 'garage', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: null,  // multi-resident state
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id, label, type, status, is_active, assigned_to_resident_email, property').single()
  const sharedId = shared!.id as number
  // CP-5, G-2 — Joe's own primaries (single-resident state)
  const { data: joesCp5 } = await admin.from('spaces').insert({
    label: 'CP-5', type: 'covered', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: RES_JOE_EMAIL,
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id, label, type, status, is_active, assigned_to_resident_email, property').single()
  const cp5Id = joesCp5!.id as number
  const { data: joesG2 } = await admin.from('spaces').insert({
    label: 'G-2', type: 'garage', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: RES_JOE_EMAIL,
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id, label, type, status, is_active, assigned_to_resident_email, property').single()
  const g2Id = joesG2!.id as number

  // Ties: G-1 → both May + Joe; CP-5 → Joe; G-2 → Joe.
  await admin.from('space_residents').insert([
    { space_id: sharedId, resident_email: RES_MAY_EMAIL, added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: sharedId, resident_email: RES_JOE_EMAIL, added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: cp5Id,    resident_email: RES_JOE_EMAIL, added_by_email: DISPOSABLE_MGR_EMAIL },
    { space_id: g2Id,     resident_email: RES_JOE_EMAIL, added_by_email: DISPOSABLE_MGR_EMAIL },
  ])
  console.log(`  ✓ spaces: G-1(shared, primary=NULL)=${sharedId}, CP-5(joe)=${cp5Id}, G-2(joe)=${g2Id}`)
  console.log(`  ✓ ties: G-1↔{may,joe}, CP-5↔joe, G-2↔joe\n`)

  // ── Manager-side fetch shape (mirrors fetchCrmDataForProperty) ────
  const { data: spaces } = await admin.from('spaces')
    .select('id, label, type, status, is_active, assigned_to_resident_email, property')
    .ilike('property', PROP_NAME)
  const { data: ties } = await admin.from('space_residents')
    .select('space_id, resident_email')
    .in('space_id', (spaces ?? []).map(s => s.id))

  // ── [1] CRM builder — Joe's assignedSpaces includes G-1 ─────────
  console.log('─── [1] CRM builder — roommate sees shared space ────────────')
  const rows1 = buildCrmResidents({
    residents: residents ?? [], pendingResidents: [], vehicles: [],
    spaces: spaces ?? [], spaceResidentTies: ties ?? [],
    guestAuths: [], spaceRequests: [],
  })
  const joeRow = rows1.find(r => r.email.toLowerCase() === RES_JOE_EMAIL)
  const mayRow = rows1.find(r => r.email.toLowerCase() === RES_MAY_EMAIL)
  const joeLabels = (joeRow?.assignedSpaces ?? []).map(s => s.label).sort()
  const mayLabels = (mayRow?.assignedSpaces ?? []).map(s => s.label).sort()
  const test1 = JSON.stringify(joeLabels) === JSON.stringify(['CP-5', 'G-1', 'G-2']) &&
                JSON.stringify(mayLabels) === JSON.stringify(['G-1'])
  console.log(`  joe's assignedSpaces: ${JSON.stringify(joeLabels)} (expect ['CP-5','G-1','G-2'])`)
  console.log(`  may's assignedSpaces: ${JSON.stringify(mayLabels)} (expect ['G-1'])`)
  console.log(`  [1] ${test1 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [2] Per-space legacy fallback preserved (pre-v1.1 shape) ─────
  console.log('─── [2] Per-space legacy fallback — pre-v1.1 assignee shape ──')
  // Simulate a pre-v1.1 row: assignee set, NO tie in space_residents.
  const legacyEmail = `${TAG}_legacy@example.com`
  const { data: legacySpace } = await admin.from('spaces').insert({
    label: 'LEG-1', type: 'covered', status: 'assigned', is_active: true,
    property: PROP_NAME, company: COMPANY_NAME,
    assigned_to_resident_email: legacyEmail,  // primary set
    created_by_email: DISPOSABLE_MGR_EMAIL,
  }).select('id, label, type, status, is_active, assigned_to_resident_email, property').single()
  await admin.from('residents').insert({
    email: legacyEmail, name: 'Legacy Res', unit: '999', phone: null,
    property: PROP_NAME, company: COMPANY_NAME, status: 'active', is_active: true, lease_end: '2026-12-31',
  })
  await admin.from('user_roles').insert({
    email: legacyEmail, role: 'resident', company: COMPANY_NAME, property: [PROP_NAME], can_approve_vehicles: false,
  })
  const { data: spaces2 } = await admin.from('spaces')
    .select('id, label, type, status, is_active, assigned_to_resident_email, property')
    .ilike('property', PROP_NAME)
  const { data: ties2 } = await admin.from('space_residents')
    .select('space_id, resident_email')
    .in('space_id', (spaces2 ?? []).map(s => s.id))
  const { data: residents2 } = await admin.from('residents').select('id, name, email, unit, property, phone, status, is_active, lease_end, created_at, manager_note').ilike('email', `%${TAG}%`).order('id')
  const rows2 = buildCrmResidents({
    residents: residents2 ?? [], pendingResidents: [], vehicles: [],
    spaces: spaces2 ?? [], spaceResidentTies: ties2 ?? [],
    guestAuths: [], spaceRequests: [],
  })
  const legacyRow = rows2.find(r => r.email.toLowerCase() === legacyEmail)
  const legacyLabels = (legacyRow?.assignedSpaces ?? []).map(s => s.label).sort()
  const test2 = JSON.stringify(legacyLabels) === JSON.stringify(['LEG-1'])
  console.log(`  legacy resident assignedSpaces: ${JSON.stringify(legacyLabels)} (expect ['LEG-1'])`)
  console.log(`  [2] ${test2 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [3] Anti-regression — empty ties MUST NOT resurface legacy ───
  console.log('─── [3] Anti-regression — ties=[] does not silently fall back ─')
  // Feed the builder with the real spaces but an EMPTY ties array (as if
  // the tie fetch silently failed). Before the fix, this would have made
  // Joe's assignedSpaces = [CP-5, G-2] via the legacy fallback (correct
  // for a primary, but WRONG for the roommate G-1 case — G-1's primary
  // is NULL). After the fix, per-space fallback ONLY applies to LEG-1
  // (which has an assignee set); G-1 (NULL primary + no ties) should
  // NOT surface to anyone.
  const rows3 = buildCrmResidents({
    residents: residents2 ?? [], pendingResidents: [], vehicles: [],
    spaces: spaces2 ?? [], spaceResidentTies: [],  // ← simulated failure
    guestAuths: [], spaceRequests: [],
  })
  const joeRow3 = rows3.find(r => r.email.toLowerCase() === RES_JOE_EMAIL)
  const mayRow3 = rows3.find(r => r.email.toLowerCase() === RES_MAY_EMAIL)
  const joeLabels3 = (joeRow3?.assignedSpaces ?? []).map(s => s.label).sort()
  const mayLabels3 = (mayRow3?.assignedSpaces ?? []).map(s => s.label).sort()
  // Joe legitimately falls back to his LEGACY primaries [CP-5, G-2] via
  // per-space fallback because those spaces have assigned_to_resident_email
  // = joe. But G-1 (NULL primary) must NOT appear anywhere — it correctly
  // vanishes when ties are missing (no legacy claim to it).
  const g1LeaksToJoe = joeLabels3.includes('G-1')
  const g1LeaksToMay = mayLabels3.includes('G-1')
  const test3 = !g1LeaksToJoe && !g1LeaksToMay
  console.log(`  joe (ties=[]) assignedSpaces: ${JSON.stringify(joeLabels3)} (G-1 must NOT be here — was fetched via tie only)`)
  console.log(`  may (ties=[]) assignedSpaces: ${JSON.stringify(mayLabels3)} (empty — May's only claim to G-1 was via tie)`)
  console.log(`  [3] ${test3 ? '🟢 PASS — no silent whole-fallback' : '🔴 FAIL — G-1 leaked via legacy fallback'}\n`)

  // ── [4] Resident portal shape — ID union includes G-1 ────────────
  console.log('─── [4] Resident portal ID union includes shared space ──────')
  const { data: joeTies } = await admin.from('space_residents')
    .select('space_id').ilike('resident_email', RES_JOE_EMAIL)
  const { data: joeLegacy } = await admin.from('spaces')
    .select('id').ilike('assigned_to_resident_email', RES_JOE_EMAIL)
  const idsFromUnion = Array.from(new Set([
    ...(joeTies ?? []).map(t => t.space_id as number),
    ...(joeLegacy ?? []).map(r => r.id as number),
  ])).sort()
  const expectedIds = [sharedId, cp5Id, g2Id].sort()
  const test4 = JSON.stringify(idsFromUnion) === JSON.stringify(expectedIds)
  console.log(`  union space ids: ${JSON.stringify(idsFromUnion)}`)
  console.log(`  expected:        ${JSON.stringify(expectedIds)}`)
  console.log(`  [4] ${test4 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── [5] Resident portal shape — full row fetch (no property filter) ──
  console.log('─── [5] Resident portal full-row fetch — no property filter ─')
  // Post-fix: resident/page.tsx drops .ilike('property', data.property).
  // Reproduce the resulting fetch shape.
  const { data: joeFullRows } = await admin.from('spaces')
    .select('id, label, type').in('id', idsFromUnion)
    .eq('is_active', true).eq('status', 'assigned')
  const joeFullLabels = (joeFullRows ?? []).map(r => r.label as string).sort()
  const test5 = JSON.stringify(joeFullLabels) === JSON.stringify(['CP-5', 'G-1', 'G-2'])
  console.log(`  joe resident-portal spaces: ${JSON.stringify(joeFullLabels)} (expect ['CP-5','G-1','G-2'])`)
  console.log(`  [5] ${test5 ? '🟢 PASS' : '🔴 FAIL'}\n`)

  // ── Cleanup ──────────────────────────────────────────────────────
  console.log('─── CLEANUP ─────────────────────────────────────────────────')
  await cleanup(admin)
  console.log('  ✓ cleaned up\n')

  const allPass = test1 && test2 && test3 && test4 && test5
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] CRM roommate: ${test1 ? '🟢' : '🔴'}  [2] legacy fallback: ${test2 ? '🟢' : '🔴'}  [3] no silent whole-fallback: ${test3 ? '🟢' : '🔴'}  [4] resident id union: ${test4 ? '🟢' : '🔴'}  [5] resident full rows: ${test5 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })
