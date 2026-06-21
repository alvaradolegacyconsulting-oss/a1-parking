// B66.7 Steps 4–6 — property/driver add + reactivate-within-cycle floor guard.
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
  console.log('── Step 4: Add a property ──')
  const beforeQty = await readSubQuantities()
  console.log(`  Stripe quantities BEFORE: base=${beforeQty.base?.qty} per_property=${beforeQty.per_property?.qty} per_driver=${beforeQty.per_driver?.qty}`)

  const { data: prop, error: pe } = await c.from('properties').insert({
    name: 'E2E Property 1',
    company: COMPANY_NAME,
    address: '123 Smoke St',
    city: 'Houston',
    state: 'TX',
    zip: '77002',
    visitor_capacity: 10,
    is_active: true,
  }).select('id').single()
  if (pe) { console.log('FAIL property insert:', pe.message); return }
  console.log(`  inserted property id=${prop!.id}`)

  const syncResult = await syncOnAdd(COMPANY_ID, 'property')
  console.log(`  syncOnAdd result: ${JSON.stringify(syncResult)}`)

  const afterPropQty = await readSubQuantities()
  console.log(`  Stripe quantities AFTER: base=${afterPropQty.base?.qty} per_property=${afterPropQty.per_property?.qty} per_driver=${afterPropQty.per_driver?.qty}`)
  const propPass = afterPropQty.per_property?.qty === (beforeQty.per_property?.qty ?? 0) + 1
  console.log(`  ${propPass ? 'PASS' : 'FAIL'} per_property qty incremented by 1 (${beforeQty.per_property?.qty} → ${afterPropQty.per_property?.qty})`)

  console.log('\n── Step 5: Add a driver ──')
  const drvBefore = afterPropQty
  const { data: driver, error: de } = await c.from('drivers').insert({
    name: 'E2E Driver 1',
    email: 'e2e-driver-1@example.com',
    phone: '+15551234567',
    company: COMPANY_NAME,
    assigned_properties: ['E2E Property 1'],
    operator_license: 'TX-E2E-DRV-001',
    is_active: true,
  }).select('id').single()
  if (de) { console.log('FAIL driver insert:', de.message); return }
  console.log(`  inserted driver id=${driver!.id}`)

  const drvSyncResult = await syncOnAdd(COMPANY_ID, 'driver')
  console.log(`  syncOnAdd result: ${JSON.stringify(drvSyncResult)}`)

  const afterDrvQty = await readSubQuantities()
  console.log(`  Stripe quantities AFTER: base=${afterDrvQty.base?.qty} per_property=${afterDrvQty.per_property?.qty} per_driver=${afterDrvQty.per_driver?.qty}`)
  const drvPass = afterDrvQty.per_driver?.qty === (drvBefore.per_driver?.qty ?? 0) + 1
  console.log(`  ${drvPass ? 'PASS' : 'FAIL'} per_driver qty incremented by 1 (${drvBefore.per_driver?.qty} → ${afterDrvQty.per_driver?.qty})`)

  console.log('\n── Step 6: Deactivate then reactivate property → noop_within_floor ──')
  // Deactivate
  const { error: deActErr } = await c.from('properties').update({ is_active: false }).eq('id', prop!.id)
  if (deActErr) { console.log('FAIL deactivate:', deActErr.message); return }
  console.log(`  property deactivated`)

  // Reactivate
  const { error: reActErr } = await c.from('properties').update({ is_active: true }).eq('id', prop!.id)
  if (reActErr) { console.log('FAIL reactivate:', reActErr.message); return }
  console.log(`  property reactivated`)

  const reactSyncResult = await syncOnAdd(COMPANY_ID, 'property')
  console.log(`  syncOnAdd result: ${JSON.stringify(reactSyncResult)}`)

  const afterReactQty = await readSubQuantities()
  console.log(`  Stripe quantities AFTER: base=${afterReactQty.base?.qty} per_property=${afterReactQty.per_property?.qty} per_driver=${afterReactQty.per_driver?.qty}`)
  const reactPass = (reactSyncResult as { ok: true; action: string }).action === 'noop_within_floor'
    && afterReactQty.per_property?.qty === afterDrvQty.per_property?.qty
  console.log(`  ${reactPass ? 'PASS' : 'FAIL'} noop_within_floor (action=${(reactSyncResult as any).action}; qty unchanged ${afterDrvQty.per_property?.qty} → ${afterReactQty.per_property?.qty})`)

  console.log('\n── Step 4-6 SUMMARY ──')
  console.log(`  property add:      ${propPass ? 'PASS' : 'FAIL'}`)
  console.log(`  driver add:        ${drvPass ? 'PASS' : 'FAIL'}`)
  console.log(`  reactivate floor:  ${reactPass ? 'PASS' : 'FAIL'}`)

  console.log('\nrefs for Step 7/8:')
  console.log(`  property_id=${prop!.id} driver_id=${driver!.id}`)
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })
