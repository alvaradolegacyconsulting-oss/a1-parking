# Backlog — the property-add notice should only fire when the bill moves

**Date filed:** 2026-10-03
**Ruling:** Jose, after the live two-line acceptance run.
**File:** app/company_admin/page.tsx:1567-1586 (`perPropCopy` + the
`window.confirm` immediately below)

## The ruling

Show the "price may change" notice **only when the add will actually
raise the bill**:

| Situation | Notice |
|---|---|
| Above the paid quantity, properties 1-20 | **Yes** — with the real amount: *"+$20/month, prorated this period"* |
| Within the already-paid quantity | **No** |
| Above 20 (properties 21-50) | **No** — the band is $0 |
| At 50 | The existing **Elite** message |

## Why today's version is wrong

```ts
const perPropCopy =
    ctx.tier === 'pm_starter'         ? 'no per-property fee — …'
  : ctx.tier === 'pm_only'            ? '$20/mo per property (PM-Only base)'
  : ctx.tier === 'enforcement_only'   ? '$15/mo per property (Enforcement-Only base)'
  : ctx.tier === 'legacy'             ? 'the custom per-property rate on your negotiated contract'
  : /* fail-closed */                   `an unrecognised plan (${ctx.tier}). …`
window.confirm(`Adding "${name}" will change your bill: ${perPropCopy}.`)
```

It warns **unconditionally**, and it is wrong in four distinct ways:

1. **It fires when nothing changes.** Above 20 the graduated band is
   $0 — the bill does not move — and the dialog still says "will change
   your bill". Within the already-paid quantity it also does not move.
2. **The rates are hardcoded.** `$20` and `$15` are string literals in
   the component. This is the identical construction that had `/signup`
   advertising $199 for a $339 subscription on 2026-10-02. **Source the
   rate from the quote endpoint** (`/api/signup/quote` →
   app/lib/pricing-quote.ts), the same rows Stripe charges from.
3. **`legacy` says "your negotiated contract".** True for A1 and Elite;
   false for a self-serve Operator Pro or PM Pro subscriber, whose
   per-property rate is published ($20 / $15). Same discriminator
   problem as the CA plan card — **both populations carry
   `tier = 'legacy'`, so the tier key cannot tell them apart. Key on
   the proposal code.**
4. **It says "will change your bill" without saying when.** See below —
   this differs by cycle and the current copy implies "now" for
   everyone.

## 🔴 The two things that make this harder than it looks

**(a) "Above the paid quantity" needs the PAID quantity, not the
property count.** Those are deliberately different numbers.
`syncOnAdd` sets an **absolute** quantity and **ratchets upward only**;
the renewal-trim path (`syncOnRemove`) brings it back down. So a company
that added and then deactivated a property is still paying for the high
water mark, and their next add is genuinely free. Comparing against
`properties.length` would warn about a charge that will not occur —
which is the bug being fixed, in a new place.

The paid quantity lives on the **Stripe subscription item**, not in a
column. Decide deliberately: read it live (a Stripe call on a dialog),
or mirror it into `companies` at sync time and read the mirror. A mirror
is a projection and will drift unless it is written in the same place
`syncOnAdd` writes to Stripe.

**(b) "Prorated this period" is only true on monthly.** From the
2026-10-02 annual-adds change:

- **Monthly** — `proration_behavior: 'create_prorations'`. The charge is
  **deferred to the next invoice**. Correct copy: *"+$20/month, added to
  your next invoice."*
- **Annual** — `proration_behavior: 'always_invoice'`. The customer is
  **billed immediately** for the remainder of the term. Correct copy
  names a real one-off charge now, not a monthly delta.

One sentence cannot serve both. Branch on cycle.

## Verification when picked up

Fixtures must include the case that distinguishes the fix from the bug:
a company **below its paid quantity** (add → no notice) and one **at
21+ properties** (add → no notice). A dialog that always warns passes
any test that only checks "warns when adding property #2".

## Related

- docs/backlog/tier-display-names-and-price-sources-2026-10-02.md —
  items 1 and 3 are the same hardcoded-price class, same proposal-code
  discriminator.
- [[feedback_syncOnAdd_absolute_not_delta]]
- [[feedback_billing_is_subscriber_only]] — CA-only surface; do not
  leak amounts onto manager/resident views.
