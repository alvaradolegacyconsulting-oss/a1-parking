// ════════════════════════════════════════════════════════════════════
// GATE — duplicate plates refuse early and explain clearly
// ════════════════════════════════════════════════════════════════════
//
// A1 live, 2026-10-07: approving a pending plate that was already
// active raised 23505 on vehicles_plate_norm_uniq, PostgREST returned
// 409, and the manager's button hung on "Approving…" forever. 18 of 29
// pending rows at Green Acres were in that state.
//
// Proven here BY EXECUTION, with real sessions:
//   1. request_my_vehicle refuses an already-ACTIVE plate
//   2. …and an already-PENDING one, with a different message
//   3. …and still accepts a genuinely new plate (positive control — a
//      function that refuses everything passes 1 and 2)
//   4. approve_vehicle returns structured plate_already_active carrying
//      the existing unit, resident and same_resident
//   5. …and the same-resident flag flips correctly for a cross-resident
//      collision
//   6. deactivate_vehicle actually deactivates a PENDING row (PART 4 —
//      the old is_active=false shortcut made Clear-duplicate a no-op)
//   7. a clean approve still works end to end (positive control)
//
// Pure-logic checks (no DB) cover the badge matcher and the manager
// wording, including the unit-format case that misclassified a
// re-submission as a cross-resident dispute.
//
// Sessions come from generateLink -> verifyOtp: signInWithPassword is
// captcha-gated.
//
// Usage: npx tsx scripts/verify-duplicate-plate.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { normalizePlate, normalizeUnit } from '../app/lib/plate'
import { findPlateDuplicates, plateClashMessage, isPlateClash } from '../app/lib/pm-crm'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
const UNIT = `ZZDUP-${STAMP}`
const P_ACTIVE = `ZZD${String(STAMP).slice(-6)}`
const P_NEW = `ZZN${String(STAMP).slice(-6)}`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const created: { email: string; uid: string }[] = []

async function actor(tag: string, role: 'resident' | 'manager', unit = UNIT) {
  const email = `zz-dup-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  created.push({ email, uid: data.user.id })
  const { error: rErr } = await db.from('user_roles').insert({
    email, role, company: COMPANY, property: [PROPERTY], is_active: true,
    ...(role === 'manager' ? { can_approve_vehicles: true } : {}),
  })
  if (rErr) throw new Error(`user_roles ${tag}: ${rErr.message}`)
  if (role === 'resident') {
    const { error: resErr } = await db.from('residents').insert({
      email, name: `ZZ Dup ${tag}`, property: PROPERTY, unit, company: COMPANY, is_active: true, status: 'active',
    })
    if (resErr) throw new Error(`residents ${tag}: ${resErr.message}`)
  }
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

async function veh(email: string, plate: string, status: string, unit = UNIT) {
  const { data, error } = await db.from('vehicles').insert({
    plate, state: 'TX', property: PROPERTY, unit, company: COMPANY,
    resident_email: email, status, is_active: status === 'active',
  }).select('id').single()
  if (error) throw new Error(`vehicles ${plate}: ${error.message}`)
  return data.id as number
}

const main = async () => {
  // ── Pure logic first: no DB, no fixtures, always runnable ─────────
  console.log('── pure logic ──')
  const rows = [
    { id: 1, plate: 'AAA111', property: 'P', unit: 'Traila #191', resident_email: 'a@x.com', status: 'active', is_active: true },
    { id: 2, plate: 'aaa 111', property: 'p', unit: 'Traila# 191', resident_email: 'A@X.com', status: 'pending', is_active: false },
    { id: 3, plate: 'BBB222', property: 'P', unit: '7', resident_email: 'b@x.com', status: 'pending', is_active: false },
  ]
  const dupes = findPlateDuplicates(rows, normalizePlate, normalizeUnit)
  chk('badge: matches across case + spacing + property case', dupes.has('2'))
  // 🔴 The case that misclassified a re-submission as a dispute.
  chk('badge: "Traila# 191" == "Traila #191" → sameResident', dupes.get('2')?.sameResident === true,
    JSON.stringify(dupes.get('2')))
  chk('badge: a non-colliding pending plate is NOT flagged', !dupes.has('3'))

  const same = plateClashMessage({ error: 'plate_already_active', same_resident: true, existing_unit: '12', plate: 'AAA111' })
  chk('copy: same resident offers the clear', same.offerClear && /already approved for this resident at Unit 12/.test(same.text), same.text)
  const cross = plateClashMessage({ error: 'plate_already_active', same_resident: false, existing_unit: '81', existing_resident_email: 'n@x.com', plate: 'AAA111' })
  chk('copy: different household offers NO clear and says what to do',
    !cross.offerClear && /deactivate that record first/.test(cross.text), cross.text)
  chk('isPlateClash rejects an unrelated error', !isPlateClash({ error: 'vehicle_not_found' }))

  // ── Pre-flight ────────────────────────────────────────────────────
  // 🔴 This gate cannot exit 2 for "migration not applied", because
  // approve_vehicle and request_my_vehicle both EXIST before it — only
  // their bodies change. So an unapplied migration shows up as a red
  // run, and the failure text below says which shape that is. A red run
  // with "duplicate key value violates unique constraint" IS the
  // unfixed production bug, reproduced.
  const probe = await db.from('vehicles').select('id').limit(1)
  if (probe.error) { console.error('db unreachable'); process.exit(2) }
  const srcProbe = await db.rpc('approve_vehicle', { p_vehicle_id: -1, p_manager_note: null })
  if (srcProbe.error && /Could not find the function/i.test(srcProbe.error.message)) {
    console.error('approve_vehicle missing — apply migrations/20261007_duplicate_plate_handling.sql first'); process.exit(2)
  }

  console.log('\n── execution ──')
  let A: Awaited<ReturnType<typeof actor>> | null = null
  let B: Awaited<ReturnType<typeof actor>> | null = null
  let M: Awaited<ReturnType<typeof actor>> | null = null
  try {
    A = await actor('a', 'resident')
    B = await actor('b', 'resident', `${UNIT}-OTHER`)
    M = await actor('m', 'manager')
    const vActive = await veh(A.email, P_ACTIVE, 'active')

    // 1 + 2 — refuse at the source
    const r1 = await A.client.rpc('request_my_vehicle', { p_plate: P_ACTIVE, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('request_my_vehicle refuses an already-ACTIVE plate',
      !!r1.error && /vehicle_already_registered/.test(r1.error.message), r1.error?.message ?? 'NO ERROR')

    const vPend = await veh(A.email, P_NEW, 'pending')
    const r2 = await A.client.rpc('request_my_vehicle', { p_plate: P_NEW, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('request_my_vehicle refuses an already-PENDING plate',
      !!r2.error && /vehicle_already_pending/.test(r2.error.message), r2.error?.message ?? 'NO ERROR')

    // 3 — positive control
    const r3 = await A.client.rpc('request_my_vehicle', { p_plate: `ZZF${String(STAMP).slice(-6)}`, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('request_my_vehicle STILL ACCEPTS a new plate', !r3.error && typeof r3.data === 'number',
      r3.error?.message ?? `id ${r3.data}`)

    // 4 — structured clash, same resident
    const vDupSame = await veh(A.email, `${P_ACTIVE} `, 'pending')   // same plate, trailing space
    const r4 = await M.client.rpc('approve_vehicle', { p_vehicle_id: vDupSame, p_manager_note: null })
    const d4 = r4.data as Record<string, unknown>
    chk('approve_vehicle returns plate_already_active (not a raw 409)',
      !r4.error && d4?.error === 'plate_already_active', r4.error?.message ?? JSON.stringify(d4))
    chk('…carrying the existing unit and resident',
      d4?.existing_vehicle_id === vActive && !!d4?.existing_unit && d4?.existing_resident_email === A.email,
      JSON.stringify({ id: d4?.existing_vehicle_id, unit: d4?.existing_unit, who: d4?.existing_resident_email }))
    chk('…with same_resident = true', d4?.same_resident === true, String(d4?.same_resident))

    // 5 — cross-resident flips the flag
    const vDupCross = await veh(B.email, P_ACTIVE, 'pending', `${UNIT}-OTHER`)
    const r5 = await M.client.rpc('approve_vehicle', { p_vehicle_id: vDupCross, p_manager_note: null })
    const d5 = r5.data as Record<string, unknown>
    chk('cross-resident collision reports same_resident = false',
      d5?.error === 'plate_already_active' && d5?.same_resident === false, JSON.stringify(d5))

    // 6 — PART 4: a PENDING row is deactivatable
    const r6 = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vDupSame, p_reason: 'registered_in_error', p_note: null })
    const d6 = r6.data as Record<string, unknown>
    chk('deactivate_vehicle DEACTIVATES a pending row (was a silent no-op)',
      d6?.ok === true && d6?.action === 'deactivated', JSON.stringify(d6?.action ?? r6.error?.message))
    const after6 = await db.from('vehicles').select('status, is_active, deactivation_reason').eq('id', vDupSame).single()
    chk('…and stamps the reason', after6.data?.status === 'deactivated' && after6.data?.deactivation_reason === 'registered_in_error',
      JSON.stringify(after6.data))
    // idempotency must survive
    const r6b = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vDupSame, p_reason: 'registered_in_error', p_note: null })
    chk('…and a second call still short-circuits', (r6b.data as Record<string, unknown>)?.action === 'already_deactivated',
      JSON.stringify((r6b.data as Record<string, unknown>)?.action))

    // 6c — 🔴 THE DECLINED-ROW PROTECTION.
    // The first draft of PART 4 short-circuited only on
    // status='deactivated', which would have let a manager overwrite a
    // DECLINED row (55 live). That is destructive: the resident portal
    // fetches `is_active = true OR status = 'declined'`, so rewriting a
    // decline to 'deactivated' erases it from the resident's view along
    // with the manager's note. The allowlist prevents it, and nothing
    // else proves the allowlist is doing that job.
    const vDeclined = await veh(A.email, `ZZX${String(STAMP).slice(-6)}`, 'declined')
    const r6c = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vDeclined, p_reason: 'vehicle_sold', p_note: null })
    chk('a DECLINED row is NOT overwritten by deactivate_vehicle',
      (r6c.data as Record<string, unknown>)?.action === 'already_deactivated',
      JSON.stringify((r6c.data as Record<string, unknown>)?.action ?? r6c.error?.message))
    const after6c = await db.from('vehicles').select('status, deactivation_reason').eq('id', vDeclined).single()
    chk('…and its status is still declined, reason still unstamped',
      after6c.data?.status === 'declined' && after6c.data?.deactivation_reason === null,
      JSON.stringify(after6c.data))

    // 7 — a clean approve still works (positive control on PART 2)
    const r7 = await M.client.rpc('approve_vehicle', { p_vehicle_id: vPend, p_manager_note: null })
    const d7 = r7.data as Record<string, unknown>
    chk('a NON-duplicate approve still succeeds', d7?.ok === true && d7?.action === 'approved',
      JSON.stringify(d7?.action ?? r7.error?.message))
  } finally {
    await db.from('vehicles').delete().eq('property', PROPERTY).ilike('unit', `${UNIT}%`)
    await db.from('residents').delete().eq('property', PROPERTY).ilike('unit', `${UNIT}%`)
    for (const c of created) {
      await db.from('user_roles').delete().ilike('email', c.email)
      await db.auth.admin.deleteUser(c.uid).catch(() => {})
    }
    // Sweep orphans from any earlier aborted run of THIS gate only.
    const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
    for (const o of (orph?.users ?? []).filter(u => /^zz-dup-[abm]-\d+@test\.invalid$/.test(u.email ?? ''))) {
      await db.from('user_roles').delete().ilike('email', o.email!)
      await db.auth.admin.deleteUser(o.id).catch(() => {})
      console.log(`  swept orphan: ${o.email}`)
    }
  }

  const leftV = (await db.from('vehicles').select('*', { count: 'exact', head: true }).ilike('unit', `${UNIT}%`)).count
  chk('fixture cleaned up', leftV === 0, `${leftV} vehicles left`)

  console.log('')
  if (fails) {
    console.log(`❌ ${fails} FAILURE(S).`)
    console.log('If the failures are "NO ERROR" on the two refusals plus a raw')
    console.log('"duplicate key value violates unique constraint" on approve, the')
    console.log('migration has not been applied — that output is the live bug.')
    process.exit(1)
  }
  console.log('✅ Duplicates are refused at submission and explained at approval.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
