import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import type { SyncResult, SkipResult } from './types'

/**
 * invoice.payment_action_required handler — B66.5 commit 2.
 *
 * Fires when SCA (Strong Customer Authentication — e.g., 3D Secure)
 * is required to complete a payment. The subscription stays in its
 * current state (likely 'active' with the invoice 'open'); no state
 * change happens here. The customer must complete authentication via
 * Stripe's hosted invoice URL to proceed.
 *
 * Informational handler: writes an audit log entry for operator
 * visibility. Commit 4 will add a Resend email prompting the customer
 * to complete authentication via the Customer Portal.
 *
 * No verify-after-write needed (no state change). Audit log failure is
 * non-fatal (informational handler shouldn't block the webhook ack).
 */
export async function handleInvoicePaymentActionRequired(
  event: Stripe.InvoicePaymentActionRequiredEvent,
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
    .select('id')
    .eq('stripe_customer_id', customerId)
    // Seed/Wipe Layer 1 — belt-and-suspenders (see customer-updated.ts).
    .eq('company_env', 'production')
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for customer ${customerId}: ${lookupErr.message}` }
  }
  if (!company) {
    return { ok: true, skipped: true, reason: `no company for stripe_customer_id ${customerId}` }
  }

  // Audit log captures the SCA-required event. Non-fatal — log + return
  // ok even if audit write fails (informational; not a state change).
  const { error: auditErr } = await supabase.from('audit_logs').insert({
    user_email: 'system@stripe-webhook',
    action: 'STRIPE_PAYMENT_ACTION_REQUIRED',
    table_name: 'companies',
    record_id: String(company.id),
    new_values: {
      stripe_invoice_id: invoice.id,
      stripe_customer_id: customerId,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
      amount_due: invoice.amount_due ?? null,
    },
  })
  if (auditErr) {
    console.error('[invoice-payment-action-required] audit log insert failed', {
      companyId: company.id, error: auditErr.message,
    })
    // Non-fatal — informational handler doesn't block ack on audit failure.
  }

  return { ok: true }
}
