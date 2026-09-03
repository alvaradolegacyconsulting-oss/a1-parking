# Negotiated permit allowance for proposal codes — Gap 2

**Filed:** September 3, 2026
**Priority:** BACKLOG — not a signup blocker. Revenue-upside item.
**Origin:** Mateo Sep 3 §3 during picker research.

## The gap

The self-serve `pm_starter` tier has a graduated permit price (500 included at
$0.00, then $1.25 each above). The negotiated-track (proposal_code) path has no
`per_permit` line at all — `ProposalCodeLineItem` union today is `base` + `per_property`
only. `per_permit` is in the standard-catalog `LineItem` union but not the
proposal-code one.

**Consequence:** a negotiated customer at, say, $300 flat with 2,500 permits included
can be provisioned today by issuing a proposal code at `$300 base` with **zero
per_permit line**. That works cleanly — no meter, no allowance to enforce, no cap.

**The gap fires only if the customer OUTGROWS their negotiated allowance** and we want
to bill overage. E.g., $300 flat with 2,500 included + metered at $0.80 above 2,500.
That shape has no proposal-code line-item to represent it today; would require:

1. Widen `ProposalCodeLineItem` union to include `per_permit`
2. Extend the proposal-code creation UI (`app/admin/proposal-codes/new/page.tsx` +
   `[code]/page.tsx`) to accept a graduated permit-tier JSONB per code
3. Extend `create-stripe-prices.ts` proposal-code branch to create per-code graduated
   Prices (same shape as the standard pm_starter per_permit price but with the code's
   custom allowance + rate schedule)
4. Verify the same Pattern-C per-code Product model works with graduated pricing
   (project_b232_legacy_proposal_code_pattern_c reference)

## Why not now

Two-part reason (Mateo Sep 3 §3):

**The 500-permit allowance exists to bound a self-serve subscriber nobody has spoken
to.** A negotiated customer has been spoken to — the pricing is deliberate. Either the
$300 flat suits them (no meter needed) or they need a custom shape we build once when
we have that customer.

**Consolidation vs scale — two different controls:**
- The one-property cap (cap sequence A→A₀) is the **anti-consolidation** control.
  Prevents ten properties under "ABC Holdings, LLC."
- The 500-permit allowance bounds how **large** a single property can get on $149.
  A 900-unit complex is one property, passes the cap, and pays $149 + 400 × $1.25 =
  $649 — the allowance working as designed.

Conflating them leads to changing the wrong number.

## Trigger conditions to build

Any of:

1. A negotiated deal is proposed at `$X flat + $Y/permit above Z included` — this is
   the first customer whose deal shape requires the widening
2. A negotiated deal is proposed at `$X flat` with a claim that the customer expects
   to exceed some permit threshold — this is the revenue-upside signal
3. Post-launch, self-serve pm_starter customers request a "same tier with more
   included allowance" negotiated variant

Absent any of these, don't build. Filing so the option is discoverable when a real
customer shape needs it.

## Related

- `feedback_missing_column_is_correct_shape` — the pm_starter no-per_property invariant
- `project_b232_legacy_proposal_code_pattern_c` — proposal-code Pattern C (per-code
  Product)
- `stripe-catalog.ts` — self-serve catalog helper with `per_permit` line
