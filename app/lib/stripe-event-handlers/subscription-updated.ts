import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import { getStripeMode } from '../stripe'
import { PAST_DUE_GRACE_MS } from '../dunning-config'
import { sendDunningDay0, type DunningCompany } from '../dunning-emails'
import type { SyncResult, SkipResult } from './types'

/**
 * customer.subscription.updated handler.
 *
 * Fires on more than admin-triggered events. Stripe sends
 * customer.subscription.updated on invoice payment success/failure as
 * well — status transitions active ↔ past_due ↔ unpaid happen here
 * during normal billing cycles, not just during admin actions in the
 * Customer Portal. All writes are idempotent UPDATEs.
 *
 * B66.5 Decision 3 — DEFENSIVE UNPAID POPULATOR:
 * Under the locked "mark as unpaid" Stripe Dashboard config, retry
 * exhaustion lands subscription_status='unpaid'. Normally
 * invoice.payment_failed fires FIRST and populates past_due_since /
 * past_due_grace_until via that handler. But webhook ordering anomalies
 * + retroactive Stripe status changes can land 'unpaid' here with
 * past_due_since=NULL — without the defensive populator, the UI banner
 * (commit 4) would fail to fire for this path.
 */
export async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent,
): Promise<SyncResult | SkipResult> {
  const sub = event.data.object
  const supabase = createSupabaseServiceClient()

  // Find the companies row this subscription belongs to. SELECT extended
  // to include past_due_since + account_state for Decision 3 populator,
  // plus name + display_name + tier + tier_type + dunning_day0_sent_at
  // for commit 4.2's Day 0 email send from the populator path (H.1.a).
  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id, stripe_subscription_id, subscription_status, account_state, past_due_since, name, display_name, tier, tier_type, dunning_day0_sent_at')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for sub ${sub.id}: ${lookupErr.message}` }
  }
  if (!company) {
    console.warn('[stripe-event-handlers] subscription.updated for unknown subscription_id', { subId: sub.id })
    return { ok: true, skipped: true, reason: `unknown subscription_id ${sub.id}` }
  }

  // current_period_end lives on items (per-item period support landed in
  // a recent API version — the Subscription-level field was removed).
  const firstItem = sub.items?.data?.[0]
  const currentPeriodEndIso = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : null

  // ── B141 — resolve subscription → tier/tier_type via stripe_prices ──
  // Scope to the BASE line item's price ID. per_property and per_driver
  // items don't define tier; iterating them would risk picking the wrong
  // row. Custom-customer protection: stripe_prices.tier_track + tier_name
  // are NOT NULL on every row (standard catalog AND per-code rows from
  // B66.2b), so this same query resolves A1's negotiated Prices identically
  // to standard customers. No special-casing.
  //
  // Defensive: skip the tier write (log + continue) if lookup returns no
  // row. The non-tier columns (subscription_status etc) still UPDATE
  // successfully. Tagged prefix matches the existing
  // [subscription-updated-*] discipline at this handler.
  //
  // NOT FATAL by design: tier-write is additive on top of the required
  // status/period/cancel UPDATE. A fatal failure here would block that
  // required write and trigger Stripe webhook retries over an additive
  // concern — wrong shape for a webhook handler.
  const subPriceIds = (sub.items?.data ?? [])
    .map(it => it.price?.id)
    .filter((id): id is string => typeof id === 'string')

  let resolvedTier: { tier_track: string; tier_name: string } | null = null
  if (subPriceIds.length > 0) {
    const mode = getStripeMode()
    const { data: priceRow, error: priceErr } = await supabase
      .from('stripe_prices')
      .select('tier_track, tier_name')
      .in('stripe_price_id', subPriceIds)
      .eq('mode', mode)
      .eq('line_item', 'base')
      .maybeSingle()
    if (priceErr) {
      console.error('[B141-tier-lookup-failed]', {
        subId: sub.id, companyId: company.id, error: priceErr.message,
      })
    } else if (priceRow) {
      resolvedTier = { tier_track: priceRow.tier_track, tier_name: priceRow.tier_name }
    } else {
      // No base-line-item price match. Acceptable latent gap: if a sub's
      // base price ID isn't in stripe_prices (price created outside the
      // catalog / B66.2b reconciliation gap), tier silently won't update —
      // this log is the safety net. Fine for A1 (per-code prices ARE in
      // the table at issue time).
      console.warn('[B141-tier-no-match]', {
        subId: sub.id, companyId: company.id, subPriceIds, mode,
      })
    }
  }

  // Build the UPDATE payload — append tier columns only if resolved.
  // Allows the always-required subscription_status / period / cancel
  // UPDATE to land even when tier resolution fails (defensive degrade).
  const updatePayload: Record<string, unknown> = {
    subscription_status: sub.status,
    current_period_end: currentPeriodEndIso,
    cancel_at_period_end: sub.cancel_at_period_end,
  }
  if (resolvedTier) {
    updatePayload.tier = resolvedTier.tier_name        // companies.tier   ← B141
    updatePayload.tier_type = resolvedTier.tier_track  // companies.tier_type ← B141
  }

  const { error: updErr } = await supabase
    .from('companies')
    .update(updatePayload)
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for sub ${sub.id}: ${updErr.message}` }
  }

  // ── B141 — F6 verify-after-write for the tier columns ───────────────
  // Mirrors the [subscription-updated-populator-verify-mismatch] pattern
  // already used by the unpaid populator below. Non-fatal: tier write is
  // additive on top of the required UPDATE above. Tagged-log surfaces any
  // silent drift between intent and actual column state. Only runs when
  // we actually wrote tier — skips the no-match defensive path cleanly.
  if (resolvedTier) {
    const { data: verifyRow, error: verifyErr } = await supabase
      .from('companies')
      .select('tier, tier_type')
      .eq('id', company.id)
      .maybeSingle()
    if (verifyErr || !verifyRow) {
      console.error('[B141-tier-verify-mismatch]', {
        companyId: company.id, stage: 'read',
        error: verifyErr?.message ?? 'no row returned',
      })
    } else if (verifyRow.tier !== resolvedTier.tier_name
      || verifyRow.tier_type !== resolvedTier.tier_track) {
      console.error('[B141-tier-verify-mismatch]', {
        companyId: company.id, stage: 'column-check',
        expected: resolvedTier, actual: verifyRow,
      })
    }
  }

  // ── B66.5 Decision 3 — defensive unpaid populator ──────────────────
  // Should normally not trigger (invoice.payment_failed fires first).
  // Covers the webhook-ordering-anomaly edge case so the UI banner
  // (commit 4) reliably fires for any path that lands at 'unpaid'.
  //
  // Verify-after-write applies here per F6 discipline — this is new
  // code (not an extracted-as-is handler body covered by B134 deferral),
  // and edge-case paths are exactly the kind that silently break and
  // aren't caught for weeks. Verify failures use a tagged log prefix
  // ([subscription-updated-populator-verify-mismatch]) for monitoring.
  // Still non-fatal: the main subscription_status UPDATE above already
  // succeeded, so the webhook ack is honest.
  if (sub.status === 'unpaid' && company.past_due_since === null) {
    const nowIso = new Date().toISOString()
    const graceIso = new Date(Date.now() + PAST_DUE_GRACE_MS).toISOString()
    const { error: populateErr } = await supabase
      .from('companies')
      .update({
        account_state: 'past_due',
        past_due_since: nowIso,
        past_due_grace_until: graceIso,
      })
      .eq('id', company.id)
    if (populateErr) {
      console.error('[subscription-updated-populator-update-failed]', {
        companyId: company.id, error: populateErr.message,
      })
    } else {
      const { data: verifyRow, error: verifyErr } = await supabase
        .from('companies')
        .select('account_state, past_due_since, past_due_grace_until')
        .eq('id', company.id)
        .maybeSingle()
      if (verifyErr || !verifyRow) {
        console.error('[subscription-updated-populator-verify-mismatch]', {
          companyId: company.id,
          stage: 'read',
          error: verifyErr?.message ?? 'no row returned',
        })
      } else if (verifyRow.account_state !== 'past_due'
        || !verifyRow.past_due_since
        || !verifyRow.past_due_grace_until) {
        console.error('[subscription-updated-populator-verify-mismatch]', {
          companyId: company.id,
          stage: 'column-check',
          verifyRow,
        })
      } else {
        // B66.5 commit 4.2 (H.1.a lock) — Day 0 email send from populator.
        //
        // Fires when the populator successfully writes past_due (which
        // is exactly the moment we treat as "missed the invoice.payment_
        // failed webhook"). Without this, customers landing in past_due
        // via the populator path would never receive the Day 0
        // notification.
        //
        // alreadySent gate uses the dunning_day0_sent_at value from the
        // SELECT above. Same dedup gate as the invoice-payment-failed
        // handler — no double-send risk.
        const dunningCompany: DunningCompany = {
          id: company.id as number,
          name: String(company.name ?? ''),
          display_name: (company.display_name as string | null) ?? null,
          tier: (company.tier as string | null) ?? null,
          tier_type: (company.tier_type as string | null) ?? null,
        }
        const alreadySent = !!company.dunning_day0_sent_at
        try {
          await sendDunningDay0(dunningCompany, alreadySent, 'webhook', null /* no invoice.id from this path */)
        } catch (e) {
          console.error('[subscription-updated-populator-day0-orchestration-threw]', {
            companyId: company.id, error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }
  }

  return { ok: true }
}
