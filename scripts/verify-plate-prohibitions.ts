// ════════════════════════════════════════════════════════════════════
// GATE — plate prohibitions
// ════════════════════════════════════════════════════════════════════
//
// Thirteen paths create a plate authorization and only eight are RPCs,
// so the refusal is a BEFORE trigger. This proves the trigger actually
// fires on the paths that bypass every RPC — the service-role bulk
// import and the manager's direct insert — because those are precisely
// the ones a per-RPC check would have missed.
//
// 🔴 AND IT TESTS AS A RESIDENT, NOT ONLY AS A MANAGER.
// plate_prohibition_at() is SECURITY DEFINER for one reason: the
// trigger runs as the inserting user, and residents have no SELECT
// policy on property_plate_prohibitions. A non-DEFINER version returns
// zero rows to exactly the callers this blocks — the feature would be
// inert for residents and visitors while working perfectly for
// managers. A manager-only gate would certify that.
//
// Usage: npx tsx scripts/verify-plate-prohibitions.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { isPlateProhibitedError, plateProhibitedCopy, PLATE_PROHIBITED_TOKEN } from '../app/lib/plate-prohibition-copy'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
const UNIT = `ZZPP-${STAMP}`
const BAD  = `ZZB${String(STAMP).slice(-6)}`   // to be prohibited
const OK   = `ZZG${String(STAMP).slice(-6)}`   // positive control
const EXP  = `ZZX${String(STAMP).slice(-6)}`   // expired prohibition
const SECRET_REASON = `INTERNAL-${STAMP}-trespass-notice`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []
type R = Record<string, unknown>

async function actor(tag: string, role: string, withResident = false) {
  const email = `zz-pp-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({
    email, role, company: COMPANY, property: [PROPERTY], is_active: true,
    ...(role === 'manager' ? { can_approve_vehicles: true } : {}),
  })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  if (withResident) {
    const rr = await db.from('residents').insert({
      email, name: `ZZ PP ${tag}`, property: PROPERTY, unit: UNIT, company: COMPANY, is_active: true, status: 'active',
    })
    if (rr.error) throw new Error(`residents ${tag}: ${rr.error.message}`)
  }
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  // ══ PURE: the copy rules ══
  console.log('── copy rules (pure) ──')
  const res = plateProhibitedCopy('resident', BAD)
  const vis = plateProhibitedCopy('visitor', BAD)
  const mgr = plateProhibitedCopy('manager', BAD)
  const forbidden = /prohibit|banned|ban\b/i
  chk('resident copy says neither "prohibited" nor "banned"', !forbidden.test(res), res)
  chk('visitor copy says neither "prohibited" nor "banned"', !forbidden.test(vis), vis)
  chk('resident copy points at the office', /contact the property office/i.test(res))
  chk('visitor copy points at the office', /contact the property office/i.test(vis))
  chk('manager copy IS explicit', /not permitted/i.test(mgr) && /prohibition/i.test(mgr), mgr)
  chk('the raw token never appears in any audience copy',
    ![res, vis, mgr].some(c => c.includes(PLATE_PROHIBITED_TOKEN)))
  chk('isPlateProhibitedError matches the token', isPlateProhibitedError({ message: `x ${PLATE_PROHIBITED_TOKEN} y` }))
  chk('…and rejects an unrelated error', !isPlateProhibitedError({ message: 'account_deactivated' }))

  // ══ Pre-flight ══
  const probe = await db.rpc('add_plate_prohibition', { p_property: PROPERTY, p_plate: 'ZZPROBE', p_reason: 'probe' })
  if (probe.error && /Could not find the function/i.test(probe.error.message)) {
    console.error('\nadd_plate_prohibition does not exist — apply the three')
    console.error('  migrations/20261011_plate_prohibitions_part{1,2,3}_*.sql  first.')
    process.exit(2)
  }

  console.log('\n── enforcement (execution) ──')
  let MGR: Awaited<ReturnType<typeof actor>> | null = null
  let RES: Awaited<ReturnType<typeof actor>> | null = null
  let propId = 0
  try {
    propId = (await db.from('properties').select('id').eq('name', PROPERTY).single()).data!.id as number
    MGR = await actor('mgr', 'manager')
    RES = await actor('res', 'resident', true)

    // Pre-existing live grants, so the revocation has something to revoke.
    const vehId = (await db.from('vehicles').insert({
      plate: BAD, state: 'TX', property: PROPERTY, unit: UNIT, company: COMPANY,
      resident_email: RES.email, status: 'active', is_active: true,
    }).select('id').single()).data!.id as number
    const passId = (await db.from('visitor_passes').insert({
      plate: BAD, visitor_name: 'ZZ', visiting_unit: UNIT, property: PROPERTY,
      vehicle_desc: 'x', duration_hours: 24, is_active: true,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    }).select('id').single()).data!.id as number

    // ── preview, then apply — counts must agree ──
    const pv = (await MGR.client.rpc('preview_plate_prohibition_impact', { p_property: PROPERTY, p_plate: BAD })).data as R
    chk('preview is authorized for a manager at the property', pv?.ok === true, JSON.stringify(pv))
    const add = (await MGR.client.rpc('add_plate_prohibition', {
      p_property: PROPERTY, p_plate: BAD, p_reason: SECRET_REASON, p_note: 'gate',
    })).data as R
    chk('manager can add a prohibition', add?.ok === true && add?.action === 'prohibited', JSON.stringify(add?.action))
    const rev = add?.revoked as R
    chk('🔴 confirm counts match what was ACTUALLY revoked',
      Number(pv?.vehicles) === Number(rev?.vehicles) && Number(pv?.visitor_passes) === Number(rev?.visitor_passes),
      `preview v=${pv?.vehicles} p=${pv?.visitor_passes} / actual v=${rev?.vehicles} p=${rev?.visitor_passes}`)
    const v1 = (await db.from('vehicles').select('is_active,status,deactivation_reason').eq('id', vehId).single()).data
    chk('…and the vehicle really is deactivated with reason plate_prohibited',
      v1?.is_active === false && v1?.deactivation_reason === 'plate_prohibited', JSON.stringify(v1))
    const p1 = (await db.from('visitor_passes').select('is_active').eq('id', passId).single()).data
    chk('…and the live pass really is revoked', p1?.is_active === false, JSON.stringify(p1))

    // ── every path refused ──
    const r1 = await RES.client.rpc('request_my_vehicle', { p_plate: BAD, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('PATH request_my_vehicle refused', isPlateProhibitedError(r1.error), r1.error?.message ?? 'NO ERROR')
    chk('🔴 …and the error does NOT contain the reason', !(r1.error?.message ?? '').includes(SECRET_REASON))

    const r2 = await RES.client.rpc('issue_visitor_pass', { p_plate: BAD, p_visitor_name: 'z', p_visiting_unit: UNIT, p_property: PROPERTY, p_vehicle_desc: 'x', p_duration_hours: 4 })
    chk('PATH issue_visitor_pass (resident) refused', isPlateProhibitedError(r2.error), r2.error?.message ?? 'NO ERROR')

    const r3 = await db.rpc('issue_visitor_pass', { p_plate: BAD, p_visitor_name: 'z', p_visiting_unit: UNIT, p_property: PROPERTY, p_vehicle_desc: 'x', p_duration_hours: 4 })
    chk('PATH issue_visitor_pass (service_role = /visitor route) refused', isPlateProhibitedError(r3.error), r3.error?.message ?? 'NO ERROR')

    // 🔴 The service-role DIRECT INSERT — the bulk-invite path. This is
    // the one no RPC check could ever have covered.
    const r4 = await db.from('vehicles').insert({
      plate: BAD, state: 'TX', property: PROPERTY, unit: UNIT, company: COMPANY,
      resident_email: RES.email, status: 'pending', is_active: false,
    })
    chk('PATH direct insert, service_role (bulk invite) refused', isPlateProhibitedError(r4.error), r4.error?.message ?? 'NO ERROR')

    const r5 = await db.from('guest_authorizations').insert({
      company: COMPANY, property: PROPERTY, plate: BAD, guest_name: 'z', visiting_unit: UNIT,
      start_date: new Date().toISOString().slice(0, 10), end_date: new Date(Date.now() + 864e5).toISOString().slice(0, 10),
      status: 'active', is_active: true, created_by_email: MGR.email,
    })
    chk('PATH guest_authorizations insert refused', isPlateProhibitedError(r5.error), r5.error?.message ?? 'NO ERROR')

    // The UPDATE arm: a pending row whose plate is prohibited later.
    const pend = (await db.from('vehicles').insert({
      plate: OK, state: 'TX', property: PROPERTY, unit: UNIT, company: COMPANY,
      resident_email: RES.email, status: 'pending', is_active: false,
    }).select('id').single()).data!.id as number
    await MGR.client.rpc('add_plate_prohibition', { p_property: PROPERTY, p_plate: OK, p_reason: SECRET_REASON })
    const r6 = await MGR.client.rpc('approve_vehicle', { p_vehicle_id: pend, p_manager_note: null })
    chk('🔴 PATH approve_vehicle refused when the plate was prohibited AFTER submission',
      isPlateProhibitedError(r6.error) || isPlateProhibitedError((r6.data as R)?.error),
      r6.error?.message ?? JSON.stringify(r6.data))

    // ── positive controls ──
    const good = `ZZP${String(STAMP).slice(-6)}`
    const r7 = await RES.client.rpc('request_my_vehicle', { p_plate: good, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('CONTROL a non-prohibited plate still registers', !r7.error && typeof r7.data === 'number', r7.error?.message ?? `id ${r7.data}`)

    // Expired prohibition must not block.
    await db.from('property_plate_prohibitions').insert({
      property_id: propId, plate: EXP, reason: SECRET_REASON, added_by: MGR.email,
      added_at: new Date(Date.now() - 2 * 864e5).toISOString(),
      expires_at: new Date(Date.now() - 864e5).toISOString(),
    })
    const r8 = await db.from('vehicles').insert({
      plate: EXP, state: 'TX', property: PROPERTY, unit: UNIT, company: COMPANY,
      resident_email: RES.email, status: 'pending', is_active: false,
    }).select('id').single()
    chk('CONTROL an EXPIRED prohibition no longer blocks', !r8.error, r8.error?.message ?? `id ${r8.data?.id}`)

    // ── removal ──
    const pid = Number(add?.prohibition_id)
    const rm1 = (await MGR.client.rpc('remove_plate_prohibition', { p_id: pid, p_reason: '' })).data as R
    chk('🔴 removal WITHOUT a reason is refused', rm1?.error === 'removal_reason_required', JSON.stringify(rm1))
    const rm2 = await db.from('property_plate_prohibitions').update({ removed_at: new Date().toISOString(), removed_by: MGR.email }).eq('id', pid)
    chk('…and a direct UPDATE without a reason is refused by the CHECK too',
      !!rm2.error && /ppp_removal_is_complete/.test(rm2.error.message), rm2.error?.message?.slice(0, 80) ?? 'NO ERROR')

    const rm3 = (await MGR.client.rpc('remove_plate_prohibition', { p_id: pid, p_reason: 'resolved with the resident', p_note: 'gate' })).data as R
    chk('removal WITH a reason succeeds', rm3?.ok === true && rm3?.action === 'removed', JSON.stringify(rm3?.action))
    chk('…and says nothing was restored', rm3?.restored_nothing === true)
    const hist = (await db.from('property_plate_prohibitions').select('added_by,added_at,reason,removed_by,removed_at,removed_reason').eq('id', pid).single()).data
    chk('…and the full history is on the row', !!hist?.added_by && !!hist?.reason && !!hist?.removed_by && !!hist?.removed_reason, JSON.stringify(hist))
    const v2 = (await db.from('vehicles').select('is_active').eq('id', vehId).single()).data
    chk('🔴 removal does NOT restore the revoked vehicle', v2?.is_active === false)

    const r9 = await RES.client.rpc('request_my_vehicle', { p_plate: BAD, p_state: 'TX', p_make: null, p_model: null, p_year: null, p_color: null })
    chk('CONTROL after removal the plate registers again', !r9.error && typeof r9.data === 'number', r9.error?.message ?? `id ${r9.data}`)

    // A manager may lift a CA-added prohibition.
    const caAdd = await db.from('property_plate_prohibitions').insert({
      property_id: propId, plate: `ZZC${String(STAMP).slice(-6)}`, reason: SECRET_REASON, added_by: 'ca@example.invalid',
    }).select('id').single()
    const rm4 = (await MGR.client.rpc('remove_plate_prohibition', { p_id: caAdd.data!.id, p_reason: 'manager lifting a CA prohibition' })).data as R
    chk('a manager can lift a prohibition a CA added', rm4?.ok === true, JSON.stringify(rm4?.error ?? rm4?.action))

    // A manager must not stamp the system reason by hand.
    const r10 = (await MGR.client.rpc('deactivate_vehicle', { p_vehicle_id: vehId, p_reason: 'plate_prohibited', p_note: null })).data as R
    chk('a manager CANNOT stamp plate_prohibited via deactivate_vehicle',
      r10?.error === 'system_reason_not_permitted', JSON.stringify(r10?.error))
  } finally {
    await db.from('property_plate_prohibitions').delete().eq('property_id', propId).ilike('plate', 'ZZ%').in('reason', [SECRET_REASON])
    await db.from('property_plate_prohibitions').delete().eq('property_id', propId).ilike('reason', 'ZZ%')
    await db.from('guest_authorizations').delete().eq('property', PROPERTY).ilike('visiting_unit', `ZZPP-${STAMP}%`)
    await db.from('visitor_passes').delete().eq('property', PROPERTY).ilike('visiting_unit', `ZZPP-${STAMP}%`)
    await db.from('vehicles').delete().eq('property', PROPERTY).ilike('unit', `ZZPP-${STAMP}%`)
    await db.from('residents').delete().eq('property', PROPERTY).ilike('unit', `ZZPP-${STAMP}%`)
    for (const u of users) {
      await db.from('user_roles').delete().ilike('email', u.email)
      await db.auth.admin.deleteUser(u.uid).catch(() => {})
    }
    const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
    for (const o of (orph?.users ?? []).filter(u => /^zz-pp-[a-z]+-\d+@test\.invalid$/.test(u.email ?? ''))) {
      await db.from('user_roles').delete().ilike('email', o.email!)
      await db.auth.admin.deleteUser(o.id).catch(() => {})
      console.log(`  swept orphan: ${o.email}`)
    }
  }

  const left = (await db.from('property_plate_prohibitions').select('*', { count: 'exact', head: true }).eq('reason', SECRET_REASON)).count
  chk('fixtures cleaned up', left === 0, `${left} prohibitions left`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ Prohibited plates are refused on every path, and only managers ever see why.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
