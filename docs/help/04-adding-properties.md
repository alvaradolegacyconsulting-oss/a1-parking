---
title: "Adding Properties"
category: "Shared"
audience: ["company_admin", "manager"]
tier_required: "any"
last_updated: "2026-08-20"
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
- **State**
- **Zip code**

**Optional but recommended:**

- **Property owner/contact name** — Your point of contact at the property management company or property owner. The form labels this as "PM Name" / "PM Phone" / "PM Email."
- **Property owner phone and email**
- **Visitor capacity** — The number of visitor parking spots the property offers, if any. Used by the visitor pass system.
- **Towing authorization PDF** — Upload the signed authorization document (10MB max, PDF only). Stored privately and shown to managers via a signed link.
- **Towing authorization expiration date** — Track when you need to renew the authorization agreement.
- **Towing authorization notes** — Details about the authorization terms, renewal contacts, or scope-of-work language from the agreement. This field lives inside the Towing Authorization card and is intended for compliance information about the authorization itself, not for operational rules like tow-zone geometry. There is no general property-notes field today; operational rules belong with the property manager, not on the property record.

### Step 4: Save

Click **Save**. The property is added immediately and visible to all managers and drivers in your company.

---

## Configuring property settings

After the property exists, there are additional settings you should configure.

### Visitor Pass Quota Exemptions (managed in the manager portal)

Some regular visitors would otherwise exceed the rolling 30-day visitor-pass cap through normal use — caregivers, family members visiting weekly, service providers, contractors, delivery drivers with recurring routes.

To add a plate to the exemption list:
1. Sign in to the **manager portal** (this control is not in the Company Admin portal)
2. Open the property's **Settings** tab
3. Scroll to the **Visitor Pass Quota Exemptions** section
4. Add plates one at a time

Exempt plates bypass the visitor-pass rolling-30 cap for that property. They do **not** grant enforcement authorization — that comes from resident vehicles or approved visitor passes. Think of the exemption as "don't count this plate against the resident's visitor allowance," not "always allow this plate."

**Note for company admins:** if you don't see the Visitor Pass Quota Exemptions section in the Company Admin portal, that is correct. Adding a plate to the exemption list is a manager-portal action, scoped to a single property. If you're the CA and need an exemption added, ask the property's manager to add it, or sign in as a manager for that property.

### Visitor pass settings (managed in the manager portal)

Enforcement-track customers can skip this section — visitor passes are a PM-track feature.

The visitor-pass daily/monthly cap and the exemption list (above) are both set from the **manager portal's Settings tab**, one property at a time. The Company Admin portal does not have controls for these — the CA sees aggregate visitor-pass activity on the Property tab but does not adjust the per-property cap.

For PM customers, see [Visitor Passes](../property-management-track/09-visitor-passes.md).

### Towing authorization documentation

You can upload the signed towing authorization PDF directly on the property record (Add Property form or Edit Property, "Towing Authorization" card — Company Admin portal). Managers see a signed link to the PDF on their portal but cannot upload or replace it — that's a CA-only action.

Also record the **authorization expiration date** on the same card. Set yourself a calendar reminder 30-60 days before each authorization expires to renew with the property owner. Towing from a property after authorization has lapsed can result in penalties under Texas Chapter 2308.

If you prefer to keep the PDF in your own files (contract management system, shared drive) rather than upload it, the expiration date field on the property record is still worth setting so the platform can flag imminent renewals.

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
Only until the first manager or leasing agent is assigned to it. Once at least one non-admin user is assigned, the name is locked — attempting to save a rename will fail with a database error. This is intentional: the property name is referenced across historical audit rows, and mid-flight renames after user assignments cause cross-portal display drift.

**What if I need to rename after users are assigned?** Contact hello@shieldmylot.com. Renames are still possible with coordination, but the guardrail prevents them from happening accidentally during onboarding.

Otherwise (no users yet): click the property in the Manage tab, edit the name, save. Historical violations reflect the new name on display; the underlying database links are preserved.

---

## Next steps

- Add drivers to your company: [Provisioning Drivers](05-provisioning-drivers.md)
- Configure violation submission workflow: [Submitting Violations](06-submitting-violations.md)
- Set up exempt plates for property owner vehicles

Stuck on something not covered here? Email hello@shieldmylot.com.
