import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import type { SyncResult, SkipResult } from './types'

/**
 * invoice.payment_succeeded handler — B66.5 commit 2.
 *
 * Recovery path. Fires on normal successful payments (active accounts —
 * no-op skip) AND on successful retries within the dunning grace window
 * (past_due or suspended → recovery: clears all dunning timestamps +
 * flips account_state back to active).
 *
 * Stripe's "mark as unpaid" config (locked Decision 1B) stops automatic
 * retries after 8 attempts over 2 weeks — but a customer can still pay
 * the invoice manually via the Customer Portal even after retries are
 * exhausted, which fires invoice.payment_succeeded here. So this
 * handler covers both: automatic recovery (retry success during grace)
 * and manual recovery (customer self-cures via Portal).
 *
 * Verify-after-write per F6 discipline.
 *
 * Cancelled accounts cannot recover via this path (cancelled is
 * terminal — reactivation requires new signup). Skipped if reached.
 */
export async function handleInvoicePaymentSucceeded(
  event: Stripe.InvoicePaymentSucceededEvent,
): Promise<SyncResult | SkipResult> {
  const invoice = event.data.object
  const supabase = createSupabaseServiceClient()

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id ?? null
  if (!customerId) {
    return { ok: true, skipped: true, reason: 'invoice has no customer' }
  }

  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id, account_state')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for customer ${customerId}: ${lookupErr.message}` }
  }
  if (!company) {
    return { ok: true, skipped: true, reason: `no company for stripe_customer_id ${customerId}` }
  }

  // Skip when in 'active' (normal successful payment, no recovery
  // needed), 'configuring' (signup mid-flight), or 'cancelled' (terminal).
  // Only past_due + suspended need the recovery path.
  if (company.account_state !== 'past_due' && company.account_state !== 'suspended') {
    return { ok: true, skipped: true, reason: `account_state '${company.account_state}', no recovery needed` }
  }

  const previousState = company.account_state

  // RECOVERY — clear all dunning timestamps, flip back to active.
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      account_state: 'active',
      past_due_since: null,
      past_due_grace_until: null,
      suspension_since: null,
      suspension_grace_until: null,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for ${company.id}: ${updErr.message}` }
  }

  // Verify-after-write — F6 discipline.
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('companies')
    .select('account_state, past_due_since, past_due_grace_until, suspension_since, suspension_grace_until')
    .eq('id', company.id)
    .maybeSingle()
  if (verifyErr || !verifyRow) {
    return { ok: false, reason: `verify-after-write read failed for ${company.id}: ${verifyErr?.message ?? 'no row'}` }
  }
  if (verifyRow.account_state !== 'active'
    || verifyRow.past_due_since !== null
    || verifyRow.past_due_grace_until !== null
    || verifyRow.suspension_since !== null
    || verifyRow.suspension_grace_until !== null) {
    return {
      ok: false,
      reason: `verify-after-write mismatch for ${company.id}: ${JSON.stringify(verifyRow)}`,
    }
  }

  // Audit log — captures the recovery transition. previous_state field
  // distinguishes "past_due recovered before suspension" from "suspended
  // recovered before cancellation" for operator visibility.
  await supabase.from('audit_logs').insert({
    user_email: 'system@stripe-webhook',
    action: 'BILLING_STATE_RECOVERED',
    table_name: 'companies',
    record_id: String(company.id),
    new_values: {
      account_state: 'active',
      previous_state: previousState,
      stripe_invoice_id: invoice.id,
      stripe_customer_id: customerId,
    },
  })

  return { ok: true }
}
