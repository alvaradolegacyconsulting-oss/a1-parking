// ════════════════════════════════════════════════════════════════════
// GATE — the identity helpers: deactivated loses access, and every
//        live role keeps exactly what it had
// ════════════════════════════════════════════════════════════════════
//
// 159 policies and 58 functions inherit get_my_role / get_my_company /
// get_my_properties. Adding `AND is_active` is one line that changes
// behaviour everywhere at once, so the only honest test is a
// before/after comparison with real sessions.
//
//   npm run verify:identityhelpers -- --baseline    BEFORE the migration
//   npm run verify:identityhelpers                  AFTER — compares
//
// 🔴 RUN THE BASELINE FIRST. A suite only run afterwards cannot tell
// you it was ever testing the right thing: "resident reads 5 rows" is
// meaningless unless yesterday it also read 5. Same discipline as the
// swift-handler suite.
//
// 🔴 THE POSITIVE CONTROLS ARE THE POINT. A helper that returned NULL
// for everyone would pass every "deactivated is refused" assertion in
// this file. One ACTIVE canary per role — all six that exist in
// production — is what proves the product still works.
//
// Canaries only, on Test-LEGACY. Never A1.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const BASELINE = 'docs/backlog/identity-helpers-baseline.json'
const RECORD = process.argv.includes('--baseline')
const CO = 'Test-LEGACY'
const PROP = 'Test Legacy Property'
const S = Date.now()
// Every role that exists in production: 349 resident, 15 manager,
// 8 company_admin, 6 driver, 3 leasing_agent, 1 admin.
const ROLES = ['admin', 'company_admin', 'manager', 'leasing_agent', 'driver', 'resident'] as const
// The tables most governed by the three helpers. Row COUNTS, never
// contents — a baseline file must not become a PII file.
const TABLES = ['residents', 'vehicles', 'properties', 'user_roles', 'visitor_passes', 'violations'] as const

// 🔴 WHAT A DEACTIVATED USER MAY STILL SEE: their OWN identity row,
// and nothing else.
//
// This is not a leniency, it is a requirement. /deactivated has to be
// able to tell the person their access was removed, and
// get_my_effective_active() reads user_roles and residents.is_active to
// decide that. A deactivated user who can read NOTHING gets a blank
// page or a login loop instead of an explanation — the exact outcome
// G7 in the SQL verification exists to prevent.
//
// The first version of this gate asserted "reads nothing it read
// before", which failed the correct outcome: a deactivated admin going
// from 388 user_roles rows to 1 is the fix working, and the assertion
// called it a leak. Worse, it would have PASSED a regression where the
// self-row became unreadable — so it was both wrong and blind in the
// one direction that breaks a user-facing path.
const SELF_MAX: Record<string, number> = { user_roles: 1, residents: 1 }

type Probe = { role: string | null; company: string | null; properties: string | null; reads: Record<string, number | string> }

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

const made: { uid: string | null; roleId: number; extra?: { table: string; id: number } }[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  for (const m of made) {
    if (m.extra) {
      const r = await db.from(m.extra.table).delete().eq('id', m.extra.id).select('id')
      if (r.error || (r.data ?? []).length !== 1) console.error(`   🔴 ${m.extra.table} ${m.extra.id} NOT removed`)
    }
    const r = await db.from('user_roles').delete().eq('id', m.roleId).select('id')
    if (r.error || (r.data ?? []).length !== 1) console.error(`   🔴 user_roles ${m.roleId} NOT removed`)
    if (m.uid) {
      await db.auth.admin.deleteUser(m.uid).catch(() => {})
      const back = await db.auth.admin.listUsers({ perPage: 1000 })
      if ((back.data?.users ?? []).some(u => u.id === m.uid)) { console.error(`   🔴 auth user ${m.uid} STILL PRESENT`); fails++ }
    }
  }
  for (const t of ['residents', 'drivers', 'user_roles'] as const) {
    const stray = await db.from(t).delete().ilike('email', 'zz-ih-%').select('id')
    if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray ${t} row(s)`)
  }
  console.log(`   ↩ removed ${made.length} canaries`)
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

async function canary(role: string, isActive: boolean) {
  const tag = `${role}-${isActive ? 'on' : 'off'}`
  const email = `zz-ih-${tag}-${S}@test.invalid`
  const { data: u, error } = await db.auth.admin.createUser({ email, password: `Zz!ih${S}q`, email_confirm: true })
  if (error || !u.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  const ins = await db.from('user_roles').insert({
    email, role, company: CO, property: [PROP], is_active: isActive,
  }).select('id').single()
  if (ins.error) throw new Error(`user_roles ${tag}: ${ins.error.message}`)
  const rec: typeof made[number] = { uid: u.user.id, roleId: ins.data.id as number }

  // A driver needs a drivers row and a resident a residents row, or
  // their own policies have nothing to match and every read is 0 for
  // the wrong reason.
  if (role === 'driver') {
    const d = await db.from('drivers').insert({
      email, name: `ZZ IH ${tag}`, company: CO, assigned_properties: [PROP],
      is_active: isActive, operator_license: 'N/A',
    }).select('id').single()
    if (d.error) throw new Error(`drivers ${tag}: ${d.error.message}`)
    rec.extra = { table: 'drivers', id: d.data.id as number }
  } else if (role === 'resident') {
    const r = await db.from('residents').insert({
      name: `ZZ IH ${tag}`, email, unit: '101', property: PROP, company: CO,
      is_active: isActive, status: isActive ? 'active' : 'deactivated',
    }).select('id').single()
    if (r.error) throw new Error(`residents ${tag}: ${r.error.message}`)
    rec.extra = { table: 'residents', id: r.data.id as number }
  }
  made.push(rec)

  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  const v = await c.auth.verifyOtp({ token_hash: link!.properties!.hashed_token!, type: 'magiclink' })
  if (v.error) throw new Error(`otp ${tag}: ${v.error.message}`)
  return c
}

async function probe(c: SupabaseClient): Promise<Probe> {
  const role = await c.rpc('get_my_role')
  const company = await c.rpc('get_my_company')
  const props = await c.rpc('get_my_properties')
  const reads: Record<string, number | string> = {}
  for (const t of TABLES) {
    const r = await c.from(t).select('*', { count: 'exact', head: true })
    // 🔴 A grant denial and an RLS filter are different answers and
    // must not collapse into "0". That conflation is how a broken
    // guard reads as a working one.
    reads[t] = r.error ? `refused:${r.error.code ?? 'err'}` : (r.count ?? 0)
  }
  return {
    role: (role.data as string | null) ?? null,
    company: (company.data as string | null) ?? null,
    properties: props.data ? JSON.stringify(props.data) : null,
    reads,
  }
}

const main = async () => {
  const current: Record<string, Probe> = {}
  try {
    for (const role of ROLES) {
      for (const isActive of [true, false]) {
        const c = await canary(role, isActive)
        current[`${role}:${isActive ? 'active' : 'deactivated'}`] = await probe(c)
      }
    }
  } catch (e) {
    console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2)
  }

  if (RECORD) {
    fs.writeFileSync(BASELINE, JSON.stringify({ recorded_at: new Date().toISOString(), probes: current }, null, 2) + '\n')
    console.log(`\n📋 BASELINE recorded to ${BASELINE} — ${Object.keys(current).length} role/state probes.`)
    for (const [k, p] of Object.entries(current)) {
      console.log(`   ${k.padEnd(28)} role=${JSON.stringify(p.role).padEnd(17)} reads=${JSON.stringify(p.reads)}`)
    }
    console.log(`\n🔴 This is the BEFORE picture. Apply the migration, then run without --baseline.`)
    await cleanup('end')
    process.exit(0)
  }

  if (!fs.existsSync(BASELINE)) {
    console.error(`🔴 ${BASELINE} does not exist. Run with --baseline BEFORE applying the migration.`)
    console.error(`   Refusing to run: with nothing to compare against, "deactivated reads 0" could always have been 0.`)
    await cleanup('end')
    process.exit(2)
  }
  const before = (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as { probes: Record<string, Probe> }).probes

  console.log('── 🔴 POSITIVE CONTROLS: every ACTIVE role keeps exactly what it had ──')
  for (const role of ROLES) {
    const k = `${role}:active`
    const b = before[k], a = current[k]
    if (!b) { chk(`${role} active — baseline present`, false, 'missing from the baseline file'); continue }
    chk(`${role.padEnd(14)} still resolves to its role`, a.role === b.role, `${JSON.stringify(b.role)} → ${JSON.stringify(a.role)}`)
    chk(`${''.padEnd(14)}   ...company and properties unchanged`,
      a.company === b.company && a.properties === b.properties,
      `${b.company}/${b.properties} → ${a.company}/${a.properties}`)
    const changed = TABLES.filter(t => String(a.reads[t]) !== String(b.reads[t]))
    chk(`${''.padEnd(14)}   ...reads identical on ${TABLES.length} tables`, changed.length === 0,
      changed.length ? `🔴 CHANGED: ${changed.map(t => `${t} ${b.reads[t]}→${a.reads[t]}`).join(', ')}` : JSON.stringify(a.reads))
  }

  console.log('\n── 🔴 THE POINT: every DEACTIVATED role loses its identity ──')
  for (const role of ROLES) {
    const k = `${role}:deactivated`
    const b = before[k], a = current[k]
    if (!b) { chk(`${role} deactivated — baseline present`, false, 'missing from the baseline file'); continue }
    chk(`${role.padEnd(14)} resolved to its role BEFORE (the defect, reproduced)`, b.role === role,
      `baseline role=${JSON.stringify(b.role)}`)
    chk(`${''.padEnd(14)}   ...and resolves to NULL now`, a.role === null, `now ${JSON.stringify(a.role)}`)
    chk(`${''.padEnd(14)}   ...company and properties also NULL`, a.company === null && a.properties === null,
      `${JSON.stringify(a.company)} / ${JSON.stringify(a.properties)}`)
    // 🔴 No TENANT data: every table down to its self-allowance.
    const leaks = TABLES.filter(t => typeof a.reads[t] === 'number'
      && (a.reads[t] as number) > (SELF_MAX[t] ?? 0))
    chk(`${''.padEnd(14)}   ...reads no tenant data at all`, leaks.length === 0,
      leaks.length
        ? `🔴 LEAKS: ${leaks.map(t => `${t}=${a.reads[t]} (max ${SELF_MAX[t] ?? 0})`).join(', ')}`
        : TABLES.map(t => `${t}=${a.reads[t]}`).join(' '))

    // ...and the reduction is real where there was something to lose.
    const lost = TABLES.filter(t => typeof b.reads[t] === 'number'
      && (b.reads[t] as number) > (SELF_MAX[t] ?? 0))
    chk(`${''.padEnd(14)}   ...and it LOST what it could see before`,
      lost.every(t => typeof a.reads[t] === 'number' && (a.reads[t] as number) <= (SELF_MAX[t] ?? 0)),
      lost.length ? `${lost.map(t => `${t} ${b.reads[t]}→${a.reads[t]}`).join(', ')}` : 'it had nothing beyond its own row to lose')

    // 🔴 THE INVERSE CONTROL, which the first version was blind to.
    // The self-row must SURVIVE. If user_roles drops to 0 the person
    // cannot be told they are deactivated — they get a login loop, and
    // "deactivated reads nothing" would have scored that as a pass.
    chk(`${''.padEnd(14)}   🔴 ...but can STILL read its own row (so /deactivated works)`,
      a.reads['user_roles'] === 1,
      `user_roles=${a.reads['user_roles']} — must be 1, not 0`)
  }

  await cleanup('end')
  console.log(`\n${fails === 0 ? '✅ all green — active roles unchanged, deactivated roles cut off' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
