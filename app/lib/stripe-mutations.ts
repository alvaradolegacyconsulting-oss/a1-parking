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
  // B165 — proposalCodeId set per-item via stripe_prices JOIN. NULL on
  // catalog Prices, non-null on proposal-code-issued Prices. Used by
  // changeTier's proposal-code refusal as Signal B (defense-in-depth):
  // Signal A is the proposal_codes WHERE company_id=$1 AND status=
  // 'redeemed' lookup; Signal B is this per-line-item check. Either
  // tripping refuses the upgrade. companies has no proposal_code_id
  // column — the link lives on proposal_codes.company_id.
  proposalCodeId: number | null
  // B165 — tierName + track + cycle for the rollback recipe log. When a
  // partial-swap failure fires, the [B165-partial-swap-CRITICAL] log
  // needs the full ORIGINAL state of every line item so manual recovery
  // is mechanical, not investigative.
  tierName: string | null
  track: string | null
  cycle: string | null
}

// B147 2.1 — snapshot includes the sub's collection_method so callers
// can short-circuit on non-auto subs.
//
// FAIL-SAFE ALLOWLIST: only 'charge_automatically' is treated as safe
// for auto-mutation. send_invoice + null + unknown + future Stripe
// values all skip. The check is at the helper layer — single source
// of truth, so future callers (B165 tier change, etc.) can't
// accidentally forget the gate. Rationale: send_invoice subs are
// today managed manually via the proposal-code send_invoice branch;
// auto-trim would overwrite manual control. Unknown / new Stripe
// collection_method values default to the safe path (skip) rather
// than guess.
interface SubscriptionSnapshot {
  collectionMethod: string  // 'charge_automatically' | 'send_invoice' | other-future | '' (null)
  items: SubItemSnapshot[]
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
async function snapshotSubscription(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  stripeSubId: string,
  companyId: number,
): Promise<SubscriptionSnapshot | null> {
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

  // B147 2.1 — pass-through, no default-to-auto. Empty string for null/
  // undefined so the allowlist check is honest: only the exact string
  // 'charge_automatically' wins. Any other value (send_invoice, null,
  // future Stripe values) lands at the skip path. Fail-safe stance.
  const collectionMethod = String(sub.collection_method ?? '')

  const priceIds = (sub.items?.data ?? [])
    .map(it => it.price?.id)
    .filter((id): id is string => typeof id === 'string')
  if (priceIds.length === 0) return { collectionMethod, items: [] }

  const mode = getStripeMode()
  // B165 — extended SELECT to also pull proposal_code_id + tier_name +
  // tier_track + cycle. proposal_code_id powers the changeTier proposal-
  // code refusal path (defense-in-depth Signal B). tier_name/tier_track/
  // cycle power the rollback recipe so partial-swap failure logs carry
  // the full ORIGINAL identity of each line item.
  //
  // House convention (matches stripe-catalog.ts:38/48): in-code field
  // name is `track`, DB column is `tier_track`. Alias at the query.
  const { data: priceRows, error: priceErr } = await supabase
    .from('stripe_prices')
    .select('stripe_price_id, line_item, proposal_code_id, tier_name, tier_track, cycle')
    .in('stripe_price_id', priceIds)
    .eq('mode', mode)
  if (priceErr) {
    console.error('[B147-price-lookup-failed]', {
      companyId, priceIds, error: priceErr.message,
    })
    return null
  }
  const rowByPriceId = new Map((priceRows ?? []).map(p => [p.stripe_price_id as string, p]))

  const items: SubItemSnapshot[] = []
  for (const it of sub.items?.data ?? []) {
    if (!it.price?.id || typeof it.quantity !== 'number') continue
    const row = rowByPriceId.get(it.price.id)
    items.push({
      itemId: it.id,
      lineItem: (row?.line_item as string | undefined) ?? 'unknown',
      quantity: it.quantity,
      priceId: it.price.id,
      proposalCodeId: (row?.proposal_code_id as number | null | undefined) ?? null,
      tierName: (row?.tier_name as string | null | undefined) ?? null,
      track: (row?.tier_track as string | null | undefined) ?? null,
      cycle: (row?.cycle as string | null | undefined) ?? null,
    })
  }
  return { collectionMethod, items }
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

// B165 — sibling of updateLineItemQuantity for tier-jump Price swaps.
// Inherits the same custom-Price-preservation contract by construction:
// takes a pre-resolved itemId from snapshotSubscription (NEVER catalog-
// attaches a fresh Stripe Price object), calls
// stripe.subscriptionItems.update(itemId, { price }) which REPLACES the
// Price on the existing line item while preserving negotiated quantity.
// Non-throwing: API failures + verify mismatches return
// { ok: false; reason } with [B165-*] tagged logs.
async function updateLineItemPrice(
  itemId: string,
  newPriceId: string,
  prorationBehavior: 'create_prorations' | 'none',
  companyId: number,
  lineItem: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stripe = getStripe()
  try {
    const updated = await stripe.subscriptionItems.update(itemId, {
      price: newPriceId,
      proration_behavior: prorationBehavior,
    })
    if (updated.price?.id !== newPriceId) {
      console.error('[B165-verify-mismatch]', {
        companyId, itemId, lineItem,
        expected: newPriceId, actual: updated.price?.id,
      })
      return { ok: false, reason: `Stripe accepted update but price.id returned ${updated.price?.id} ≠ ${newPriceId}` }
    }
    return { ok: true }
  } catch (e) {
    const reason = `subscriptionItems.update(price) failed: ${(e as Error).message}`
    console.error('[B165-update-failed]', {
      companyId, itemId, lineItem, newPriceId, prorationBehavior, error: reason,
    })
    return { ok: false, reason }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export type SyncOnAddResult =
  | { ok: true; action: 'incremented' | 'noop_within_floor' | 'skipped_no_sub' | 'skipped_no_line_item' | 'skipped_manual_collection' }
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

  const snapshot = await snapshotSubscription(supabase, company.stripeSubId, companyId)
  if (!snapshot) return { ok: false, reason: 'snapshot failed (see [B147-*] logs)' }

  // B147 2.1 — fail-safe allowlist. Only 'charge_automatically' subs
  // are eligible for auto-mutation. send_invoice + null + unknown +
  // future Stripe values all skip. Gate lives at the helper layer
  // (single source of truth); same check appears in reconcileAtRenewal.
  if (snapshot.collectionMethod !== 'charge_automatically') {
    console.warn('[B147-skipped-manual-collection]', {
      companyId, kind, callsite: 'syncOnAdd', collectionMethod: snapshot.collectionMethod,
    })
    return { ok: true, action: 'skipped_manual_collection' }
  }

  const targetLineItem = kind === 'property' ? 'per_property' : 'per_driver'
  const item = snapshot.items.find(s => s.lineItem === targetLineItem)
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

  const snapshot = await snapshotSubscription(supabase, company.stripeSubId, companyId)
  if (!snapshot) return { ok: false, reason: 'snapshot failed (see [B147-*] logs)' }

  // B147 2.1 — fail-safe allowlist (symmetric with syncOnAdd). Renewal
  // trim must not overwrite manually-managed quantities. Returns empty
  // actions; the tagged log carries the reason + the actual
  // collectionMethod value for observability.
  if (snapshot.collectionMethod !== 'charge_automatically') {
    console.warn('[B147-skipped-manual-collection]', {
      companyId, callsite: 'reconcileAtRenewal', collectionMethod: snapshot.collectionMethod,
    })
    return { ok: true, actions: [] }
  }

  const counts = await countActiveRecords(supabase, company.name)
  const actions: ReconcileAction[] = []

  for (const item of snapshot.items) {
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

// ─── B165 — Tier change (forced upgrade) ────────────────────────────
//
// Public API: previewTierChange + changeTier.
//
// Scope guards (refuse + route to support):
//   1. Track switch (Enf↔PM)  — v1 refuses; per_driver-orphan hazard
//   2. Proposal-code customer  — non-catalog Prices; clobber-prevention
//   3. Premium target tier     — contact-sales per B89
//   4. Non-charge_automatically — same fail-safe allowlist as B147
//   5. Same-or-lower tier      — refuse downgrade (offline runbook)
//
// Ordering (per Option B): Stripe swaps FIRST (sequential awaits, stop
// on first failure), then DB write of companies.tier + tier_type. B141
// customer.subscription.updated webhook is the convergence safety net
// for the ✅✅✅-then-DB-fail edge case.
//
// Partial-swap failure (refinement A): if any of the 3 line-item swaps
// fails AFTER one or more have succeeded, emit
// [B165-partial-swap-CRITICAL] with the COMPLETE rollback recipe —
// every original Price ID by line item + itemId + which swap failed +
// the new Price ID that was attempted. Manual recovery is mechanical,
// not investigative. The subscription is left in the partially-swapped
// state (we don't auto-rollback in v1 — that's another sequence that
// could itself partial-fail).

// Within-track tier order (used for upgrade-only enforcement). Index
// in the array = tier "height" within the track. Higher index = more
// expensive tier. Premium is contact-sales (not self-serve) so it's
// excluded from this ordering — changeTier refuses target='premium'.
const ENF_TIER_ORDER = ['starter', 'growth', 'legacy'] as const
const PM_TIER_ORDER = ['essential', 'professional', 'enterprise'] as const

type SubscriptionTrack = 'enforcement' | 'property_management'

function trackOrder(track: string): readonly string[] {
  return track === 'enforcement' ? ENF_TIER_ORDER : PM_TIER_ORDER
}

function isUpgradeWithinTrack(currentTier: string, targetTier: string, track: string): boolean {
  const order = trackOrder(track)
  const cur = order.indexOf(currentTier.toLowerCase())
  const tgt = order.indexOf(targetTier.toLowerCase())
  if (cur === -1 || tgt === -1) return false
  return tgt > cur
}

// Resolve target tier's per-line-item Price IDs from stripe_prices.
// Returns null if any required line item is missing (Premium, unknown
// tier, missing cycle, missing mode rows). Caller treats null as
// refuse-and-route-to-support.
async function resolveTargetTierPriceIds(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  targetTier: string,
  targetTrack: SubscriptionTrack,
  cycle: 'monthly' | 'annual',
  mode: 'test' | 'live',
): Promise<{ base: string; per_property: string; per_driver: string | null } | null> {
  const { data, error } = await supabase
    .from('stripe_prices')
    .select('stripe_price_id, line_item')
    .eq('tier_name', targetTier)
    .eq('tier_track', targetTrack)
    .eq('cycle', cycle)
    .eq('mode', mode)
    .is('proposal_code_id', null)
  if (error || !data) {
    console.error('[B165-price-resolution-failed]', {
      targetTier, targetTrack, cycle, mode, error: error?.message,
    })
    return null
  }
  const byLineItem = new Map(data.map(r => [r.line_item as string, r.stripe_price_id as string]))
  const base = byLineItem.get('base')
  const per_property = byLineItem.get('per_property')
  const per_driver = byLineItem.get('per_driver') ?? null
  if (!base || !per_property) return null
  // Enforcement requires per_driver; PM has no per_driver line item.
  if (targetTrack === 'enforcement' && !per_driver) return null
  return { base, per_property, per_driver }
}

export type TierChangeRefusalReason =
  | 'no_subscription'           // company.stripe_subscription_id IS NULL
  | 'snapshot_failed'           // snapshotSubscription returned null
  | 'manual_collection'         // send_invoice / null / unknown collection_method
  | 'proposal_code_attached'    // proposal_codes WHERE company_id=$1 AND status='redeemed' (Signal A) OR any item.proposalCodeId set (Signal B)
  | 'track_switch_refused'      // current.track !== target.track (v1 scope guard)
  | 'premium_target'            // targetTier === 'premium' → contact-sales
  | 'not_an_upgrade'            // target tier index ≤ current tier index (refuse downgrade in v1)
  | 'target_tier_unknown'       // target tier doesn't resolve in stripe_prices for the cycle/mode
  | 'cycle_unknown'             // current items don't agree on a single cycle
  | 'company_tier_drift'        // companies.tier_type doesn't match what's on the live subscription

export type ChangeTierResult =
  | { ok: true; swaps: { lineItem: string; from: string; to: string }[] }
  | { ok: false; reason: TierChangeRefusalReason; detail?: string }

export type PreviewTierChangeResult =
  | {
      ok: true
      proratedToday: number       // cents
      newPeriodTotal: number      // cents — the post-swap normal-period charge
      currency: string
      periodEnd: number           // unix timestamp of next billing date
    }
  | { ok: false; reason: TierChangeRefusalReason; detail?: string }

// Snapshot the current subscription + resolve the unambiguous current
// (tier, track, cycle) from its items. All non-base items must agree
// on tier_name + track + cycle for the resolution to succeed. Returns
// the resolved tuple OR null when any item disagrees (drift case).
function resolveCurrentTierFromSnapshot(items: SubItemSnapshot[]): {
  tier: string; track: SubscriptionTrack; cycle: 'monthly' | 'annual'
} | null {
  // Pull tier_name / track / cycle from any item that has them populated.
  // All catalog Prices for a given tier share the same tier_name + track + cycle.
  const populated = items.filter(it => it.tierName && it.track && it.cycle)
  if (populated.length === 0) return null
  const first = populated[0]
  for (const it of populated) {
    if (it.tierName !== first.tierName || it.track !== first.track || it.cycle !== first.cycle) {
      // Drift — items don't agree. Refuse.
      return null
    }
  }
  const trackStr = first.track as string
  if (trackStr !== 'enforcement' && trackStr !== 'property_management') return null
  const cycleStr = first.cycle as string
  if (cycleStr !== 'monthly' && cycleStr !== 'annual') return null
  return {
    tier: first.tierName as string,
    track: trackStr,
    cycle: cycleStr,
  }
}

/**
 * previewTierChange — preview-invoice helper.
 *
 * Returns the prorated-today amount + the new normal-period total for
 * a proposed tier change, BEFORE any mutation. Powers the forced-upgrade
 * modal's "Upgrade to Legacy: $X prorated today, then $Y/mo starting
 * [date]" copy.
 *
 * Runs the SAME refusal guards as changeTier — if a customer can't
 * upgrade, they shouldn't see a preview either. Honest-or-nothing.
 *
 * On Stripe preview-invoice failure, returns ok:false with detail so
 * the modal can surface "final amount calculated at checkout" or block
 * the confirm (per refinement B). Never returns an estimated/wrong
 * number.
 */
export async function previewTierChange(
  companyId: number,
  targetTier: string,
  targetTrack: SubscriptionTrack,
): Promise<PreviewTierChangeResult> {
  const guardResult = await runChangeTierGuards(companyId, targetTier, targetTrack)
  if (!guardResult.ok) return guardResult

  const stripe = getStripe()
  const { snapshot, company, targetPriceIds } = guardResult

  // Build the items[] for the preview invoice — same swap shape we'd
  // apply in changeTier. Stripe computes proration on assumption these
  // are about to take effect.
  const baseItem = snapshot.items.find(it => it.lineItem === 'base')
  const propItem = snapshot.items.find(it => it.lineItem === 'per_property')
  const drvItem = snapshot.items.find(it => it.lineItem === 'per_driver')

  const previewItems: { id: string; price: string }[] = []
  if (baseItem) previewItems.push({ id: baseItem.itemId, price: targetPriceIds.base })
  if (propItem) previewItems.push({ id: propItem.itemId, price: targetPriceIds.per_property })
  // Per_driver: only if both current sub has it AND target tier has it.
  // (Within-track upgrade preserves track, so both should have it on Enf
  // and neither on PM — but the explicit check is cheap defense.)
  if (drvItem && targetPriceIds.per_driver) {
    previewItems.push({ id: drvItem.itemId, price: targetPriceIds.per_driver })
  }

  try {
    // createPreview is Stripe SDK's preview-invoice retrieval. Returns
    // the upcoming invoice as Stripe would render it with the proposed
    // subscription_items + automatic_tax. We extract proration_amount
    // + amount_due for the today + new-period numbers.
    const preview = await stripe.invoices.createPreview({
      customer: undefined, // resolved via subscription
      subscription: company.stripeSubId,
      subscription_details: {
        items: previewItems,
        proration_behavior: 'create_prorations',
      },
      automatic_tax: { enabled: true },
    })

    // proratedToday = the immediate charge that hits the customer now
    // (prorated for time elapsed in the current period). Stripe sums all
    // proration line items in amount_due; for a tier upgrade with
    // create_prorations, that's the prorated additional amount.
    const proratedToday = preview.amount_due ?? 0

    // newPeriodTotal = the recurring full-period total (pre-tax shown as
    // subtotal, tax added separately). For the modal, show the total
    // including tax so the customer sees what they'll pay each period.
    // total = subtotal + tax (Stripe-computed).
    const newPeriodTotal = preview.total ?? 0

    const currency = preview.currency || 'usd'

    // periodEnd: take from the live subscription (not the preview), as
    // the preview is for the upcoming period that begins after current.
    const liveSub = await stripe.subscriptions.retrieve(company.stripeSubId)
    const item0 = liveSub.items?.data?.[0] as { current_period_end?: number } | undefined
    const periodEnd = item0?.current_period_end ?? 0

    return {
      ok: true,
      proratedToday,
      newPeriodTotal,
      currency,
      periodEnd,
    }
  } catch (e) {
    console.error('[B165-preview-failed]', {
      companyId, targetTier, targetTrack, error: (e as Error).message,
    })
    return {
      ok: false,
      reason: 'snapshot_failed',
      detail: `Preview invoice failed: ${(e as Error).message}`,
    }
  }
}

// Internal — shared guard pass for previewTierChange + changeTier so a
// customer who can't upgrade can't see a preview either. Returns the
// snapshot + targetPriceIds on ok:true (so changeTier doesn't re-snapshot).
async function runChangeTierGuards(
  companyId: number,
  targetTier: string,
  targetTrack: SubscriptionTrack,
): Promise<
  | { ok: true; company: CompanyForSync; snapshot: SubscriptionSnapshot; currentTier: string; currentCycle: 'monthly' | 'annual'; targetPriceIds: { base: string; per_property: string; per_driver: string | null }; companyRow: { tier: string; tier_type: string } }
  | { ok: false; reason: TierChangeRefusalReason; detail?: string }
> {
  const supabase = createSupabaseServiceClient()

  // Premium = refuse upfront (no catalog Prices exist for Premium).
  if (targetTier.toLowerCase() === 'premium') {
    return { ok: false, reason: 'premium_target' }
  }

  const company = await loadCompanyForSync(supabase, companyId)
  if (!company) return { ok: false, reason: 'no_subscription' }

  // Pull companies row for tier + tier_type (no proposal_code_id column
  // on companies — the link lives on proposal_codes.company_id).
  const { data: companyRowData } = await supabase
    .from('companies')
    .select('tier, tier_type')
    .eq('id', companyId)
    .maybeSingle()
  if (!companyRowData) return { ok: false, reason: 'no_subscription' }

  // Signal A — reverse lookup against proposal_codes.company_id for any
  // 'redeemed' code. status enum is ('draft','issued','redeemed',
  // 'expired','revoked'); 'redeemed' is the only state that implies an
  // active customer with non-catalog Prices. Other states (draft/issued/
  // expired/revoked) don't represent a live association.
  const { data: redeemedCodes } = await supabase
    .from('proposal_codes')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'redeemed')
    .limit(1)
  if (redeemedCodes && redeemedCodes.length > 0) {
    return {
      ok: false, reason: 'proposal_code_attached',
      detail: `Signal A: proposal_codes.company_id=${companyId} has a redeemed code (id=${redeemedCodes[0].id})`,
    }
  }

  const snapshot = await snapshotSubscription(supabase, company.stripeSubId, companyId)
  if (!snapshot) return { ok: false, reason: 'snapshot_failed' }

  // Signal B for proposal-code detection — defense-in-depth.
  const itemWithProposalCode = snapshot.items.find(it => it.proposalCodeId != null)
  if (itemWithProposalCode) {
    return {
      ok: false, reason: 'proposal_code_attached',
      detail: `Signal B: subscription item ${itemWithProposalCode.itemId} has proposalCodeId=${itemWithProposalCode.proposalCodeId}`,
    }
  }

  // Fail-safe allowlist — same as B147.
  if (snapshot.collectionMethod !== 'charge_automatically') {
    return {
      ok: false, reason: 'manual_collection',
      detail: `collection_method=${snapshot.collectionMethod}`,
    }
  }

  const currentResolved = resolveCurrentTierFromSnapshot(snapshot.items)
  if (!currentResolved) {
    return {
      ok: false, reason: 'cycle_unknown',
      detail: 'Subscription items disagree on tier/track/cycle (drift case)',
    }
  }

  // Track switch refusal — v1 scope guard.
  if (currentResolved.track !== targetTrack) {
    return {
      ok: false, reason: 'track_switch_refused',
      detail: `current track=${currentResolved.track}, target track=${targetTrack}`,
    }
  }

  // Refuse downgrade or same-tier "upgrade".
  if (!isUpgradeWithinTrack(currentResolved.tier, targetTier, currentResolved.track)) {
    return {
      ok: false, reason: 'not_an_upgrade',
      detail: `current=${currentResolved.tier}, target=${targetTier}, track=${currentResolved.track}`,
    }
  }

  // Drift detection — companies row tier_type should agree with the live
  // sub's track. If not, refuse + flag — admin should reconcile first.
  const companyTierTypeNormalized = companyRowData.tier_type === 'pm' ? 'property_management' : companyRowData.tier_type
  if (companyTierTypeNormalized !== currentResolved.track) {
    return {
      ok: false, reason: 'company_tier_drift',
      detail: `companies.tier_type=${companyRowData.tier_type}, live sub track=${currentResolved.track}`,
    }
  }

  const mode = getStripeMode()
  const targetPriceIds = await resolveTargetTierPriceIds(
    supabase, targetTier, targetTrack, currentResolved.cycle, mode,
  )
  if (!targetPriceIds) {
    return { ok: false, reason: 'target_tier_unknown', detail: `No catalog Prices for ${targetTrack}/${targetTier}/${currentResolved.cycle}/${mode}` }
  }

  return {
    ok: true,
    company,
    snapshot,
    currentTier: currentResolved.tier,
    currentCycle: currentResolved.cycle,
    targetPriceIds,
    companyRow: companyRowData as { tier: string; tier_type: string },
  }
}

/**
 * changeTier — execute a within-track tier upgrade.
 *
 * Pipeline:
 *   1. runChangeTierGuards — all 5+ refusal paths
 *   2. Build rollback recipe BEFORE any mutation
 *   3. Sequential Stripe swaps (base, per_property, per_driver if Enf)
 *      with stop-on-failure; partial failure emits
 *      [B165-partial-swap-CRITICAL] with the full rollback recipe
 *   4. Update companies.tier + tier_type (same request; B141 webhook
 *      converges as safety net if this write fails)
 *
 * Recommended caller pattern on partial-success-then-DB-fail:
 *   "Subscription updated but account didn't refresh — contact
 *   support; do not retry." B141 webhook will catch up in seconds.
 */
export async function changeTier(
  companyId: number,
  targetTier: string,
  targetTrack: SubscriptionTrack,
): Promise<ChangeTierResult> {
  const guardResult = await runChangeTierGuards(companyId, targetTier, targetTrack)
  if (!guardResult.ok) return guardResult

  const { snapshot, currentTier, currentCycle, targetPriceIds, company } = guardResult
  const supabase = createSupabaseServiceClient()

  // Rollback recipe — built BEFORE any mutation. Captures the COMPLETE
  // original state of every line item we might touch. If a partial swap
  // happens, this gets logged with the tag so manual recovery is
  // mechanical, not investigative.
  const baseItem = snapshot.items.find(it => it.lineItem === 'base')
  const propItem = snapshot.items.find(it => it.lineItem === 'per_property')
  const drvItem = snapshot.items.find(it => it.lineItem === 'per_driver')
  const rollbackRecipe = {
    companyId,
    subscriptionId: company.stripeSubId,
    currentTier, currentCycle,
    targetTier, targetTrack,
    items: {
      base: baseItem ? { itemId: baseItem.itemId, originalPriceId: baseItem.priceId, attemptedNewPriceId: targetPriceIds.base } : null,
      per_property: propItem ? { itemId: propItem.itemId, originalPriceId: propItem.priceId, attemptedNewPriceId: targetPriceIds.per_property } : null,
      per_driver: drvItem ? { itemId: drvItem.itemId, originalPriceId: drvItem.priceId, attemptedNewPriceId: targetPriceIds.per_driver } : null,
    },
  }

  // Sequential awaits — order matters for the rollback recipe (we know
  // which item we got to before failure).
  const swaps: { lineItem: string; from: string; to: string }[] = []
  const successfulSwaps: { lineItem: string; itemId: string; originalPriceId: string }[] = []

  async function applySwap(item: SubItemSnapshot | undefined, newPriceId: string | null, lineItem: string) {
    if (!item || !newPriceId) return { ok: true as const, skipped: true }
    const r = await updateLineItemPrice(item.itemId, newPriceId, 'create_prorations', companyId, lineItem)
    if (r.ok) {
      swaps.push({ lineItem, from: item.priceId, to: newPriceId })
      successfulSwaps.push({ lineItem, itemId: item.itemId, originalPriceId: item.priceId })
    }
    return r
  }

  // Base first
  const baseResult = await applySwap(baseItem, targetPriceIds.base, 'base')
  if (!baseResult.ok) {
    return { ok: false, reason: 'snapshot_failed', detail: `base swap failed: ${baseResult.reason}` }
  }

  // Per-property next
  const propResult = await applySwap(propItem, targetPriceIds.per_property, 'per_property')
  if (!propResult.ok) {
    console.error('[B165-partial-swap-CRITICAL]', {
      stage: 'per_property_failed_after_base_swapped',
      failedSwap: { lineItem: 'per_property', itemId: propItem?.itemId, attemptedPriceId: targetPriceIds.per_property, error: propResult.reason },
      successfulSwaps,
      rollbackRecipe,
    })
    return { ok: false, reason: 'snapshot_failed', detail: `per_property swap failed AFTER base succeeded; see [B165-partial-swap-CRITICAL]: ${propResult.reason}` }
  }

  // Per-driver last (Enf only)
  if (drvItem && targetPriceIds.per_driver) {
    const drvResult = await applySwap(drvItem, targetPriceIds.per_driver, 'per_driver')
    if (!drvResult.ok) {
      console.error('[B165-partial-swap-CRITICAL]', {
        stage: 'per_driver_failed_after_base_and_per_property_swapped',
        failedSwap: { lineItem: 'per_driver', itemId: drvItem.itemId, attemptedPriceId: targetPriceIds.per_driver, error: drvResult.reason },
        successfulSwaps,
        rollbackRecipe,
      })
      return { ok: false, reason: 'snapshot_failed', detail: `per_driver swap failed AFTER base+per_property succeeded; see [B165-partial-swap-CRITICAL]: ${drvResult.reason}` }
    }
  }

  // ✅✅✅ — all Stripe swaps succeeded. Write DB.
  const { error: dbErr } = await supabase
    .from('companies')
    .update({
      tier: targetTier,
      tier_type: targetTrack,
    })
    .eq('id', companyId)

  if (dbErr) {
    // ✅✅✅-then-DB-fail. B141 webhook will catch up within seconds.
    console.error('[B165-db-write-failed]', {
      companyId, targetTier, targetTrack,
      stripeSwapsApplied: swaps,
      dbError: dbErr.message,
    })
    return {
      ok: false, reason: 'snapshot_failed',
      detail: `Stripe upgrade applied successfully but DB write failed. B141 webhook will reconcile. DB error: ${dbErr.message}`,
    }
  }

  return { ok: true, swaps }
}
