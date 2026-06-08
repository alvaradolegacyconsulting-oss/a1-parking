import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'
import { getStripe, getStripeMode } from './stripe'

// B147 — shared Stripe-mutation helper.
//
// Defer-to-renewal route per locked design (June 7):
//
//   • syncOnAdd — fired from CA-portal property/driver INSERT and
//     reactivation paths AFTER DB write succeeds. Increments the
//     relevant line item only when activeCount > current Stripe
//     quantity. With create_prorations. Adds within prepaid floor →
//     no Stripe call. Reactivation handled by construction (the floor
//     check naturally exempts reactivation within prepaid).
//
//   • reconcileAtRenewal — fired from invoice.payment_succeeded
//     handler gated on billing_reason='subscription_cycle'.
//     Bidirectional + idempotent: sets per_property + per_driver
//     quantity = activeCount with proration_behavior='none'. Universal
//     backstop for everything else (admin bulk-toggles, race-induced
//     drift, missed adds, etc).
//
// Custom-Price preservation: every mutation operates on the EXISTING
// line item resolved from stripe_subscription_id. NEVER catalog-lookup
// — that destroys A1's negotiated prices. Line item identification via
// the same stripe_prices.line_item label resolution pattern as B141.
//
// Short-circuits on stripe_subscription_id IS NULL (admin-onboarded
// companies / A1-today). PM track no-ops on driver sync (no
// per_driver line item exists in the subscription).
//
// Non-throwing throughout: Stripe API failures + verify mismatches
// return { ok: false; reason } with [B147-*] tagged-log records.
// Callers (CA-portal pages, webhook handlers) MUST NOT throw on
// failure — the DB write already succeeded; reconcileAtRenewal is the
// backstop. Recommended caller pattern on failure:
//   if (!r.ok) console.warn('[B147-sync-failed]', { context, reason: r.reason })

interface CompanyForSync {
  name: string
  stripeSubId: string
}

interface SubItemSnapshot {
  itemId: string
  lineItem: 'base' | 'per_property' | 'per_driver' | string
  quantity: number
  priceId: string
}

interface ActiveCounts {
  properties: number
  drivers: number
}

// Load companies row + verify the company has a stripe_subscription_id.
// Returns null on missing-sub / missing-row.
async function loadCompanyForSync(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  companyId: number,
): Promise<CompanyForSync | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('name, stripe_subscription_id')
    .eq('id', companyId)
    .maybeSingle()
  if (error) {
    console.warn('[B147-load-failed]', { companyId, error: error.message })
    return null
  }
  if (!data?.stripe_subscription_id || !data?.name) return null
  return { name: String(data.name), stripeSubId: String(data.stripe_subscription_id) }
}

// Snapshot the live subscription's line items with line_item labels
// resolved via stripe_prices. Same pattern as B141's price→tier lookup.
async function snapshotLineItems(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  stripeSubId: string,
  companyId: number,
): Promise<SubItemSnapshot[] | null> {
  const stripe = getStripe()
  let sub
  try {
    sub = await stripe.subscriptions.retrieve(stripeSubId, { expand: ['items.data'] })
  } catch (e) {
    console.error('[B147-retrieve-failed]', {
      companyId, stripeSubId, error: (e as Error).message,
    })
    return null
  }

  const priceIds = (sub.items?.data ?? [])
    .map(it => it.price?.id)
    .filter((id): id is string => typeof id === 'string')
  if (priceIds.length === 0) return []

  const mode = getStripeMode()
  const { data: priceRows, error: priceErr } = await supabase
    .from('stripe_prices')
    .select('stripe_price_id, line_item')
    .in('stripe_price_id', priceIds)
    .eq('mode', mode)
  if (priceErr) {
    console.error('[B147-price-lookup-failed]', {
      companyId, priceIds, error: priceErr.message,
    })
    return null
  }
  const labelByPriceId = new Map((priceRows ?? []).map(p => [p.stripe_price_id as string, p.line_item as string]))

  const out: SubItemSnapshot[] = []
  for (const it of sub.items?.data ?? []) {
    if (!it.price?.id || typeof it.quantity !== 'number') continue
    out.push({
      itemId: it.id,
      lineItem: labelByPriceId.get(it.price.id) ?? 'unknown',
      quantity: it.quantity,
      priceId: it.price.id,
    })
  }
  return out
}

// Count is_active=true rows for properties + drivers via company name
// match (text column, not FK).
async function countActiveRecords(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  companyName: string,
): Promise<ActiveCounts> {
  const [props, drvs] = await Promise.all([
    supabase.from('properties').select('id', { count: 'exact', head: true }).ilike('company', companyName).eq('is_active', true),
    supabase.from('drivers').select('id', { count: 'exact', head: true }).ilike('company', companyName).eq('is_active', true),
  ])
  return {
    properties: props.count ?? 0,
    drivers: drvs.count ?? 0,
  }
}

// Update line item quantity + F6 verify-after-write. Non-fatal: Stripe
// errors + verify mismatches log with tagged prefix and return ok=false
// without throwing. Semantic comparison (numeric, not string).
async function updateLineItemQuantity(
  itemId: string,
  newQty: number,
  prorationBehavior: 'create_prorations' | 'none',
  companyId: number,
  lineItem: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stripe = getStripe()
  try {
    const updated = await stripe.subscriptionItems.update(itemId, {
      quantity: newQty,
      proration_behavior: prorationBehavior,
    })
    if (updated.quantity !== newQty) {
      console.error('[B147-verify-mismatch]', {
        companyId, itemId, lineItem,
        expected: newQty, actual: updated.quantity,
      })
      return { ok: false, reason: `Stripe accepted update but quantity returned ${updated.quantity} ≠ ${newQty}` }
    }
    return { ok: true }
  } catch (e) {
    const reason = `subscriptionItems.update failed: ${(e as Error).message}`
    console.error('[B147-update-failed]', {
      companyId, itemId, lineItem, newQty, prorationBehavior, error: reason,
    })
    return { ok: false, reason }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export type SyncOnAddResult =
  | { ok: true; action: 'incremented' | 'noop_within_floor' | 'skipped_no_sub' | 'skipped_no_line_item' }
  | { ok: false; reason: string }

/**
 * syncOnAdd — call AFTER a property/driver DB insert OR reactivation
 * (toggle from is_active=false → true) succeeds. Increments the
 * relevant line item only when activeCount > current Stripe quantity.
 * Uses create_prorations. Reactivation within prepaid is free by
 * construction (the floor check excludes it).
 *
 * Non-throwing: Stripe API failures degrade to { ok: false; reason }
 * so the caller's UX path is uninterrupted — the DB write already
 * succeeded; reconcileAtRenewal is the backstop. Recommended caller
 * pattern on failure:
 *   if (!r.ok) console.warn('[B147-sync-failed]', { context, reason: r.reason })
 */
export async function syncOnAdd(
  companyId: number,
  kind: 'property' | 'driver',
): Promise<SyncOnAddResult> {
  const supabase = createSupabaseServiceClient()
  const company = await loadCompanyForSync(supabase, companyId)
  if (!company) return { ok: true, action: 'skipped_no_sub' }

  const snapshots = await snapshotLineItems(supabase, company.stripeSubId, companyId)
  if (!snapshots) return { ok: false, reason: 'snapshot failed (see [B147-*] logs)' }

  const targetLineItem = kind === 'property' ? 'per_property' : 'per_driver'
  const item = snapshots.find(s => s.lineItem === targetLineItem)
  if (!item) return { ok: true, action: 'skipped_no_line_item' }

  const counts = await countActiveRecords(supabase, company.name)
  const activeCount = kind === 'property' ? counts.properties : counts.drivers

  if (activeCount <= item.quantity) {
    return { ok: true, action: 'noop_within_floor' }
  }

  const result = await updateLineItemQuantity(item.itemId, activeCount, 'create_prorations', companyId, item.lineItem)
  if (!result.ok) return result
  return { ok: true, action: 'incremented' }
}

export type ReconcileAction = {
  lineItem: string
  from: number
  to: number
  result: 'updated' | 'noop' | 'failed'
}
export type ReconcileAtRenewalResult =
  | { ok: true; actions: ReconcileAction[] }
  | { ok: false; reason: string }

/**
 * reconcileAtRenewal — call from invoice.payment_succeeded handler
 * GATED on billing_reason='subscription_cycle'. Bidirectional +
 * idempotent: sets per_property + per_driver quantity to current
 * activeCount with proration_behavior='none'. Backstop for everything
 * else (admin bulk-toggles, race-induced drift, missed adds, etc).
 *
 * Iterates all snapshot line items; per-item failures are logged and
 * recorded in the returned actions array but don't abort the loop.
 *
 * Base-line-item tripwire: per the locked design, the base line item
 * is always quantity=1 and never reconciled. If we see quantity != 1
 * for a base item, log via [B147-base-tripwire] tagged prefix and
 * continue — DON'T mutate (a base mutation here would clobber a
 * legitimate upstream change). Non-fatal alarm bell for unexpected
 * upstream activity.
 */
export async function reconcileAtRenewal(
  companyId: number,
): Promise<ReconcileAtRenewalResult> {
  const supabase = createSupabaseServiceClient()
  const company = await loadCompanyForSync(supabase, companyId)
  if (!company) return { ok: true, actions: [] }

  const snapshots = await snapshotLineItems(supabase, company.stripeSubId, companyId)
  if (!snapshots) return { ok: false, reason: 'snapshot failed (see [B147-*] logs)' }

  const counts = await countActiveRecords(supabase, company.name)
  const actions: ReconcileAction[] = []

  for (const item of snapshots) {
    // Base-line-item tripwire — non-fatal tagged log, no mutation.
    // Per locked design, base is always quantity=1; an unexpected
    // value here means something upstream (admin Dashboard edit,
    // manual subscriptionItems.update, SDK drift) changed it. We
    // surface the anomaly without overwriting whatever happened.
    if (item.lineItem === 'base' && item.quantity !== 1) {
      console.error('[B147-base-tripwire]', {
        companyId, itemId: item.itemId,
        expected: 1, actual: item.quantity,
      })
    }
    if (item.lineItem !== 'per_property' && item.lineItem !== 'per_driver') continue
    const target = item.lineItem === 'per_property' ? counts.properties : counts.drivers
    if (target === item.quantity) {
      actions.push({ lineItem: item.lineItem, from: item.quantity, to: target, result: 'noop' })
      continue
    }
    const r = await updateLineItemQuantity(item.itemId, target, 'none', companyId, item.lineItem)
    actions.push({
      lineItem: item.lineItem,
      from: item.quantity,
      to: target,
      result: r.ok ? 'updated' : 'failed',
    })
  }
  return { ok: true, actions }
}
