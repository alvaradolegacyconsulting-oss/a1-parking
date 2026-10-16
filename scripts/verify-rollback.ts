// ════════════════════════════════════════════════════════════════════
// GATE — same-day rollback, on batch 8
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16: same-day, all-or-nothing, refuses if anyone has
// claimed (listing them), refuses if anything references the rows,
// no partial rollback and no auth-user deletion.
//
// 🔴 IT REACHES A LOADED STATE AND DOES NOT RE-PROVE THE LOAD.
// verify:loader already asserts the load in 42 checks. Copying those
// here would be two gates drifting apart over the same behaviour, so
// this one loads via the RPC as the operator — the shortest honest path
// to the state under test — and spends its assertions on the undo.
//
// 🔴 THE REFUSALS ARE EXERCISED BY CONSTRUCTION, NOT BY SIMULATION.
// Same-day is tested by moving loaded_at back a day and restoring it.
// "Already claimed" is tested by actually claiming one of the loaded
// residents. Dependents are tested by inserting a real referencing row
// into whichever table the discovery walk found, and removing it.
// Each one is built, measured, and taken down again.
//
// Usage: npm run verify:rollback

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'
import { parseBulkCsv, BULK_CSV_COLUMNS } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3999
const BASE = `http://127.0.0.1:${PORT}`
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
const str = (v: unknown, n = 220) => (JSON.stringify(v) ?? 'undefined').slice(0, n)

let srv: DevServer | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
const claimUids: string[] = []
const claimRoleEmails: string[] = []
// A dependent row this gate built to exercise the refusal. If the run
// dies between creating it and removing it, the rollback it blocks is
// the LEAST of the problems — but it would also make the next run's
// happy path fail for a reason that is this gate's fault.
const depRows: { table: string; id: unknown }[] = []
// Probe rows in the VALUE-referenced tables. They have no FK to the
// batch, so nothing in the database would stop them outliving this run
// — only this list does.
const valueRows: { table: string; id: number }[] = []
// 🔴 RESTORE WHAT WAS THERE, NOT `false`.
// These gates used to refuse outright if the flag was already on,
// because they restored it to false and that would be the wrong value
// to leave. That made them unrunnable exactly when they were most
// wanted: during a UAT window where the ruling is that the flag STAYS
// ON. The refusal was protecting a wrong assumption rather than the
// tenant.
// Snapshotting the original and putting it back makes the gate
// transparent to whatever state it found — which is what "restore"
// always meant.
let flaggedCompany: number | null = null
let flagWas: boolean | null = null
let batchSnapshot: Record<string, unknown> | null = null
let batchId = 0
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)
  // The dependent row first: while it exists, every delete below that
  // touches vehicles is blocked by its own FK.
  for (const d of depRows) {
    const r = await db.from(d.table as 'vehicle_plate_changes').delete().eq('id', d.id as number).select('id')
    if (r.error) { warn(`   🔴 could not remove the probe dependent in ${d.table}: ${r.error.message}`); fails++ }
    else say(`   ↩ removed ${(r.data ?? []).length} probe row(s) from ${d.table}`)
  }
  for (const v of valueRows) {
    const r = await db.from(v.table as 'violations').delete().eq('id', v.id).select('id')
    if (r.error) { warn(`   🔴 could not remove the probe row in ${v.table}: ${r.error.message}`); fails++ }
    else say(`   ↩ removed ${(r.data ?? []).length} probe row(s) from ${v.table}`)
  }
  // Records next — they sit at a property a demo CA can open.
  if (batchId) {
    for (const t of ['vehicles', 'user_roles', 'residents'] as const) {
      const r = await db.from(t).delete().eq('import_batch_id', batchId).select('id')
      if (r.error) { warn(`   🔴 ${t}: ${r.error.message}`); fails++ }
      else if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} ${t} row(s) stamped with batch ${batchId}`)
    }
  }
  if (claimRoleEmails.length) {
    const r = await db.from('user_roles').delete().in('email', claimRoleEmails).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} unstamped role row(s)`)
  }
  for (const uid of claimUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete claimed auth user ${uid}`); fails++ }
  }
  if (claimUids.length) say(`   ↩ deleted ${claimUids.length} auth user(s) the claim created`)
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} actor role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} actor auth user(s)`)
  if (flaggedCompany !== null) {
    const want = flagWas === true
    const r = await db.from('companies').update({ bulk_onboarding_enabled: want })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== want) { warn(`   🔴 FLAG NOT RESTORED`); fails++ }
    else say(`   ↩ bulk_onboarding_enabled back to ${want} on company ${flaggedCompany} (as found)`)
  }
  if (batchSnapshot && batchId) {
    const want = {
      status: batchSnapshot.status,
      approved_by: batchSnapshot.approved_by, approved_at: batchSnapshot.approved_at,
      loaded_at: null, loaded_by: null,
      loaded_resident_count: null, loaded_vehicle_count: null,
    }
    const r = await db.from('import_batches').update(want).eq('id', batchId)
      .select('status,loaded_at').maybeSingle()
    if (r.error || r.data?.status !== want.status || r.data?.loaded_at !== null) {
      warn(`   🔴 BATCH ${batchId} NOT RESTORED — reads ${str(r.data)}`); fails++
    } else say(`   ↩ batch ${batchId} restored to status=${want.status}`)
  }
  if (batchId) {
    const r = await db.from('audit_logs').delete()
      .eq('table_name', 'import_batches').eq('record_id', String(batchId))
      .gte('created_at', new Date(S - 60_000).toISOString()).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} audit row(s) from this run`)
  }
  if (srv) { await srv.stop(); srv = null; say('   ↩ stopped the server this gate started (whole process group)') }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  warn(`🔴 uncaught: ${(e as Error).message}`)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

type Actor = { email: string; cookie: string; client: SupabaseClient }
async function actor(label: string, role: string, company: string | null, property: string[]): Promise<Actor> {
  const email = `zz-rb-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company, property, is_active: true }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  const { cookie, accessToken } = await cookieHeaderFor(db, URL_, ANON, email)
  return { email, cookie, client: createClient(URL_, ANON, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken}` } } }) }
}

const post = (path: string, body: unknown, a?: Actor) => fetch(`${BASE}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(a ? { Cookie: a.cookie } : {}) },
  body: JSON.stringify(body),
})
const js = async (r: Response) => { try { return JSON.parse(await r.text()) as Record<string, any> } catch { return {} } }

const main = async () => {
  if (await portBusy(PORT)) {
    warn(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  const { data: cos } = await db.from('companies')
    .select('id,name,company_env,bulk_onboarding_enabled').eq('company_env', 'demo')
  const demo = (cos ?? [])[0]
  if (!demo) { warn("🔴 no demo company. Refusing."); process.exit(2) }
  const { data: batch } = await db.from('import_batches').select('*')
    .eq('company_id', demo.id).order('id').limit(1).maybeSingle()
  if (!batch) { warn('🔴 no batch at the demo company. Run npm run seed:demobatch first.'); process.exit(2) }
  batchId = Number(batch.id); batchSnapshot = { ...batch }
  if (batch.status !== 'submitted') {
    warn(`🔴 batch ${batchId} is '${batch.status}', not 'submitted'. Refusing: restoring from an unexpected start would write the wrong value back.`)
    process.exit(2)
  }
  const { data: prop } = await db.from('properties').select('id,name').eq('id', batch.property_id).maybeSingle()
  const propName = String(prop!.name)

  const ping = await db.rpc('rollback_import_batch', { p_batch_id: -1 })
  if (ping.error) {
    warn(`🔴 rollback_import_batch is not callable: ${ping.error.message}`)
    warn('   Apply docs/backlog/wip-20261016_rollback.sql first.')
    process.exit(2)
  }
  // 🔴 And the value-dependent half. Without it the FK-only rollback
  // happily removes a batch that has a post-load violation or a guest
  // authorization against it — measured 2026-10-16, when this gate ran
  // against the applied FK-only version and watched it roll back
  // through both. Refusing beats reporting seven reds that all have
  // one cause.
  const ping2 = await db.rpc('import_batch_value_dependents')
  if (ping2.error) {
    warn(`🔴 import_batch_value_dependents() is not callable: ${ping2.error.message}`)
    warn('   Apply docs/backlog/wip-20261016_rollback_value_dependents.sql first.')
    warn('   Until it is applied, rollback checks only the 3 foreign keys and will')
    warn('   remove a batch while leaving a violation, a guest authorization, a space')
    warn('   assignment or a dispute pointing at rows that no longer exist.')
    process.exit(2)
  }

  const count = async (t: 'residents' | 'vehicles' | 'user_roles') => {
    const { count: c } = await db.from(t).select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
    return c ?? 0
  }
  const propCount = async (t: 'residents' | 'vehicles') => {
    const { count: c } = await db.from(t).select('*', { count: 'exact', head: true }).eq('property', propName)
    return c ?? 0
  }
  const resBase = await propCount('residents'), vehBase = await propCount('vehicles')
  say(`subject: batch ${batchId} · ${propName} · ${demo.name}`)
  say(`baseline: ${resBase} residents, ${vehBase} vehicles\n`)

  try {
    const admin = await actor('adm', 'admin', null, [])
    const mgr = await actor('mgr', 'manager', demo.name, [propName])

    srv = await startDevServer(PORT, { env: { TURNSTILE_SECRET_KEY: TEST_SECRET, NODE_ENV: 'development' } })
    if (!srv) { warn('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    say('server up\n')

    const setFlag = async (on: boolean) => {
      const r = await db.from('companies').update({ bulk_onboarding_enabled: on })
        .eq('id', demo.id).select('bulk_onboarding_enabled')
      if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== on) throw new Error(`could not set the flag to ${on}`)
      if (on) flaggedCompany = demo.id as number
    }
    await setFlag(true)

    // ── reach a loaded state ───────────────────────────────────────
    console.log('── reaching a loaded state (verify:loader proves the load itself) ──')
    const ap = await js(await post('/api/admin/import-batch/approve', { batch_id: batchId }, admin))
    chk('approved', ap.ok === true, str(ap, 120))
    const ld = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
    chk('loaded', ld.ok === true && ld.residents === 228 && ld.vehicles === 358,
      `${ld.residents}/${ld.vehicles}/${ld.roles}`)

    // ── 🔴 who cannot roll back ────────────────────────────────────
    console.log('\n── 🔴 who cannot roll back ──')
    const mgrR = await post('/api/admin/import-batch/rollback', { batch_id: batchId }, mgr)
    chk('a manager is refused by the route', mgrR.status === 403, `HTTP ${mgrR.status}`)
    const mgrRpc = await mgr.client.rpc('rollback_import_batch', { p_batch_id: batchId })
    chk('🔴 ...and by the RPC with the route bypassed',
      (mgrRpc.data as Record<string, unknown> | null)?.error === 'not_operator', str(mgrRpc.data ?? mgrRpc.error))
    const anonR = await post('/api/admin/import-batch/rollback', { batch_id: batchId })
    chk('anonymous is refused', anonR.status === 307 || anonR.status === 401, `HTTP ${anonR.status}`)

    // ── 🔴 NOT SAME DAY — the property's day, not the server's ─────
    console.log('\n── 🔴 same day means the PROPERTY\'s day ──')
    const realLoadedAt = (await db.from('import_batches').select('loaded_at').eq('id', batchId).maybeSingle()).data?.loaded_at
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    await db.from('import_batches').update({ loaded_at: yesterday }).eq('id', batchId)
    const stale = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('🔴 a batch loaded on an earlier day is refused',
      stale.error === 'not_same_day',
      `${str(stale, 200)}`)
    chk('   ...naming the day it was loaded and today, both in Central',
      !!stale.loaded_on && !!stale.today && stale.loaded_on !== stale.today,
      `loaded_on=${stale.loaded_on} today=${stale.today}`)
    chk('   ...and nothing was removed', (await count('residents')) === 228, `${await count('residents')} stamped`)
    await db.from('import_batches').update({ loaded_at: realLoadedAt }).eq('id', batchId)
    const backSame = await db.from('import_batches').select('loaded_at').eq('id', batchId).maybeSingle()
    chk('   (control) the real load time is restored, so today counts again',
      backSame.data?.loaded_at === realLoadedAt, `${backSame.data?.loaded_at}`)

    // ── 🔴 A DEPENDENT REFUSES THE WHOLE ROLLBACK ──────────────────
    // Built against whichever table the discovery walk finds, rather
    // than a table this gate assumes exists.
    console.log('\n── 🔴 a dependent row refuses the rollback ──')
    const { data: oneVeh } = await db.from('vehicles').select('id,plate,property,company,resident_email')
      .eq('import_batch_id', batchId).limit(1).maybeSingle()
    let depMade: { table: string; id: unknown } | null = null
    // 🔴 vehicle_plate_changes, NOT violations. The first version of
    // this gate used violations and the insert would have failed:
    // violations has no vehicle_id at all — enforcement matches on
    // PLATE TEXT, so it never was a referencing table. Measured, not
    // assumed.
    //
    // The three relationships that genuinely reference vehicles are
    //   vehicle_plate_changes.vehicle_id   ON DELETE CASCADE
    //   vehicle_parking_tags.vehicle_id    ON DELETE CASCADE
    //   spaces.designated_vehicle_id       ON DELETE SET NULL
    // and all three are exactly why the refusal matters: without it a
    // rollback would silently destroy plate-change history and tag
    // assignments, and quietly detach a space's designated vehicle.
    // None of that is an undo.
    //
    // The CASCADE one is used here because it is the case where the
    // damage would be invisible — no error, just missing history.
    const tryDep = await db.from('vehicle_plate_changes').insert({
      vehicle_id: oneVeh!.id, property: oneVeh!.property,
      old_plate: String(oneVeh!.plate).slice(0, 12), new_plate: 'ZZPROBE1',
      status: 'pending', submitted_by: String(oneVeh!.resident_email),
    }).select('id').maybeSingle()
    if (!tryDep.error && tryDep.data?.id) {
      depMade = { table: 'vehicle_plate_changes', id: tryDep.data.id }
      depRows.push(depMade)
      const dep = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
      chk('🔴 the rollback is refused because something references a batch row',
        dep.error === 'has_dependents', str(dep, 240))
      chk('   ...naming the table and the row count, not just a refusal',
        Array.isArray(dep.blockers) && dep.blockers.length > 0 && Number(dep.blockers[0]?.rows) > 0,
        str(dep.blockers))
      chk('   ...and nothing was removed', (await count('residents')) === 228, `${await count('residents')} stamped`)
      const rm = await db.from('vehicle_plate_changes').delete().eq('id', depMade.id).select('id')
      chk('   (control) the dependent is removed, so the rollback can proceed',
        (rm.data ?? []).length === 1, `${(rm.data ?? []).length} removed`)
      depMade = null
      depRows.length = 0
    } else {
      chk('a dependent row could be created to test the refusal', false,
        `🔴 could not insert into vehicle_plate_changes: ${tryDep.error?.message}. The dependent refusal is UNTESTED by this gate — the function discovers referencing tables from pg_constraint, so it is not wrong, but this assertion did not exercise it.`)
    }

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE EIGHT VALUE REFERENCES — the ones an FK walk is blind to
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 🔴 the value-dependent list is counted, not assumed ──')
    const listed = await db.rpc('import_batch_value_dependents')
    const listRows = (listed.data as { tbl: string; key_kind: string; scope_kind: string }[] | null) ?? []
    chk('🔴 the list holds exactly 8 entries',
      !listed.error && listRows.length === 8,
      listed.error ? listed.error.message : listRows.map(d => d.tbl).join(', '))
    chk('   ...six by resident address, two by plate since the load',
      listRows.filter(d => d.key_kind === 'resident_email').length === 6
      && listRows.filter(d => d.scope_kind === 'property_since_load').length === 2,
      `${listRows.filter(d => d.key_kind === 'resident_email').length} by address, ${listRows.filter(d => d.scope_kind === 'property_since_load').length} since-load`)
    // 🔴 THIS PASSED FOR THE WRONG REASON on the first run. With the
    // list empty — the migration unapplied — "none of these are on it"
    // is trivially true. An exclusion assertion has to require the list
    // to be populated first, or absence proves itself.
    chk('🔴 ...and visitor_passes and authorized_plates are NOT on it',
      listRows.length === 8
      && !listRows.some(d => ['visitor_passes', 'authorized_plates', 'audit_logs'].includes(d.tbl)),
      listRows.length !== 8
        ? `🔴 cannot conclude: the list holds ${listRows.length} entries, so "not present" proves nothing`
        : 'ruled independent: a pass belongs to a visitor and a plate list is configuration, so neither came to exist because a vehicle row did')

    const loadedAt = String((await db.from('import_batches').select('loaded_at').eq('id', batchId).maybeSingle()).data?.loaded_at)
    const anImportedPlate = String((await db.from('vehicles').select('plate')
      .eq('import_batch_id', batchId).limit(1).maybeSingle()).data?.plate)
    const anImportedEmail = String((await db.from('residents').select('email')
      .eq('import_batch_id', batchId).limit(1).maybeSingle()).data?.email)

    // ── 🔴 (1) a violation written AFTER the load blocks ────────────
    console.log('\n── 🔴 a violation on an imported plate, written since the load ──')
    const vPost = await db.from('violations').insert({
      plate: anImportedPlate, property: propName, violation_type: 'zz probe post-load',
      created_at: new Date(new Date(loadedAt).getTime() + 60_000).toISOString(),
    }).select('id').maybeSingle()
    if (vPost.error) throw new Error(`post-load violation probe: ${vPost.error.message}`)
    valueRows.push({ table: 'violations', id: vPost.data!.id as number })
    const blockedByViolation = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('🔴 the rollback is refused — an FK walk would never have seen this',
      blockedByViolation.error === 'has_dependents', str(blockedByViolation, 200))
    chk('   ...and names violations with its key and row count',
      (blockedByViolation.blockers ?? []).some((b: Record<string, unknown>) =>
        String(b.table).includes('violations') && Number(b.rows) === 1),
      str(blockedByViolation.blockers))
    chk('   ...and nothing was removed', (await count('residents')) === 228, `${await count('residents')} stamped`)
    const rmPost = await db.from('violations').delete().eq('id', vPost.data!.id).select('id')
    valueRows.length = 0
    chk('   (control) with it removed, the rollback is unblocked again',
      (rmPost.data ?? []).length === 1, `${(rmPost.data ?? []).length} removed`)

    // ── 🔴 (2) a violation written BEFORE the load does NOT block ───
    // A plate was in the lot before it was loaded. A ticket from last
    // week never referred to the vehicle row, so it is not a dependent
    // of the batch — and without the time scope it would block the undo
    // of a load it predates.
    console.log('\n── 🔴 a violation on the SAME plate, written before the load ──')
    const vPre = await db.from('violations').insert({
      plate: anImportedPlate, property: propName, violation_type: 'zz probe pre-load',
      created_at: new Date(new Date(loadedAt).getTime() - 7 * 24 * 3600_000).toISOString(),
    }).select('id,created_at').maybeSingle()
    if (vPre.error) throw new Error(`pre-load violation probe: ${vPre.error.message}`)
    valueRows.push({ table: 'violations', id: vPre.data!.id as number })
    const preCheck = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('🔴 it does NOT block — same plate, same property, but it predates the load',
      preCheck.error !== 'has_dependents',
      `${str(preCheck, 180)} — created ${vPre.data?.created_at} vs loaded ${loadedAt}`)
    // That call may have ROLLED THE BATCH BACK. Put it back if so.
    const afterPre = (await db.from('import_batches').select('status').eq('id', batchId).maybeSingle()).data?.status
    chk('   ...it went through, which is the assertion', afterPre === 'rolled_back' || preCheck.ok === true,
      `status=${afterPre}`)
    const rmPre = await db.from('violations').delete().eq('id', vPre.data!.id).select('id')
    valueRows.length = 0
    chk('   (the pre-load probe is removed)', (rmPre.data ?? []).length === 1)

    // 🔴 The rollback just succeeded, so re-load to carry on testing
    // the remaining refusals against a loaded batch.
    if (afterPre === 'rolled_back') {
      chk('🔴 and the clean rollback removed everything it wrote',
        (await count('residents')) === 0 && (await count('vehicles')) === 0 && (await count('user_roles')) === 0,
        `residents ${await count('residents')}, vehicles ${await count('vehicles')}, roles ${await count('user_roles')}`)
      chk('   ...restoring the property to its baseline',
        (await propCount('residents')) === resBase && (await propCount('vehicles')) === vehBase,
        `residents ${await propCount('residents')} (was ${resBase}), vehicles ${await propCount('vehicles')} (was ${vehBase})`)
      say('\n   re-loading to test the remaining refusals against a loaded batch…')
      await db.from('import_batches').update({
        status: 'approved', loaded_at: null, loaded_by: null,
        loaded_resident_count: null, loaded_vehicle_count: null,
      }).eq('id', batchId)
      const reload = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
      chk('   re-loaded', reload.ok === true, `${reload.residents}/${reload.vehicles}`)
    }

    // ── 🔴 (3) a guest authorization by an imported resident blocks ──
    console.log('\n── 🔴 a guest authorization issued by an imported resident ──')
    const freshEmail = String((await db.from('residents').select('email')
      .eq('import_batch_id', batchId).limit(1).maybeSingle()).data?.email)
    const ga = await db.from('guest_authorizations').insert({
      company: demo.name, property: propName, plate: 'ZZGUEST1', state: 'TX',
      guest_name: 'ZZ Probe Guest', visiting_unit: '1309', resident_email: freshEmail,
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date(Date.now() + 7 * 24 * 3600_000).toISOString().slice(0, 10),
      status: 'active', is_active: true, created_by_email: freshEmail,
    }).select('id').maybeSingle()
    if (ga.error) throw new Error(`guest auth probe: ${ga.error.message}`)
    valueRows.push({ table: 'guest_authorizations', id: ga.data!.id as number })
    const blockedByGa = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('🔴 the rollback is refused — a guest is still admitted by a resident who would be gone',
      blockedByGa.error === 'has_dependents', str(blockedByGa, 200))
    chk('   ...naming guest_authorizations',
      (blockedByGa.blockers ?? []).some((b: Record<string, unknown>) =>
        String(b.table).includes('guest_authorizations')),
      str(blockedByGa.blockers))
    const rmGa = await db.from('guest_authorizations').delete().eq('id', ga.data!.id).select('id')
    valueRows.length = 0
    chk('   (control) removed', (rmGa.data ?? []).length === 1)

    // ── 🔴 (4) the same address at ANOTHER property does not block ──
    console.log('\n── 🔴 the same address, at a different property ──')
    const { data: otherProp } = await db.from('properties').select('name')
      .eq('company', demo.name).neq('name', propName).eq('is_active', true).limit(1).maybeSingle()
    if (otherProp) {
      const sr = await db.from('space_requests').insert({
        resident_email: freshEmail, property: String(otherProp.name),
        note: 'zz probe at another property', status: 'pending',
      }).select('id').maybeSingle()
      if (sr.error) throw new Error(`space_requests probe: ${sr.error.message}`)
      valueRows.push({ table: 'space_requests', id: sr.data!.id as number })
      const other = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
      chk(`🔴 a space request for the same address at ${otherProp.name} does NOT block`,
        other.error !== 'has_dependents',
        `${str(other, 180)} — matching resident_email alone would have refused here, which is why the check is scoped by property`)
      const rmSr = await db.from('space_requests').delete().eq('id', sr.data!.id).select('id')
      valueRows.length = 0
      chk('   (the probe is removed)', (rmSr.data ?? []).length === 1)
      // It rolled back; put it back for the remaining legs.
      const st = (await db.from('import_batches').select('status').eq('id', batchId).maybeSingle()).data?.status
      if (st === 'rolled_back') {
        await db.from('import_batches').update({
          status: 'approved', loaded_at: null, loaded_by: null,
          loaded_resident_count: null, loaded_vehicle_count: null,
        }).eq('id', batchId)
        const rl = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
        chk('   (re-loaded for the remaining legs)', rl.ok === true, `${rl.residents}/${rl.vehicles}`)
      }
    } else {
      chk('a second property exists to test the scoping', false,
        '🔴 the demo company has only one active property, so the property-scoping assertion could not be exercised')
    }

    // ── 🔴 A CLAIMED RESIDENT REFUSES THE WHOLE ROLLBACK ───────────
    console.log('\n── 🔴 a resident who has claimed refuses the rollback ──')
    // Claim one, for real, on an address the mail provider accepts.
    const claimable = `zz-rb-claim-${S}@test.invalid`
    const extra = await db.from('residents').insert({
      name: `ZZ RB CLAIM ${S}`, email: claimable, unit: '1401',
      property: propName, company: demo.name, is_active: true, status: 'active',
      import_batch_id: batchId,
    }).select('id,unit').maybeSingle()
    if (extra.error) throw new Error(`claim canary: ${extra.error.message}`)
    const c = await fetch(`${BASE}/api/register/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: claimable, property: propName, captchaToken: 'dummy' }),
    })
    chk('the claim answers', c.status === 200, `HTTP ${c.status}`)
    const all = await db.auth.admin.listUsers({ perPage: 1000 })
    const made = (all.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === claimable)
    if (made) claimUids.push(made.id)
    claimRoleEmails.push(claimable)
    chk('   ...and the resident now has an auth account', !!made, made ? `uid ${made.id}` : '🔴 none')

    const claimed = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('🔴 the rollback is refused because someone has claimed',
      claimed.error === 'already_claimed', str(claimed, 200))
    chk('🔴 ...and they are LISTED by address and unit, not counted',
      Array.isArray(claimed.claimed) && claimed.claimed.length >= 1
      && String(claimed.claimed[0]?.email).length > 3,
      `${str(claimed.claimed)} — "1 resident has a login" is not something an operator can act on`)
    chk('   ...and nothing was removed', (await count('residents')) === 229, `${await count('residents')} stamped`)
    const { data: stillLoaded } = await db.from('import_batches').select('status').eq('id', batchId).maybeSingle()
    chk('   ...and the batch is still loaded — a refusal is not a transition',
      stillLoaded?.status === 'loaded', `status=${stillLoaded?.status}`)
    // 🔴 And the auth account is untouched, as ruled.
    const after = await db.auth.admin.listUsers({ perPage: 1000 })
    chk('🔴 ...and their auth account was NOT deleted',
      (after.data?.users ?? []).some(u => (u.email ?? '').toLowerCase() === claimable),
      'no auth-user deletion, as ruled — and no transaction could cover it anyway')

    // Take the claim back down so the happy path can run.
    await db.auth.admin.deleteUser(made!.id)
    claimUids.length = 0
    await db.from('user_roles').delete().in('email', claimRoleEmails)
    claimRoleEmails.length = 0
    await db.from('residents').delete().eq('id', extra.data!.id)
    chk('   (control) with the claim removed, 228 remain stamped',
      (await count('residents')) === 228, `${await count('residents')}`)

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE ROLLBACK
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 🔴 the rollback ──')
    const rbR = await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin)
    const rb = await js(rbR)
    chk('🔴 the batch rolls back', rbR.status === 200 && rb.ok === true, `HTTP ${rbR.status} ${str(rb, 200)}`)
    chk('🔴 with the counts the load wrote — 228 residents, 358 vehicles, 228 role rows',
      rb.residents === 228 && rb.vehicles === 358 && rb.roles === 228,
      `${rb.residents}/${rb.vehicles}/${rb.roles}`)
    for (const t of ['residents', 'vehicles', 'user_roles'] as const) {
      chk(`   nothing stamped with batch ${batchId} remains in ${t}`,
        (await count(t)) === 0, `${await count(t)} left`)
    }
    chk('🔴 the property is back to its baseline',
      (await propCount('residents')) === resBase && (await propCount('vehicles')) === vehBase,
      `residents ${await propCount('residents')} (was ${resBase}), vehicles ${await propCount('vehicles')} (was ${vehBase})`)
    const { data: rbRow } = await db.from('import_batches')
      .select('status,loaded_at,loaded_resident_count').eq('id', batchId).maybeSingle()
    chk('status is rolled_back', rbRow?.status === 'rolled_back', str(rbRow))
    chk('🔴 ...and the load record is KEPT, because it happened',
      !!rbRow?.loaded_at && rbRow?.loaded_resident_count === 228,
      `loaded_at=${rbRow?.loaded_at} loaded_resident_count=${rbRow?.loaded_resident_count} — an undo does not unhappen the load, and the audit trail needs both events`)

    const { data: aud } = await db.from('audit_logs').select('action,user_email')
      .eq('table_name', 'import_batches').eq('record_id', String(batchId))
      .gte('created_at', new Date(S - 60_000).toISOString())
    chk('the rollback is audited by the trigger, naming the operator',
      (aud ?? []).some(a => String(a.action) === 'IMPORT_BATCH_ROLLED_BACK' && String(a.user_email) === admin.email),
      (aud ?? []).map(a => a.action).join(', '))

    // ── 🔴 rolling back twice, and resubmitting after ──────────────
    console.log('\n── 🔴 after the rollback ──')
    const twice = await js(await post('/api/admin/import-batch/rollback', { batch_id: batchId }, admin))
    chk('rolling back again is refused', twice.error === 'wrong_status', str(twice, 150))
    const parsed = parseBulkCsv(fs.readFileSync('docs/bulk-onboarding/fixtures/alden_fixture_clean.csv', 'utf8'))
    chk('(the fixture still parses, for the next assertion)', parsed.ok)
    const resub = await db.from('import_batches').insert({
      company_id: batch.company_id, property_id: batch.property_id,
      source_filename: 'zz-resub.csv', storage_path: `${batch.property_id}/zz-resub.csv`,
      file_sha256: String(batch.file_sha256),
      attested_by_user_id: mintedUids[0], attested_name: 'Probe', attested_title: 'Probe',
      resident_count: 1, vehicle_count: 1, status: 'submitted',
    }).select('id').maybeSingle()
    if (resub.data?.id) await db.from('import_batches').delete().eq('id', resub.data.id)
    chk('🔴 the same file CAN be resubmitted after a rollback — rolled_back is not live',
      !resub.error,
      resub.error ? `🔴 ${resub.error.message} — a rollback the company cannot follow with a corrected file is a dead end` : 'the corrected file is not blocked by the batch it replaces')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })
