import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import type { SyncResult, SkipResult } from './types'

/**
 * customer.subscription.deleted handler.
 *
 * Under B66.5 Decision 1 (B: mark-as-unpaid), Stripe NO LONGER fires
 * this event from retry exhaustion (subs land at 'unpaid' instead).
 * Remaining triggers:
 *   • Cron-driven API DELETE at day 14 of dunning grace (commit 3)
 *   • Customer cancellation via Customer Portal
 *   • Admin cancellation via Stripe Dashboard
 *
 * Flips companies.account_state to 'cancelled' (British spelling per the
 * existing companies_account_state_valid CHECK). The 90-day reactivation
 * window (Cluster 7.8) is enforced at /login dispatch via
 * gateAccountState; no separate state needed.
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
): Promise<SyncResult | SkipResult> {
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
    return { ok: true, skipped: true, reason: `unknown subscription_id ${sub.id}` }
  }

  const { error: updErr } = await supabase
    .from('companies')
    .update({
      account_state: 'cancelled',
      subscription_status: 'canceled',
      cancel_at_period_end: false,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for sub ${sub.id}: ${updErr.message}` }
  }

  return { ok: true }
}
