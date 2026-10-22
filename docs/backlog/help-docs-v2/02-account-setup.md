---
title: "Account Setup"
category: "Getting Started"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-10-22"
related: ["signup-and-first-login", "understanding-your-tier", "account-security"]
---

# Account Setup

Once you've logged in for the first time and changed your password, the next thing to do is configure your company profile. This guide walks through the settings you should complete in your first day on the platform.

This doc is for Company Admins (account owners). If you're a manager, driver, or resident, you don't need to do any of this — your company admin handles account setup.

## Why account setup matters

A few minutes of upfront configuration prevents confusion later. Your company name appears on tow tickets, violations, and resident-facing pages. Your support contact tells residents and visitors where to reach your team. Your logo makes the platform feel like yours instead of generic.

None of this is required to operate, but you'll save time and avoid customer questions by getting it right early.

---

## The setup checklist

In rough order of importance:

1. Complete your company profile
2. Upload your company logo
3. Set your support contact
4. Add additional admin users (if applicable)
5. Verify your plan and limits
6. Review your billing details

Each of these takes 1-3 minutes.

---

## Complete your company profile

In the Company Admin portal, find the **Settings** or **Manage** tab (depending on your view).

Fill in or verify these fields:

**Required:**
- **Company name** — Your legal business name (e.g., "A1 Wrecker LLC"). This appears on tow tickets and customer-facing pages.
- **Company short name** — A shorter version used in tight spaces (e.g., "A1 Wrecker"). Optional but helpful.
- **Business address** — Your operational headquarters, not just a mailbox.
- **Phone number** — Your main business line. Make this the number you want residents and visitors to call.

**Recommended:**
- **Business hours** — When your team is reachable. Used to set expectations on tow ticket pages.
- **Operating area** — Cities or regions you serve. Texas only at this time.

**Optional:**
- **Tax ID / EIN** — For billing and tax purposes. Not displayed publicly.
- **Insurance carrier and policy number** — Some property owners ask for this; useful to have on file.

Click **Save** after each section.

---

## Upload your own logo

Your logo (the one you supply — we don't design one for you) appears on:
- Tow tickets (printed and digital)
- The login page (subtly, beside the ShieldMyLot branding)
- Resident portal pages for your properties

**Upload specs:**
- Format: PNG or JPG (any image format is accepted, but PNG/JPG render most reliably)
- Maximum file size: 2 MB (hard limit; upload will be rejected above this)
- Recommended dimensions: 400×400 pixels minimum, square aspect ratio
- Transparent background recommended (PNG with alpha channel) — looks cleanest beside dark or light surrounds
- Avoid logos with very thin lines — they may not reproduce well on printed tow tickets

To upload:
1. Settings tab → Logo section
2. Click **Choose File** or drag and drop
3. Preview the result
4. Click **Save**

If your logo doesn't look right (cropped, blurry, wrong color), try a higher-resolution version. The platform doesn't auto-enhance.

---

## Set your support contact

ShieldMyLot uses a B2B support model:
- **Your customers** (residents, drivers, property managers at your client properties) contact **you** for support.
- **You** contact **ShieldMyLot** for platform-level issues.

Your support contact information tells your customers how to reach you when they have questions about a tow or visitor pass.

**Configure:**
- **Support email** — A monitored inbox (e.g., support@yourcompany.com or operations@yourcompany.com). Don't use a personal email.
- **Support phone** — The number for after-hours tow callouts and general operator-customer contact.

These contact details appear on tow tickets and the public visitor pass page.

---

## Add additional admin users

If you have business partners or operations leads who need full account access, add them as company admins.

**To add a company admin:**
1. Manage tab → Users section
2. Click **+ Add User**
3. Fill in: name, email, role = `company_admin`
4. Save

The new admin will receive their credentials directly from you (see [Signup and First Login](01-signup-and-first-login.md) for what they should expect — first login forces a password change).

**Important:** Company admins have full access to all properties, all drivers, all financial information, and all user management. Only add people you trust with that level of access. For more limited access:

- **Manager** — Manages one or more specific properties. Sees only those properties. Available on every plan.
- **Leasing agent** — Read-mostly access; assists managers. Your Plan tab shows whether your plan includes it.
- **Driver** — Field enforcement. Submits violations, scans plates, generates tow tickets. Available on Operator Starter and Operator Pro. Drivers can act only at the active properties they're assigned to.

See [Provisioning Drivers](05-provisioning-drivers.md) for the driver-specific workflow.

---

## Verify your plan and limits

Click the **Plan** tab to confirm your plan is set correctly.

What to verify:
- **Plan name** matches what you signed up for: **PM Starter**, **PM Pro**, **Operator Starter**, **Operator Pro**, or your Elite terms
- **The right tools show.** Operator plans show violations and tow tickets. PM plans and Operator Pro show residents, visitor passes, Spaces and guest authorizations.
- **Active property count** and your **property limit** are what you expect
- **Features** shown on the Plan tab match your plan

If something looks wrong, email support@shieldmylot.com right away. Plan errors are easier to fix at setup than later.

See [Understanding Your Plan](03-understanding-your-tier.md) for what each plan includes.

---

## Review your billing details

Billing runs through Stripe. Open **Company Admin → Billing → Manage Billing** to reach the Stripe customer portal, where you can:

- update your payment method (card or ACH);
- update your billing address;
- add contacts who should receive invoice receipts, such as your bookkeeper;
- see your invoice history.

You chose monthly or annual billing at signup. Annual is ten months' price for twelve.

See [Billing and Plan Changes](13-billing-and-tier-changes.md) for billing details.

---

## What you don't need to set up yet

A few things to skip during initial setup — they have their own workflows in other guides:

- **Properties** — Adding your first property is a substantial task that needs its own attention. See [Adding Properties](04-adding-properties.md).
- **Drivers** (Operator plans) — Add drivers after properties exist, so you can assign them. See [Provisioning Drivers](05-provisioning-drivers.md).
- **Resident QR codes** — For PM plans and Operator Pro. See [Resident Self-Registration](11-resident-self-registration.md).
- **Violation types** — The platform has standard violation types out of the box. You can customize them later if needed.

---

## Setup completion check

Before moving on, verify:

- ☐ Company name and address show correctly in your portal
- ☐ Logo uploads and displays on a test page (try logging out and back in to see the login page)
- ☐ Support contact details are filled in
- ☐ Additional admins (if any) have logged in successfully
- ☐ Plan tab shows the correct plan
- ☐ Billing details are set in the Stripe portal

If all six are checked, you're ready to start adding properties and drivers.

---

## Next steps

- **Operator customers:** [Adding Properties](04-adding-properties.md)
- **Property management customers:** [Property Management Overview](08-property-management-overview.md)
- **Understand your plan in depth:** [Understanding Your Plan](03-understanding-your-tier.md)

Questions about account setup not covered here? Email support@shieldmylot.com.

