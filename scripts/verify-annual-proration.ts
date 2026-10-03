// ════════════════════════════════════════════════════════════════════
// GATE — annual mid-term adds bill NOW; monthly still defers
// ════════════════════════════════════════════════════════════════════
//
// create_prorations puts the proration on the next scheduled invoice.
// On monthly that is ~30 days. On ANNUAL it can be up to twelve months,
// so a property added in month two was invoiced the following January.
//
// This builds a real subscription in TEST mode for each cycle, adds a
// third property, and asserts what Stripe actually did — an invoice
// created and paid immediately on annual, a pending proration on
// monthly. Reading the constant would only prove the constant.
//
// Usage: STRIPE_MODE=test npx tsx scripts/verify-annual-proration.ts
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const stripe = new Stripe(process.env.STRIPE_TEST_SECRET_KEY || g('STRIPE_TEST_SECRET_KEY'))
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const money = (c: number | null | undefined) => c == null ? '—' : '$' + (c / 100).toFixed(2)
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`) }

async function priceIds(cycle: 'monthly' | 'annual') {
  const { data } = await db.from('stripe_prices')
    .select('line_item, stripe_price_id')
    .eq('tier_track', 'enforcement').eq('tier_name', 'legacy')
    .eq('cycle', cycle).eq('mode', 'test').is('proposal_code_id', null).eq('is_active', true)
  const base = data?.find(d => d.line_item === 'base')?.stripe_price_id
  const prop = data?.find(d => d.line_item === 'per_property')?.stripe_price_id
  if (!base || !prop) throw new Error(`missing ${cycle} Operator Pro prices`)
  return { base, prop }
}

async function run(cycle: 'monthly' | 'annual', proration: 'create_prorations' | 'always_invoice') {
  console.log(`\n── ${cycle.toUpperCase()}  (proration_behavior = ${proration}) ──`)
  const { base, prop } = await priceIds(cycle)
  const cust = await stripe.customers.create({ name: `ZZ proration ${cycle}`, email: `zz-proration-${cycle}@test.invalid` })
  // A test clock would be cleaner, but a default payment method on a
  // test customer is enough: Stripe bills the first invoice at once.
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } })
  await stripe.paymentMethods.attach(pm.id, { customer: cust.id })
  await stripe.customers.update(cust.id, { invoice_settings: { default_payment_method: pm.id } })

  const sub = await stripe.subscriptions.create({
    customer: cust.id,
    items: [{ price: base, quantity: 1 }, { price: prop, quantity: 2 }],
  })
  const first = await stripe.invoices.list({ subscription: sub.id, limit: 1 })
  console.log(`   first invoice ${money(first.data[0]?.subtotal)} (${first.data[0]?.status})`)

  const invoicesBefore = (await stripe.invoices.list({ customer: cust.id, limit: 100 })).data.length
  const item = sub.items.data.find(i => i.price.id === prop)!
  await stripe.subscriptionItems.update(item.id, { quantity: 3, proration_behavior: proration })
  const after = await stripe.invoices.list({ customer: cust.id, limit: 100 })
  const created = after.data.length - invoicesBefore

  if (proration === 'always_invoice') {
    chk(`${cycle}: an invoice was created IMMEDIATELY for the add`, created === 1, `${created} new invoice(s)`)
    const newest = after.data[0]
    chk(`${cycle}: ...and it is paid or being collected`,
      ['paid', 'open'].includes(String(newest?.status)), `status=${newest?.status} ${money(newest?.total)}`)
  } else {
    chk(`${cycle}: NO immediate invoice — it waits for the cycle`, created === 0, `${created} new invoice(s)`)
    const up = await (stripe.invoices as unknown as { createPreview: (a: unknown) => Promise<Stripe.Invoice> })
      .createPreview({ subscription: sub.id })
    // 🔴 Detect the proration by ARITHMETIC, not by a flag.
    //
    // The first attempt filtered on `line.proration`, which is absent
    // on this API version, and reported "0 prorated lines" against an
    // upcoming subtotal of $379 — a false red on correct behaviour.
    //
    // A clean next cycle is base + 3 × per-property = $359. Anything
    // ABOVE that is the mid-cycle catch-up. Comparing against the
    // recurring total cannot go stale when Stripe renames a field.
    const recurring = 29900 + 3 * 2000
    const extra = (up.subtotal ?? 0) - recurring
    chk(`${cycle}: a proration is PENDING on the next invoice`,
      extra > 0,
      `upcoming ${money(up.subtotal)} vs clean recurring ${money(recurring)} → ${money(extra)} of catch-up`)
  }

  await stripe.subscriptions.cancel(sub.id)
  await stripe.customers.del(cust.id)
  console.log(`   cleaned up ${cust.id}`)
}

const main = async () => {
  await run('annual', 'always_invoice')
  await run('monthly', 'create_prorations')
  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ ANNUAL BILLS THE ADD NOW; MONTHLY STILL DEFERS IT.')
}
main().catch(e => { console.error('FATAL', e instanceof Error ? e.message : String(e)); process.exit(1) })
