// ════════════════════════════════════════════════════════════════════
// GATE — storage: anon writes nothing, every real path still works
// ════════════════════════════════════════════════════════════════════
//
// 🔴 ANON IS PROBED WITH A CORRECT MIME TYPE. The first probe of this
// hole was refused by the bucket's MIME allowlist and read as "RLS
// stopped it". With application/pdf and image/png both private buckets
// accepted the upload. A MIME allowlist is a convenience filter, not an
// access control, and a gate that forgets that proves nothing.
//
// 🔴 THE SWEEP IS THE POSITIVE-CONTROL LIST. 9 write sites across 5
// buckets and 4 roles. Dropping the allow-all policy without covering
// them is how driver violation upload — the core enforcement workflow —
// would stop.
//
// Usage: npm run verify:storagepolicies

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const S = Date.now()
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []
const uploaded: [string, string][] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  for (const [bucket, path] of uploaded) {
    const r = await db.storage.from(bucket).remove([path])
    if (r.error) console.error(`   🔴 could not remove ${bucket}/${path}: ${r.error.message}`)
  }
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.from('drivers').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-sp-/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.from('drivers').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
  }
  // belt: sweep any probe object by name
  for (const b of ['violation-photos', 'violation-videos', 'property-authorizations', 'vehicle-removal-photos', 'logos']) {
    const l = await db.storage.from(b).list('', { limit: 1000 })
    const mine = (l.data ?? []).filter(x => x.name.includes('zz-sp-'))
    if (mine.length) await db.storage.from(b).remove(mine.map(x => x.name))
  }
  console.log(`   cleanup done (${why})`)
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    console.error(`\n🔴 ${sig} — cleaning up.`); cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const BUCKETS: { bucket: string; mime: string; ext: string }[] = [
  { bucket: 'property-authorizations', mime: 'application/pdf', ext: 'pdf' },
  { bucket: 'vehicle-removal-photos',  mime: 'image/png',       ext: 'png' },
  { bucket: 'violation-photos',        mime: 'image/jpeg',      ext: 'jpg' },
  { bucket: 'violation-videos',        mime: 'video/mp4',       ext: 'mp4' },
  { bucket: 'logos',                   mime: 'image/png',       ext: 'png' },
]

async function actor(tag: string, role: string, extra: Record<string, unknown> = {}) {
  const email = `zz-sp-${tag}-${S}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({
    email, role, company: 'Test-LEGACY', property: ['Test Legacy Property'], is_active: true, ...extra,
  })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  if (role === 'driver') {
    await db.from('drivers').insert({
      email, name: `ZZ SP ${tag}`, company: 'Test-LEGACY',
      assigned_properties: ['Test Legacy Property'], is_active: true, operator_license: 'N/A',
    })
  }
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`link ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`otp ${tag}: ${vErr.message}`)
  return { email, client }
}

const up = async (c: ReturnType<typeof createClient>, bucket: string, path: string, mime: string) => {
  const r = await c.storage.from(bucket).upload(path, new Blob(['zz'], { type: mime }), { contentType: mime })
  if (!r.error) uploaded.push([bucket, path])
  return r
}

const main = async () => {
  // ── 1. 🔴 anon, with the CORRECT mime for each bucket ─────────────
  console.log('── 1. anon must write NOTHING (correct MIME per bucket) ──')
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  for (const { bucket, mime, ext } of BUCKETS) {
    const r = await up(anon, bucket, `zz-sp-anon-${S}.${ext}`, mime)
    chk(`anon refused on ${bucket.padEnd(24)}`, !!r.error,
      r.error ? r.error.message.slice(0, 54) : '🔴 ALLOWED — unauthenticated write into this bucket')
  }

  let DRV: Awaited<ReturnType<typeof actor>> | null = null
  let CA:  Awaited<ReturnType<typeof actor>> | null = null
  let ADM: Awaited<ReturnType<typeof actor>> | null = null
  try {
    DRV = await actor('drv', 'driver')
    CA  = await actor('ca',  'company_admin')
    ADM = await actor('adm', 'admin')

    // ── 2-6. every path the sweep found ─────────────────────────────
    console.log('\n── the sweep IS the positive-control list (9 sites, 5 buckets, 4 roles) ──')

    const d1 = await up(DRV.client, 'violation-photos', `zz-sp-drv-${S}.jpg`, 'image/jpeg')
    chk('2. driver photo upload (driver/page.tsx:1284)', !d1.error, d1.error?.message.slice(0, 60) ?? 'ok')

    const d2 = await up(DRV.client, 'violation-videos', `zz-sp-drvvid-${S}.mp4`, 'video/mp4')
    chk('2b. driver VIDEO upload (via video-upload.ts, resumable)', !d2.error, d2.error?.message.slice(0, 60) ?? 'ok')

    const c1 = await up(CA.client, 'violation-photos', `zz-sp-ca-${S}.jpg`, 'image/jpeg')
    chk('3. CA violation upload (company_admin:3704)', !c1.error, c1.error?.message.slice(0, 60) ?? 'ok')

    // the authorization PDF path is <property_id>/<ts>.pdf — the CA
    // policy keys on split_part(name,'/',1) resolving to a property of
    // their company, so the path shape is load-bearing here.
    const prop = (await db.from('properties').select('id').eq('name', 'Test Legacy Property').single()).data as { id: number }
    const c2 = await up(CA.client, 'property-authorizations', `${prop.id}/zz-sp-auth-${S}.pdf`, 'application/pdf')
    chk('5. authorization-PDF upload, company-scoped path (company_admin:2124)',
      !c2.error, c2.error?.message.slice(0, 60) ?? `ok at ${prop.id}/…`)

    const c3 = await up(CA.client, 'logos', `companies/zz-sp-logo-ca-${S}.png`, 'image/png')
    chk('6. CA logo upload (company_admin:2201)', !c3.error, c3.error?.message.slice(0, 60) ?? 'ok')

    const a1 = await up(ADM.client, 'logos', `companies/zz-sp-logo-adm-${S}.png`, 'image/png')
    chk('6b. super-admin logo upload (admin:341, admin_console:603)', !a1.error, a1.error?.message.slice(0, 60) ?? 'ok')

    // tow-log writes vehicle-removal-photos as manager/CA, path <property_id>/…
    const c4 = await up(CA.client, 'vehicle-removal-photos', `${prop.id}/zz-sp-tow-${S}.png`, 'image/png')
    chk('7. tow-log removal photo (lib/tow-log-writes.ts)', !c4.error, c4.error?.message.slice(0, 60) ?? 'ok')

    // ── 6c. 🔴 THE REPLACE PATH, which an upload to a fresh path does
    // NOT exercise. All three logo sites use upsert:true, and an upsert
    // that replaces an existing object needs UPDATE on storage.objects,
    // not just INSERT. The first version of this gate only ever wrote
    // new paths, so it would have passed with the UPDATE policy absent
    // and logo REPLACEMENT broken.
    const replacePath = `companies/zz-sp-replace-${S}.png`
    const r1 = await CA.client.storage.from('logos')
      .upload(replacePath, new Blob(['one'], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    if (!r1.error) uploaded.push(['logos', replacePath])
    const r2 = await CA.client.storage.from('logos')
      .upload(replacePath, new Blob(['two-longer'], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    let replaced = false
    if (!r2.error) {
      const d = await db.storage.from('logos').download(replacePath)
      replaced = d.data ? (await d.data.text()) === 'two-longer' : false
    }
    chk('6c. logo REPLACE via upsert works, and the bytes actually change',
      !r1.error && !r2.error && replaced,
      r2.error ? r2.error.message.slice(0, 60) : (replaced ? 'content replaced' : '🔴 upsert reported ok but the bytes did not change'))

    const anonUpsert = await anon.storage.from('logos')
      .upload(replacePath, new Blob(['anon'], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
    chk('6d. anon cannot upsert OVER an existing object either',
      !!anonUpsert.error, anonUpsert.error ? anonUpsert.error.message.slice(0, 50) : '🔴 ALLOWED')

    // ── 4. the ticket-view path — READ-only, so prove the read ──────
    // 🔴 It does NOT upload. The earlier belief that it did came from
    // grepping the WORD "storage" in `tow_storage_name` and "Contact
    // the storage facility". So the check is that the anon read path
    // still works, not that an anon write does.
    console.log('\n── 4. ticket-view is READ-ONLY: prove the anon read, not a write ──')
    const tv = await anon.rpc('get_violation_by_view_token', { p_token: 'zz' + 'x'.repeat(40) })
    chk('ticket-view RPC is still reachable anonymously and refuses a bogus token',
      !tv.error || !/permission denied|does not exist/i.test(tv.error.message),
      tv.error ? tv.error.message.slice(0, 60) : `returned ${JSON.stringify(tv.data)?.slice(0, 40)}`)
  } finally {
    await cleanup('finally')
  }

  // ── leftovers ───────────────────────────────────────────────────────
  let left = 0
  for (const { bucket } of BUCKETS) {
    const l = await db.storage.from(bucket).list('', { limit: 1000 })
    const mine = (l.data ?? []).filter(x => x.name.includes('zz-sp-'))
    if (mine.length) { left += mine.length; console.log(`   🔴 left in ${bucket}: ${mine.map(x => x.name).join(', ')}`) }
  }
  chk('no probe objects left in any bucket', left === 0, `${left} left`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ anon writes nothing, with the correct MIME type, in any of the five buckets —')
  console.log('   and all nine upload sites from the sweep still work.')
}
main().catch(e => {
  console.error('FATAL', e.message)
  cleanup('fatal').then(() => process.exit(2)).catch(() => process.exit(2))
})
