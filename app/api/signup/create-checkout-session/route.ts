import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { getStripe, getStripeMode } from '../../../lib/stripe'
import { getStripeBillingEnabled, getPublicSignupOpen } from '../../../lib/platform-flags'
import { getStandardCatalogLines } from '../../../lib/stripe-catalog'
import {
  TOS_VERSION,
  PRIVACY_VERSION,
  TEXAS_ATTESTATION_VERSION,
} from '../../../lib/legal-versions'

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

// 🔴 2026-09-03 (Picker §2) — tier union narrowed to the two values
// the self-serve picker can actually send. Old 6-value list was a
// carryover from B66.2a's pre-pivot catalog + never updated when the
// picker moved to 3-tier + pm_starter. Narrow makes the next vocab
// drift a BUILD error rather than the 503 the picker-research pass
// found here (intended.tier as IntendedTier['tier'] silenced the
// comparison). See feedback_cast_at_vocabulary_boundary.
// Legacy self-serve doesn't exist — legacy is proposal-code-only,
// which uses a different route entirely.
interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'pm_starter' | 'enforcement_only'
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

  // ── 🔴 Legal consent gate (2026-09-03, Mateo Sep 3 §1 flip blocker) ─
  // Verifies that /api/signup/attest was called successfully and
  // persisted tos_acceptances rows at the CURRENT pinned versions.
  // Without this, a caller who skips /signup/verify (never hitting
  // /api/signup/attest) can POST here and create a paid subscription
  // with zero recorded consent — the entire B118 arc bypassed.
  //
  // Version-pinned: a row against a superseded TOS_VERSION /
  // PRIVACY_VERSION / TEXAS_ATTESTATION_VERSION doesn't count as
  // consent to the CURRENT terms. Server pins from lib/legal-versions.ts
  // are the source of truth (same file /api/signup/attest reads from,
  // so the two endpoints agree on "current").
  //
  // RLS on tos_acceptances (tos_acceptances_self_select policy from
  // 20260520_b65_self_serve_signup_schema.sql) filters to the user's
  // own rows — the cookie-bound session client above provides auth.uid()
  // so this read is naturally scoped without a service-role escalation.
  //
  // Missing any → 400 pointing at re-attest. Doesn't distinguish
  // WHICH pin failed to keep the error terse; the /signup/verify page
  // owns the re-attest UX.
  const { data: consentRows, error: consentErr } = await supabase
    .from('tos_acceptances')
    .select('document_type, tos_version, privacy_version, attestation_version')
    .eq('user_id', user.id)
    .in('document_type', ['tos', 'privacy', 'texas_attestation'])
  if (consentErr) {
    return NextResponse.json(
      { error: 'legal consent verification failed: ' + consentErr.message },
      { status: 500 }
    )
  }
  const hasTos = (consentRows ?? []).some(
    r => r.document_type === 'tos' && r.tos_version === TOS_VERSION
  )
  const hasPrivacy = (consentRows ?? []).some(
    r => r.document_type === 'privacy' && r.privacy_version === PRIVACY_VERSION
  )
  const hasTexas = (consentRows ?? []).some(
    r => r.document_type === 'texas_attestation' && r.attestation_version === TEXAS_ATTESTATION_VERSION
  )
  if (!hasTos || !hasPrivacy || !hasTexas) {
    const missing: string[] = []
    if (!hasTos) missing.push('terms_of_service')
    if (!hasPrivacy) missing.push('privacy_policy')
    if (!hasTexas) missing.push('texas_attestation')
    return NextResponse.json(
      {
        error: 'legal consent not recorded at current versions',
        missing,
        hint: 'return to /signup/verify to record consent, then retry checkout',
      },
      { status: 400 }
    )
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
  // 2026-07-01 — Enforcement per_driver line RETIRED with the 3-tier
  // move (Slice 1). Enforcement catalog is now base + per_property only.
  // The old "requires at least 1 driver" check would 400 every legit
  // enforcement caller now that driver_count=0 is the normal shape.
  // Removed. `driver_count` remains in the body type for backward
  // compat with clients that still send it; PM guard above enforces
  // ==0 for PM; enforcement no longer enforces a minimum.

  // ── B2-1 Commit 1 — pre-flight company-name uniqueness ─────────────
  // Fires BEFORE catalog resolution + Stripe session creation so a
  // duplicate name is caught while the prospect is still on-site and
  // no money has moved. Uses the company_name_available() DEFINER RPC
  // which normalizes with lower(trim(...)) — matching the unique index
  // companies_name_lower_unique. ILIKE would be whitespace-insensitive
  // wrong; must match the index or the check is theatre. On collision,
  // 303-redirect to /signup/verify?error=name_taken so the Verify page
  // renders the support-routing card. RPC call failures fail-open here
  // (log + let checkout proceed) so a transient DB blip doesn't block a
  // legitimate customer — the DB unique index remains as the backstop
  // if the pre-check is bypassed (webhook's 23505 handling in Commit 2
  // logs to provisioning_failures).
  const { data: nameAvailable, error: nameErr } = await supabase
    .rpc('company_name_available', { p_name: intended.company_name })
  if (nameErr) {
    console.error('[create-checkout-session] company_name_available RPC error — proceeding to catalog resolution (unique index remains as backstop):', nameErr.message)
  } else if (nameAvailable === false) {
    const errOrigin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
    return NextResponse.redirect(`${errOrigin}/signup/verify?error=name_taken`, { status: 303 })
  }

  // ── Resolve catalog lines ────────────────────────────────────────
  const mode = getStripeMode()
  let catalog: Awaited<ReturnType<typeof getStandardCatalogLines>>
  try {
    catalog = await getStandardCatalogLines(
      intended.track,
      intended.tier,   // 🔴 cast removed 2026-09-03 (Picker §2); union is now catalog-compatible
      intended.cycle,
      mode,
    )
  } catch (e) {
    return NextResponse.json({ error: 'catalog lookup failed: ' + (e as Error).message }, { status: 503 })
  }
  // 🔴 2026-09-03 (Picker §2) — expectedCount keyed off TIER via
  // Record<IntendedTier['tier'], number>. Prior `track === 'pm' ? 3 : 2`
  // would 503 pm_starter as "catalog missing" (pm_starter is PM but
  // has only 2 lines — base + per_permit; NO per_property per
  // feedback_missing_column_is_correct_shape).
  //
  // Record shape forces build-time exhaustiveness: adding a tier to
  // IntendedTier['tier'] fails this Record<> if the new tier isn't
  // added here too. No chained ternary silence.
  //
  // pm_starter → 2 (base + per_permit graduated; NO per_property)
  // enforcement_only → 2 (base + per_property; per_driver retired)
  // pm_only is NOT in this map — self-serve picker doesn't send it
  // (proposal-code path uses a different route). If pm_only ever
  // becomes self-serve, add here.
  const expectedCountByTier: Record<IntendedTier['tier'], number> = {
    pm_starter: 2,
    enforcement_only: 2,
  }
  const expectedCount = expectedCountByTier[intended.tier]
  if (catalog.length !== expectedCount) {
    return NextResponse.json(
      { error: `standard catalog missing rows for (${intended.track}.${intended.tier}.${intended.cycle}.${mode}): expected ${expectedCount}, got ${catalog.length}. Run scripts/create-stripe-prices.ts.` },
      { status: 503 }
    )
  }

  // ── Build line items ─────────────────────────────────────────────
  // 2026-07-01 — quantity map rewritten for the 3-tier catalog.
  // 2026-09-03 — comment corrected: per_permit is LICENSED with a
  // ratcheted quantity, NOT metered. Prior wording ("billed by metered
  // usage") was wrong — the Stripe Prices are created without
  // usage_type (defaults to 'licensed'), and syncOnAdd calls
  // stripe.subscriptionItems.update(itemId, { quantity }) to ratchet
  // the count. No code path calls createUsageRecord / usage_records.
  //   base         → 1
  //   per_property → intended.property_count
  //   per_permit   → 1 (LICENSED tiered Price; graduated tier 1 covers
  //                  0-500 permits at $0.00 so a fresh subscriber's
  //                  first invoice is $0 for permits regardless of
  //                  starting quantity. Ratcheted upward by syncOnAdd
  //                  as permits are approved; renewal-trim by the
  //                  parallel syncOnRemove path.)
  //   per_driver   → retired with the 3-tier move; not in the catalog.
  // Previous fallthrough sent intended.driver_count for anything not
  // base/per_property — that would produce NaN for PM per_permit and
  // silently drop the line via the >0 filter.
  const lineItems = catalog
    .map(line => ({
      price: line.stripe_price_id,
      quantity:
        line.line_item === 'base'         ? 1
        : line.line_item === 'per_property' ? intended.property_count!
        : line.line_item === 'per_permit'   ? 1
        : 1,
    }))
    .filter(li => li.quantity > 0)

  // ── Create Stripe Checkout Session ───────────────────────────────
  const stripe = getStripe()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'

  // Pattern A (Stripe Tax) replaces B66.9's Pattern B fixed-rate attach.
  // The STRIPE_<MODE>_TX_TAX_RATE_ID env var is no longer required by
  // this route — Stripe Tax sources jurisdiction from the customer's
  // billing address (collected at Checkout below) and applies the SaaS
  // tax_code on each Product (txcd_10103001 — set in
  // scripts/create-stripe-prices.ts) which carries the TX Rule 3.330
  // 80%-of-8.25% reduced basis natively. The env var resolution is
  // kept as a no-op observability log during the migration window so
  // the absence on Vercel doesn't surface as a deploy surprise, and
  // log greps can confirm Pattern A is the active path. The send_invoice
  // branch in /api/proposal-codes/start-billing still uses the env var
  // (Pattern B until its own migration); remove this block + the
  // STRIPE_<MODE>_TX_TAX_RATE_ID Vercel vars after that lands.
  const stripeMode = process.env.STRIPE_MODE === 'live' ? 'live' : 'test'
  const taxRateEnvVar = stripeMode === 'live' ? 'STRIPE_LIVE_TX_TAX_RATE_ID' : 'STRIPE_TEST_TX_TAX_RATE_ID'
  if (process.env[taxRateEnvVar]) {
    console.log(`[create-checkout-session] ${taxRateEnvVar} present but unused under Pattern A (automatic_tax)`)
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email!,
      line_items: lineItems,
      success_url: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/signup/cancelled`,
      // B66.9: collect billing address at checkout for audit + cleaner
      // customer records. With customer_email (no pre-existing customer),
      // Stripe persists the collected address to the freshly-created
      // Customer automatically — no customer_update needed (Stripe
      // rejects customer_update without a pre-existing `customer` ID).
      // Pattern A (B110 close-out): this collected address is ALSO the
      // jurisdiction-sourcing input for Stripe Tax — automatic_tax
      // below requires it.
      billing_address_collection: 'required',
      // Pattern A — Stripe Tax. Computes tax server-side based on the
      // customer's billing address + each Product's tax_code
      // (txcd_10103001 = SaaS, applies TX Rule 3.330 80%-basis
      // natively). Replaces Pattern B's fixed 6.6%-flat TaxRate attach
      // which mis-charged for non-Houston TX billing addresses (Sugar
      // Land, Katy, Pearland etc. have different combined rates) plus
      // gave no jurisdiction-level filing report. Requires Stripe Tax
      // enabled + TX collection obligation registered in Dashboard.
      automatic_tax: { enabled: true },
      metadata: {
        supabase_user_id: user.id,
        intended_tier_json: JSON.stringify(intended),
      },
      subscription_data: {
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
