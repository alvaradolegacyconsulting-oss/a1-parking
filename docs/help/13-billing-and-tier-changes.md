---
title: "Billing and Tier Changes"
category: "Shared"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-09-04"
related: ["understanding-your-tier", "account-setup", "support-and-contact"]
---

# Billing and Tier Changes

This guide covers how ShieldMyLot™ billing works, what drives your bill, and how to make changes.

## The three plans, at a glance

- **PM Starter** — For a property manager running a single community. **$149/mo flat**, one property included, first 500 approved permits per month included, then $1.25 per additional permit. Self-serve signup.
- **Enforcement-Only** — Towing and enforcement operators. **$199/mo base + $15/mo per property.** No per-permit meter. No per-driver charge. Self-serve signup.
- **Custom quote** — Multi-property PM, combined PM + enforcement, or non-standard needs. Custom-negotiated pricing set at proposal-code issue time. Numbers vary by contract; not published publicly. Onboarded via a proposal code from ShieldMyLot.

See [Understanding Your Tier](03-understanding-your-tier.md) for what each plan includes.

---

## You only pay for what you use

ShieldMyLot's pricing model:

- **Base fee** covers what your plan does. For PM Starter, that's your single property plus the first 500 approved permits. For Enforcement-Only, that's the platform baseline.
- **Adding a property (Enforcement-Only)** raises your bill by $15/mo, immediately reflected on your next invoice. PM Starter is for one property — contact us to expand.
- **Approving a resident vehicle (PM Starter)** counts as one permit. **First 500 approved permits per month are included in your $149 base.** Permits beyond 500 bill at $1.25 each.
- **Adding drivers, property managers, or leasing agents** does not affect your bill. There is no cap on any of these.
- **Reserved parking (Spaces)** is included on PM Starter at no additional cost.

Pending vehicles and declined vehicles do not count toward the permit meter.

### How the permit meter works

**Your billed permit count reflects the highest number active during the cycle** and adjusts to the current active count at your next renewal. Two examples:

- You approve 400 permits in March and stay at 400 through April → April's invoice reflects 400 permits (0 overage; all within the 500 allowance).
- You approve 600 permits in March and deactivate back to 400 in April → March's invoice reflected 600 permits (100 overage at $1.25 = $125). April's invoice adjusts to the current active count at renewal.

Deactivating a permit mid-cycle doesn't reduce that month's charge. The count adjusts at the next renewal.

---

## Annual vs monthly billing

ShieldMyLot offers both monthly and annual billing.

**Monthly:**
- Pay each month for that month.
- More flexible — you can change plans month-to-month if your needs shift (plan changes involve a support call — see below).
- No commitment beyond the current month.

**Annual:**
- Annual billing is available at **10 months' rate — approximately 17% off**.
  - **PM Starter** — $1,490 per year (equivalent to ~$124/mo)
  - **Enforcement-Only** — $1,990 per year plus $150 per property per year (equivalent to ~$166/mo base + ~$12.50/property)
- Locks you in for the annual term.
- You can move to Custom quote mid-year (prorated). Standard plan switches happen at renewal.

---

## Refunds

**14-day money back on the first month** if PM Starter or Enforcement-Only isn't the right fit. Contact hello@shieldmylot.com within 14 days of your first charge.

---

## Billing platform

ShieldMyLot billing runs through Stripe. When you complete signup:

- You enter your payment method during checkout (credit card or ACH).
- Invoices are generated automatically per your billing cycle (monthly or annual).
- You'll receive invoice receipts by email at your billing contact address.
- **Manage Billing** (Company Admin → Billing tab) opens the Stripe customer portal where you can update your payment method, view invoice history, update billing address, and cancel.

Custom quote customers may have alternate arrangements (e.g., ACH via invoice) documented in the negotiated proposal. Your Billing tab reflects your actual setup.

### Texas sales tax

Texas SaaS sales tax applies to your subscription — Stripe Tax handles the jurisdiction lookup and shows the tax line item separately on each invoice.

---

## Custom-negotiated (Custom quote) pricing

Custom quote accounts have pricing arrangements set at proposal-code issue time. Depending on how your account was configured:

- Different per-property rates
- Different or no per-permit meter
- Any combination of PM and Enforcement-Only features

Your Plan tab reflects your actual configuration. Your invoices reflect your negotiated rates.

If you're not sure whether you have a Custom quote arrangement, check your Plan tab: it will show your specific plan name.

---

## Changing plans

Most customers pick a plan at signup and stay there. When you need to change:

### Between the two self-serve plans (PM Starter ↔ Enforcement-Only)

These are separate products with different feature sets. Switching between them is not a "plan upgrade" — it's effectively changing what your account is for. Contact hello@shieldmylot.com and we'll discuss whether:

- A plan switch on your existing account makes sense, or
- A Custom quote configuration (both tracks combined, or multi-property PM) fits better

### To or from Custom quote

Contact hello@shieldmylot.com. Custom quote configurations are negotiated per-account; there's no self-serve path.

### Effective dates

- **Custom quote upgrades** on monthly billing generally apply immediately (prorated).
- **Custom quote upgrades** on annual billing apply immediately with proration on the annual amount.
- **Downgrades** apply at your next billing cycle (protects you from mid-cycle disruption). Deactivate any resources that exceed the target plan's limits before requesting the downgrade.

---

## Changes to pricing

If ShieldMyLot changes pricing for your plan (rare, but possible), you'll receive at least **30 days' notice** before the new pricing takes effect. Larger price increases may get 60 days' notice.

- **Monthly** customers: new pricing applies at your next billing cycle after the notice period.
- **Annual** customers: pricing is locked for the duration of the annual term. New pricing applies only at renewal.

---

## Cancellation

If you decide to cancel:

1. Open **Company Admin → Billing** → **Manage Billing** to reach the Stripe portal. From there you can schedule cancellation at end of your current billing period.
2. Or email hello@shieldmylot.com if you'd prefer a support-assisted cancellation.
3. Your account stays active through the end of your current billing period (monthly or annual).
4. After the cancellation effective date, your account is deactivated.

### Data retention after cancellation

- Your data is retained for **30 days** after cancellation, in case you want to reactivate.
- During that 30 days, you can request a data export.
- After 30 days, data is purged from active systems but retained in compliance archives for Texas Chapter 2308 record retention requirements (typically 7 years).

Request any data export before the 30-day window closes.

---

## Non-payment and dunning

If a payment fails (expired card, insufficient funds, etc.), ShieldMyLot's dunning process:

1. **Day 0** — Stripe attempts the charge, receives a failure code. You'll get an email notification.
2. **Day 3 / Day 5 / Day 7** — Stripe retries the charge with an email reminder each time.
3. **Grace period** — Your account remains active during dunning attempts so a temporary card issue doesn't disrupt operations.
4. **Suspension** — If all retries fail, your account is suspended. Reactivating requires updating your payment method (via the Stripe portal) and paying the outstanding balance.

To avoid dunning: keep your payment method current in the Stripe portal.

---

## Invoice questions

If something on an invoice doesn't look right:

1. Check your Billing tab to see current subscription status and next billing date.
2. Compare the invoice to your service agreement (Custom quote accounts especially).
3. If there's a discrepancy, email hello@shieldmylot.com with the invoice number and your concern.

Common questions:

- **"Why is my invoice higher than last month?"** — For PM Starter: most commonly you crossed the 500-permit allowance and are now paying $1.25 per additional permit. For Enforcement-Only: you added a property (per-property line increased). Both show on the Billing tab under current-cycle usage.
- **"I deactivated permits/vehicles mid-cycle. Why didn't my bill drop?"** — The billed permit count reflects the highest number active during the cycle. The count adjusts to your current active count at your next renewal.
- **"I see a charge I don't recognize."** — Check the invoice line items. Each corresponds to base, per-property, or (PM Starter) per-permit overage.

---

## Common questions

**Can I pay by ACH instead of credit card?**
Yes, via the Stripe customer portal on your Billing tab. Both credit card and ACH are supported.

**Can I get a quarterly billing option?**
Not currently. Monthly and annual are the two options.

**What if my company changes name or business structure?**
Contact hello@shieldmylot.com. We can update the billing entity but it requires verification (we don't want to accidentally transfer your account to someone unrelated to your business).

**Can I have multiple billing contacts?**
Your primary billing email is used for invoice receipts. Additional contacts CC'd on billing emails can be set up in your Stripe portal.

**Do declined resident vehicles cost anything (PM Starter)?**
No. Only approved permits count toward the meter. Pending and declined vehicles are free.

**Do driver invitations cost anything (Enforcement-Only)?**
No. Add as many drivers as your operation needs.

**How do plan changes affect existing data?**
Plan changes affect feature access and billing, never existing data. Properties, drivers, residents, violations, etc. all stay intact through plan changes.

---

## Next steps

- **Review your plan:** [Understanding Your Tier](03-understanding-your-tier.md)
- **Add a property (and see the billing impact):** [Adding Properties](04-adding-properties.md)
- **Get support:** [Support and Contact](15-support-and-contact.md)

Questions about billing? Email hello@shieldmylot.com.
