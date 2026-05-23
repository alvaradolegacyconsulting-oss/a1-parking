import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from './supabase-admin'

// B66.3 — Stripe event handlers, factored out of the webhook route so
// B66.5+'s out-of-band processor can lift them without rewriting the
// route. Today: inline-called from /api/stripe/webhook AFTER the event
// is persisted to stripe_events. When the processor arrives, the same
// handlers get called from there instead; the webhook collapses back
// to persist-only.
//
// Each handler is self-contained:
//   • Takes a fully-typed Stripe.Event (signature already verified)
//   • Returns { ok: true } | { ok: false; reason: string } — never throws
//   • Service-role Supabase client (bypasses RLS) for the DB writes
//   • Idempotency: re-running with the same event must produce the same
//     final state (or a no-op if state is already reached)
//
// Why no throws: the webhook route returns 200 OK for non-Stripe-fault
// failures (per B66.1 fail-closed pattern — don't trigger Stripe retry
// storms from our DB hiccups). Handlers report failure via the result
// object so the caller can log + ack without trapping exceptions.

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'starter' | 'growth' | 'legacy' | 'essential' | 'professional' | 'enterprise'
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

export type HandlerResult =
  | { ok: true; companyId: number }
  | { ok: false; reason: string }

export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
): Promise<HandlerResult> {
  const session = event.data.object
  const supabase = createSupabaseServiceClient()

  // ── Idempotency probe ──────────────────────────────────────────────
  // If a prior webhook delivery already created the company for this
  // session, the stripe_subscription_id on companies will match. Skip.
  const stripeSubId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null
  if (stripeSubId) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id')
      .eq('stripe_subscription_id', stripeSubId)
      .maybeSingle()
    if (existing) {
      return { ok: true, companyId: existing.id as number }
    }
  }

  // ── Read session metadata (set by /api/signup/create-checkout-session) ─
  const meta = session.metadata ?? {}
  const userId = meta.supabase_user_id
  const intendedTierJson = meta.intended_tier_json
  if (!userId || !intendedTierJson) {
    return { ok: false, reason: 'session metadata missing supabase_user_id or intended_tier_json' }
  }
  let intendedTier: IntendedTier
  try {
    intendedTier = JSON.parse(intendedTierJson) as IntendedTier
  } catch {
    return { ok: false, reason: 'session metadata intended_tier_json is not valid JSON' }
  }

  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null
  if (!stripeCustomerId || !stripeSubId) {
    return { ok: false, reason: 'session missing customer or subscription ID (incomplete checkout?)' }
  }

  // ── Resolve caller email (for user_roles.email) ────────────────────
  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(userId)
  if (authErr || !authUser?.user?.email) {
    return { ok: false, reason: `cannot resolve auth user ${userId}: ${authErr?.message ?? 'no email'}` }
  }
  const email = authUser.user.email.toLowerCase()

  // ── Company name uniqueness pre-check + auto-disambiguation ────────
  // Two users signing up with the same company name = collision. Try
  // the requested name first; if taken, append " (2)", " (3)", etc.
  let companyName = intendedTier.company_name.trim()
  for (let suffix = 2; suffix <= 100; suffix++) {
    const { data: exists } = await supabase
      .from('companies')
      .select('id')
      .ilike('name', companyName)
      .maybeSingle()
    if (!exists) break
    companyName = `${intendedTier.company_name.trim()} (${suffix})`
    if (suffix === 100) {
      return { ok: false, reason: `company name collision unresolvable after 100 attempts: ${intendedTier.company_name}` }
    }
  }

  // ── INSERT companies row ──────────────────────────────────────────
  // account_state='active' (no 'configuring' intermediate state — the
  // webhook IS the activation event). is_active=true mirrored per
  // P5.6 finding (legacy boolean coexists with account_state until B105
  // consolidates). acquisition_channel='self_serve' tags the channel
  // for B66.5+ welcome-email branching.
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .insert({
      name: companyName,
      tier_type: intendedTier.track,
      tier: intendedTier.tier,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubId,
      acquisition_channel: 'self_serve',
      account_state: 'active',
      is_active: true,
    })
    .select('id')
    .single()
  if (companyErr || !company) {
    return { ok: false, reason: `companies INSERT failed: ${companyErr?.message ?? 'unknown'}` }
  }
  const companyId = company.id as number

  // ── INSERT user_roles row (company_admin, no property scope) ───────
  // Matches B65 redeem_proposal_code pattern exactly.
  const { error: roleErr } = await supabase
    .from('user_roles')
    .insert({
      email,
      role: 'company_admin',
      company: companyName,
      property: [],
    })
  if (roleErr) {
    // Partial state: company created, no user_role. Manual reconciliation
    // required. Log + report; do NOT roll back the company INSERT (the
    // payment already cleared — the company exists in Stripe's world).
    console.error('[stripe-event-handlers] companies row created but user_roles INSERT failed', {
      companyId, email, error: roleErr.message,
    })
    return { ok: false, reason: `user_roles INSERT failed (company ${companyId} orphaned): ${roleErr.message}` }
  }

  // ── tos_acceptances attestation row was inserted at /signup/verify ─
  // time via /api/signup/attest — the attestation pre-dates payment per
  // the Option D refinement. Webhook does NOT insert here (would be
  // double-record). If the attestation row is missing, that's a B67
  // cleanup concern, not a webhook failure.

  return { ok: true, companyId }
}
