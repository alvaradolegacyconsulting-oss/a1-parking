// B233 — proposal-code line-item derivation, extracted from
// proposal-code-stripe.ts so BOTH server-side executor AND client-side
// admin confirm dialog import from the same source. Prior state:
// proposal-code-stripe.ts was 'server-only' → the admin confirm dialog
// (client component) couldn't import lineItemsForCode; it had to
// inline-duplicate the count logic. That's exactly how the confirm
// dialog's `expectedPriceCount = enforcement === 3 ? 3 : 2` went stale
// after per_driver retirement (Slice 1 Commit 5, 2026-07-04) — the
// executor's actual derivation moved on and the client-side hardcoded
// count didn't. Root cause = duplication; fix = share.
//
// This module is pure derivation (no runtime state, no side effects,
// no server-only imports), so both client + server code paths can
// consume it. See [[feedback_preview_and_executor_share_line_items]].
//
// proposal-code-stripe.ts re-exports from here for backward-compat with
// existing consumers (start-billing/route.ts) — no import-path churn.

export type LineItem = 'base' | 'per_property' | 'per_driver'

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
 * per_permit customization (PM-Only) for custom Legacy codes is Gap 2 —
 * deferred as Bar-2 per architect 2026-07-04 (A1 doesn't meter).
 */
export function lineItemsForCode(
  code: {
    base_tier_type: 'enforcement' | 'property_management'
    base_tier: 'starter' | 'growth' | 'legacy' | 'premium' | 'essential' | 'professional' | 'enterprise'
    custom_base_fee: number | null
    custom_per_property_fee: number | null
  }
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
