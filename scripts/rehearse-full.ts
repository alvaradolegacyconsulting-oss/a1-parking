// ════════════════════════════════════════════════════════════════════
// THE FULL REHEARSAL — submit, approve, load, and a real claim email
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. The whole arc end to end on
// alden_fixture_rehearsal.csv, finishing with an invite that actually
// arrives in Jose's inbox.
//
// 🔴 THIS IS NOT A GATE AND IT DOES NOT CLEAN UP. A gate proves
// something and leaves no trace; a rehearsal leaves the thing it built
// so a person can look at it. It ends with 228 residents and 358
// vehicles at a demo property and an email in a real mailbox, and the
// summary says how to undo it.
//
// 🔴 WILLOWBROOK COURT, NOT SUNSET RIDGE. Batch 8 is the gates' subject
// and lives on Sunset Ridge. Both fixtures carry the SAME 358 plates,
// and the plate uniqueness index is (normalize_plate, property) — so
// loading the rehearsal onto Sunset Ridge would make batch 8
// permanently unloadable and break verify:loader and verify:rollback.
// A different property keeps the two apart with no overlap at all.
//
// 🔴 THE CAPTCHA IS THE ONE THING BYPASSED, AND NOTHING ELSE IS.
// The claim route verifies Turnstile and a script cannot solve one, so
// the server runs with Cloudflare's published always-pass test secret.
// Everything downstream is real: a real Supabase invite, through the
// real template, to a real mailbox.
//
// Usage: npm run rehearse:full

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import fs from 'fs'
import crypto from 'crypto'
import { cookieHeaderFor } from './lib/ssr-session'
import { BULK_BUCKET } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 4002
const BASE = `http://127.0.0.1:${PORT}`
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const FIXTURE = 'docs/bulk-onboarding/fixtures/alden_fixture_rehearsal.csv'
const CA_EMAIL = 'demo-ca@test.shieldmylot.com'
const PROPERTY = 'Willowbrook Court'
const CLAIMANT = 'jose+bulkload1@shieldmylot.com'
const S = Date.now()

let srv: DevServer | null = null
let operatorUid = '', operatorEmail = ''
let flaggedCompany: number | null = null
let uploadedPath: string | null = null
let cleaned = false

// 🔴 Only the SCAFFOLDING is taken down: the flag, the temporary
// operator, an unconsumed upload. The batch and its records stay —
// that is the point of a rehearsal.
async function teardownScaffolding(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 teardown (${why})`)
  if (operatorEmail) {
    const r = await db.from('user_roles').delete().ilike('email', operatorEmail).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed the temporary operator's role row`)
  }
  if (operatorUid) {
    const r = await db.auth.admin.deleteUser(operatorUid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) warn(`   🔴 could not delete the temporary operator ${operatorUid} — DELETE IT BY HAND, it is a super-admin`)
    else say(`   ↩ deleted the temporary operator account`)
  }
  if (flaggedCompany !== null) {
    const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== false) warn('   🔴 FLAG NOT RESTORED — set it back by hand')
    else say(`   ↩ bulk_onboarding_enabled back to false (the gates refuse to run while it is on)`)
  }
  if (uploadedPath) {
    const left = await db.storage.from(BULK_BUCKET).download(uploadedPath)
    if (!left.error) { await db.storage.from(BULK_BUCKET).remove([uploadedPath]); say(`   ↩ removed the unconsumed upload`) }
  }
  if (srv) { await srv.stop(); srv = null; say('   ↩ stopped the server') }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    teardownScaffolding(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  warn(`🔴 uncaught: ${(e as Error).message}`)
  teardownScaffolding('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const die = (m: string): never => { warn(`🔴 ${m}`); throw new Error(m) }
const step = (n: number, t: string) => say(`\n${'═'.repeat(66)}\n  STEP ${n} — ${t}\n${'═'.repeat(66)}`)

const main = async () => {
  if (await portBusy(PORT)) die(`something is already listening on ${PORT}`)
  if (!fs.existsSync(FIXTURE)) die(`${FIXTURE} is missing. Run npm run derive:rehearsal first.`)

  // ── the subject ──────────────────────────────────────────────────
  const { data: cos } = await db.from('companies')
    .select('id,name,company_env,bulk_onboarding_enabled').eq('company_env', 'demo')
  const demo = (cos ?? [])[0]
  if (!demo) die("no company with company_env='demo'. A rehearsal runs on a demo tenant, never A1.")
  const { data: prop } = await db.from('properties').select('id,name,is_active')
    .eq('company', demo!.name).eq('name', PROPERTY).maybeSingle()
  if (!prop) throw new Error(`${PROPERTY} not found at ${demo!.name}`)
  if (prop.is_active !== true) die(`${PROPERTY} is not active`)

  // 🔴 RESUMABLE, BECAUSE THE FIRST RUN TAUGHT ME THAT IT HAD TO BE.
  // Steps 1-3 succeeded and step 4 died on a transient `fetch failed`
  // from the 358-row validation RPC — the fourth heavy call in a row.
  // The upload had already been consumed by submit, so a rehearsal that
  // refuses when a batch exists would have meant deleting the batch and
  // re-uploading to recover from a network blip.
  //
  // So: a submitted or approved batch is RESUMED from where it got to.
  // A loaded one is refused, because that is the one state where
  // continuing would stack a second load onto the same plates.
  const { data: existing } = await db.from('import_batches')
    .select('id,status,loaded_resident_count').eq('property_id', prop.id)
  const prior = (existing ?? [])[0]
  if (prior && !['submitted', 'approved'].includes(String(prior.status))) {
    say(`\nThere is already a batch on ${PROPERTY}:`)
    for (const b of existing ?? []) say(`   batch ${b.id} · ${b.status} · ${b.loaded_resident_count ?? '—'} loaded`)
    say('\nNothing done. Roll it back from the queue (same day) or delete the row, then run again.')
    return
  }
  if (prior) {
    say(`\n↻ resuming batch ${prior.id} (${prior.status}) — steps 1-3 are already done`)
  }

  const { data: caRole } = await db.from('user_roles').select('email,role,company,is_active')
    .ilike('email', CA_EMAIL).maybeSingle()
  if (!caRole || caRole.role !== 'company_admin' || caRole.is_active !== true
      || String(caRole.company).trim().toLowerCase() !== String(demo!.name).trim().toLowerCase()) {
    die(`${CA_EMAIL} is not an active company_admin at ${demo!.name}`)
  }

  say(`rehearsal subject: ${demo!.name} · ${PROPERTY} (id ${prop.id})`)
  say(`  the customer:  ${CA_EMAIL}`)
  say(`  the file:      ${FIXTURE}`)
  say(`  the claimant:  ${CLAIMANT}\n`)

  try {
    // ── a temporary operator ───────────────────────────────────────
    // 🔴 Not Jose's own admin account: that would mean minting a
    // session for a real person's login. A named temporary operator
    // does the two operator actions and is deleted at the end; the
    // audit rows keep its address, so the provenance stays readable.
    operatorEmail = `zz-rehearsal-operator-${S}@test.invalid`
    const u = await db.auth.admin.createUser({ email: operatorEmail, email_confirm: true, password: `Zz!${S}q` })
    if (u.error || !u.data.user) throw new Error(`createUser: ${u.error?.message}`)
    operatorUid = u.data.user.id
    const ins = await db.from('user_roles').insert({
      email: operatorEmail, role: 'admin', company: null, property: [], is_active: true,
    }).select('id')
    if (ins.error) die(`operator role: ${ins.error.message}`)
    const op = await cookieHeaderFor(db, URL_, ANON, operatorEmail)
    const caSession = await cookieHeaderFor(db, URL_, ANON, CA_EMAIL)
    const asCa: SupabaseClient = createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${caSession.accessToken}` } },
    })

    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo!.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) die('could not enable the flag')
    flaggedCompany = demo!.id as number

    srv = await startDevServer(PORT, { env: { TURNSTILE_SECRET_KEY: TEST_SECRET, NODE_ENV: 'development' } })
    if (!srv) die('server did not come up')

    const post = (path: string, body: unknown, cookie: string) => fetch(`${BASE}${path}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
    const js = async (r: Response) => { try { return JSON.parse(await r.text()) as Record<string, any> } catch { return {} } }

    let batchId = prior ? Number(prior.id) : 0

    if (!prior) {
    // ══ STEP 1 — the customer uploads ═════════════════════════════
    step(1, 'the company uploads its file')
    const bytes = fs.readFileSync(FIXTURE)
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    const path = `${prop.id}/${crypto.randomUUID()}.csv`
    const up = await asCa.storage.from(BULK_BUCKET).upload(path, bytes, { contentType: 'text/csv' })
    if (up.error) die(`upload refused: ${up.error.message}`)
    uploadedPath = path
    say(`  uploaded as the CA: ${path}`)
    say(`  ${bytes.length} bytes, sha256 ${sha.slice(0, 16)}…`)

    // ══ STEP 2 — the preview ══════════════════════════════════════
    step(2, 'the company previews it')
    const prev = await js(await post('/api/bulk-onboarding/preview', { object_path: path }, caSession.cookie))
    if (prev.ok !== true) die(`preview failed: ${JSON.stringify(prev)}`)
    say(`  ${prev.data_rows} rows · ${prev.resident_count} residents · ${prev.vehicle_count} vehicles`)
    say(`  clean: ${prev.clean}${prev.error_count ? ` (${prev.error_count} error(s))` : ''}`)
    if (prev.clean !== true) die(`the rehearsal file is not clean at ${PROPERTY}: ${JSON.stringify(prev.errors).slice(0, 400)}`)

    // ══ STEP 3 — the company submits ══════════════════════════════
    step(3, 'the company submits it for review')
    const sub = await js(await post('/api/bulk-onboarding/submit', {
      object_path: path, source_filename: 'alden_fixture_rehearsal.csv',
      attested_name: 'Demo Company Administrator', attested_title: 'Property Operations',
    }, caSession.cookie))
    if (sub.ok !== true) die(`submit failed: ${JSON.stringify(sub)}`)
    uploadedPath = null
    batchId = Number(sub.batch_id)
    say(`  batch ${batchId} · status ${sub.status} · ${sub.resident_count} residents · ${sub.vehicle_count} vehicles`)
    }

    // ══ STEP 4 — the operator reviews ═════════════════════════════
    step(4, 'the operator reviews it against the property as it stands')
    // 🔴 RETRIED, BECAUSE "COULD NOT CHECK" IS NOT "DIRTY". The review
    // pushes 358 rows through bulk_validate_rows, and the first run of
    // this rehearsal died when that call came back `fetch failed` — a
    // transport failure, not a verdict about the file. The review route
    // reports it correctly as validation.ran === false rather than
    // guessing clean, which is exactly right for the route and exactly
    // not a reason for a rehearsal to stop. Three attempts, then give
    // up and say what happened.
    let rev: Record<string, any> = {}
    for (let attempt = 1; attempt <= 3; attempt++) {
      rev = await js(await post('/api/admin/import-batch/review', { batch_id: batchId }, op.cookie))
      if (rev.ok === true && rev.validation?.ran === true) break
      const why = rev.ok === true ? String(rev.validation?.why ?? '') : JSON.stringify(rev)
      if (attempt < 3) {
        warn(`  ⟳ attempt ${attempt}: the record checks did not run — ${why.slice(0, 120)}`)
        await new Promise(r => setTimeout(r, 2500))
      } else {
        die(`review could not validate after 3 attempts: ${why}`)
      }
    }
    if (rev.ok !== true) die(`review failed: ${JSON.stringify(rev)}`)
    say(`  file hash matches what was attested: ${rev.file?.matches}`)
    say(`  blocked: ${rev.block?.blocked}   load-blocked (billing): ${rev.block?.loadBlocked}`)
    say(`  record checks ran: ${rev.validation?.ran}   clean: ${rev.validation?.clean}`)
    if (rev.can_approve !== true) die(`not approvable: ${JSON.stringify({ block: rev.block, validation: rev.validation })}`)

    // ══ STEP 5 — approve ══════════════════════════════════════════
    step(5, 'the operator approves it')
    const ap = await js(await post('/api/admin/import-batch/approve', { batch_id: batchId }, op.cookie))
    if (ap.ok !== true) die(`approve failed: ${JSON.stringify(ap)}`)
    say(`  approved`)

    // ══ STEP 6 — load ═════════════════════════════════════════════
    step(6, 'the operator loads it — a separate decision')
    const ld = await js(await post('/api/admin/import-batch/load', { batch_id: batchId }, op.cookie))
    if (ld.ok !== true) die(`load failed: ${JSON.stringify(ld)}`)
    say(`  loaded into ${ld.property}: ${ld.residents} residents, ${ld.vehicles} vehicles, ${ld.roles} logins-in-waiting`)

    // ══ STEP 7 — the resident claims ══════════════════════════════
    step(7, `the resident asks for a login — ${CLAIMANT}`)
    const { data: me } = await db.from('residents').select('id,name,unit,email,import_batch_id')
      .ilike('email', CLAIMANT).eq('import_batch_id', batchId).maybeSingle()
    if (!me) throw new Error(`${CLAIMANT} is not in batch ${batchId}. Did derive:rehearsal run against the current fixture?`)
    say(`  they are in the batch: unit ${me.unit}, ${me.name}`)
    const { count: theirCars } = await db.from('vehicles').select('*', { count: 'exact', head: true })
      .eq('import_batch_id', batchId).ilike('resident_email', CLAIMANT)
    say(`  with ${theirCars} vehicle(s) on file`)

    const claim = await fetch(`${BASE}/api/register/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CLAIMANT, property: PROPERTY, captchaToken: 'rehearsal' }),
    })
    const claimBody = await claim.text()
    say(`  /api/register/claim → HTTP ${claim.status}`)
    say(`  the screen says: ${claimBody}`)

    const all = await db.auth.admin.listUsers({ perPage: 1000 })
    const made = (all.data?.users ?? []).find(x => (x.email ?? '').toLowerCase() === CLAIMANT)
    if (!made) {
      warn(`  🔴 NO AUTH USER for ${CLAIMANT} — the invite did not go out. The screen says the same thing either way, by design, so the log above is the only place this shows.`)
      // An explicit throw rather than die(), because TypeScript narrows
      // on a throw and does not narrow through a never-returning const
      // arrow — and the three lines below read `made` directly.
      throw new Error('the claim did not produce an invite')
    }
    say(`  ✅ an auth user now exists: ${made.id}`)
    say(`     confirmed: ${made.email_confirmed_at ?? 'not yet — the link in the email does that'}`)
    const meta = (made.user_metadata ?? {}) as Record<string, unknown>
    say(`     invite metadata: property=${meta.claim_property} unit=${meta.claim_unit} vehicles=${meta.claim_vehicle_count}`)
    if (JSON.stringify(meta).toLowerCase().includes('plate')) warn('  🔴 the invite metadata mentions a plate — it must not')

    // ══ the summary ═══════════════════════════════════════════════
    const { data: finalRow } = await db.from('import_batches')
      .select('id,status,loaded_at,loaded_resident_count,loaded_vehicle_count').eq('id', batchId).maybeSingle()
    say(`\n${'═'.repeat(66)}`)
    say(`  REHEARSAL COMPLETE`)
    say(`${'═'.repeat(66)}`)
    say(`  batch ${batchId} · ${finalRow?.status} · loaded ${finalRow?.loaded_at}`)
    say(`  ${finalRow?.loaded_resident_count} residents and ${finalRow?.loaded_vehicle_count} vehicles at ${PROPERTY}`)
    say(``)
    say(`  📬 CHECK ${CLAIMANT} NOW.`)
    say(`     Subject line is the Invite template's. The body names the property`)
    say(`     and unit ONLY IF the conditional block has been added to`)
    say(`     Supabase → Auth → Email Templates → Invite; without it the`)
    say(`     invite still works and simply does not name them.`)
    say(``)
    say(`  Then: the link sets a password and lands on /reset-password-required.`)
    say(`  jose+bulkload2@ and jose+bulkload3@ are also in this batch and can`)
    say(`  be claimed from /claim?property=${encodeURIComponent(PROPERTY)}&company=${encodeURIComponent(demo!.name)}`)
    say(``)
    say(`  TO UNDO: the queue's "Roll back (same day only)" button on batch`)
    say(`  ${batchId}. 🔴 It refuses once anyone in the batch has claimed — so if you`)
    say(`  accept the invite first, the rollback will list ${CLAIMANT}`)
    say(`  and remove nothing. That is the ruled behaviour, not a fault.`)
  } finally {
    await teardownScaffolding('end')
  }
}

main().catch(() => process.exit(1))
