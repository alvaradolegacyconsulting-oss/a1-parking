// ════════════════════════════════════════════════════════════════════
// GATE — Stage 1c activation guard, every legitimate path
// ════════════════════════════════════════════════════════════════════
//
// The paired SQL proves the refusal under SET LOCAL ROLE authenticated.
// This proves the things only real sessions and the real service-role
// client can: that every path a vehicle legitimately becomes active
// through STILL works.
//
// 🔴 A GUARD THAT REFUSES EVERYTHING PASSES EVERY REFUSAL TEST. That is
// why this file is mostly positive controls, and why it fails loudly if
// any of them stops working.
//
// Usage: npm run verify:activationguard

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  const { data: veh } = await db.from('vehicles').select('id').ilike('plate', 'ZZAG%')
  const ids = (veh ?? []).map(v => (v as { id: number }).id)
  if (ids.length) {
    await db.from('audit_logs').delete().in('record_id', ids.map(String))
    await db.from('vehicle_parking_tags').delete().in('vehicle_id', ids)
    await db.from('vehicles').delete().in('id', ids)
  }
  await db.from('residents').delete().ilike('email', 'zz-ag-%@test.invalid')
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-ag-/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.from('residents').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
    console.log(`   swept orphan: ${o.email}`)
  }
  console.log(`   cleanup done (${why})`)
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    console.error(`\n🔴 ${sig} — cleaning up.`); cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

async function actor(tag: string, role: string, canApprove = false) {
  const email = `zz-ag-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({
    email, role, company: COMPANY, property: [PROPERTY], is_active: true, can_approve_vehicles: canApprove,
  })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`link ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`otp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  // ── CANARY: refuse to run before 1c is applied ────────────────────
  const probe = await db.from('vehicles').select('id').limit(1)
  if (probe.error) { console.error('db unreachable'); process.exit(2) }
  const fn = await db.rpc('manager_add_vehicle', { p_property: 'ZZ none', p_unit: 'x', p_resident_email: 'x@y.z', p_plate: 'ZZ', p_state: 'TX' })
  if (fn.error && /Could not find the function/i.test(fn.error.message)) {
    console.error('🔴 manager_add_vehicle is missing. Apply Stage 1d, then 1c. Nothing was written.')
    process.exit(2)
  }
  console.log('canary: manager_add_vehicle exists\n')

  let MGRY: Awaited<ReturnType<typeof actor>> | null = null
  let MGRN: Awaited<ReturnType<typeof actor>> | null = null
  let CA:   Awaited<ReturnType<typeof actor>> | null = null
  let RES:  Awaited<ReturnType<typeof actor>> | null = null
  try {
    MGRY = await actor('mgry', 'manager', true)
    MGRN = await actor('mgrn', 'manager', false)
    CA   = await actor('ca',   'company_admin', false)
    RES  = await actor('res',  'resident', false)

    const call = (c: typeof db, f: string, a: Record<string, unknown>) =>
      c.rpc(f, a).then(r => (r.data ?? { ok: false, error: `rpc_error:${r.error?.message}` }) as Record<string, unknown>)
    const add = (c: typeof db, who: string, plate: string, extra: Record<string, unknown> = {}) =>
      call(c, 'manager_add_vehicle', { p_property: PROPERTY, p_unit: 'AG', p_resident_email: who, p_plate: plate, p_state: 'TX', ...extra })

    // ── 1-3. the three staff paths ──────────────────────────────────
    console.log('── POSITIVE CONTROLS: every legitimate path to active ──')
    const a1 = await add(MGRY.client, MGRY.email, `ZZAG1${STAMP % 10000}`)
    chk('1. a FLAGGED manager adds and it lands ACTIVE', a1.action === 'added_active', JSON.stringify(a1))

    const a2 = await add(MGRN.client, MGRN.email, `ZZAG2${STAMP % 10000}`)
    chk('2. an UNFLAGGED manager adds and it lands PENDING, with the reason',
      a2.action === 'added_pending' && a2.pending_reason === 'no_approval_authority', JSON.stringify(a2))

    const a3 = await add(CA.client, CA.email, `ZZAG3${STAMP % 10000}`)
    chk('3. a CA adds and it lands ACTIVE', a3.action === 'added_active', JSON.stringify(a3))

    // ── 4. the resident path ────────────────────────────────────────
    // request_my_vehicle needs a residents row to attribute to.
    await db.from('residents').insert({
      email: RES.email, name: 'ZZ AG Resident', property: PROPERTY, company: COMPANY,
      unit: 'AG', status: 'active', is_active: true,
    })
    const r4 = await call(RES.client, 'request_my_vehicle', {
      p_plate: `ZZAG4${STAMP % 10000}`, p_state: 'TX', p_make: 'P', p_model: 'Res', p_color: null, p_year: null,
    })
    const v4 = (await db.from('vehicles').select('status, is_active').ilike('plate', `ZZAG4${STAMP % 10000}`).maybeSingle()).data as Record<string, unknown> | null
    chk('4. a RESIDENT request lands PENDING and is not refused by the guard',
      !!v4 && v4.status === 'pending' && v4.is_active === false,
      `rpc: ${JSON.stringify(r4).slice(0, 90)} | row: ${JSON.stringify(v4)}`)

    // ── 5. approve_vehicle still approves ───────────────────────────
    const pendingId = (await db.from('vehicles').select('id').ilike('plate', `ZZAG2${STAMP % 10000}`).single()).data as { id: number }
    const r5 = await call(MGRY.client, 'approve_vehicle', { p_vehicle_id: pendingId.id, p_manager_note: 'gate' })
    chk('5. approve_vehicle still activates a pending vehicle', r5.ok === true && r5.action === 'approved',
      JSON.stringify(r5).slice(0, 110))

    // ── 6. the service-role path B113 depends on ────────────────────
    // 🔴 This is the MECHANISM, exercised directly, not an HTTP test of
    // /api/billing/bulk-invite — that needs a running server, and a gate
    // must not pretend to have tested a route it never called. B113
    // inserts as service_role with initialVehicleState(tier), which for
    // a legacy tier is status='active'. If the guard blocked
    // service_role, bulk invite would break on its next run.
    const b6 = await db.from('vehicles').insert({
      plate: `ZZAG6${STAMP % 10000}`, state: 'TX', make: 'P', model: 'B113',
      property: PROPERTY, company: COMPANY, unit: 'AG', resident_email: RES.email,
      status: 'active', is_active: true,
    }).select('id, status, is_active')
    chk('6. a SERVICE-ROLE insert arriving ACTIVE still passes (the mechanism B113 and /register rely on)',
      !b6.error && b6.data?.[0]?.status === 'active',
      b6.error ? b6.error.message.slice(0, 80) : JSON.stringify(b6.data?.[0]))

    // ── the refusals ────────────────────────────────────────────────
    console.log('\n── REFUSALS: a direct client write cannot activate ──')
    const target = (await db.from('vehicles').select('id').ilike('plate', `ZZAG6${STAMP % 10000}`).single()).data as { id: number }
    await db.from('vehicles').update({ status: 'pending', is_active: false }).eq('id', target.id)

    const p1 = await MGRY.client.from('vehicles').update({ is_active: true, status: 'active' }).eq('id', target.id).select('id')
    chk('a FLAGGED manager cannot activate by direct PATCH either — authority is not the point, the path is',
      !!p1.error && /vehicle_activation_not_permitted/.test(p1.error.message),
      p1.error ? p1.error.message.slice(0, 70) : `🔴 ALLOWED (${p1.data?.length} row)`)

    const p2 = await MGRN.client.from('vehicles')
      .insert({ plate: `ZZAG7${STAMP % 10000}`, state: 'TX', property: PROPERTY, company: COMPANY,
                unit: 'AG', resident_email: RES.email, status: 'active', is_active: true }).select('id')
    chk('an UNFLAGGED manager cannot INSERT an already-active vehicle',
      !!p2.error && /vehicle_activation_not_permitted/.test(p2.error.message),
      p2.error ? p2.error.message.slice(0, 70) : `🔴 ALLOWED — self-approval by INSERT`)

    // ── and what must still be allowed from a client ────────────────
    console.log('\n── POSITIVE CONTROLS: ordinary manager writes still work ──')
    const c1 = await MGRY.client.from('vehicles').update({ color: 'ZZAG' }).eq('id', target.id).select('id')
    chk('cosmetic edit still allowed', !c1.error && (c1.data?.length ?? 0) === 1, c1.error?.message.slice(0, 60) ?? 'ok')
    const c2 = await MGRY.client.from('vehicles').update({ is_active: false, status: 'declined' }).eq('id', target.id).select('id')
    chk('decline still allowed', !c2.error && (c2.data?.length ?? 0) === 1, c2.error?.message.slice(0, 60) ?? 'ok')
    const c3 = await MGRY.client.from('vehicles').update({ is_active: false, status: 'deactivated' }).eq('id', target.id).select('id')
    chk('remove still allowed', !c3.error && (c3.data?.length ?? 0) === 1, c3.error?.message.slice(0, 60) ?? 'ok')
  } finally {
    await cleanup('finally')
  }

  const left = (await db.from('vehicles').select('id, plate').ilike('plate', 'ZZAG%')).data
  chk('no probe vehicles left behind', (left?.length ?? 0) === 0, JSON.stringify(left))

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ Every legitimate path to active still works — flagged manager, CA, approve_vehicle, resident-pending, service-role —')
  console.log('   and no direct client write can activate, by PATCH or by INSERT.')
}
main().catch(e => {
  console.error('FATAL', e.message)
  cleanup('fatal').then(() => process.exit(2)).catch(() => process.exit(2))
})
