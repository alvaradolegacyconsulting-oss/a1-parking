// ════════════════════════════════════════════════════════════════════
// pricing-quote — ONE price computation, shared by display and charge
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS FILE EXISTS. On 2026-10-02 a live two-line acceptance run
// found Stripe Checkout showing the correct Operator Pro total ($299
// base + 2 × $20 = $339) while OUR OWN pages, one click earlier, said
// $199.00 — "$199/mo base + $0/property". Two different numbers for the
// same purchase, ours being the one the buyer reads first.
//
// The cause was not a bad number. It was a SECOND SOURCE. /signup and
// /signup/verify derived the estimate from TIER_PRICING + OFFERINGS —
// hardcoded display constants — while Checkout derived the charge from
// the stripe_prices projection. TIER_PRICING carried
// `legacy: { base: 199, perProperty: 0 }`, annotated in its own comment
// as an "internal display value". It was internal right up until it was
// the headline figure on a public purchase page.
//
// 🔴 THE RULE THIS FILE ENFORCES: the number we SHOW and the number we
// CHARGE are computed from the same rows by the same code. Not "kept in
// sync" — the same. Display constants may describe a plan; they may not
// price it.
//
// Pure and isomorphic on purpose: no 'server-only', no Supabase, no
// Stripe SDK. It takes catalog rows and returns money, so the band
// arithmetic can be asserted against the published table without a
// network, a browser, or a Stripe account (scripts/verify-signup-quote.ts).
// The rows themselves are fetched server-side and handed to the client
// through /api/signup/quote, which calls getStandardCatalogLines — the
// identical function Checkout calls.
//
// 🔴 NOT a pricing authority. This file knows how to ADD UP a catalog,
// not what anything costs. Every amount comes from stripe_prices, which
// is the projection of scripts/create-stripe-prices.ts. If a price is
// wrong here it is wrong in Stripe too, which is the property we want:
// a disagreement becomes impossible rather than merely unlikely.

/** One graduated band, in Stripe's own wire shape (cents). */
export interface PriceBand {
  /** Cumulative upper bound for this band. null = unbounded ("inf"). */
  up_to: number | null
  /** Per-unit charge within the band. */
  unit_amount?: number | null
  /** Charged once if the band is reached at all. Unused by today's catalog. */
  flat_amount?: number | null
}

export type PriceModel = 'flat' | 'graduated'

/**
 * The subset of a stripe_prices row this math needs. Structurally
 * compatible with CatalogLine from stripe-catalog.ts, so catalog rows
 * can be passed straight in.
 */
export interface QuoteLine {
  line_item: string
  price_model?: PriceModel | string | null
  unit_amount_cents?: number | null
  tiers?: PriceBand[] | null
}

/**
 * The quantity each line item is bought at.
 *
 * 🔴 MUST MATCH CHECKOUT. create-checkout-session imports this rather
 * than keeping its own copy, so the estimate cannot price a different
 * basket than the one Stripe is handed. A change here changes both.
 *
 *   base         → 1
 *   per_property → the property count
 *   per_permit   → 1 (licensed tiered Price; band 1 covers 0-500 at
 *                  $0.00, so a new subscriber's first invoice is $0 for
 *                  permits whatever the starting quantity. Ratcheted
 *                  later by syncOnAdd.)
 *   anything else→ 1 (historical rows; per_driver is retired)
 */
export function quantityForLine(lineItem: string, propertyCount: number): number {
  if (lineItem === 'base') return 1
  if (lineItem === 'per_property') return propertyCount
  if (lineItem === 'per_permit') return 1
  return 1
}

/**
 * Stripe `tiers_mode: 'graduated'` arithmetic.
 *
 * Each band prices only the units that fall INSIDE it — not the whole
 * quantity. `up_to` is cumulative, so a 20/null pair at 2000/0 charges
 * the first 20 units $20 each and every unit after that nothing:
 * q=2 → $40, q=20 → $400, q=21 → $400, q=50 → $400.
 *
 * This is the half that a "per-property rate" display cannot express,
 * and the reason the old preview printed a single `perProp` number.
 */
export function graduatedCostCents(bands: PriceBand[], quantity: number): number {
  if (quantity <= 0) return 0
  let remaining = quantity
  let floor = 0
  let cents = 0
  for (const band of bands) {
    if (remaining <= 0) break
    const ceiling = band.up_to ?? Number.POSITIVE_INFINITY
    const span = ceiling - floor
    if (span > 0) {
      const take = Math.min(remaining, span)
      cents += take * (band.unit_amount ?? 0)
      cents += band.flat_amount ?? 0
      remaining -= take
    }
    floor = ceiling
  }
  return cents
}

/** What one catalog line costs at this property count. */
export function lineCostCents(line: QuoteLine, propertyCount: number): number {
  const qty = quantityForLine(line.line_item, propertyCount)
  if (qty <= 0) return 0
  if (line.price_model === 'graduated' || (line.tiers && line.tiers.length > 0)) {
    return graduatedCostCents(line.tiers ?? [], qty)
  }
  return qty * (line.unit_amount_cents ?? 0)
}

export interface QuoteBreakdownLine {
  line_item: string
  quantity: number
  /** 'graduated' lines have no single rate; null says so rather than lying with band 1. */
  unit_amount_cents: number | null
  graduated: boolean
  subtotal_cents: number
  /** Bands, passed through so the UI can describe the 20/50 step honestly. */
  bands: PriceBand[] | null
}

export interface Quote {
  total_cents: number
  lines: QuoteBreakdownLine[]
}

/**
 * Price a whole catalog at a property count.
 *
 * Zero-quantity lines are dropped, exactly as Checkout drops them with
 * `.filter(li => li.quantity > 0)`.
 */
export function quoteFromLines(lines: QuoteLine[], propertyCount: number): Quote {
  const out: QuoteBreakdownLine[] = []
  let total = 0
  for (const line of lines) {
    const quantity = quantityForLine(line.line_item, propertyCount)
    if (quantity <= 0) continue
    const graduated = line.price_model === 'graduated' || !!(line.tiers && line.tiers.length > 0)
    const subtotal = lineCostCents(line, propertyCount)
    total += subtotal
    out.push({
      line_item: line.line_item,
      quantity,
      unit_amount_cents: graduated ? null : (line.unit_amount_cents ?? 0),
      graduated,
      subtotal_cents: subtotal,
      bands: graduated ? (line.tiers ?? null) : null,
    })
  }
  return { total_cents: total, lines: out }
}

/**
 * The hard ceiling on properties for a self-serve plan, used only in
 * the "properties 21-50 are free" copy.
 *
 * 🔴 SECOND PLACE HOLDING THIS NUMBER. The enforcing copy is PART 2 of
 * migrations/20261002_property_ceiling_50_with_a1_override.sql, which
 * is where the limit is actually applied (A1 keeps an explicit -1
 * override). This constant only makes a sentence; it enforces nothing.
 * scripts/verify-signup-quote.ts greps that migration and fails if the
 * two disagree, so the copy cannot quietly start promising a range the
 * product no longer allows.
 */
export const PROPERTY_CEILING = 50

/** Cents → "$1,234.00". The only place the estimate becomes a string. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * A human sentence for one priced line.
 *
 * Pure, and kept beside the arithmetic, so the gate asserts the words a
 * buyer reads and not merely the total they add up to. The old preview
 * failed on exactly this axis: the total was wrong AND the explanation
 * under it ("$0/property") was wrong, and nothing checked either.
 *
 * Returns null for a line with nothing worth saying (a $0 permit meter
 * — the allowance copy covers that separately).
 */
export function describeLine(line: QuoteBreakdownLine): string | null {
  if (line.line_item === 'base') {
    return `${formatUsd(line.subtotal_cents)} base`
  }

  if (line.line_item === 'per_property') {
    const unit = line.graduated
      ? (line.bands?.[0]?.unit_amount ?? 0)
      : (line.unit_amount_cents ?? 0)
    const noun = line.quantity === 1 ? 'property' : 'properties'
    const head = `${line.quantity} ${noun} × ${formatUsd(unit)}`

    // The 20/50 step: a trailing unbounded band at zero. Say that the
    // extra properties are included rather than leaving the buyer to
    // wonder why the total stopped moving when they typed 21.
    const cutoff = line.bands?.[0]?.up_to ?? null
    const tail = line.bands?.[line.bands.length - 1]
    const stepsToFree = line.graduated && cutoff !== null && tail?.up_to === null && (tail?.unit_amount ?? 0) === 0
    if (stepsToFree && line.quantity > cutoff) {
      const free = line.quantity - cutoff
      return `${cutoff} properties × ${formatUsd(unit)} · ${free} more included at no charge `
        + `(properties ${cutoff + 1}\u2013${PROPERTY_CEILING} are free)`
    }
    return head
  }

  if (line.line_item === 'per_permit') {
    return line.subtotal_cents > 0 ? `${formatUsd(line.subtotal_cents)} permits` : null
  }

  return line.subtotal_cents > 0 ? `${formatUsd(line.subtotal_cents)} ${line.line_item}` : null
}

/** The full explanation under the headline figure. */
export function describeQuote(lines: QuoteBreakdownLine[]): string {
  return lines.map(describeLine).filter((s): s is string => s !== null).join(' + ')
}
