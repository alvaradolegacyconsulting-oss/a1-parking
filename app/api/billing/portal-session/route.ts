import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { getStripe, getStripeMode } from '../../../lib/stripe'

// B66.4 — Stripe Customer Portal session creator. Called from the
// /company_admin Billing tab "Manage Billing" button. Authenticated
// company_admin only; pulls stripe_customer_id from the user's
// company row; passes the explicit Portal configuration_id (per
// pre-flight counter-proposal B.2 — sourced from env, not from
// Stripe's "default" config which can drift).
//
// Returns { url } JSON so the client redirects via window.location.href.
// (Cleaner than 303 for the Billing-tab button-click pattern; the
// /api/signup/create-checkout-session 303-redirect pattern was driven
// by form-submit semantics that don't apply here.)
//
// ── AUTH MODEL ──────────────────────────────────────────────────────
// • requireAuthenticated session via cookie-bound supabase client
// • user_roles row must have role='company_admin'
// • stripe_customer_id resolved from companies table (NOT from user
//   profile — multi-admin companies share one Stripe Customer)
//
// ── FAILURE MODE CONTRACT ───────────────────────────────────────────
//   • Auth missing → 401
//   • Wrong role → 403
//   • No company / no stripe_customer_id → 404 (informative message)
//   • STRIPE_PORTAL_CONFIG_ID env var unset → 503 (deploy gap)
//   • Stripe API failure → 502
//
// ── MIDDLEWARE NOTE ─────────────────────────────────────────────────
// This route is NOT in middleware.ts publicPaths. Middleware will
// redirect anon→/login at the edge; authenticated calls flow through
// to this handler which then re-validates role + company ownership.
// Confirmed correct posture during commit 2 audit-pass per pre-flight
// ask E.1 + feedback_middleware_public_paths_allowlist.

export const runtime = 'nodejs'
export const maxDuration = 30

function resolvePortalConfigId(mode: 'test' | 'live'): string | null {
  const varName = mode === 'test'
    ? 'STRIPE_TEST_PORTAL_CONFIG_ID'
    : 'STRIPE_LIVE_PORTAL_CONFIG_ID'
  return process.env[varName] || null
}

export async function POST() {
  // ── Auth ─────────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (roleRow.role !== 'company_admin') {
    return NextResponse.json({ error: 'company_admin required' }, { status: 403 })
  }
  if (!roleRow.company) {
    return NextResponse.json({ error: 'no company associated with this account' }, { status: 404 })
  }

  // ── Resolve stripe_customer_id from companies ────────────────────
  const { data: companyRow, error: companyErr } = await supabase
    .from('companies')
    .select('id, stripe_customer_id')
    .ilike('name', roleRow.company)
    .single()
  if (companyErr || !companyRow) {
    return NextResponse.json({ error: 'company not found' }, { status: 404 })
  }
  if (!companyRow.stripe_customer_id) {
    return NextResponse.json(
      { error: 'no Stripe customer linked to this company — billing portal unavailable' },
      { status: 404 }
    )
  }

  // ── Resolve Portal config + create session ───────────────────────
  const mode = getStripeMode()
  const portalConfigId = resolvePortalConfigId(mode)
  if (!portalConfigId) {
    return NextResponse.json(
      {
        error: `STRIPE_${mode.toUpperCase()}_PORTAL_CONFIG_ID is not set. ` +
               `Run scripts/configure-stripe-portal.ts in ${mode} mode and add the returned config_id to Vercel.`,
      },
      { status: 503 }
    )
  }

  const stripe = getStripe()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: companyRow.stripe_customer_id,
      configuration: portalConfigId,
      return_url: `${origin}/company_admin?tab=billing&from=portal`,
    })
    if (!session.url) {
      return NextResponse.json({ error: 'Stripe returned a Portal session without a URL' }, { status: 502 })
    }
    return NextResponse.json({ url: session.url })
  } catch (e) {
    return NextResponse.json(
      { error: 'Stripe Portal session create failed: ' + (e as Error).message },
      { status: 502 }
    )
  }
}
