import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import { getStripe } from '../stripe'
import type { HandlerResult } from './types'

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'starter' | 'growth' | 'legacy' | 'essential' | 'professional' | 'enterprise'
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

// ════════════════════════════════════════════════════════════════════
// B152 — eager-populate the 8 fields normally written by sibling
// handlers (customer.subscription.created/updated, customer.updated).
// Removes dependency on Stripe webhook arrival order — the row lands
// with all 16 fields populated at INSERT/UPDATE time, regardless of
// whether sibling events have arrived yet.
//
// Sibling handlers (handleSubscriptionUpdated, handleCustomerUpdated)
// remain wired (B151 dispatch entry + existing entries). They become
// idempotent UPDATE-on-match: when they arrive after eager-populate,
// they overwrite with the same values (no-op state-wise). When they
// arrive before checkout.session.completed has INSERTed the row, they
// SKIP cleanly (no harm — eager will fill on INSERT). The race is
// neutralized by construction.
//
// Graceful degradation: Stripe API retrieve calls are wrapped. If the
// API hiccups, fields fall back to null and the INSERT still lands
// with the core 8 fields. Sibling handlers will backfill from the
// actual webhook events when those events fire. Worst case = current
// pre-B152 behavior, which is the safety floor.
// ════════════════════════════════════════════════════════════════════
interface EagerFields {
  subscription_status: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean | null
  address: string | null
  billing_city: string | null
  billing_state: string | null
  billing_postal_code: string | null
  billing_country: string | null
}
const EAGER_NULL: EagerFields = {
  subscription_status: null,
  current_period_end: null,
  cancel_at_period_end: null,
  address: null,
  billing_city: null,
  billing_state: null,
  billing_postal_code: null,
  billing_country: null,
}

async function fetchEagerFields(
  stripeSubId: string,
  stripeCustomerId: string,
): Promise<EagerFields> {
  try {
    const stripe = getStripe()
    const [sub, customer] = await Promise.all([
      stripe.subscriptions.retrieve(stripeSubId, { expand: ['items.data'] }),
      stripe.customers.retrieve(stripeCustomerId),
    ])
    // current_period_end lives on items.data[0] per the API version that
    // moved it off the Subscription root. Mirrors subscription-updated.ts.
    const firstItem = sub.items?.data?.[0]
    const cpeIso = firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000).toISOString()
      : null
    // Customer may rarely come back as a DeletedCustomer if the customer
    // was deleted between session completion and our retrieve. Type-narrow.
    const addr = ('address' in customer && !('deleted' in customer && customer.deleted))
      ? customer.address
      : null
    return {
      subscription_status: sub.status,
      current_period_end: cpeIso,
      cancel_at_period_end: sub.cancel_at_period_end,
      address: addr?.line1 ?? null,
      billing_city: addr?.city ?? null,
      billing_state: addr?.state ?? null,
      billing_postal_code: addr?.postal_code ?? null,
      billing_country: addr?.country ?? null,
    }
  } catch (e) {
    // Graceful degradation per Jose's build discipline: don't let a Stripe
    // API hiccup abort the whole INSERT. Sibling handlers backfill.
    console.error('[checkout-session-completed] B152 eager-populate Stripe retrieve failed — falling back to null fields; sibling handlers will backfill:', (e as Error).message)
    return EAGER_NULL
  }
}

export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
): Promise<HandlerResult> {
  const session = event.data.object
  const supabase = createSupabaseServiceClient()

  // ── Idempotency probe ──────────────────────────────────────────────
  // If a prior webhook delivery already updated/created the company for
  // this session, the stripe_subscription_id on companies will match. Skip.
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

  // ── B66.7 — proposal-code discriminator ─────────────────────────────
  // Two code paths share this handler, distinguished by session.metadata:
  //   • proposal_code_id PRESENT → company already created by
  //     redeem_proposal_code RPC; webhook UPDATEs existing companies row
  //     with stripe_customer_id + stripe_subscription_id.
  //   • proposal_code_id ABSENT → self-serve path (existing B66.3
  //     behavior); webhook CREATES new companies row + user_roles row.
  // The proposal-code path's metadata is set in
  // app/api/proposal-codes/start-billing/route.ts at Checkout Session
  // create time.
  const meta = session.metadata ?? {}
  const proposalCodeIdRaw = meta.proposal_code_id
  if (proposalCodeIdRaw) {
    return handleProposalCodeCompletion(supabase, session, proposalCodeIdRaw, stripeSubId)
  }

  // ── Read session metadata (set by /api/signup/create-checkout-session) ─
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

  // ── B152 eager-populate ──────────────────────────────────────────
  // Retrieve sub + customer from Stripe API BEFORE the INSERT so we
  // can land all 16 fields atomically. See the header block above for
  // the race-neutralization rationale.
  const eager = await fetchEagerFields(stripeSubId, stripeCustomerId)

  // ── INSERT companies row ──────────────────────────────────────────
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
      // B152 — race-resistant initial state.
      subscription_status: eager.subscription_status,
      current_period_end: eager.current_period_end,
      cancel_at_period_end: eager.cancel_at_period_end,
      address: eager.address,
      billing_city: eager.billing_city,
      billing_state: eager.billing_state,
      billing_postal_code: eager.billing_postal_code,
      billing_country: eager.billing_country,
    })
    .select('id, subscription_status, current_period_end, cancel_at_period_end, address, billing_city, billing_state, billing_postal_code, billing_country')
    .single()
  if (companyErr || !company) {
    return { ok: false, reason: `companies INSERT failed: ${companyErr?.message ?? 'unknown'}` }
  }
  const companyId = company.id as number

  // Verify-after-write per F6 — eager fields should round-trip.
  // Mismatch indicates DB-side weirdness; log but continue (sibling
  // handlers will overwrite with the canonical Stripe values).
  for (const k of ['subscription_status','current_period_end','cancel_at_period_end','address','billing_city','billing_state','billing_postal_code','billing_country'] as const) {
    if (eager[k] !== (company as Record<string, unknown>)[k]) {
      console.error('[checkout-session-completed] B152 verify mismatch', { companyId, field: k, expected: eager[k], actual: (company as Record<string, unknown>)[k] })
    }
  }

  // ── INSERT user_roles row (company_admin, no property scope) ───────
  const { error: roleErr } = await supabase
    .from('user_roles')
    .insert({
      email,
      role: 'company_admin',
      company: companyName,
      property: [],
    })
  if (roleErr) {
    console.error('[stripe-event-handlers] companies row created but user_roles INSERT failed', {
      companyId, email, error: roleErr.message,
    })
    return { ok: false, reason: `user_roles INSERT failed (company ${companyId} orphaned): ${roleErr.message}` }
  }

  return { ok: true, companyId }
}

// ════════════════════════════════════════════════════════════════════
// B66.7 — proposal-code completion path
// ════════════════════════════════════════════════════════════════════
// Discriminator: session.metadata.proposal_code_id present.
//
// At this point the company already exists (created by
// redeem_proposal_code RPC at /signup/redeem/verify submit-time, with
// account_state='active', user_roles row attached, ToS captured).
// Webhook's job is narrow: attach Stripe IDs to the existing companies
// row. No company creation, no user_roles creation, no name
// disambiguation — those all happened before Checkout was even reached.
//
// Verify-after-write (per B66.5 F6 discipline): re-SELECT the updated
// columns to confirm the UPDATE landed. A silent UPDATE failure here
// would leave A1 paying via Stripe but with no DB linkage — invisible
// until B66.4 Portal embed renders blank or dunning can't find them.
async function handleProposalCodeCompletion(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  session: Stripe.Checkout.Session,
  proposalCodeIdRaw: string,
  stripeSubId: string | null,
): Promise<HandlerResult> {
  const proposalCodeId = Number(proposalCodeIdRaw)
  if (!Number.isInteger(proposalCodeId)) {
    return { ok: false, reason: `metadata.proposal_code_id is not an integer: ${proposalCodeIdRaw}` }
  }

  const companyIdRaw = session.metadata?.company_id
  if (!companyIdRaw) {
    return { ok: false, reason: 'metadata missing company_id (proposal-code path requires it)' }
  }
  const companyId = Number(companyIdRaw)
  if (!Number.isInteger(companyId)) {
    return { ok: false, reason: `metadata.company_id is not an integer: ${companyIdRaw}` }
  }

  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null
  if (!stripeCustomerId || !stripeSubId) {
    return { ok: false, reason: 'session missing customer or subscription ID (incomplete checkout?)' }
  }

  // ── B152 eager-populate (proposal-code path) ───────────────────────
  // Same rationale as the self-serve branch: race-resistant initial state.
  // A1's actual production path is proposal-code, so this branch is the
  // load-bearing one for the first real customer.
  const eager = await fetchEagerFields(stripeSubId, stripeCustomerId)

  // ── UPDATE the existing companies row with Stripe IDs + eager fields ─
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubId,
      // B152 — race-resistant initial state.
      subscription_status: eager.subscription_status,
      current_period_end: eager.current_period_end,
      cancel_at_period_end: eager.cancel_at_period_end,
      address: eager.address,
      billing_city: eager.billing_city,
      billing_state: eager.billing_state,
      billing_postal_code: eager.billing_postal_code,
      billing_country: eager.billing_country,
    })
    .eq('id', companyId)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for proposal-code path (company ${companyId}): ${updErr.message}` }
  }

  // ── Verify-after-write (F6 discipline) ─────────────────────────────
  // RLS bypass via service_role makes this a straight SELECT; the silent
  // failure mode we're guarding is "UPDATE matched zero rows" (e.g.,
  // company_id from metadata doesn't exist), which Postgres reports as
  // success on the UPDATE call itself.
  const { data: verify, error: verifyErr } = await supabase
    .from('companies')
    .select('id, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, cancel_at_period_end, address, billing_city, billing_state, billing_postal_code, billing_country')
    .eq('id', companyId)
    .maybeSingle()
  if (verifyErr || !verify) {
    return { ok: false, reason: `verify-after-write failed (company ${companyId}): ${verifyErr?.message ?? 'row not found'}` }
  }
  if (verify.stripe_customer_id !== stripeCustomerId || verify.stripe_subscription_id !== stripeSubId) {
    return {
      ok: false,
      reason: `verify-after-write mismatch: expected customer=${stripeCustomerId} sub=${stripeSubId}, got customer=${verify.stripe_customer_id} sub=${verify.stripe_subscription_id}`,
    }
  }
  // B152 — verify-after-write on the eager fields. Log but don't fail
  // (sibling handlers will overwrite).
  for (const k of ['subscription_status','current_period_end','cancel_at_period_end','address','billing_city','billing_state','billing_postal_code','billing_country'] as const) {
    if (eager[k] !== (verify as Record<string, unknown>)[k]) {
      console.error('[checkout-session-completed] B152 proposal-code verify mismatch', { companyId, field: k, expected: eager[k], actual: (verify as Record<string, unknown>)[k] })
    }
  }

  console.log('[stripe-event-handlers] proposal-code completion linked', {
    companyId, proposalCodeId, stripeCustomerId, stripeSubId,
  })
  return { ok: true, companyId }
}
