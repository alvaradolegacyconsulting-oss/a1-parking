// ════════════════════════════════════════════════════════════════════
// GATE — issuing the same pass twice returns the first one
// ════════════════════════════════════════════════════════════════════
//
// A1 live, 2026-10-09: one resident issued the same 24h pass four times
// in 9 seconds. 22 bursts, 27 duplicate rows, 4 properties, back to
// August. Gaps up to 109 seconds, so the page's in-flight guard was
// never going to catch them all — the dedup has to be server-side.
//
// Proven here BY EXECUTION:
//   1. a second identical call returns the FIRST pass, not a new one
//   2. 🔴 FOUR CONCURRENT calls produce exactly ONE row — the advisory
//      lock. This is the actual defect; a sequential test would pass
//      against a select-then-insert that still races.
//   3. an EXPIRED pass that is still flagged is_active does NOT dedup
//      (1,846 rows are in that state, so one-predicate liveness would
//      hand back a dead pass)
//   4. created_at comes from the server, not the caller
//   5. a resident cannot issue for someone else's unit — the scoping
//      that replaced the RLS a DEFINER function bypasses
//   6. a resident CAN issue for their own unit (positive control)
//   7. anon cannot execute it at all (the CAPTCHA bypass)
//
// Usage: npx tsx scripts/verify-visitor-pass-dedup.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
const UNIT = `ZZVP-${STAMP}`
const OTHER_UNIT = `ZZVP-${STAMP}-OTHER`
const PLATE = `ZZV${String(STAMP).slice(-6)}`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const created: { email: string; uid: string }[] = []
type R = Record<string, unknown>

async function resident(tag: string, unit: string) {
  const email = `zz-vp-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  created.push({ email, uid: data.user.id })
  const r1 = await db.from('user_roles').insert({ email, role: 'resident', company: COMPANY, property: [PROPERTY], is_active: true })
  if (r1.error) throw new Error(`user_roles: ${r1.error.message}`)
  const r2 = await db.from('residents').insert({ email, name: `ZZ VP ${tag}`, property: PROPERTY, unit, company: COMPANY, is_active: true, status: 'active' })
  if (r2.error) throw new Error(`residents: ${r2.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp: ${vErr.message}`)
  return { email, client }
}

const call = (c: ReturnType<typeof createClient>, plate: string, unit: string, hours = 24) =>
  c.rpc('issue_visitor_pass', {
    p_plate: plate, p_visitor_name: 'ZZ Gate Visitor', p_visiting_unit: unit,
    p_property: PROPERTY, p_vehicle_desc: 'grey test car', p_duration_hours: hours,
  })

const main = async () => {
  const probe = await call(db, 'ZZPROBE0', 'nope')
  if (probe.error && /Could not find the function/i.test(probe.error.message)) {
    console.error('issue_visitor_pass does not exist — apply')
    console.error('  migrations/20261009_issue_visitor_pass_dedup.sql  first. Not a pass, not a failure.')
    process.exit(2)
  }

  let A: Awaited<ReturnType<typeof resident>> | null = null
  let B: Awaited<ReturnType<typeof resident>> | null = null
  try {
    A = await resident('a', UNIT)
    B = await resident('b', OTHER_UNIT)
    console.log(`fixture: ${PLATE} @ ${PROPERTY} unit ${UNIT}\n`)

    // ── 1. sequential dedup (as service_role, the /visitor route's identity)
    const c1 = await call(db, PLATE, UNIT)
    const d1 = c1.data as R
    chk('first call creates a pass', !c1.error && d1?.action === 'created', c1.error?.message ?? JSON.stringify(d1?.action))
    const firstId = d1?.pass_id as number

    const c2 = await call(db, PLATE, UNIT)
    const d2 = c2.data as R
    chk('second identical call returns the FIRST pass',
      d2?.action === 'existing' && d2?.pass_id === firstId,
      JSON.stringify({ action: d2?.action, pass_id: d2?.pass_id, want: firstId }))

    // formatting variants must land on the same pass
    const c2b = await call(db, `${PLATE.slice(0, 3)}-${PLATE.slice(3)}`, ` ${UNIT} `)
    chk('a differently-formatted plate/unit still dedups',
      (c2b.data as R)?.pass_id === firstId, JSON.stringify((c2b.data as R)?.pass_id))

    // ── 2. 🔴 THE RACE ────────────────────────────────────────────
    const racePlate = `ZZR${String(STAMP).slice(-6)}`
    const burst = await Promise.all([1, 2, 3, 4].map(() => call(db, racePlate, UNIT)))
    const actions = burst.map(b => (b.data as R)?.action)
    const rows = await db.from('visitor_passes').select('id')
      .eq('property', PROPERTY).ilike('plate', racePlate)
    chk('4 CONCURRENT calls create exactly ONE row',
      (rows.data?.length ?? 0) === 1,
      `${rows.data?.length} rows; actions ${JSON.stringify(actions)}`)
    chk('…one created, three existing',
      actions.filter(a => a === 'created').length === 1 && actions.filter(a => a === 'existing').length === 3,
      JSON.stringify(actions))

    // ── 3. an EXPIRED but still-flagged pass must NOT dedup ───────
    const expPlate = `ZZE${String(STAMP).slice(-6)}`
    const ins = await db.from('visitor_passes').insert({
      plate: expPlate, visitor_name: 'ZZ Expired', visiting_unit: UNIT, property: PROPERTY,
      vehicle_desc: 'x', duration_hours: 1,
      created_at: new Date(Date.now() - 864e5).toISOString(),
      expires_at: new Date(Date.now() - 82800000).toISOString(),
      is_active: true,                  // the 1,846-row state
    }).select('id').single()
    if (ins.error) throw new Error(`expired insert: ${ins.error.message}`)
    const c3 = await call(db, expPlate, UNIT)
    chk('an expired-but-flagged pass does NOT dedup (both predicates)',
      (c3.data as R)?.action === 'created' && (c3.data as R)?.pass_id !== ins.data.id,
      JSON.stringify({ action: (c3.data as R)?.action, newId: (c3.data as R)?.pass_id, expiredId: ins.data.id }))

    // ── 4. server time ────────────────────────────────────────────
    const row = await db.from('visitor_passes').select('created_at, expires_at').eq('id', firstId).single()
    const skewSec = Math.abs(new Date(row.data!.created_at as string).getTime() - Date.now()) / 1000
    chk('created_at is server time (within 120s of now)', skewSec < 120, `${skewSec.toFixed(1)}s skew`)

    // ── 5. a resident cannot issue for another unit ───────────────
    const c5 = await call(A.client, `ZZX${String(STAMP).slice(-6)}`, OTHER_UNIT)
    chk('a resident CANNOT issue for someone else\'s unit',
      !!c5.error && /not_your_unit/.test(c5.error.message),
      c5.error ? c5.error.message : `NO ERROR — ${JSON.stringify(c5.data)}`)

    // ── 6. positive control: own unit works ──────────────────────
    const ownPlate = `ZZO${String(STAMP).slice(-6)}`
    const c6 = await call(A.client, ownPlate, UNIT)
    chk('a resident CAN issue for their own unit', !c6.error && (c6.data as R)?.action === 'created',
      c6.error?.message ?? JSON.stringify((c6.data as R)?.action))
    const c6b = await call(A.client, ownPlate, UNIT)
    chk('…and their own second tap dedups too', (c6b.data as R)?.action === 'existing',
      JSON.stringify((c6b.data as R)?.action))

    // ── 7. anon cannot execute it ────────────────────────────────
    const anonC = createClient(URL, ANON, { auth: { persistSession: false } })
    const c7 = await call(anonC, `ZZA${String(STAMP).slice(-6)}`, UNIT)
    chk('anon CANNOT execute issue_visitor_pass (no CAPTCHA bypass)',
      !!c7.error, c7.error ? `${c7.error.code ?? ''} ${c7.error.message}`.trim() : `NO ERROR — ${JSON.stringify(c7.data)}`)
  } finally {
    await db.from('visitor_passes').delete().eq('property', PROPERTY).ilike('visiting_unit', `ZZVP-${STAMP}%`)
    await db.from('residents').delete().eq('property', PROPERTY).ilike('unit', `ZZVP-${STAMP}%`)
    for (const c of created) {
      await db.from('user_roles').delete().ilike('email', c.email)
      await db.auth.admin.deleteUser(c.uid).catch(() => {})
    }
    const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
    for (const o of (orph?.users ?? []).filter(u => /^zz-vp-[ab]-\d+@test\.invalid$/.test(u.email ?? ''))) {
      await db.from('user_roles').delete().ilike('email', o.email!)
      await db.auth.admin.deleteUser(o.id).catch(() => {})
      console.log(`  swept orphan: ${o.email}`)
    }
  }

  const left = (await db.from('visitor_passes').select('*', { count: 'exact', head: true }).ilike('visiting_unit', `ZZVP-${STAMP}%`)).count
  chk('fixture cleaned up', left === 0, `${left} passes left`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ One live pass per plate+unit+property, even under concurrent submits.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
