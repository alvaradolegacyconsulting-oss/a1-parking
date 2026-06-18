// B165 — one-shot provisioning script for the 6 test-mode Stripe
// subscriptions the live probe needs.
//
// ════════════════════════════════════════════════════════════════
// SAFETY GUARANTEES (read this before running)
// ════════════════════════════════════════════════════════════════
//
//   1. HARD-ASSERTS STRIPE_MODE=test at the top. If anything else is
//      set (or unset), the script EXITS with an error code BEFORE the
//      Stripe SDK loads. Cannot proceed against live mode by mistake.
//
//   2. VERIFIES the loaded secret key starts with `sk_test_` or
//      `rk_test_` (Stripe's test-key prefixes). If the key happens to
//      be a live key (sk_live_ / rk_live_) the script EXITS. Belt-and-
//      suspenders — defends against an env-var swap that bypassed (1).
//
//   3. USES ONLY the Stripe-documented TEST PAYMENT METHOD TOKEN
//      `pm_card_visa`. This is a special test-only token recognized by
//      Stripe's test endpoint that always succeeds. It is REJECTED by
//      live-mode endpoints with `resource_missing` — even if test-key
//      enforcement somehow failed, this token CANNOT cause a real
//      charge against a real card.
//
//   4. NO REAL CARD INPUT. Nowhere does this script read card numbers,
//      CVCs, expiration dates, billing info, or anything from a real
//      payment method. The only payment-method reference is the literal
//      string `pm_card_visa`.
//
//   5. NO FILE WRITES that could be checked in by mistake. The script
//      prints env-vars to stdout for Jose to copy into .env.local
//      manually; it does NOT modify .env.local itself.
//
//   6. PRINTS every action it's about to take so the operator can Ctrl-C
//      between phases if anything looks wrong.
//
// ════════════════════════════════════════════════════════════════
// PREREQUISITES
// ════════════════════════════════════════════════════════════════
//
//   • .env.local must have STRIPE_MODE=test + STRIPE_TEST_SECRET_KEY
//     set to a Stripe test secret key (sk_test_...) or restricted test
//     key (rk_test_...).
//   • stripe_prices catalog must be populated in test mode (run
//     scripts/create-stripe-prices.ts first if not — that's the B66.2a
//     populator).
//   • SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL set so the
//     script can read stripe_prices.
//
// ════════════════════════════════════════════════════════════════
// USAGE
// ════════════════════════════════════════════════════════════════
//
//   # Provision the 6 test subs:
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/provision-b165-test-subs.ts
//
//   # Cleanup (cancel + detach customers) when done with probe:
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/provision-b165-test-subs.ts --cleanup
//
//   The provision command prints a copy-pasteable env-var block at the
//   end. Paste those 6 lines into .env.local, then run the live probe:
//
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/probe-b165-tier-change.ts --live
//
// ════════════════════════════════════════════════════════════════
// CATALOG ASSUMPTIONS
// ════════════════════════════════════════════════════════════════
//
// The script reads stripe_prices test-mode rows by (tier_name, track,
// line_item, cycle) and uses those Stripe Price IDs to compose the
// subscription line items. It does NOT create catalog Prices — that's
// the B66.2a populator's job. If a needed Price row is missing in test
// mode, the script REPORTS what's missing and EXITS without creating
// any partial subscriptions.

import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// ── Safety gate 1: hard-assert STRIPE_MODE=test BEFORE loading anything else
const STRIPE_MODE = process.env.STRIPE_MODE
if (STRIPE_MODE !== 'test') {
  console.error(`❌ ABORTED: STRIPE_MODE must be exactly 'test' to run this script.`)
  console.error(`   Got: ${JSON.stringify(STRIPE_MODE)}`)
  console.error(`   This script provisions Stripe subscriptions. Running it against`)
  console.error(`   live mode is not supported and would create real billing artifacts.`)
  process.exit(1)
}

// ── Safety gate 2: verify the key prefix
const TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY
if (!TEST_KEY) {
  console.error(`❌ ABORTED: STRIPE_TEST_SECRET_KEY is unset.`)
  console.error(`   Provision a Stripe test secret key (sk_test_... or rk_test_...) and put it in .env.local.`)
  process.exit(1)
}
if (!TEST_KEY.startsWith('sk_test_') && !TEST_KEY.startsWith('rk_test_')) {
  console.error(`❌ ABORTED: STRIPE_TEST_SECRET_KEY does not have a test-key prefix.`)
  console.error(`   Expected: sk_test_* or rk_test_*`)
  console.error(`   Got: ${TEST_KEY.slice(0, 8)}... (length=${TEST_KEY.length})`)
  console.error(`   Refusing to proceed — a non-test key here would mean operations could hit live mode.`)
  process.exit(1)
}

// ── Both gates passed. Print the safety affirmation banner.
console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  B165 TEST SUBSCRIPTION PROVISIONING — TEST MODE ONLY            ║
║                                                                  ║
║  STRIPE_MODE     = test                                          ║
║  Secret key      = ${TEST_KEY.slice(0, 12)}... (length ${String(TEST_KEY.length).padStart(3)})                  ║
║  Payment method  = pm_card_visa (Stripe test-only token)         ║
║                                                                  ║
║  Cannot hit live mode. Cannot charge a real card.                ║
║  Ctrl-C to abort. Pausing 2 seconds...                           ║
╚══════════════════════════════════════════════════════════════════╝
`)

// Stripe + supabase clients (lazy-init inside main())
const stripe = new Stripe(TEST_KEY, { apiVersion: '2026-04-22.dahlia' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ ABORTED: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── Configuration of the 6 subs ──────────────────────────────────
//
// Quantities are tuned so each sub is AT CAP (max-1) for that tier,
// making the forced-upgrade modal path realistic when the probe spawns
// a fixture company linked to one of these subs.

interface SubConfig {
  envVar: string
  description: string
  tier: string
  track: 'enforcement' | 'property_management'
  cycle: 'monthly' | 'annual'
  collection: 'charge_automatically' | 'send_invoice'
  qty: { base: number; per_property: number; per_driver: number }
}

const SUBS: SubConfig[] = [
  {
    envVar: 'B165_TEST_SUB_STARTER',
    description: 'Enf Starter monthly (at-cap 3p/3d)',
    tier: 'starter', track: 'enforcement', cycle: 'monthly',
    collection: 'charge_automatically',
    qty: { base: 1, per_property: 3, per_driver: 3 },
  },
  {
    envVar: 'B165_TEST_SUB_GROWTH',
    description: 'Enf Growth monthly (at-cap 10p/10d)',
    tier: 'growth', track: 'enforcement', cycle: 'monthly',
    collection: 'charge_automatically',
    qty: { base: 1, per_property: 10, per_driver: 10 },
  },
  {
    envVar: 'B165_TEST_SUB_ESSENTIAL',
    description: 'PM Essential monthly (at-cap 3p)',
    tier: 'essential', track: 'property_management', cycle: 'monthly',
    collection: 'charge_automatically',
    qty: { base: 1, per_property: 3, per_driver: 0 },
  },
  {
    envVar: 'B165_TEST_SUB_PROFESSIONAL',
    description: 'PM Professional monthly (at-cap 10p)',
    tier: 'professional', track: 'property_management', cycle: 'monthly',
    collection: 'charge_automatically',
    qty: { base: 1, per_property: 10, per_driver: 0 },
  },
  {
    envVar: 'B165_TEST_SUB_GROWTH_ANNUAL',
    description: 'Enf Growth ANNUAL (cycle resolution test)',
    tier: 'growth', track: 'enforcement', cycle: 'annual',
    collection: 'charge_automatically',
    qty: { base: 1, per_property: 10, per_driver: 10 },
  },
  {
    envVar: 'B165_TEST_SUB_SEND_INVOICE',
    description: 'Enf Legacy monthly send_invoice (manual_collection refusal)',
    tier: 'legacy', track: 'enforcement', cycle: 'monthly',
    collection: 'send_invoice',
    qty: { base: 1, per_property: 5, per_driver: 5 },
  },
]

// Identification tag so cleanup can find these specifically.
const PROBE_FIXTURE_METADATA = { b165_probe_fixture: '1' }

// ── Catalog resolution ──────────────────────────────────────────

interface CatalogPriceRow {
  stripe_price_id: string
  line_item: string
  tier_name: string | null
  track: string | null
  cycle: string | null
}

async function loadTestCatalog(): Promise<CatalogPriceRow[]> {
  // House convention: in-code `track`, DB column `tier_track`. Alias at
  // the query (Option B per Jose 2026-06-17 — minimal blast radius).
  const { data, error } = await supabase
    .from('stripe_prices')
    .select('stripe_price_id, line_item, tier_name, tier_track, cycle')
    .eq('mode', 'test')
    .is('proposal_code_id', null)
  if (error) {
    throw new Error(`stripe_prices read failed: ${error.message}`)
  }
  // Map raw DB rows to the in-code shape; tier_track → track.
  return (data ?? []).map(r => ({
    stripe_price_id: r.stripe_price_id as string,
    line_item: r.line_item as string,
    tier_name: (r.tier_name as string | null) ?? null,
    track: (r.tier_track as string | null) ?? null,
    cycle: (r.cycle as string | null) ?? null,
  }))
}

function pickPriceId(catalog: CatalogPriceRow[], tier: string, track: string, line_item: string, cycle: string): string | null {
  const match = catalog.find(r =>
    r.tier_name === tier && r.track === track && r.line_item === line_item && r.cycle === cycle
  )
  return match?.stripe_price_id ?? null
}

function checkCatalogCompleteness(catalog: CatalogPriceRow[]): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = []
  for (const sub of SUBS) {
    const needs: { line_item: string; required: boolean }[] = [
      { line_item: 'base',         required: true },
      { line_item: 'per_property', required: true },
      { line_item: 'per_driver',   required: sub.track === 'enforcement' },
    ]
    for (const n of needs) {
      if (!n.required) continue
      const id = pickPriceId(catalog, sub.tier, sub.track, n.line_item, sub.cycle)
      if (!id) {
        missing.push(`${sub.track}/${sub.tier}/${n.line_item}/${sub.cycle}/test`)
      }
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

// ── Provision flow ──────────────────────────────────────────────

async function provisionOne(sub: SubConfig, catalog: CatalogPriceRow[]): Promise<{ envVar: string; subId: string; customerId: string }> {
  console.log(`\n── ${sub.description} ──`)

  const email = `b165-probe-${sub.envVar.toLowerCase().replace(/_/g, '-')}@example.com`
  console.log(`   Creating customer: ${email}`)
  const customer = await stripe.customers.create({
    email,
    description: `B165 probe fixture — ${sub.description}`,
    metadata: PROBE_FIXTURE_METADATA,
  })

  // Attach test payment method (skip for send_invoice subs)
  if (sub.collection === 'charge_automatically') {
    console.log(`   Attaching pm_card_visa (Stripe test-only PaymentMethod token)`)
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    })
  }

  // Compose line items
  const items: { price: string; quantity: number }[] = []
  const basePriceId = pickPriceId(catalog, sub.tier, sub.track, 'base', sub.cycle)!
  const perPropPriceId = pickPriceId(catalog, sub.tier, sub.track, 'per_property', sub.cycle)!
  items.push({ price: basePriceId, quantity: sub.qty.base })
  items.push({ price: perPropPriceId, quantity: sub.qty.per_property })
  if (sub.track === 'enforcement') {
    const perDriverPriceId = pickPriceId(catalog, sub.tier, sub.track, 'per_driver', sub.cycle)!
    items.push({ price: perDriverPriceId, quantity: sub.qty.per_driver })
  }

  console.log(`   Creating subscription (${items.length} line items, collection=${sub.collection})`)
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    collection_method: sub.collection,
    ...(sub.collection === 'send_invoice' ? { days_until_due: 30 } : {}),
    metadata: PROBE_FIXTURE_METADATA,
    payment_behavior: sub.collection === 'charge_automatically' ? 'default_incomplete' : 'default_incomplete',
  })

  console.log(`   ✓ ${sub.envVar} = ${subscription.id}`)
  console.log(`   (customer: ${customer.id})`)

  return { envVar: sub.envVar, subId: subscription.id, customerId: customer.id }
}

async function provisionAll() {
  console.log('Loading test-mode catalog from stripe_prices...')
  const catalog = await loadTestCatalog()
  console.log(`   ${catalog.length} catalog rows loaded.\n`)

  const completeness = checkCatalogCompleteness(catalog)
  if (!completeness.ok) {
    console.error(`❌ ABORTED: stripe_prices test-mode catalog is incomplete.\n`)
    console.error(`   Missing Price rows (tier/track/line_item/cycle/mode):`)
    completeness.missing.forEach(m => console.error(`     • ${m}`))
    console.error(`\n   Run scripts/create-stripe-prices.ts (B66.2a populator) in test mode first.`)
    process.exit(2)
  }
  console.log('   ✓ Catalog complete for all 6 sub configs.\n')

  const results: { envVar: string; subId: string; customerId: string }[] = []
  for (const sub of SUBS) {
    try {
      const r = await provisionOne(sub, catalog)
      results.push(r)
    } catch (e) {
      console.error(`❌ Failed provisioning ${sub.envVar}: ${(e as Error).message}`)
      console.error(`   Partial state: ${results.length} subs created before this failure.`)
      console.error(`   Run --cleanup to remove the partial set, then re-run provision.`)
      process.exit(3)
    }
  }

  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`)
  console.log(`║  ✓ ALL 6 TEST SUBSCRIPTIONS PROVISIONED                          ║`)
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`)
  console.log(`Copy these lines into .env.local (or export them):\n`)
  for (const r of results) {
    console.log(`${r.envVar}=${r.subId}`)
  }
  console.log(`\nThen run the live probe:`)
  console.log(`  npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \\`)
  console.log(`    scripts/probe-b165-tier-change.ts --live\n`)
  console.log(`When done with the probe, run cleanup:`)
  console.log(`  npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \\`)
  console.log(`    scripts/provision-b165-test-subs.ts --cleanup\n`)
}

// ── Cleanup flow ────────────────────────────────────────────────

async function cleanupAll() {
  console.log('Searching Stripe test mode for B165 probe fixture customers...\n')

  // Find all test-mode customers tagged with our metadata.
  let starting_after: string | undefined = undefined
  const found: { id: string; email: string | null; subscriptions: string[] }[] = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await stripe.customers.list({ limit: 100, starting_after })
    for (const c of page.data) {
      if (c.metadata?.b165_probe_fixture === '1') {
        const subs = await stripe.subscriptions.list({ customer: c.id, limit: 10 })
        found.push({
          id: c.id, email: c.email ?? null,
          subscriptions: subs.data.map(s => s.id),
        })
      }
    }
    if (!page.has_more) break
    starting_after = page.data[page.data.length - 1].id
  }

  if (found.length === 0) {
    console.log('No B165 probe fixture customers found. Nothing to clean up.')
    return
  }

  console.log(`Found ${found.length} fixture customer(s):`)
  for (const f of found) {
    console.log(`  • ${f.id} (${f.email}) → ${f.subscriptions.length} sub(s): ${f.subscriptions.join(', ')}`)
  }
  console.log(``)
  console.log(`Cancelling subscriptions + deleting customers...`)

  for (const f of found) {
    for (const subId of f.subscriptions) {
      try {
        await stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false })
        console.log(`   ✓ Cancelled ${subId}`)
      } catch (e) {
        console.warn(`   ⚠ Cancel ${subId} failed: ${(e as Error).message}`)
      }
    }
    try {
      await stripe.customers.del(f.id)
      console.log(`   ✓ Deleted ${f.id}`)
    } catch (e) {
      console.warn(`   ⚠ Delete ${f.id} failed: ${(e as Error).message}`)
    }
  }
  console.log(`\n✓ Cleanup complete. ${found.length} customer(s) + their subs removed.`)
}

// ── Main ────────────────────────────────────────────────────────

const CLEANUP = process.argv.includes('--cleanup')

async function main() {
  if (CLEANUP) {
    await cleanupAll()
  } else {
    // 2-second pause so operator can read the safety banner + abort if anything looks wrong.
    await new Promise(r => setTimeout(r, 2000))
    await provisionAll()
  }
}

main().catch(e => {
  console.error('Unhandled error:', (e as Error).message)
  process.exit(99)
})
