import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'
import type { PriceBand, PriceModel } from './pricing-quote'

// B66.3 — standard-catalog query helper. Resolves a (track, tier, cycle,
// mode) tuple to the per-line-item Stripe Price IDs for line-item
// construction at Checkout-session-create time. Used by
// /api/signup/create-checkout-session today; B66.4 / B66.7 reuse the
// same helper for plan-change + proposal-code Subscription flows.
//
// Pattern B catalog assumption (per B66.2a): one Stripe Product per
// (track, tier, line_item); two Prices per Product (monthly + annual).
// This helper returns Prices only; the Product ID is on each Price row
// for callers that need it (e.g., B66.2b proposal-code creation reuses
// the same Product).
//
// Expected row counts by (track, tier) — post Bar-2 launch prep §5:
//   • enforcement / enforcement_only:  2 (base, per_property)
//   • property_management / pm_only:   3 (base, per_property, per_permit)
//   • property_management / pm_starter: 2 (base, per_permit) — 🔴 NO
//     per_property; Starter is one property by definition (cap sequence
//     A→A₀ enforces cap=1). Missing line-item is the correct shape,
//     not an omission (see 20260901 migration header for the invariant).
// per_driver RETIRED with the 3-tier move; historical DB rows may
// still exist but the catalog script no longer creates them.
// Callers should assert the expected count to catch catalog drift.

type Track = 'enforcement' | 'property_management'
type Tier =
  | 'starter' | 'growth' | 'legacy'                    // old 6-tier (historical rows)
  | 'essential' | 'professional' | 'enterprise'         // old 6-tier (historical rows)
  | 'pm_only' | 'enforcement_only' | 'pm_starter'       // current self-serve (pm_starter added 2026-09-02, Bar-2 launch prep §5)
// LineItem includes 'per_permit' (graduated meter, PM-only) added with
// the 3-tier move. 'per_driver' kept in the union for historical rows
// even though the current catalog script no longer creates it.
type LineItem = 'base' | 'per_property' | 'per_driver' | 'per_permit'
type Cycle = 'monthly' | 'annual'
type Mode = 'test' | 'live'

export interface CatalogLine {
  line_item: LineItem
  stripe_price_id: string
  stripe_product_id: string
  // 🔴 NULL on graduated rows. The amount lives in `tiers`, not here —
  // reading unit_amount_cents alone on a graduated line yields null and,
  // with the usual `?? 0`, a confident $0.
  unit_amount_cents: number | null
  lookup_key: string | null
  // 2026-10-02 — price_model + tiers added to the projection.
  //
  // 🔴 WHY: these columns have always existed and this helper never
  // selected them, so no caller could price a graduated line. Checkout
  // did not need to (Stripe applies the bands), but that made the
  // catalog UNPRICEABLE OUTSIDE STRIPE, which is why /signup grew a
  // second, hardcoded price source and started contradicting Checkout.
  // Carrying the bands is what lets display and charge share one source.
  price_model: PriceModel | null
  tiers: PriceBand[] | null
}

/**
 * How many catalog rows a self-serve tier must have, per cycle+mode.
 *
 * 🔴 ABSENCE IS NOT A PRICE. A missing row does not raise — it just
 * makes the total smaller, so an incomplete catalog quotes a confident
 * wrong number instead of failing. Both the Checkout route and the
 * /api/signup/quote estimate assert against this map and 503 rather
 * than price a partial basket.
 *
 *   pm_starter       2 — base + per_permit. NO per_property: Starter is
 *                        one property by definition. The missing line is
 *                        the correct shape, not an omission.
 *   enforcement_only 2 — base + per_property
 *   legacy           2 — base + per_property, on EITHER track. PM Pro has
 *                        no per_permit line (permits are unlimited on
 *                        Pro); the track distinguishes the two, and this
 *                        helper is keyed on (track, tier).
 *
 * pm_only is absent on purpose: the self-serve picker cannot send it.
 */
export const EXPECTED_LINE_COUNT: Record<'pm_starter' | 'enforcement_only' | 'legacy', number> = {
  pm_starter: 2,
  enforcement_only: 2,
  legacy: 2,
}

export async function getStandardCatalogLines(
  track: Track,
  tier: Tier,
  cycle: Cycle,
  mode: Mode,
): Promise<CatalogLine[]> {
  const supabase = createSupabaseServiceClient()

  const { data, error } = await supabase
    .from('stripe_prices')
    .select('line_item, stripe_price_id, stripe_product_id, unit_amount_cents, lookup_key, price_model, tiers')
    .eq('tier_track', track)
    .eq('tier_name', tier)
    .eq('cycle', cycle)
    .eq('mode', mode)
    .is('proposal_code_id', null)
    .eq('is_active', true)
    .order('line_item')

  if (error) {
    throw new Error(`[stripe-catalog] DB query failed for (${track}.${tier}.${cycle}.${mode}): ${error.message}`)
  }
  return (data ?? []) as CatalogLine[]
}
