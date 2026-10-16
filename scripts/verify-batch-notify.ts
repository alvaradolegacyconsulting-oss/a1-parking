// ════════════════════════════════════════════════════════════════════
// GATE — the load/return/reject notification BOOKKEEPING
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHAT THIS GATE PROVES, AND WHAT IT CANNOT. It runs locally, and a
// local `next dev` reads .env.local, which does not carry
// RESEND_API_KEY — that key is a Vercel SHARED (team-level) variable
// and applies to deployments, not to this machine. So 'failed' is the
// EXPECTED outcome here and the gate is built around it. What it proves
// is the bookkeeping: that a send failure is recorded, that it never
// fails or re-steers the action, and that a non-delivery can never read
// as a delivery. DELIVERY ITSELF IS PROVEN ON THE REAL DEPLOYMENT, by
// the production demo send — not here.
//
// That division is deliberate. A gate that needed a live mail provider
// would be a gate nobody could run, and the defect class worth catching
// is not "Resend was down", it is "the queue said the company was told
// when it wasn't".
//
// 🔴 ONE DEVIATION FROM THE SPEC, STATED RATHER THAN SMUGGLED.
// Assertion (d) was specified as "notify_error is non-null iff the
// outcome is failed". The writer also records a reason for 'skipped'
// — "no recipient to write to" — because knowing WHY nobody was
// emailed is the whole value of the column, and an unexplained
// 'skipped' is the absence-as-answer failure. So the gate asserts the
// intent in its true form:
//
//     a NON-SUCCESS outcome (failed | skipped) always carries a reason,
//     and a SUCCESS outcome (sent | overridden) never does.
//
// The success half cannot be exercised without a key, so it is reported
// as NOT EXERCISED rather than as a pass.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-batch-notify.ts

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import fs from 'fs'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import { cookieHeaderFor } from './lib/ssr-session'
import { BULK_CSV_HEADER } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 4007
const BASE = `http://127.0.0.1:${PORT}`
// 🔴 Not Northgate: that property carries the production demo-send
// batches. A gate that seeds where a human is mid-walkthrough is a gate
// that corrupts the thing it was run alongside.
const PROPERTY = 'Sunset Ridge Apartments'
const S = Date.now()

const LEGAL = ['sent', 'overridden', 'failed', 'skipped']
const SUCCESS = ['sent', 'overridden']

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; say(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
const note = (n: string, d: string) => say(`➖ ${n}\n       ${d}`)

let srv: DevServer | null = null
let operatorEmail = ''
let operatorUid = ''
const seeded: number[] = []
// 🔴 THE GATE SETS THE FLAG IT NEEDS, AND RESTORES WHAT IT FOUND.
// It first ran while bulk_onboarding_enabled happened to be ON for the
// demo company, and went red the moment that flag was turned off after
// the demo send: the reject route refuses with `blocked` —
// "the company would not be able to send a replacement" — which is the
// route behaving correctly and the gate depending on state it never
// established. Same correction the six flag-flipping gates took.
let flaggedCompany: number | null = null
let flagWas: boolean | null = null

async function teardown(why: string) {
  if (flaggedCompany !== null) {
    const want = flagWas === true
    const r = await db.from('companies').update({ bulk_onboarding_enabled: want })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    const back = r.data?.[0]?.bulk_onboarding_enabled
    say(`   ↩ bulk_onboarding_enabled back to ${back} on company ${flaggedCompany} (as found)`)
  }
  for (const id of seeded) {
    const b = await db.from('import_batches').select('storage_path').eq('id', id).maybeSingle()
    if (b.data?.storage_path) await db.storage.from('bulk-onboarding').remove([String(b.data.storage_path)])
    const del = await db.from('import_batches').delete().eq('id', id).select('id')
    const aud = await db.from('audit_logs').delete()
      .eq('table_name', 'import_batches').eq('record_id', String(id)).select('id')
    say(`   ↩ batch ${id}: removed ${del.data?.length ?? 0} row(s), ${aud.data?.length ?? 0} audit row(s)`)
  }
  if (operatorEmail) {
    const r = await db.from('user_roles').delete().ilike('email', operatorEmail).select('id')
    say(`   ↩ removed ${r.data?.length ?? 0} operator role row(s)`)
  }
  if (operatorUid) { await db.auth.admin.deleteUser(operatorUid); say('   ↩ deleted the temporary operator account') }
  if (srv) { await srv.stop(); say('   ↩ stopped the server this gate started') }
  if (why === 'throw') warn('   (teardown ran from the failure path)')
}

/**
 * A small file that is genuinely CLEAN at the target property.
 *
 * 🔴 NOT A COMMITTED FIXTURE. The gate first seeded alden_fixture_clean
 * and the reject route refused it with use_return: "4 rows no longer fit
 * the records at Sunset Ridge Apartments". It was right to — reject
 * re-validates, and a file whose rows have since collided is a Return,
 * not a Reject. A fixture that was clean against a property last month
 * is not clean against it today, so the rows are generated per run with
 * plates and emails nothing else can hold.
 */
function smallValidCsv(tag: string, rows: number): Buffer {
  const lines = [BULK_CSV_HEADER]
  for (let i = 1; i <= rows; i++) {
    const plate = `ZZ${tag.toUpperCase().slice(-4)}${String(i).padStart(2, '0')}`
    lines.push([
      `90${String(i).padStart(2, '0')}`,              // unit, plainly written
      'Gate', `Probe ${i}`,                            // one name is enough; both given
      `alvaradolegacyconsulting+gate${tag}${i}@gmail.com`,
      '', plate, 'TX', 'Toyota', 'Corolla', 'Silver', '',
    ].join(','))
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

/** A disposable submitted batch. `attestedBy` null ⇒ unresolvable CA. */
async function seed(attestedBy: string | null, tag: string): Promise<number> {
  const { data: co } = await db.from('companies').select('id,name').eq('company_env', 'demo').limit(1).maybeSingle()
  if (!co) throw new Error('no demo company')
  const { data: prop } = await db.from('properties').select('id').eq('company', co.name).eq('name', PROPERTY).maybeSingle()
  if (!prop) throw new Error(`${PROPERTY} not found at ${co.name}`)

  // Distinct bytes per batch: import_batches_one_live_per_file is
  // UNIQUE on (property_id, file_sha256) for live statuses, so two
  // identical files on one property cannot both be submitted. The tag
  // is in the plates and the emails, so two batches differ in content
  // rather than in a trailing comment.
  const ROWS = 3
  const bytes = smallValidCsv(tag, ROWS)
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')

  const ins = await db.from('import_batches').insert({
    company_id: co.id, property_id: prop.id,
    source_filename: `zz_notify_gate_${tag}.csv`, storage_path: `batches/zz_notify_gate_${tag}.csv`,
    file_sha256: sha,
    // 🔴 No FK on this column — measured. A random UUID is accepted,
    // which is also the real-world shape: delete the CA who submitted a
    // batch and the attestation points at nothing.
    attested_by_user_id: attestedBy ?? crypto.randomUUID(),
    attested_name: 'Notification Gate', attested_title: 'Automated',
    // The queue displays these, and the loader recomputes them; a
    // seeded zero would have the queue advertise an empty file.
    status: 'submitted', resident_count: ROWS, vehicle_count: ROWS,
  }).select('id').single()
  if (ins.error) throw new Error(`seed ${tag}: ${ins.error.message}`)
  const id = ins.data.id as number
  seeded.push(id)

  const path = `batches/${id}.csv`
  const up = await db.storage.from('bulk-onboarding').upload(path, bytes, { contentType: 'text/csv', upsert: true })
  if (up.error) throw new Error(`upload ${tag}: ${up.error.message}`)
  const fix = await db.from('import_batches').update({ storage_path: path }).eq('id', id).select('id').single()
  if (fix.error) throw new Error(`storage_path ${tag}: ${fix.error.message}`)
  return id
}

async function readBatch(id: number) {
  const { data } = await db.from('import_batches')
    .select('status,notify_ca_outcome,notify_admin_outcome,notify_error,notified_at').eq('id', id).maybeSingle()
  return data as Record<string, unknown> | null
}

/** Status-transition audit rows for a batch, oldest first. */
async function statusAudit(id: number): Promise<string[]> {
  const { data } = await db.from('audit_logs').select('action,created_at')
    .eq('table_name', 'import_batches').eq('record_id', String(id)).order('created_at')
  return (data ?? []).map(r => String(r.action))
}

async function rejectOverHttp(cookie: string, id: number, reason: string) {
  const r = await fetch(`${BASE}/api/admin/import-batch/reject`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ batch_id: id, reason }),
  })
  let body: Record<string, unknown> = {}
  try { body = await r.json() as Record<string, unknown> } catch { /* non-JSON */ }
  return { status: r.status, body }
}

const main = async () => {
  if (await portBusy(PORT)) { warn(`🔴 something is already listening on ${PORT}`); process.exit(2) }
  say('\n══ import-batch notification bookkeeping ══\n')
  say(`RESEND_API_KEY in this process: ${process.env.RESEND_API_KEY ? 'present' : 'ABSENT — "failed" is the expected outcome'}`)
  say(`IMPORT_BATCH_ALERT_EMAIL: ${process.env.IMPORT_BATCH_ALERT_EMAIL ?? '(unset)'}\n`)

  try {
    // Establish the flag BEFORE anything else, and register the restore
    // before the write so a crash still puts it back.
    const { data: demoCo } = await db.from('companies')
      .select('id,name,bulk_onboarding_enabled').eq('company_env', 'demo').limit(1).maybeSingle()
    if (!demoCo) throw new Error('no demo company')
    flaggedCompany = demoCo.id as number
    flagWas = demoCo.bulk_onboarding_enabled === true
    const on = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (on.error || on.data?.[0]?.bulk_onboarding_enabled !== true) {
      throw new Error('could not enable bulk onboarding for the demo company')
    }
    say(`bulk_onboarding_enabled set true on ${demoCo.name} (was ${flagWas}; restored on exit)\n`)

    const { data: ca } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const demoCa = (ca?.users ?? []).find(u => (u.email ?? '').toLowerCase() === 'demo-ca@test.shieldmylot.com')
    if (!demoCa) throw new Error('demo-ca@test.shieldmylot.com has no auth user')

    const batchA = await seed(demoCa.id, `a${S}`)
    const batchB = await seed(null, `b${S}`)
    say(`seeded batch ${batchA} (resolvable CA) and batch ${batchB} (unresolvable CA)\n`)

    operatorEmail = `zz-notify-gate-${S}@test.invalid`
    const u = await db.auth.admin.createUser({ email: operatorEmail, email_confirm: true, password: `Zz!${S}q` })
    if (u.error || !u.data.user) throw new Error(`createUser: ${u.error?.message}`)
    operatorUid = u.data.user.id
    const ins = await db.from('user_roles').insert({
      email: operatorEmail, role: 'admin', company: null, property: [], is_active: true,
    }).select('id')
    if (ins.error) throw new Error(`operator role: ${ins.error.message}`)
    const session = await cookieHeaderFor(db, URL_, ANON, operatorEmail)
    const cookie = session.cookie

    srv = await startDevServer(PORT)
    if (!srv) throw new Error('server did not come up')

    // ── the action ───────────────────────────────────────────────────
    say('── 1. the reject goes through, and the send does not stop it ──')
    const before = await statusAudit(batchA)
    const res = await rejectOverHttp(cookie, batchA, 'notification bookkeeping gate')
    chk('(a) the route returns HTTP 200', res.status === 200, `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`)

    const a1 = await readBatch(batchA)
    chk('(b) the status moved to rejected', a1?.status === 'rejected', `status=${a1?.status}`)

    // ── the bookkeeping ──────────────────────────────────────────────
    say('\n── 2. the outcome is recorded, in the vocabulary ──')
    const caOut = a1?.notify_ca_outcome as string | null
    chk('(c) notify_ca_outcome is one of the four legal values',
      typeof caOut === 'string' && LEGAL.includes(caOut),
      `notify_ca_outcome=${JSON.stringify(caOut)} — legal: ${LEGAL.join(' | ')}`)
    chk('   ...and notified_at was stamped', !!a1?.notified_at, String(a1?.notified_at ?? 'null'))

    const err = a1?.notify_error as string | null
    if (caOut && SUCCESS.includes(caOut)) {
      chk('(d) a SUCCESS outcome carries no error', !err, `outcome=${caOut} error=${JSON.stringify(err)}`)
    } else {
      chk('(d) a NON-SUCCESS outcome carries a reason', !!err && err.trim().length > 0,
        `outcome=${caOut} error=${JSON.stringify(err?.slice(0, 120))}`)
      // 🔴 Absence is not a pass. The success half of (d) needs a mail
      // provider; say it was not exercised rather than let the pass
      // count for both directions.
      note('(d) the SUCCESS half was NOT EXERCISED',
        'no RESEND_API_KEY in this process, so sent/overridden is unreachable locally. Proven by the production demo send.')
    }

    say('\n── 3. 🔴 a failed send does not re-steer the batch ──')
    const a2 = await readBatch(batchA)
    chk('(e) the status is unchanged on a second read', a2?.status === a1?.status,
      `${a1?.status} → ${a2?.status}`)
    const after = await statusAudit(batchA)
    // The trigger fires AFTER INSERT and on a status UPDATE, so a
    // seeded-then-rejected batch has exactly two. A third would mean
    // something moved the status again.
    chk('   ...and exactly ONE status transition was recorded for the action',
      after.length === before.length + 1,
      `audit actions: ${after.join(' → ')} (was ${before.length}, now ${after.length})`)
    chk('   ...and the last transition is the reject, not a mail artefact',
      after[after.length - 1] === 'IMPORT_BATCH_REJECTED', after.join(' → '))

    // ── the negative control ─────────────────────────────────────────
    say('\n── 4. 🔴 negative control: an unresolvable recipient ──')
    const resB = await rejectOverHttp(cookie, batchB, 'negative control, unresolvable recipient')
    chk('the action still succeeds with nobody to write to', resB.status === 200,
      `HTTP ${resB.status} ${JSON.stringify(resB.body).slice(0, 120)}`)
    const b1 = await readBatch(batchB)
    const bOut = b1?.notify_ca_outcome as string | null
    chk('🔴 an unresolvable recipient is skipped, NEVER sent',
      bOut === 'skipped',
      `notify_ca_outcome=${JSON.stringify(bOut)} — 'sent' here would be a notification nobody received`)
    chk('   ...and the skip says why', !!(b1?.notify_error),
      String(b1?.notify_error ?? 'null').slice(0, 120))
    chk('   ...and that batch moved too', b1?.status === 'rejected', `status=${b1?.status}`)

    // ── (f) cleanup is checked, not assumed ──────────────────────────
    say('\n── 5. (f) the probe batches leave nothing behind ──')
  } catch (e) {
    warn(`🔴 ${(e as Error).message}`)
    await teardown('throw')
    process.exit(2)
  }

  const ids = [...seeded]
  await teardown('end')
  for (const id of ids) {
    const row = await db.from('import_batches').select('id').eq('id', id)
    const aud = await statusAudit(id)
    chk(`(f) batch ${id} and its audit rows are gone, read back`,
      (row.data ?? []).length === 0 && aud.length === 0,
      `${(row.data ?? []).length} batch row(s), ${aud.length} audit row(s)`)
  }

  say(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await teardown('throw'); process.exit(2) })
