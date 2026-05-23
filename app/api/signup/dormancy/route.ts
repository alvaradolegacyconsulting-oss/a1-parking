import { NextResponse } from 'next/server'
import { getStripeBillingEnabled, getPublicSignupOpen } from '../../../lib/platform-flags'

// B66.3 — anonymous dormancy probe for /signup page render decision.
// Returns { open: true } only when BOTH stripe_billing_enabled AND
// public_signup_open are true. Either off → { open: false } and the
// page renders the B65.2-style "Coming soon" placeholder instead of
// the tier picker form. Avoids client-side platform_settings RLS
// coupling; service-role read happens here.
//
// No auth required — this is what /signup checks BEFORE the user
// reaches the auth-gated flow. Leaks no sensitive data (just whether
// the public signup path is live).

export const runtime = 'nodejs'

export async function GET() {
  const [billing, signup] = await Promise.all([
    getStripeBillingEnabled(),
    getPublicSignupOpen(),
  ])
  return NextResponse.json({ open: billing && signup })
}
