// ════════════════════════════════════════════════════════════════════
// GATE — Piece 1 parking tags (the half SQL cannot prove)
// ════════════════════════════════════════════════════════════════════
//
// The paired verification asserts structure and executes the indexes
// and the void trigger. It CANNOT prove what only a real JWT shows:
// that a manager is refused when the property switch is off, that the
// RPC is genuinely the only write path, that a resident reads their own
// tag and no one else's, and that anon reads nothing.
//
// 🔴 CANARY FIRST, then arm, then write. Standing rule after this gate's
// ancestor corrupted a production row: a gate never runs before its
// migration is applied, and never proves a hole by exploiting it.
//
// 🔴 THE POSITIVE CONTROLS ARE HALF THE POINT. set_vehicle_tag refusing
// everything would pass every refusal check here. Each refusal is
// paired with the success that proves the refusal was specific.
//
// Usage: npm run verify:parkingtags

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })
process.stderr.on('error', () => {})

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
const OTHER_PROPERTY = 'Test-LEGACY second property placeholder'   // resolved below
const TAG_A = `ZZA${STAMP % 100000}`, TAG_B = `ZZB${STAMP % 100000}`
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []

// ── armed cleanup ───────────────────────────────────────────────────
let switchWasOn: boolean | null = null
let propertyId: number | null = null
let cleaned = false

async function cleanupNow(why: string): Promise<boolean> {
  if (cleaned) return true
  cleaned = true
  let ok = true
  // 1. every tag row this gate created
  // 🔴 By assigned_by, NOT by a list of tag numbers. The first version
  // listed TAG_A/TAG_B and leaked row "ZZA…X", because the RPC
  // NORMALIZES what it is given — the stored number is not the string
  // the gate passed in. assigned_by is the gate's own identity and
  // cannot drift from it.
  const { error: dErr, data: dRows } = await db.from('vehicle_parking_tags')
    .delete().ilike('assigned_by', 'zz-pt-%@test.invalid').select('id')
  if (dErr) { console.error(`🔴 cleanup (${why}): tag delete failed: ${dErr.message}`); ok = false }
  else if (dRows?.length) console.log(`   removed ${dRows.length} probe tag row(s)`)

  // 2. the feature switch back to what it was. Service role passes the
  //    properties guard's no-JWT passthrough, so this is a direct write.
  if (switchWasOn === false && propertyId !== null) {
    const { data, error } = await db.from('properties')
      .update({ parking_tags_enabled: false }).eq('id', propertyId).select('parking_tags_enabled')
    if (error || data?.[0]?.parking_tags_enabled !== false) {
      console.error(`🔴 cleanup (${why}): parking_tags_enabled NOT restored to false on property ${propertyId}.`)
      console.error(`   Fix by hand: UPDATE properties SET parking_tags_enabled = false WHERE id = ${propertyId};`)
      ok = false
    } else console.log('   parking_tags_enabled restored to false')
  }

  // 3. users
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-pt-[a-z]+-\d+@test\.invalid$/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
    console.log(`   swept orphan: ${o.email}`)
  }
  await db.from('audit_logs').delete()
    .in('action', ['assign_vehicle_tag', 'reissue_vehicle_tag', 'clear_vehicle_tag', 'void_vehicle_tag'])
    .in('user_email', users.map(u => u.email))
  return ok
}

let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => {
    if (dying) return; dying = true
    console.error(`\n🔴 ${sig} — cleaning up before exit.`)
    cleanupNow(sig).then(() => process.exit(2)).catch(() => process.exit(2))
  })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanupNow('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

async function actor(tag: string, role: string, company: string, props: string[], canApprove = false) {
  const email = `zz-pt-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({
    email, role, company, property: props, is_active: true,
    // 🔴 deactivate_vehicle requires vehicle-approval authority
    // ("This manager account lacks vehicle-approval authority"), so the
    // void-trigger test cannot reach the RPC without it. Granted only
    // for the actor that needs it, not blanket.
    can_approve_vehicles: canApprove,
  })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  // ── CANARY: refuse to run before the migration is applied ─────────
  const probe = await db.from('vehicle_parking_tags').select('id').limit(1)
  if (probe.error) {
    console.error(`🔴 vehicle_parking_tags is not reachable: ${probe.error.message}`)
    console.error('   Apply wip-20261013_piece1_parking_tags.sql first. Nothing was written.')
    process.exit(2)
  }
  const fnProbe = await db.rpc('set_vehicle_tag', { p_vehicle_id: -1, p_tag: 'ZZ' })
  if (fnProbe.error && /Could not find the function/i.test(fnProbe.error.message)) {
    console.error('🔴 set_vehicle_tag does not exist. Apply Part A first. Nothing was written.')
    process.exit(2)
  }
  // 🔴 service_role holds EXECUTE but has no JWT, so set_vehicle_tag
  // answers not_signed_in — by design: every legitimate tag writer is a
  // logged-in person. So the canary asserts only that the function
  // exists and refuses STRUCTURALLY (jsonb with an error code, never a
  // raised Postgres error), which is the contract the UI depends on.
  const canary = fnProbe.data as Record<string, unknown> | null
  chk('canary: the RPC exists and refuses structurally rather than raising',
    !fnProbe.error && typeof canary?.error === 'string' && canary.ok === false,
    JSON.stringify(canary ?? fnProbe.error?.message))

  const prop = (await db.from('properties')
    .select('id, name, parking_tags_enabled').eq('name', PROPERTY).single()).data as Record<string, unknown>
  if (!prop) { console.error(`fixture property ${PROPERTY} not found`); process.exit(2) }
  propertyId = Number(prop.id)
  switchWasOn = Boolean(prop.parking_tags_enabled)
  console.log(`fixture: ${PROPERTY} (id ${propertyId}), parking_tags_enabled=${switchWasOn}\n`)

  const vehs = (await db.from('vehicles')
    .select('id, plate, resident_email, unit')
    .eq('property', PROPERTY).eq('status', 'active').eq('is_active', true)
    .order('id').limit(2)).data as Array<Record<string, unknown>>
  if (!vehs || vehs.length < 2) { console.error('need 2 active vehicles at the fixture property'); process.exit(2) }
  const [vA, vB] = vehs
  console.log(`vehicles: ${vA.id} (${vA.plate}) and ${vB.id} (${vB.plate})\n`)

  let MGR: Awaited<ReturnType<typeof actor>> | null = null
  let CA: Awaited<ReturnType<typeof actor>> | null = null
  let FOREIGN: Awaited<ReturnType<typeof actor>> | null = null
  let RES: Awaited<ReturnType<typeof actor>> | null = null
  try {
    MGR = await actor('mgr', 'manager', COMPANY, [PROPERTY], true)
    CA  = await actor('ca',  'company_admin', COMPANY, [PROPERTY])
    // A manager of a DIFFERENT property in the same company.
    const other = (await db.from('properties').select('name')
      .eq('company', COMPANY).neq('name', PROPERTY).limit(1).single()).data as Record<string, unknown>
    FOREIGN = await actor('fgn', 'manager', COMPANY, [String(other?.name ?? OTHER_PROPERTY)])

    const call = (c: typeof db, fn: string, args: Record<string, unknown>) =>
      c.rpc(fn, args).then(r => (r.data ?? { ok: false, error: `rpc_error:${r.error?.message}` }) as Record<string, unknown>)

    // ── 1. switch OFF: refused ────────────────────────────────────────
    console.log('── the switch is the gate ──')
    const off = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: TAG_A })
    chk('manager refused while parking tags are switched OFF',
      off.ok === false && off.error === 'parking_tags_not_enabled', JSON.stringify(off))

    // ── 2. CA turns it on, manager can assign (positive control) ──────
    const flip = await call(CA.client, 'set_property_feature_switch',
      { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: true })
    chk('CA switched parking tags ON via the RPC', flip.ok === true, JSON.stringify(flip))

    const asg = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: `${TAG_A.toLowerCase()}-x` })
    chk('manager CAN assign once the switch is ON, and the number is normalized',
      asg.ok === true && asg.action === 'assigned' && asg.tag_number === `${TAG_A}X`,
      JSON.stringify(asg))

    // ── 3. the same number cannot be live twice at one property ───────
    console.log('\n── one live tag per number, per property ──')
    const dup = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vB.id, p_tag: `${TAG_A}X` })
    chk('a number already live at the property is refused, naming the holder',
      dup.ok === false && dup.error === 'tag_already_assigned' && dup.held_by_plate === vA.plate,
      JSON.stringify(dup))

    // ── 4. re-issue voids the previous row, keeping history ───────────
    const re = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: TAG_B })
    chk('re-issuing returns the previous number and voids it',
      re.ok === true && re.action === 'reissued' && re.previous_tag_number === `${TAG_A}X`,
      JSON.stringify(re))
    const hist = (await db.from('vehicle_parking_tags')
      .select('tag_number, voided_at, voided_reason').eq('vehicle_id', vA.id)).data as Array<Record<string, unknown>>
    chk('the voided row is RETAINED as history, not deleted',
      hist.length === 2 && hist.filter(h => h.voided_at).length === 1
      && hist.some(h => h.voided_reason === 'reissued'),
      JSON.stringify(hist))

    // ── 5. 🔴 the RPC is the ONLY write path ─────────────────────────
    console.log('\n── the RPC is the only write path ──')
    const ins = await MGR.client.from('vehicle_parking_tags')
      .insert({ vehicle_id: vB.id, property_id: propertyId, tag_number: 'ZZHACK', assigned_by: MGR.email }).select('id')
    chk('a manager CANNOT INSERT a tag row directly', !!ins.error, ins.error ? '' : '🔴 INSERT ALLOWED')
    const upd = await MGR.client.from('vehicle_parking_tags')
      .update({ tag_number: 'ZZHACK' }).eq('vehicle_id', vA.id).select('id')
    chk('a manager CANNOT UPDATE a tag row directly',
      !!upd.error || (upd.data?.length ?? 0) === 0, upd.error ? '' : `rows affected: ${upd.data?.length}`)
    const del = await MGR.client.from('vehicle_parking_tags').delete().eq('vehicle_id', vA.id).select('id')
    chk('a manager CANNOT DELETE a tag row directly',
      !!del.error || (del.data?.length ?? 0) === 0, del.error ? '' : `rows deleted: ${del.data?.length} 🔴`)

    // ── 6. authority is per property ─────────────────────────────────
    console.log('\n── authority is scoped to the property ──')
    const fgn = await call(FOREIGN.client, 'set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: 'ZZFGN1' })
    chk('a manager of another property is refused',
      fgn.ok === false && fgn.error === 'not_permitted', JSON.stringify(fgn))

    // ── 7. resident reads own, not others ────────────────────────────
    console.log('\n── resident: read-only, own vehicle only ──')
    const resEmail = String(vA.resident_email ?? '')
    if (!resEmail) {
      chk('resident fixture available', false, 'vehicle A has no resident_email — cannot test resident scope')
    } else {
      const { data: rl } = await db.auth.admin.generateLink({ type: 'magiclink', email: resEmail })
      if (!rl?.properties?.hashed_token) {
        chk('resident fixture available', false, `no auth user for ${resEmail}`)
      } else {
        const rc = createClient(URL, ANON, { auth: { persistSession: false } })
        const { error: rErr } = await rc.auth.verifyOtp({ token_hash: rl.properties.hashed_token, type: 'magiclink' })
        if (rErr) chk('resident sign-in', false, rErr.message)
        else {
          const own = await rc.from('vehicle_parking_tags').select('id, vehicle_id, tag_number').eq('vehicle_id', vA.id)
          chk('resident CAN read their own vehicle\'s tag', !own.error && (own.data?.length ?? 0) > 0,
            own.error ? own.error.message.slice(0, 60) : `${own.data?.length} row(s)`)
          const notOwn = await rc.from('vehicle_parking_tags').select('id').eq('vehicle_id', vB.id)
          // RLS denial is {data:[],error:null} — a filter, not an error.
          chk('resident reads NOTHING for a vehicle that is not theirs',
            !notOwn.error && (notOwn.data?.length ?? 0) === 0,
            notOwn.error ? notOwn.error.message.slice(0, 60) : `${notOwn.data?.length} row(s)`)
          const rw = await rc.from('vehicle_parking_tags').update({ tag_number: 'ZZRES' }).eq('vehicle_id', vA.id).select('id')
          chk('resident CANNOT write their own tag',
            !!rw.error || (rw.data?.length ?? 0) === 0, rw.error ? '' : `🔴 ${rw.data?.length} row(s) updated`)
        }
      }
    }

    // ── 8. anon sees nothing ─────────────────────────────────────────
    const an = createClient(URL, ANON, { auth: { persistSession: false } })
    const anr = await an.from('vehicle_parking_tags').select('id').limit(1)
    chk('anon cannot read the table', !!anr.error || (anr.data?.length ?? 0) === 0,
      anr.error ? anr.error.message.slice(0, 50) : `🔴 ${anr.data?.length} row(s)`)
    const anf = await an.rpc('set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: 'ZZANON' })
    chk('anon cannot execute set_vehicle_tag', !!anf.error,
      anf.error ? anf.error.message.slice(0, 50) : '🔴 EXECUTED')

    // ── 9. clearing is not an error ──────────────────────────────────
    console.log('\n── clearing, and the void trigger ──')
    const clr = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vA.id, p_tag: '' })
    chk('an empty tag CLEARS rather than erroring',
      clr.ok === true && clr.action === 'cleared' && clr.previous_tag_number === TAG_B, JSON.stringify(clr))

    // ── 10. void trigger through a real deactivation path ────────────
    const asg2 = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vB.id, p_tag: TAG_A })
    chk('re-assigned to vehicle B for the trigger test', asg2.ok === true, JSON.stringify(asg2))
    const deact = await call(MGR.client, 'deactivate_vehicle',
      { p_vehicle_id: vB.id, p_reason: 'registered_in_error', p_note: `gate ${STAMP}` })
    const liveAfter = (await db.from('vehicle_parking_tags')
      .select('tag_number, voided_at, voided_reason').eq('vehicle_id', vB.id).is('voided_at', null)).data
    chk('deactivating via the deactivate_vehicle RPC voided its tag',
      (liveAfter?.length ?? 0) === 0,
      `deactivate: ${JSON.stringify(deact).slice(0, 90)} | live tags left: ${liveAfter?.length}`)

    await db.from('vehicles').update({
      is_active: true, status: 'active',
      deactivated_at: null, deactivated_by: null, deactivation_reason: null, deactivation_note: null,
    }).eq('id', vB.id)

    // 🔴 And again via a DIRECT PATCH. This is the path a manager
    // actually uses today (manager/page.tsx:2791 Remove, :1633 Decline
    // both write status/is_active straight to the table), and it is the
    // reason the void is a TRIGGER rather than a step inside the RPC.
    // If this fails, every tag survives the removal that should void it.
    const t2 = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vB.id, p_tag: `${TAG_A}P` })
    chk('re-assigned for the direct-PATCH trigger test', t2.ok === true, JSON.stringify(t2))
    const patch = await MGR.client.from('vehicles')
      .update({ is_active: false, status: 'deactivated' }).eq('id', vB.id).select('id')
    const liveAfter2 = (await db.from('vehicle_parking_tags')
      .select('tag_number').eq('vehicle_id', vB.id).is('voided_at', null)).data
    chk('a manager\'s DIRECT PATCH to status also voided the tag (trigger, not the RPC)',
      !patch.error && (liveAfter2?.length ?? 0) === 0,
      patch.error ? patch.error.message.slice(0, 60) : `live tags left: ${liveAfter2?.length}`)

    // restore vehicle B
    await db.from('vehicles').update({
      is_active: true, status: 'active',
      deactivated_at: null, deactivated_by: null, deactivation_reason: null, deactivation_note: null,
    }).eq('id', vB.id)
    const back = (await db.from('vehicles').select('is_active, status').eq('id', vB.id).single()).data as Record<string, unknown>
    chk('fixture vehicle B restored to active', back.is_active === true && back.status === 'active', JSON.stringify(back))

    // ── 11. switch OFF still allows voiding (the un-do is not gated) ──
    const t3 = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vB.id, p_tag: TAG_B })
    chk('re-assigned for the switch-off void test', t3.ok === true, JSON.stringify(t3))
    await call(CA.client, 'set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })
    const voidOff = await call(MGR.client, 'void_vehicle_tag',
      { p_vehicle_id: vB.id, p_reason: 'collected_at_moveout' })
    chk('an outstanding tag can STILL be voided after the switch is turned off',
      voidOff.ok === true && voidOff.action === 'voided',
      JSON.stringify(voidOff) + '  (gating the un-do on the same switch would trap rows)')
    const assignOff = await call(MGR.client, 'set_vehicle_tag', { p_vehicle_id: vB.id, p_tag: 'ZZOFF1' })
    chk('but assigning a NEW tag is refused with the switch off',
      assignOff.ok === false && assignOff.error === 'parking_tags_not_enabled', JSON.stringify(assignOff))
  } finally {
    const ok = await cleanupNow('finally')
    if (!ok) fails++
  }

  const leftover = (await db.from('vehicle_parking_tags')
    .select('id, tag_number, assigned_by')
    .or('assigned_by.ilike.zz-pt-%,tag_number.ilike.ZZ%')).data
  chk('no probe tag rows left behind', (leftover?.length ?? 0) === 0, JSON.stringify(leftover))
  const sw = (await db.from('properties').select('parking_tags_enabled').eq('id', propertyId!).single()).data as Record<string, unknown>
  chk('parking_tags_enabled left as found (false)', sw.parking_tags_enabled === false, JSON.stringify(sw))

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ The switch gates assignment, the RPC is the only write path, authority is per property, residents are read-only on their own tag, and voiding survives the switch being turned off.')
}
main().catch(e => {
  console.error('FATAL', e.message)
  cleanupNow('fatal').then(() => process.exit(2)).catch(() => process.exit(2))
})
