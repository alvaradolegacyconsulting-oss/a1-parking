// Billing Slice 1 Commit 3 — Stripe Price catalog population script
//
// Rebuilds the standard catalog from the new 3-tier + per-permit-graduated
// model (June 24 pricing pivot). Replaces the old 30/15 6-tier flat
// catalog (B66.2a, lookup_key v1; B66.9, lookup_key v2 — tax_behavior
// added). The old Stripe objects still exist in the test account
// (orphaned post-Commit 1 stripe_prices clear); see commit 3's §2 for
// the archive decision (deferred until after this run).
//
// NEW BUILD MATRIX (10 prices / 5 products):
//   PM-Only (track=property_management, tier_name=pm_only):
//     base         flat       × monthly + annual  = 2
//     per_property flat       × monthly + annual  = 2
//     per_permit   GRADUATED  × monthly + annual  = 2
//     = 6 prices on 3 products
//   Enforcement-Only (track=enforcement, tier_name=enforcement_only):
//     base         flat       × monthly + annual  = 2
//     per_property flat       × monthly + annual  = 2
//     = 4 prices on 2 products
//   Legacy: ZERO standard rows (negotiated-only via proposal-code path)
//   ─────────────────────────────────────────────────────────────────
//   Total: 10 Prices / 5 Products (Pattern B — monthly+annual share Product)
//
// THE GRADUATED PATH (per_permit only):
//   Stripe Price with billing_scheme:'tiered', tiers_mode:'graduated',
//   tiers[] built from platform_settings.permit_tiers JSONB. Each band:
//     { up_to: <n | 'inf'>, unit_amount: <rate_cents [× 10 if annual]> }
//   Annual graduated: tier thresholds (up_to) UNCHANGED — those are
//   per-permit-count buckets, not time-scaled. Per-tier unit_amount
//   gets × ANNUAL_MULTIPLIER like flat prices do.
//   DB write: price_model='graduated', unit_amount_cents=NULL,
//   tiers=<the AS-SENT JSONB> (Stripe's terminology + cents). Stored
//   for audit — the DB row reflects what's at Stripe, no recomputation
//   needed to verify.
//
// UNIT CONVENTION (locked, slice 1):
//   - platform_settings flat scalar columns store INTEGER DOLLARS
//     (price_pm_only_base etc. as NUMERIC). Multiplied × 100 here →
//     cents to Stripe.
//   - platform_settings.permit_tiers JSONB inner-band rates use
//     rate_cents (integer). Already in cents — no multiply for monthly;
//     × ANNUAL_MULTIPLIER for annual.
//   - stripe_prices.tiers JSONB uses Stripe's term `unit_amount`
//     (cents) so the DB row is naming-parity with the Stripe API.
//     Slight deliberate divergence from platform_settings.permit_tiers'
//     `rate_cents` — different audiences (admin-edited vs script-
//     written) make naming-by-source preferable to forced uniformity.
//
// LOOKUP KEY VERSION BUMP: v2 → v3.
//   The stripe_prices table was cleared in commit 1 so no DB collision
//   risk, but old v2 Stripe objects may still hold their v2 keys —
//   bumping to v3 ensures new keys don't collide. Convention unchanged:
//     sml.<track>.<tier>.<line_item>.<cycle>.v3
//
// HISTORY (preserved for context):
//   v1 (B66.2a, 2026-05-22): initial 30/15 catalog, no tax_behavior.
//   v2 (B66.9, 2026-05-XX):  tax_behavior='exclusive' added so TX
//                            Sales Tax Rate renders separately on
//                            invoices. tax_behavior is immutable post-
//                            creation; v2 swap was the only way.
//   v3 (Slice 1 Commit 3, 2026-06-26): full model rebuild. 6-tier flat
//     → 3-tier + per-permit graduated. per_driver retired from
//     creation (kept as a valid line_item value for back-compat per
//     commit 1 CHECK, but no new rows). Legacy negotiated-only.
//
// IDEMPOTENCY (preserved from v1/v2):
//   1. DB existence probe (composite UNIQUE: tier_track, tier_name,
//      line_item, cycle, mode WHERE proposal_code_id IS NULL).
//   2. If DB row exists with matching lookup_key → SKIP.
//   3. If DB row exists with different lookup_key (legacy migration
//      path; won't trigger on empty post-commit-1 DB but kept defensive)
//      → UPDATE in place + archive old Stripe Price.
//   4. If no DB row → probe Stripe by lookup_key (active only); RECOVER
//      if found, CREATE if not.
//
// ENV (read at startup, fail-closed):
//   STRIPE_MODE              — 'test' | 'live' (exact match; resolveMode)
//   STRIPE_TEST_SECRET_KEY   (when mode=test) OR
//   STRIPE_LIVE_SECRET_KEY   (when mode=live)
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY (REQUIRED — script writes stripe_prices
//                              under service-role; bypasses RLS)
//
// Run:
//   STRIPE_MODE=test npx tsx scripts/create-stripe-prices.ts
//
// Verification post-run:
//   SELECT tier_track, tier_name, line_item, cycle, price_model,
//          unit_amount_cents, (tiers IS NOT NULL) AS has_tiers
//     FROM public.stripe_prices
//    WHERE proposal_code_id IS NULL AND mode='test'
//    ORDER BY tier_track, tier_name, line_item, cycle;
//   -- Expect 10 rows: 6 pm_only (2 per_permit = graduated, has_tiers=true,
//   --                            unit_amount_cents=NULL),
//   --                 4 enforcement_only (all flat).
//
//   SELECT COUNT(*) FROM public.stripe_prices
//    WHERE line_item='per_permit' AND tier_track='enforcement';
//   -- Expect 0 (commit 1 CHECK enforces; sanity).
//
// Notes on the existing implementation we preserve:
//   • Pattern A (B110 close-out) — tax_code='txcd_10103001' stamped on
//     every Product (SaaS in TX; Stripe Tax handles TX Rule 3.330 80%
//     basis automatically once + customer billing address set).
//     ensureProductTaxCode() is verify-after-write per B66.5 F6.
//   • No standalone 'server-only' imports — this is a Node CLI; the
//     server-only guard at app/lib/stripe.ts + app/lib/supabase-admin.ts
//     would fail outside Next runtime. Init logic is inlined here and
//     mirrors the lib intentionally.
//   • SaaS in TX = txcd_10103001 for all 5 NEW Products (same as v1/v2).

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// ── Types ────────────────────────────────────────────────────────────
type Track = 'enforcement' | 'property_management'
// Slice 1 Commit 1 tightened the DB CHECK to these 3 values; commit 3
// only creates standard rows for the 2 self-serve tiers. Legacy is
// proposal-code-only.
type TierName = 'pm_only' | 'enforcement_only' | 'legacy'
// Slice 1 Commit 1 added 'per_permit'; 'per_driver' kept VALID for
// back-compat but commit 3 creates ZERO new per_driver rows.
type LineItem = 'base' | 'per_property' | 'per_driver' | 'per_permit'
type Cycle = 'monthly' | 'annual'
type Mode = 'test' | 'live'

interface LogicalAddress {
  tier_track: Track
  tier_name: TierName
  line_item: LineItem
  cycle: Cycle
}

// Source shape from platform_settings.permit_tiers (rate_cents).
interface SourcePermitTier { up_to: number | null; rate_cents: number }
// As-sent shape to Stripe + stored in stripe_prices.tiers (unit_amount).
interface WirePermitTier { up_to: number | null; unit_amount: number }

// ── Constants ────────────────────────────────────────────────────────
// Pinned to match app/lib/stripe.ts (B66.1). Don't float; drift risk.
const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

// Annual = monthly × ANNUAL_MULTIPLIER (matches admin Bill Calculator
// at admin/page.tsx). 10 → ~17% discount vs. paying monthly × 12.
// Applies to flat AND per-tier unit_amount in graduated prices.
const ANNUAL_MULTIPLIER = 10

// Slice 1 Commit 3 — bumped from v2 to v3 for the model rebuild.
// Old v2 Stripe objects (orphaned in test account post-commit-1 DB
// clear) keep their v2 keys; v3 new objects don't collide.
const PRICE_LOOKUP_VERSION = 'v3'

// SaaS tax_code for TX Rule 3.330 80% basis (B110 close-out). All 5
// new Products get this stamped (same value used in v1/v2).
const SAAS_TAX_CODE = 'txcd_10103001'

// ── Env resolution (fail-closed) ─────────────────────────────────────
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
// Slice 1 Commit 3 — 10 addresses total. PM-Only has 3 line_items;
// Enforcement-Only has 2 (no per_permit per commit 1's permit_pm_only
// CHECK constraint). Legacy excluded — negotiated-only.
function buildAddresses(): LogicalAddress[] {
  const addrs: LogicalAddress[] = []
  const PM_LINE_ITEMS: LineItem[] = ['base', 'per_property', 'per_permit']
  const ENF_LINE_ITEMS: LineItem[] = ['base', 'per_property']
  const CYCLES: Cycle[] = ['monthly', 'annual']

  for (const li of PM_LINE_ITEMS) {
    for (const c of CYCLES) {
      addrs.push({ tier_track: 'property_management', tier_name: 'pm_only', line_item: li, cycle: c })
    }
  }
  for (const li of ENF_LINE_ITEMS) {
    for (const c of CYCLES) {
      addrs.push({ tier_track: 'enforcement', tier_name: 'enforcement_only', line_item: li, cycle: c })
    }
  }
  return addrs
}

function formatLookupKey(a: LogicalAddress): string {
  return `sml.${a.tier_track}.${a.tier_name}.${a.line_item}.${a.cycle}.${PRICE_LOOKUP_VERSION}`
}

function formatProductName(a: LogicalAddress): string {
  const trackLabel = a.tier_track === 'property_management' ? 'PM-Only' : 'Enforcement-Only'
  const liLabel = a.line_item === 'base' ? 'Base'
              : a.line_item === 'per_property' ? 'Per-Property'
              : a.line_item === 'per_permit' ? 'Per-Permit (Graduated)'
              : 'Per-Driver'   // unreachable in v3 build but keeps the type total
  return `ShieldMyLot ${trackLabel} — ${liLabel}`
}

// FLAT line items only. Maps (track, tier_name, line_item) → the
// platform_settings dollar column. Per-permit reads permit_tiers JSONB
// instead — handled in main() outside this function.
function flatPriceColumn(a: LogicalAddress): string {
  if (a.tier_track === 'property_management' && a.tier_name === 'pm_only') {
    if (a.line_item === 'base') return 'price_pm_only_base'
    if (a.line_item === 'per_property') return 'price_pm_only_per_property'
  }
  if (a.tier_track === 'enforcement' && a.tier_name === 'enforcement_only') {
    if (a.line_item === 'base') return 'price_enforcement_only_base'
    if (a.line_item === 'per_property') return 'price_enforcement_only_per_property'
  }
  throw new Error(`[create-stripe-prices] flatPriceColumn: no mapping for ${JSON.stringify(a)} — this is a build-matrix bug, not a config issue.`)
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

// FLAT helper — unchanged from v1/v2.
function unitAmountCents(monthlyDollars: number, cycle: Cycle): number {
  const dollars = cycle === 'monthly' ? monthlyDollars : monthlyDollars * ANNUAL_MULTIPLIER
  return Math.round(dollars * 100)
}

// GRADUATED helper — Slice 1 Commit 3.
// Takes platform_settings.permit_tiers (source: rate_cents) and a
// cycle; returns the AS-SENT array we both send Stripe and store in
// stripe_prices.tiers. Annual gets each band's unit_amount × ANNUAL_
// MULTIPLIER; up_to thresholds are UNCHANGED (per-permit-count
// buckets, not time-scaled).
//
// Validation: ascending up_to, exactly one trailing null up_to, all
// rate_cents > 0. Same rules as the admin Pricing tab's
// validatePermitTiers() — duplicated here so the script can fail-
// closed if platform_settings somehow got malformed JSONB past the
// UI (defense in depth).
function graduatedTiers(source: SourcePermitTier[], cycle: Cycle): WirePermitTier[] {
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error(`[create-stripe-prices] permit_tiers is empty or not an array — cannot build graduated price.`)
  }
  for (let i = 0; i < source.length - 1; i++) {
    if (source[i].up_to == null) {
      throw new Error(`[create-stripe-prices] permit_tiers band ${i + 1}: only the LAST band may have up_to=null.`)
    }
    if (!(source[i].up_to! > 0)) {
      throw new Error(`[create-stripe-prices] permit_tiers band ${i + 1}: up_to must be > 0.`)
    }
    if (i > 0 && source[i].up_to! <= source[i - 1].up_to!) {
      throw new Error(`[create-stripe-prices] permit_tiers band ${i + 1}: up_to (${source[i].up_to}) must be > previous (${source[i - 1].up_to}).`)
    }
  }
  if (source[source.length - 1].up_to !== null) {
    throw new Error(`[create-stripe-prices] permit_tiers last band must have up_to=null (covers permits above the last bounded up_to).`)
  }
  for (let i = 0; i < source.length; i++) {
    if (!(source[i].rate_cents > 0)) {
      throw new Error(`[create-stripe-prices] permit_tiers band ${i + 1}: rate_cents must be > 0.`)
    }
  }
  const multiplier = cycle === 'monthly' ? 1 : ANNUAL_MULTIPLIER
  return source.map(b => ({
    up_to: b.up_to,
    unit_amount: Math.round(b.rate_cents * multiplier),
  }))
}

// Convert our WirePermitTier shape to Stripe's CreatePriceTier shape.
// Stripe's API uses 'inf' (string literal) for the unbounded band; we
// store null in DB for readability and convert at the API boundary only.
function wireTiersToStripeShape(wire: WirePermitTier[]): Stripe.PriceCreateParams.Tier[] {
  return wire.map(b => ({
    up_to: b.up_to === null ? 'inf' : b.up_to,
    unit_amount: b.unit_amount,
  }))
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
  console.log(`[create-stripe-prices] Lookup key version=${PRICE_LOOKUP_VERSION}`)

  // Read canonical monthly pricing + permit_tiers from platform_settings.
  const { data: ps, error: psErr } = await supabase
    .from('platform_settings')
    .select('*')
    .eq('id', 1)
    .single()
  if (psErr || !ps) {
    console.error('[create-stripe-prices] Failed to read platform_settings row id=1:', psErr?.message || 'not found')
    process.exit(1)
  }

  // Validate permit_tiers ONCE upfront (the same JSONB feeds both
  // monthly + annual graduated rows; bad shape fails before any
  // Stripe call).
  const permitTiersSource = (ps.permit_tiers ?? []) as SourcePermitTier[]
  // graduatedTiers() throws on malformed shape; do a dry monthly call
  // here so the failure happens at startup, not mid-loop.
  try {
    graduatedTiers(permitTiersSource, 'monthly')
  } catch (e) {
    console.error(`[create-stripe-prices] permit_tiers validation failed: ${(e as Error).message}`)
    console.error(`  Fix via admin Pricing tab → Save All Pricing (validates before writing JSONB).`)
    process.exit(1)
  }

  const addresses = buildAddresses()
  const EXPECTED_TOTAL = 10
  if (addresses.length !== EXPECTED_TOTAL) {
    console.error(`[create-stripe-prices] Internal error: built ${addresses.length} addresses, expected ${EXPECTED_TOTAL}.`)
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
    const isGraduated = addr.line_item === 'per_permit'

    // Resolve the price input — FLAT path reads a dollar column;
    // GRADUATED path uses the validated permit_tiers JSONB.
    let amountCentsForDb: number | null = null
    let wireTiersForDb: WirePermitTier[] | null = null
    if (isGraduated) {
      // Already validated upfront; re-call returns the cycle-correct array.
      wireTiersForDb = graduatedTiers(permitTiersSource, addr.cycle)
    } else {
      const colName = flatPriceColumn(addr)
      const rawMonthly = ps[colName as keyof typeof ps]
      const monthlyDollars = Number(rawMonthly)
      if (!Number.isFinite(monthlyDollars) || monthlyDollars <= 0) {
        console.error(`[create-stripe-prices] platform_settings.${colName} is invalid: ${JSON.stringify(rawMonthly)}`)
        process.exit(1)
      }
      amountCentsForDb = unitAmountCents(monthlyDollars, addr.cycle)
    }

    // 1. DB existence probe — composite UNIQUE is the script's
    //    idempotency key. Same shape as v1/v2:
    //    • DB row's lookup_key === target (v3) → true SKIP
    //    • DB row's lookup_key !== target     → MIGRATE in place (UPDATE
    //                                            + archive old Stripe Price)
    //    • No DB row                          → fresh INSERT
    //
    // After commit 1's DELETE FROM stripe_prices, the DB is empty so all
    // rows hit the third branch. Migration path kept defensive (no harm,
    // protects against partial-state edge cases on re-runs).
    const { data: existing, error: selErr } = await supabase
      .from('stripe_prices')
      .select('id, stripe_price_id, stripe_product_id, lookup_key')
      .eq('tier_track', addr.tier_track)
      .eq('tier_name', addr.tier_name)
      .eq('line_item', addr.line_item)
      .eq('cycle', addr.cycle)
      .eq('mode', mode)
      .is('proposal_code_id', null)   // standard-row partial UNIQUE; ignore proposal-code rows
      .maybeSingle()
    if (selErr) {
      console.error(`[create-stripe-prices] DB select failed for ${lookupKey}: ${selErr.message}`)
      process.exit(1)
    }
    if (existing && existing.lookup_key === lookupKey) {
      // SKIP path — DB row already at v3 lookup_key. Still run the
      // Pattern A tax_code backfill on the Product (idempotent; no-op
      // when already correct) — same self-heal as v1/v2.
      await ensureProductTaxCode(stripe, existing.stripe_product_id, SAAS_TAX_CODE)
      skipped++
      console.log(`  SKIP    ${lookupKey} (DB row id=${existing.id}, price=${existing.stripe_price_id}, product=${existing.stripe_product_id})`)
      continue
    }
    const isMigration = existing !== null
    const oldStripePriceId = existing?.stripe_price_id as string | undefined
    if (isMigration) {
      console.log(`  MIGRATE ${lookupKey} (from ${existing.lookup_key}, archiving old price ${oldStripePriceId})`)
    }

    // 2. Stripe lookup_key probe (active Prices only).
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
      await ensureProductTaxCode(stripe, stripeProductId, SAAS_TAX_CODE)
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
            // Pattern A — SaaS in TX = txcd_10103001. Same as v1/v2.
            tax_code: SAAS_TAX_CODE,
            metadata: {
              tier_track: addr.tier_track,
              tier_name: addr.tier_name,
              line_item: addr.line_item,
              sml_group: groupKey,
              price_model: isGraduated ? 'graduated' : 'flat',
            },
          })
          productId = product.id
        }
        await ensureProductTaxCode(stripe, productId, SAAS_TAX_CODE)
        productIdByGroup.set(groupKey, productId)
      }

      // 4. Create the Price. Two shapes:
      //    FLAT       → billing_scheme defaults to 'per_unit', unit_amount=<cents>
      //    GRADUATED  → billing_scheme='tiered', tiers_mode='graduated', tiers[]
      //    Both: tax_behavior='exclusive' (B66.9, immutable post-creation).
      const commonPriceParams = {
        product: productId,
        currency: 'usd',
        recurring: { interval: addr.cycle === 'monthly' ? 'month' as const : 'year' as const },
        lookup_key: lookupKey,
        tax_behavior: 'exclusive' as const,
        metadata: {
          tier_track: addr.tier_track,
          tier_name: addr.tier_name,
          line_item: addr.line_item,
          cycle: addr.cycle,
          lookup_version: PRICE_LOOKUP_VERSION,
        },
      }
      let price: Stripe.Price
      if (isGraduated) {
        price = await stripe.prices.create({
          ...commonPriceParams,
          billing_scheme: 'tiered',
          tiers_mode: 'graduated',
          tiers: wireTiersToStripeShape(wireTiersForDb!),
        })
      } else {
        price = await stripe.prices.create({
          ...commonPriceParams,
          unit_amount: amountCentsForDb!,
        })
      }
      stripePriceId = price.id
      stripeProductId = productId
      action = 'create'
      created++
    }

    // 5. DB write — INSERT for fresh rows, UPDATE in place for migration.
    //    Both branches handle FLAT vs GRADUATED column shape:
    //      FLAT      → unit_amount_cents=<cents>, price_model='flat', tiers=NULL
    //      GRADUATED → unit_amount_cents=NULL,   price_model='graduated', tiers=<WirePermitTier[]>
    if (isMigration) {
      const { error: updErr } = await supabase
        .from('stripe_prices')
        .update({
          stripe_price_id: stripePriceId,
          stripe_product_id: stripeProductId,
          lookup_key: lookupKey,
          unit_amount_cents: isGraduated ? null : amountCentsForDb,
          price_model: isGraduated ? 'graduated' : 'flat',
          tiers: isGraduated ? wireTiersForDb : null,
        })
        .eq('id', existing!.id)
      if (updErr) {
        console.error(`[create-stripe-prices] DB update failed for ${lookupKey}: ${updErr.message}`)
        console.error(`  Stripe Price ${stripePriceId} was ${action === 'create' ? 'created' : 'recovered'} but DB row not updated.`)
        console.error(`  Re-run the script to re-attempt migration.`)
        process.exit(1)
      }

      // Archive the old Price per Q2 lock ("Old Prices archived, not
      // deleted"). Non-fatal on archival failure — DB is the source of
      // truth for "which Price do new checkouts use".
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
          unit_amount_cents: isGraduated ? null : amountCentsForDb,
          price_model: isGraduated ? 'graduated' : 'flat',
          tiers: isGraduated ? wireTiersForDb : null,
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
    const priceShape = isGraduated
      ? `graduated:${(wireTiersForDb ?? []).length}-band`
      : `flat:${amountCentsForDb}¢`
    console.log(`  ${tag} ${lookupKey} (${stripePriceId}, ${priceShape}, prod=${stripeProductId})`)
  }

  const total = created + recovered + skipped
  console.log('')
  console.log(`[create-stripe-prices] Done. mode=${mode}`)
  console.log(`  created:   ${created}`)
  console.log(`  recovered: ${recovered}`)
  console.log(`  skipped:   ${skipped}`)
  console.log(`  total:     ${total} (expected ${EXPECTED_TOTAL})`)

  if (total !== EXPECTED_TOTAL) {
    console.error(`[create-stripe-prices] Total != ${EXPECTED_TOTAL} — investigate before treating catalog as complete.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[create-stripe-prices] Fatal:', err)
  process.exit(1)
})
