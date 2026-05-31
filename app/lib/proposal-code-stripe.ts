import 'server-only'
import { getStripe, getStripeMode } from './stripe'
import { createSupabaseServiceClient } from './supabase-admin'

// B66.2b commit 2 — Stripe Price creation for proposal codes.
//
// Called from app/api/proposal-codes/[id]/issue/route.ts at the moment
// the admin clicks "Issue Code". Creates one Stripe Price per line item
// (3 for Enforcement, 2 for Property Management — Cluster 2.1) backed
// by the standard catalog's Product (Pattern B per B66 architecture
// doc — proposal-code Prices share a Product with the standard catalog
// row for the same (track, tier, line_item) tuple).
//
// ── PREMIUM HANDLING ─────────────────────────────────────────────────
// Premium tier proposal codes do NOT flow through this helper. The
// stripe_prices.tier_name CHECK (from B66.2a, commit 3135cab) admits
// only the 6 self-serveable tier values; 'premium' is intentionally
// absent. Premium is contact-sales per B89 and uses the manual invoice
// path. Caller (issue route) checks isPremiumCode() before invoking
// this function and routes Premium codes around it.
//
// ── PRICING SOURCE ──────────────────────────────────────────────────
// For each line item: use the proposal code's custom_*_fee override
// if set, else fall back to the platform_settings tier default (same
// fallback source as scripts/create-stripe-prices.ts at B66.2a). All
// values converted at the Stripe boundary: Math.round(dollars * 100).
// Custom fees stay NUMERIC in the DB per pre-flight ask 5 (no
// destructive migration; conversion lives here).
//
// ── IDEMPOTENCY (safe to re-run after partial failure) ──────────────
// Triple-layer recovery same shape as the B66.2a populator script:
//   1. DB UNIQUE — the partial UNIQUE on (proposal_code_id, line_item,
//      cycle, mode) WHERE proposal_code_id IS NOT NULL (per the B66.2b
//      commit 1 migration). Existing row → SKIP, no Stripe call.
//   2. Stripe lookup_key probe — sml.proposal.<code>.<line_item>.monthly.
//      Existing active Price → RECOVER its ID into a new DB row.
//   3. Pattern B Product reuse — no sibling-cycle reuse here (all
//      proposal Prices are monthly per pre-flight ask 7 YAGNI); the
//      Product is sourced from the standard catalog row at (track,
//      tier, line_item) via DB SELECT. Bail with precondition error
//      if the standard catalog is missing — scripts/create-stripe-
//      prices.ts must have populated the standard 30 first.
//
// ── FAILURE MODES (issue-route caller maps to HTTP status) ──────────
// • Stripe API failure → ProposalStripeError stage='stripe' → 502
// • DB select/insert failure → stage='db' → 500
// • Standard catalog missing / platform_settings invalid / non-issuable
//   tier → stage='precondition' → 400

type Track = 'enforcement' | 'property_management'
type TierName =
  | 'starter' | 'growth' | 'legacy' | 'premium'
  | 'essential' | 'professional' | 'enterprise'
type LineItem = 'base' | 'per_property' | 'per_driver'

export interface ProposalCodeForStripe {
  id: number
  code: string
  client_name: string | null
  base_tier_type: Track
  base_tier: TierName
  custom_base_fee: number | null
  custom_per_property_fee: number | null
  custom_per_driver_fee: number | null
}

export interface CreatedPrice {
  line_item: LineItem
  stripe_price_id: string
  stripe_product_id: string
  unit_amount_cents: number
  lookup_key: string
  action: 'created' | 'recovered' | 'skipped'
}

export interface IssueResult {
  prices: CreatedPrice[]
  created: number
  recovered: number
  skipped: number
}

export class ProposalStripeError extends Error {
  constructor(public stage: 'stripe' | 'db' | 'precondition', message: string) {
    super(message)
    this.name = 'ProposalStripeError'
  }
}

// Premium codes skip Stripe Price creation. See PREMIUM HANDLING header.
export function isPremiumCode(code: Pick<ProposalCodeForStripe, 'base_tier'>): boolean {
  return code.base_tier === 'premium'
}

function lineItemsForTrack(track: Track): LineItem[] {
  return track === 'enforcement'
    ? ['base', 'per_property', 'per_driver']
    : ['base', 'per_property']
}

function lineItemLabel(li: LineItem): string {
  if (li === 'base') return 'Base'
  if (li === 'per_property') return 'Per Property'
  return 'Per Driver'
}

// Mirrors scripts/create-stripe-prices.ts platformSettingsColumn() —
// same naming convention so override fallbacks resolve to the same row.
function platformSettingsColumn(track: Track, tier: TierName, li: LineItem): string {
  if (track === 'enforcement') return `price_${tier}_${li}`
  return `price_pm_${tier}_${li}`
}

function resolveMonthlyDollars(
  code: ProposalCodeForStripe,
  li: LineItem,
  platformSettings: Record<string, unknown>
): number {
  const override = li === 'base'
    ? code.custom_base_fee
    : li === 'per_property'
      ? code.custom_per_property_fee
      : code.custom_per_driver_fee
  if (override != null) return Number(override)

  const colName = platformSettingsColumn(code.base_tier_type, code.base_tier, li)
  const raw = platformSettings[colName]
  const fallback = Number(raw)
  if (!Number.isFinite(fallback) || fallback <= 0) {
    throw new ProposalStripeError(
      'precondition',
      `platform_settings.${colName} is invalid: ${JSON.stringify(raw)}`
    )
  }
  return fallback
}

function formatLookupKey(code: string, li: LineItem): string {
  return `sml.proposal.${code}.${li}.monthly`
}

function formatNickname(clientName: string | null, li: LineItem): string {
  const cli = clientName?.trim() || '(unnamed code)'
  return `${cli} — ${lineItemLabel(li)}`
}

export async function createStripePricesForProposalCode(
  code: ProposalCodeForStripe
): Promise<IssueResult> {
  if (isPremiumCode(code)) {
    throw new ProposalStripeError(
      'precondition',
      'Premium codes do not create Stripe Prices; caller must bypass via isPremiumCode().'
    )
  }
  if (code.base_tier_type === 'property_management' && code.custom_per_driver_fee != null) {
    throw new ProposalStripeError(
      'precondition',
      'property_management codes cannot have per_driver pricing (Cluster 2.1).'
    )
  }

  const stripe = getStripe()
  const mode = getStripeMode()
  const supabase = createSupabaseServiceClient()

  const { data: ps, error: psErr } = await supabase
    .from('platform_settings')
    .select('*')
    .eq('id', 1)
    .single()
  if (psErr || !ps) {
    throw new ProposalStripeError(
      'precondition',
      `Failed to read platform_settings row id=1: ${psErr?.message ?? 'not found'}`
    )
  }

  const lineItems = lineItemsForTrack(code.base_tier_type)
  const prices: CreatedPrice[] = []
  let createdCount = 0
  let recoveredCount = 0
  let skippedCount = 0

  for (const li of lineItems) {
    const dollars = resolveMonthlyDollars(code, li, ps as Record<string, unknown>)
    const amountCents = Math.round(dollars * 100)
    const lookupKey = formatLookupKey(code.code, li)

    // 1. DB existence probe (idempotency layer 1).
    const { data: existing, error: selErr } = await supabase
      .from('stripe_prices')
      .select('id, stripe_price_id, stripe_product_id, unit_amount_cents')
      .eq('proposal_code_id', code.id)
      .eq('line_item', li)
      .eq('cycle', 'monthly')
      .eq('mode', mode)
      .maybeSingle()
    if (selErr) {
      throw new ProposalStripeError('db', `DB select failed for ${lookupKey}: ${selErr.message}`)
    }
    if (existing) {
      prices.push({
        line_item: li,
        stripe_price_id: existing.stripe_price_id,
        stripe_product_id: existing.stripe_product_id,
        unit_amount_cents: existing.unit_amount_cents,
        lookup_key: lookupKey,
        action: 'skipped',
      })
      skippedCount++
      continue
    }

    // 2. Stripe lookup_key probe (idempotency layer 2).
    let stripePriceId: string
    let stripeProductId: string
    let action: 'created' | 'recovered'

    let probe
    try {
      probe = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true })
    } catch (e) {
      throw new ProposalStripeError('stripe', `Stripe lookup_key probe failed for ${lookupKey}: ${(e as Error).message}`)
    }

    if (probe.data.length > 0) {
      const p = probe.data[0]
      stripePriceId = p.id
      stripeProductId = typeof p.product === 'string' ? p.product : p.product.id
      action = 'recovered'
      recoveredCount++
    } else {
      // 3. Product resolution — Pattern B: source the Product from the
      //    standard catalog row at (track, tier, line_item, monthly, mode).
      const { data: stdRow, error: stdErr } = await supabase
        .from('stripe_prices')
        .select('stripe_product_id')
        .eq('tier_track', code.base_tier_type)
        .eq('tier_name', code.base_tier)
        .eq('line_item', li)
        .eq('cycle', 'monthly')
        .eq('mode', mode)
        .is('proposal_code_id', null)
        .maybeSingle()
      if (stdErr) {
        throw new ProposalStripeError(
          'db',
          `DB lookup for standard catalog Product failed (${code.base_tier_type}.${code.base_tier}.${li}.monthly.${mode}): ${stdErr.message}`
        )
      }
      if (!stdRow) {
        throw new ProposalStripeError(
          'precondition',
          `Standard catalog Product missing for (${code.base_tier_type}.${code.base_tier}.${li}.monthly.${mode}). Run scripts/create-stripe-prices.ts first.`
        )
      }
      stripeProductId = stdRow.stripe_product_id

      let created
      try {
        created = await stripe.prices.create({
          product: stripeProductId,
          unit_amount: amountCents,
          currency: 'usd',
          recurring: { interval: 'month' },
          lookup_key: lookupKey,
          nickname: formatNickname(code.client_name, li),
          // B66.7 CP-1: proposal-code Prices are created here, OUTSIDE the
          // standard catalog populator (scripts/create-stripe-prices.ts),
          // so the B66.9 v2 migration that retrofitted tax_behavior on the
          // standard catalog doesn't reach this code path. Without this,
          // the proposal-code Prices ship as 'unspecified' tax_behavior
          // and Stripe rejects the subscription create when default_tax_rates
          // is attached (tax_behavior must be 'exclusive' or 'inclusive'
          // on every Price in the subscription). Forward-only — no
          // production proposal-code Prices exist yet (AP.D confirmed),
          // so no migration of existing Prices needed.
          tax_behavior: 'exclusive',
          metadata: {
            proposal_code: code.code,
            proposal_code_id: String(code.id),
            tier_track: code.base_tier_type,
            tier_name: code.base_tier,
            line_item: li,
            cycle: 'monthly',
          },
        })
      } catch (e) {
        throw new ProposalStripeError('stripe', `Stripe Price create failed for ${lookupKey}: ${(e as Error).message}`)
      }
      stripePriceId = created.id
      action = 'created'
      createdCount++
    }

    // 5. Insert DB row. If this fails after Stripe creation, the next
    //    issue-button click recovers the orphan via the lookup_key probe.
    const { error: insErr } = await supabase
      .from('stripe_prices')
      .insert({
        stripe_price_id: stripePriceId,
        stripe_product_id: stripeProductId,
        tier_track: code.base_tier_type,
        tier_name: code.base_tier,
        line_item: li,
        cycle: 'monthly',
        unit_amount_cents: amountCents,
        mode,
        lookup_key: lookupKey,
        is_active: true,
        proposal_code_id: code.id,
      })
    if (insErr) {
      throw new ProposalStripeError(
        'db',
        `DB insert failed for ${lookupKey}: ${insErr.message}. Stripe Price ${stripePriceId} was ${action}; recoverable via lookup_key probe on retry.`
      )
    }

    prices.push({
      line_item: li,
      stripe_price_id: stripePriceId,
      stripe_product_id: stripeProductId,
      unit_amount_cents: amountCents,
      lookup_key: lookupKey,
      action,
    })
  }

  return {
    prices,
    created: createdCount,
    recovered: recoveredCount,
    skipped: skippedCount,
  }
}
