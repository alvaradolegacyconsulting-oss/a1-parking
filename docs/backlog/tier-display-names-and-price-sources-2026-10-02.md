# Backlog — display names in-app, and the last TIER_PRICING readers

**Date filed:** 2026-10-02
**Trigger:** live two-line acceptance run. Stripe Checkout quoted Operator
Pro correctly ($299 + 2 × $20 = $339); every screen before it said
"$199.00 — $199/mo base + $0/property × 2" and "Enforcement · Legacy".
Caught before payment. `/signup` and `/signup/verify` were fixed in the
same session; this file is what was deliberately left.

**Ruling:** Jose, 2026-10-02. The four items below were reported as
findings and folded into the already-queued badges/labels follow-up.

## The pattern

Two separate leaks, both from the same root — **the display layer was
allowed to hold product facts it does not own.**

1. **Prices.** `TIER_PRICING` (app/lib/tier-config.ts) is a hardcoded
   map whose `legacy` entry reads `{ base: 199, perProperty: 0 }`,
   annotated in its own comment as an "internal display value". It was
   internal right up to the moment it was the headline figure on a
   public purchase page. The real prices live in `stripe_prices`.
2. **Names.** `legacy` is the backend key for BOTH Operator Pro and PM
   Pro. Anything that renders the tier key, or capitalises it as a
   fallback, shows a buyer our internal vocabulary.

Already closed on the signup path: prices now come from
`/api/signup/quote` → `getStandardCatalogLines` (the function Checkout
calls), and names from `tokenFor()` → `displayName()`. Gate:
`npm run verify:quote`, 40 cells, cross-checked against Stripe.

## Item 1 — CA portal plan card

**File:** app/company_admin/page.tsx:9033-9095

Two problems, one of them visible to paying subscribers today:

- **Label.** `planLabel = isLegacy ? `${trackLabel} · Legacy` : …`
  renders "Enforcement · Legacy" / "Property Management · Legacy".
  → Show the display name: **Operator Pro / PM Pro / Operator Starter**,
  resolved with `tokenFor(track, tier)` + `displayName(token)` from
  app/lib/signup-tier-param.ts. Same helper the verify page now uses.
- **Price.** The `isLegacy` branch short-circuits to *"Tailored rate ·
  see Stripe billing portal for the current amount."* That is why no
  wrong price reaches a subscriber today — the branch fires before
  `catalogTotal` (which would compute `199 + 0 × propertyCount`) is
  ever rendered. **It is correct by accident, and it stops being true
  the moment a self-serve Pro subscriber exists:** Pro has a published
  price, so "tailored rate" misdescribes it.

  → **"Tailored rate" only when the company actually has a negotiated
  deal** — i.e. a proposal code (A1, Elite). Self-serve Pro shows its
  plan name and its published price, sourced from the quote endpoint,
  not from `TIER_PRICING`.

  🔴 The discriminator is **the proposal code, not the tier key.** Both
  populations carry `tier = 'legacy'`; that key cannot tell them apart.

## Item 2 — getUpgradePrompt

**File:** app/lib/tier.ts (the `getTierPricing(tt, candidate)` call)

Safe only by accident: `TIER_LADDER` is a single-element array per
track, so the loop never reaches a second candidate and no price is
ever surfaced. Adding a Pro tier to that ladder — which launching
self-serve Pro invites — immediately starts quoting $199 as an upgrade
price in the CA portal.

**Done 2026-10-02:** a loud note sits at that call site so whoever adds
the ladder step reads it before shipping. Nothing else changed, because
nothing is currently wrong.

→ When the ladder step is added, price it through the quote endpoint.

## Item 3 — proposal-code forms + PDF template

**Files:** app/admin/proposal-codes/new/page.tsx:133,
app/admin/proposal-codes/[code]/page.tsx:233,
app/lib/proposal-pdf-template.ts:56

All three prefill a negotiated price with `getTierPricing(...)?.base ?? 0`.
For `legacy` that seeds **$199**. These are admin-authoring defaults an
admin can edit, so this is not a customer-facing quote — but **an admin
who accepts the default by accident undercuts the price list by $100 on
a signed proposal.**

→ Default to the published figure by track: **Operator Pro $299 +
$20/property**, **PM Pro $249 + $15/property**. Or leave it blank and
force an explicit entry. Blank is the safer shape if the catalog cannot
be read from these admin surfaces — an empty field asks a question; a
wrong default answers it.

## Item 4 — retire or rename TIER_PRICING

Once Items 1–3 land, nothing customer-facing reads it.

→ Delete it, or rename it so its nature is unmistakable at the call
site — `INTERNAL_LEGACY_PRICE_HINTS` or similar. A map named
`TIER_PRICING` will be read as a price list by the next person,
whatever its comment says. That is exactly how this bug shipped.

🔴 Check `TIER_LADDER`/`TIER_DISPLAY_NAME` consumers in the same pass:
the three maps are keyed alike and a rename that misses one produces a
silent `undefined` → `?? 0` → $0.

## Verification when this is picked up

- `npm run verify:quote` must stay green (it fails if `/signup` or
  `/signup/verify` regains a local price read).
- Add a CA-portal cell: a `legacy` company **with** a proposal code
  shows "tailored"; one **without** shows the published price. Two
  fixtures — one of each — or the gate proves nothing, since a branch
  that always says "tailored" passes a test that only checks A1.

## Related standing rules

- [[feedback_tier_pricing_omission_audit]] — TIER_PRICING omission +
  `?? 0` fallthrough fabricates pricing. This is that rule's live
  consequence.
- [[project_b34_tier_config_drift]] — tier facts split across TS config
  and SQL.
- [[feedback_absence_must_not_be_failure_output]] — a missing catalog
  row makes a total smaller, not an error. The quote endpoint 503s on a
  short catalog rather than quoting a confident partial basket.
- docs/backlog/tier-vocabulary-retired-references-sweep-2026-09-04.md —
  sibling sweep; same rot class, vocabulary rather than price.

## Priority

**Item 1 before the first self-serve Pro subscriber exists** — it is the
only one with a live customer-facing surface, and a Pro buyer landing in
the CA portal to find "Enforcement · Legacy · Tailored rate" contradicts
the page they just bought from. Items 2-4 are hygiene; 4 is cleanup.
