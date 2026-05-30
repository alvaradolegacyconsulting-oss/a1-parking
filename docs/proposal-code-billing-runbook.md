# Proposal-Code Billing Runbook (TX Sales Tax)

**Audience:** Jose (admin) — operational discipline for proposal-code customer billing.
**Last updated:** 2026-05-30 (filed with B66.9).

---

## Why this runbook exists

B66.9 (Texas Sales Tax integration) wired the TX Sales Tax Rate into the **self-serve Checkout** path automatically — every self-serve subscription gets `default_tax_rates: [TX_TAX_RATE_ID]` attached at creation, so 6.6% TX tax renders on every invoice.

The **proposal-code path bypasses Stripe subscription creation entirely.** Per the B66.9 Step 4 finding: `redeem_proposal_code` RPC creates the `companies` row with `account_state='active'` but `stripe_customer_id=NULL` and `stripe_subscription_id=NULL`. The Stripe Prices created at proposal-code issue time exist but are not linked to a subscription. Customer billing for proposal-code subscribers is handled manually by Jose — either via off-platform invoicing (check/wire) or by creating a Subscription/Invoice in the Stripe Dashboard manually.

**This runbook covers the discipline for that manual path.** Without it, manually-created Stripe Subscriptions for proposal-code customers would ship untaxed invoices, putting us out of compliance with the Texas Comptroller and creating a remediation mess.

---

## The rule

> **No account-level default exists for manual tax rates.** If a proposal-code subscription is ever created manually in the Dashboard, the TX Sales Tax Rate MUST be attached explicitly via Subscription → Tax Rates. Per current operating plan this path is not exercised before B66.7 — proposal codes are not issued pre-launch, and A1 is billed offline until B66.7 then migrated via B66.7's code path (which injects `default_tax_rates` automatically).
>
> This runbook is belt-and-suspenders for the genuinely-unexpected case where a manual Dashboard subscription IS created for a proposal-code customer before B66.7 lands.

The TX Tax Rate ID is `STRIPE_TEST_TX_TAX_RATE_ID` (test) or `STRIPE_LIVE_TX_TAX_RATE_ID` (live), set as Vercel env vars. To look it up in the Dashboard:

- Navigate to **Products → Tax Rates** in Stripe Dashboard
- Filter by `metadata.purpose=b66_9_tx_tax`
- Confirm `display_name='Texas Sales Tax'` and `description='6.6% effective (8.25% × 80% taxable basis, 34 TAC §3.330)'`
- Copy the rate ID (`txr_...`)

---

## Step-by-step (manual Subscription creation)

1. **Stripe Dashboard → Customers** — find or create the customer record for the proposal-code subscriber.
2. **Customers → [the customer] → Create subscription** (or click the relevant Subscription if updating).
3. **Add Prices** — select the proposal-code's pre-created Stripe Prices (created at `/admin/proposal-codes/[code]/issue` time per B66.2b).
4. **Tax rates section** — attach the TX Sales Tax Rate explicitly. No account-level default exists for manual Pattern B rates (Stripe's only account-level tax automation is `automatic_tax`, which is Pattern A — location-sourced — and deliberately NOT used per B66.9). Forgetting this step ships an untaxed invoice; there is no platform-level backstop.
5. **Confirm** — the preview should show:
   - Subscription line: $XXX.XX
   - TX Sales Tax (6.6%): $YY.YY
   - **Total: $XXX.XX + $YY.YY**
6. **Create**. Customer's first invoice will carry the tax line correctly.

---

## Step-by-step (manual Invoice creation, off-subscription)

For one-off charges (setup fees, custom invoices) to proposal-code customers:

1. **Stripe Dashboard → Invoices → Create invoice** for the customer.
2. **Add line items** — describe + amount.
3. **Tax rates section** — attach the TX Sales Tax Rate (same `txr_...` as above).
4. **Send invoice**.

---

## Why there's no platform-level backstop

**No account-level default exists for manual tax rates. Do NOT enable Stripe Tax (Settings → Tax) — it is Pattern A, location-sourced, and would zero-rate out-of-state subscribers of our Texas-delivered service. Explicit per-subscription attach is the only mechanism.**

The operating plan keeps the manual path closed: proposal codes are not issued pre-launch. A1 (only near-term proposal-code customer) is billed offline until B66.7, then migrated onto the system via B66.7's auto-creation path which injects `default_tax_rates` in code. So the manual-Dashboard tax path is not expected to be exercised at all pre-B66.7.

This runbook exists for the belt-and-suspenders case: if an emergency requires manually creating a proposal-code Subscription in the Dashboard before B66.7 ships, the steps above are the explicit-attach procedure.

---

## When to update this runbook

- When B66.7 (proposal-code → Stripe Subscription auto-creation) ships → much of this runbook becomes obsolete; tax application will be code-driven for proposal-code customers too. Mark sections "DEPRECATED" rather than deleting, so the institutional pattern remains visible.
- If the TX Sales Tax Rate is rotated (e.g., regulatory rate change) → update the lookup procedure section above.
- If Stripe ever introduces an account-level default for manual rates (Pattern B) → update the "Why there's no platform-level backstop" section to reflect the new option. (Today: Stripe's only account-level automation is `automatic_tax` = Pattern A, which we explicitly DO NOT use.)

---

## Cross-references

- [[project-b66-9-texas-tax-closure]] — sub-arc closure note
- [[pattern-tax-rate-configuration-pattern-b-vs-a]] — why fixed Tax Rate (Pattern B) vs `automatic_tax` (Pattern A)
- [[decision-6-6-flat-over-8-25-on-80-basis]] — Q1 reasoning (mechanism elimination + encoded-name clarity recovery)
- `scripts/create-stripe-tax-rate.ts` — the script that creates the Tax Rate
- `app/api/signup/create-checkout-session/route.ts` — the self-serve path that has tax wired in code (proposal-code does NOT have this; this runbook is the gap-filler)
