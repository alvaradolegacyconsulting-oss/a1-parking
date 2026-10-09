// B66.7 Step 3 — webhook landing + ground-truth reads.
// Reads:
//   • stripe_events table (1:1 vs what stripe listen captured)
//   • companies row (every relevant column)
//   • proposal_codes row (status, company_id, redeemed_at)
//   • user_roles row (company_admin)
//   • cross-check against Stripe (Subscription + Customer)

import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const stripeKey  = process.env.STRIPE_TEST_SECRET_KEY!

const c = createClient(url, serviceKey, { auth: { persistSession: false } })
const stripe = new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' })

const EMAIL = 'alvaradolegacyconsulting+e2e@gmail.com'
const CODE  = 'E2E-TGKWRN'

async function main() {
  // 1. Auth user
  const { data: page } = await c.auth.admin.listUsers({ page:1, perPage:200 })
  const u = page.users.find(x => x.email === EMAIL)
  if (!u) { console.log('FAIL: auth user not found'); return }
  console.log(`auth.user: id=${u.id} confirmed=${u.email_confirmed_at}`)
  console.log(`  metadata.proposal_code=${(u.user_metadata as any)?.proposal_code}`)
  console.log(`  metadata.intended_tier=${JSON.stringify((u.user_metadata as any)?.intended_tier)}`)

  // 2. user_roles
  const { data: ur } = await c.from('user_roles').select('*').ilike('email', EMAIL).maybeSingle()
  console.log('\nuser_roles row:')
  console.log(JSON.stringify(ur, null, 2))

  if (!ur) { console.log('FAIL: no user_roles row'); return }
  const companyName = ur.company

  // 3. companies
  const { data: co } = await c.from('companies').select('*').ilike('name', companyName!).maybeSingle()
  console.log('\ncompanies row (all relevant cols):')
  if (!co) { console.log('FAIL: no companies row'); return }
  const showCols = ['id','name','tier','tier_type','account_state','stripe_customer_id','stripe_subscription_id','subscription_status','current_period_end','cancel_at_period_end','address','billing_city','billing_state','billing_postal_code']
  for (const k of showCols) console.log(`  ${k}: ${JSON.stringify((co as any)[k])}`)

  // 4. proposal_codes
  const { data: pc } = await c.from('proposal_codes').select('id,code,status,company_id,redeemed_at,issued_at').eq('code', CODE).maybeSingle()
  console.log('\nproposal_codes row:')
  console.log(JSON.stringify(pc, null, 2))

  // 5. stripe_events table (1:1 vs the events Stripe sent)
  const { data: events } = await c
    .from('stripe_events')
    .select('id,event_id,event_type,processed,process_error,process_skip_reason,received_at,processed_at,process_attempts')
    .gte('received_at', new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .order('received_at', { ascending: true })
  console.log('\nstripe_events (last 30 min):')
  console.log(`  count=${events?.length ?? 0}`)
  for (const e of events ?? []) {
    console.log(`  ${e.event_type} | processed=${e.processed} | skip=${e.process_skip_reason ?? '-'} | err=${e.process_error ?? '-'} | attempts=${e.process_attempts}`)
  }
  // 1:1 check — duplicates?
  const byType: Record<string, number> = {}
  for (const e of events ?? []) byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
  console.log('  byType:', JSON.stringify(byType))

  // 6. Cross-check Stripe-side Subscription + Customer
  if (co.stripe_subscription_id) {
    const sub = await stripe.subscriptions.retrieve(co.stripe_subscription_id, { expand: ['items.data.price'] })
    console.log('\nStripe Subscription cross-check:')
    console.log(`  id=${sub.id} status=${sub.status} customer=${sub.customer}`)
    console.log(`  items:`)
    for (const it of sub.items.data) {
      console.log(`    ${it.id} | qty=${it.quantity} | price=${it.price.id} (${it.price.lookup_key}) | ${it.price.unit_amount}¢`)
    }
    console.log(`  default_tax_rates: ${JSON.stringify(sub.default_tax_rates?.map(t => typeof t === 'string' ? t : t.id) ?? [])}`)
    // current_period_end check
    const subPeriodEnd = sub.items.data[0]?.current_period_end
    if (subPeriodEnd) {
      console.log(`  items[0].current_period_end (stripe): ${new Date(subPeriodEnd*1000).toISOString()}`)
      console.log(`  companies.current_period_end (db):    ${co.current_period_end}`)
    }
    // Tax on the first invoice (proves Houston ZIP tax)
    if (sub.latest_invoice) {
      const inv = await stripe.invoices.retrieve(typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice.id)
      const invAny = inv as unknown as Record<string, unknown>
      console.log(`  latest_invoice: id=${inv.id} status=${inv.status} subtotal=${inv.subtotal} tax=${JSON.stringify(invAny.tax ?? invAny.total_tax ?? invAny.total_taxes)} total=${inv.total}`)
    }
  }
  if (co.stripe_customer_id) {
    const cu = await stripe.customers.retrieve(co.stripe_customer_id)
    console.log('\nStripe Customer cross-check:')
    if ('email' in cu) console.log(`  id=${cu.id} email=${cu.email}`)
    if ('address' in cu) console.log(`  address: ${JSON.stringify(cu.address)}`)
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
