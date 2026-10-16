// ════════════════════════════════════════════════════════════════════
// Roll back a demo batch through the REAL queue action
// ════════════════════════════════════════════════════════════════════
// The operator's own route, not a service-role DELETE. A rehearsal that
// was undone by hand would not have exercised the thing an operator
// will actually press, and the refusals are the interesting part.
//
// Takes the property and the action, so it is not wired to one
// rehearsal or one verb:
//   npm run queue:act -- "Willowbrook Court" rollback
//   npm run queue:act -- "Sunset Ridge Apartments" reject "rehearsal fixture"
//
// 🔴 Generalised on the third use rather than the second. rollback,
// reject and return are the same shape — an operator session, one POST,
// and the refusal is the interesting part — and a third copy would have
// been three places for the operator-account cleanup to drift.
//
// 🔴 It does not delete auth users. Rollback refuses while any batch
// resident has an auth account, and that refusal is the ruling — not
// something for this script to work around. If it refuses, it prints
// who, and clearing them is a separate decision someone has to take.

import { createClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 4003
const BASE = `http://127.0.0.1:${PORT}`
const PROPERTY = process.argv[2] || 'Willowbrook Court'
const ACTION = (process.argv[3] || 'rollback') as 'rollback' | 'reject' | 'return'
const REASON = process.argv[4] || ''
if (!['rollback', 'reject', 'return'].includes(ACTION)) {
  warn(`🔴 unknown action ${JSON.stringify(ACTION)} — use rollback, reject or return`)
  process.exit(2)
}
const S = Date.now()

let srv: DevServer | null = null
let operatorUid = '', operatorEmail = ''
let cleaned = false

async function teardown(why: string) {
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
  if (srv) { await srv.stop(); srv = null; say('   ↩ stopped the server') }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    teardown(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  warn(`🔴 uncaught: ${(e as Error).message}`)
  teardown('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const main = async () => {
  if (await portBusy(PORT)) { warn(`🔴 something is already listening on ${PORT}`); process.exit(2) }

  const { data: cos } = await db.from('companies').select('id,name').eq('company_env', 'demo')
  const demo = (cos ?? [])[0]
  if (!demo) { warn("🔴 no demo company. This only operates on a demo tenant."); process.exit(2) }
  const { data: prop } = await db.from('properties').select('id,name')
    .eq('company', demo.name).eq('name', PROPERTY).maybeSingle()
  if (!prop) { warn(`🔴 ${PROPERTY} not found at ${demo.name}`); process.exit(2) }
  const { data: batch } = await db.from('import_batches')
    .select('id,status,loaded_resident_count,loaded_vehicle_count')
    .eq('property_id', prop.id).order('id', { ascending: false }).limit(1).maybeSingle()
  if (!batch) { warn(`🔴 no batch on ${PROPERTY}`); process.exit(2) }

  const count = async (t: 'residents' | 'vehicles' | 'user_roles') => {
    const { count: c } = await db.from(t).select('*', { count: 'exact', head: true }).eq('import_batch_id', batch.id)
    return c ?? 0
  }
  const propCount = async (t: 'residents' | 'vehicles') => {
    const { count: c } = await db.from(t).select('*', { count: 'exact', head: true }).eq('property', PROPERTY)
    return c ?? 0
  }
  say(`batch ${batch.id} on ${PROPERTY} · ${batch.status} · action: ${ACTION}`)
  say(`  stamped now: ${await count('residents')} residents, ${await count('vehicles')} vehicles, ${await count('user_roles')} role rows`)
  say(`  ${PROPERTY} totals: ${await propCount('residents')} residents, ${await propCount('vehicles')} vehicles\n`)

  try {
    operatorEmail = `zz-rollback-operator-${S}@test.invalid`
    const u = await db.auth.admin.createUser({ email: operatorEmail, email_confirm: true, password: `Zz!${S}q` })
    if (u.error || !u.data.user) throw new Error(`createUser: ${u.error?.message}`)
    operatorUid = u.data.user.id
    const ins = await db.from('user_roles').insert({
      email: operatorEmail, role: 'admin', company: null, property: [], is_active: true,
    }).select('id')
    if (ins.error) throw new Error(`operator role: ${ins.error.message}`)
    const op = await cookieHeaderFor(db, URL_, ANON, operatorEmail)

    srv = await startDevServer(PORT)
    if (!srv) throw new Error('server did not come up')

    // 🔴 reject REQUIRES a typed reason and the RPC refuses one under
    // ten characters, because that sentence is the only thing the
    // company is told. Caught here so the operator is not told by a
    // 409 after a round trip.
    if (ACTION === 'reject' && REASON.trim().length < 10) {
      warn(`🔴 reject needs a reason of at least 10 characters — it is the only thing the company is told about their file.`)
      warn(`   npm run queue:act -- ${JSON.stringify(PROPERTY)} reject "why this file will not be loaded"`)
      await teardown('end'); process.exit(2)
    }
    const r = await fetch(`${BASE}/api/admin/import-batch/${ACTION}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: op.cookie },
      body: JSON.stringify({ batch_id: batch.id, reason: REASON, trigger: 'review' }),
    })
    const out = await r.json().catch(() => ({})) as Record<string, any>
    say(`POST /api/admin/import-batch/${ACTION} → HTTP ${r.status}`)

    if (out.ok === true) {
      say(ACTION === 'rollback'
        ? `\n✅ rolled back: ${out.residents} residents, ${out.vehicles} vehicles, ${out.roles} role rows removed`
        : `\n✅ ${ACTION}: batch ${out.batch_id} is now ${out.status}${out.error_count !== undefined ? ` (${out.error_count} error(s) attached)` : ''}`)
    } else {
      warn(`\n🔴 REFUSED: ${out.error}`)
      say(`   ${out.message}`)
      if (Array.isArray(out.claimed)) {
        say(`\n   ${out.claimed_count} resident(s) with an auth account:`)
        for (const c of out.claimed) say(`     unit ${c.unit || '—'} · ${c.email}`)
      }
      // 🔴 The block reasons, which the first version did not print —
      // so a `blocked` refusal said only that it was blocked. A refusal
      // an operator cannot act on is the thing this whole arc keeps
      // being about.
      if (Array.isArray(out.reasons)) {
        say(`\n   reasons:`)
        for (const why of out.reasons) say(`     · ${why}`)
      }
      if (Array.isArray(out.blockers)) {
        say(`\n   dependents:`)
        for (const b of out.blockers) say(`     ${b.rows} row(s) in ${b.table} (${b.key}) — ${b.how}`)
      }
    }

    say(`\nafter: stamped ${await count('residents')} residents, ${await count('vehicles')} vehicles, ${await count('user_roles')} role rows`)
    say(`       ${PROPERTY} totals: ${await propCount('residents')} residents, ${await propCount('vehicles')} vehicles`)
    const { data: now } = await db.from('import_batches').select('status').eq('id', batch.id).maybeSingle()
    say(`       batch ${batch.id} status: ${now?.status}`)
  } finally {
    await teardown('end')
  }
}

main().catch(() => process.exit(1))
