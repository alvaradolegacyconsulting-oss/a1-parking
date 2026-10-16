// ════════════════════════════════════════════════════════════════════
// GATE — the approval queue, driven over HTTP against batch 8
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: build the queue against a real batch. Batch 8 is
// the Alden Park clean fixture on Sunset Ridge Apartments at Demo
// Company — 358 rows, 228 residents, submitted through the CA's own
// routes by demo-ca@test.shieldmylot.com.
//
// 🔴 IT MUTATES BATCH 8, AND RESTORES IT, AND CHECKS THE RESTORE.
// Approving and returning a batch is the thing under test, so the
// subject's status has to move. Its whole row is snapshotted first and
// written back at the end, and the write-back is re-read — a restore
// that silently did nothing would leave the loader's subject in the
// wrong state and the next run would test something else.
//
// 🔴 STALENESS IS INDUCED WITH A CANARY RESIDENT, NOT BY EDITING THE
// FILE. The immutable copy under batches/ is what the loader will hash;
// corrupting it to make the validator complain would be proving a hole
// by making one. Instead a resident is inserted at the property with an
// email taken from the fixture, which is exactly what happens in real
// life between submit and approve, and deleted afterwards with
// RETURNING.
//
// Cookies, not a bearer token: every route reads the session through
// createSupabaseServerClient.
//
// Usage: npm run verify:queue

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import { say, warn } from './lib/safe-log'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'
import { parseBulkCsv, BULK_CSV_COLUMNS } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3995
const BASE = `http://127.0.0.1:${PORT}`
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

let srv: DevServer | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
const canaryResidentIds: number[] = []
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

  // ════════════════════════════════════════════════════════════════
  // 🔴 ORDERED BY HARM, NOT BY THE ORDER THINGS WERE CREATED.
  // On 2026-10-16 this cleanup was aborted mid-way (a console.error on
  // a pipe `head` had closed threw EPIPE) and it left behind, in this
  // order of seriousness: two LIVE `admin` role rows, and
  // bulk_onboarding_enabled ON for the demo company. Both were after
  // the batch restore in the old ordering.
  //
  // So: live privilege first, then the account-level flag, then the
  // subject's own state, then cosmetic pollution. Logging now goes
  // through safe-log and cannot throw — but ordering by harm means
  // even an unexpected throw has already undone the dangerous half.
  // ════════════════════════════════════════════════════════════════
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if (r.error || (r.data ?? []).length !== mintedEmails.length) {
      warn(`   🔴 role rows: removed ${(r.data ?? []).length}/${mintedEmails.length}`); fails++
    } else say(`   ↩ removed ${(r.data ?? []).length} role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} auth user(s)`)
  const left = await db.from('user_roles').select('id,role').in('email', mintedEmails)
  if ((left.data ?? []).length > 0) {
    warn(`   🔴 ${(left.data ?? []).length} ROLE ROW(S) STILL PRESENT — one of them is an admin`); fails++
  }

  if (flaggedCompany !== null) {
    const want = flagWas === true
    const r = await db.from('companies').update({ bulk_onboarding_enabled: want })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== want) {
      warn(`   🔴 FLAG NOT RESTORED on company ${flaggedCompany}`); fails++
    } else say(`   ↩ bulk_onboarding_enabled back to ${want} on company ${flaggedCompany} (as found)`)
  }

  // Now the subject's own state. The restore is verified.
  if (batchSnapshot && batchId) {
    const want = {
      status: batchSnapshot.status,
      approved_by: batchSnapshot.approved_by,
      approved_at: batchSnapshot.approved_at,
      reject_reason: batchSnapshot.reject_reason,
      reject_errors: batchSnapshot.reject_errors,
      reject_error_count: batchSnapshot.reject_error_count,
    }
    const r = await db.from('import_batches').update(want).eq('id', batchId)
      .select('status,approved_by,reject_error_count').maybeSingle()
    const ok = !r.error && r.data?.status === want.status
      && (r.data?.approved_by ?? null) === (want.approved_by ?? null)
      && (r.data?.reject_error_count ?? null) === (want.reject_error_count ?? null)
    if (!ok) {
      warn(`   🔴 BATCH ${batchId} NOT RESTORED to ${JSON.stringify(want)} — reads ${JSON.stringify(r.data)}${r.error ? ` (${r.error.message})` : ''}`)
      fails++
    } else say(`   ↩ batch ${batchId} restored to status=${want.status}, approval and rejection cleared`)
  }
  // The audit rows this run's transitions wrote. They are a log, and
  // this run's entries are about a demo batch being moved back and
  // forth by a gate — keeping them would make the real trail unreadable.
  if (batchId) {
    const r = await db.from('audit_logs').delete()
      .eq('table_name', 'import_batches').eq('record_id', String(batchId))
      .gte('created_at', new Date(S - 60_000).toISOString()).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} audit row(s) from this run`)
  }
  if (canaryResidentIds.length) {
    const r = await db.from('residents').delete().in('id', canaryResidentIds).select('id')
    if (r.error || (r.data ?? []).length !== canaryResidentIds.length) {
      warn(`   🔴 canary residents: removed ${(r.data ?? []).length}/${canaryResidentIds.length}`); fails++
    } else say(`   ↩ removed ${(r.data ?? []).length} canary resident(s)`)
  }
  if (srv) { await srv.stop(); srv = null; say('   ↩ stopped the server this gate started (whole process group)') }
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


type Actor = { email: string; cookie: string; client: SupabaseClient }
async function actor(label: string, role: string, company: string | null, property: string[], active = true): Promise<Actor> {
  const email = `zz-q-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company, property, is_active: active }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  const { cookie, accessToken } = await cookieHeaderFor(db, URL_, ANON, email)
  return { email, cookie, client: createClient(URL_, ANON, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken}` } } }) }
}

const call = (path: string, body: unknown | null, a?: Actor) => fetch(`${BASE}${path}`, {
  method: body === null ? 'GET' : 'POST', redirect: 'manual',
  headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...(a ? { Cookie: a.cookie } : {}) },
  ...(body === null ? {} : { body: JSON.stringify(body) }),
})
const js = async (r: Response) => { try { return JSON.parse(await r.text()) as Record<string, any> } catch { return {} } }
// 🔴 JSON.stringify(undefined) RETURNS undefined, NOT "undefined", so
// `JSON.stringify(x?.y).slice(0, n)` throws the moment x?.y is absent —
// which is exactly when a check has already failed and you most want to
// read its detail. This gate crashed on that in the audit section when
// the audit trigger was not yet applied: every assertion had reported
// correctly and then the formatter took the process down.
const str = (v: unknown, n = 200) => (JSON.stringify(v) ?? 'undefined').slice(0, n)

const main = async () => {
  if (await portBusy(PORT)) {
    console.error(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  // ── the subject ──────────────────────────────────────────────────
  const { data: demos } = await db.from('companies')
    .select('id,name,company_env,bulk_onboarding_enabled').eq('company_env', 'demo')
  const demo = (demos ?? [])[0]
  if (!demo) { console.error("🔴 no company with company_env='demo'. Refusing."); process.exit(2) }
  const { data: batch } = await db.from('import_batches').select('*')
    .eq('company_id', demo.id).order('id').limit(1).maybeSingle()
  if (!batch) {
    console.error('🔴 no batch at the demo company. Run npm run seed:demobatch first — this gate is built against a real batch, not a fabricated one.')
    process.exit(2)
  }
  batchId = Number(batch.id)
  batchSnapshot = { ...batch }
  if (batch.status !== 'submitted') {
    console.error(`🔴 batch ${batchId} is '${batch.status}', not 'submitted'. Refusing: this gate starts from the review state, and restoring from an unexpected start would write the wrong value back.`)
    process.exit(2)
  }
  const { data: prop } = await db.from('properties').select('id,name').eq('id', batch.property_id).maybeSingle()
  console.log(`subject: batch ${batchId} · ${prop!.name} · ${demo.name} · ${batch.resident_count} residents\n`)

  // ── the RPCs are applied, or refuse ──────────────────────────────
  const ping = await db.rpc('is_active_import_operator')
  if (ping.error) {
    console.error(`🔴 is_active_import_operator() is not callable: ${ping.error.message}`)
    console.error('   Apply docs/backlog/wip-20261015_approve_and_return_rpcs.sql first. Refusing to report on a queue whose transitions do not exist.')
    process.exit(2)
  }

  // The second migration, same discipline: refuse rather than run and
  // report four reds and a crash. Pinged as service_role, which
  // is_active_import_operator refuses before anything is touched, so a
  // present function answers {not_operator} and an absent one errors.
  const ping2 = await db.rpc('reject_import_batch', { p_batch_id: -1, p_reason: 'preflight ping' })
  if (ping2.error) {
    warn(`🔴 reject_import_batch is not callable: ${ping2.error.message}`)
    warn('   Apply docs/backlog/wip-20261016_reject_and_audit.sql first. It also carries the')
    warn('   count-equals-zero-iff-empty CHECK and the audit trigger, so without it the Reject,')
    warn('   equivalence and audit sections below would all report red for one reason.')
    process.exit(2)
  }

  try {
    const admin = await actor('adm', 'admin', null, [])
    const deadAdmin = await actor('dead', 'admin', null, [], false)
    const mgr = await actor('mgr', 'manager', demo.name, [String(prop!.name)])
    const ca = await actor('ca', 'company_admin', demo.name, [String(prop!.name)])
    console.log('actors: admin, deactivated admin, manager, company_admin\n')

    console.log(`starting next dev on ${PORT}…`)
    srv = await startDevServer(PORT)
    if (!srv) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    const PATHS = ['list', 'review', 'approve', 'return'] as const
    const bodyFor = (p: string) => p === 'list' ? null : { batch_id: batchId }

    // ── anonymous ───────────────────────────────────────────────────
    console.log('── anonymous ──')
    for (const p of PATHS) {
      const r = await call(`/api/admin/import-batch/${p}`, bodyFor(p))
      chk(`/${p} refuses anonymous`, r.status === 307 || r.status === 302 || r.status === 401,
        `HTTP ${r.status} → ${r.headers.get('location') ?? ''}`)
    }

    // ── 🔴 who is not an operator ───────────────────────────────────
    // The deactivated admin is the one that matters: requireAdmin() in
    // server-auth would let them through, because it reads role and
    // never is_active. authorizeImportOperator does its own read.
    console.log('\n── 🔴 who the queue refuses ──')
    for (const [who, a] of [['a DEACTIVATED admin', deadAdmin], ['a manager', mgr], ['a company_admin', ca]] as const) {
      const r = await call('/api/admin/import-batch/list', null, a)
      const j = await js(r)
      chk(`${who} is refused`, r.status === 403 && j.error === 'not_operator', `HTTP ${r.status} ${JSON.stringify(j)}`)
    }
    const deadReview = await call('/api/admin/import-batch/review', { batch_id: batchId }, deadAdmin)
    chk('🔴 ...and a deactivated admin cannot review either',
      deadReview.status === 403,
      `HTTP ${deadReview.status} — requireAdmin() in server-auth would have let them through; it reads role and never is_active`)
    // Direct RPC, bypassing the route, as the deactivated admin.
    const deadRpc = await deadAdmin.client.rpc('approve_import_batch', { p_batch_id: batchId, p_file_sha256: String(batch.file_sha256) })
    chk('🔴 ...and the RPC refuses them too, with the route bypassed',
      (deadRpc.data as Record<string, unknown> | null)?.error === 'not_operator',
      str(deadRpc.data ?? deadRpc.error))
    const caRpc = await ca.client.rpc('approve_import_batch', { p_batch_id: batchId, p_file_sha256: String(batch.file_sha256) })
    chk('   ...and so does it for the owning company\'s own CA',
      (caRpc.data as Record<string, unknown> | null)?.error === 'not_operator',
      str(caRpc.data ?? caRpc.error))

    // ── the list ────────────────────────────────────────────────────
    console.log('\n── the list ──')
    const listR = await call('/api/admin/import-batch/list', null, admin)
    const list = await js(listR)
    chk('an active admin gets the queue', listR.status === 200 && list.ok === true, `HTTP ${listR.status}`)
    const mine = (list.batches ?? []).find((b: Record<string, unknown>) => Number(b.id) === batchId)
    chk('🔴 batch 8 is in it, with its company and property NAMED',
      !!mine && mine.company_name === demo.name && mine.property_name === prop!.name,
      str(mine && { id: mine.id, company_name: mine.company_name, property_name: mine.property_name, status: mine.status }))

    // ── 🔴 CANNOT LOAD, WITH THE FLAG OFF ──────────────────────────
    // Ruled: a reason, not a status. Batch 8 shows this until the flag
    // is on, which is why the flag is flipped below rather than assumed.
    console.log('\n── 🔴 "cannot load" is a reason, not a status (flag off) ──')
    const offR = await call('/api/admin/import-batch/review', { batch_id: batchId }, admin)
    const off = await js(offR)
    chk('review answers', offR.status === 200, `HTTP ${offR.status}`)
    chk('🔴 it is blocked, and says why', off.block?.blocked === true && (off.block?.reasons ?? []).length > 0,
      JSON.stringify(off.block))
    chk('   ...and the reason names the switched-off flag',
      (off.block?.reasons ?? []).some((s: string) => /switched off/i.test(s)),
      JSON.stringify(off.block?.reasons))
    chk('🔴 the batch status has NOT changed — a block is not a transition',
      String(off.batch?.status) === 'submitted', `status=${off.batch?.status}`)
    chk('   ...and neither action is offered', off.can_approve === false && off.can_load === false,
      `can_approve=${off.can_approve} can_load=${off.can_load}`)
    const offApprove = await call('/api/admin/import-batch/approve', { batch_id: batchId }, admin)
    const offApproveJ = await js(offApprove)
    chk('🔴 approving a blocked batch is refused with the reasons',
      offApprove.status === 409 && offApproveJ.error === 'blocked' && (offApproveJ.reasons ?? []).length > 0,
      `HTTP ${offApprove.status} ${JSON.stringify(offApproveJ).slice(0, 180)}`)
    const offReturn = await call('/api/admin/import-batch/return', { batch_id: batchId }, admin)
    const offReturnJ = await js(offReturn)
    chk('🔴 and so is RETURNING it — the company could not resubmit',
      offReturn.status === 409 && offReturnJ.error === 'blocked',
      `HTTP ${offReturn.status} ${JSON.stringify(offReturnJ).slice(0, 180)}`)
    const offReject = await js(await call('/api/admin/import-batch/reject',
      { batch_id: batchId, reason: 'This is the wrong property for this file.' }, admin))
    chk('🔴 and so is REJECTING it — they could not send a replacement',
      offReject.error === 'blocked', JSON.stringify(offReject).slice(0, 180))

    // ── flag on ─────────────────────────────────────────────────────
    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) throw new Error('could not enable the flag')
    flagWas = demo.bulk_onboarding_enabled === true
    flaggedCompany = demo.id as number
    console.log(`\nflag on for ${demo.name} (restored in cleanup)\n`)

    // ── 🔴 the live verdict ────────────────────────────────────────
    console.log('── 🔴 re-validation point 1: the review screen ──')
    const r1 = await js(await call('/api/admin/import-batch/review', { batch_id: batchId }, admin))
    chk('not blocked any more', r1.block?.blocked === false, JSON.stringify(r1.block))
    chk('🔴 the stored file still hashes to what was attested',
      r1.file?.matches === true, `${r1.file?.sha256?.slice(0, 16)}… (${r1.file?.bytes} bytes)`)
    chk('   ...and it still parses to the counts on the row',
      r1.parsed?.data_rows === 358 && r1.parsed?.resident_count === Number(batch.resident_count),
      `${r1.parsed?.data_rows} rows · ${r1.parsed?.resident_count} residents vs row's ${batch.resident_count}`)
    chk('🔴 the record checks RAN — not assumed, and not defaulted to clean',
      r1.validation?.ran === true, JSON.stringify(r1.validation).slice(0, 160))
    chk('   ...and came back clean against the property as it stands',
      r1.validation?.clean === true, `error_count=${r1.validation?.error_count}`)
    chk('Approve is offered; Load is not this action',
      r1.can_approve === true && r1.can_load === false,
      `can_approve=${r1.can_approve} can_load=${r1.can_load} (status submitted)`)

    // ── 🔴 nothing to return on a clean file ───────────────────────
    const cleanReturn = await js(await call('/api/admin/import-batch/return', { batch_id: batchId }, admin))
    chk('🔴 a clean batch cannot be returned — there would be nothing to attach',
      cleanReturn.error === 'nothing_to_return',
      `${JSON.stringify(cleanReturn).slice(0, 200)}`)

    // ── 🔴 the RPC's own guards, route bypassed ────────────────────
    console.log('\n── 🔴 the RPC guards, with the route bypassed ──')
    const wrongSha = await admin.client.rpc('approve_import_batch',
      { p_batch_id: batchId, p_file_sha256: 'f'.repeat(64) })
    chk('approving with a hash that is not the row\'s is refused',
      (wrongSha.data as Record<string, unknown> | null)?.error === 'sha_mismatch',
      `${JSON.stringify(wrongSha.data)} — an approval is of bytes someone looked at`)
    const emptyErrors = await admin.client.rpc('return_import_batch_to_company',
      { p_batch_id: batchId, p_reason: 'probe', p_errors: [], p_error_count: 0 })
    chk('returning with no errors attached is refused',
      (emptyErrors.data as Record<string, unknown> | null)?.error === 'bad_error_count'
      || (emptyErrors.data as Record<string, unknown> | null)?.error === 'errors_required',
      JSON.stringify(emptyErrors.data))
    const badCount = await admin.client.rpc('return_import_batch_to_company',
      { p_batch_id: batchId, p_reason: 'probe', p_errors: [{ row: 1, message: 'x' }, { row: 2, message: 'y' }], p_error_count: 1 })
    chk('🔴 returning with a count smaller than the list is refused',
      (badCount.data as Record<string, unknown> | null)?.error === 'bad_error_count',
      `${JSON.stringify(badCount.data)} — the count is the authority and cannot understate the evidence`)
    const noReason = await admin.client.rpc('return_import_batch_to_company',
      { p_batch_id: batchId, p_reason: '   ', p_errors: [{ row: 1, message: 'x' }], p_error_count: 1 })
    chk('returning with a blank reason is refused',
      (noReason.data as Record<string, unknown> | null)?.error === 'reason_required',
      JSON.stringify(noReason.data))
    console.log('   (no_caller_identity is unreachable from here: a service_role call has no')
    console.log('    jwt email, so is_active_import_operator refuses it first. Code-read, not asserted.)')

    // ── 🔴 re-validation point 2: approve ──────────────────────────
    console.log('\n── 🔴 re-validation point 2: approve ──')
    const apR = await call('/api/admin/import-batch/approve', { batch_id: batchId }, admin)
    const ap = await js(apR)
    chk('🔴 the batch is approved', apR.status === 200 && ap.ok === true,
      `HTTP ${apR.status} ${JSON.stringify(ap).slice(0, 180)}`)
    const { data: afterAp } = await db.from('import_batches')
      .select('status,approved_by,approved_at').eq('id', batchId).maybeSingle()
    chk('   ...and the row records WHO and WHEN', afterAp?.status === 'approved'
      && !!afterAp?.approved_by && !!afterAp?.approved_at,
      JSON.stringify(afterAp))
    const adminUid = mintedUids[0]
    chk('🔴 approved_by is the operator\'s user id, not an email',
      String(afterAp?.approved_by) === adminUid,
      `${afterAp?.approved_by} vs the admin's uid ${adminUid}`)
    const again = await js(await call('/api/admin/import-batch/approve', { batch_id: batchId }, admin))
    chk('approving twice is refused with the status, not silently repeated',
      again.error === 'wrong_status', JSON.stringify(again).slice(0, 170))

    // 🔴 THE DUPLICATE GUARD STILL COVERS AN APPROVED BATCH. This is
    // the silent hole the schema migration closed, measured here on the
    // real batch rather than on a probe row.
    const dupe = await db.from('import_batches').insert({
      company_id: batch.company_id, property_id: batch.property_id,
      source_filename: 'zz-dupe.csv', storage_path: `${batch.property_id}/zz-dupe.csv`,
      file_sha256: String(batch.file_sha256),
      attested_by_user_id: adminUid, attested_name: 'Probe', attested_title: 'Probe',
      resident_count: 1, vehicle_count: 1, status: 'submitted',
    }).select('id').maybeSingle()
    if (dupe.data?.id) await db.from('import_batches').delete().eq('id', dupe.data.id)
    chk('🔴 the same bytes cannot be resubmitted while this batch is APPROVED',
      !!dupe.error && /one_live_per_file/.test(dupe.error.message + (dupe.error.details ?? '')),
      dupe.error ? dupe.error.message.slice(0, 130) : '🔴 accepted — an approved batch has fallen out of the live index and both copies could load')

    // ── 🔴 re-validation point 3's input: induce staleness ─────────
    // A resident is added at the property with an email from the file,
    // which is exactly what happens between submit and load.
    console.log('\n── 🔴 a file that was clean at submit goes stale ──')
    const text = fs.readFileSync('docs/bulk-onboarding/fixtures/alden_fixture_clean.csv', 'utf8')
    const parsed = parseBulkCsv(text)
    if (!parsed.ok) throw new Error('fixture no longer parses')
    const emailCol = BULK_CSV_COLUMNS.indexOf('email')
    const victim = parsed.dataRows.map(r => (r[emailCol] ?? '').trim()).filter(Boolean)[0]
    const canary = await db.from('residents').insert({
      name: `ZZ Q ${S}`, email: victim, unit: '999',
      property: prop!.name, company: demo.name, is_active: true, status: 'active',
    }).select('id').maybeSingle()
    if (canary.error) throw new Error(`canary resident: ${canary.error.message}`)
    canaryResidentIds.push(canary.data!.id as number)
    console.log(`   added a resident at ${prop!.name} with ${victim}, an address from the file\n`)

    const r3 = await js(await call('/api/admin/import-batch/review', { batch_id: batchId }, admin))
    chk('🔴 the review screen now reports the file as NOT clean',
      r3.validation?.ran === true && r3.validation?.clean === false && r3.validation?.error_count > 0,
      `error_count=${r3.validation?.error_count} — the same bytes, the same hash, a different answer`)
    chk('   ...and the hash still matches, so this is the property changing, not the file',
      r3.file?.matches === true, `matches=${r3.file?.matches}`)
    chk('   ...and the error names the row and a fix',
      typeof r3.validation?.errors?.[0]?.row === 'number' && String(r3.validation?.errors?.[0]?.message ?? '').length > 12,
      str(r3.validation?.errors?.[0]))
    chk('🔴 Load is no longer offered on the approved batch', r3.can_load === false,
      `can_load=${r3.can_load} status=${r3.batch?.status}`)
    const staleApprove = await js(await call('/api/admin/import-batch/approve', { batch_id: batchId }, admin))
    chk('   ...and it cannot be re-approved into that state either',
      staleApprove.error === 'wrong_status' || staleApprove.error === 'file_has_errors',
      JSON.stringify(staleApprove).slice(0, 150))

    // ── 🔴 Return to company, one click ───────────────────────────
    console.log('\n── 🔴 Return to company ──')
    const retR = await call('/api/admin/import-batch/return', { batch_id: batchId, trigger: 'load' }, admin)
    const ret = await js(retR)
    chk('🔴 the approved batch is returned', retR.status === 200 && ret.ok === true,
      `HTTP ${retR.status} ${JSON.stringify({ status: ret.status, from: ret.from_status, n: ret.error_count })}`)
    chk('   ...from approved, and to rejected — no new status',
      ret.from_status === 'approved' && ret.status === 'rejected',
      `${ret.from_status} → ${ret.status}`)
    const { data: rejRow } = await db.from('import_batches')
      .select('status,reject_reason,reject_errors,reject_error_count,approved_by').eq('id', batchId).maybeSingle()
    chk('🔴 the row carries the auto-generated reason',
      typeof rejRow?.reject_reason === 'string' && rejRow.reject_reason.length > 60,
      String(rejRow?.reject_reason).slice(0, 200))
    chk('   ...and the reason says the file was fine when they sent it',
      /clean when you sent it/i.test(String(rejRow?.reject_reason)),
      'the CA must not read this as a judgement about their work')
    chk('🔴 the row-numbered errors are attached, with the TRUE count',
      Array.isArray(rejRow?.reject_errors) && (rejRow!.reject_errors as unknown[]).length > 0
      && Number(rejRow?.reject_error_count) >= (rejRow!.reject_errors as unknown[]).length,
      `${(rejRow?.reject_errors as unknown[])?.length} attached of ${rejRow?.reject_error_count} found`)
    chk('   ...and they are the errors the SERVER measured, matching the review',
      Number(rejRow?.reject_error_count) === Number(r3.validation?.error_count),
      `row says ${rejRow?.reject_error_count}, the review said ${r3.validation?.error_count} — a client-supplied list would not have to agree`)

    // ── 🔴 THE CA SEES IT, which is the point of attaching it ─────
    console.log('\n── 🔴 the company can read what it was told ──')
    const caSees = await ca.client.from('import_batches')
      .select('id,status,reject_reason,reject_errors,reject_error_count').eq('id', batchId).maybeSingle()
    chk('🔴 the CA reads the returned batch through their own policy',
      !caSees.error && caSees.data?.status === 'rejected',
      caSees.error ? caSees.error.message : `status=${caSees.data?.status}`)
    chk('   ...including the reason and the row-numbered errors',
      typeof caSees.data?.reject_reason === 'string'
      && Array.isArray(caSees.data?.reject_errors)
      && (caSees.data!.reject_errors as unknown[]).length > 0,
      `${(caSees.data?.reject_errors as unknown[])?.length} error(s) visible to the company — this is why the list lives on the row and not in the bucket, where the CA has INSERT and no SELECT`)
    const mgrSees = await mgr.client.from('import_batches').select('id').eq('id', batchId)
    chk('   ...and a manager at the same company sees nothing',
      (mgrSees.data ?? []).length === 0,
      `${(mgrSees.data ?? []).length} row(s) — RLS denials return an empty list, not an error`)

    // ══════════════════════════════════════════════════════════════
    // 🔴 REJECT — for a file that validates fine and still should not
    // load. Needs batch 8 back at submitted and the canary gone, so
    // the gate resets its own subject mid-run rather than at the end.
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 🔴 Reject, for a clean file ──')
    const delCanary = await db.from('residents').delete().in('id', canaryResidentIds).select('id')
    chk('the staleness canary is removed, so the file is clean again',
      (delCanary.data ?? []).length === canaryResidentIds.length,
      `${(delCanary.data ?? []).length}/${canaryResidentIds.length} removed`)
    canaryResidentIds.length = 0
    const reset = await db.from('import_batches')
      .update({ status: 'submitted', approved_by: null, approved_at: null,
                reject_reason: null, reject_errors: null, reject_error_count: null })
      .eq('id', batchId).select('status,reject_error_count').maybeSingle()
    chk('batch 8 is reset to submitted for the Reject path',
      !reset.error && reset.data?.status === 'submitted' && reset.data?.reject_error_count === null,
      str(reset.data ?? reset.error?.message))

    const shortReason = await call('/api/admin/import-batch/reject', { batch_id: batchId, reason: 'nope' }, admin)
    const shortJ = await js(shortReason)
    chk('🔴 a reason too short to carry a thought is refused',
      shortReason.status === 400 && shortJ.error === 'reason_required',
      `HTTP ${shortReason.status} — this sentence is the only thing the company is told about their file`)

    const typed = 'This is the resident list for Willowbrook Court, not Sunset Ridge. Please upload it against the right property.'
    const rejR = await call('/api/admin/import-batch/reject', { batch_id: batchId, reason: typed }, admin)
    const rej = await js(rejR)
    chk('🔴 a clean batch is rejected with the operator\'s typed reason',
      rejR.status === 200 && rej.ok === true, `HTTP ${rejR.status} ${JSON.stringify(rej).slice(0, 140)}`)
    const { data: rejRow2 } = await db.from('import_batches')
      .select('status,reject_reason,reject_errors,reject_error_count').eq('id', batchId).maybeSingle()
    chk('🔴 the ruled shape is stored: an EMPTY array and a ZERO count',
      Array.isArray(rejRow2?.reject_errors) && (rejRow2!.reject_errors as unknown[]).length === 0
      && rejRow2?.reject_error_count === 0,
      `reject_errors=${JSON.stringify(rejRow2?.reject_errors)} count=${rejRow2?.reject_error_count} — NULL would mean "never rejected", and this batch has been`)
    chk('   ...and the reason is the one the operator typed, not a generated one',
      rejRow2?.reject_reason === typed, String(rejRow2?.reject_reason).slice(0, 90))

    // 🔴 THE EQUIVALENCE, PROBED DIRECTLY. The ruling asked for this to
    // be confirmed and the answer before 2026-10-16 was no on both
    // halves: ([], 0) was refused and ([], 5) was allowed.
    console.log('\n── 🔴 count = 0 exactly when the list is empty ──')
    const probe = await db.from('import_batches').insert({
      company_id: batch.company_id, property_id: batch.property_id,
      source_filename: 'zz-eq.csv', storage_path: `${batch.property_id}/zz-eq.csv`,
      file_sha256: 'e'.repeat(64),
      attested_by_user_id: adminUid, attested_name: 'Probe', attested_title: 'Probe',
      resident_count: 1, vehicle_count: 1, status: 'submitted',
    }).select('id').maybeSingle()
    if (probe.error) throw new Error(`equivalence probe: ${probe.error.message}`)
    const pid = probe.data!.id as number
    const shape = async (errs: unknown, n: unknown) => {
      const r = await db.from('import_batches')
        .update({ status: 'rejected', reject_reason: 'probe reason text', reject_errors: errs, reject_error_count: n })
        .eq('id', pid).select('id')
      await db.from('import_batches').update({ status: 'submitted', reject_reason: null, reject_errors: null, reject_error_count: null }).eq('id', pid)
      return { refused: !!r.error, which: r.error?.message.match(/constraint "([^"]+)"/)?.[1] ?? r.error?.message?.slice(0, 50) ?? '' }
    }
    const eqA = await shape([], 0)
    chk('🔴 ([], 0) — the clean-reject pairing — is ALLOWED', !eqA.refused, eqA.which)
    const eqB = await shape([], 5)
    chk('🔴 ([], 5) — a claim with no evidence — is REFUSED', eqB.refused,
      eqB.refused ? eqB.which + ' — the company would be told five rows are wrong and shown none' : '🔴 allowed')
    const eqC = await shape([{ row: 1, message: 'x' }], 0)
    chk('   ([e], 0) — a list with no claim — is refused', eqC.refused, eqC.which)
    const eqD = await shape([{ row: 1, message: 'x' }, { row: 2, message: 'y' }], 40)
    chk('   ([e,e], 40) — a capped list — is still allowed', !eqD.refused, eqD.which)
    const pdel = await db.from('import_batches').delete().eq('id', pid).select('id')
    chk('the equivalence probe row is removed', (pdel.data ?? []).length === 1, `${(pdel.data ?? []).length} removed`)

    // ── 🔴 THE AUDIT TRAIL ────────────────────────────────────────
    console.log('\n── 🔴 the audit trail ──')
    const { data: audit } = await db.from('audit_logs')
      .select('action,user_email,record_id,old_values,new_values,notes')
      .eq('table_name', 'import_batches').eq('record_id', String(batchId))
      .gte('created_at', new Date(S - 60_000).toISOString())
    const actions = (audit ?? []).map(a => String(a.action))
    chk('🔴 every transition this gate made is audited',
      actions.includes('IMPORT_BATCH_APPROVED') && actions.includes('IMPORT_BATCH_REJECTED'),
      `${actions.length} row(s): ${actions.join(', ')}`)
    // 🔴 THIS ASSERTION WAS WRONG BEFORE THE CODE WAS. It read "every
    // audit row names the operator" and failed on a row with no email —
    // which turned out to be the gate's OWN service_role reset of
    // batch 8 back to 'submitted' mid-run. A service_role write has no
    // jwt email, so the trigger recorded no operator, which is correct
    // and is the behaviour its comment exists for: it covers writes
    // made outside the RPCs, and those are the ones most worth a
    // record. Inventing an email for them would be the defect.
    //
    // So the two groups are asserted separately.
    const byRpc = (audit ?? []).filter(a =>
      ['approved', 'rejected'].includes(String((a.new_values as Record<string, unknown>)?.status)))
    chk('🔴 every transition an RPC made names the operator who made it',
      byRpc.length >= 3 && byRpc.every(a => String(a.user_email) === admin.email),
      `${byRpc.length} RPC transition(s), emails: ${[...new Set(byRpc.map(a => a.user_email))].join(', ')}`)
    const byService = (audit ?? []).filter(a => !a.user_email)
    chk('   ...and a service_role write is recorded as having NO operator, not a guessed one',
      byService.every(a => String((a.new_values as Record<string, unknown>)?.status) === 'submitted'),
      `${byService.length} row(s) with no email — this gate's own reset of batch 8. A write with no identity must read as no identity; the trigger covering writes made outside the RPCs is the point of it being a trigger.`)
    chk('   ...and recording what it moved FROM as well as to',
      (audit ?? []).some(a => (a.old_values as Record<string, unknown> | null)?.status === 'approved'),
      JSON.stringify((audit ?? []).map(a => ({ from: (a.old_values as Record<string, unknown> | null)?.status, to: (a.new_values as Record<string, unknown>)?.status }))))
    // 🔴 An audit table is read by more people and kept longer than the
    // row it describes, so none of the resident data in reject_errors
    // may reach it.
    const audBlob = JSON.stringify((audit ?? []).map(a => a.new_values))
    chk('🔴 NO resident data in the audit rows — no plate, no email, no unit',
      !/plate|@|\bunit\b/i.test(audBlob),
      audBlob.slice(0, 200))
    chk('   ...but the counts, ids and hash are there, which is what a reviewer needs',
      (audit ?? []).every(a => {
        const v = a.new_values as Record<string, unknown>
        return v && v.file_sha256 && v.property_id !== undefined && v.resident_count !== undefined
      }),
      str((audit ?? [])[0]?.new_values, 180))

    // ── a non-operator cannot reject ──────────────────────────────
    const mgrReject = await call('/api/admin/import-batch/reject', { batch_id: batchId, reason: typed }, mgr)
    chk('a manager cannot reject', mgrReject.status === 403, `HTTP ${mgrReject.status}`)
    const caRejectRpc = await ca.client.rpc('reject_import_batch', { p_batch_id: batchId, p_reason: typed })
    chk('   ...and the RPC refuses a CA with the route bypassed',
      (caRejectRpc.data as Record<string, unknown> | null)?.error === 'not_operator',
      str(caRejectRpc.data ?? caRejectRpc.error))

    // ── the fixed file can be resubmitted ─────────────────────────
    const resub = await db.from('import_batches').insert({
      company_id: batch.company_id, property_id: batch.property_id,
      source_filename: 'zz-resub.csv', storage_path: `${batch.property_id}/zz-resub.csv`,
      file_sha256: String(batch.file_sha256),
      attested_by_user_id: adminUid, attested_name: 'Probe', attested_title: 'Probe',
      resident_count: 1, vehicle_count: 1, status: 'submitted',
    }).select('id').maybeSingle()
    if (resub.data?.id) await db.from('import_batches').delete().eq('id', resub.data.id)
    chk('🔴 once returned, the company CAN resubmit — rejected is not live',
      !resub.error,
      resub.error ? `🔴 ${resub.error.message} — a return the company cannot act on is a dead end` : 'the fixed file is not blocked by the batch it replaces')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
