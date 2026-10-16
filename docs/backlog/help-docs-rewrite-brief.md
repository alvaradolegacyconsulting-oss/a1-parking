# Help docs rewrite — brief for the drafter

**Prepared:** 2026-10-16 · **Drafts:** Claude · **Reviews:** Jose · **Publishes:** Mateo
**Companion:** [`help-docs-plan-name-rewrite-2026-10-10.md`](help-docs-plan-name-rewrite-2026-10-10.md)
— that file already carries the **line-by-line inventory of all 65 occurrences** with file paths
and surrounding text. This brief is the other half: the canonical facts, pulled from the live
system rather than from memory or from the docs themselves.

---

## 🔴 Read this first: it is not a rename

A find-and-replace leaves these docs wrong in a worse way. They describe a **two-plan world that
no longer exists** — `PM Starter` + `Enforcement-Only` + "Custom quote". Across all 17 help docs:
zero mentions of Operator Pro, PM Pro, Operator Starter, Elite, or the 21–50 property band.

The rename is the small half. The missing half is two entire plans, the property band, and Elite.

---

## Where the facts come from, and why that matters

🔴 **Do not price anything from `TIER_CONFIG` or any hardcoded map.** `TIER_PRICING` was
**retired on 2026-10-10** after shipping a $199 headline on `/signup` for a subscription Stripe
then billed at $339 — caught in a live acceptance run, before anyone paid. Its `legacy` entry read
`{ base: 199, perProperty: 0 }` while Operator Pro is $299 + $20 and PM Pro is $249 + $15; one map
entry cannot price two plans, and no static map can price a graduated band.

The source of truth is the **`stripe_prices` catalog**, reached through `/api/signup/quote` — the
same rows Checkout charges from. Everything below was read from the live catalog on 2026-10-16.

## Canonical pricing (live catalog, `mode = live`, `is_active = true`)

| Plan (doc name) | track / tier key | base monthly | base annual | per property |
|---|---|---|---|---|
| **Operator Starter** | `enforcement` / `enforcement_only` | $199 | $1,990 | $15 for the first 20, **$0 for 21+** |
| **Operator Pro** | `enforcement` / `legacy` | $299 | $2,990 | $20 for the first 20, **$0 for 21+** |
| **PM Pro** | `property_management` / `legacy` | $249 | $2,490 | $15 for the first 20, **$0 for 21+** |
| **PM Starter** | `property_management` / `pm_starter` | $149 | $1,490 | n/a — 500 permits included, then $1.25 each |
| **PM-Only** (see below) | `property_management` / `pm_only` | $179 | $1,790 | $20 flat; permits tiered at 50 / 200 / 500 |
| **Elite** | — | contact sales | — | above 50 properties |

- **Annual is ×10** — ten months for twelve. True in every row of the catalog, not just as a rule
  of thumb.
- The **21+ free band is in the catalog itself**, as a graduated price:
  `[{up_to: 20, unit_amount: …}, {up_to: null, unit_amount: 0}]`. It is not a discount applied
  elsewhere.

### The three mappings that are not 1:1

| In the docs | Becomes | Note |
|---|---|---|
| `Enforcement-Only` | **Operator Starter** | Clean 1:1. Same plan, same $199 + $15. Most of the 65 hits. |
| `PM-Only` | — | 🔴 Not a self-serve plan. Negotiated-only since the Aug 31 rewrite; `/signup` cannot reach it. Do **not** rename it to PM Pro. Describe it as a negotiated arrangement, or cut it. **Open question for Jose:** live prices for `pm_only` ($179 + $20) still exist in the catalog. Those two facts need reconciling before the docs describe either. |
| `Legacy` | **Operator Pro** *or* **PM Pro** | 🔴 Depends on the track. `legacy` is the backend key for both: on enforcement it is Operator Pro, on property management it is PM Pro. Each occurrence needs reading, not substituting. |

## The 50-property ceiling — **verified 2026-10-16**

Safe to state in the docs. It is enforced **server-side**, and the enforcement was proven by
execution, not by reading the migration:

- `get_effective_property_limit()` returns **50** for `enforcement_only` and `legacy`, **1** for
  `pm_starter`, **-1** (unlimited) for `pm_only` and for A1 (proposal-code override).
- A canary on Test-ENF seeded to exactly 50 properties and attempted the 51st:
  **refused, sqlstate 23514** — *"Property limit exceeded: tier allows 50 active properties."*
  All 49 seeded rows were removed and read back as gone.
- Precedence is: proposal-code `feature_overrides.max_properties` **first**, then the per-tier
  default. Any negative value means unlimited.

🔴 **An earlier note in this project said the tier CASE was stale and new-model tiers fell through
to unlimited. That note is out of date** — the `ELSE` was made to RAISE on 2026-09-02, and the 50s
landed on 2026-10-02. No tier is wrong today. An unrecognised tier now fails loudly instead of
silently granting unlimited.

**Still worth saying in the docs:** an Elite proposal code **must** set `max_properties`, or the
account inherits 50.

## What differs by plan

Features are resolved through `hasFeature()` against `TIER_CONFIG` (`app/lib/tier-config.ts`) —
that file remains correct for **features**; it is only **pricing** that was removed from it. The
drafter should read the per-tier blocks there rather than restating a feature list from the
current docs, which predate two plans.

---

## Scope: the docs to rewrite

Thirteen help docs plus the flyer carry a plan name or a price:

| file | lines matching |
|---|---|
| `docs/help/03-understanding-your-tier.md` | **27** — the clearest case; its plan table has two rows and there are now four plus Elite |
| `docs/help/13-billing-and-tier-changes.md` | **27** — carries worked examples at $124/mo, $166/mo, $150/property, $12.50 and $1.25 |
| `docs/help/04-adding-properties.md` | 12 |
| `docs/help/01-signup-and-first-login.md` | 7 |
| `docs/help/15-support-and-contact.md` | 7 |
| `docs/help/02-account-setup.md` | 4 |
| `docs/help/09-visitor-passes.md` | 4 |
| `docs/help/16-approval-authority-grants.md` | 4 |
| `docs/help/00a-getting-started-company-admin.md` | 3 |
| `docs/help/08-property-management-overview.md` | 3 |
| `docs/help/05-provisioning-drivers.md` | 2 |
| `docs/help/12-spaces-and-reserved-parking.md` | 5 |
| `docs/help/07-tow-tickets-and-evidence.md` | 1 |
| `docs/GettingStarted_CompanyAdmin_flyer.html` | 5 |

The $1.25 permit overage and the $149 / $199 bases are still correct. The derived annual
equivalents in `13-billing-and-tier-changes.md` should be re-derived once the Pro rows exist.

## Also to add

- The resident section **"remove a vehicle you no longer own"**.
- **Elite**, which appears nowhere today.
- The **21–50 free property band**, which appears nowhere today.

## Working rule for the drafter

Where a constant exists, name the behaviour and let the product show the number — the docs should
not become a second price list. The one number safe to write out is the one the catalog and the
page both derive from the same row.
