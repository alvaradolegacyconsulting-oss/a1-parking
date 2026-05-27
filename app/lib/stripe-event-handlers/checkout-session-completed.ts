import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import type { HandlerResult } from './types'

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'starter' | 'growth' | 'legacy' | 'essential' | 'professional' | 'enterprise'
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

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
