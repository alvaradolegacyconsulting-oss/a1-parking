---
title: "Provisioning Drivers"
category: "Enforcement Track"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-05-19"
related: ["adding-properties", "submitting-violations", "understanding-your-tier"]
---

# Provisioning Drivers

Drivers are the field enforcement users who scan plates, observe parking violations, capture photo and video evidence, and submit violations through ShieldMyLot™. Before any violations can be submitted, you need at least one driver account on your team.

This guide walks Company Admins through adding driver accounts, communicating credentials, and managing the driver roster over time.

## Who should have a driver account

A driver account is for anyone on your team who will be in the field submitting violations. Common examples:

- Tow truck operators who scout properties for violations
- Patrol drivers on contracts that include observation
- Supervisors who occasionally submit violations themselves
- Anyone authorized to make on-the-ground enforcement decisions

**Not for:**
- Office staff who don't submit violations (use a manager or admin role instead)
- Property owners (your customers, not your employees)
- Third-party contractors unless they're working under your direct supervision

If someone needs limited platform access but isn't a field driver, consider the manager or leasing agent roles. See [Account Setup](../getting-started/02-account-setup.md) for role definitions.

---

## Driver tier limits

Your tier determines how many active driver accounts you can have:

| Enforcement Tier | Driver Limit |
|---|---|
| Starter | 3 |
| Growth | 10 |
| Legacy | Unlimited |

Drivers who leave your company should be deactivated, not deleted, to preserve audit trails. Deactivated drivers don't count against your limit.

If you have a custom pricing arrangement with ShieldMyLot, your effective limit may differ from the standard tier defaults. Check the **Plan** tab.

---

## How to add a driver

### Step 1: Navigate to Manage

In the Company Admin portal, click the **Manage** tab. Find the Drivers section.

[Screenshot: Manage tab with Drivers section highlighted, showing current driver count]

### Step 2: Click "+ Add Driver"

If you're under your tier's driver limit, the gold "+ Add Driver" button is active. Click it.

If you're at your tier's limit, you'll see an upgrade prompt. You can either deactivate an existing driver to free a slot or upgrade your tier (see [Understanding Your Tier](../getting-started/03-understanding-your-tier.md)).

### Step 3: Fill in driver information

**Required:**
- **Full name** — The driver's real name, as it should appear in audit logs.
- **Email** — Driver's email address; this becomes their login. Use their work email if they have one, or their personal email if not.
- **Phone number** — For operational contact and emergencies.

**Optional but recommended:**
- **Employee ID or driver number** — Your internal identifier, helpful for cross-referencing with your fleet records.
- **CDL number** — If they hold a Commercial Driver's License (required for most tow operations).
- **Hire date** — Tracking field; useful for tenure reporting.

### Step 4: Save and capture the temporary password

When you click **Save**, the platform creates the driver account and generates a temporary password. **The temporary password is displayed once on the success screen.**

[Screenshot: Driver creation success screen showing temporary password with copy button]

**Important: copy the temporary password before closing this screen.** You'll need to give it to the driver. If you close the screen without copying it, you'll need to reset their password from their account record.

---

## Communicating credentials to the driver

ShieldMyLot does not send any emails to your drivers. You are responsible for getting their credentials to them. There are a few practical approaches:

### Approach 1: In-person hand-off (recommended)

Best for drivers who report to your office:
1. Have the driver come to your office with their phone
2. Help them log in for the first time at https://www.shieldmylot.com/login
3. They'll be forced to change their password immediately
4. Walk them through the driver portal layout while they're there

This eliminates the password-in-email security risk and gives you a chance to train them.

### Approach 2: Email from your own account

If in-person isn't practical:
1. Compose an email from your business address to the driver's email
2. Include: their login email (which they already know — it's their email), the temporary password, and the login URL
3. Tell them they'll be required to change the password on first login
4. Ask them to log in within 24 hours to confirm receipt

**Don't send the password and login URL in the same SMS or messaging app.** Use email for the password specifically — it's more secure than SMS for credential transmission.

### Approach 3: SMS or phone call

If the driver doesn't have a reliable email, you can give them the password by phone or SMS. Walk them through the first login while you're on the call.

---

## What drivers can and can't do

Once logged in, a driver can:

- **Look up license plates** to check exempt status, registered residents, and visitor passes
- **Submit violations** with photo and video evidence (see [Submitting Violations](06-submitting-violations.md))
- **Generate tow tickets** after confirming a violation
- **View their own violation history** for reference
- **Manage their own media** in violations they submitted (photo/video soft-delete with audit trail; see [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md))

Drivers cannot:
- Add or edit properties
- Add or edit residents
- See violations submitted by other drivers (only their own)
- Modify confirmed violations (only managers and admins can do that)
- Issue visitor passes (managers and residents do that)
- Access billing, plan, or company configuration

This scope limitation is intentional — drivers should be focused on field enforcement, not platform administration.

---

## Driver mobile usage

The driver portal is fully web-based and works on any modern smartphone. Drivers don't need to install an app — they just open https://www.shieldmylot.com/login in their phone browser.

**Recommendations to share with drivers:**

- **Bookmark the login page** on their phone's home screen for one-tap access
- **Use landscape orientation for video capture** — better evidence quality
- **Make sure their phone has good camera quality** — at least a recent mid-range phone; bad cameras produce bad evidence
- **Test camera and microphone permissions** before going into the field
- **Have a charger in the truck** — submitting violations is battery-intensive

Drivers should be familiar with [Submitting Violations](06-submitting-violations.md) before their first field shift.

---

## Deactivating a driver

When a driver leaves your company:

1. Manage tab → Drivers section
2. Find the driver
3. Click **Deactivate**

Deactivated drivers:
- Can no longer log in
- Don't count against your tier limit
- Their historical violations remain visible (Chapter 2308 record retention)
- Audit trails remain intact

You can reactivate a deactivated driver if they return. Their previous violation history stays linked to them.

**Why deactivate instead of delete:** Texas Chapter 2308 requires record retention. The driver's name appears on tow tickets and violation records. Deleting the account would either orphan those records (bad for audit) or remove the driver's name from historical records (bad for accountability).

---

## Resetting a driver's password

If a driver forgets their password, they can reset it themselves using the "Forgot Password" link on the login page (they'll need access to the email they registered with).

If they can't reset it themselves (lost email access, etc.), you can reset it from their account record:

1. Manage tab → Drivers
2. Click on the driver
3. Click **Reset Password**
4. The platform generates a new temporary password
5. Copy and communicate it to the driver
6. They'll be forced to change it on next login

---

## Audit trails for driver actions

Every action a driver takes is logged in the platform's audit trail:

- Plate lookups (which plate, when, from where)
- Violation submissions (draft creation, photo uploads, confirmation)
- Violation edits during the review stage
- Tow ticket generation
- Post-confirmation media changes

This trail is visible to Company Admins and is important for:
- Defending disputes (proof of what evidence was captured and when)
- Performance management (which drivers submit clean evidence consistently)
- Compliance documentation (Chapter 2308 record retention)
- Investigation if a driver's actions are ever questioned

You don't need to do anything to enable audit logging — it's automatic.

---

## Common questions

**Can a driver have multiple emails / accounts?**
No. Each driver should have one account. Multiple accounts for the same person breaks audit trails and creates confusion.

**Can two companies share a driver?**
A driver account is scoped to one company. If a driver works for two different towing companies, they need separate accounts at each. Each company's account is isolated by the platform's data security boundaries.

**My driver hit a photo or video cap. How do I increase it?**
Photo and video caps are tier-based. Upgrade your tier to raise the caps. See [Understanding Your Tier](../getting-started/03-understanding-your-tier.md) for details.

**A driver claims they submitted a violation but I don't see it. What's wrong?**
The violation may be in a "draft" state — submitted but not yet confirmed. See [Submitting Violations](06-submitting-violations.md) for the two-step submission process and how to resume drafts.

**Can I limit a driver to specific properties?**
Currently, driver scope is company-wide — drivers can submit violations at any property your company has access to. Per-property driver assignment is on the roadmap but not yet available. If you need property-restricted access, the manager role provides that scoping for a different use case.

---

## Next steps

- **Add your first driver, then have them practice on a test:** [Submitting Violations](06-submitting-violations.md)
- **Understand evidence retention and post-confirmation workflow:** [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md)
- **Need to upgrade to add more drivers:** [Understanding Your Tier](../getting-started/03-understanding-your-tier.md)

Questions about driver management? Email support@shieldmylot.com.
