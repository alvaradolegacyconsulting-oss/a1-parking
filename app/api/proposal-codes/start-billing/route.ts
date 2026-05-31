import 'server-only'
import { NextResponse } from 'next/server'
import { getStripe, getStripeMode } from '../../../lib/stripe'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { getStripeBillingEnabled } from '../../../lib/platform-flags'

// B66.7 — proposal-code → Stripe Subscription bridge.
//
// Called from /signup/redeem/verify AFTER redeem_proposal_code RPC
// returns successfully. At this point:
//   • The company exists (account_state='active', stripe IDs NULL).
//   • The proposal code is in 'redeemed' status, linked to the company.
//   • The caller is authenticated as the just-redeemed user (CA).
//
// This route reads the code's collection_method and routes:
//   • charge_automatically → builds a Stripe Checkout Session from the
//     proposal-code's Prices + redirects to Stripe-hosted Checkout.
//     Webhook (checkout.session.completed) UPDATEs companies with
//     stripe_customer_id + stripe_subscription_id on success.
//   • send_invoice → creates the Stripe Customer + Subscription directly
//     (net-30, no card collection); UPDATEs companies inline; returns
//     redirect to /signup/success with a marker so the page short-
//     circuits the polling.
//
// ── AUTH MODEL ──────────────────────────────────────────────────────
// User-session-bound. The caller's JWT identifies them; we verify
// they hold company_admin role on the target company (defense-in-depth;
// the user_roles row was just created by the RPC). Service-role
// client used for DB reads/writes that need cross-row visibility
// (proposal_codes, stripe_prices, companies UPDATE).
//
// ── DORMANCY ────────────────────────────────────────────────────────
// stripe_billing_enabled must be true. Mirrors /signup/create-checkout-
// session's guard. proposal-code path inherits the same posture.
//
// ── FAILURE MODE CONTRACT ───────────────────────────────────────────
//   • Not authenticated → 401
//   • Email not confirmed → 403 (defense; RPC-side already gated)
//   • Billing dormant → 503
//   • Body missing company_id → 400
//   • Company not found / caller not its company_admin → 403
//   • No redeemed proposal code linked to the company → 404
//   • No Stripe Prices for the code → 503 (issue route bug — should
//     have created them at draft→issued; recoverable via re-issue)
//   • Tax rate env var missing → 500 (fail-closed; never undercharge)
//   • Stripe API failure → 502
//
// ── MODE DISCIPLINE ─────────────────────────────────────────────────
// STRIPE_MODE selects SDK keypair + the stripe_prices.mode filter.
// Mismatched state (test code, live mode key) surfaces as no-Prices-
// found at the catalog lookup; same diagnosis path as create-checkout-
// session.

export const runtime = 'nodejs'
export const maxDuration = 30

// Quantity for proposal-code line items. Defaults to 1 when
// included_* column is NULL on the code (pre-B66.7 codes have NULL
// per the migration's nullable choice). For redeem-time consistency
// with the admin-set negotiated quantities, the migration ensures
// new codes have integer values from the admin form.
function quantityFor(lineItem: string, includedProperties: number | null, includedDrivers: number | null): number {
  if (lineItem === 'base') return 1
  if (lineItem === 'per_property') return includedProperties ?? 1
  if (lineItem === 'per_driver') return includedDrivers ?? 1
  return 1
}

export async function POST(request: Request) {
  // ── Auth ─────────────────────────────────────────────────────────
  const supabaseUser = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'email not verified' }, { status: 403 })
  }

  // ── Dormancy ──────────────────────────────────────────────────────
  if (!(await getStripeBillingEnabled())) {
    return NextResponse.json({ error: 'billing is not currently open' }, { status: 503 })
  }

  // ── Body parse ───────────────────────────────────────────────────
  let body: { company_id?: number } = {}
  try { body = await request.json() } catch { /* empty body → 400 below */ }
  const companyId = body.company_id
  if (!Number.isInteger(companyId)) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 })
  }

  // ── Verify caller owns the company (defense-in-depth on RPC output) ─
  const callerEmail = user.email!.toLowerCase()
  const supabase = createSupabaseServiceClient()
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('id, name, stripe_customer_id, stripe_subscription_id, primary_contact_name, address, account_state')
    .eq('id', companyId!)
    .maybeSingle()
  if (companyErr || !company) {
    return NextResponse.json({ error: 'company not found' }, { status: 404 })
  }
  const { data: role } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', callerEmail)
    .maybeSingle()
  if (!role || role.role !== 'company_admin' || role.company !== company.name) {
    return NextResponse.json({ error: 'caller is not company_admin of this company' }, { status: 403 })
  }

  // ── Already billed? (idempotency on retry) ────────────────────────
  // The webhook will UPDATE these fields on charge_automatically; for
  // send_invoice we UPDATE inline. Either way, presence means done.
  if (company.stripe_subscription_id) {
    return NextResponse.json({ already_billed: true, stripe_subscription_id: company.stripe_subscription_id })
  }

  // ── Find the redeemed proposal code linked to this company ────────
  const { data: code, error: codeErr } = await supabase
    .from('proposal_codes')
    .select('id, code, client_name, base_tier_type, base_tier, collection_method, included_properties, included_drivers')
    .eq('company_id', companyId!)
    .eq('status', 'redeemed')
    .maybeSingle()
  if (codeErr || !code) {
    return NextResponse.json({ error: 'no redeemed proposal code linked to this company' }, { status: 404 })
  }

  // ── Resolve the code's Stripe Prices (created at draft→issued) ────
  const mode = getStripeMode()
  const { data: priceRows, error: priceErr } = await supabase
    .from('stripe_prices')
    .select('line_item, stripe_price_id, stripe_product_id, unit_amount_cents')
    .eq('proposal_code_id', code.id)
    .eq('mode', mode)
    .eq('is_active', true)
    .order('line_item')
  if (priceErr) {
    return NextResponse.json({ error: 'price lookup failed: ' + priceErr.message }, { status: 503 })
  }
  const expectedLines = code.base_tier_type === 'enforcement' ? 3 : 2
  if (!priceRows || priceRows.length !== expectedLines) {
    return NextResponse.json(
      { error: `proposal-code Prices missing for code ${code.code} (mode=${mode}): expected ${expectedLines}, got ${priceRows?.length ?? 0}. Re-issue the code to recreate Prices.` },
      { status: 503 }
    )
  }

  // ── Tax rate resolution (Pattern B per B66.9) ─────────────────────
  // Fails closed: never ship a subscription without TX tax attached.
  const taxRateEnvVar = mode === 'live' ? 'STRIPE_LIVE_TX_TAX_RATE_ID' : 'STRIPE_TEST_TX_TAX_RATE_ID'
  const taxRateId = process.env[taxRateEnvVar]
  if (!taxRateId) {
    console.error(`[start-billing] missing ${taxRateEnvVar} — refusing to bill without TX tax rate`)
    return NextResponse.json({ error: 'Tax configuration missing. Contact support.' }, { status: 500 })
  }

  // ── Build line items ─────────────────────────────────────────────
  // Quantity from admin-captured included_* counts (B66.7 Option γ).
  // Filter zero-quantity lines so Stripe doesn't reject the create.
  const lineItems = priceRows
    .map(p => ({
      price: p.stripe_price_id,
      quantity: quantityFor(p.line_item, code.included_properties, code.included_drivers),
    }))
    .filter(li => li.quantity > 0)

  const stripe = getStripe()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'

  // ── Branch on collection_method ────────────────────────────────────

  if (code.collection_method === 'charge_automatically') {
    // ── charge_automatically: Stripe Checkout for card collection ───
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: user.email!,
        line_items: lineItems,
        success_url: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}&proposal_code_id=${code.id}`,
        cancel_url: `${origin}/signup/cancelled`,
        billing_address_collection: 'required',
        customer_update: { address: 'auto' },
        // Webhook discriminator. checkout-session-completed handler
        // reads proposal_code_id → UPDATE existing companies row.
        metadata: {
          supabase_user_id: user.id,
          proposal_code_id: String(code.id),
          company_id: String(companyId),
        },
        subscription_data: {
          default_tax_rates: [taxRateId],
          metadata: {
            supabase_user_id: user.id,
            proposal_code_id: String(code.id),
            company_id: String(companyId),
            proposal_code: code.code,
            tier_track: code.base_tier_type,
            tier_name: code.base_tier,
          },
        },
      })
      if (!session.url) {
        return NextResponse.json({ error: 'Stripe returned a session without a checkout URL' }, { status: 502 })
      }
      return NextResponse.json({ branch: 'charge_automatically', checkout_url: session.url })
    } catch (e) {
      return NextResponse.json({ error: 'Stripe Checkout session create failed: ' + (e as Error).message }, { status: 502 })
    }
  }

  if (code.collection_method === 'send_invoice') {
    // ── send_invoice: direct customer + subscription create ─────────
    // No Checkout (no card collection); Stripe issues an invoice net-30
    // payable via the hosted-invoice-page link Stripe emails the
    // customer at the contact email below.
    try {
      const customer = await stripe.customers.create({
        email: user.email!,
        name: company.primary_contact_name || code.client_name || company.name,
        metadata: {
          supabase_user_id: user.id,
          company_id: String(companyId),
          proposal_code_id: String(code.id),
          proposal_code: code.code,
          collection_method: 'send_invoice',
        },
      })

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: lineItems.map(li => ({ price: li.price, quantity: li.quantity })),
        collection_method: 'send_invoice',
        days_until_due: 30,
        default_tax_rates: [taxRateId],
        metadata: {
          supabase_user_id: user.id,
          company_id: String(companyId),
          proposal_code_id: String(code.id),
          proposal_code: code.code,
          tier_track: code.base_tier_type,
          tier_name: code.base_tier,
        },
      })

      // ── UPDATE companies inline (no webhook for send_invoice path) ─
      const { error: updErr } = await supabase
        .from('companies')
        .update({
          stripe_customer_id: customer.id,
          stripe_subscription_id: subscription.id,
        })
        .eq('id', companyId!)
      if (updErr) {
        // Stripe-side resources exist but DB linkage failed. Surface
        // loudly; admin can manually attach via SQL Editor.
        console.error('[start-billing] send_invoice: companies UPDATE failed after Stripe success', {
          companyId, customerId: customer.id, subscriptionId: subscription.id, error: updErr.message,
        })
        return NextResponse.json(
          { error: `Stripe subscription created (${subscription.id}) but DB UPDATE failed: ${updErr.message}` },
          { status: 500 }
        )
      }

      // ── Verify-after-write (F6) ───────────────────────────────────
      const { data: verify } = await supabase
        .from('companies')
        .select('stripe_customer_id, stripe_subscription_id')
        .eq('id', companyId!)
        .maybeSingle()
      if (!verify || verify.stripe_customer_id !== customer.id || verify.stripe_subscription_id !== subscription.id) {
        console.error('[start-billing] send_invoice: verify-after-write mismatch', {
          companyId, expectedCustomer: customer.id, expectedSub: subscription.id, actual: verify,
        })
        return NextResponse.json({ error: 'verify-after-write mismatch on send_invoice path' }, { status: 500 })
      }

      return NextResponse.json({
        branch: 'send_invoice',
        stripe_customer_id: customer.id,
        stripe_subscription_id: subscription.id,
        success_redirect: `/signup/success?proposal_code_id=${code.id}&send_invoice=1`,
      })
    } catch (e) {
      return NextResponse.json({ error: 'Stripe send_invoice subscription create failed: ' + (e as Error).message }, { status: 502 })
    }
  }

  return NextResponse.json(
    { error: `unknown collection_method on proposal_codes row: ${code.collection_method}` },
    { status: 500 }
  )
}
