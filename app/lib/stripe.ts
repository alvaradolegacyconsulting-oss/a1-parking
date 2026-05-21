import 'server-only'
import Stripe from 'stripe'

// B66.1 — Stripe SDK singleton, mode-aware.
//
// Layer 1 of the three-layer dormancy architecture (Cluster 1.3 of B66
// architecture doc). STRIPE_MODE env var picks which keypair the SDK
// uses. Module-level lazy init — Stripe instance constructed on first
// import + cached. Mode value is captured at module load and never
// changes for the lifetime of the process; Vercel deploys a new
// container when env vars change.
//
// Layers 2 + 3 (stripe_billing_enabled + public_signup_open) gate
// USAGE of this SDK; SDK existence is independent. Importing this file
// is harmless even when billing is disabled.

export type StripeMode = 'test' | 'live'

const STRIPE_MODE_RAW = process.env.STRIPE_MODE

function resolveMode(): StripeMode {
  if (STRIPE_MODE_RAW !== 'test' && STRIPE_MODE_RAW !== 'live') {
    throw new Error(
      `[stripe] STRIPE_MODE must be 'test' or 'live' (got: ${JSON.stringify(STRIPE_MODE_RAW)}). ` +
      `Configure on Vercel before deploy. Fails-closed by design.`
    )
  }
  return STRIPE_MODE_RAW
}

function resolveSecretKey(mode: StripeMode): string {
  const key = mode === 'test'
    ? process.env.STRIPE_TEST_SECRET_KEY
    : process.env.STRIPE_LIVE_SECRET_KEY
  if (!key) {
    throw new Error(
      `[stripe] Missing ${mode === 'test' ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'} ` +
      `for STRIPE_MODE='${mode}'. Configure on Vercel before deploy.`
    )
  }
  return key
}

// Pinned to the Stripe API version the installed SDK (stripe@22.1.1)
// natively targets. Don't float — drift risk if SDK auto-bumps. When
// the SDK upgrades, surface the new dated version explicitly here and
// in the B66.1 memory file.
const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

let _stripe: Stripe | null = null
let _mode: StripeMode | null = null

function init(): { stripe: Stripe; mode: StripeMode } {
  if (_stripe && _mode) return { stripe: _stripe, mode: _mode }
  const mode = resolveMode()
  const secretKey = resolveSecretKey(mode)
  _stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION })
  _mode = mode
  return { stripe: _stripe, mode: _mode }
}

export function getStripe(): Stripe {
  return init().stripe
}

export function getStripeMode(): StripeMode {
  return init().mode
}

export { STRIPE_API_VERSION }
