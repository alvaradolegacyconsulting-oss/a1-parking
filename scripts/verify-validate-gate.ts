// ════════════════════════════════════════════════════════════════════
// GATE — may_bulk_validate_at, exercised by four kinds of caller
// ════════════════════════════════════════════════════════════════════
// Execution half of wip-20261015_admin_validate_gate.sql. The SQL
// verification proves may_bulk_upload_at is the text that was applied
// and that the one substituted line is the only change; this proves who
// the new gate lets through and — the point of the whole split — what it
// still does NOT let them do.
//
// 🔴 THE ASSERTION THAT JUSTIFIES TWO FUNCTIONS IS THE UPLOAD REFUSAL.
// Widening may_bulk_upload_at would have been one line less work, and
// it would have handed an admin write access to every property's upload
// prefix, because the storage INSERT policy calls that function. So
// this gate checks both halves for the same admin: they CAN validate
// property 139's file, and they CANNOT write a byte into 139/. If the
// second ever passes, the split has collapsed.
//
// Subject: the demo company, resolved by company_env, never A1. The
// flag is flipped on for the customer-half checks and restored to false
// in cleanup, including on a signal.
//
// Usage: npm run verify:validategate

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import fs from 'fs'
import crypto from 'crypto'
import { cookieHeaderFor } from './lib/ssr-session'
import { BULK_BUCKET } from '../app/lib/bulk-onboarding'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const mintedUids: string[] = []
const mintedEmails: string[] = []
const storagePaths: string[] = []
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
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)
  if (storagePaths.length) {
    const r = await db.storage.from(BULK_BUCKET).remove(storagePaths)
    if (r.error) warn(`   ⚠ storage remove: ${r.error.message}`)
    else say(`   ↩ removed ${(r.data ?? []).length} storage object(s)`)
  }
  // 🔴 Live privilege first, then the flag, then the rest — see
  // scripts/lib/safe-log.ts for what an aborted cleanup left behind
  // when this was ordered by creation instead.
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if (r.error || (r.data ?? []).length !== mintedEmails.length) { warn(`   🔴 role rows: removed ${(r.data ?? []).length}/${mintedEmails.length}`); fails++ }
    else say(`   ↩ removed ${(r.data ?? []).length} role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} auth user(s)`)
  if (flaggedCompany !== null) {
    const want = flagWas === true
    const r = await db.from('companies').update({ bulk_onboarding_enabled: want })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    const back = r.data?.[0]?.bulk_onboarding_enabled
    if (r.error || back !== false) { warn(`   🔴 FLAG NOT RESTORED on company ${flaggedCompany} (reads ${back})`); fails++ }
    else say(`   ↩ bulk_onboarding_enabled back to ${want} on company ${flaggedCompany} (as found)`)
  }

  // 🔴 An admin role row surviving a crashed gate is the worst thing
  // this script can leave behind, so it is checked rather than assumed.
  const left = await db.from('user_roles').select('id,email,role').in('email', mintedEmails)
  if ((left.data ?? []).length > 0) {
    warn(`   🔴 ${(left.data ?? []).length} ROLE ROW(S) STILL PRESENT: ${JSON.stringify(left.data)}`); fails++
  }
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

async function actor(label: string, role: string, company: string | null, property: string[], active = true) {
  const email = `zz-vg-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company, property, is_active: active }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  const { accessToken } = await cookieHeaderFor(db, URL_, ANON, email)
  return {
    email,
    client: createClient(URL_, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }) as SupabaseClient,
  }
}

const ROW = [{ i: 0, email: 'zz-probe@test.invalid', plate: 'ZZPROBE1' }]
const validate = async (c: SupabaseClient, propertyId: number | null) => {
  const r = await c.rpc('bulk_validate_rows', { p_property_id: propertyId, p_rows: ROW })
  return { refused: !!r.error, msg: r.error?.message ?? '', rows: (r.data as unknown[] | null)?.length ?? 0 }
}

const main = async () => {
  const { data: cos } = await db.from('companies').select('id,name,company_env,bulk_onboarding_enabled')
    .eq('company_env', 'demo')
  const demo = (cos ?? [])[0]
  if (!demo) { console.error("🔴 no company with company_env='demo'. Refusing."); process.exit(2) }
  // Batch 8's property, so the gate exercises the real subject.
  const { data: b8 } = await db.from('import_batches').select('id,property_id').order('id').limit(1).maybeSingle()
  const propertyId = b8 ? Number(b8.property_id) : null
  if (!propertyId) { console.error('🔴 no batch to take a property from. Run npm run seed:demobatch first.'); process.exit(2) }
  const { data: prop } = await db.from('properties').select('id,name,company').eq('id', propertyId).maybeSingle()
  if (!prop || String(prop.company) !== String(demo.name)) {
    console.error(`🔴 property ${propertyId} is not at ${demo.name}. Refusing to validate against a non-demo property.`)
    process.exit(2)
  }
  console.log(`subject: batch ${b8!.id} · ${prop.name} (id ${propertyId}) · ${demo.name}\n`)

  try {
    const admin = await actor('adm', 'admin', null, [])
    const deadAdmin = await actor('dead', 'admin', null, [], false)
    const ca = await actor('ca', 'company_admin', demo.name, [String(prop.name)])
    const mgr = await actor('mgr', 'manager', demo.name, [String(prop.name)])
    console.log('four actors: admin, deactivated admin, company_admin, manager\n')

    // ── the migration is applied, or refuse ─────────────────────────
    const probe = await admin.client.rpc('may_bulk_validate_at', { p_property_id: propertyId })
    if (probe.error) {
      console.error(`🔴 may_bulk_validate_at is not callable: ${probe.error.message}`)
      console.error('   Apply docs/backlog/wip-20261015_admin_validate_gate.sql first. Refusing to report on the old gate.')
      await cleanup('end'); process.exit(2)
    }

    // ── 🔴 the operator half ────────────────────────────────────────
    console.log('── 🔴 an active super-admin ──')
    chk('may_bulk_validate_at says yes', probe.data === true, `= ${JSON.stringify(probe.data)}`)
    const vAdmin = await validate(admin.client, propertyId)
    chk('🔴 and the validator runs for them — this is what the queue needs',
      !vAdmin.refused && vAdmin.rows === 1,
      vAdmin.refused ? `REFUSED: ${vAdmin.msg}` : `${vAdmin.rows} row(s) checked`)
    const narrow = await admin.client.rpc('may_bulk_upload_at', { p_property_id: propertyId })
    chk('   ...while the NARROW gate still says no to them',
      narrow.data === false, `may_bulk_upload_at = ${JSON.stringify(narrow.data)}`)

    // 🔴 THE ASSERTION THE SPLIT EXISTS FOR.
    const intrude = await admin.client.storage.from(BULK_BUCKET)
      .upload(`${propertyId}/${crypto.randomUUID()}.csv`, Buffer.from('a,b\n1,2\n'), { contentType: 'text/csv' })
    chk('🔴 and an admin still CANNOT upload into a property prefix',
      !!intrude.error,
      intrude.error
        ? `${intrude.error.message} — the storage policy calls the narrow gate, which is why there are two functions instead of one widened one`
        : '🔴 THE SPLIT HAS COLLAPSED: widening the validate gate has become upload permission')
    if (!intrude.error && intrude.data?.path) storagePaths.push(intrude.data.path)

    // ── who is still refused ────────────────────────────────────────
    console.log('\n── who the wide gate still refuses ──')
    const vDead = await validate(deadAdmin.client, propertyId)
    chk('🔴 a DEACTIVATED admin is refused', vDead.refused,
      vDead.refused ? vDead.msg : '🔴 is_active is not being read — a revoked operator can still validate')
    const vMgr = await validate(mgr.client, propertyId)
    chk('a manager is refused', vMgr.refused, vMgr.refused ? vMgr.msg : `🔴 ${vMgr.rows} row(s) returned`)

    // ── 🔴 the NULL-property guard ──────────────────────────────────
    // Without it an admin passes the gate for a NULL id, and the
    // validator then resolves v_property and v_company to NULL, where
    // every `property = NULL` comparison is UNKNOWN, every duplicate
    // check finds nothing, and the file comes back CLEAN because
    // nothing was compared. A clean verdict reached by comparing
    // against nothing is the worst possible output here.
    console.log('\n── 🔴 the NULL-property guard on the admin branch ──')
    const mayNull = await admin.client.rpc('may_bulk_validate_at', { p_property_id: null })
    chk('may_bulk_validate_at(NULL) is false for an admin',
      mayNull.data === false, `= ${JSON.stringify(mayNull.data)}`)
    const vNull = await validate(admin.client, null)
    chk('🔴 validating a NULL property is REFUSED, not answered "clean"',
      vNull.refused,
      vNull.refused ? vNull.msg : `🔴 returned ${vNull.rows} row(s) — a clean verdict reached by comparing against nothing`)
    const { data: maxProp } = await db.from('properties').select('id').order('id', { ascending: false }).limit(1).maybeSingle()
    const ghost = Number(maxProp?.id ?? 0) + 10_000
    const mayGhost = await admin.client.rpc('may_bulk_validate_at', { p_property_id: ghost })
    chk(`a property id that does not exist (${ghost}) is false too`,
      mayGhost.data === false, `= ${JSON.stringify(mayGhost.data)}`)

    // ── the customer half is unchanged ──────────────────────────────
    console.log('\n── the customer half, unchanged ──')
    const vCaOff = await validate(ca.client, propertyId)
    chk('🔴 a company_admin with the flag OFF is still refused', vCaOff.refused,
      vCaOff.refused ? vCaOff.msg : '🔴 the flag has stopped gating the customer')
    const flip = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('id', demo.id).select('bulk_onboarding_enabled')
    if (flip.error || flip.data?.[0]?.bulk_onboarding_enabled !== true) throw new Error('could not enable the flag')
    flagWas = demo.bulk_onboarding_enabled === true
    flaggedCompany = demo.id as number
    const vCaOn = await validate(ca.client, propertyId)
    chk('   ...and passes with the flag ON', !vCaOn.refused && vCaOn.rows === 1,
      vCaOn.refused ? `REFUSED: ${vCaOn.msg}` : `${vCaOn.rows} row(s) checked`)
    // A CA of ANOTHER company must still be refused for this property,
    // flag or no flag — the wide gate must not have widened tenancy.
    const { data: other } = await db.from('companies').select('name')
      .neq('name', demo.name).eq('is_active', true).limit(1).maybeSingle()
    if (other) {
      const xca = await actor('xca', 'company_admin', String(other.name), [])
      const vX = await validate(xca.client, propertyId)
      chk(`🔴 a company_admin at ${other.name} is still refused for ${prop.name}`,
        vX.refused, vX.refused ? vX.msg : `🔴 ${vX.rows} row(s) — tenancy has leaked`)
    }

    // ── what the admin can legitimately reach ───────────────────────
    console.log('\n── the rest of the review surface, for the record ──')
    const dl = await admin.client.storage.from(BULK_BUCKET).download(`batches/${b8!.id}.csv`)
    chk(`an admin can download batches/${b8!.id}.csv (the bytes they are reviewing)`,
      !dl.error, dl.error?.message ?? `${(await dl.data!.arrayBuffer()).byteLength} bytes`)
    const row = await admin.client.from('import_batches').select('id,status').eq('id', b8!.id)
    chk('   ...and read the batch row', !row.error && (row.data ?? []).length === 1,
      row.error?.message ?? JSON.stringify(row.data))

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })
