// ════════════════════════════════════════════════════════════════════
// GATE — the bulk-onboarding HTTP layer, driven as a real CA
// ════════════════════════════════════════════════════════════════════
// The rehearsal (npm run rehearse:bulk) proves the VALIDATOR: fixtures
// in, expected defects out. It says in its own header that the HTTP
// layer is not exercised there. This is that gate.
//
// 🔴 IT DRIVES THE ROUTES THE WAY THE PAGE DOES — cookies, not a
// bearer token. authorizeBulkCompany() reads the session through
// createSupabaseServerClient(), so a bearer token would be ignored and
// every call would read as anonymous: the gate would "pass" its
// refusal assertions for the wrong reason and could never reach the
// authorized ones. scripts/lib/ssr-session.ts manufactures the cookie
// with the same library the app uses.
//
// 🔴 THE SUBJECT IS A DEMO PROPERTY, AND THE GATE REFUSES TO RUN
// WITHOUT ONE. Jose's standing rule is that he tests on a demo
// property, never A1. So the company is resolved by company_env='demo'
// and the gate exits 2 if that resolution fails — it does not fall back
// to "the first company it finds", which is how a gate ends up writing
// to production.
//
// 🔴 AND IT PUTS THE FLAG BACK. The flag is flipped on for the demo
// company for the duration and restored in cleanup, including on a
// signal — `finally` does not run on SIGTERM, so the handlers do it.
//
// What it does NOT cover, stated rather than implied: whether the CA
// PAGE renders what these routes return. company_admin/page.tsx is a
// client component whose properties, flag and QR cards all arrive from
// a browser-side fetch, so the server HTML contains none of them. That
// includes the flag-off non-regression for the /claim flyer. It needs a
// real browser and belongs to the Playwright work in Sweep #2 phase 4.
//
// Usage: npm run verify:bulkhttp

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import crypto from 'crypto'
import { cookieHeaderFor } from './lib/ssr-session'
import { parseBulkCsv, BULK_CSV_COLUMNS, BULK_BUCKET, MAX_BULK_ROWS } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3993
const BASE = `http://127.0.0.1:${PORT}`
const DIR = 'docs/bulk-onboarding/fixtures'
const S = Date.now()

// Published with the fixtures by the architect. The same list the
// rehearsal checks — asserted here through HTTP instead of in-process,
// so a route that silently dropped the db-flag half would be caught.
const EXPECTED_DIRTY = [7, 11, 79, 133, 167, 204, 322, 355]

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

let server: ChildProcess | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
const flaggedCompanies: number[] = []
const batchIds: number[] = []
const storagePaths: string[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)

  // 🔴 The flag goes back FIRST and is read back. Leaving bulk upload
  // switched on for a company because a gate died is the one piece of
  // state here that changes what a real operator can do.
  for (const id of flaggedCompanies) {
    const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
      .eq('id', id).select('bulk_onboarding_enabled')
    const back = r.data?.[0]?.bulk_onboarding_enabled
    if (r.error || back !== false) { warn(`   🔴 FLAG NOT RESTORED on company ${id} (reads ${back})`); fails++ }
    else say(`   ↩ bulk_onboarding_enabled back to false on company ${id}`)
  }
  if (batchIds.length) {
    const r = await db.from('import_batches').delete().in('id', batchIds).select('id')
    if (r.error || (r.data ?? []).length !== batchIds.length) { warn(`   🔴 batches: removed ${(r.data ?? []).length}/${batchIds.length}: ${r.error?.message ?? ''}`); fails++ }
    else say(`   ↩ removed ${batchIds.length} import_batches row(s)`)
  }
  if (storagePaths.length) {
    const r = await db.storage.from(BULK_BUCKET).remove(storagePaths)
    if (r.error) warn(`   ⚠ storage remove: ${r.error.message}`)
    else say(`   ↩ removed ${(r.data ?? []).length} storage object(s)`)
  }
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    say(`   ↩ removed ${(r.data ?? []).length} role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} auth user(s)`)
  if (server && !server.killed) { server.kill('SIGTERM'); say('   ↩ stopped the server this gate started') }
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

type Actor = { email: string; cookie: string; token: string; client: SupabaseClient }

async function mintActor(label: string, role: string, company: string, property: string[], active = true): Promise<Actor> {
  // 🔴 The label, not the role, names the user: two of the four actors
  // are company_admins (one live, one deactivated) and keying the email
  // off the role made the second createUser fail with "already
  // registered" — after the first two had been cleaned up, so the gate
  // exited having proven nothing.
  const email = `zz-bh-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company, property, is_active: active }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  // 🔴 The session is minted while the row is ACTIVE even for the
  // deactivated actor: a token issued before the flip is exactly the
  // case authorizeBulkCompany's own is_active read exists for. Minting
  // it after would prove nothing a login refusal does not already.
  const { cookie, accessToken } = await cookieHeaderFor(db, URL_, ANON, email)
  return {
    email, cookie, token: accessToken,
    client: createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  }
}

const GET = (path: string, actor?: Actor) => fetch(`${BASE}${path}`, {
  redirect: 'manual',
  headers: actor ? { Cookie: actor.cookie } : {},
})
const POST = (path: string, body: unknown, actor?: Actor) => fetch(`${BASE}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(actor ? { Cookie: actor.cookie } : {}) },
  body: JSON.stringify(body),
})
const js = async (r: Response) => { try { return JSON.parse(await r.text()) as Record<string, unknown> } catch { return {} } }

const main = async () => {
  if (await portBusy()) {
    console.error(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build serving stale routes.`)
    process.exit(2)
  }

  // ── 🔴 THE SUBJECT, RESOLVED AND REFUSED IF ABSENT ──────────────
  const { data: demos, error: coErr } = await db.from('companies')
    .select('id,name,company_env,bulk_onboarding_enabled,is_active')
    .eq('company_env', 'demo')
  if (coErr) { console.error(`🔴 companies read: ${coErr.message}`); process.exit(2) }
  const demo = (demos ?? []).find(c => c.is_active === true)
  if (!demo) {
    console.error('🔴 no active company with company_env=\'demo\'. Refusing to run: the standing rule is a demo property, never A1, and a gate that falls back to "whatever company is first" is how that rule gets broken.')
    process.exit(2)
  }
  const { data: dProps } = await db.from('properties').select('id,name,company,is_active')
    .eq('company', demo.name).eq('is_active', true).order('id')
  const target = (dProps ?? [])[0]
  if (!target) { console.error(`🔴 ${demo.name} has no active property`); process.exit(2) }
  if (demo.bulk_onboarding_enabled === true) {
    console.error(`🔴 ${demo.name} already has bulk_onboarding_enabled=true. Refusing: this gate flips it on and restores it to FALSE, which would be the wrong value to leave if it was already on. Clear it or run the gate against a company that does not have it set.`)
    process.exit(2)
  }
  console.log(`subject: ${demo.name} (id ${demo.id}, env=demo) · ${target.name} (id ${target.id})\n`)

  // Another company's property, for the cross-tenant path claim.
  const { data: others } = await db.from('properties').select('id,name,company')
    .neq('company', demo.name).eq('is_active', true).limit(1)
  const foreign = (others ?? [])[0]
  if (!foreign) { console.error('🔴 no property outside the demo company to test the cross-tenant claim'); process.exit(2) }

  try {
    const ca = await mintActor('ca', 'company_admin', demo.name, [target.name])
    const mgr = await mintActor('mgr', 'manager', demo.name, [target.name])
    const dead = await mintActor('dead', 'company_admin', demo.name, [target.name], false)
    const foreignCa = await mintActor('xca', 'company_admin', String(foreign.company), [String(foreign.name)])
    console.log('four actors minted: company_admin, manager, deactivated company_admin, company_admin at another company\n')

    // ── server ───────────────────────────────────────────────────
    console.log(`starting next dev on ${PORT}…`)
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'] })
    server.stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`   [server] ${s}`) })
    const until = Date.now() + 120_000
    let up = false
    while (Date.now() < until && !up) {
      try { up = (await fetch(`${BASE}/login`)).status === 200 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 700))
    }
    if (!up) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    // ── 🔴 ANONYMOUS — AND THE REDIRECT TRAP ─────────────────────
    // 🔴 WORTH KNOWING AND EASY TO GET WRONG: fetch FOLLOWS redirects
    // by default, so an unauthenticated call to one of these routes
    // comes back as HTTP 200 with the /login page's HTML. A gate that
    // asserted `status !== 200` would read that as a pass; one that
    // asserted `status === 200 means exposed` would read it as a hole.
    // Both would be wrong. redirect:'manual' is why every request in
    // this gate goes through GET()/POST().
    console.log('── anonymous ──')
    for (const [path, call] of [
      ['/api/bulk-onboarding/context', () => GET('/api/bulk-onboarding/context')],
      ['/api/bulk-onboarding/preview', () => POST('/api/bulk-onboarding/preview', { object_path: `${target.id}/x.csv` })],
      ['/api/bulk-onboarding/submit', () => POST('/api/bulk-onboarding/submit', { object_path: `${target.id}/x.csv` })],
    ] as const) {
      const r = await call()
      chk(`${path} refuses anonymous`, r.status === 307 || r.status === 302 || r.status === 401,
        `HTTP ${r.status}${r.headers.get('location') ? ` → ${r.headers.get('location')}` : ''}`)
    }
    const followed = await fetch(`${BASE}/api/bulk-onboarding/context`)
    chk('   ...and the same call WITHOUT redirect:manual looks like a 200 HTML page',
      followed.status === 200 && (await followed.text()).includes('<!DOCTYPE html'),
      'documented, not a defect: this is the trap the assertions above avoid')

    // ── 🔴 FLAG OFF — ALL THREE MUST AGREE ───────────────────────
    // A context endpoint that says "enabled" where the upload refuses
    // is how a customer ends up staring at a form that cannot submit.
    // The shared authorizeBulkCompany is supposed to make that
    // impossible; this is the assertion that it does.
    console.log('\n── 🔴 flag off: context, preview and submit must give the SAME answer ──')
    const offCtx = await GET('/api/bulk-onboarding/context', ca)
    const offPrev = await POST('/api/bulk-onboarding/preview', { object_path: `${target.id}/x.csv` }, ca)
    const offSub = await POST('/api/bulk-onboarding/submit', { object_path: `${target.id}/x.csv`, attested_name: 'x', attested_title: 'y' }, ca)
    const codes = await Promise.all([offCtx, offPrev, offSub].map(async r => `${r.status}:${(await js(r)).error}`))
    chk('🔴 all three refuse with one code when the flag is off',
      new Set(codes).size === 1 && codes[0] === '403:bulk_onboarding_not_enabled',
      codes.join(' · '))

    // ── method guards ────────────────────────────────────────────
    console.log('\n── method guards ──')
    for (const p of ['/api/bulk-onboarding/preview', '/api/bulk-onboarding/submit']) {
      const r = await GET(p, ca)
      chk(`GET ${p} → 405`, r.status === 405, `HTTP ${r.status}`)
    }

    // ── flag on ──────────────────────────────────────────────────
    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) {
      console.error('🔴 could not enable the flag'); await cleanup('end'); process.exit(2)
    }
    flaggedCompanies.push(demo.id as number)
    console.log(`\nflag on for ${demo.name} (restored in cleanup)\n`)

    // ── 🔴 WHO IS STILL REFUSED WITH THE FLAG ON ─────────────────
    console.log('── 🔴 role and liveness, with the flag on ──')
    const asMgr = await GET('/api/bulk-onboarding/context', mgr)
    chk('a manager at the same company is refused', asMgr.status === 403,
      `HTTP ${asMgr.status} ${JSON.stringify(await js(asMgr))}`)
    const asDead = await GET('/api/bulk-onboarding/context', dead)
    chk('🔴 a DEACTIVATED company_admin is refused, with a live token',
      asDead.status === 403,
      `HTTP ${asDead.status} — the session was minted while the row was active. get_my_role() and requireAuthenticated both ignore is_active; authorizeBulkCompany reads it itself, and this is that read.`)

    // ── context ──────────────────────────────────────────────────
    console.log('\n── context ──')
    const ctxR = await GET('/api/bulk-onboarding/context', ca)
    const ctx = await js(ctxR)
    chk('the CA gets their context', ctxR.status === 200 && ctx.ok === true, `HTTP ${ctxR.status}`)
    const names = ((ctx.properties ?? []) as { name: string }[]).map(p => p.name)
    chk('🔴 it lists only the caller\'s own company\'s properties',
      names.length > 0 && names.includes(String(target.name)) && !names.includes(String(foreign.name)),
      `${names.length} propert(ies): ${names.join(', ')} — ${foreign.name} (${foreign.company}) absent`)
    chk('   ...and the caps it advertises are the ones the routes enforce',
      ctx.max_rows === MAX_BULK_ROWS, `max_rows=${ctx.max_rows} vs MAX_BULK_ROWS=${MAX_BULK_ROWS}`)

    // ── 🔴 THE OBJECT PATH IS A CLAIM, NOT A FACT ────────────────
    console.log('\n── 🔴 the object path is client-chosen ──')
    const xTenant = await POST('/api/bulk-onboarding/preview', { object_path: `${foreign.id}/${crypto.randomUUID()}.csv` }, ca)
    chk('🔴 a path under ANOTHER company\'s property id is refused',
      xTenant.status === 403,
      `HTTP ${xTenant.status} ${JSON.stringify(await js(xTenant))} — property ${foreign.id} belongs to ${foreign.company}`)
    const badShape = await POST('/api/bulk-onboarding/preview', { object_path: `batches/${crypto.randomUUID()}.csv` }, ca)
    chk('   ...and so is a path into the server-only batches/ prefix',
      badShape.status >= 400, `HTTP ${badShape.status} ${JSON.stringify(await js(badShape))}`)

    // ── 🔴 THE DIRTY FIXTURE, THROUGH HTTP, UPLOADED AS THE CA ───
    console.log('\n── 🔴 the dirty fixture, previewed over HTTP ──')
    const dirtyBytes = fs.readFileSync(`${DIR}/alden_fixture_dirty.csv`)
    const dirtyPath = `${target.id}/${crypto.randomUUID()}.csv`
    const upD = await ca.client.storage.from(BULK_BUCKET).upload(dirtyPath, dirtyBytes, { contentType: 'text/csv' })
    chk('🔴 the CA can upload to their own property prefix (their INSERT policy, their JWT)',
      !upD.error, upD.error?.message ?? dirtyPath)
    if (!upD.error) storagePaths.push(dirtyPath)

    const prevDR = await POST('/api/bulk-onboarding/preview', { object_path: dirtyPath }, ca)
    const prevD = await js(prevDR)
    chk('preview answers', prevDR.status === 200, `HTTP ${prevDR.status} ${JSON.stringify(prevD).slice(0, 160)}`)
    const parsedDirty = parseBulkCsv(fs.readFileSync(`${DIR}/alden_fixture_dirty.csv`, 'utf8'))
    chk('every row reached the database check',
      prevD.rows_checked === (parsedDirty.ok ? parsedDirty.dataRows.length : -1),
      `rows_checked=${prevD.rows_checked} of ${parsedDirty.ok ? parsedDirty.dataRows.length : '?'}`)
    chk('🔴 the file is NOT clean', prevD.clean === false, `clean=${prevD.clean}`)
    // 🔴 THE EXPECTED SET IS THE POINT, not the count: eight findings
    // that are not THOSE eight is a validator finding the wrong things.
    const errRows = [...new Set(((prevD.errors ?? []) as { row: number }[]).map(e => e.row))].sort((a, b) => a - b)
    chk('🔴 the flagged rows are exactly the architect\'s published eight',
      JSON.stringify(errRows) === JSON.stringify(EXPECTED_DIRTY),
      `got   ${JSON.stringify(errRows)}\n       want  ${JSON.stringify(EXPECTED_DIRTY)}`)
    chk('   ...and every error names a fix, not just a fault',
      ((prevD.errors ?? []) as { message?: string }[]).every(e => typeof e.message === 'string' && e.message.length > 12),
      JSON.stringify(((prevD.errors ?? []) as { message?: string }[])[0]))

    // ── 🔴 A DIRTY FILE IS NOT SUBMITTABLE ───────────────────────
    console.log('\n── 🔴 submit re-runs the validation; preview is a courtesy ──')
    const subD = await POST('/api/bulk-onboarding/submit',
      { object_path: dirtyPath, source_filename: 'alden_fixture_dirty.csv', attested_name: 'Gate Runner', attested_title: 'Automated' }, ca)
    const subDj = await js(subD)
    // 🔴 THE CODE, NOT JUST A 4xx. This assertion was first written as
    // `subD.status >= 400` and it PASSED — on a 500 submit_failed,
    // because the route was calling bulk_validate_rows as service_role
    // and every submission died in the RPC. A gate that accepts any
    // failure cannot tell a working refusal from a broken route.
    chk('🔴 submitting the dirty file is refused as a VALIDATION failure, naming the count',
      subD.status === 422 && subDj.error === 'file_has_errors' && Number(subDj.error_count) > 0,
      `HTTP ${subD.status} ${JSON.stringify(subDj).slice(0, 200)}`)
    const { data: noBatch } = await db.from('import_batches').select('id').eq('property_id', target.id)
    chk('   ...and no batch row was created by the refusal',
      (noBatch ?? []).length === 0, `${(noBatch ?? []).length} batch row(s)`)

    // ── attestation ──────────────────────────────────────────────
    console.log('\n── attestation ──')
    const cleanBytes = fs.readFileSync(`${DIR}/alden_fixture_clean.csv`)
    const cleanPath = `${target.id}/${crypto.randomUUID()}.csv`
    const upC = await ca.client.storage.from(BULK_BUCKET).upload(cleanPath, cleanBytes, { contentType: 'text/csv' })
    if (upC.error) throw new Error(`clean upload: ${upC.error.message}`)
    storagePaths.push(cleanPath)
    const noAttest = await POST('/api/bulk-onboarding/submit', { object_path: cleanPath }, ca)
    chk('a submission with no name and title is refused',
      noAttest.status === 400 && (await js(noAttest)).error === 'attestation_incomplete',
      `HTTP ${noAttest.status}`)

    // ── 🔴 THE REAL BATCH ────────────────────────────────────────
    console.log('\n── 🔴 the clean fixture, submitted as a real batch ──')
    const prevCR = await POST('/api/bulk-onboarding/preview', { object_path: cleanPath }, ca)
    const prevC = await js(prevCR)
    chk('🔴 the clean fixture previews clean at this property',
      prevCR.status === 200 && prevC.clean === true,
      `clean=${prevC.clean} error_count=${prevC.error_count} ${JSON.stringify((prevC.errors ?? [] as unknown[])).slice(0, 200)}`)
    chk('   ...with the fixture\'s published counts',
      prevC.data_rows === 358 && prevC.resident_count === 228 && prevC.vehicle_count === 358,
      `${prevC.data_rows} rows · ${prevC.resident_count} residents · ${prevC.vehicle_count} vehicles (want 358 / 228 / 358)`)

    const subCR = await POST('/api/bulk-onboarding/submit',
      { object_path: cleanPath, source_filename: 'alden_fixture_clean.csv', attested_name: 'Gate Runner', attested_title: 'Automated' }, ca)
    const subC = await js(subCR)
    chk('🔴 the batch is accepted', subCR.status === 200 && subC.ok === true,
      `HTTP ${subCR.status} ${JSON.stringify(subC).slice(0, 200)}`)
    const batchId = Number(subC.batch_id)
    if (Number.isFinite(batchId) && batchId > 0) batchIds.push(batchId)
    chk('   ...with status forced to submitted, never read from the payload',
      subC.status === 'submitted', String(subC.status))

    const { data: row } = await db.from('import_batches').select('*').eq('id', batchId).maybeSingle()
    const b = (row ?? {}) as Record<string, unknown>
    chk('the batch row exists and points at the demo property',
      Number(b.property_id) === Number(target.id), `property_id=${b.property_id} want ${target.id}`)
    chk('🔴 the company on the row is DERIVED, not taken from the caller\'s payload',
      String(b.company_id ?? b.company) === String(demo.id) || String(b.company) === String(demo.name),
      `company_id=${b.company_id ?? '-'} company=${b.company ?? '-'}`)
    chk('the attestation is recorded',
      String(b.attested_name) === 'Gate Runner' && String(b.attested_title) === 'Automated',
      `${b.attested_name} / ${b.attested_title}`)

    // 🔴 THE HASHED FILE MUST BE THE LOADED FILE. storage_path names
    // the immutable copy once it is proven identical, and the CA's
    // original is removed — so the bytes Jose approves cannot be
    // swapped afterwards by a CA re-uploading to the same path.
    console.log('\n── 🔴 the bytes that were hashed are the bytes that remain ──')
    const localSha = crypto.createHash('sha256').update(cleanBytes).digest('hex')
    chk('the hash on the row is the hash of the file submitted',
      String(b.file_sha256) === localSha && String(subC.file_sha256) === localSha,
      `row=${String(b.file_sha256).slice(0, 16)}… local=${localSha.slice(0, 16)}…`)
    const immutablePath = String(b.storage_path)
    chk('🔴 storage_path points INTO batches/, not at the CA-writable prefix',
      /^batches\//.test(immutablePath),
      `${immutablePath} — batches/ is outside every CA INSERT policy, which is anchored on ^[0-9]+/`)
    if (/^batches\//.test(immutablePath)) storagePaths.push(immutablePath)
    const dl = await db.storage.from(BULK_BUCKET).download(immutablePath)
    const dlSha = dl.data ? crypto.createHash('sha256').update(Buffer.from(await dl.data.arrayBuffer())).digest('hex') : ''
    chk('   ...the copy there is byte-identical to what was submitted',
      dlSha === localSha, dl.error?.message ?? `${dlSha.slice(0, 16)}…`)
    const stillThere = await db.storage.from(BULK_BUCKET).download(cleanPath)
    chk('🔴 the CA\'s original upload is GONE, so it cannot be swapped under the batch',
      !!stillThere.error,
      stillThere.error ? `${cleanPath} no longer readable` : `🔴 ${cleanPath} is still present — a CA could overwrite the path the batch was built from`)
    // The CA must not be able to write into the immutable prefix either.
    const intrude = await ca.client.storage.from(BULK_BUCKET)
      .upload(`batches/zz-${S}.csv`, Buffer.from('a,b\n1,2\n'), { contentType: 'text/csv' })
    chk('🔴 and the CA cannot write into batches/ themselves',
      !!intrude.error, intrude.error?.message ?? '🔴 the CA WROTE into the server-only prefix')
    if (!intrude.error) storagePaths.push(`batches/zz-${S}.csv`)

    // ── the same bytes twice ─────────────────────────────────────
    console.log('\n── the same file submitted twice ──')
    const dupPath = `${target.id}/${crypto.randomUUID()}.csv`
    const upDup = await ca.client.storage.from(BULK_BUCKET).upload(dupPath, cleanBytes, { contentType: 'text/csv' })
    if (!upDup.error) storagePaths.push(dupPath)
    const dup = await POST('/api/bulk-onboarding/submit',
      { object_path: dupPath, source_filename: 'alden_fixture_clean.csv', attested_name: 'Gate Runner', attested_title: 'Automated' }, ca)
    const dupJ = await js(dup)
    if (dup.status === 200 && Number.isFinite(Number(dupJ.batch_id))) batchIds.push(Number(dupJ.batch_id))
    // Same note as above: `>= 400` passed on a 500. The duplicate is a
    // partial unique index on (property_id, file_sha256) for live
    // batches, surfaced as 409 already_submitted.
    chk('🔴 the same bytes for the same property are refused as a DUPLICATE, not a server error',
      dup.status === 409 && dupJ.error === 'already_submitted',
      `HTTP ${dup.status} ${JSON.stringify(dupJ).slice(0, 200)}`)

    // ── the foreign CA cannot see or touch this batch ────────────
    console.log('\n── another company\'s CA ──')
    const fCtx = await GET('/api/bulk-onboarding/context', foreignCa)
    const fCtxJ = await js(fCtx)
    const fNames = ((fCtxJ.properties ?? []) as { name: string }[]).map(p => p.name)
    chk('their context never mentions the demo company\'s property',
      !fNames.includes(String(target.name)),
      fCtx.status === 403 ? `HTTP 403 (their own flag is off, which is also a refusal)` : fNames.join(', '))
    const fPrev = await POST('/api/bulk-onboarding/preview', { object_path: cleanPath }, foreignCa)
    chk('🔴 and they cannot preview the demo company\'s object path',
      fPrev.status >= 400, `HTTP ${fPrev.status} ${JSON.stringify(await js(fPrev)).slice(0, 140)}`)

    // ── the CA page itself ───────────────────────────────────────
    // 🔴 WHAT THIS CAN AND CANNOT SAY. Both pages are client
    // components: properties, the flag and the QR cards all arrive from
    // a browser-side fetch, so the server HTML carries none of them.
    // So this asserts reachability for an authenticated CA and nothing
    // about what renders — including the /claim flyer's flag-off
    // non-regression, which needs a real browser.
    console.log('\n── the CA pages, reachable for a real CA ──')
    // 🔴 A FRESH CA IS NOT EXPECTED TO LAND ON THE PORTAL. This gate
    // mints a brand-new company_admin, and a company_admin who has not
    // signed the current SaaS agreement is sent to /consent — that is
    // B118 working, not a failure. So the assertion is "reachable for
    // an authenticated CA", where /consent counts as reached and
    // /login does not: being sent to /login would mean the session was
    // not accepted at all, which is the thing worth catching.
    for (const p of ['/company_admin', '/company_admin/resident-upload']) {
      const r = await GET(p, ca)
      const loc = r.headers.get('location') ?? ''
      const authed = r.status === 200 || (r.status === 307 && !/\/login/.test(loc))
      chk(`${p} accepts the CA's session`, authed,
        r.status === 200 ? 'HTTP 200' : `HTTP ${r.status} → ${loc}${/consent/.test(loc) ? ' (the consent gate, not an auth failure)' : ''}`)
      const anon = await GET(p)
      chk(`   ...and sends an anonymous visitor to /login`,
        (anon.status === 307 || anon.status === 302) && /\/login/.test(anon.headers.get('location') ?? ''),
        `HTTP ${anon.status} → ${anon.headers.get('location')}`)
    }
    // Read from the FILE, not from a response that may be a redirect
    // with an empty body: "the string is absent" must mean the render
    // does not contain it, not that there was nothing to search.
    const caSrc = fs.readFileSync('app/company_admin/page.tsx', 'utf8')
    const caHtml = await (await fetch(`${BASE}/company_admin`, { headers: { Cookie: ca.cookie } })).text()
    chk('🔴 the QR cards are in the SOURCE but not in the server HTML — so no render assertion here is possible',
      caSrc.includes('Resident Login Setup QR Codes')
      && !caHtml.includes('qr-claim-') && !caHtml.includes('Resident Login Setup QR Codes'),
      'stated, not asserted away: company_admin/page.tsx is \'use client\' and its properties arrive from a browser fetch. The flag-off flyer non-regression belongs to the Playwright work (Sweep #2 phase 4).')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
