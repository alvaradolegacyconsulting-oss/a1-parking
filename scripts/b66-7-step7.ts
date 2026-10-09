// B66.7 Step 7 — Stripe-side base price swap → fire customer.subscription.updated.
// Swap Legacy base → Growth base; verify companies.tier flips legacy → growth.
// Then restore Legacy.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const stripeKey  = process.env.STRIPE_TEST_SECRET_KEY!
const c = createClient(url, serviceKey, { auth: { persistSession: false } })
const stripe = new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' })

const COMPANY_ID = 54
const SUB_ID = 'sub_1Thv0c3UC9fdqhGiSwWfEejq'
const LEGACY_BASE = 'price_1ThuXB3UC9fdqhGi6wZSCisp'   // proposal-code Legacy
const GROWTH_BASE = 'price_1Tcno83UC9fdqhGi7vdw2IMz'   // standard catalog Growth

async function readCompanyTier() {
  const { data } = await c.from('companies').select('tier,tier_type,updated_at').eq('id', COMPANY_ID).single()
  return data
}

async function findBaseItem(): Promise<string> {
  const sub = await stripe.subscriptions.retrieve(SUB_ID, { expand: ['items.data.price'] })
  for (const it of sub.items.data) {
    if (it.price.lookup_key?.includes('.base.')) return it.id
  }
  throw new Error('no base item found on subscription')
}

async function readWebhookEvents(sinceIso: string) {
  const { data } = await c.from('stripe_events')
    .select('event_type,received_at,processed,process_error,process_skip_reason')
    .gte('received_at', sinceIso)
    .order('received_at', { ascending: true })
  return data ?? []
}

async function main() {
  const tierBefore = await readCompanyTier()
  console.log(`tier BEFORE swap: ${tierBefore!.tier}/${tierBefore!.tier_type} (companies.updated_at=${tierBefore!.updated_at})`)
  const baseItemId = await findBaseItem()
  console.log(`base item id: ${baseItemId}`)

  console.log('\n── SWAP Legacy → Growth base price ──')
  const swapAt = new Date().toISOString()
  await stripe.subscriptionItems.update(baseItemId, {
    price: GROWTH_BASE,
    proration_behavior: 'none',  // smoke isolation; not testing proration
  })
  console.log(`  swap fired (waiting 5s for webhook landings)...`)
  await new Promise(r => setTimeout(r, 5000))

  const eventsAfterSwap = await readWebhookEvents(swapAt)
  console.log(`  events received post-swap: ${eventsAfterSwap.length}`)
  for (const e of eventsAfterSwap) {
    const status = e.process_error ? 'ERR:'+e.process_error.slice(0,80) : (e.process_skip_reason ? 'SKIP:'+e.process_skip_reason.slice(0,80) : 'OK')
    console.log(`    ${e.event_type} | proc=${e.processed} | ${status}`)
  }

  const tierAfter = await readCompanyTier()
  console.log(`\ntier AFTER swap: ${tierAfter!.tier}/${tierAfter!.tier_type} (companies.updated_at=${tierAfter!.updated_at})`)
  const pass = tierAfter!.tier === 'growth' && tierAfter!.tier_type === 'enforcement' && tierAfter!.updated_at !== tierBefore!.updated_at
  console.log(`  ${pass ? 'PASS' : 'FAIL'} B141 tier write (expected: growth/enforcement; got: ${tierAfter!.tier}/${tierAfter!.tier_type})`)

  console.log('\n── RESTORE Growth → Legacy base price ──')
  const restoreAt = new Date().toISOString()
  await stripe.subscriptionItems.update(baseItemId, {
    price: LEGACY_BASE,
    proration_behavior: 'none',
  })
  console.log(`  restore fired (waiting 5s)...`)
  await new Promise(r => setTimeout(r, 5000))

  const eventsAfterRestore = await readWebhookEvents(restoreAt)
  console.log(`  events received post-restore: ${eventsAfterRestore.length}`)
  for (const e of eventsAfterRestore) {
    const status = e.process_error ? 'ERR:'+e.process_error.slice(0,80) : (e.process_skip_reason ? 'SKIP:'+e.process_skip_reason.slice(0,80) : 'OK')
    console.log(`    ${e.event_type} | proc=${e.processed} | ${status}`)
  }

  const tierRestored = await readCompanyTier()
  console.log(`\ntier AFTER restore: ${tierRestored!.tier}/${tierRestored!.tier_type}`)
  // Note: restoring to the proposal-code Price may or may not flip tier back to 'legacy' — depends on whether the proposal-code Price is mapped via stripe_prices to tier_name='legacy'.
  // Read the stripe_prices row for the legacy proposal-code Price:
  const { data: legacyMapping } = await c.from('stripe_prices')
    .select('tier_name,tier_track').eq('stripe_price_id', LEGACY_BASE).maybeSingle()
  console.log(`  legacy proposal-code Price maps to: ${JSON.stringify(legacyMapping)}`)
  const restorePass = tierRestored!.tier === 'legacy' && tierRestored!.tier_type === 'enforcement'
  console.log(`  ${restorePass ? 'PASS' : 'NOTE'} restore landed (tier=${tierRestored!.tier})`)
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
