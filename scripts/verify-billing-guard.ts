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
// Ruled 2026-10-16: no Stripe writes and no A1 reads from this session.
// So the two legs are covered differently and each says which it is:
//   • METERED — decision-logic coverage. The production decision
//     functions are handed a metered check result. Nothing here proves
//     Stripe would return one; the real end-to-end leg is REQUIRED in
//     the slice-2 checkout gate, filed.
//   • A1 — asserted from the nightly BILLING_SYNC_CRON record, which
//     already asks Stripe this exact question every day and writes the
//     answer down. Reading its own record beats making a live call.
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
// 🔴 Imported from app/lib/import-batch-block.ts, which carries no
// `server-only` — these are the PRODUCTION functions the routes call,
// not a test double. The standing rule is no fault-injection seam in
// production code, and there is none: nothing in that module exists
// only for this gate.
import { meteredLoadReasons, blockRefusesAction, type BatchBlock } from '../app/lib/import-batch-block'
import type { MeteredLineItemCheck } from '../app/lib/stripe-mutations'

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

    // ── 🔴 all four routes go through the ONE decision ──────────────
    // 🔴 THESE TWO CHECKS REPLACED A PAIR THAT WENT STALE IN THE SAME
    // CHANGE THAT FIXED THEM. The earlier version read each route's
    // source for its inline condition — `block.blocked` versus
    // `blocked || loadBlocked` — and once the four routes were
    // refactored onto blockRefusesAction those conditions no longer
    // existed there, so the checks failed while the behaviour was
    // correct. A regex asserting a line that has moved is the stale
    // gate this arc keeps tripping over.
    //
    // The truth table above now proves the BEHAVIOUR by execution. The
    // only thing source can still usefully say is the WIRING: that each
    // route delegates, and passes its own action. A route that
    // hand-rolled the condition again, or passed 'return' where it
    // means 'load', would pass the truth table and be wrong.
    console.log('\n── 🔴 the wiring: four routes, one decision, correct action each ──')
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const routeSrc: Record<string, string> = {}
    for (const a of ['approve', 'load', 'return', 'reject']) {
      routeSrc[a] = strip(fs.readFileSync(`app/api/admin/import-batch/${a}/route.ts`, 'utf8'))
    }
    chk('   (comments stripped before reading the route source)',
      !/ONLY THE HARD BLOCK/.test(routeSrc.return),
      'a presence check over commented source can assert the comment instead of the code — three times today')
    for (const a of ['approve', 'load', 'return', 'reject']) {
      chk(`🔴 ${a} delegates to blockRefusesAction('${a}')`,
        new RegExp(`blockRefusesAction\\('${a}', review\\.block\\)`).test(routeSrc[a]),
        `passing another route's action would pass the truth table and still be wrong`)
    }
    chk('🔴 ...and none of them hand-rolls the condition any more',
      !Object.values(routeSrc).some(t => /block\.loadBlocked/.test(t)),
      'four inline copies of a per-action rule is where the fourth one drifts')

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE METERED LEG — DECISION-LOGIC COVERAGE
    // ══════════════════════════════════════════════════════════════
    // Ruled 2026-10-16: no Stripe writes, so the metered branch is
    // tested by handing the real decision function a metered check
    // result. This is NOT end-to-end: nothing proves Stripe would
    // return such a result, because no subscription carries a
    // per_permit item yet. What it proves is that WHEN one does, the
    // refusals and the permissions are the ruled ones.
    //
    // The real end-to-end leg is filed as required in the slice-2
    // checkout gate — see docs/phaseB-billing-guard-gate-gap.md.
    console.log('\n── 🔴 METERED: decision-logic coverage (not end-to-end) ──')
    const meteredCheck: MeteredLineItemCheck =
      { ok: true, metered: true, lineItems: ['per_permit'], quantity: 42 }
    const meteredReasons = meteredLoadReasons(meteredCheck, 'Metered Test Co', 358)
    chk('🔴 a per_permit line item produces a load-blocking reason',
      meteredReasons.length === 1, str(meteredReasons))
    chk('   ...labelled "Blocked: metered tenant", as ruled',
      /^Blocked: metered tenant\./.test(meteredReasons[0] ?? ''),
      (meteredReasons[0] ?? '').slice(0, 150))
    chk('   ...naming the current quantity and what the batch would add',
      /\b42\b/.test(meteredReasons[0] ?? '') && /\b358\b/.test(meteredReasons[0] ?? ''),
      'an operator has to see the size of the thing they are being protected from')
    chk('🔴 ...and saying what to do instead — return it and agree the billing',
      /[Rr]eturn the batch/.test(meteredReasons[0] ?? ''),
      'a refusal with no next step is a dead end')

    const meteredBlock: BatchBlock = {
      blocked: false, reasons: [],
      loadBlocked: meteredReasons.length > 0, loadReasons: meteredReasons,
    }
    chk('🔴 APPROVE is refused for a metered tenant',
      blockRefusesAction('approve', meteredBlock) === true)
    chk('🔴 LOAD is refused for a metered tenant',
      blockRefusesAction('load', meteredBlock) === true)
    chk('🔴 RETURN is NOT refused — it is the right move for them',
      blockRefusesAction('return', meteredBlock) === false,
      'blocking this would leave a metered tenant\'s batch with no move the operator could make')
    chk('🔴 REJECT is NOT refused either',
      blockRefusesAction('reject', meteredBlock) === false,
      'a clean file from a metered tenant still needs a sentence saying why it will not be loaded')

    // The fail-closed branch, same way.
    const unreachable: MeteredLineItemCheck = { ok: false, reason: 'the subscription could not be read' }
    const failClosed = meteredLoadReasons(unreachable, 'Metered Test Co', 358)
    chk('🔴 an UNREACHABLE billing system also blocks the load — fail closed',
      failClosed.length === 1 && /could not be checked/.test(failClosed[0]),
      str(failClosed, 160))
    chk('   ...and Return still survives that too',
      blockRefusesAction('return', { blocked: false, reasons: [], loadBlocked: true, loadReasons: failClosed }) === false)

    // And the negative control: a non-metered check must produce NOTHING.
    for (const [label, c] of [
      ['no subscription', { ok: true, metered: false, reason: 'skipped_no_sub' }],
      ['subscribed, no per_permit item', { ok: true, metered: false, reason: 'skipped_no_line_item' }],
    ] as [string, MeteredLineItemCheck][]) {
      const r = meteredLoadReasons(c, 'Some Co', 358)
      chk(`🔴 ${label} produces NO reason — the guard does not block by default`,
        r.length === 0, str(r))
    }
    // 🔴 The truth table, exhaustively, so a future edit to
    // blockRefusesAction cannot quietly change one cell.
    const clean: BatchBlock = { blocked: false, reasons: [], loadBlocked: false, loadReasons: [] }
    const hard: BatchBlock = { blocked: true, reasons: ['property inactive'], loadBlocked: false, loadReasons: [] }
    const table: [string, BatchBlock, boolean, boolean, boolean, boolean][] = [
      ['no block',        clean,        false, false, false, false],
      ['load-only block', meteredBlock, true,  true,  false, false],
      ['hard block',      hard,         true,  true,  true,  true],
    ]
    let tableOk = true
    for (const [label, b, wa, wl, wr, wj] of table) {
      const got = [blockRefusesAction('approve', b), blockRefusesAction('load', b),
                   blockRefusesAction('return', b), blockRefusesAction('reject', b)]
      const want = [wa, wl, wr, wj]
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        tableOk = false
        console.log(`       🔴 ${label}: approve/load/return/reject = ${got.join(',')} want ${want.join(',')}`)
      }
    }
    chk('🔴 the whole truth table holds — 3 block shapes x 4 actions',
      tableOk, 'no block → nothing refused; load-only → approve+load only; hard → all four')

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE A1 LEG — from the cron's own record, not from Stripe
    // ══════════════════════════════════════════════════════════════
    // Ruled 2026-10-16: no reads of A1 from this session. The nightly
    // permit sync already asks Stripe this exact question every day and
    // writes the answer down, so the evidence exists and asserting it
    // beats making a live call.
    console.log('\n── 🔴 A1: asserted from BILLING_SYNC_CRON, not from Stripe ──')
    const { data: cronRows } = await db.from('audit_logs')
      .select('created_at, new_values').eq('action', 'BILLING_SYNC_CRON')
      .order('created_at', { ascending: false }).limit(40)
    chk('the nightly permit sync has a record to read',
      (cronRows ?? []).length > 0, `${(cronRows ?? []).length} run(s) recorded`)
    const outcomesOf = (row: Record<string, unknown> | undefined) =>
      ((row?.new_values as Record<string, unknown> | undefined)?.outcomes
        ?? []) as { company_name?: string; action?: string }[]
    const latest = (cronRows ?? [])[0]
    const a1Latest = outcomesOf(latest).find(o => /A1 Wrecker/i.test(String(o.company_name ?? '')))
    chk('🔴 the LATEST run records A1 as skipped_no_line_item',
      a1Latest?.action === 'skipped_no_line_item',
      `${latest?.created_at} → ${str(a1Latest)} — the cron asks Stripe this exact question nightly, so its answer is the evidence`)
    // How long it has been true, which is what makes it a fact rather
    // than one reading.
    let streak = 0
    for (const row of cronRows ?? []) {
      const o = outcomesOf(row).find(x => /A1 Wrecker/i.test(String(x.company_name ?? '')))
      if (o?.action === 'skipped_no_line_item') streak++
      else break
    }
    chk('🔴 ...and has done so for every consecutive run on record',
      streak >= 31,
      `${streak} consecutive run(s) — A1's subscription carries no per_permit item, so the guard is inert for them and the load path is unaffected`)
    chk('   ...with no run recording a per_permit outcome for anyone',
      !(cronRows ?? []).some(r => outcomesOf(r).some(o => o.action === 'incremented')),
      'nothing has ever been metered, which is the same fact from the other side')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0
    ? '✅ all green — metered covered as DECISION LOGIC (production functions, injected check result); A1 from the BILLING_SYNC_CRON record. The real metered end-to-end is a required leg in the slice-2 checkout gate.'
    : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })
