import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { getStripe, getStripeMode } from '../../../lib/stripe'
import { getStripeBillingEnabled, getPublicSignupOpen } from '../../../lib/platform-flags'
import { getStandardCatalogLines } from '../../../lib/stripe-catalog'

// B66.3 — Stripe Checkout session creator. Called from /signup/verify
// when the user clicks "Continue to Checkout" after email verification.
// Reads the persisted tier selection from user_metadata, looks up the
// standard catalog Price IDs for the chosen (track, tier, cycle, mode),
// builds line items with customer-entered quantities, creates a Stripe
// Checkout Session, and 303-redirects to the hosted Checkout URL.
//
// ── DORMANCY GUARDS (defense-in-depth per B66.1 Cluster 1.1) ────────
// /signup page-level guard also enforces this. Both flags must be true
// for the route to proceed. Either off → 503. Webhook handler ALSO
// fails-closed on stripe_billing_enabled=false (its own check).
//
// ── FAILURE MODE CONTRACT ───────────────────────────────────────────
//   • Auth missing/unverified → 401/403
//   • Dormancy flags off → 503
//   • user_metadata.intended_tier missing/malformed → 400
//   • Standard catalog row missing (drift between repo + Stripe) → 503
//   • Stripe API failure → 502
//
// ── MODE DISCIPLINE ─────────────────────────────────────────────────
// STRIPE_MODE env var picks which Stripe keypair the SDK uses (B66.1)
// AND which mode-filtered stripe_prices rows we look up. Mismatched
// state surfaces as catalog-missing at line-item construction time
// (the test-mode SDK can't see live-mode Prices and vice versa).

export const runtime = 'nodejs'
export const maxDuration = 30

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'starter' | 'growth' | 'legacy' | 'essential' | 'professional' | 'enterprise'
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

export async function POST() {
  // ── Auth ─────────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'email not verified' }, { status: 403 })
  }

  // ── Dormancy guards ──────────────────────────────────────────────
  const [billingOn, signupOn] = await Promise.all([
    getStripeBillingEnabled(),
    getPublicSignupOpen(),
  ])
  if (!billingOn || !signupOn) {
    return NextResponse.json(
      { error: 'self-serve signup is not currently open' },
      { status: 503 }
    )
  }

  // ── Read tier selection from user_metadata ────────────────────────
  const intendedRaw = user.user_metadata?.intended_tier
  if (!intendedRaw || typeof intendedRaw !== 'object') {
    return NextResponse.json({ error: 'intended_tier missing from user_metadata' }, { status: 400 })
  }
  const intended = intendedRaw as Partial<IntendedTier>
  if (
    !intended.track || !intended.tier || !intended.cycle ||
    typeof intended.property_count !== 'number' ||
    typeof intended.driver_count !== 'number' ||
    !intended.company_name
  ) {
    return NextResponse.json({ error: 'intended_tier malformed' }, { status: 400 })
  }
  if (intended.track === 'property_management' && intended.driver_count > 0) {
    return NextResponse.json({ error: 'PM track does not support driver count' }, { status: 400 })
  }
  if (intended.property_count < 1) {
    return NextResponse.json({ error: 'property_count must be at least 1' }, { status: 400 })
  }
  if (intended.track === 'enforcement' && intended.driver_count < 1) {
    return NextResponse.json({ error: 'enforcement track requires at least 1 driver' }, { status: 400 })
  }

  // ── Resolve catalog lines ────────────────────────────────────────
  const mode = getStripeMode()
  let catalog: Awaited<ReturnType<typeof getStandardCatalogLines>>
  try {
    catalog = await getStandardCatalogLines(
      intended.track,
      intended.tier as IntendedTier['tier'],
      intended.cycle,
      mode,
    )
  } catch (e) {
    return NextResponse.json({ error: 'catalog lookup failed: ' + (e as Error).message }, { status: 503 })
  }
  const expectedCount = intended.track === 'enforcement' ? 3 : 2
  if (catalog.length !== expectedCount) {
    return NextResponse.json(
      { error: `standard catalog missing rows for (${intended.track}.${intended.tier}.${intended.cycle}.${mode}): expected ${expectedCount}, got ${catalog.length}. Run scripts/create-stripe-prices.ts.` },
      { status: 503 }
    )
  }

  // ── Build line items ─────────────────────────────────────────────
  // base → quantity 1; per_property → property_count; per_driver → driver_count.
  // Stripe rejects quantity=0, so the per_* lines drop out if their count is 0
  // (only realistically possible for PM driver_count, which we already guarded).
  const lineItems = catalog
    .map(line => ({
      price: line.stripe_price_id,
      quantity:
        line.line_item === 'base' ? 1
        : line.line_item === 'per_property' ? intended.property_count!
        : intended.driver_count!,
    }))
    .filter(li => li.quantity > 0)

  // ── Create Stripe Checkout Session ───────────────────────────────
  const stripe = getStripe()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'

  // B66.9: Texas Sales Tax Rate ID resolution (Pattern B — fixed-rate
  // jurisdiction-based tax). 6.6% effective rate created via
  // scripts/create-stripe-tax-rate.ts and stored in Vercel env per mode.
  // Fails closed: if the env var is missing, refuse to checkout rather
  // than silently undercharge. Pre-launch this should always be set;
  // missing env var means the operator skipped Vercel setup.
  const stripeMode = process.env.STRIPE_MODE === 'live' ? 'live' : 'test'
  const taxRateEnvVar = stripeMode === 'live' ? 'STRIPE_LIVE_TX_TAX_RATE_ID' : 'STRIPE_TEST_TX_TAX_RATE_ID'
  const taxRateId = process.env[taxRateEnvVar]
  if (!taxRateId) {
    console.error(`[create-checkout-session] missing ${taxRateEnvVar} — refusing to checkout without TX tax rate configured`)
    return NextResponse.json(
      { error: 'Tax configuration missing. Contact support.' },
      { status: 500 }
    )
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email!,
      line_items: lineItems,
      success_url: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/signup/cancelled`,
      // B66.9: collect billing address at checkout for audit + cleaner
      // customer records. customer_update.address: 'auto' persists the
      // collected address to the Stripe customer record (otherwise it
      // lives only on the one invoice from this Checkout). Both fields
      // needed — see B66.9 Step 7 finding (the second-field gotcha).
      billing_address_collection: 'required',
      customer_update: { address: 'auto' },
      metadata: {
        supabase_user_id: user.id,
        intended_tier_json: JSON.stringify(intended),
      },
      subscription_data: {
        // B66.9: default_tax_rates attaches the TX Sales Tax Rate to the
        // subscription. Tax computed by Stripe (6.6% × line subtotal,
        // rendered as a separate line on every recurring invoice).
        default_tax_rates: [taxRateId],
        metadata: {
          supabase_user_id: user.id,
          company_name: intended.company_name,
          tier_track: intended.track,
          tier_name: intended.tier,
        },
      },
    })
    if (!session.url) {
      return NextResponse.json({ error: 'Stripe returned a session without a checkout URL' }, { status: 502 })
    }
    return NextResponse.redirect(session.url, { status: 303 })
  } catch (e) {
    return NextResponse.json({ error: 'Stripe Checkout session create failed: ' + (e as Error).message }, { status: 502 })
  }
}
