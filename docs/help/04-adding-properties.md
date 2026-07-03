---
title: "Adding Properties"
category: "Shared"
audience: ["company_admin", "manager"]
tier_required: "any"
last_updated: "2026-07-02"
related: ["provisioning-drivers", "submitting-violations", "understanding-your-tier", "billing-and-tier-changes"]
---

# Adding Properties

A property in ShieldMyLot™ is a parking lot or facility where your towing company has enforcement authority. Before you can submit a single violation, you need at least one property in your account.

This guide covers the full process — from confirming you have proper authorization to configuring property-specific settings.

## Before you add a property

You must have **signed towing authorization** from the property owner or property management company before adding the property to ShieldMyLot. This is a Texas Chapter 2308 requirement, not just a ShieldMyLot rule.

**What signed authorization typically includes:**
- The property owner's identity (LLC or individual)
- The specific property address
- Authorization for your company to tow unauthorized vehicles
- Signage requirements you'll fulfill
- Term length (usually annual, renewable)

**What ShieldMyLot doesn't do:** We don't manage your towing authorization documents directly. Those live with you and your customer (the property owner). What we do is help you track which properties you have authorization for and make sure your enforcement workflow stays compliant.

If you don't have signed authorization yet, don't add the property. Towing a vehicle from a property without proper authorization can result in significant penalties under Texas Chapter 2308.

---

## How to add a property

### Step 1: Navigate to Manage

In the Company Admin portal, click the **Manage** tab.

### Step 2: Click "+ Add Property"

Click the "+ Add Property" button in the Manage tab.

### A note on billing

Adding a property changes your bill. Per-property rate depends on your tier:

- **PM-Only** — $20/month per property (added to your base of $179/month)
- **Enforcement-Only** — $15/month per property (added to your base of $199/month)
- **Legacy** — the custom per-property rate set at proposal-code issue time; reflected on your invoices

Before the property is created, the portal shows a confirmation with the per-property cost so you can double-check. You do not need approval from anyone else to add a property — you're the subscriber and the change applies to your next invoice automatically.

See [Billing and Tier Changes](13-billing-and-tier-changes.md) for the full pricing model.

### Step 3: Fill in the property form

**Required fields:**

- **Property name** — The display name your team will recognize. Examples: "Bayou Heights Apartments", "Westchase Plaza", "Memorial Park Lofts". This name appears throughout the platform on violations, visitor passes, and tow tickets.
- **Property address** — Full street address.
- **City** — Texas only; the platform is licensed for Texas operation under Chapter 2308.
- **Zip code**
- **Property type** — Apartment complex, retail center, office building, etc. This is informational but helps you organize larger property portfolios.

**Optional but recommended:**

- **Property owner/contact name** — Your point of contact at the property management company or property owner.
- **Property owner phone and email** — For escalations and account issues.
- **Towing authorization expiration date** — Track when you need to renew the authorization agreement.
- **Notes** — Any property-specific information your team should know (e.g., "Tow zone is rear lot only; do not tow from front lot").

### Step 4: Save

Click **Save**. The property is added immediately and visible to all managers and drivers in your company.

---

## Configuring property settings

After the property exists, there are additional settings you should configure.

### Exempt plates

Some vehicles should never be towed from a property, even if they appear to violate rules. Common examples:

- The property owner's personal vehicles
- Maintenance contractor vehicles with regular access
- Delivery service vehicles (UPS, FedEx, USPS)
- Vehicles with permanent permits agreed to by the owner

To add exempt plates:
1. Navigate to the property's settings page (click the property name in the Manage tab)
2. Find the **Exempt Plates** section
3. Add plates one at a time

Exempt plates bypass both violation submission warnings AND visitor pass limits. Use this list carefully.

### Visitor pass settings (Property Management track only)

Enforcement track customers can skip this section — visitor passes are a PM-track feature.

For PM customers, see [Visitor Passes](../property-management-track/09-visitor-passes.md).

### Towing authorization documentation

You're responsible for maintaining your signed towing authorization documents from each property owner. Keep these in your own files (PDF, contract management system, or wherever you maintain customer agreements) and use the property notes field in ShieldMyLot to record the authorization expiration date.

Set yourself a calendar reminder 30-60 days before each authorization expires to renew with the property owner. Towing from a property after authorization has lapsed can result in penalties under Texas Chapter 2308.

### Assigning managers

Once a property exists, you can assign property managers to it. Managers can only see and act on properties they're explicitly assigned to — they cannot see other properties even within your company.

To assign a manager:
1. Go to the Manage tab
2. Click on the manager's user record
3. Select properties from the list
4. Save

A manager can be assigned to multiple properties. See [Provisioning Drivers](05-provisioning-drivers.md) for the parallel driver assignment process (drivers are scoped by company, not by property — different from managers).

---

## Property caps

**PM-Only** and **Enforcement-Only** do not cap the number of properties. Add as many as your operation needs — the per-property monthly rate applies to each (see [Billing and Tier Changes](13-billing-and-tier-changes.md)).

**Legacy** accounts may have property caps as part of their proposal-code configuration. Your Plan tab reflects any cap that applies to your account.

---

## Deactivating a property

If you lose authorization at a property, or the property changes ownership and the new owner uses a different towing service, deactivate the property in ShieldMyLot rather than deleting it.

**Why deactivate instead of delete:**
- Historical violations remain visible for record retention (Chapter 2308 requires record retention)
- Audit trails stay intact
- Reactivation is easy if circumstances change

To deactivate:
1. Manage tab → click the property
2. Find the **Deactivate Property** option
3. Confirm

After deactivation:
- The property no longer counts against your tier limit
- New violations cannot be submitted at that property
- Existing violations remain accessible
- Managers assigned only to that property lose access; managers assigned to multiple properties retain access to the others

---

## Common questions

**Can I add a property outside Texas?**
No. ShieldMyLot is licensed for Texas operation only. The legal framework (Chapter 2308) is Texas-specific. If you operate in multiple states, you'll need separate compliance solutions for each.

**Can two companies use the same property?**
Each property in ShieldMyLot is tied to one company. If two different towing companies are authorized at the same physical property (rare but possible), each would maintain their own property record in their own ShieldMyLot account. We don't currently support multi-tenant properties.

**What happens to existing violations if I deactivate a property?**
They remain visible to everyone who could see them before deactivation (managers, company admins, residents whose plates match, super admin). Soft-deleted violations and their evidence remain intact for legal record retention.

**Can a property name be changed after creation?**
Yes. Click the property in the Manage tab, edit the name, save. Be aware that historical violations will reflect the new name on display — the underlying database links are preserved, but display labels update.

---

## Next steps

- Add drivers to your company: [Provisioning Drivers](05-provisioning-drivers.md)
- Configure violation submission workflow: [Submitting Violations](06-submitting-violations.md)
- Set up exempt plates for property owner vehicles

Stuck on something not covered here? Email support@shieldmylot.com.
