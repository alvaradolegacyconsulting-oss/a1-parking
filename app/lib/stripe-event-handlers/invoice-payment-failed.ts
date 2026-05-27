import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import { PAST_DUE_GRACE_MS } from '../dunning-config'
import type { SyncResult, SkipResult } from './types'

/**
 * invoice.payment_failed handler — B66.5 commit 2.
 *
 * First payment failure flips account_state active → past_due and starts
 * the 7-day grace clock. Subsequent retry failures arrive here while
 * already past_due (or suspended after day 7) — those are no-op skips
 * (idempotent; the grace clock doesn't reset on each retry).
 *
 * Verify-after-write per F6 discipline: SELECT the row back after UPDATE
 * to confirm the columns landed before claiming success.
 *
 * Recovery (payment eventually succeeds) is handled by the sibling
 * invoice-payment-succeeded handler.
 */
export async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent,
): Promise<SyncResult | SkipResult> {
  const invoice = event.data.object
  const supabase = createSupabaseServiceClient()

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id ?? null
  if (!customerId) {
    return { ok: true, skipped: true, reason: 'invoice has no customer (likely a non-subscription invoice)' }
  }

  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id, account_state, past_due_since')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for customer ${customerId}: ${lookupErr.message}` }
  }
  if (!company) {
    return { ok: true, skipped: true, reason: `no company for stripe_customer_id ${customerId}` }
  }

  // Skip if already in dunning lifecycle. First failure flips active →
  // past_due; subsequent retries find account_state already past_due (or
  // already moved to suspended/cancelled by the cron) — no-op.
  if (company.account_state !== 'active') {
    return { ok: true, skipped: true, reason: `account_state already '${company.account_state}', no-op` }
  }

  const nowIso = new Date().toISOString()
  const graceIso = new Date(Date.now() + PAST_DUE_GRACE_MS).toISOString()

  const { error: updErr } = await supabase
    .from('companies')
    .update({
      account_state: 'past_due',
      past_due_since: nowIso,
      past_due_grace_until: graceIso,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for ${company.id}: ${updErr.message}` }
  }

  // Verify-after-write — F6 discipline. Confirm columns actually landed
  // before claiming success. RLS gates + service-role bypass + a stale
  // cached row could all silently break the UPDATE; verify catches it.
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('companies')
    .select('account_state, past_due_since, past_due_grace_until')
    .eq('id', company.id)
    .maybeSingle()
  if (verifyErr || !verifyRow) {
    return { ok: false, reason: `verify-after-write read failed for ${company.id}: ${verifyErr?.message ?? 'no row'}` }
  }
  if (verifyRow.account_state !== 'past_due'
    || !verifyRow.past_due_since
    || !verifyRow.past_due_grace_until) {
    return {
      ok: false,
      reason: `verify-after-write mismatch for ${company.id}: ${JSON.stringify(verifyRow)}`,
    }
  }

  // Audit log — captures the lifecycle transition for forensic review +
  // operator visibility. action='BILLING_STATE_PAST_DUE' follows the
  // UPPERCASE convention used by other billing-related audit entries.
  await supabase.from('audit_logs').insert({
    user_email: 'system@stripe-webhook',
    action: 'BILLING_STATE_PAST_DUE',
    table_name: 'companies',
    record_id: String(company.id),
    new_values: {
      account_state: 'past_due',
      past_due_since: nowIso,
      past_due_grace_until: graceIso,
      stripe_invoice_id: invoice.id,
      stripe_customer_id: customerId,
    },
  })

  return { ok: true }
}
