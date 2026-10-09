// ════════════════════════════════════════════════════════════════════
// Backfill companies.billing_interval
// ════════════════════════════════════════════════════════════════════
//
// The webhook now writes this on every customer.subscription.created /
// .updated, but existing subscribers have had no such event since the
// column was added. Two companies carry a subscription id: A1 Wrecker
// llc (live, active) and Test PM Starter 2 (test, canceled).
//
// 🔴 A1 NEEDS NO STRIPE CALL, and that matters because the live key
// stays with Jose. A1 bought through a proposal code, and its per-code
// base price is in stripe_prices: row 170,
// price_1Ts2CaKM2PcfaFN9xt6bStuy, line_item='base', cycle='monthly',
// mode='live', proposal_code_id=54. The catalog is the projection of
// what A1 is actually billed from, so reading the cycle off it is not a
// guess — it is the same row the webhook's own tier resolution uses.
//
// 🔴 AND IT REFUSES TO GUESS. Scoping only by
// (tier_track, tier_name, mode, line_item='base') would be ambiguous
// for A1: the Oct-2026 standard lineup also has enforcement/legacy base
// rows in live mode, monthly AND annual. So the proposal-code path
// scopes by proposal_code_id, and any address that resolves to more
// than one distinct cycle is REPORTED, never picked.
//
// Resolution ladder, most authoritative first:
//   1. redeemed proposal code → stripe_prices WHERE proposal_code_id
//      AND line_item='base' → cycle   (exactly one distinct cycle, or refuse)
//   2. read the subscription from Stripe → its base price →
//      stripe_prices.cycle; if that price is absent from the catalog,
//      Stripe's recurring.interval mapped month→monthly / year→annual
//   3. refuse, and say which company and why
//
// Usage: npx tsx scripts/backfill-billing-interval.ts [--apply]
//        STRIPE_MODE=test is enough: step 1 covers the live subscriber.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')
const testKey = process.env.STRIPE_TEST_SECRET_KEY || g('STRIPE_TEST_SECRET_KEY')
const stripeTest = testKey ? new Stripe(testKey) : null

type Resolution = { interval: 'monthly' | 'annual' | null; how: string }

async function viaProposalCode(companyId: number): Promise<Resolution | null> {
  const { data: codes } = await db.from('proposal_codes')
    .select('id, code').eq('company_id', companyId).eq('status', 'redeemed')
  if (!codes?.length) return null
  const ids = codes.map(c => c.id)
  const { data: rows } = await db.from('stripe_prices')
    .select('stripe_price_id, cycle, mode, proposal_code_id')
    .in('proposal_code_id', ids).eq('line_item', 'base').eq('is_active', true)
  if (!rows?.length) return null
  const cycles = [...new Set(rows.map(r => r.cycle).filter(Boolean))]
  if (cycles.length !== 1) {
    return { interval: null, how: `AMBIGUOUS — proposal-code base prices give ${cycles.length} distinct cycles (${cycles.join(', ')})` }
  }
  const c = cycles[0]
  if (c !== 'monthly' && c !== 'annual') return { interval: null, how: `catalog cycle is ${JSON.stringify(c)}, not monthly/annual` }
  return { interval: c, how: `proposal code ${codes.map(x => x.code).join(',')} → stripe_prices base cycle` }
}

async function viaStripe(subId: string): Promise<Resolution | null> {
  if (!stripeTest) return { interval: null, how: 'no test key available' }
  let sub: Stripe.Subscription
  try {
    sub = await stripeTest.subscriptions.retrieve(subId)
  } catch (e) {
    // A live-mode subscription read with a test key fails here. That is
    // expected and is NOT a failure of the backfill — step 1 is meant
    // to have covered it. Reported so a silent miss is impossible.
    return { interval: null, how: `not readable with the test key (${(e as Error).message.slice(0, 60)})` }
  }
  const priceIds = sub.items.data.map(i => i.price.id)
  const { data: rows } = await db.from('stripe_prices')
    .select('cycle').in('stripe_price_id', priceIds).eq('line_item', 'base')
  const cycles = [...new Set((rows ?? []).map(r => r.cycle).filter(Boolean))]
  if (cycles.length === 1 && (cycles[0] === 'monthly' || cycles[0] === 'annual')) {
    return { interval: cycles[0], how: 'Stripe subscription → catalog base cycle' }
  }
  const iv = sub.items.data[0]?.price?.recurring?.interval ?? null
  const mapped = iv === 'month' ? 'monthly' : iv === 'year' ? 'annual' : null
  if (mapped) return { interval: mapped, how: `Stripe recurring.interval=${iv} (base price not in catalog)` }
  return { interval: null, how: `unresolved: catalog gave ${cycles.length} cycles, Stripe interval ${JSON.stringify(iv)}` }
}

const main = async () => {
  console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (pass --apply to write) ──\n')

  const { data: cos, error } = await db.from('companies')
    .select('id, name, tier, tier_type, stripe_subscription_id, subscription_status, billing_interval')
    .not('stripe_subscription_id', 'is', null).order('id')
  if (error) {
    if (/billing_interval.*does not exist/i.test(error.message)) {
      console.error('companies.billing_interval does not exist — apply')
      console.error('  migrations/20261010_companies_billing_interval.sql  first.')
      console.error('  This is NOT a failure of the backfill.')
      process.exit(2)
    }
    console.error('read failed:', error.message); process.exit(2)
  }
  console.log(`companies with a subscription id: ${cos?.length}\n`)

  const plan: Array<{ id: number; name: string; from: string | null; to: 'monthly' | 'annual'; how: string }> = []
  const refused: Array<{ id: number; name: string; why: string }> = []

  for (const c of cos ?? []) {
    const byCode = await viaProposalCode(c.id as number)
    let r: Resolution | null = byCode && byCode.interval ? byCode : null
    if (!r) r = await viaStripe(c.stripe_subscription_id as string)
    if (!r?.interval) {
      refused.push({ id: c.id as number, name: c.name as string, why: [byCode?.how, r?.how].filter(Boolean).join(' / ') || 'no resolution path' })
      continue
    }
    if (c.billing_interval === r.interval) {
      console.log(`  = ${c.name}: already ${r.interval}`)
      continue
    }
    plan.push({ id: c.id as number, name: c.name as string, from: (c.billing_interval as string) ?? null, to: r.interval, how: r.how })
  }

  console.log(`\n═══ WILL SET — ${plan.length} ═══`)
  for (const p of plan) console.log(`   ${String(p.id).padStart(4)} ${p.name.padEnd(22)} ${String(p.from ?? 'NULL').padEnd(7)} -> ${p.to.padEnd(7)}  via ${p.how}`)
  console.log(`\n═══ REFUSED — ${refused.length} (reported, never guessed) ═══`)
  for (const r of refused) console.log(`   🔴 ${r.id} ${r.name}: ${r.why}`)

  if (!APPLY) { console.log('\nDry run — nothing written.'); return }
  if (!plan.length) { console.log('\nNothing to set.'); return }

  for (const p of plan) {
    const { data, error: uErr } = await db.from('companies')
      .update({ billing_interval: p.to }).eq('id', p.id).select('id, name, billing_interval')
    if (uErr) { console.error(`UPDATE failed on ${p.id}:`, uErr.message); process.exit(2) }
    console.log(`   set ${data?.[0]?.name} -> ${data?.[0]?.billing_interval}`)
  }

  await db.from('audit_logs').insert({
    user_email: 'backfill-billing-interval script',
    action: 'BILLING_INTERVAL_BACKFILLED',
    table_name: 'companies',
    record_id: null,
    old_values: { before: plan.map(p => ({ id: p.id, billing_interval: p.from })) },
    new_values: { after: plan.map(p => ({ id: p.id, billing_interval: p.to, resolved_via: p.how })), refused },
    notes: 'companies.billing_interval added 2026-10-10 so the CA plan card can price itself from the stripe_prices catalog without reading Stripe at render. Existing subscribers had had no subscription webhook since. A1 resolved from its per-code base price in stripe_prices (no live key needed); anything ambiguous or unreadable was refused and reported rather than guessed.',
  })
  console.log('\naudit row written (BILLING_INTERVAL_BACKFILLED)')

  const { data: after } = await db.from('companies')
    .select('id, name, billing_interval').not('stripe_subscription_id', 'is', null).order('id')
  console.log('\nAFTER:')
  for (const a of after ?? []) console.log(`   ${a.id} ${String(a.name).padEnd(22)} ${a.billing_interval ?? 'NULL'}`)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })
