// ════════════════════════════════════════════════════════════════════
// GATE — the billing guard on bulk load
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16: refuse to approve or load for any company whose
// subscription carries a per_permit line item; show it as a can't-load
// reason; no effect on a non-metered tenant.
//
// 🔴 WHAT THIS GATE CAN REACH, AND WHAT IT REFUSES TO PRETEND.
// Measured 2026-10-16:
//   • A1 Wrecker llc is the ONLY company in the system with a
//     stripe_subscription_id.
//   • NO subscription anywhere carries a per_permit item — syncOnAdd's
//     own comment says so: "Until slice 2 ships checkout creating
//     subscriptions with per_permit items, this returns
//     action='skipped_no_line_item'".
//
// So the metered branch cannot be exercised against a real
// subscription, and the subscribed-but-not-metered branch exists only
// on A1, which is production and which the standing rule keeps out of
// tests. Building a subscription to test against is a Stripe write and
// a decision — filed in docs/phaseB-billing-guard-gate-gap.md.
//
// This gate therefore asserts, by execution:
//   • a tenant with NO subscription is not blocked (the skipped_no_sub
//     shape — Demo Company, and every test company);
//   • the guard runs on the load path at all, rather than being dead
//     code the queue never calls;
//   • the two block KINDS are wired so Return survives a load-only
//     block, which is the part of the ruling that is easy to get wrong
//     and does not need a metered tenant to check.
//
// And it states the two legs it cannot reach rather than passing them.
//
// Usage: npm run verify:billingguard

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

const PORT = 4001
const BASE = `http://127.0.0.1:${PORT}`
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
const note = (n: string, d: string) => console.log(`➖ ${n}\n       ${d}`)
const str = (v: unknown, n = 220) => (JSON.stringify(v) ?? 'undefined').slice(0, n)

let srv: DevServer | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
let flaggedCompany: number | null = null
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if ((r.data ?? []).length) say(`   ↩ removed ${(r.data ?? []).length} role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} auth user(s)`)
  if (flaggedCompany !== null) {
    const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
      .eq('id', flaggedCompany).select('bulk_onboarding_enabled')
    if (r.error || r.data?.[0]?.bulk_onboarding_enabled !== false) { warn('   🔴 FLAG NOT RESTORED'); fails++ }
    else say(`   ↩ bulk_onboarding_enabled back to false on company ${flaggedCompany}`)
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
async function actor(label: string, role: string): Promise<Actor> {
  const email = `zz-bg-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role, company: null, property: [], is_active: true }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  const { cookie, accessToken } = await cookieHeaderFor(db, URL_, ANON, email)
  return { email, cookie, client: createClient(URL_, ANON, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken}` } } }) }
}

const post = (path: string, body: unknown, a: Actor) => fetch(`${BASE}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
  body: JSON.stringify(body),
})
const js = async (r: Response) => { try { return JSON.parse(await r.text()) as Record<string, any> } catch { return {} } }

const main = async () => {
  if (await portBusy(PORT)) {
    warn(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  // ── the Stripe landscape, measured rather than assumed ───────────
  console.log('── the billing landscape ──')
  const { data: cos } = await db.from('companies')
    .select('id,name,company_env,stripe_subscription_id,bulk_onboarding_enabled').order('id')
  const subscribed = (cos ?? []).filter(c => !!c.stripe_subscription_id)
  const { data: prices } = await db.from('stripe_prices').select('line_item').eq('line_item', 'per_permit')
  console.log(`   ${(cos ?? []).length} companies, ${subscribed.length} with a Stripe subscription: ${subscribed.map(c => c.name).join(', ') || '(none)'}`)
  console.log(`   ${(prices ?? []).length} per_permit Price(s) in the catalog`)
  chk('the per_permit catalog exists, so the guard has something to match one day',
    (prices ?? []).length > 0, `${(prices ?? []).length} prices`)

  const demo = (cos ?? []).find(c => c.company_env === 'demo')
  if (!demo) { warn("🔴 no demo company. Refusing."); process.exit(2) }
  if (demo.bulk_onboarding_enabled === true) {
    warn(`🔴 ${demo.name} already has the flag on; this gate restores it to false. Clear it first.`)
    process.exit(2)
  }
  const { data: batch } = await db.from('import_batches').select('id,status,company_id')
    .eq('company_id', demo.id).order('id').limit(1).maybeSingle()
  if (!batch) { warn('🔴 no batch at the demo company. Run npm run seed:demobatch first.'); process.exit(2) }
  if (batch.status !== 'submitted') {
    warn(`🔴 batch ${batch.id} is '${batch.status}', not 'submitted'. Refusing.`)
    process.exit(2)
  }

  try {
    const admin = await actor('adm', 'admin')
    await db.from('companies').update({ bulk_onboarding_enabled: true }).eq('id', demo.id)
    flaggedCompany = demo.id as number

    srv = await startDevServer(PORT)
    if (!srv) { warn('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    say('server up\n')

    // ── 🔴 a tenant with no subscription is not blocked ─────────────
    console.log('── 🔴 a tenant with NO subscription (the skipped_no_sub shape) ──')
    const rev = await js(await post('/api/admin/import-batch/review', { batch_id: batch.id }, admin))
    chk('review answers', rev.ok === true, str(rev.block))
    chk('🔴 it is NOT load-blocked — no subscription means nothing to meter',
      rev.block?.loadBlocked === false,
      `loadBlocked=${rev.block?.loadBlocked} loadReasons=${str(rev.block?.loadReasons)} — ${demo.name} has no stripe_subscription_id, which is also every test company's shape`)
    chk('   ...and approve is offered, so the guard is not blocking by default',
      rev.can_approve === true,
      `can_approve=${rev.can_approve} — a guard that refused everyone would pass a refusal-only gate, which is why this leg exists`)

    // 🔴 The guard RAN. If companyPerPermitLineItems were never called,
    // every assertion above would still pass — so the response has to
    // carry the shape, not just the absence of a block.
    chk('🔴 the response carries both block kinds, so the guard is on this path',
      typeof rev.block?.loadBlocked === 'boolean' && Array.isArray(rev.block?.loadReasons),
      str(rev.block))

    const ap = await js(await post('/api/admin/import-batch/approve', { batch_id: batch.id }, admin))
    chk('approving a non-metered tenant goes through', ap.ok === true, str(ap, 140))
    // Put it back — this gate is not the loader's.
    await db.from('import_batches').update({ status: 'submitted', approved_by: null, approved_at: null })
      .eq('id', batch.id)
    const back = await db.from('import_batches').select('status').eq('id', batch.id).maybeSingle()
    chk('   (restored to submitted)', back.data?.status === 'submitted', `status=${back.data?.status}`)

    // ── 🔴 the two block kinds are wired differently ───────────────
    // This does not need a metered tenant: it is a property of the
    // routes, and getting it wrong is how a metered tenant's batch
    // would end up with no move the operator could make.
    console.log('\n── 🔴 Return survives a load-only block (route source) ──')
    // 🔴 COMMENTS STRIPPED FIRST, AND THIS IS THE THIRD TIME THIS
    // SESSION. The first version read the raw files and failed:
    // return/reject carry the comment "ONLY THE HARD BLOCK, NOT
    // loadBlocked", so a regex looking for loadBlocked found the
    // sentence saying it is not used. The memory written after the
    // SQL version of this says presence checks survive it and
    // COUNT/POSITION checks do not — but a NEGATIVE presence check
    // ("this token must be ABSENT") is just as vulnerable, and that is
    // what these two are. Stripping is the fix wherever a gate reads
    // source, in any language.
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const approveSrc = strip(fs.readFileSync('app/api/admin/import-batch/approve/route.ts', 'utf8'))
    const loadSrc = strip(fs.readFileSync('app/api/admin/import-batch/load/route.ts', 'utf8'))
    const returnSrc = strip(fs.readFileSync('app/api/admin/import-batch/return/route.ts', 'utf8'))
    const rejectSrc = strip(fs.readFileSync('app/api/admin/import-batch/reject/route.ts', 'utf8'))
    // And prove the strip did something, or a broken regex quietly
    // returns the gate to reading prose.
    chk('   (comments stripped before reading the route source)',
      !/ONLY THE HARD BLOCK/.test(returnSrc) && returnSrc.includes('review.block.blocked'),
      'a negative presence check over commented source asserts the comment, not the code')
    chk('🔴 approve and load refuse on EITHER kind',
      /block\.blocked \|\| review\.block\.loadBlocked|blocked \|\| review\.block\.loadBlocked/.test(approveSrc)
      && /blocked \|\| review\.block\.loadBlocked/.test(loadSrc),
      'a metered tenant must not be approved or loaded')
    chk('🔴 return and reject refuse on the HARD block only',
      !/loadBlocked/.test(returnSrc) && !/loadBlocked/.test(rejectSrc),
      'sending the batch back is the right answer for a metered tenant — "we cannot bulk-load you, your plan bills per permit". Blocking it would leave the batch stuck.')

    // ── what this gate cannot reach ────────────────────────────────
    console.log('\n── 🔴 the two legs this gate refuses to pretend it covered ──')
    note('a METERED tenant is refused',
      `UNTESTED. No subscription in the system carries a per_permit item — syncOnAdd's own comment says the meter activates only once slice 2 ships checkout creating them. Testing it means CREATING a Stripe subscription with one of the ${(prices ?? []).length} catalog per_permit Prices, which is a Stripe write and a decision. See docs/phaseB-billing-guard-gate-gap.md.`)
    note('an A1-shaped tenant (subscribed, not metered) is unaffected',
      `UNTESTED. ${subscribed.map(c => c.name).join(', ') || '(nobody)'} is the only subscribed company, and it is production — the standing rule keeps A1 out of tests. The code path it would exercise (load company → retrieve subscription → find no per_permit item → skipped_no_line_item) is the same one the no-subscription leg above exercises up to the retrieve.`)

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green (2 legs stated as untested, not passed)' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })
