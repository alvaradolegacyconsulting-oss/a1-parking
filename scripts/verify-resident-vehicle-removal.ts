// ════════════════════════════════════════════════════════════════════
// GATE — a resident removes their OWN vehicle, and only their own
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THE CASE THIS EXISTS FOR. update_my_vehicle_cosmetic scopes by
// UNIT: (property, unit) IN (the caller's resident rows). That is fine
// for a colour correction and catastrophic for removal — it would let
// one roommate delete another's car. deactivate_my_vehicle narrows to
// ownership AND current residency, and the only way to prove that is to
// stand up two residents at ONE unit and have one of them try.
//
// Structural gates cannot see this. The verification SQL checks that
// the predicate TEXT mentions resident_email; it cannot check that
// Postgres refuses. So this signs in as two real residents, over the
// real anon client, and calls the real RPC.
//
// Uses the live shared-unit shape: 13 units in production currently
// have more than one active resident, so this is the arrangement the
// feature actually meets, not an invented one.
//
// Everything it creates, it destroys — in a finally block, so a failed
// assertion still tears down.
//
// Usage: npx tsx scripts/verify-resident-vehicle-removal.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL')
const ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY'
const PROPERTY = 'Test Legacy Property'
const UNIT = `ZZGATE-${STAMP}`
const PW = `Zz!gate${STAMP}aQ`

let fails = 0
const chk = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

type Actor = { email: string; uid: string; client: ReturnType<typeof createClient> }

// 🔴 CLEANUP REGISTRY, not the actor variables.
//
// The first version tore down from A/B/M, which are only assigned once
// makeUser RETURNS. The captcha-gated signIn threw midway through
// makeUser('a') on 2026-10-06, so A was still null, the finally block
// skipped it, and a real auth user plus a real user_roles row were left
// in production. A teardown that depends on the success of the thing it
// is cleaning up after is not a teardown.
//
// Every created identity is registered the instant it exists.
const created: { email: string; uid: string }[] = []

async function makeUser(tag: string, role: 'resident' | 'manager'): Promise<Actor> {
  const email = `zz-rm-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, password: PW, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  created.push({ email, uid: data.user.id })
  const { error: rErr } = await db.from('user_roles').insert({
    email, role, company: COMPANY, property: [PROPERTY], is_active: true,
    ...(role === 'manager' ? { can_approve_vehicles: true } : {}),
  })
  if (rErr) throw new Error(`user_roles ${tag}: ${rErr.message}`)
  // Session via generateLink -> verifyOtp, not signInWithPassword.
  // Password sign-in is captcha-gated (post-B213 Turnstile toggle-on)
  // and a script has no captcha token; verifyOtp is not gated. Same
  // path scripts/b228-p3-role-bypass-check.ts and the /register
  // single-solve build use.
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { data: sess, error: sErr } = await client.auth.verifyOtp({
    token_hash: link.properties.hashed_token, type: 'magiclink',
  })
  if (sErr || !sess.session) throw new Error(`verifyOtp ${tag}: ${sErr?.message}`)
  return { email, uid: data.user.id, client }
}

async function makeResidentRow(email: string) {
  const { error } = await db.from('residents').insert({
    email, name: `ZZ Gate ${email}`, property: PROPERTY, unit: UNIT,
    company: COMPANY, is_active: true, status: 'active',
  })
  if (error) throw new Error(`residents ${email}: ${error.message}`)
}

async function makeVehicle(email: string, plate: string, status = 'active'): Promise<number> {
  const { data, error } = await db.from('vehicles').insert({
    plate, state: 'TX', property: PROPERTY, unit: UNIT, company: COMPANY,
    resident_email: email, status, is_active: status === 'active',
  }).select('id').single()
  if (error) throw new Error(`vehicles ${plate}: ${error.message}`)
  return data.id as number
}

const main = async () => {
  // ── Pre-flight: refuse to be green before the migration lands ─────
  // A "function does not exist" must read as NOT APPLIED, not as a
  // product failure and certainly not as a pass.
  const probe = await db.rpc('deactivate_my_vehicle', { p_vehicle_id: -1 })
  if (probe.error && /Could not find the function/i.test(probe.error.message)) {
    console.error('deactivate_my_vehicle does not exist — apply')
    console.error('  migrations/20261006_resident_vehicle_removal.sql  first.')
    console.error('  This is NOT a pass and NOT a failure of the feature.')
    process.exit(2)
  }

  let A: Actor | null = null, B: Actor | null = null, M: Actor | null = null
  let vA = 0, vA2 = 0, vB = 0

  try {
    A = await makeUser('a', 'resident')
    B = await makeUser('b', 'resident')
    M = await makeUser('m', 'manager')
    await makeResidentRow(A.email)
    await makeResidentRow(B.email)
    vA  = await makeVehicle(A.email, `ZZA${STAMP % 100000}`)
    vA2 = await makeVehicle(A.email, `ZZC${STAMP % 100000}`)
    vB  = await makeVehicle(B.email, `ZZB${STAMP % 100000}`)
    console.log(`fixture: unit ${UNIT} @ ${PROPERTY} — A=${A.email} (veh ${vA}, ${vA2})  B=${B.email} (veh ${vB})\n`)

    // ── 1. THE ROOMMATE CASE ──────────────────────────────────────
    const r1 = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vB })
    chk('A CANNOT deactivate B\'s vehicle at the same unit',
      !!r1.error && /not found or not yours/.test(r1.error.message),
      r1.error ? r1.error.message : `NO ERROR — returned ${JSON.stringify(r1.data)}`)

    const bStill = await db.from('vehicles').select('is_active, status').eq('id', vB).single()
    chk('B\'s vehicle is untouched', bStill.data?.is_active === true && bStill.data?.status === 'active',
      JSON.stringify(bStill.data))

    // ── 2. A removes their OWN ────────────────────────────────────
    const r2 = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vA })
    chk('A CAN deactivate their own vehicle',
      !r2.error && (r2.data as { action?: string })?.action === 'deactivated',
      r2.error ? r2.error.message : JSON.stringify(r2.data))

    const row = await db.from('vehicles')
      .select('is_active, status, deactivation_reason, deactivated_by, deactivated_at').eq('id', vA).single()
    chk('row is soft-deactivated with the right stamp',
      row.data?.is_active === false && row.data?.status === 'deactivated'
      && row.data?.deactivation_reason === 'resident_removed'
      && row.data?.deactivated_by === A.email && !!row.data?.deactivated_at,
      JSON.stringify(row.data))

    const aud = await db.from('audit_logs').select('id, user_email, action')
      .eq('action', 'RESIDENT_DEACTIVATE_VEHICLE').eq('user_email', A.email)
    chk('audit row written with the RESIDENT as actor', (aud.data?.length ?? 0) === 1,
      `${aud.data?.length ?? 0} row(s)`)

    // ── 3. Idempotent ─────────────────────────────────────────────
    const r3 = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vA })
    chk('second call is already_deactivated, not an error',
      !r3.error && (r3.data as { action?: string })?.action === 'already_deactivated',
      r3.error ? r3.error.message : JSON.stringify(r3.data))

    // ── 3b. A PENDING row is refused HONESTLY ─────────────────────
    // 🔴 2026-10-07. This used to return {ok:true,
    // action:'already_deactivated'} and touch nothing — a success
    // response for a no-op, because the idempotency branch keyed on
    // is_active=false, which is true of every pending row. Resident
    // withdrawal is ruled and queued; until it ships the refusal has to
    // say so rather than imply it worked.
    const vPending = await makeVehicle(A.email, `ZZP${STAMP % 100000}`, 'pending')
    const r3b = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vPending })
    chk('a PENDING row is refused with not_active, not a fake ok:true',
      !!r3b.error && /not_active/.test(r3b.error.message),
      r3b.error ? r3b.error.message : `NO ERROR — returned ${JSON.stringify(r3b.data)}`)
    const pendAfter = await db.from('vehicles').select('status, is_active, deactivation_reason').eq('id', vPending).single()
    chk('…and the pending row is untouched', pendAfter.data?.status === 'pending' && pendAfter.data?.deactivation_reason === null,
      JSON.stringify(pendAfter.data))

    // A genuinely deactivated row still reports already_deactivated —
    // the idempotency contract must survive the narrowing. (vA was
    // deactivated in step 2.)
    const r3c = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vA })
    chk('a genuinely deactivated row still returns already_deactivated',
      !r3c.error && (r3c.data as { action?: string })?.action === 'already_deactivated',
      r3c.error?.message ?? JSON.stringify(r3c.data))

    // ── 4. Deactivated resident gets the deactivated message ──────
    await db.from('residents').update({ is_active: false }).eq('email', A.email)
    const r4 = await A.client.rpc('deactivate_my_vehicle', { p_vehicle_id: vA2 })
    chk('a deactivated resident is told account_deactivated, NOT "not yours"',
      !!r4.error && /account_deactivated/.test(r4.error.message),
      r4.error ? r4.error.message : `NO ERROR — ${JSON.stringify(r4.data)}`)
    await db.from('residents').update({ is_active: true }).eq('email', A.email)

    // ── 5. A manager must NOT be able to claim the resident did it ─
    const r5 = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vB, p_reason: 'resident_removed', p_note: null })
    chk('manager CANNOT stamp resident_removed',
      (r5.data as { error?: string })?.error === 'system_reason_not_permitted',
      JSON.stringify(r5.data ?? r5.error?.message))

    // ── 6. …and deactivate_vehicle still WORKS (Part 2 didn't break it)
    // A positive control. A function that rejects everything would pass
    // check 5 and be completely broken.
    const r6 = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vB, p_reason: 'vehicle_sold', p_note: null })
    chk('manager CAN still deactivate with a legitimate reason',
      (r6.data as { ok?: boolean; action?: string })?.ok === true
      && (r6.data as { action?: string })?.action === 'deactivated',
      JSON.stringify(r6.data ?? r6.error?.message))

    // ── 7. The p_note default survived the replacement ────────────
    const vC = await makeVehicle(B.email, `ZZD${STAMP % 100000}`)
    const r7 = await M.client.rpc('deactivate_vehicle', { p_vehicle_id: vC, p_reason: 'vehicle_sold' })
    chk('deactivate_vehicle still callable with 2 args (p_note DEFAULT intact)',
      (r7.data as { ok?: boolean })?.ok === true,
      JSON.stringify(r7.data ?? r7.error?.message))
  } finally {
    // ── Teardown ──
    await db.from('audit_logs').delete().eq('action', 'RESIDENT_DEACTIVATE_VEHICLE')
      .in('user_email', created.length ? created.map(c => c.email) : [''])
    await db.from('vehicles').delete().eq('unit', UNIT).eq('property', PROPERTY)
    await db.from('residents').delete().eq('unit', UNIT).eq('property', PROPERTY)
    for (const a of created) {
      await db.from('user_roles').delete().ilike('email', a.email)
      await db.auth.admin.deleteUser(a.uid).catch(() => {})
    }
  }

  // Sweep orphans from any EARLIER aborted run of this gate. Scoped to
  // the zz-rm-*@test.invalid shape this script owns and nothing else.
  const { data: orphans } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orphans?.users ?? []).filter(u => /^zz-rm-[abm]-\d+@test\.invalid$/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
    console.log(`  swept orphan from an earlier run: ${o.email}`)
  }

  // Residue check — a green run must leave nothing behind.
  const leftV = (await db.from('vehicles').select('*', { count: 'exact', head: true }).eq('unit', UNIT)).count
  const leftR = (await db.from('residents').select('*', { count: 'exact', head: true }).eq('unit', UNIT)).count
  chk('fixture cleaned up', leftV === 0 && leftR === 0, `${leftV} vehicles, ${leftR} residents left`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ A resident can remove their own vehicle, and cannot touch a roommate\'s.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
