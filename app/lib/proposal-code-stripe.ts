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
// ── PATTERN C — per-code Product (Legacy tier only) — B232 ─────────
// Legacy is negotiated-only: scripts/create-stripe-prices.ts:20 +
// :118-120 states "Legacy: ZERO standard rows". Pattern B would abort
// at the catalog-Product SELECT — that latent gap surfaced when A1
// (first real Legacy code) tried to issue.
//
// Fix: Legacy codes create their OWN Stripe Product at issue time.
// One Product per code, shared across all its line items (a Product
// with multiple Prices is the correct Stripe modeling for a single
// negotiated deal). Metadata { sml_kind: 'legacy',
// sml_proposal_code_id, sml_code } makes every Legacy Stripe object
// enumerable for cleanup / test-artifact sweeps.
//
// Idempotency: deterministic key on (mode, code.id) — a mid-flight
// retry returns the SAME Product ID rather than duplicating. DB-level
// recovery (existing stripe_prices row for the same code carries the
// Product ID we already minted) runs FIRST — cheap + covers >24h
// retry windows past Stripe's idempotency-key TTL. Duplicates that
// slip past both layers are still metadata-findable via the trio,
// not silent orphans (June 16 orphan lesson).
//
// Track-agnostic: branches on code.base_tier === 'legacy' regardless
// of code.base_tier_type — covers both enforcement.legacy AND
// property_management.legacy shapes.
//
// Same tax_code as the standard catalog (SAAS_TAX_CODE =
// 'txcd_10103001') so Legacy is taxed identically under Pattern A.
//
// NOTE: canonical B66 architecture doc B66_Architecture_Decisions_May20_2026.md
// lives in the planning workspace, off-repo. Mirror this Pattern C
// entry there so the design record stays in sync with the code.
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

/**
 * Line items to create for a proposal code, applying:
 *   • per_driver retirement (Slice 1 Commit 5 form drop → 2026-07-04 lib
 *     drop — Enforcement per_driver removed everywhere else; this was
 *     the last stale reference).
 *   • Legacy $0-override omit (2026-07-04 architect Option (b)): when a
 *     Legacy code has an EXPLICIT $0 override on a line item, that item
 *     is omitted entirely — no Stripe Price is created, no subscription
 *     line at redemption. Guardrail: only omit on EXPLICIT $0 override,
 *     NEVER on a fallback that resolved to 0 (that would silently drop
 *     a line the catalog default expected). Only Legacy codes; non-Legacy
 *     always get their full track set.
 *
 * Exported so start-billing can compute expectedLines using the same
 * shape logic — single source of truth for the sub structure.
 *
 * per_permit customization (PM-Only) for custom Legacy codes is Gap 2 —
 * deferred as Bar-2 per architect 2026-07-04 (A1 doesn't meter).
 */
export function lineItemsForCode(
  code: Pick<ProposalCodeForStripe, 'base_tier_type' | 'base_tier'
                                 | 'custom_base_fee' | 'custom_per_property_fee'>
): LineItem[] {
  const trackLines: LineItem[] = code.base_tier_type === 'enforcement'
    ? ['base', 'per_property']
    : ['base', 'per_property']

  if (code.base_tier !== 'legacy') return trackLines

  return trackLines.filter(li => {
    const override = li === 'base'
      ? code.custom_base_fee
      : li === 'per_property'
        ? code.custom_per_property_fee
        : null
    // Omit only when the OVERRIDE is explicitly 0 — not on null (fallback)
    // or on any positive value.
    return !(override != null && Number(override) === 0)
  })
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

// B232 — Pattern C. Resolves the Stripe Product ID for a Legacy code:
// one Product per code, reused across every line item. Two recovery
// layers:
//   1. DB-side: any existing stripe_prices row for this code (any line
//      item, same mode) already carries a stripe_product_id we minted
//      on a prior successful issue call. Reuse it — cheap + covers
//      >24h retry windows past Stripe's idempotency-key TTL.
//   2. Stripe-side: idempotent products.create with deterministic key
//      sml-legacy-product-<mode>-<code.id>. Mid-flight retry returns
//      the SAME Product ID rather than minting a duplicate.
// Metadata trio makes the Product enumerable for cleanup sweeps.
async function resolvePerCodeLegacyProduct(
  stripe: ReturnType<typeof getStripe>,
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  code: ProposalCodeForStripe,
  mode: 'live' | 'test'
): Promise<string> {
  const { data: prior, error: priorErr } = await supabase
    .from('stripe_prices')
    .select('stripe_product_id')
    .eq('proposal_code_id', code.id)
    .eq('mode', mode)
    .limit(1)
    .maybeSingle()
  if (priorErr) {
    throw new ProposalStripeError(
      'db',
      `Legacy Product DB recovery probe failed for code ${code.code}: ${priorErr.message}`
    )
  }
  if (prior?.stripe_product_id) return prior.stripe_product_id

  const nickname = code.client_name?.trim() || '(unnamed code)'
  let product
  try {
    product = await stripe.products.create(
      {
        name: `ShieldMyLot Legacy — ${code.code} — ${nickname}`,
        // SaaS in TX = txcd_10103001 (matches SAAS_TAX_CODE in
        // scripts/create-stripe-prices.ts). Pattern A tax_code
        // consistency across catalog + Legacy.
        tax_code: 'txcd_10103001',
        metadata: {
          sml_kind:             'legacy',
          sml_proposal_code_id: String(code.id),
          sml_code:             code.code,
        },
      },
      { idempotencyKey: `sml-legacy-product-${mode}-${code.id}` }
    )
  } catch (e) {
    throw new ProposalStripeError(
      'stripe',
      `Legacy Product create failed for code ${code.code}: ${(e as Error).message}`
    )
  }
  return product.id
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

  const lineItems = lineItemsForCode(code)
  const prices: CreatedPrice[] = []
  let createdCount = 0
  let recoveredCount = 0
  let skippedCount = 0

  // B232 — Pattern C: for Legacy, resolve the per-code Product ONCE
  // upfront (before the loop). All line-item Prices share it. For
  // Pattern B (standard tiers), Product resolution stays per-iteration
  // inside the loop (different Product per line-item in the catalog).
  const isLegacy = code.base_tier === 'legacy'
  const legacyProductId = isLegacy
    ? await resolvePerCodeLegacyProduct(stripe, supabase, code, mode)
    : null

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
      // 3. Product resolution — split on tier.
      //
      // Pattern C (Legacy): per-code Product hoisted upfront outside
      // the loop (resolvePerCodeLegacyProduct above). All line-item
      // Prices share the same Product ID.
      //
      // Pattern B (standard tiers): the Product is sourced from the
      // standard catalog row at (track, tier, line_item, monthly, mode).
      // Bails with precondition if the catalog row is missing.
      if (isLegacy) {
        // legacyProductId non-null by construction (resolved above
        // when isLegacy is true).
        stripeProductId = legacyProductId as string
      } else {
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
      }

      let created
      try {
        created = await stripe.prices.create(
          {
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
              // B232 — enumeration metadata trio for cleanup sweeps.
              // Same trio on the Legacy Product for parity.
              sml_kind:             isLegacy ? 'legacy' : 'standard',
              sml_proposal_code_id: String(code.id),
              sml_code:             code.code,
            },
          },
          // B232 — deterministic idempotency key so mid-flight retries
          // return the SAME Price, not a duplicate (June 16 orphan
          // class). Key expires from Stripe after ~24h; the DB-side
          // recovery layer (existing stripe_prices row) covers longer
          // retry windows.
          { idempotencyKey: `sml-price-${mode}-${code.id}-${li}` }
        )
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
