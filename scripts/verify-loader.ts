// ════════════════════════════════════════════════════════════════════
// GATE — the loader, on batch 8
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. Batch 8 is the Alden Park clean fixture on Sunset
// Ridge Apartments at Demo Company: 358 rows, 228 residents.
//
// 🔴 THIS GATE WRITES 586 REAL RECORDS AND THEN REMOVES THEM. Rollback
// is not built yet, so the restore is this gate's own: delete by
// import_batch_id on all three tables and reset the batch, each step
// verified by count. A load that cannot be undone by hand is a load
// nobody should run twice, and the restore is the only reason this is
// repeatable.
//
// 🔴 THE HASH IS NEVER TAMPERED WITH ON DISK. "Hash tamper refused" is
// proven by calling the RPC with a hash that is not the row's — not by
// editing batches/8.csv, which is the file the loader hashes and a
// later rollback would check. Making a hole to prove one is not a gate.
//
// 🔴 AND THE RESTORE RUNS EVEN ON A CRASH, ordered by harm: the records
// first (they are visible to a real property), then the flag, then the
// batch's own state.
//
// Usage: npm run verify:loader

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3998
const BASE = `http://127.0.0.1:${PORT}`
// Cloudflare's published always-pass secret: the /claim leg needs a
// captcha solved, and the captcha is not the control under test.
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
const str = (v: unknown, n = 200) => (JSON.stringify(v) ?? 'undefined').slice(0, n)

let srv: DevServer | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
const claimUids: string[] = []
let flaggedCompany: number | null = null
let batchSnapshot: Record<string, unknown> | null = null
let batchId = 0
let loadedSomething = false
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)

  // ══════════════════════════════════════════════════════════════════
  // 🔴 THE 586 RECORDS FIRST. They are the only thing here a real
  // person could see, and they sit at a property a demo CA can open.
  // Deleted by import_batch_id — the stamp the loader wrote — which is
  // also a rehearsal of what rollback will do.
  // ══════════════════════════════════════════════════════════════════
  if (batchId && loadedSomething) {
    for (const t of ['vehicles', 'user_roles', 'residents'] as const) {
      const r = await db.from(t).delete().eq('import_batch_id', batchId).select('id')
      if (r.error) { warn(`   🔴 ${t}: delete by import_batch_id failed — ${r.error.message}`); fails++ }
      else say(`   ↩ removed ${(r.data ?? []).length} ${t} row(s) stamped with batch ${batchId}`)
    }
    // Verified by count, not assumed. A stamp the delete missed is a
    // row nobody will ever find again.
    for (const t of ['vehicles', 'user_roles', 'residents'] as const) {
      const { count } = await db.from(t).select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
      if ((count ?? 0) !== 0) { warn(`   🔴 ${count} ${t} row(s) STILL stamped with batch ${batchId}`); fails++ }
    }
  }
  // Auth users the /claim leg created.
  for (const uid of claimUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete claimed auth user ${uid}`); fails++ }
  }
  if (claimUids.length) say(`   ↩ deleted ${claimUids.length} auth user(s) the claim created`)
  // The gate's own actors.
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if (r.error) { warn(`   🔴 role rows: ${r.error.message}`); fails++ }
    else say(`   ↩ removed ${(r.data ?? []).length} actor role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} actor auth user(s)`)
  if (flaggedCompany !== null) {
    const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== false) {
      warn(`   🔴 FLAG NOT RESTORED on company ${flaggedCompany}`); fails++
    } else say(`   ↩ bulk_onboarding_enabled back to false on company ${flaggedCompany}`)
  }
  if (batchSnapshot && batchId) {
    const want = {
      status: batchSnapshot.status,
      approved_by: batchSnapshot.approved_by, approved_at: batchSnapshot.approved_at,
      reject_reason: batchSnapshot.reject_reason, reject_errors: batchSnapshot.reject_errors,
      reject_error_count: batchSnapshot.reject_error_count,
      loaded_at: null, loaded_by: null,
      loaded_resident_count: null, loaded_vehicle_count: null,
    }
    const r = await db.from('import_batches').update(want).eq('id', batchId)
      .select('status,loaded_at,loaded_resident_count').maybeSingle()
    const ok = !r.error && r.data?.status === want.status && r.data?.loaded_at === null
    if (!ok) { warn(`   🔴 BATCH ${batchId} NOT RESTORED — reads ${str(r.data)}${r.error ? ` (${r.error.message})` : ''}`); fails++ }
    else say(`   ↩ batch ${batchId} restored to status=${want.status}, load record cleared`)
  }
  // This run's audit rows.
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
async function actor(label: string, role: string, company: string | null, property: string[], active = true): Promise<Actor> {
  const email = `zz-ld-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company, property, is_active: active }).select('id')
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

  // ── the subject ──────────────────────────────────────────────────
  const { data: cos } = await db.from('companies')
    .select('id,name,company_env,bulk_onboarding_enabled').eq('company_env', 'demo')
  const demo = (cos ?? [])[0]
  if (!demo) { warn("🔴 no company with company_env='demo'. Refusing."); process.exit(2) }
  if (demo.bulk_onboarding_enabled === true) {
    warn(`🔴 ${demo.name} already has bulk_onboarding_enabled=true; this gate restores it to false. Clear it first.`)
    process.exit(2)
  }
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

  // The loader must exist, or refuse rather than report reds.
  const ping = await db.rpc('load_import_batch', { p_batch_id: -1, p_file_sha256: 'x', p_rows: [] })
  if (ping.error) {
    warn(`🔴 load_import_batch is not callable: ${ping.error.message}`)
    warn('   Apply docs/backlog/wip-20261016_loader.sql first.')
    process.exit(2)
  }

  // Baselines, so the counts asserted later are deltas and not totals.
  const base = async (t: 'residents' | 'vehicles') => {
    const { count } = await db.from(t).select('*', { count: 'exact', head: true }).eq('property', propName)
    return count ?? 0
  }
  const resBefore = await base('residents')
  const vehBefore = await base('vehicles')
  say(`subject: batch ${batchId} · ${propName} · ${demo.name}`)
  say(`baseline at ${propName}: ${resBefore} residents, ${vehBefore} vehicles\n`)

  try {
    const admin = await actor('adm', 'admin', null, [])
    const mgr = await actor('mgr', 'manager', demo.name, [propName])
    say('actors: admin, manager\n')

    srv = await startDevServer(PORT, { env: { TURNSTILE_SECRET_KEY: TEST_SECRET, NODE_ENV: 'development' } })
    if (!srv) { warn('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    say('server up\n')

    // ── 🔴 flag off: a blocked load is refused, never retried ───────
    console.log('── 🔴 flag off: blocked, and NOT retryable ──')
    const offLoad = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
    chk('🔴 loading is refused with the reason', offLoad.error === 'blocked', str(offLoad, 160))
    chk('🔴 ...and the response says a retry would NOT help',
      offLoad.retryable === false,
      `retryable=${offLoad.retryable} — a retry here would SUCCEED and load 228 residents into a property nobody can see, which is the whole reason this is not "transient"`)
    const { count: afterOff } = await db.from('residents').select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
    chk('   ...and nothing was written', (afterOff ?? 0) === 0, `${afterOff} stamped row(s)`)

    // flag on
    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) throw new Error('could not enable the flag')
    flaggedCompany = demo.id as number
    say(`\nflag on for ${demo.name} (restored in cleanup)\n`)

    // ── a submitted batch cannot be loaded ─────────────────────────
    console.log('── approve first: Load is a second decision ──')
    const preLoad = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
    chk('a SUBMITTED batch cannot be loaded', preLoad.error === 'wrong_status', str(preLoad, 150))
    const ap = await js(await post('/api/admin/import-batch/approve', { batch_id: batchId }, admin))
    chk('the batch is approved', ap.ok === true, str(ap, 140))

    // ── 🔴 a non-admin is refused ──────────────────────────────────
    console.log('\n── 🔴 who cannot load ──')
    const mgrLoad = await post('/api/admin/import-batch/load', { batch_id: batchId }, mgr)
    chk('a manager is refused by the route', mgrLoad.status === 403, `HTTP ${mgrLoad.status}`)
    const mgrRpc = await mgr.client.rpc('load_import_batch',
      { p_batch_id: batchId, p_file_sha256: String(batch.file_sha256), p_rows: [] })
    chk('🔴 ...and by the RPC with the route bypassed',
      (mgrRpc.data as Record<string, unknown> | null)?.error === 'not_operator',
      str(mgrRpc.data ?? mgrRpc.error))
    const anon = await post('/api/admin/import-batch/load', { batch_id: batchId })
    chk('anonymous is refused', anon.status === 307 || anon.status === 401, `HTTP ${anon.status}`)

    // ── 🔴 hash tamper, without touching the file ──────────────────
    console.log('\n── 🔴 the hash guard ──')
    const badSha = await admin.client.rpc('load_import_batch',
      { p_batch_id: batchId, p_file_sha256: 'f'.repeat(64), p_rows: [] })
    chk('🔴 a hash that is not the row\'s is refused',
      (badSha.data as Record<string, unknown> | null)?.error === 'sha_mismatch',
      `${str(badSha.data, 150)} — proven by passing a wrong hash, never by editing batches/${batchId}.csv, which is the file a later rollback will check`)
    // And the payload-shape guard, with the RIGHT hash.
    const shortRows = await admin.client.rpc('load_import_batch',
      { p_batch_id: batchId, p_file_sha256: String(batch.file_sha256), p_rows: [{ email: 'x@y.z' }] })
    chk('🔴 a payload shorter than the attested row count is refused',
      (shortRows.data as Record<string, unknown> | null)?.error === 'row_count_mismatch',
      `${str(shortRows.data, 170)} — the hash proves the FILE; this is what ties the PAYLOAD to it`)
    const { count: stillNone } = await db.from('residents').select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
    chk('   ...and none of those refusals wrote anything', (stillNone ?? 0) === 0, `${stillNone} stamped row(s)`)

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE LOAD
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 🔴 the load ──')
    const ldR = await post('/api/admin/import-batch/load', { batch_id: batchId }, admin)
    const ld = await js(ldR)
    chk('🔴 the batch loads', ldR.status === 200 && ld.ok === true, `HTTP ${ldR.status} ${str(ld, 200)}`)
    if (ld.ok === true) loadedSomething = true
    chk('🔴 with the fixture\'s exact counts — 228 residents, 358 vehicles',
      ld.residents === 228 && ld.vehicles === 358,
      `${ld.residents} residents, ${ld.vehicles} vehicles, ${ld.roles} role rows`)
    chk('   ...and one resident role row per resident, not per vehicle row',
      ld.roles === 228, `${ld.roles} role rows for ${ld.residents} residents`)

    const { count: resAfter } = await db.from('residents').select('*', { count: 'exact', head: true }).eq('property', propName)
    const { count: vehAfter } = await db.from('vehicles').select('*', { count: 'exact', head: true }).eq('property', propName)
    chk('🔴 the property gained exactly that many, measured as a delta',
      (resAfter ?? 0) - resBefore === 228 && (vehAfter ?? 0) - vehBefore === 358,
      `residents ${resBefore} → ${resAfter} (+${(resAfter ?? 0) - resBefore}), vehicles ${vehBefore} → ${vehAfter} (+${(vehAfter ?? 0) - vehBefore})`)

    // ── 🔴 every row carries the stamp ─────────────────────────────
    console.log('\n── 🔴 the stamp, on every row the loader wrote ──')
    for (const [t, want] of [['residents', 228], ['vehicles', 358], ['user_roles', 228]] as const) {
      const { count } = await db.from(t).select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
      chk(`${t}: ${want} row(s) stamped with batch ${batchId}`,
        (count ?? 0) === want,
        `${count} — rollback deletes by this column, so an unstamped row is one nobody will find again`)
    }

    // ── 🔴 THE BINDING STAFF-ROLE ASSERTION ────────────────────────
    console.log('\n── 🔴 no staff role, ever ──')
    const { data: rolesMade } = await db.from('user_roles').select('role, is_active, company, property, import_batch_id')
      .eq('import_batch_id', batchId)
    const kinds = [...new Set((rolesMade ?? []).map(r => String(r.role)))]
    chk('🔴 every role row the loader created is role=resident, and nothing else',
      kinds.length === 1 && kinds[0] === 'resident',
      `${kinds.join(', ')} — the template has 11 columns and no role, both ingest libraries contain zero occurrences of the string, and this is the last place one could enter`)
    chk('   ...scoped to the batch\'s own company and property',
      (rolesMade ?? []).every(r => String(r.company) === demo.name
        && JSON.stringify(r.property) === JSON.stringify([propName])),
      str((rolesMade ?? [])[0]))
    const { data: vehSample } = await db.from('vehicles').select('is_active,status,is_primary,resident_email,plate,state')
      .eq('import_batch_id', batchId).limit(400)
    chk('🔴 every vehicle is active — a property that uploaded them has approved them',
      (vehSample ?? []).every(v => v.is_active === true && v.status === 'active'),
      `${(vehSample ?? []).filter(v => v.is_active !== true || v.status !== 'active').length} not active`)
    chk('   ...and exactly one primary per resident',
      (vehSample ?? []).filter(v => v.is_primary === true).length === 228,
      `${(vehSample ?? []).filter(v => v.is_primary).length} primary of ${(vehSample ?? []).length}`)

    // ── 🔴 a second load is refused ────────────────────────────────
    console.log('\n── 🔴 a second load ──')
    const twice = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, admin))
    chk('🔴 loading the same batch again is refused',
      twice.error === 'wrong_status',
      `${str(twice, 180)}`)
    chk('   ...and says why in a sentence about the consequence',
      /already loaded|twice/i.test(String(twice.message ?? '')),
      String(twice.message ?? '').slice(0, 140))
    const { count: resStill } = await db.from('residents').select('*', { count: 'exact', head: true }).eq('import_batch_id', batchId)
    chk('   ...and did not double anything', (resStill ?? 0) === 228, `${resStill} stamped resident row(s)`)

    // ── 🔴 the plate lookup finds an imported plate ─────────────────
    console.log('\n── 🔴 a manager looking up an imported plate ──')
    const plate = String((vehSample ?? [])[0]?.plate ?? '')
    const look = await mgr.client.rpc('pm_plate_lookup',
      { p_plate: plate, p_viewing_property: propName, p_tag: null })
    const lr = (Array.isArray(look.data) ? look.data[0] : look.data) as Record<string, unknown> | null
    chk(`🔴 ${plate} resolves as a resident`,
      !look.error && String(lr?.result_type) === 'resident',
      `${str(lr, 200)}${look.error ? ` err=${look.error.message}` : ''} — this is the load's whole purpose: enforcement must not tow a resident the property told us about`)
    chk('   ...and names their unit',
      !!lr?.unit_number,
      `unit=${str(lr?.unit_number)}`)

    // ── 🔴 /claim sends the invite for an imported resident ─────────
    // The one journey that closes the arc: a resident the property
    // uploaded asks for a login and gets one.
    console.log('\n── 🔴 /claim for an imported resident ──')
    const victimEmail = String((vehSample ?? [])[0]?.resident_email ?? '')
    const claim = await fetch(`${BASE}/api/register/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: victimEmail, property: propName, captchaToken: 'dummy' }),
    })
    const claimBody = await claim.text()
    chk('the claim answers', claim.status === 200, `HTTP ${claim.status} ${claimBody.slice(0, 120)}`)
    const all = await db.auth.admin.listUsers({ perPage: 1000 })
    const made = (all.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === victimEmail.toLowerCase())
    if (made) claimUids.push(made.id)
    chk(`🔴 an invite was sent for ${victimEmail} — an auth user now exists`,
      !!made, made ? `uid ${made.id}` : '🔴 none: the loaded resident cannot get a login, which makes the load pointless')
    chk('   ...unconfirmed until they accept it',
      !made?.email_confirmed_at, `email_confirmed_at=${made?.email_confirmed_at ?? 'null'}`)
    const { data: claimRole } = await db.from('user_roles').select('id,role,import_batch_id')
      .ilike('email', victimEmail).limit(2)
    chk('🔴 ...and the claim reused the role row the LOADER made, not a second one',
      (claimRole ?? []).length === 1 && Number((claimRole ?? [])[0]?.import_batch_id) === batchId,
      `${(claimRole ?? []).length} role row(s), import_batch_id=${(claimRole ?? [])[0]?.import_batch_id} — one email, one role, and the stamp survives the claim so rollback can still find it`)

    // ── the batch's own record of the load ─────────────────────────
    console.log('\n── what the batch records ──')
    const { data: row } = await db.from('import_batches')
      .select('status,loaded_at,loaded_by,loaded_resident_count,loaded_vehicle_count').eq('id', batchId).maybeSingle()
    chk('status is loaded, with when and who',
      row?.status === 'loaded' && !!row?.loaded_at && !!row?.loaded_by, str(row))
    chk('🔴 and what was WRITTEN, which is not the same field as what the file claimed',
      row?.loaded_resident_count === 228 && row?.loaded_vehicle_count === 358,
      `loaded ${row?.loaded_resident_count}/${row?.loaded_vehicle_count} vs the file's ${batch.resident_count}/${batch.vehicle_count} — stored separately so rollback can check it deleted the number that went in`)
    const { data: aud } = await db.from('audit_logs').select('action,user_email,new_values')
      .eq('table_name', 'import_batches').eq('record_id', String(batchId))
      .gte('created_at', new Date(S - 60_000).toISOString())
    chk('the load is audited by the trigger, naming the operator',
      (aud ?? []).some(a => String(a.action) === 'IMPORT_BATCH_LOADED' && String(a.user_email) === admin.email),
      `${(aud ?? []).map(a => a.action).join(', ')}`)

  } finally {
    await cleanup('end')
  }

  // ── 🔴 the restore, asserted AFTER cleanup ran ────────────────────
  // Cleanup counts its own deletions, but the property's totals are the
  // check that matters: the gate must leave Sunset Ridge exactly as it
  // found it.
  const { count: resEnd } = await db.from('residents').select('*', { count: 'exact', head: true }).eq('property', propName)
  const { count: vehEnd } = await db.from('vehicles').select('*', { count: 'exact', head: true }).eq('property', propName)
  chk('🔴 the property is back to its baseline',
    (resEnd ?? 0) === resBefore && (vehEnd ?? 0) === vehBefore,
    `residents ${resEnd} (was ${resBefore}), vehicles ${vehEnd} (was ${vehBefore}) — rollback is not built yet, so this restore is the gate's own and is the only reason it is repeatable`)

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })
