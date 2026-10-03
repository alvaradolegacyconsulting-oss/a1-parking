// ════════════════════════════════════════════════════════════════════
// GET /api/signup/quote — the price the buyer sees, from the rows
// Stripe is about to charge from
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS ROUTE EXISTS. /signup and /signup/verify are client
// pages. getStandardCatalogLines is `import 'server-only'` — it holds a
// service-role Supabase client — so a client page physically cannot
// call it, and that is the gap the old code filled with hardcoded
// TIER_PRICING constants. On 2026-10-02 those constants told a live
// buyer Operator Pro was $199/mo with $0 per property; Stripe Checkout,
// one click later, correctly said $339.
//
// This route is the bridge. It calls the SAME function Checkout calls,
// against the SAME (track, tier, cycle, mode) address, and prices it
// with the SAME quantity map — then returns the total. There is no
// second price list left to drift.
//
// 🔴 REFUSES RATHER THAN UNDERQUOTES. If the catalog is short a row the
// total is simply smaller, which is a confident wrong answer and worse
// than an error. The row count is asserted against EXPECTED_LINE_COUNT
// and a short catalog 503s, so the page shows "couldn't price this"
// instead of an attractive $0.00.
//
// Public: sits under the /api/signup prefix, which middleware already
// treats as public, and must be — the estimate renders before anyone
// has an account. It discloses nothing private: these are list prices,
// the same ones on the home page and in Stripe's own Checkout.

import { NextRequest, NextResponse } from 'next/server'
import { getStandardCatalogLines, EXPECTED_LINE_COUNT } from '../../../lib/stripe-catalog'
import { quoteFromLines } from '../../../lib/pricing-quote'
import { isPlanToken, planFor } from '../../../lib/signup-tier-param'
import { getStripeMode } from '../../../lib/stripe'

// Prices come from the DB and the active Stripe mode; never cache.
export const dynamic = 'force-dynamic'

// A sane ceiling on the property count. Not a product cap (the real cap
// is enforce_property_limit); just a guard so a hostile querystring
// can't ask us to price 10^9 properties.
const MAX_QUOTE_PROPERTIES = 10000

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const token = sp.get('token')
  if (!isPlanToken(token)) {
    return NextResponse.json({ error: 'unknown plan token' }, { status: 400 })
  }
  const plan = planFor(token)

  const cycle = sp.get('cycle')
  if (cycle !== 'monthly' && cycle !== 'annual') {
    return NextResponse.json({ error: 'cycle must be monthly or annual' }, { status: 400 })
  }

  // 🔴 Number('') === 0 and Number(null) === 0. An absent or blank
  // `properties` must not quietly become a zero-property quote — it
  // would drop the per_property line entirely and return base-only,
  // which is a plausible number and therefore a dangerous one.
  const rawProperties = sp.get('properties')
  if (rawProperties === null || rawProperties.trim() === '') {
    return NextResponse.json({ error: 'properties is required' }, { status: 400 })
  }
  const properties = Number(rawProperties)
  if (!Number.isInteger(properties) || properties < 0 || properties > MAX_QUOTE_PROPERTIES) {
    return NextResponse.json({ error: 'properties must be an integer 0..' + MAX_QUOTE_PROPERTIES }, { status: 400 })
  }

  const mode = getStripeMode()

  let catalog: Awaited<ReturnType<typeof getStandardCatalogLines>>
  try {
    catalog = await getStandardCatalogLines(plan.track, plan.tier, cycle, mode)
  } catch (e) {
    console.error('[signup/quote] catalog query failed', e)
    return NextResponse.json({ error: 'pricing unavailable' }, { status: 503 })
  }

  const expected = EXPECTED_LINE_COUNT[plan.tier]
  if (catalog.length !== expected) {
    console.error(
      `[signup/quote] catalog shape wrong for (${plan.track}.${plan.tier}.${cycle}.${mode}): expected ${expected}, got ${catalog.length}`
    )
    return NextResponse.json({ error: 'pricing unavailable' }, { status: 503 })
  }

  const quote = quoteFromLines(catalog, properties)

  return NextResponse.json({
    token,
    label: plan.label,
    track: plan.track,
    tier: plan.tier,
    cycle,
    properties,
    mode,
    total_cents: quote.total_cents,
    lines: quote.lines,
  })
}
