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

## For Mateo to verify before publishing
1. **Feature split vs `TIER_CONFIG`.** Operator Pro adds resident self-registration, visitor
   passes, Spaces and guest authorizations; PM Starter vs PM Pro differ only in scale. Also check
   leasing agents, CSV export, house rules and tags by plan.
2. **Property deactivation and billing:** confirm "lowers at renewal" against the Stripe quantity
   ratchet (docs 13, 04).
3. ~~TDLR license~~ **Resolved (rev 2):** company admins set it under **Billing → Company info**
   (live). Docs 07 and 00a now point there. Separately, the **dead duplicate TDLR field** in
   Manage → Company (`company_admin/page.tsx:8760`, unreachable under `CA_CRM_REDESIGN`) is
   approved for deletion as its own commit.
4. **Exempt plates:** doc 04 says they only bypass the visitor pass limit; the old doc 09 said
   drivers see them as exempt in lookups. Confirm which is true (doc 09 marks the spot).
5. **Driver property assignment (doc 05):** give the exact UI path. Confirm whether photo/video
   caps still differ by plan.
6. **Approval-authority dialog (doc 16):** its metered copy was written for PM-Only ("graduated
   permit rate"). What does PM Starter show now, and is it accurate?
7. **Visitor pass forms (doc 09):** list the current manager and resident form fields (start
   time, duration choices, notes).
8. **Portal message (doc 04):** the PM Starter second-property refusal still says "contact us
   about upgrading — hello@". Change it to point to PM Pro and support@, and update the quote in
   doc 04 to match.
9. **Resident remove-a-vehicle section:** confirm the button label, and whether resident
   withdrawal of a pending request has shipped.
10. **Carried over unchanged, unverified:**
    - the dunning schedule (Days 0/3/5/7);
    - 30-day data retention;
    - 30-day price-change notice;
    - ACH support;
    - upgrades immediate / downgrades next cycle;
    - doc 15's "your company admin will be notified" when a driver emails us;
    - doc 05's "ShieldMyLot doesn't email drivers" and "drivers see only their own violations";
    - doc 02's profile fields (business hours, tax ID, insurance).
11. **Frontmatter:** doc 12 has `tier_required: "pm_only_or_legacy"`. If code reads that key for
    gating, update it to the current plan keys; otherwise leave it.

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
