import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'

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
// Expected row counts (post 3-tier move, Slice 1):
//   • enforcement: 2 (base, per_property) — per_driver RETIRED with the
//     3-tier move; historical DB rows may still exist but the catalog
//     script no longer creates them.
//   • property_management: 3 (base, per_property, per_permit graduated)
// Callers should assert the expected count to catch catalog drift.

type Track = 'enforcement' | 'property_management'
type Tier =
  | 'starter' | 'growth' | 'legacy'                    // old 6-tier (historical rows)
  | 'essential' | 'professional' | 'enterprise'         // old 6-tier (historical rows)
  | 'pm_only' | 'enforcement_only'                      // 3-tier (current)
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
  unit_amount_cents: number
  lookup_key: string | null
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
    .select('line_item, stripe_price_id, stripe_product_id, unit_amount_cents, lookup_key')
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
