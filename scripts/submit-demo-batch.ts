// ════════════════════════════════════════════════════════════════════
// Submit the Alden Park fixture as a REAL batch, on a demo property
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: the approval queue gets built against a real batch,
// submitted from the Alden Park fixture through the CA page's own route
// on a demo property. This is that submission.
//
// It is NOT a gate. verify:bulkhttp proves the routes and cleans up
// after itself, which is what makes it repeatable. This leaves a batch
// behind on purpose, so it is deliberately hard to run twice: it
// refuses if a live batch already exists for the property.
//
// 🔴 IT SUBMITS AS THE REAL DEMO CA, NOT A MINTED ONE.
// demo-ca@test.shieldmylot.com is the company_admin the demo seed
// created, and the batch's attested_by_user_id is a real person's uid
// rather than a throwaway that gets deleted minutes later. The
// attestation is the record of who said the file was right; pointing it
// at a user that no longer exists would make the queue's own
// provenance a dead end.
//
// 🔴 AND IT PUTS THE FLAG BACK TO OFF.
// The batch is what the queue needs; the flag is what lets the demo CA
// upload more. Leaving it on would quietly widen what that account can
// do, and verify:bulkhttp refuses to run when it is already on.
//
// Usage: npm run seed:demobatch

import { createClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import crypto from 'crypto'
import { cookieHeaderFor } from './lib/ssr-session'
import { BULK_BUCKET } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3994
const BASE = `http://127.0.0.1:${PORT}`
const FIXTURE = 'docs/bulk-onboarding/fixtures/alden_fixture_clean.csv'
const CA_EMAIL = 'demo-ca@test.shieldmylot.com'

let server: ChildProcess | null = null
let flaggedCompany: number | null = null
let uploadedPath: string | null = null
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)
  if (flaggedCompany !== null) {
    const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    const back = r.data?.[0]?.bulk_onboarding_enabled
    if (r.error || back !== false) warn(`   🔴 FLAG NOT RESTORED on company ${flaggedCompany} (reads ${back}) — set it back by hand`)
    else say(`   ↩ bulk_onboarding_enabled back to false on company ${flaggedCompany}`)
  }
  // Only an upload the route did NOT consume. On success the route
  // removes the CA's original itself.
  if (uploadedPath) {
    const left = await db.storage.from(BULK_BUCKET).download(uploadedPath)
    if (!left.error) {
      await db.storage.from(BULK_BUCKET).remove([uploadedPath])
      say(`   ↩ removed the unconsumed upload ${uploadedPath}`)
    }
  }
  if (server && !server.killed) { server.kill('SIGTERM'); say('   ↩ stopped the server this script started') }
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

const die = (m: string): never => { console.error(`🔴 ${m}`); throw new Error(m) }

const main = async () => {
  if (await portBusy()) die(`something is already listening on ${PORT}. Refusing: it may be a stale build.`)

  // ── the subject, demo-only, refused if absent ───────────────────
  const { data: demos, error: coErr } = await db.from('companies')
    .select('id,name,company_env,is_active,account_state,bulk_onboarding_enabled')
    .eq('company_env', 'demo')
  if (coErr) die(`companies read: ${coErr.message}`)
  const demo = (demos ?? []).find(c => c.is_active === true)
  if (!demo) die("no active company with company_env='demo'. Refusing: a real batch goes on a demo property, never A1.")
  const { data: props } = await db.from('properties').select('id,name,company')
    .eq('company', demo!.name).eq('is_active', true).order('id')
  const target = (props ?? [])[0]
  if (!target) die(`${demo!.name} has no active property`)

  // ── one live batch per property, or this is a re-run ────────────
  const { data: live } = await db.from('import_batches')
    .select('id,status,created_at,resident_count').eq('property_id', target.id)
  if ((live ?? []).length > 0) {
    console.log(`\nThere is already a batch on ${target.name}:`)
    for (const b of live ?? []) console.log(`   batch ${b.id} · ${b.status} · ${b.resident_count} residents · ${b.created_at}`)
    console.log('\nNothing submitted. This script leaves state behind on purpose, so it refuses to stack a second batch on the same property. Delete the row above if you want a fresh one.')
    return
  }

  // ── the CA must already exist; this does not mint one ──────────
  const { data: roles } = await db.from('user_roles').select('email,role,company,is_active')
    .ilike('email', CA_EMAIL)
  const caRole = (roles ?? [])[0]
  if (!caRole || caRole.role !== 'company_admin' || caRole.is_active !== true
      || String(caRole.company).trim().toLowerCase() !== String(demo!.name).trim().toLowerCase()) {
    die(`${CA_EMAIL} is not an active company_admin at ${demo!.name} (${JSON.stringify(caRole)}). Refusing to invent an attester: attested_by_user_id is the record of who said this file was right.`)
  }
  const all = await db.auth.admin.listUsers({ perPage: 1000 })
  const caUser = (all.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === CA_EMAIL)
  if (!caUser) die(`${CA_EMAIL} has a role row but no auth account`)

  console.log(`submitting as ${CA_EMAIL} (uid ${caUser!.id})`)
  console.log(`  company  ${demo!.name} (id ${demo!.id}, env=demo)`)
  console.log(`  property ${target.name} (id ${target.id})`)
  console.log(`  file     ${FIXTURE}\n`)

  try {
    const { cookie, accessToken } = await cookieHeaderFor(db, URL_, ANON, CA_EMAIL)
    const asCa = createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo!.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) die('could not enable the flag')
    flaggedCompany = demo!.id as number

    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'] })
    server.stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`   [server] ${s}`) })
    const until = Date.now() + 120_000
    let up = false
    while (Date.now() < until && !up) {
      try { up = (await fetch(`${BASE}/login`)).status === 200 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 700))
    }
    if (!up) die('server did not come up')

    // The CA's own upload, through their own storage policy.
    const bytes = fs.readFileSync(FIXTURE)
    const path = `${target.id}/${crypto.randomUUID()}.csv`
    const up2 = await asCa.storage.from(BULK_BUCKET).upload(path, bytes, { contentType: 'text/csv' })
    if (up2.error) die(`upload: ${up2.error.message}`)
    uploadedPath = path
    console.log(`uploaded ${path} (${bytes.length} bytes, sha ${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…)`)

    const post = (p: string, body: unknown) => fetch(`${BASE}${p}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })

    const prev = await post('/api/bulk-onboarding/preview', { object_path: path })
    const prevJ = await prev.json().catch(() => ({})) as Record<string, unknown>
    if (prev.status !== 200) die(`preview HTTP ${prev.status}: ${JSON.stringify(prevJ)}`)
    console.log(`preview: ${prevJ.data_rows} rows · ${prevJ.resident_count} residents · ${prevJ.vehicle_count} vehicles · clean=${prevJ.clean}`)
    if (prevJ.clean !== true) die(`the fixture is not clean at ${target.name}: ${prevJ.error_count} error(s) — ${JSON.stringify(prevJ.errors).slice(0, 400)}`)

    const sub = await post('/api/bulk-onboarding/submit', {
      object_path: path,
      source_filename: 'alden_fixture_clean.csv',
      attested_name: 'Demo Company Administrator',
      attested_title: 'Property Operations',
    })
    const subJ = await sub.json().catch(() => ({})) as Record<string, unknown>
    if (sub.status !== 200) die(`submit HTTP ${sub.status}: ${JSON.stringify(subJ)}`)
    uploadedPath = null   // the route consumed it

    const { data: row } = await db.from('import_batches').select('*').eq('id', subJ.batch_id).maybeSingle()
    const b = (row ?? {}) as Record<string, unknown>
    console.log(`\n✅ batch ${subJ.batch_id} submitted`)
    console.log(`   property      ${b.property_id} (${target.name})`)
    console.log(`   company        ${b.company_id} (${demo!.name})`)
    console.log(`   status         ${b.status}`)
    console.log(`   residents      ${b.resident_count}`)
    console.log(`   vehicles       ${b.vehicle_count}`)
    console.log(`   attested by    ${b.attested_name} / ${b.attested_title} (uid ${b.attested_by_user_id})`)
    console.log(`   storage_path   ${b.storage_path}`)
    console.log(`   file_sha256    ${b.file_sha256}`)
    console.log(`\nThis is the batch the approval queue is built against. It is left in place.`)
  } finally {
    await cleanup('end')
  }
}

main().catch(() => { process.exit(1) })
