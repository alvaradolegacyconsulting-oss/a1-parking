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

// B66.4 — simpler shape for sync-only handlers (no companyId to return;
// the row already existed at event time).
export type SyncResult =
  | { ok: true }
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

// ════════════════════════════════════════════════════════════════════
// B66.4 handlers — Stripe Customer Portal sync
// ════════════════════════════════════════════════════════════════════
// Three handlers covering the Portal-driven change surface:
//   • customer.subscription.updated  — sync subscription state changes
//   • customer.subscription.deleted  — flip account_state to cancelled
//   • customer.updated               — sync billing address changes
//
// Common shape: look up companies row by stripe_subscription_id (or
// stripe_customer_id for the customer event); if no match, log + ack
// success (Stripe sub doesn't belong to us — likely an account that
// pre-dates B66.3 or was deleted in Stripe without webhook follow-up).
// All writes are idempotent UPDATEs. Event ordering doesn't matter at
// our scale; the final state of any sequence is the same regardless
// of arrival order.

/**
 * customer.subscription.updated handler.
 *
 * **This handler fires on more than admin-triggered events.** Stripe
 * sends customer.subscription.updated on invoice payment success/failure
 * as well — status transitions active ↔ past_due ↔ unpaid happen here
 * during normal billing cycles, not just during admin actions in the
 * Customer Portal. The handler treats all writes as idempotent UPDATEs
 * so this is by design — subscription_status will see writes during
 * normal billing cycles. B66.5 dunning logic will read these writes
 * downstream (e.g., scan for subscription_status='past_due' rows to
 * surface a billing-failed banner).
 */
export async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent,
): Promise<SyncResult> {
  const sub = event.data.object
  const supabase = createSupabaseServiceClient()

  // Find the companies row this subscription belongs to.
  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id, stripe_subscription_id, subscription_status')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for sub ${sub.id}: ${lookupErr.message}` }
  }
  if (!company) {
    // Unknown subscription — likely a pre-B66.3 account or a Stripe-side
    // sub created out-of-band. Log + ack; not our row to update.
    console.warn('[stripe-event-handlers] subscription.updated for unknown subscription_id', { subId: sub.id })
    return { ok: true }
  }

  // current_period_end lives on items (per-item period support landed in
  // a recent API version — the Subscription-level field was removed).
  // All our items share the same cycle (created together by /api/signup/
  // create-checkout-session), so reading items.data[0] is sufficient.
  // Stripe sends Unix seconds; convert to ISO for TIMESTAMPTZ.
  const firstItem = sub.items?.data?.[0]
  const currentPeriodEndIso = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : null

  const { error: updErr } = await supabase
    .from('companies')
    .update({
      subscription_status: sub.status,
      current_period_end: currentPeriodEndIso,
      cancel_at_period_end: sub.cancel_at_period_end,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for sub ${sub.id}: ${updErr.message}` }
  }

  return { ok: true }
}

/**
 * customer.subscription.deleted handler.
 *
 * Fires when a subscription is truly removed in Stripe — typically after
 * the period_end date if cancel_at_period_end=true was set earlier, OR
 * immediately if an admin deletes the subscription directly. Two-step
 * cancellation flow: the cancel-scheduled state arrives first via
 * subscription.updated (cancel_at_period_end=true, status=active); the
 * actual delete arrives later via this handler (status=canceled).
 *
 * Flips companies.account_state to 'cancelled' (British spelling per the
 * existing companies_account_state_valid CHECK). The 90-day reactivation
 * window (Cluster 7.8) is enforced at /login dispatch via
 * gateAccountState; no separate state needed.
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
): Promise<SyncResult> {
  const sub = event.data.object
  const supabase = createSupabaseServiceClient()

  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for sub ${sub.id}: ${lookupErr.message}` }
  }
  if (!company) {
    console.warn('[stripe-event-handlers] subscription.deleted for unknown subscription_id', { subId: sub.id })
    return { ok: true }
  }

  const { error: updErr } = await supabase
    .from('companies')
    .update({
      account_state: 'cancelled',
      subscription_status: 'canceled',  // Stripe's spelling on the status field
      cancel_at_period_end: false,       // No longer pending — already deleted
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for sub ${sub.id}: ${updErr.message}` }
  }

  return { ok: true }
}

/**
 * customer.updated handler.
 *
 * Fires when the customer record changes in Stripe — including billing
 * address edits made via the Customer Portal. Syncs the address into
 * companies for B110 Texas tax jurisdiction lookups and customer-
 * facing invoice display.
 *
 * Does NOT sync customer.name → companies.name. companies.name is the
 * internal identity used by RLS via get_my_company() + audit logs +
 * user_roles.company foreign-key-ish matching; renaming via Stripe-side
 * customer.name update could break a lot. Customer-facing invoice
 * display name lives on Stripe's customer.name; ShieldMyLot's internal
 * identity stays stable.
 */
export async function handleCustomerUpdated(
  event: Stripe.CustomerUpdatedEvent,
): Promise<SyncResult> {
  const customer = event.data.object
  const supabase = createSupabaseServiceClient()

  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id')
    .eq('stripe_customer_id', customer.id)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for customer ${customer.id}: ${lookupErr.message}` }
  }
  if (!company) {
    console.warn('[stripe-event-handlers] customer.updated for unknown customer_id', { customerId: customer.id })
    return { ok: true }
  }

  // Address may be null on the customer (Stripe permits no-address customers).
  // Sync the 5 fields atomically; missing sub-fields → NULL in DB.
  const addr = customer.address
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      address:             addr?.line1 ?? null,
      billing_city:        addr?.city ?? null,
      billing_state:       addr?.state ?? null,
      billing_postal_code: addr?.postal_code ?? null,
      billing_country:     addr?.country ?? null,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for customer ${customer.id}: ${updErr.message}` }
  }

  return { ok: true }
}
