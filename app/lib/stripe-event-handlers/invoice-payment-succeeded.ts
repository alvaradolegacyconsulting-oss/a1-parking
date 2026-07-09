import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import { sendDunningRecovery, type DunningCompany } from '../dunning-emails'
import { reconcileAtRenewal } from '../stripe-mutations'
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

  // Extended SELECT (commit 4.2) — adds name + display_name + tier +
  // tier_type for sendDunningRecovery's DunningCompany shape +
  // dunning_recovery_sent_at for the dedup gate.
  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id, account_state, name, display_name, tier, tier_type, dunning_recovery_sent_at')
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

  // ── B147 3c — renewal-trim branch ──────────────────────────────────
  // Fires INDEPENDENT of the recovery path below. Active customers
  // also need cycle-boundary quantity reconciliation, so this branch
  // runs BEFORE the skip-on-active gate.
  //
  // Mandatory billing_reason='subscription_cycle' gate: this webhook
  // also fires on subscription_create (signup) and subscription_update
  // (proration / quantity charges). Trimming on either would
  // prematurely true-up before the cycle has actually closed.
  //
  // send_invoice short-circuit lives in the helper (COMMIT 2.1's
  // fail-safe allowlist). This branch doesn't repeat the check — the
  // helper returns empty actions for non-charge_automatically subs,
  // logged as [B147-skipped-manual-collection].
  //
  // Non-fatal: helper failures log via tagged prefix and don't block
  // the recovery write below or fail the webhook ack. Helper is itself
  // bidirectional + idempotent (target === item.quantity → noop), so
  // double-firing on Stripe retries is safe.
  //
  // Co-fire composition (past_due/suspended + cycle): both this trim
  // branch AND the recovery branch fire in the same handler invocation.
  // They touch different layers (trim: Stripe sub items; recovery: DB
  // companies row + dunning state) — no shared mutation, no ordering
  // dependency. Trim-first ordering is deliberate: non-fatal trim
  // failure doesn't block the load-bearing recovery write.
  if (invoice.billing_reason === 'subscription_cycle') {
    const trimResult = await reconcileAtRenewal(company.id as number)
    if (trimResult.ok) {
      console.log('[B147-renewal-trim]', {
        companyId: company.id, billingReason: invoice.billing_reason,
        invoiceId: invoice.id, actions: trimResult.actions,
      })
    } else {
      console.error('[B147-renewal-trim-failed]', {
        companyId: company.id, billingReason: invoice.billing_reason,
        invoiceId: invoice.id, reason: trimResult.reason,
      })
    }
  }

  // Skip when in 'active' (normal successful payment, no recovery
  // needed), 'configuring' (signup mid-flight), or 'cancelled' (terminal).
  // Only past_due + suspended need the recovery path.
  if (company.account_state !== 'past_due' && company.account_state !== 'suspended') {
    return { ok: true, skipped: true, reason: `account_state '${company.account_state}', no recovery needed` }
  }

  const previousState = company.account_state

  // RECOVERY — clear all dunning timestamps, flip back to active.
  //
  // commit 4.2 extension: also clear the 6 dunning_*_sent_at dedup
  // columns so a future relapse re-fires the email sequence cleanly
  // (Pattern A recovery semantics per the locked greenlight).
  // dunning_cancellation_sent_at is included for completeness even
  // though the cancelled state is technically terminal — a recovery
  // arriving here means we're back to active, and we want the sequence
  // armed for any future relapse.
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      account_state: 'active',
      past_due_since: null,
      past_due_grace_until: null,
      suspension_since: null,
      suspension_grace_until: null,
      dunning_day0_sent_at: null,
      dunning_day3_sent_at: null,
      dunning_day5_sent_at: null,
      dunning_day7_sent_at: null,
      dunning_recovery_sent_at: null,
      dunning_cancellation_sent_at: null,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for ${company.id}: ${updErr.message}` }
  }

  // Verify-after-write — F6 discipline. Extended to 11 columns: the
  // original 5 (account_state + 4 grace timestamps) + the 6 dunning
  // dedup columns. All 6 dedup columns must verify as NULL post-clear
  // so the next relapse sequence fires from a clean slate.
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('companies')
    .select('account_state, past_due_since, past_due_grace_until, suspension_since, suspension_grace_until, dunning_day0_sent_at, dunning_day3_sent_at, dunning_day5_sent_at, dunning_day7_sent_at, dunning_recovery_sent_at, dunning_cancellation_sent_at')
    .eq('id', company.id)
    .maybeSingle()
  if (verifyErr || !verifyRow) {
    return { ok: false, reason: `verify-after-write read failed for ${company.id}: ${verifyErr?.message ?? 'no row'}` }
  }
  if (verifyRow.account_state !== 'active'
    || verifyRow.past_due_since !== null
    || verifyRow.past_due_grace_until !== null
    || verifyRow.suspension_since !== null
    || verifyRow.suspension_grace_until !== null
    || verifyRow.dunning_day0_sent_at !== null
    || verifyRow.dunning_day3_sent_at !== null
    || verifyRow.dunning_day5_sent_at !== null
    || verifyRow.dunning_day7_sent_at !== null
    || verifyRow.dunning_recovery_sent_at !== null
    || verifyRow.dunning_cancellation_sent_at !== null) {
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

  // B66.5 commit 4.2 — Recovery email send.
  //
  // Pattern Y per locked greenlight: email send happens AFTER the DB
  // writes commit. Send failures are non-blocking (H.4 fail-soft).
  //
  // alreadySent gate: passes false because we just cleared
  // dunning_recovery_sent_at in the UPDATE above. The dedup gate in
  // dispatchStage is belt-and-suspenders for any future code path that
  // reaches this handler without the clear.
  //
  // Recovery fires on BOTH automatic retry success AND manual Portal
  // pay (H.3 lock): single template covers both paths.
  const dunningCompany: DunningCompany = {
    id: company.id as number,
    name: String(company.name ?? ''),
    display_name: (company.display_name as string | null) ?? null,
    tier: (company.tier as string | null) ?? null,
    tier_type: (company.tier_type as string | null) ?? null,
  }
  try {
    await sendDunningRecovery(dunningCompany, /* alreadySent */ false, invoice.id ?? null, previousState)
  } catch (e) {
    console.error('[invoice-payment-succeeded] recovery email orchestration threw', {
      companyId: company.id, error: e instanceof Error ? e.message : String(e),
    })
  }

  return { ok: true }
}
