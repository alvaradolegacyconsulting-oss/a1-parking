# Help docs rewrite: review notes (Oct 22, complete draft, rev 2)

All 13 docs, the CA Getting Started flyer, and one new resident section are drafted in this folder.
**File names and URL slugs are unchanged**, so no links break. Every spot that needs a check is
marked in the file with an `<!-- REVIEW ... -->` comment; Mateo removes each one once it's
resolved, before publishing.

## Settled by Jose (Oct 22)
- **Plan changes aren't self-serve.** The docs say "email support@" (a portal upgrade may come in v2).
- **Deactivating a property lowers the bill at renewal**, not mid-term. Written that way, pending
  Mateo's confirmation below.
- **Starter vs Pro feature split:** as drafted, pending Mateo's confirmation.
- **Support addresses**, following Jose's concern that residents and drivers aren't subscribers:
  - **support@** for company admins and property managers (billing, setup, platform issues);
  - residents and drivers are sent to **their property office or company admin** first;
  - **hello@** only where a non-subscriber contacts ShieldMyLot directly (a resident or driver
    reporting a serious bug, and security reports).

- **Priority support (doc 15): Elite only**, since it's custom. Every self-serve plan gets email
  support on the terms in its SaaS agreement.

## Verification status — 2026-10-22, measured against deployed code

Every item below was resolved by reading the code, not the docs. Only **#1** and **#10** remain
open, and #1 is the only one still carrying an `<!-- REVIEW -->` marker in a doc.

### Closed — confirmed, no doc change needed
- **#2 deactivation lowers the bill at renewal.** `syncOnAdd` increments only when
  `activeCount > current Stripe quantity`, so nothing decrements mid-term; `reconcileAtRenewal`
  sets quantity bidirectionally at the cycle invoice with `proration_behavior='none'`.
- **#2b annual mid-term adds DO bill immediately** — `always_invoice` on annual,
  `create_prorations` on monthly (`stripe-mutations.ts:453`). Doc 13 was right. Two caveats it does
  not yet mention: an add within the quantity already paid for is free either way
  (`noop_within_floor`), and above 20 properties the band is $0, so there is nothing to bill.
- **#4 exempt plates only bypass the limit.** `exempt_plates` is read in three places, all
  manager/admin, and never by the driver portal or any enforcement lookup.

### Closed — corrected in the docs
- **#5** caps by plan: Operator Starter 10 photos / 60s video; Operator Pro unlimited / 120s. Doc
  05 also now names the real UI path for driver property assignment.
- **#6** the PM Starter dialog is accurate and is quoted verbatim in doc 16. The "graduated permit
  rate" wording the note flagged was PM-Only's, replaced 2026-09-04.
- **#7** there are **two** ways to get a pass, not three. `issue_visitor_pass` has exactly two
  callers — the anonymous QR route and the resident portal. No manager-portal issue path exists,
  and no revoke action exists anywhere: the only revocation is the plate-prohibition trigger.
- **#8** the portal refusal now points PM Starter at PM Pro with support@, and doc 04 quotes the
  shipped string verbatim (pinned by `verify:propertycap`).
- **#9** the button reads "Remove This Vehicle"; pending-withdrawal has not shipped, so that
  bullet stands.
- **#11** `tier_required` is **not** inert — it renders verbatim as a visible gold badge
  (`app/help/[slug]/page.tsx:257`) for any value but `"any"`. Doc 12 set to `"any"`, and the live
  `docs/help/12` hotfixed, because the published page was showing a `pm_only_or_legacy` badge.

### 🔴 Open — with Jose
- **#1 the plan feature split.** The effective product — tier flags × render track-gating × the
  server's `my_tier_enforcement_capable()` — disagrees with the public home-page comparison table
  in several cells. Measured in full in the Oct 22 report. Docs 03, 04, 08, 09 and 12 are rewritten
  once in one pass after the ruling, which is why #1 keeps the only remaining marker.
- **#10 carried over, unverified against the SaaS agreement:** the dunning schedule, 30-day
  retention, 30-day price notice, ACH, upgrade/downgrade timing, and doc 15's driver-contact
  claims. Until checked, the docs keep the agreement's wording or say "per your subscription
  agreement" rather than a number.

## Rev 2 fixes (from Mateo's review)
- **08**: removed the "concurrent / monthly cap / max duration" visitor-pass wording in both
  places; it now matches doc 09.
- **00a**: the license step now points to Billing → Company info (not Account Setup).
- **07**: TDLR path added; the REVIEW comment removed.

## Not a docs item, now owned
- **`pm_only` live prices** ($179 + $20) are still active in the Stripe catalog, though PM-Only
  isn't sold. The docs never quote them. This goes on the PM-Only cleanup backlog (archive the
  catalog rows and Stripe prices); Jose runs the Stripe side with a temporary key.

## What changed, by doc
- **03 / 13**: rewritten. Four plans + Elite, the 21–50 free band, the 50-property limit, annual
  for all plans, mid-term adds (monthly prorated / annual immediate), deactivation at renewal.
  Titles are now "Understanding Your Plan" and "Billing and Plan Changes."
- **00a**: plan names; drivers are assigned to properties.
- **01**: the signup step lists the four plans + Elite; Elite replaces Custom quote; the
  "Set up your login" path for residents the office has loaded.
- **02**: plan check rewritten. **Removed** the "billing is manual, Stripe in development"
  paragraph, replaced by the Stripe portal. Broken `../folder/` links fixed.
- **04**: per-plan property billing, the 50 limit, PM Starter → PM Pro, deactivation blocks
  citations and tows, and a note that renaming a property means reprinting its QR codes.
- **05**: drivers on the Operator plans, no cap; **new step to assign properties**; the
  "company-wide, assignment on the roadmap" answer corrected.
- **07**: TDLR/VSF license lines; the two ticket views (storage/owner with fees, PM without);
  Operator-plan CSV export.
- **08**: PM Starter / PM Pro section; "3 / 10 / unlimited" removed; the own-enforcement answer
  now points to Operator Pro.
- **09**: **rewritten**. Three ways to get a pass (QR, resident, office), renewals (each creates
  a new pass and counts; double taps don't), the real per-plate rolling-30-day limit, exempt
  plates, not-permitted plates. Removed the invented "concurrent," "monthly cap" and
  "pending approval" mechanics.
- **12**: Spaces are on PM Starter, PM Pro and Operator Pro.
- **15**: support by plan; addresses split as settled above.
- **16**: metered-approval wording moved from PM-Only to PM Starter.
- **Flyer**: four plan cards (PM Starter & Pro, Operator Starter, Operator Pro, Elite) in a 2×2
  grid; "(Enforcement / Legacy)" labels → "(Operator plans)."
- **NEW**: the resident section "Removing a vehicle you no longer own."
