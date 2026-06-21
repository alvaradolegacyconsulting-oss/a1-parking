// B66.7 Step 4b/5b/6b — second add (above floor) to actually test increment,
// then the reactivate floor guard against the new Stripe quantity.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { syncOnAdd } from '../app/lib/stripe-mutations'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const stripeKey  = process.env.STRIPE_TEST_SECRET_KEY!
const c = createClient(url, serviceKey, { auth: { persistSession: false } })
const stripe = new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' })

const COMPANY_ID = 54
const COMPANY_NAME = 'A1 Test E2E'
const SUB_ID = 'sub_1Thv0c3UC9fdqhGiSwWfEejq'

async function readSubQuantities() {
  const sub = await stripe.subscriptions.retrieve(SUB_ID, { expand: ['items.data.price'] })
  const items: Record<string, { qty: number, item_id: string }> = {}
  for (const it of sub.items.data) {
    const li = it.price.lookup_key?.split('.')[3] ?? 'unknown'
    items[li] = { qty: it.quantity!, item_id: it.id }
  }
  return items
}

async function main() {
  console.log('── Step 4b: Add SECOND property → trigger increment above floor ──')
  const before4b = await readSubQuantities()
  console.log(`  Stripe BEFORE: per_property=${before4b.per_property?.qty}`)

  const { data: prop2, error: pe } = await c.from('properties').insert({
    name: 'E2E Property 2',
    company: COMPANY_NAME,
    address: '456 Smoke Ave',
    city: 'Houston',
    state: 'TX',
    zip: '77002',
    visitor_capacity: 10,
    is_active: true,
  }).select('id').single()
  if (pe) { console.log('FAIL property insert:', pe.message); return }
  console.log(`  inserted property2 id=${prop2!.id}`)

  const sync2 = await syncOnAdd(COMPANY_ID, 'property')
  console.log(`  syncOnAdd: ${JSON.stringify(sync2)}`)
  const after4b = await readSubQuantities()
  console.log(`  Stripe AFTER: per_property=${after4b.per_property?.qty}`)
  const pass4b = (sync2 as any).action === 'incremented' && after4b.per_property?.qty === 2
  console.log(`  ${pass4b ? 'PASS' : 'FAIL'} per_property qty 1 → 2`)

  console.log('\n── Step 5b: Add SECOND driver → trigger increment above floor ──')
  const before5b = after4b
  console.log(`  Stripe BEFORE: per_driver=${before5b.per_driver?.qty}`)
  const { data: drv2, error: de } = await c.from('drivers').insert({
    name: 'E2E Driver 2',
    email: 'e2e-driver-2@example.com',
    phone: '+15559876543',
    company: COMPANY_NAME,
    assigned_properties: ['E2E Property 2'],
    operator_license: 'TX-E2E-DRV-002',
    is_active: true,
  }).select('id').single()
  if (de) { console.log('FAIL driver insert:', de.message); return }
  console.log(`  inserted driver2 id=${drv2!.id}`)

  const sync5b = await syncOnAdd(COMPANY_ID, 'driver')
  console.log(`  syncOnAdd: ${JSON.stringify(sync5b)}`)
  const after5b = await readSubQuantities()
  console.log(`  Stripe AFTER: per_driver=${after5b.per_driver?.qty}`)
  const pass5b = (sync5b as any).action === 'incremented' && after5b.per_driver?.qty === 2
  console.log(`  ${pass5b ? 'PASS' : 'FAIL'} per_driver qty 1 → 2`)

  console.log('\n── Step 6b: Deactivate prop2 → reactivate → noop_within_floor (the REAL floor-guard test) ──')
  // Deactivate prop2 (activeCount drops to 1)
  const { error: deactErr } = await c.from('properties').update({ is_active: false }).eq('id', prop2!.id)
  if (deactErr) { console.log('FAIL deactivate:', deactErr.message); return }
  console.log(`  property2 deactivated`)

  // Reactivate prop2 (activeCount back to 2; Stripe.quantity is also 2 from Step 4b)
  const { error: reactErr } = await c.from('properties').update({ is_active: true }).eq('id', prop2!.id)
  if (reactErr) { console.log('FAIL reactivate:', reactErr.message); return }
  console.log(`  property2 reactivated`)

  const before6b = await readSubQuantities()
  console.log(`  Stripe BEFORE syncOnAdd: per_property=${before6b.per_property?.qty}`)
  const sync6b = await syncOnAdd(COMPANY_ID, 'property')
  console.log(`  syncOnAdd: ${JSON.stringify(sync6b)}`)
  const after6b = await readSubQuantities()
  console.log(`  Stripe AFTER: per_property=${after6b.per_property?.qty}`)
  const pass6b = (sync6b as any).action === 'noop_within_floor' && after6b.per_property?.qty === before6b.per_property?.qty
  console.log(`  ${pass6b ? 'PASS' : 'FAIL'} noop_within_floor; qty unchanged ${before6b.per_property?.qty} → ${after6b.per_property?.qty}`)

  console.log('\n── B147 SUMMARY ──')
  console.log(`  4b (property increment above floor): ${pass4b ? 'PASS' : 'FAIL'}`)
  console.log(`  5b (driver increment above floor):   ${pass5b ? 'PASS' : 'FAIL'}`)
  console.log(`  6b (reactivate floor guard):         ${pass6b ? 'PASS' : 'FAIL'}`)

  console.log('\nrefs for Step 7/8:')
  console.log(`  property1=62 property2=${prop2!.id} driver1=59 driver2=${drv2!.id}`)
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
