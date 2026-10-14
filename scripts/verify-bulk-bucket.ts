// ════════════════════════════════════════════════════════════════════
// GATE — bulk-onboarding bucket: only a CA, only their own property,
//        only once, and never into batches/
// ════════════════════════════════════════════════════════════════════
//
// The SQL verification reads the catalog and executes the helper. That
// proves the objects exist, run, and fail closed with no JWT. It cannot
// prove what a real company_admin's browser can and cannot upload —
// only a live probe with a real JWT does, which is this file.
//
// 🔴 PROBED WITH CORRECT CONTENT TYPES. A MIME allowlist is a
// convenience filter, not an access control: the first anon probe of
// the allow-all hole was refused on content type and nearly read as
// "RLS stopped it". Every refusal here is checked against an upload
// the bucket's MIME list accepts, so a refusal can only be RLS.
//
// 🔴 THIS GATE FLIPS A PRODUCTION FLAG. companies.bulk_onboarding_enabled
// goes TRUE for Test-LEGACY and back. It is flipped by direct
// service_role UPDATE rather than through set_company_bulk_onboarding
// so that re-running the gate does not write two audit rows a run. The
// restore is retried and then VERIFIED by reading the value back; a
// restore whose own error is never checked is how property 138 was
// corrupted.
//
// Usage: npm run verify:bulkbucket

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import crypto from 'crypto'
import { BULK_CSV_HEADER, BULK_OBJECT_PATH, MAX_BULK_BYTES, MAX_BULK_ROWS } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const BUCKET = 'bulk-onboarding'
const CO = 'Test-LEGACY'              // the gate's own tenant
const S = Date.now()
const uuid = () => crypto.randomUUID()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

const users: { email: string; uid: string }[] = []
const uploaded: string[] = []
const flipped: string[] = []
let cleaned = false

// ── restore, armed before the first mutation, checked and verified ──
// Every company this run turned on, turned back off, each read back.
async function restoreFlag(): Promise<void> {
  while (flipped.length) {
    const co = flipped[flipped.length - 1]
    let ok = false
    for (let i = 1; i <= 3 && !ok; i++) {
      const r = await db.from('companies')
        .update({ bulk_onboarding_enabled: false }).eq('name', co).select('name,bulk_onboarding_enabled')
      const back = r.data?.[0]?.bulk_onboarding_enabled
      if (!r.error && back === false) { ok = true; console.log(`   ↩ ${co}.bulk_onboarding_enabled restored to false (verified)`) }
      else console.error(`   🔴 restore attempt ${i}/3 for ${co} failed: ${r.error?.message ?? `read back ${back}`}`)
    }
    if (!ok) {
      console.error(`\n🔴🔴 MANUAL ACTION REQUIRED: ${co}.bulk_onboarding_enabled is still TRUE.`)
      console.error(`     UPDATE public.companies SET bulk_onboarding_enabled = FALSE WHERE name = '${co}';`)
      fails++
    }
    flipped.pop()
  }
}

async function enable(co: string) {
  const f = await db.from('companies').update({ bulk_onboarding_enabled: true })
    .eq('name', co).select('name,bulk_onboarding_enabled')
  if (f.error || f.data?.[0]?.bulk_onboarding_enabled !== true) {
    throw new Error(`could not enable the flag for ${co}: ${f.error?.message ?? 'read back false'}`)
  }
  flipped.push(co)
  console.log(`   ⚑ ${co}.bulk_onboarding_enabled = true (restored at exit)`)
}

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  if (uploaded.length) {
    const r = await db.storage.from(BUCKET).remove(uploaded)
    if (r.error) console.error(`   🔴 could not remove objects: ${r.error.message}`)
  }
  // belt: anything this run left behind under any prefix
  for (const pre of ['', 'batches']) {
    const l = await db.storage.from(BUCKET).list(pre, { limit: 1000 })
    for (const f of l.data ?? []) if (f.name.includes(String(S))) await db.storage.from(BUCKET).remove([pre ? `${pre}/${f.name}` : f.name])
  }
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-bb-/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
  }
  await restoreFlag()
}

// 🔴 `finally` does not run on a signal. Arm handlers before mutating.
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

async function actor(tag: string, role: string, company = CO, property: string[] = ['Test Legacy Property']) {
  const email = `zz-bb-${tag}-${S}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({ email, role, company, property, is_active: true })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`link ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`otp ${tag}: ${vErr.message}`)
  return { email, client }
}

type C = ReturnType<typeof createClient>
const CSV = 'unit,first_name,last_name,email,phone,plate,plate_state,make,model,color,tag_number\n101,Jane,Doe,j@x.invalid,,ABC1234,TX,Toyota,Camry,Silver,\n'

async function up(c: C, path: string, mime = 'text/csv', body: BlobPart = CSV, upsert = false) {
  const r = await c.storage.from(BUCKET).upload(path, new Blob([body], { type: mime }), { contentType: mime, upsert })
  if (!r.error) uploaded.push(path)
  return r
}
const why = (r: { error: { message: string } | null }) => r.error ? r.error.message.slice(0, 58) : ''

const main = async () => {
  // ── 0. drift: four copies of one contract ─────────────────────────
  // The header, the caps and the path shape live in the shared module,
  // the customer template and the storage policy. A customer whose
  // template header no longer matches the route gets a file that
  // validates in their spreadsheet and is refused on submission, with
  // nothing on either side admitting why.
  console.log('── 0. the file contract does not drift ──')
  const tmpl = fs.readFileSync('docs/bulk-onboarding/template.csv', 'utf8')
    .replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim()
  chk('template.csv header === BULK_CSV_HEADER', tmpl === BULK_CSV_HEADER,
    tmpl === BULK_CSV_HEADER ? 'ok' : `🔴 template has "${tmpl}"`)

  const polSql = fs.readFileSync('migrations/20261015_bulk_onboarding_bucket.sql', 'utf8')
  // The policy writes the regex as a SQL literal; the module writes it
  // as a JS literal with the capture group. Compare the shared middle.
  const core = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  chk('the policy and the route anchor on the same path shape',
    polSql.includes(`^[0-9]+/${core}`) && BULK_OBJECT_PATH.source.includes(core),
    polSql.includes(`^[0-9]+/${core}`) ? 'ok' : '🔴 the SQL policy regex no longer matches BULK_OBJECT_PATH')
  chk('the instructions state the same row cap as the code',
    fs.readFileSync('docs/bulk-onboarding/INSTRUCTIONS.md', 'utf8').includes(`${MAX_BULK_ROWS.toLocaleString('en-US')} rows`),
    `code says ${MAX_BULK_ROWS}`)

  // ── 0b. 🔴 refuse to report on a bucket that does not exist ──────
  // Every refusal check below would pass against a missing bucket —
  // "not found" is an error, and an error reads as a refusal. A gate
  // that goes green because its subject is absent is worse than no
  // gate. Exit 2, not pass.
  const { data: buckets, error: bErr } = await db.storage.listBuckets()
  if (bErr || !(buckets ?? []).some(b => b.id === BUCKET)) {
    console.error(`\n🔴 bucket ${BUCKET} does not exist — apply migrations/20261015_bulk_onboarding_bucket.sql first.`)
    console.error(`   Refusing to run: every negative check here would pass against a missing bucket.`)
    process.exit(2)
  }

  // ── 0c. the fixtures this gate reasons about must be what I think ─
  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const mine   = props?.find(p => p.company === CO && p.name === 'Test Legacy Property' && p.is_active)
  const myDead = props?.find(p => p.company === CO && p.is_active === false)
  const theirs = props?.find(p => p.company !== CO && p.is_active)
  if (!mine || !myDead || !theirs) {
    console.error(`🔴 cannot run: need an active + an inactive ${CO} property and one other company's active property.`)
    console.error(`   active=${mine?.id} inactive=${myDead?.id} other=${theirs?.id}`)
    process.exit(2)
  }
  console.log(`fixtures: own=${mine.id} (${mine.name})  own-inactive=${myDead.id}  other-company=${theirs.id} (${theirs.company})\n`)

  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  let CA: Awaited<ReturnType<typeof actor>> | null = null
  let MGR: Awaited<ReturnType<typeof actor>> | null = null
  let ADM: Awaited<ReturnType<typeof actor>> | null = null

  try {
    CA  = await actor('ca',  'company_admin')
    MGR = await actor('mgr', 'manager')
    ADM = await actor('adm', 'admin')

    // ── 1. anon writes nothing, with a MIME the bucket accepts ──────
    console.log('── 1. unauthenticated ──')
    const a1 = await up(anon, `${mine.id}/${uuid()}.csv`)
    chk('anon upload refused', !!a1.error, a1.error ? why(a1) : '🔴 ALLOWED — anyone can submit a batch')

    // ── 2. 🔴 flag OFF is enforced AT THE BUCKET, not just the route ─
    // If the bucket let a flag-off tenant upload, the route would still
    // refuse the batch but the object would already be sitting there.
    console.log('\n── 2. flag OFF (the state every company is in today) ──')
    const off = await up(CA.client, `${mine.id}/${uuid()}.csv`)
    chk('CA upload refused while bulk_onboarding_enabled = false', !!off.error,
      off.error ? why(off) : '🔴 ALLOWED — a flag-off tenant can park objects the route will never claim')

    // ── 3. turn it on ───────────────────────────────────────────────
    // 🔴 BOTH companies, and the second one is the whole point.
    // With only this tenant enabled, the cross-company check below
    // would be refused by the OTHER company's flag being off, and pass
    // while proving nothing about company scoping. Two causes share one
    // sqlstate here: "not your company" and "not switched on" are both
    // a row-level-security refusal with identical text. Turning the
    // other company's flag ON removes the second cause, so a refusal
    // can only be the first.
    console.log('')
    await enable(CO)
    await enable(theirs.company as string)

    // ── 4. positive controls — the CA's real upload, every MIME ─────
    // 🔴 Browsers do not agree on a type for .csv. Windows with Excel
    // installed sends application/vnd.ms-excel. A text/csv-only list
    // would refuse A1's real files at the storage layer with an
    // unhelpful error, so all four must be accepted here.
    console.log('\n── 4. positive controls: CA, own active property ──')
    for (const mime of ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream']) {
      const r = await up(CA.client, `${mine.id}/${uuid()}.csv`, mime)
      chk(`CA upload accepted as ${mime.padEnd(26)}`, !r.error, r.error ? '🔴 REFUSED — ' + why(r) : 'ok')
    }

    // ── 5. 🔴 batches/ is unreachable, by pattern ───────────────────
    console.log('\n── 5. the immutable per-batch prefix ──')
    const b1 = await up(CA.client, `batches/${uuid()}.csv`)
    chk('CA refused on batches/{uuid}.csv', !!b1.error,
      b1.error ? why(b1) : '🔴 ALLOWED — the CA can overwrite the copy the loader will hash')
    const b2 = await up(CA.client, `batches/${mine.id}-${uuid()}.csv`)
    chk('CA refused on batches/ even with their own id in the name', !!b2.error,
      b2.error ? why(b2) : '🔴 ALLOWED — the prefix check is matching a substring')

    // ── 6. scope ────────────────────────────────────────────────────
    console.log('\n── 6. scope ──')
    // 🔴 The isolated cross-company check: the other company's flag is
    // ON, its property is active, and its CA could upload here — so the
    // only thing left to refuse this is that it is not OUR company.
    const s1 = await up(CA.client, `${theirs.id}/${uuid()}.csv`)
    chk(`CA refused on another company's property (${theirs.id}, ${theirs.company}) WITH THAT COMPANY'S FLAG ALSO ON`,
      !!s1.error, s1.error ? why(s1) : '🔴 ALLOWED — cross-tenant upload')
    // Positive control for the control: that company's own CA CAN
    // upload there. Without it, the refusal above is also what a
    // blanket "nobody may upload for 136" would look like.
    const other = await actor('ca2', 'company_admin', theirs.company as string, [theirs.name as string])
    const s1b = await up(other.client, `${theirs.id}/${uuid()}.csv`)
    chk(`   ...and ${theirs.company}'s OWN company_admin can upload there`, !s1b.error,
      s1b.error ? '🔴 REFUSED — the check above proves nothing: ' + why(s1b) : 'ok')
    const s2 = await up(CA.client, `${myDead.id}/${uuid()}.csv`)
    chk(`CA refused on their own INACTIVE property (${myDead.id})`, !!s2.error,
      s2.error ? why(s2) : '🔴 ALLOWED — a deactivated property still accepts residents')
    const s3 = await up(CA.client, `${mine.id}/not-a-uuid-${S}.csv`)
    chk('CA refused on a non-uuid filename', !!s3.error, s3.error ? why(s3) : '🔴 ALLOWED — the name is not constrained')
    const s4 = await up(CA.client, `${mine.id}/${uuid()}.xlsx`)
    chk('CA refused on a non-.csv extension', !!s4.error, s4.error ? why(s4) : '🔴 ALLOWED')
    const s5 = await up(CA.client, `${uuid()}.csv`)
    chk('CA refused on a bare filename with no property prefix', !!s5.error, s5.error ? why(s5) : '🔴 ALLOWED')

    // ── 7. role ─────────────────────────────────────────────────────
    console.log('\n── 7. role ──')
    const r1 = await up(MGR.client, `${mine.id}/${uuid()}.csv`)
    chk('manager refused on a path their CA may write', !!r1.error,
      r1.error ? why(r1) : '🔴 ALLOWED — onboarding is a CA act, not a manager one')
    const r2 = await up(ADM.client, `${mine.id}/${uuid()}.csv`)
    chk('super admin refused on upload (read-only by design)', !!r2.error,
      r2.error ? why(r2) : '🔴 ALLOWED — admin holds a SELECT policy only')

    // ── 8. 🔴 a submission cannot change or disappear ───────────────
    console.log('\n── 8. no overwrite, no withdrawal ──')
    const live = `${mine.id}/${uuid()}.csv`
    const l1 = await up(CA.client, live)
    chk('CA upload accepted (the object the next two checks act on)', !l1.error, l1.error ? '🔴 ' + why(l1) : 'ok')
    if (!l1.error) {
      const u1 = await up(CA.client, live, 'text/csv', 'unit,first_name\nTAMPERED,x\n', true)
      chk('CA refused on upsert over their own submission', !!u1.error,
        u1.error ? why(u1) : '🔴 ALLOWED — a reviewed file can be swapped after submission')
      // and prove the bytes really did not move
      const dl = await db.storage.from(BUCKET).download(live)
      const txt = dl.data ? await dl.data.text() : ''
      chk('the stored bytes are unchanged', txt === CSV,
        txt === CSV ? 'ok' : `🔴 stored content now starts "${txt.slice(0, 28)}"`)
      const d1 = await CA.client.storage.from(BUCKET).remove([live])
      // storage remove returns {data:[],error:null} when RLS hides the row
      chk('CA cannot delete their own submission', !!d1.error || (d1.data ?? []).length === 0,
        d1.error ? why(d1) : ((d1.data ?? []).length === 0 ? 'refused (0 rows removed)' : '🔴 DELETED'))
      const still = await db.storage.from(BUCKET).download(live)
      chk('the submission is still there after the delete attempt', !still.error,
        still.error ? '🔴 GONE — ' + still.error.message.slice(0, 40) : 'ok')

      // ── 9. read access ───────────────────────────────────────────
      console.log('\n── 9. who can read it ──')
      const caRead = await CA.client.storage.from(BUCKET).download(live)
      chk('CA cannot read objects back (no CA SELECT policy)', !!caRead.error,
        caRead.error ? why(caRead) : '🔴 READABLE — not a hole, but not the designed surface either')
      const admRead = await ADM.client.storage.from(BUCKET).download(live)
      chk('super admin CAN read the submission (review needs it)', !admRead.error,
        admRead.error ? '🔴 REFUSED — Jose cannot read what he must approve: ' + why(admRead) : 'ok')
    }

    // ── 9b. the console's write path, by its real API ───────────────
    // 🔴 PARAMETER NAMES ARE THE API UNDER PostgREST. The console's
    // first version called p_company_name; the function declares
    // p_company, and the result is PGRST202 "could not find the
    // function" — not a type error, and not something tsc or a build
    // can see. Asserted both ways so the call site cannot drift back.
    console.log('\n── 9b. set_company_bulk_onboarding, as the console calls it ──')
    const wrongName = await ADM.client.rpc('set_company_bulk_onboarding',
      { p_company_name: CO, p_enabled: true })
    chk('the wrong parameter name is refused (PGRST202, not a type error)',
      !!wrongName.error && /could not find the function/i.test(wrongName.error.message),
      wrongName.error ? wrongName.error.code ?? 'error' : '🔴 ACCEPTED — the signature is not what the console assumes')

    const viaRpc = await ADM.client.rpc('set_company_bulk_onboarding', { p_company: CO, p_enabled: true })
    const rr = viaRpc.data as { ok?: boolean; was?: boolean; changed?: boolean } | null
    chk('p_company + p_enabled returns ok with the PRIOR value', !viaRpc.error && rr?.ok === true && typeof rr?.was === 'boolean',
      viaRpc.error ? '🔴 ' + viaRpc.error.message.slice(0, 50) : `was=${rr?.was} changed=${rr?.changed}`)
    const readBack = await db.from('companies').select('bulk_onboarding_enabled').eq('name', CO).maybeSingle()
    chk('   ...and the column really changed', (readBack.data as { bulk_onboarding_enabled?: boolean } | null)?.bulk_onboarding_enabled === true,
      'read back from companies, not inferred from the call')
    const missing = await ADM.client.rpc('set_company_bulk_onboarding', { p_company: `ZZ No Such Co ${S}`, p_enabled: true })
    const mr = missing.data as { ok?: boolean; error?: string } | null
    chk('an unresolvable company is an explicit error, not a quiet no-op',
      mr?.ok === false && mr?.error === 'company_not_found', mr?.error ?? '🔴 reported success')
    // A non-admin must not reach it at all.
    const caTry = await CA.client.rpc('set_company_bulk_onboarding', { p_company: CO, p_enabled: false })
    const cr = caTry.data as { ok?: boolean; error?: string } | null
    chk('a company_admin cannot flip their own switch',
      !!caTry.error || cr?.ok === false, caTry.error ? caTry.error.message.slice(0, 40) : (cr?.error ?? '🔴 ALLOWED'))

    // ── 10. byte ceiling ────────────────────────────────────────────
    console.log('\n── 10. byte ceiling ──')
    const big = await up(CA.client, `${mine.id}/${uuid()}.csv`, 'text/csv', new Uint8Array(3 * 1024 * 1024))
    chk(`CA refused on a 3 MB file (${MAX_BULK_BYTES / 1048576} MB bucket limit)`, !!big.error,
      big.error ? why(big) : '🔴 ALLOWED — the size limit is not set')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
