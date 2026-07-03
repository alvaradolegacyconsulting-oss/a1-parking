---
title: "Billing and Tier Changes"
category: "Shared"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-07-02"
related: ["understanding-your-tier", "account-setup", "support-and-contact"]
---

# Billing and Tier Changes

This guide covers how ShieldMyLot™ billing works, what drives your bill, and how to make changes.

## The three tiers, at a glance

- **PM-Only** — Property management firms. $179/mo base + $20/mo per property + graduated per-approved-permit meter. Self-serve signup.
- **Enforcement-Only** — Towing/enforcement operators. $199/mo base + $15/mo per property. No per-permit meter. No per-driver charge. Self-serve signup.
- **Legacy** — Custom-negotiated pricing set at proposal-code issue time. Numbers vary by contract; not published publicly. Onboarded via a proposal code from ShieldMyLot.

See [Understanding Your Tier](03-understanding-your-tier.md) for what each tier includes.

---

## You only pay for what you use

ShieldMyLot's pricing model:

- **Adding a property** raises your bill by the per-property rate for your tier, immediately on your next invoice.
- **Approving a resident vehicle (PM-Only only)** counts as one permit. Rate depends on your current bracket:

  | Approved permits | Rate per permit |
  |---|---|
  | 1 – 50 | $2.00 |
  | 51 – 200 | $1.75 |
  | 201 – 500 | $1.50 |
  | 501 + | $1.25 |

  Pending vehicles and declined vehicles do not count toward the meter.
- **Adding drivers, property managers, or leasing agents** does not affect your bill. There is no cap on any of these.
- **Reserved parking (Spaces)** on PM-Only is included at no additional cost.

If you never approve a permit and never add a property beyond your first, your bill stays at the monthly base.

---

## Annual vs monthly billing

ShieldMyLot offers both monthly and annual billing.

**Monthly:**
- Pay each month for that month.
- More flexible — you can change tiers month-to-month if your needs shift.
- No commitment beyond the current month.

**Annual:**
- Pay 12 months upfront and save (typical ~17% discount vs monthly — "pay 10, get 12" framing).
- Locks you in for the annual term.
- You can upgrade to Legacy mid-year (prorated). Standard tier switches happen at renewal.

For pricing specifics on either option, see your service agreement or [Understanding Your Tier](03-understanding-your-tier.md).

---

## Billing platform

ShieldMyLot billing runs through Stripe. When you complete signup:

- You enter your payment method during checkout (credit card or ACH).
- Invoices are generated automatically per your billing cycle (monthly or annual).
- You'll receive invoice receipts by email at your billing contact address.
- **Manage Billing** (Company Admin → Billing tab) opens the Stripe customer portal where you can update your payment method, view invoice history, update billing address, and cancel.

Legacy customers may have alternate arrangements (e.g., ACH via invoice) documented in the negotiated proposal. Your Billing tab reflects your actual setup.

### Texas sales tax

Texas SaaS sales tax applies to your subscription — Stripe Tax handles the jurisdiction lookup and shows the tax line item separately on each invoice.

---

## Custom-negotiated (Legacy) pricing

Legacy accounts have pricing arrangements set at proposal-code issue time. Depending on how your Legacy account was configured:

- Different per-property rates
- Different per-permit rates or brackets
- Different or no per-permit meter
- Any combination of PM-Only and Enforcement-Only features

Your Plan tab reflects your actual configuration. Your invoices reflect your negotiated rates.

If you're not sure whether you have a Legacy arrangement, check your Plan tab: it will show "Legacy" as your tier.

---

## Changing tiers

Most customers pick a tier at signup and stay there. When you need to change:

### Between the two self-serve tiers (PM-Only ↔ Enforcement-Only)

These are separate products with different feature sets. Switching between them is not a "tier upgrade" — it's effectively changing what your account is for. Contact support@shieldmylot.com and we'll discuss whether:

- A tier switch on your existing account makes sense, or
- A Legacy configuration (both tracks combined) fits better

### To or from Legacy

Contact support@shieldmylot.com. Legacy configurations are negotiated per-account; there's no self-serve path.

### Effective dates

- **Legacy upgrades** on monthly billing generally apply immediately (prorated).
- **Legacy upgrades** on annual billing apply immediately with proration on the annual amount.
- **Downgrades** apply at your next billing cycle (protects you from mid-cycle disruption). Deactivate any resources that exceed the target tier's limits before requesting the downgrade.

---

## Changes to pricing

If ShieldMyLot changes pricing for your tier (rare, but possible), you'll receive at least **30 days' notice** before the new pricing takes effect. Larger price increases may get 60 days' notice.

- **Monthly** customers: new pricing applies at your next billing cycle after the notice period.
- **Annual** customers: pricing is locked for the duration of the annual term. New pricing applies only at renewal.

---

## Cancellation

If you decide to cancel:

1. Open **Company Admin → Billing** → **Manage Billing** to reach the Stripe portal. From there you can schedule cancellation at end of your current billing period.
2. Or email support@shieldmylot.com if you'd prefer a support-assisted cancellation.
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
2. Compare the invoice to your service agreement (Legacy accounts especially).
3. If there's a discrepancy, email support@shieldmylot.com with the invoice number and your concern.

Common questions:

- **"Why is my invoice higher than last month?"** — Most commonly: you added a property (per-property line increased) or approved more resident vehicles (permit meter advanced on PM-Only). Both show on the Billing tab under current-cycle usage.
- **"I see a charge I don't recognize."** — Check the invoice line items. Each corresponds to base, per-property, or (PM-Only) per-permit metering.

---

## Common questions

**Can I pay by ACH instead of credit card?**
Yes, via the Stripe customer portal on your Billing tab. Both credit card and ACH are supported.

**Can I get a quarterly billing option?**
Not currently. Monthly and annual are the two options.

**What if my company changes name or business structure?**
Contact support@shieldmylot.com. We can update the billing entity but it requires verification (we don't want to accidentally transfer your account to someone unrelated to your business).

**Can I have multiple billing contacts?**
Your primary billing email is used for invoice receipts. Additional contacts CC'd on billing emails can be set up in your Stripe portal.

**Do declined resident vehicles cost anything (PM-Only)?**
No. Only approved permits count. Pending and declined vehicles are free.

**Do driver invitations cost anything (Enforcement-Only)?**
No. Add as many drivers as your operation needs.

**How do tier changes affect existing data?**
Tier changes affect feature access and billing, never existing data. Properties, drivers, residents, violations, etc. all stay intact through tier changes.

---

## Next steps

- **Review your tier:** [Understanding Your Tier](03-understanding-your-tier.md)
- **Add a property (and see the billing impact):** [Adding Properties](04-adding-properties.md)
- **Get support:** [Support and Contact](15-support-and-contact.md)

Questions about billing? Email support@shieldmylot.com.
