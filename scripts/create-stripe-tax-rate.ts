// B66.9 — Texas Sales Tax Rate creation script.
//
// Creates the single TX Sales Tax Rate object Stripe needs for the
// Pattern B (fixed-rate) implementation locked in B66.9 pre-flight.
//
// ── WHY 6.6% FLAT (NOT 8.25% ON 80% BASIS) ──────────────────────────
// Rule 3.330 classifies Texas SaaS as "data processing service" with
// 80% taxable basis × 8.25% Houston rate = 6.6% effective. The two
// representations reconcile identically on the Comptroller return.
// We pick 6.6%-flat because:
//   1. Stripe's `RateType` is `'flat_amount' | 'percentage'` — no
//      native reduced-basis representation exists (B66.9 Step 2
//      investigation confirmed via SDK type inspection).
//   2. Splitting each charge into a taxable 80% line + exempt 20%
//      line would be brittle and confusing on customer-facing invoices.
// The audit-clarity move that recovers the "8.25% looks familiar"
// concern: encode the derivation in the Tax Rate's `description` field.
// Customers see `display_name='Texas Sales Tax'`; auditors querying
// Stripe see the full Rule 3.330 derivation in `description`.
//
// See [[decision-6-6-flat-over-8-25-on-80-basis]] for full reasoning.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────
// TaxRate doesn't have a `lookup_key` field like Price, so probe by
// `metadata.purpose='b66_9_tx_tax'` filter on a list call. Existing
// active TaxRate → SKIP, print ID. Missing → CREATE + verify-after-
// write to confirm display_name + description landed.
//
// ── VERIFY-AFTER-WRITE (per B66.5 F6 discipline) ────────────────────
// description field carries the audit-facing derivation. A silent
// truncation/drop by Stripe would defeat the Q1 clarity move. After
// create, retrieve back + assert description matches what we sent.
//
// ── USAGE ───────────────────────────────────────────────────────────
//   export STRIPE_MODE=test
//   export STRIPE_TEST_SECRET_KEY=sk_test_...
//   # OR for live: export STRIPE_LIVE_SECRET_KEY=sk_live_...
//   npx tsx scripts/create-stripe-tax-rate.ts
//
// Output prints the TaxRate ID. Set it on Vercel as:
//   STRIPE_TEST_TX_TAX_RATE_ID=txr_...  (Production + Preview scopes)
//   STRIPE_LIVE_TX_TAX_RATE_ID=txr_...  (Production scope, post-launch)
//
// ── SAFETY ──────────────────────────────────────────────────────────
// • Sandbox-only at first; live mode runs deferred to ~1 week pre-launch.
// • Idempotent: re-running skips existing rate.
// • No DB writes — the rate ID lives in Vercel env vars, not Supabase.

import Stripe from 'stripe'

type Mode = 'test' | 'live'

const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

// 6.6% effective rate (8.25% × 80% basis per Rule 3.330).
const TAX_PERCENTAGE = 6.6

// Customer-facing label on invoices.
const DISPLAY_NAME = 'Texas Sales Tax'

// Auditor-facing derivation. Lives in `description` field.
const DESCRIPTION =
  '6.6% effective (8.25% × 80% taxable basis, 34 TAC §3.330)'

// Metadata marker for idempotent re-discovery on script re-run.
const PURPOSE_TAG = 'b66_9_tx_tax'

function resolveMode(): Mode {
  const raw = process.env.STRIPE_MODE
  if (raw !== 'test' && raw !== 'live') {
    console.error(
      `[create-stripe-tax-rate] STRIPE_MODE must be 'test' or 'live' (got: ${JSON.stringify(raw)}). ` +
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
    console.error(`[create-stripe-tax-rate] Missing ${varName} for STRIPE_MODE='${mode}'.`)
    process.exit(1)
  }
  return key
}

async function main() {
  const mode = resolveMode()
  const stripeKey = resolveStripeKey(mode)
  const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION })

  console.log(`[create-stripe-tax-rate] mode=${mode}, percentage=${TAX_PERCENTAGE}%`)
  console.log(`[create-stripe-tax-rate] probing for existing rate by metadata.purpose=${PURPOSE_TAG}...`)

  // Idempotency probe: list active TaxRates + filter by metadata.
  // Stripe doesn't support a server-side metadata filter on list, so
  // we paginate locally. At this scale (~1-5 TaxRates per account),
  // a single page is sufficient.
  const probeList = await stripe.taxRates.list({ active: true, limit: 100 })
  const existing = probeList.data.find(r => r.metadata?.purpose === PURPOSE_TAG)

  if (existing) {
    console.log(`✓ SKIP — existing TaxRate found: ${existing.id}`)
    console.log(`  display_name: ${existing.display_name}`)
    console.log(`  description:  ${existing.description ?? '(none)'}`)
    console.log(`  percentage:   ${existing.percentage}%`)
    console.log(`  active:       ${existing.active}`)
    console.log('')
    console.log(`Set on Vercel: STRIPE_${mode.toUpperCase()}_TX_TAX_RATE_ID=${existing.id}`)
    process.exit(0)
  }

  console.log('[create-stripe-tax-rate] no existing rate; creating...')

  const created = await stripe.taxRates.create({
    display_name: DISPLAY_NAME,
    description: DESCRIPTION,
    percentage: TAX_PERCENTAGE,
    inclusive: false,                    // tax shown as separate line on invoice
    country: 'US',
    state: 'TX',
    jurisdiction: 'TX, USA',
    tax_type: 'sales_tax',
    active: true,
    metadata: {
      purpose: PURPOSE_TAG,
      derivation: 'rule_3_330_data_processing_80_pct_basis',
      jurisdiction_authority: 'Texas Comptroller',
      created_by_script: 'create-stripe-tax-rate.ts',
    },
  })

  console.log(`✓ CREATED — TaxRate id: ${created.id}`)

  // Verify-after-write (F6 discipline per B66.5 lesson). Retrieve back
  // + assert display_name + description + percentage landed. Silent
  // field truncation or drop by Stripe would defeat the audit-clarity
  // Q1 move.
  //
  // NOT asserted but worth manual Dashboard eyeball post-create:
  //   country, state, jurisdiction — these are IMMUTABLE on a TaxRate
  //   (Stripe doesn't allow patching them). A wrong value = recreate-
  //   and-archive, not patch. So the cost of a silent-mismatch on these
  //   is high; manual confirmation in Dashboard before any subscription
  //   is built on the rate is the discipline. (Smoke A includes this.)
  console.log('[create-stripe-tax-rate] verifying display_name + description landed...')
  const verify = await stripe.taxRates.retrieve(created.id)

  const mismatches: string[] = []
  if (verify.display_name !== DISPLAY_NAME) {
    mismatches.push(`display_name: expected="${DISPLAY_NAME}" actual="${verify.display_name}"`)
  }
  if (verify.description !== DESCRIPTION) {
    mismatches.push(`description: expected="${DESCRIPTION}" actual="${verify.description ?? '(null)'}"`)
  }
  if (Math.abs(verify.percentage - TAX_PERCENTAGE) > 0.001) {
    mismatches.push(`percentage: expected=${TAX_PERCENTAGE} actual=${verify.percentage}`)
  }
  if (mismatches.length > 0) {
    console.error('✗ VERIFY-AFTER-WRITE MISMATCH:')
    mismatches.forEach(m => console.error(`  - ${m}`))
    console.error('Stripe may have truncated/dropped fields. Investigate before relying on this rate.')
    process.exit(2)
  }

  console.log('✓ verify-after-write OK — display_name + description + percentage match')
  console.log('')
  console.log(`Set on Vercel: STRIPE_${mode.toUpperCase()}_TX_TAX_RATE_ID=${created.id}`)
}

main().catch(err => {
  console.error('[create-stripe-tax-rate] fatal:', err)
  process.exit(1)
})
