// B66.2a commit 2 — Stripe Price catalog population script.
//
// Populates the stripe_prices table (commit 1 / migration
// 20260530_b66_2a_stripe_prices_table.sql) by creating 30 Stripe Price
// objects, backed by 15 Products (Pattern B from B66 architecture doc:
// one Product per (tier × line_item), with monthly + annual Prices
// sharing the Product).
//
// ── CATALOG DIMENSIONS (30 rows) ────────────────────────────────────
//   Enforcement (3 tiers × 3 line_items × 2 cycles = 18):
//     starter / growth / legacy  ×  base / per_property / per_driver
//                                ×  monthly / annual
//   Property management (3 tiers × 2 line_items × 2 cycles = 12):
//     essential / professional / enterprise  ×  base / per_property
//                                            ×  monthly / annual
//   No per_driver on the PM track (Cluster 2.1 invariant; schema CHECK
//   stripe_prices_driver_enforcement_only also enforces).
//   'premium' tier is intentionally excluded (Enforcement Premium is
//   contact-sales per B89; redeemed via proposal_codes path, not the
//   standard catalog).
//
// ── PRICING SOURCE ──────────────────────────────────────────────────
//   Monthly dollar amounts read from platform_settings row id=1 (the
//   admin Pricing tab is the canonical editor). Annual cents = monthly
//   dollars × 10 × 100 (≈17% discount, matching admin Bill Calculator
//   at admin/page.tsx:1660 and the customer-facing claim in
//   docs/help/02-account-setup.md).
//
// ── IDEMPOTENCY (safe to re-run) ────────────────────────────────────
//   1. DB layer: composite UNIQUE (tier_track, tier_name, line_item,
//      cycle, mode) blocks duplicate rows. A pre-existing DB row → SKIP.
//   2. Stripe layer: probe by lookup_key sml.<track>.<tier>.<line_item>.<cycle>
//      before creating. Existing active Price → RECOVER its ID into DB.
//   3. Product layer: when creating a new Price, check the sibling
//      cycle's Price for product.id reuse so monthly + annual stay
//      paired on the same Product. If neither exists, create a new
//      Product with deterministic metadata.
//
// ── FINAL REPORT ────────────────────────────────────────────────────
//   created:   net-new Stripe Price (and DB row)
//   recovered: Stripe Price already existed (by lookup_key); DB row inserted
//   skipped:   DB row already existed; no Stripe call made
//
// ── USAGE ───────────────────────────────────────────────────────────
//   export STRIPE_MODE=test            # required: 'test' or 'live'
//   export STRIPE_TEST_SECRET_KEY=sk_test_...
//   # OR for live: export STRIPE_LIVE_SECRET_KEY=sk_live_...
//   export NEXT_PUBLIC_SUPABASE_URL=...
//   export SUPABASE_SERVICE_ROLE_KEY=...
//   npx tsx scripts/create-stripe-prices.ts
//
//   Env var names match app/lib/stripe.ts (B66.1) — single source of
//   truth for Stripe key resolution. The script refuses to start if
//   STRIPE_MODE is unset or not 'test'/'live' (fails-closed; no default).
//
// ── SCOPE GUARDS ────────────────────────────────────────────────────
//   • No production code paths read stripe_prices yet — this is catalog
//     population only. B66.3+ adds consumer logic.
//   • Sandbox only at this stage. Live mode runs are deferred to ~2 weeks
//     pre-launch; the script supports STRIPE_MODE=live but operationally
//     should not be run there yet.
//   • No standalone 'server-only' imports — this is a Node CLI; the
//     server-only guard at app/lib/stripe.ts + app/lib/supabase-admin.ts
//     would fail outside Next runtime. Init logic is inlined here and
//     mirrors the lib intentionally.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// ── Types ────────────────────────────────────────────────────────────
type Track = 'enforcement' | 'property_management'
type TierName =
  | 'starter' | 'growth' | 'legacy'
  | 'essential' | 'professional' | 'enterprise'
type LineItem = 'base' | 'per_property' | 'per_driver'
type Cycle = 'monthly' | 'annual'
type Mode = 'test' | 'live'

interface LogicalAddress {
  tier_track: Track
  tier_name: TierName
  line_item: LineItem
  cycle: Cycle
}

// ── Constants ────────────────────────────────────────────────────────
// Pinned to match app/lib/stripe.ts (B66.1). Don't float; drift risk.
const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

// Annual = monthly × ANNUAL_MULTIPLIER (matches admin Bill Calculator
// at admin/page.tsx:1660). 10 → ~17% discount vs. paying monthly × 12.
const ANNUAL_MULTIPLIER = 10

// ── Env resolution ───────────────────────────────────────────────────
function resolveMode(): Mode {
  const raw = process.env.STRIPE_MODE
  if (raw !== 'test' && raw !== 'live') {
    console.error(
      `[create-stripe-prices] STRIPE_MODE must be 'test' or 'live' (got: ${JSON.stringify(raw)}). ` +
      `Refusing to start — fails-closed by design.`
    )
    process.exit(1)
  }
  return raw
}

function resolveStripeKey(mode: Mode): string {
  const varName = mode === 'test' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'
  const key = process.env[varName]
  if (!key) {
    console.error(`[create-stripe-prices] Missing ${varName} for STRIPE_MODE='${mode}'.`)
    process.exit(1)
  }
  return key
}

function resolveSupabase(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) {
    console.error('[create-stripe-prices] Missing NEXT_PUBLIC_SUPABASE_URL.')
    process.exit(1)
  }
  if (!key) {
    console.error('[create-stripe-prices] Missing SUPABASE_SERVICE_ROLE_KEY (required to bypass RLS on stripe_prices INSERT).')
    process.exit(1)
  }
  return { url, key }
}

// ── Catalog construction ────────────────────────────────────────────
function buildAddresses(): LogicalAddress[] {
  const addrs: LogicalAddress[] = []
  const ENF_TIERS: TierName[] = ['starter', 'growth', 'legacy']
  const ENF_LINE_ITEMS: LineItem[] = ['base', 'per_property', 'per_driver']
  const PM_TIERS: TierName[] = ['essential', 'professional', 'enterprise']
  const PM_LINE_ITEMS: LineItem[] = ['base', 'per_property']
  const CYCLES: Cycle[] = ['monthly', 'annual']

  for (const tier of ENF_TIERS) {
    for (const li of ENF_LINE_ITEMS) {
      for (const c of CYCLES) {
        addrs.push({ tier_track: 'enforcement', tier_name: tier, line_item: li, cycle: c })
      }
    }
  }
  for (const tier of PM_TIERS) {
    for (const li of PM_LINE_ITEMS) {
      for (const c of CYCLES) {
        addrs.push({ tier_track: 'property_management', tier_name: tier, line_item: li, cycle: c })
      }
    }
  }
  return addrs
}

// B66.9: bump to v2 — new Prices carry `tax_behavior='exclusive'` so
// the TX Sales Tax Rate (created via scripts/create-stripe-tax-rate.ts)
// can be attached via Checkout's default_tax_rates and rendered as a
// separate line on customer invoices (subtotal + tax line + total).
// Old v1 Prices (no tax_behavior set) are archived per Q2 lock —
// existing B66.5 test subscriptions continue referencing them; new
// checkouts use v2. Bump to v3+ in the future if Price contract
// changes again (currency, billing scheme, etc.).
const PRICE_LOOKUP_VERSION = 'v2'

function formatLookupKey(a: LogicalAddress): string {
  return `sml.${a.tier_track}.${a.tier_name}.${a.line_item}.${a.cycle}.${PRICE_LOOKUP_VERSION}`
}

function formatProductName(a: LogicalAddress): string {
  const trackLabel = a.tier_track === 'enforcement' ? 'Enforcement' : 'Property Management'
  const tierLabel = a.tier_name.charAt(0).toUpperCase() + a.tier_name.slice(1)
  const liLabel = a.line_item === 'base'
    ? 'Base'
    : a.line_item === 'per_property'
      ? 'Per Property'
      : 'Per Driver'
  return `ShieldMyLot ${trackLabel} ${tierLabel} — ${liLabel}`
}

// Maps an address to its platform_settings column name. Returns the
// monthly dollar amount column; annual is derived (× ANNUAL_MULTIPLIER).
function platformSettingsColumn(a: LogicalAddress): string {
  if (a.tier_track === 'enforcement') {
    return `price_${a.tier_name}_${a.line_item}`
  }
  // PM columns are prefixed with `price_pm_` and exclude per_driver.
  return `price_pm_${a.tier_name}_${a.line_item}`
}

// Pattern A — idempotent tax_code backfill on a Product.
// Reads the current Product's tax_code; updates iff missing or
// different from the target. Verifies-after-write per B66.5 F6: the
// post-update retrieve asserts the field landed, so a silent drop
// by Stripe surfaces immediately rather than at first transaction.
//
// Safe to call on Products that already have the correct tax_code —
// a leading retrieve avoids a no-op update call.
async function ensureProductTaxCode(
  stripe: Stripe,
  productId: string,
  targetTaxCode: string,
): Promise<void> {
  const before = await stripe.products.retrieve(productId)
  const beforeTaxCode = typeof before.tax_code === 'string' ? before.tax_code : before.tax_code?.id ?? null
  if (beforeTaxCode === targetTaxCode) return
  await stripe.products.update(productId, { tax_code: targetTaxCode })
  const after = await stripe.products.retrieve(productId)
  const afterTaxCode = typeof after.tax_code === 'string' ? after.tax_code : after.tax_code?.id ?? null
  if (afterTaxCode !== targetTaxCode) {
    throw new Error(
      `Product ${productId} tax_code verify-after-write mismatch — set "${targetTaxCode}", retrieved "${afterTaxCode}"`,
    )
  }
}

function unitAmountCents(monthlyDollars: number, cycle: Cycle): number {
  const dollars = cycle === 'monthly' ? monthlyDollars : monthlyDollars * ANNUAL_MULTIPLIER
  return Math.round(dollars * 100)
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const mode = resolveMode()
  const stripeKey = resolveStripeKey(mode)
  const { url, key } = resolveSupabase()

  const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION })
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  console.log(`[create-stripe-prices] mode=${mode}`)
  console.log(`[create-stripe-prices] Stripe API version=${STRIPE_API_VERSION}`)
  console.log(`[create-stripe-prices] Annual multiplier=${ANNUAL_MULTIPLIER}x monthly`)

  // Read canonical monthly pricing from platform_settings.
  const { data: ps, error: psErr } = await supabase
    .from('platform_settings')
    .select('*')
    .eq('id', 1)
    .single()
  if (psErr || !ps) {
    console.error('[create-stripe-prices] Failed to read platform_settings row id=1:', psErr?.message || 'not found')
    process.exit(1)
  }

  const addresses = buildAddresses()
  if (addresses.length !== 30) {
    console.error(`[create-stripe-prices] Internal error: built ${addresses.length} addresses, expected 30.`)
    process.exit(1)
  }

  let created = 0
  let recovered = 0
  let skipped = 0

  // Within-run Product ID cache so the second cycle of a (track, tier,
  // line_item) group reuses the Product without an extra Stripe roundtrip.
  const productIdByGroup = new Map<string, string>()

  for (const addr of addresses) {
    const lookupKey = formatLookupKey(addr)
    const groupKey = `${addr.tier_track}.${addr.tier_name}.${addr.line_item}`

    const colName = platformSettingsColumn(addr)
    const rawMonthly = ps[colName as keyof typeof ps]
    const monthlyDollars = Number(rawMonthly)
    if (!Number.isFinite(monthlyDollars) || monthlyDollars <= 0) {
      console.error(`[create-stripe-prices] platform_settings.${colName} is invalid: ${JSON.stringify(rawMonthly)}`)
      process.exit(1)
    }
    const amountCents = unitAmountCents(monthlyDollars, addr.cycle)

    // 1. DB existence probe — composite UNIQUE is the script's idempotency key.
    // B66.9: SELECT widened to pull lookup_key so we can distinguish:
    //   • DB row's lookup_key === target (v2)  → true skip (no migration)
    //   • DB row's lookup_key !== target       → migration path (UPDATE in
    //                                            place with new v2 ID, archive
    //                                            old Price)
    //   • No DB row                            → fresh INSERT (original path)
    const { data: existing, error: selErr } = await supabase
      .from('stripe_prices')
      .select('id, stripe_price_id, lookup_key')
      .eq('tier_track', addr.tier_track)
      .eq('tier_name', addr.tier_name)
      .eq('line_item', addr.line_item)
      .eq('cycle', addr.cycle)
      .eq('mode', mode)
      .maybeSingle()
    if (selErr) {
      console.error(`[create-stripe-prices] DB select failed for ${lookupKey}: ${selErr.message}`)
      process.exit(1)
    }
    if (existing && existing.lookup_key === lookupKey) {
      skipped++
      console.log(`  SKIP    ${lookupKey} (DB row id=${existing.id}, price=${existing.stripe_price_id})`)
      continue
    }
    const isMigration = existing !== null
    const oldStripePriceId = existing?.stripe_price_id as string | undefined
    if (isMigration) {
      console.log(`  MIGRATE ${lookupKey} (from ${existing.lookup_key}, archiving old price ${oldStripePriceId})`)
    }

    // 2. Stripe lookup_key probe (active Prices only — deactivated Prices
    //    free up their lookup_key, and we want to treat them as gone).
    let stripePriceId: string
    let stripeProductId: string
    let action: 'create' | 'recover'

    const probe = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true })
    if (probe.data.length > 0) {
      const p = probe.data[0]
      stripePriceId = p.id
      stripeProductId = typeof p.product === 'string' ? p.product : p.product.id
      action = 'recover'
      recovered++
      // Pattern A backfill — recovered Products predate the tax_code
      // wiring (created at B66.2a ship before B110 close-out). Stamp
      // the SaaS tax_code idempotently. Same call as the create path
      // below; no-op when already set.
      await ensureProductTaxCode(stripe, stripeProductId, 'txcd_10103001')
      // Cache the Product for the sibling cycle.
      productIdByGroup.set(groupKey, stripeProductId)
    } else {
      // 3. Resolve Product: reuse from sibling cycle if it exists, else create.
      let productId = productIdByGroup.get(groupKey)
      if (!productId) {
        const oppositeCycle: Cycle = addr.cycle === 'monthly' ? 'annual' : 'monthly'
        const siblingKey = formatLookupKey({ ...addr, cycle: oppositeCycle })
        const sibProbe = await stripe.prices.list({ lookup_keys: [siblingKey], limit: 1, active: true })
        if (sibProbe.data.length > 0) {
          const sp = sibProbe.data[0]
          productId = typeof sp.product === 'string' ? sp.product : sp.product.id
        } else {
          const product = await stripe.products.create({
            name: formatProductName(addr),
            // Pattern A — Stripe Tax (B110 close-out): tax_code drives
            // automatic_tax jurisdiction-aware computation. SaaS in TX
            // = txcd_10103001 (Software as a Service); Stripe's tax
            // engine reads this + customer billing address and applies
            // the TX Rule 3.330 80%-basis automatically. Same tax_code
            // for all 15 SaaS Products + every proposal-code Price
            // (proposal-code Prices REUSE these Products via
            // proposal-code-stripe.ts:234-258, so the tax_code
            // propagates by inheritance — no parallel set needed there).
            tax_code: 'txcd_10103001',
            metadata: {
              tier_track: addr.tier_track,
              tier_name: addr.tier_name,
              line_item: addr.line_item,
              sml_group: groupKey,
            },
          })
          productId = product.id
        }
        // Idempotent tax_code backfill for Products discovered via
        // recovery or sibling-reuse (which didn't go through the
        // .create above). On re-run after the Pattern A swap, every
        // catalog row's Product gets the SaaS tax_code stamped.
        // Verify-after-write per B66.5 F6 discipline: retrieve back
        // and assert the field landed.
        await ensureProductTaxCode(stripe, productId, 'txcd_10103001')
        productIdByGroup.set(groupKey, productId)
      }

      // 4. Create the Price. B66.9: tax_behavior='exclusive' so the TX
      //    Sales Tax Rate (default_tax_rates on Checkout) renders as a
      //    separate line on customer invoices. tax_behavior is immutable
      //    post-creation; setting it here means new Prices carry the
      //    correct semantic from birth (no later patching possible).
      const price = await stripe.prices.create({
        product: productId,
        unit_amount: amountCents,
        currency: 'usd',
        recurring: { interval: addr.cycle === 'monthly' ? 'month' : 'year' },
        lookup_key: lookupKey,
        tax_behavior: 'exclusive',
        metadata: {
          tier_track: addr.tier_track,
          tier_name: addr.tier_name,
          line_item: addr.line_item,
          cycle: addr.cycle,
          lookup_version: PRICE_LOOKUP_VERSION,
        },
      })
      stripePriceId = price.id
      stripeProductId = productId
      action = 'create'
      created++
    }

    // 5. DB write — INSERT for fresh rows, UPDATE for v1→v2 migration.
    //    Composite UNIQUE blocks duplicate INSERTs (tier_track, tier_name,
    //    line_item, cycle, mode). For migration we UPDATE the row in place
    //    to replace v1 stripe_price_id + lookup_key with v2 values.
    if (isMigration) {
      const { error: updErr } = await supabase
        .from('stripe_prices')
        .update({
          stripe_price_id: stripePriceId,
          stripe_product_id: stripeProductId,
          lookup_key: lookupKey,
          unit_amount_cents: amountCents,
        })
        .eq('id', existing!.id)
      if (updErr) {
        console.error(`[create-stripe-prices] DB update failed for ${lookupKey}: ${updErr.message}`)
        console.error(`  Stripe Price ${stripePriceId} was ${action === 'create' ? 'created' : 'recovered'} but DB row not updated.`)
        console.error(`  Re-run the script to re-attempt migration.`)
        process.exit(1)
      }

      // Archive the old v1 Price per Q2 lock ("Old Prices archived, not
      // deleted"). Existing test subscriptions continue referencing the
      // archived Price (Stripe-side); new checkouts use the v2 ID we just
      // wrote to DB. Non-fatal on archival failure — DB is the source of
      // truth for "which Price do new checkouts use"; an unarchived old
      // Price is just clutter, not a correctness issue.
      if (oldStripePriceId && oldStripePriceId !== stripePriceId) {
        try {
          await stripe.prices.update(oldStripePriceId, { active: false })
          console.log(`  ARCHIVE old price ${oldStripePriceId} (active=false)`)
        } catch (e) {
          console.error(`  WARN: failed to archive old price ${oldStripePriceId}: ${(e as Error).message}`)
        }
      }
    } else {
      const { error: insErr } = await supabase
        .from('stripe_prices')
        .insert({
          stripe_price_id: stripePriceId,
          stripe_product_id: stripeProductId,
          tier_track: addr.tier_track,
          tier_name: addr.tier_name,
          line_item: addr.line_item,
          cycle: addr.cycle,
          unit_amount_cents: amountCents,
          mode,
          lookup_key: lookupKey,
          is_active: true,
        })
      if (insErr) {
        console.error(`[create-stripe-prices] DB insert failed for ${lookupKey}: ${insErr.message}`)
        console.error(`  Stripe Price ${stripePriceId} was ${action === 'create' ? 'created' : 'recovered'} but DB row missing.`)
        console.error(`  Re-run the script to recover via the lookup_key probe.`)
        process.exit(1)
      }
    }

    const tag = action === 'create' ? 'CREATE ' : 'RECOVER'
    console.log(`  ${tag} ${lookupKey} (${stripePriceId}, ${amountCents}¢, prod=${stripeProductId})`)
  }

  const total = created + recovered + skipped
  console.log('')
  console.log(`[create-stripe-prices] Done. mode=${mode}`)
  console.log(`  created:   ${created}`)
  console.log(`  recovered: ${recovered}`)
  console.log(`  skipped:   ${skipped}`)
  console.log(`  total:     ${total} (expected 30)`)

  if (total !== 30) {
    console.error('[create-stripe-prices] Total != 30 — investigate before treating catalog as complete.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[create-stripe-prices] Fatal:', err)
  process.exit(1)
})
