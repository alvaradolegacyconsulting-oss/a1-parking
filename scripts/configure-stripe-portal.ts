// B66.4 commit 2 — Stripe Customer Portal configuration setup.
//
// Creates a Stripe Portal Configuration matching B66.4's locked feature
// toggles (payment methods + invoices + address + cancellation enabled;
// plan changes + quantity edits + pause disabled). Prints the resulting
// configuration_id for Jose to paste into Vercel env var.
//
// ── PATTERN B.2 (per pre-flight + greenlight) ───────────────────────
// API-managed config (NOT Dashboard-managed) so the source of truth
// lives in this repo, not in Stripe Dashboard state. Avoids the same
// drift surface that the audit-pass discipline file warns against.
//
// ── ENV VAR SHAPE ───────────────────────────────────────────────────
//   STRIPE_TEST_PORTAL_CONFIG_ID — populated after running this script
//                                  in test mode
//   STRIPE_LIVE_PORTAL_CONFIG_ID — populated post-launch
//
// Both must be added to Vercel Production scope per the B109 process
// discipline (env var coverage at deploy time). The Portal session
// route fail-closes with a clear error if either is unset.
//
// ── IDEMPOTENCY (v1) ────────────────────────────────────────────────
// This script ALWAYS creates a new configuration on each run. Stripe
// keeps prior configurations around; updating the env var to the new
// ID is a manual step. If accumulation becomes an issue, future
// refinement: probe billingPortal.configurations.list, find one with
// metadata.sml_arc='b66.4', UPDATE in place. Not needed today.
//
// ── USAGE ───────────────────────────────────────────────────────────
//   export STRIPE_MODE=test
//   export STRIPE_TEST_SECRET_KEY=sk_test_...
//   npx tsx scripts/configure-stripe-portal.ts
//
// Output:
//   - Prints the created configuration_id (bpc_xxx)
//   - Prints the env var name to add to Vercel
//   - Prints the feature toggle summary for verification

import Stripe from 'stripe'

type Mode = 'test' | 'live'

const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

function resolveMode(): Mode {
  const raw = process.env.STRIPE_MODE
  if (raw !== 'test' && raw !== 'live') {
    console.error(
      `[configure-stripe-portal] STRIPE_MODE must be 'test' or 'live' (got: ${JSON.stringify(raw)}). ` +
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
    console.error(`[configure-stripe-portal] Missing ${varName} for STRIPE_MODE='${mode}'.`)
    process.exit(1)
  }
  return key
}

async function main() {
  const mode = resolveMode()
  const stripeKey = resolveStripeKey(mode)

  const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION })

  console.log(`[configure-stripe-portal] mode=${mode}`)
  console.log(`[configure-stripe-portal] Stripe API version=${STRIPE_API_VERSION}`)
  console.log('')
  console.log('Creating Portal configuration with the following features:')
  console.log('  payment_method_update      ENABLED')
  console.log('  invoice_history            ENABLED')
  console.log('  customer_update            ENABLED (allowed_updates: address, name, tax_id)')
  console.log('  subscription_cancel        ENABLED (at_period_end, no reason prompt)')
  console.log('  subscription_update        DISABLED')
  console.log('  subscription_pause         (not configurable in current SDK — Portal won\'t expose; equivalent to DISABLED)')
  console.log('')

  let config
  try {
    config = await stripe.billingPortal.configurations.create({
      business_profile: {
        privacy_policy_url: 'https://shieldmylot.com/privacy',
        terms_of_service_url: 'https://shieldmylot.com/terms',
      },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: {
          enabled: true,
          allowed_updates: ['address', 'name', 'tax_id'],
        },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          // Stripe SDK type requires `options` array even when disabled,
          // AND Stripe's API runtime enforces a minimum of 2 values
          // (not type-visible — caught at create-time with "You must
          // specify at least 2 values for ...cancellation_reason.options").
          // The reason prompt stays suppressed at runtime via
          // enabled=false; specific values don't affect UX. If we later
          // enable the prompt, expand this array to the customer-facing
          // reason set (Stripe accepts: 'too_expensive', 'missing_features',
          // 'switched_service', 'unused', 'customer_service', 'too_complex',
          // 'low_quality', 'other').
          cancellation_reason: { enabled: false, options: ['other', 'unused'] },
        },
        subscription_update: { enabled: false },
        // subscription_pause was removed from the Portal config schema in
        // a recent Stripe SDK version — Stripe deprecated Portal-side
        // pause in favor of API-only Pause Collection. The pre-flight
        // locked "pause = disabled," which is the only available state
        // today (Portal won't expose a pause control to customers).
        // Equivalent to `subscription_pause: { enabled: false }` in
        // older SDKs.
      },
      default_return_url: 'https://shieldmylot.com/company_admin?tab=billing&from=portal',
      metadata: {
        sml_arc: 'b66.4',
        created_via: 'configure-stripe-portal.ts',
      },
    })
  } catch (e) {
    console.error('[configure-stripe-portal] Stripe configuration create failed:', (e as Error).message)
    process.exit(1)
  }

  const envVarName = mode === 'test' ? 'STRIPE_TEST_PORTAL_CONFIG_ID' : 'STRIPE_LIVE_PORTAL_CONFIG_ID'

  console.log('')
  console.log('[configure-stripe-portal] Done.')
  console.log('')
  console.log(`  configuration_id: ${config.id}`)
  console.log('')
  console.log(`Next steps:`)
  console.log(`  1. Add to Vercel (Production scope):`)
  console.log(`       ${envVarName}=${config.id}`)
  console.log(`  2. Redeploy the latest commit (env vars are deploy-time, not runtime).`)
  console.log(`  3. /api/billing/portal-session in ${mode} mode will pick up the new config.`)
  console.log('')
  console.log(`If running again later (policy update): re-run this script, copy the new`)
  console.log(`config_id over the prior env var value, redeploy. Old configs stay in Stripe`)
  console.log(`but are no longer referenced.`)
}

main().catch((err) => {
  console.error('[configure-stripe-portal] Fatal:', err)
  process.exit(1)
})
