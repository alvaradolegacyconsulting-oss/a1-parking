// ════════════════════════════════════════════════════════════════════
// GATE — the manager→resident role replacement, proven by execution
// ════════════════════════════════════════════════════════════════════
//
// Mirrors amandacanchol@gmail.com's situation on canaries:
//
//   property A  the one she is a RESIDENT at (Southfork Lake analogue)
//   property B  the one she was an inactive MANAGER at (Sugarberry
//               analogue) — she must see nothing there afterwards
//
// Two phases, because the "after" only means something against the
// "before":
//
//   PHASE 1  user_roles = manager at B, is_active = FALSE
//            → the pre-fix state. Asserts the session CAN read B's
//              data, which is the defect: get_my_role() has no
//              is_active term, so an inactive manager row still
//              resolves to 'manager'.
//   PHASE 2  that row replaced by resident at A, is_active = TRUE
//            → asserts role resolves to 'resident', her own record and
//              vehicle are readable, and B is now invisible.
//
// 🔴 NO SESSION IS EVER MINTED ON A REAL CUSTOMER ADDRESS. Amanda's
// own row is verified by the read-only block in the one-off, which runs
// get_my_role()'s predicate against her actual data. Minting a session
// as a live customer to confirm a fix is the thing the standing rule
// about not proving a hole by exploiting a real row exists to stop.
//
// Session acquisition is generateLink + verifyOtp, not
// signInWithPassword: the latter is captcha-gated project-wide and its
// refusal would be mistaken for the control under test.
//
// Usage: npm run verify:residentrole

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const CO = 'Test-LEGACY'
const S = Date.now()
const MARK = `ZZRR${String(S).slice(-7)}`
const EMAIL = `zz-rr-${S}@test.invalid`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

let uid: string | null = null
const roleIds: number[] = []
const residentIds: number[] = []
const vehicleIds: number[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  const del = async (t: string, ids: number[]) => {
    if (!ids.length) return
    const r = await db.from(t).delete().in('id', ids).select('id')
    if (r.error || (r.data ?? []).length !== ids.length) console.error(`   🔴 ${t}: removed ${(r.data ?? []).length}/${ids.length}`, r.error?.message ?? '')
    else console.log(`   ↩ removed ${ids.length} ${t} row(s)`)
  }
  await del('vehicles', vehicleIds)
  await del('residents', residentIds)
  await del('user_roles', roleIds)
  for (const [t, c] of [['vehicles', 'plate'], ['residents', 'email'], ['user_roles', 'email']] as const) {
    const stray = await db.from(t).delete().ilike(c, `%${MARK}%`).select('id')
    if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray ${t} row(s) by stamp`)
  }
  await db.from('user_roles').delete().ilike('email', 'zz-rr-%').select('id')
  if (uid) {
    await db.auth.admin.deleteUser(uid).catch(() => {})
    const back = await db.auth.admin.listUsers({ perPage: 1000 })
    if ((back.data?.users ?? []).some(u => u.id === uid)) { console.error(`   🔴 auth user ${uid} STILL PRESENT`); fails++ }
    else console.log(`   ↩ deleted auth user`)
  }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const session = async () => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  if (error || !link?.properties?.hashed_token) throw new Error(`generateLink: ${error?.message}`)
  const v = await c.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (v.error) throw new Error(`verifyOtp: ${v.error.message}`)
  return c
}

const main = async () => {
  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const act = (props ?? []).filter(p => p.company === CO && p.is_active)
  const A = act.find(p => p.name === 'Test Legacy Property')
  const B = act.find(p => p.id !== A?.id)
  if (!A || !B) { console.error(`🔴 need two active ${CO} properties; got A=${A?.id} B=${B?.id}`); process.exit(2) }
  console.log(`A = ${A.name} (resident there, the Southfork analogue)`)
  console.log(`B = ${B.name} (inactive manager there, the Sugarberry analogue)\n`)

  try {
    // her own record at A
    const rA = await db.from('residents').insert({
      name: `ZZ RR ${MARK}`, email: EMAIL, unit: '101', property: A.name,
      company: CO, is_active: true, status: 'active',
    }).select('id').single()
    if (rA.error) throw new Error(`residents A: ${rA.error.message}`)
    residentIds.push(rA.data.id as number)
    const vA = await db.from('vehicles').insert({
      plate: `${MARK}A`, state: 'TX', property: A.name, company: CO,
      status: 'active', is_active: true, unit: '101', resident_email: EMAIL,
    }).select('id').single()
    if (vA.error) throw new Error(`vehicles A: ${vA.error.message}`)
    vehicleIds.push(vA.data.id as number)

    // somebody else's data at B — what she must not be able to read
    const rB = await db.from('residents').insert({
      name: `ZZ RR OTHER ${MARK}`, email: `zz-rr-other-${S}-${MARK}@test.invalid`, unit: '202',
      property: B.name, company: CO, is_active: true, status: 'active',
    }).select('id').single()
    if (rB.error) throw new Error(`residents B: ${rB.error.message}`)
    residentIds.push(rB.data.id as number)
    const vB = await db.from('vehicles').insert({
      plate: `${MARK}B`, state: 'TX', property: B.name, company: CO,
      status: 'active', is_active: true, unit: '202',
    }).select('id').single()
    if (vB.error) throw new Error(`vehicles B: ${vB.error.message}`)
    vehicleIds.push(vB.data.id as number)

    const { data: u, error: uErr } = await db.auth.admin.createUser({ email: EMAIL, password: `Zz!rr${S}q`, email_confirm: true })
    if (uErr || !u.user) throw new Error(`createUser: ${uErr?.message}`)
    uid = u.user.id

    // ── PHASE 1 — the pre-fix shape ────────────────────────────────
    console.log('── PHASE 1: inactive MANAGER at B (the state Amanda is in today) ──')
    const m = await db.from('user_roles').insert({
      email: EMAIL, role: 'manager', company: CO, property: [B.name], is_active: false,
    }).select('id').single()
    if (m.error) throw new Error(`user_roles manager: ${m.error.message}`)
    roleIds.push(m.data.id as number)

    const c1 = await session()
    const r1 = await c1.rpc('get_my_role')
    chk('an INACTIVE manager row still resolves to "manager"', r1.data === 'manager',
      `get_my_role() → ${JSON.stringify(r1.data)} — this is the defect the helper change closes`)
    const bSeen1 = await c1.from('residents').select('id').eq('id', residentIds[1])
    chk("🔴 ...and it reads property B's resident data", !bSeen1.error && (bSeen1.data ?? []).length === 1,
      bSeen1.error ? 'refused: ' + bSeen1.error.message.slice(0, 40) : `${(bSeen1.data ?? []).length} row(s) — the exposure, measured`)

    // ── PHASE 2 — after the replacement ───────────────────────────
    console.log('\n── PHASE 2: that row replaced by RESIDENT at A (what the one-off does) ──')
    const d = await db.from('user_roles').delete().eq('id', roleIds[0]).select('id')
    if (d.error || (d.data ?? []).length !== 1) throw new Error('could not delete the manager row')
    roleIds.length = 0
    const res = await db.from('user_roles').insert({
      email: EMAIL, role: 'resident', company: CO, property: [A.name], is_active: true,
      tos_accepted_version: '2026-07-12-v2', privacy_accepted_version: '2026-07-12-v2',
      texas_confirmed: false, must_change_password: false,
      can_regenerate_tow_ticket: false, can_approve_vehicles: false,
    }).select('id').single()
    if (res.error) throw new Error(`user_roles resident: ${res.error.message}`)
    roleIds.push(res.data.id as number)

    const c2 = await session()
    const r2 = await c2.rpc('get_my_role')
    const co2 = await c2.rpc('get_my_company')
    const p2 = await c2.rpc('get_my_properties')
    chk('her session resolves to "resident"', r2.data === 'resident', `get_my_role() → ${JSON.stringify(r2.data)}`)
    chk('   ...at her own company', co2.data === CO, JSON.stringify(co2.data))
    chk('   ...scoped to property A only', JSON.stringify(p2.data) === JSON.stringify([A.name]), JSON.stringify(p2.data))

    const mine = await c2.from('residents').select('id,name,unit,property').eq('id', residentIds[0])
    chk('reads her OWN resident record', !mine.error && (mine.data ?? []).length === 1,
      mine.error ? '🔴 refused: ' + mine.error.message.slice(0, 44) : JSON.stringify(mine.data?.[0]))
    const myCar = await c2.from('vehicles').select('id,plate,unit').eq('id', vehicleIds[0])
    chk('reads her OWN vehicle', !myCar.error && (myCar.data ?? []).length === 1,
      myCar.error ? '🔴 refused: ' + myCar.error.message.slice(0, 44) : JSON.stringify(myCar.data?.[0]))

    const bRes = await c2.from('residents').select('id').eq('id', residentIds[1])
    chk(`🔴 reads NO resident data at property B (${B.name})`,
      bRes.error !== null || (bRes.data ?? []).length === 0,
      bRes.error ? 'refused' : (bRes.data ?? []).length === 0 ? 'hidden by RLS (0 rows)' : `🔴 STILL VISIBLE: ${(bRes.data ?? []).length} row(s)`)
    const bVeh = await c2.from('vehicles').select('id').eq('id', vehicleIds[1])
    chk(`🔴 reads NO vehicle data at property B`,
      bVeh.error !== null || (bVeh.data ?? []).length === 0,
      bVeh.error ? 'refused' : (bVeh.data ?? []).length === 0 ? 'hidden by RLS (0 rows)' : `🔴 STILL VISIBLE`)

    // The thing the whole exercise is for: her login still works.
    chk('her login still works after the replacement', true, 'a session was acquired in phase 2 — not banned')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ the replacement shape is correct' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
