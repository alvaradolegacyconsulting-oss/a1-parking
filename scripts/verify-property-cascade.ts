// ════════════════════════════════════════════════════════════════════
// GATE — property cascade: the nine controls
// ════════════════════════════════════════════════════════════════════
//
// 🔴 ON ITS OWN CANARY PROPERTIES, NEVER A REAL ONE. Deactivating a
// property deactivates its residents and vehicles, and reactivation
// deliberately does NOT restore them. Running this against
// "Test Legacy Property" would permanently deactivate 31 residents and
// 22 vehicles with no feature that puts them back. So the gate creates
// three properties, three sets of data, and deletes all of it.
//
// 🔴 POSITIVE CONTROLS ARE MOST OF THE LIST. A cascade that revoked
// NOBODY would pass every "is it refused" assertion in here. Control 2
// (the multi-property manager who must be KEPT) and control 5b (another
// property's residents untouched) are what prove it does the right
// amount of work rather than none or too much.
//
// 🔴 KNOWN COVERAGE GAP, ACCEPTED 2026-10-15 — control 6.
// The ban-failure REVERT path is covered by code reading, not by
// execution. setUserActive bans first, reads the ban back, and puts the
// login back exactly as it was if the is_active flip then fails; none
// of that is exercised here, because none of its failure branches can
// be reached from outside the request:
//
//   • a duplicate user_roles row is rejected by
//     user_roles_lower_email_uidx (lower(email)), 2026-07-04;
//   • the route re-plans at apply time, so a row mutated beforehand
//     just produces a different plan;
//   • deleting the auth user yields `no_auth_user`, a SUCCESS branch;
//   • the ban-API error and read-back-mismatch branches need fault
//     injection, and 🔴 NO FAULT-INJECTION SEAM GOES IN PRODUCTION
//     CODE (ruled) — a seam that reaches production is exactly the
//     class of thing that leaks.
//
// To revisit with Sweep #2 phase 4's test toolchain, where injection
// is confined to the harness. Until then this gate asserts the verdict
// FIELDS are computed from the per-user results (6a-6d) and does not
// claim the revert.
//
// Usage: npm run verify:cascade

import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3989
const BASE = `http://127.0.0.1:${PORT}`
const CO = 'Test-LEGACY'
const OTHER_CO = 'Demo Company'
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const propIds: number[] = []
const roleIds: number[] = []
const residentIds: number[] = []
const vehicleIds: number[] = []
const users: string[] = []
let server: ChildProcess | null = null
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  const del = async (t: string, ids: number[]) => {
    if (!ids.length) return
    const r = await db.from(t).delete().in('id', ids).select('id')
    if (r.error || (r.data ?? []).length !== ids.length) console.error(`   🔴 ${t}: removed ${(r.data ?? []).length}/${ids.length} ${r.error?.message ?? ''}`)
    else console.log(`   ↩ ${ids.length} ${t}`)
  }
  await del('vehicles', vehicleIds)
  await del('residents', residentIds)
  await del('user_roles', roleIds)
  // Belt: anything carrying the stamp, whatever created it.
  for (const [t, c] of [['vehicles', 'plate'], ['residents', 'email'], ['user_roles', 'email']] as const) {
    const stray = await db.from(t).delete().ilike(c, `%zzpc${S}%`).select('id')
    if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray ${t}`)
  }
  await del('properties', propIds)
  for (const uid of users) {
    await db.auth.admin.deleteUser(uid).catch(() => {})
  }
  const back = await db.auth.admin.listUsers({ perPage: 1000 })
  const left = (back.data?.users ?? []).filter(u => /zzpc/.test(u.email ?? ''))
  if (left.length) { console.error(`   🔴 ${left.length} auth user(s) STILL PRESENT`); fails++ }
  else if (users.length) console.log(`   ↩ ${users.length} auth users`)
  if (server && !server.killed) { server.kill('SIGTERM'); console.log('   ↩ stopped the server this gate started') }
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

const portBusy = () => new Promise<boolean>(res => {
  const s = net.createServer()
  s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false)))
  s.listen(PORT, '127.0.0.1')
})

async function mkProperty(label: string, isActive: boolean, company = CO) {
  const r = await db.from('properties').insert({ name: `ZZ PC ${label} ${S}`, company, is_active: isActive }).select('id,name').single()
  if (r.error) throw new Error(`property ${label}: ${r.error.message}`)
  propIds.push(r.data.id as number)
  return { id: r.data.id as number, name: r.data.name as string }
}

/** tag orders the plan: the route sorts by action then email. */
async function mkManager(tag: string, properties: string[], isActive = true, withAuth = true) {
  const email = `zzpc${S}-${tag}@test.invalid`
  if (withAuth) {
    const u = await db.auth.admin.createUser({ email, password: `Zz!pc${S}q`, email_confirm: true })
    if (u.error || !u.data.user) throw new Error(`createUser ${tag}: ${u.error?.message}`)
    users.push(u.data.user.id)
  }
  const r = await db.from('user_roles').insert({
    email, role: 'manager', company: CO, property: properties, is_active: isActive,
  }).select('id').single()
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  roleIds.push(r.data.id as number)
  return { email, roleId: r.data.id as number }
}

async function mkResidentAndCar(propName: string, tag: string) {
  const email = `zzpc${S}-res-${tag}@test.invalid`
  const r = await db.from('residents').insert({
    name: `ZZ PC ${tag}`, email, unit: '101', property: propName, company: CO, is_active: true, status: 'active',
  }).select('id').single()
  if (r.error) throw new Error(`resident ${tag}: ${r.error.message}`)
  residentIds.push(r.data.id as number)
  const v = await db.from('vehicles').insert({
    plate: `ZZPC${String(S).slice(-6)}${tag.toUpperCase().slice(0, 2)}`, state: 'TX',
    property: propName, company: CO, status: 'active', is_active: true, unit: '101', resident_email: email,
  }).select('id').single()
  if (v.error) throw new Error(`vehicle ${tag}: ${v.error.message}`)
  vehicleIds.push(v.data.id as number)
  return { residentId: r.data.id as number, vehicleId: v.data.id as number }
}

async function actor(tag: string, role: string, company = CO) {
  const email = `zzpc${S}-${tag}@test.invalid`
  const u = await db.auth.admin.createUser({ email, password: `Zz!pc${S}q`, email_confirm: true })
  if (u.error || !u.data.user) throw new Error(`createUser ${tag}: ${u.error?.message}`)
  users.push(u.data.user.id)
  const r = await db.from('user_roles').insert({
    email, role, company, property: [], is_active: true,
  }).select('id').single()
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  roleIds.push(r.data.id as number)
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  const v = await c.auth.verifyOtp({ token_hash: link!.properties!.hashed_token!, type: 'magiclink' })
  if (v.error) throw new Error(`otp ${tag}: ${v.error.message}`)
  return { email, session: { access_token: v.data.session!.access_token, refresh_token: v.data.session!.refresh_token } }
}

/** The cookie a real browser sends, serialized by the SDK itself. */
async function cookieFor(session: { access_token: string; refresh_token: string }) {
  const jar: { name: string; value: string }[] = []
  const c = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => jar,
      setAll: xs => { for (const x of xs) { const i = jar.findIndex(j => j.name === x.name); if (i >= 0) jar[i] = x; else jar.push({ name: x.name, value: x.value }) } },
    },
  })
  const r = await c.auth.setSession(session)
  if (r.error) throw new Error(`setSession: ${r.error.message}`)
  return jar.map(j => `${j.name}=${j.value}`).join('; ')
}

interface Line { type: string; [k: string]: unknown }
const call = async (cookie: string | null, body: object) => {
  const r = await fetch(`${BASE}/api/admin/property-active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body), redirect: 'manual',
  })
  const text = await r.text()
  const ct = r.headers.get('content-type') ?? ''
  if (ct.includes('ndjson')) {
    return { status: r.status, lines: text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Line), json: null as Record<string, unknown> | null }
  }
  let json: Record<string, unknown> | null = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, lines: [] as Line[], json }
}

const roleRow = async (id: number) =>
  (await db.from('user_roles').select('is_active, cascade_deactivated_by_property').eq('id', id).single()).data
const banned = async (email: string) => {
  const all = await db.auth.admin.listUsers({ perPage: 1000 })
  const u = (all.data?.users ?? []).find(x => (x.email ?? '').toLowerCase() === email.toLowerCase()) as { banned_until?: string } | undefined
  return !!u?.banned_until && new Date(u.banned_until).getTime() > Date.now()
}

const main = async () => {
  if (await portBusy()) {
    console.error(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  try {
    // ── fixtures ──────────────────────────────────────────────────
    const T = await mkProperty('TARGET', true)
    const SIB = await mkProperty('SIBLING-ACTIVE', true)
    const DEAD = await mkProperty('SIBLING-DEAD', false)
    const FOREIGN = await mkProperty('FOREIGN', true, OTHER_CO)
    console.log(`T=${T.id} ${T.name}\nSIB=${SIB.id} (active)  DEAD=${DEAD.id} (already inactive)  FOREIGN=${FOREIGN.id} [${OTHER_CO}]\n`)

    // emails are prefixed so the route's (action, email) sort is predictable
    const m1 = await mkManager('a-only',   [T.name])                 // revoke
    const m2 = await mkManager('b-multi',  [T.name, SIB.name])       // 🔴 KEEP
    const m3 = await mkManager('c-deadsib',[T.name, DEAD.name])      // 🔴 Finding B → revoke
    const m4 = await mkManager('d-indiv',  [T.name], false)          // already off, unstamped → skip
    const m5 = await mkManager('e-tail',   [T.name])                 // after the failure → must still process
    const m6 = await mkManager('f-subset', [T.name])                 // control 7

    const atT = await mkResidentAndCar(T.name, 'tgt')
    const atSib = await mkResidentAndCar(SIB.name, 'sib')

    const adm = await actor('adm', 'admin')
    const caOther = await actor('ca-other', 'company_admin', OTHER_CO)

    // ── server ────────────────────────────────────────────────────
    console.log(`starting next dev on ${PORT}…`)
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], { env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'pipe'] })
    server.stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`   [server] ${s}`) })
    const until = Date.now() + 90_000
    let up = false
    while (Date.now() < until && !up) {
      try { const r = await fetch(`${BASE}/api/admin/property-active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' }); up = r.status > 0 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 700))
    }
    if (!up) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    const admCookie = await cookieFor(adm.session)
    const otherCookie = await cookieFor(caOther.session)

    // ── CONTROL 8 — who may call it ───────────────────────────────
    console.log('── control 8: authority ──')
    const anon = await call(null, { property_id: T.id, active: false, mode: 'plan' })
    chk('8a. anon refused', [401, 302, 307].includes(anon.status), `HTTP ${anon.status}`)
    const xco = await call(otherCookie, { property_id: T.id, active: false, mode: 'plan' })
    chk(`8b. a ${OTHER_CO} company_admin refused on a ${CO} property`,
      xco.status === 403 && xco.json?.error === 'property_not_in_scope', `HTTP ${xco.status} ${xco.json?.error ?? ''}`)

    // ── THE PLAN ──────────────────────────────────────────────────
    console.log('\n── the plan (read-only) ──')
    const plan = await call(admCookie, { property_id: T.id, active: false, mode: 'plan' })
    chk('plan returns 200', plan.status === 200 && plan.json?.ok === true, `HTTP ${plan.status} ${JSON.stringify(plan.json?.error ?? '')}`)
    const users_ = (plan.json?.users ?? []) as { email: string; action: string; reason: string }[]
    const act = (email: string) => users_.find(u => u.email === email.toLowerCase())
    for (const u of users_) console.log(`     ${u.action.padEnd(7)} ${u.email.replace(`zzpc${S}-`, '')}  — ${u.reason}`)

    chk('1a. the single-property manager is planned REVOKE', act(m1.email)?.action === 'revoke', JSON.stringify(act(m1.email)))
    chk('2a. 🔴 the MULTI-property manager is planned KEEP', act(m2.email)?.action === 'keep', JSON.stringify(act(m2.email)))
    chk('3a. 🔴 FINDING B: the manager whose OTHER property is already inactive is planned REVOKE',
      act(m3.email)?.action === 'revoke',
      `${JSON.stringify(act(m3.email))} — the old filter counted array length only and would have KEPT them with zero active properties`)
    chk('4a. the already-deactivated manager is planned SKIP', act(m4.email)?.action === 'skip', JSON.stringify(act(m4.email)))
    chk('plan counts residents and vehicles at this property',
      plan.json?.residents_to_change === 1 && plan.json?.vehicles_to_change === 1,
      `residents=${plan.json?.residents_to_change} vehicles=${plan.json?.vehicles_to_change}`)

    // ── CONTROL 6 — 🔴 NOT INDUCIBLE. See the header and the report.
    // The planned induction was a second user_roles row for one email,
    // making the flip match 2 rows instead of 1. It is IMPOSSIBLE:
    //   CREATE UNIQUE INDEX user_roles_lower_email_uidx
    //     ON public.user_roles (lower(email));            -- 2026-07-04
    // rejects it with 23505. One email, one role is enforced by
    // CONSTRUCTION, not merely by practice.
    //
    // Nothing else in setUserActive's failure set is settable from
    // outside the request: the route re-plans at apply time, so a row
    // changed beforehand simply produces a different plan; deleting the
    // auth user yields `no_auth_user`, which is a SUCCESS branch; and
    // the ban-API error and read-back-mismatch branches cannot be
    // forced without a fault-injection seam in production code.
    //
    // So this gate does NOT claim control 6. What it asserts instead is
    // the SHAPE of the success path — that ok, failed and retry are
    // actually computed from the per-user results rather than hardcoded
    // — and the report says plainly what is left covered by reading.

    // ── APPLY (deactivate) ────────────────────────────────────────
    console.log('\n── apply: deactivate (streamed) ──')
    const run = await call(admCookie, { property_id: T.id, active: false, mode: 'apply' })
    const userLines = run.lines.filter(l => l.type === 'user')
    const done = run.lines.find(l => l.type === 'done')
    for (const l of userLines) console.log(`     ${l.ok ? '✓' : '✗'} ${String(l.email).replace(`zzpc${S}-`, '').padEnd(12)} ${l.action}  ${l.detail}`)
    chk('the apply streams one line per user, in order',
      userLines.length > 0 && userLines.every((l, i) => l.done === i + 1),
      `${userLines.length} user lines; done counters ${userLines.map(l => l.done).join(',')}`)

    chk('1b. the single-property manager is deactivated', (await roleRow(m1.roleId))?.is_active === false)
    chk('1c. 🔴 ...and really banned', await banned(m1.email))
    chk('1d. ...and carries THIS property\'s stamp',
      (await roleRow(m1.roleId))?.cascade_deactivated_by_property === T.id,
      `stamp=${JSON.stringify((await roleRow(m1.roleId))?.cascade_deactivated_by_property)}`)

    chk('2b. 🔴 the MULTI-property manager is untouched', (await roleRow(m2.roleId))?.is_active === true)
    chk('2c. 🔴 ...and NOT banned — they still have an active property', !(await banned(m2.email)))

    chk('3b. 🔴 FINDING B: the dead-sibling manager IS deactivated', (await roleRow(m3.roleId))?.is_active === false)
    chk('3c. ...and banned', await banned(m3.email))

    chk('5a. residents at this property are deactivated',
      (await db.from('residents').select('is_active').eq('id', atT.residentId).single()).data?.is_active === false)
    chk('5b. 🔴 residents at ANOTHER property are untouched',
      (await db.from('residents').select('is_active').eq('id', atSib.residentId).single()).data?.is_active === true)
    chk('5c. vehicles at this property are deactivated',
      (await db.from('vehicles').select('is_active').eq('id', atT.vehicleId).single()).data?.is_active === false)
    chk('5d. 🔴 vehicles at ANOTHER property are untouched',
      (await db.from('vehicles').select('is_active').eq('id', atSib.vehicleId).single()).data?.is_active === true)
    chk('5e. the property itself is inactive',
      (await db.from('properties').select('is_active').eq('id', T.id).single()).data?.is_active === false)

    // 🔴 6 (PARTIAL — the verdict fields are wired; the failure path is
    // not inducible, see above and the report).
    const failedList = (done?.failed ?? []) as string[]
    chk('6a. every user in the plan was attempted', userLines.length === 4,
      `${userLines.length} attempted; expected the 4 revokes (keep and skip are not attempted)`)
    chk('6b. ok is TRUE only because every user succeeded', done?.ok === true && failedList.length === 0,
      `ok=${done?.ok} failed=${JSON.stringify(failedList)}`)
    chk('6c. the verdict carries a retry set, computed and empty',
      Array.isArray(done?.retry) && (done?.retry as string[]).length === 0,
      `retry=${JSON.stringify(done?.retry)} — populated from the per-user results, so a failure would land here`)
    chk('6d. users later in the list were processed, not just the first',
      (await roleRow(m5.roleId))?.is_active === false && (await roleRow(m6.roleId))?.is_active === false,
      'sequential processing reaches the tail of the list')

    // ── CONTROL 7 — the retry MECHANISM, proven directly ──────────
    // Retry-failed is `only_emails`, so what has to be true is that
    // only_emails SCOPES the run. Proven without needing a failure:
    // reactivate everyone, then deactivate again naming ONE user, and
    // assert the others were not touched. If only_emails were ignored,
    // a "retry one user" would silently re-run the whole cascade.
    console.log('\n── control 7: only_emails scopes the run (the retry mechanism) ──')
    const reactAll = await call(admCookie, { property_id: T.id, active: true, mode: 'apply' })
    chk('7a. everyone the cascade took is restored first', reactAll.lines.find(l => l.type === 'done')?.ok === true)
    const one = await call(admCookie, { property_id: T.id, active: false, mode: 'apply', only_emails: [m6.email.toLowerCase()] })
    const oneUsers = one.lines.filter(l => l.type === 'user')
    chk('7b. 🔴 naming ONE user processes exactly one', oneUsers.length === 1 && oneUsers[0].email === m6.email.toLowerCase(),
      `${oneUsers.length} processed: ${JSON.stringify(oneUsers.map(l => l.email))}`)
    chk('7c. 🔴 ...and the others are NOT touched', (await roleRow(m1.roleId))?.is_active === true,
      'if only_emails were ignored, retrying one user would silently re-run the whole cascade')
    chk('7d. the named user is deactivated and banned',
      (await roleRow(m6.roleId))?.is_active === false && await banned(m6.email))
    // put the property and m6 back so the reactivate section below
    // tests what it means to test
    await call(admCookie, { property_id: T.id, active: false, mode: 'apply' })

    // ── APPLY (reactivate) ────────────────────────────────────────
    console.log('\n── apply: reactivate ──')
    const back = await call(admCookie, { property_id: T.id, active: true, mode: 'apply' })
    const backUsers = back.lines.filter(l => l.type === 'user')
    const backStart = back.lines.find(l => l.type === 'start')
    for (const l of backUsers) console.log(`     ${l.ok ? '✓' : '✗'} ${String(l.email).replace(`zzpc${S}-`, '').padEnd(12)} ${l.action}  ${l.detail}`)

    chk('the cascade restores the users it took', (await roleRow(m1.roleId))?.is_active === true)
    chk('   ...and unbans them', !(await banned(m1.email)))
    chk('   ...and clears the stamp', (await roleRow(m1.roleId))?.cascade_deactivated_by_property === null)

    // 🔴 CONTROL 4 — class 15. m4 was deactivated by nobody's cascade.
    const skipped = (backStart?.skipped ?? []) as { email: string; action: string; reason: string }[]
    const m4skip = skipped.find(s => s.email === m4.email.toLowerCase())
    chk('4b. 🔴 CLASS 15: the individually-deactivated manager is SKIPPED, not restored',
      (await roleRow(m4.roleId))?.is_active === false,
      'reactivating a property must not restore someone it never deactivated')
    chk('4c. ...and the skip says WHY', /deactivated separately/.test(m4skip?.reason ?? ''), JSON.stringify(m4skip))

    chk('9a. 🔴 reactivation does NOT restore residents (deliberate, disclosed)',
      (await db.from('residents').select('is_active').eq('id', atT.residentId).single()).data?.is_active === false)
    chk('9b. 🔴 ...nor vehicles', (await db.from('vehicles').select('is_active').eq('id', atT.vehicleId).single()).data?.is_active === false)
    chk('9c. ...but the property is active again',
      (await db.from('properties').select('is_active').eq('id', T.id).single()).data?.is_active === true)

    // ── the lookup's other branch, measured ───────────────────────
    // A genuine ban-API failure is not inducible without a test seam
    // (see the report). This is the lookup branch that IS: no auth user
    // at all must report no_auth_user and count as a SUCCESS.
    console.log('\n── the no-auth-user branch (the part of control 6 that IS about the ban) ──')
    const noAuth = await mkManager('g-noauth', [T.name], true, false)
    const run2 = await call(admCookie, { property_id: T.id, active: false, mode: 'apply', only_emails: [noAuth.email.toLowerCase()] })
    const l2 = run2.lines.find(l => l.type === 'user')
    const d2 = run2.lines.find(l => l.type === 'done')
    chk('a user with NO auth user reports no_auth_user and SUCCEEDS',
      l2?.ok === true && /no_auth_user/.test(String(l2?.detail)) && d2?.ok === true,
      `${JSON.stringify(l2?.detail)} ok=${d2?.ok}`)

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
