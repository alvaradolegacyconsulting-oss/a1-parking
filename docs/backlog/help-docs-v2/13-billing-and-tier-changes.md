---
title: "Billing and Plan Changes"
category: "Shared"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-10-22"
related: ["understanding-your-tier", "account-setup", "support-and-contact"]
---

# Billing and Plan Changes

This guide covers how ShieldMyLot™ billing works, what drives your bill, and how to make changes.

## The plans at a glance

| Plan | Monthly | Notes |
|---|---|---|
| **PM Starter** | $149 flat | One property. 500 approved permits a month included, then $1.25 each |
| **PM Pro** | $249 + $15 per property | Up to 50 properties. No permit meter |
| **Operator Starter** | $199 + $15 per property | Up to 50 properties |
| **Operator Pro** | $299 + $20 per property | Up to 50 properties |
| **Elite** | Custom | More than 50 properties, or non-standard terms. Set up by proposal |

On the per-property plans, you pay the per-property rate for your **first 20 properties**. **Properties 21 through 50 are included at no extra charge.**

See [Understanding Your Plan](03-understanding-your-tier.md) for what each plan includes.

---

## You only pay for what you use

- **The base fee** covers your plan.
- **Adding a property** on PM Pro, Operator Starter or Operator Pro adds the per-property rate, up to your 20th property. From the 21st on, adding a property doesn't change your bill.
- **PM Starter** is for one property. To run more, move to PM Pro.
- **Approving a resident vehicle (PM Starter only)** counts as one permit. The first 500 a month are included; each one beyond that is $1.25.
- **Adding drivers, property managers or leasing agents** doesn't affect your bill, and there's no cap.
- **Reserved parking (Spaces)** costs nothing extra on the plans that include it.

### How the permit meter works (PM Starter)

Pending and declined vehicles don't count. **Your billed permit count is the highest number active during the cycle**, and it adjusts to your current active count at your next renewal.

- You approve 400 permits in March and stay at 400 through April: April bills 400 permits, which is within the 500 allowance, so there's no overage.
- You reach 600 permits in March and drop back to 400 in April: March bills 100 extra permits ($125). April adjusts to your current active count at renewal.

Deactivating a permit mid-cycle doesn't reduce that month's charge.

---

## Adding properties mid-term

- **Monthly billing:** a property you add is prorated onto your next invoice.
- **Annual billing:** a property you add is invoiced **immediately**, prorated for the rest of your annual term.

Before a property is created, the portal shows what it will cost.

**Deactivating a property** lowers your bill **at your next renewal**, not mid-term. Until then, you keep paying for the property count you reached during the term.

<!-- REVIEW (Mateo): confirm this against the Stripe quantity ratchet before publishing. See REVIEW_NOTES.md #3. -->

---

## Monthly or annual

**Monthly**
- Pay each month for that month.
- No commitment beyond the current month.

**Annual**
- **Ten months' price for twelve months**, on every line of your bill.

| Plan | Annual base | Per property, per year (first 20) |
|---|---|---|
| PM Starter | $1,490 | n/a |
| PM Pro | $2,490 | $150 |
| Operator Starter | $1,990 | $150 |
| Operator Pro | $2,990 | $200 |

- Pricing is locked for the annual term.

---

## Refunds

There's no free trial. There is a **14-day money-back guarantee on your first payment**. Email **support@shieldmylot.com** within 14 days of your first charge.

---

## Billing platform

ShieldMyLot billing runs through Stripe.

- You enter your payment method at checkout (credit card or ACH).
- Invoices are generated automatically each billing cycle, and receipts are emailed to your billing contact.
- **Manage Billing** (Company Admin → Billing) opens the Stripe customer portal. There you can update your payment method, see invoice history, update your billing address, and cancel.

Elite customers may have other arrangements, such as invoicing, set out in their proposal. Your Billing tab reflects your actual setup.

### Texas sales tax

Texas sales tax applies to your subscription. Stripe calculates it and shows it as a separate line on each invoice.

---

## Elite pricing

Elite pricing is set in your proposal, and can include:

- a property limit above 50;
- different per-property rates;
- features from both tracks.

Your Plan tab and invoices reflect your agreed terms.

---

## Changing plans

### Starter to Pro, Pro to Starter, or changing tracks

Plan changes aren't self-serve in the portal. Email **support@shieldmylot.com** and we'll set it up with you.

### Moving to Elite

Email **support@shieldmylot.com**. Elite is set up by proposal; there's no self-serve path.

### When changes take effect

- **Upgrades** apply immediately, prorated.
- **Downgrades** apply at your next billing cycle, so nothing changes mid-cycle. Before you downgrade, deactivate anything that exceeds the new plan's limits (for example, properties beyond one when moving to PM Starter).

---

## Changes to pricing

If ShieldMyLot changes the price of your plan, you'll get at least **30 days' notice**.

- **Monthly:** the new price applies from your first billing cycle after the notice period.
- **Annual:** your price is locked for the term. The new price applies only at renewal.

---

## Cancellation

1. Open **Company Admin → Billing → Manage Billing** to reach the Stripe portal, and schedule cancellation for the end of your current billing period. Or email **support@shieldmylot.com**.
2. Your account stays active through the end of the period you've paid for.
3. After that date, your account is deactivated.

### Data after cancellation

- Your data is kept for **30 days** after cancellation, in case you want to reactivate. You can request a data export during that time.
- After 30 days, it's removed from active systems. Records needed for Texas Chapter 2308 retention are kept in archive.

---

## Failed payments

If a payment fails (an expired card, insufficient funds, and so on):

1. **Day 0:** Stripe attempts the charge, and you get an email.
2. **Days 3, 5 and 7:** Stripe retries, with an email reminder each time.
3. **Grace period:** your account stays active while retries are in progress.
4. **Suspension:** if every retry fails, your account is suspended. To reactivate, update your payment method in the Stripe portal and pay the outstanding balance.

Keep your payment method current in the Stripe portal to avoid this.

---

## Invoice questions

1. Check your Billing tab for your subscription status and next billing date.
2. Compare the invoice with your plan (or your Elite proposal).
3. If something doesn't match, email **support@shieldmylot.com** with the invoice number.

Common questions:

- **"Why is my invoice higher than last month?"** On the per-property plans, you most likely added a property (among your first 20). On PM Starter, you most likely went over 500 approved permits.
- **"I deactivated permits mid-cycle. Why didn't my bill drop?"** The billed permit count is the highest number active during the cycle. It adjusts at your next renewal.
- **"I added my 25th property and my bill didn't change."** That's expected. Properties 21 through 50 are included.

---

## Common questions

**Can I pay by ACH instead of card?**
Yes. Set it up in the Stripe customer portal from your Billing tab.

**Is quarterly billing available?**
No. Monthly and annual are the two options.

**My company changed name or structure. What do I do?**
Email **support@shieldmylot.com**. We'll verify the change before updating the billing entity.

**Can billing emails go to more than one person?**
Your primary billing email receives receipts. You can add more contacts in the Stripe portal.

**Do declined resident vehicles cost anything?**
No. Only approved permits count, and only on PM Starter.

**Do drivers cost anything?**
No. Add as many as your operation needs.

**Do plan changes affect my data?**
No. Plan changes affect features and billing only. Your properties, people, residents and violations stay intact.

---

## Next steps

- **Review your plan:** [Understanding Your Plan](03-understanding-your-tier.md)
- **Add a property:** [Adding Properties](04-adding-properties.md)
- **Get support:** [Support and Contact](15-support-and-contact.md)

Questions about billing? Email support@shieldmylot.com.
