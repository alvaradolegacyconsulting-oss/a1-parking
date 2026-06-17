---
title: "Resident Management"
category: "Property Management Track"
audience: ["manager", "leasing_agent", "company_admin"]
tier_required: "any"
last_updated: "2026-05-20"
related: ["resident-self-registration", "visitor-passes", "property-management-overview"]
---

# Resident Management

This guide is for property managers (and leasing agents) handling the resident lifecycle in ShieldMyLot™ — from approving new registrations through lease-end deactivation.

If you're a resident looking to register, see [Resident Self-Registration](../shared/11-resident-self-registration.md).

## The resident lifecycle

A resident's journey in ShieldMyLot typically looks like this:

1. **Registration** — Resident self-registers (or you add them manually)
2. **Approval** — You approve their registration
3. **Active use** — They register vehicles, issue visitor passes, and update their info as it changes
4. **Updates** — They request additional vehicles or update info; you approve as needed
5. **Lease end** — When they move out, you deactivate the account

Each step has its own workflow in the manager portal.

---

## Approving registrations

When residents self-register through your property's QR code, they appear in your **Residents** tab with **Pending** status.

### What to check before approving

Before clicking Approve, verify:

- **Unit number matches a real unit** at your property. If they put "Unit 999" but you only have 1-50, something's wrong.
- **The person's name matches your lease records.** Catches fraud or typos.
- **Email looks legitimate.** Personal emails are fine; suspicious patterns (e.g., random-looking strings) might warrant a follow-up.
- **Vehicles look reasonable.** Personal vehicles (cars, trucks, SUVs) are normal. Commercial fleet vehicles (multiple trucks all registered to one person) might warrant a conversation.
- **No duplicate accounts.** If the email is already registered, you may have a duplicate registration.

### Approve, decline, or request more info

You have three options:

**Approve**
The resident's status changes immediately. They can log in with the credentials they set during registration. No email is sent by the system — you may want to send a personal email confirming approval, but it's optional.

**Decline**
The resident's status changes to declined. They see the status in their portal if they log in. Best practice: also reach out personally with the reason. "Your registration was declined because the unit number doesn't match our records — could you double-check and re-submit?" is more useful than a silent decline.

**Request more info** (manual workflow)
If something's unclear, contact the resident directly (email, phone) before approving or declining. The resident's registration stays in Pending until you decide.

### Approval volume

Most properties approve registrations within 1-2 business days. Best practices:

- Set a recurring time to review pending registrations (e.g., Monday and Thursday mornings)
- Process in batches rather than reacting to each one as it comes in
- Aim for under 2 business days from submission to decision

If approvals consistently take longer, you may need to give a leasing agent backup authority, or train a colleague to share the workload.

---

## Adding a resident manually

If a resident can't self-register (no smartphone, walk-in registration, accessibility needs), you can add them directly:

### Step 1: Manager portal → Residents tab → "+ Add Resident"

### Step 2: Fill in the resident's information

- Full name
- Email address (becomes their login)
- Phone number
- Unit number
- Vehicle information (up to 2 vehicles at initial add)

### Step 3: Save

The system creates the account and generates a temporary password. **The temporary password is shown once on the success screen — copy it before closing.**

### Step 4: Communicate the temp password to the resident

ShieldMyLot doesn't send any emails to residents. You're responsible for getting them their temporary password. Practical approaches:

- **Email from your business address** — Compose an email with the login URL, email, and temporary password. Send to the resident.
- **In-person hand-off** — If they're at the leasing office, walk them through first login on their phone right there.
- **Phone or SMS** — Call or text the temporary password. Don't text the password and login URL in the same message — split them.

**Important:** if you lose the temporary password before sharing with the resident, you'll need to reset it from their account record.

### Step 5: First login

The resident logs in with the temporary password and is forced to change it on first login. After that, they use their own password going forward.

---

## When to use manual add vs self-registration

**Use self-registration (preferred default):**
- Resident has a smartphone
- Resident speaks English (the form is in English; future versions may localize)
- Resident is comfortable filling out forms
- Resident has reliable email access

**Use manual add (special cases):**
- Resident doesn't have a smartphone
- Resident is moving in same-day and needs immediate access
- Walk-in registration without time to scan a QR code
- Accessibility needs prevent self-service
- Bulk move-ins where you want to pre-populate the system

For most properties, 80-90% of residents will self-register. The manual add path handles the remaining 10-20%.

---

## Approving vehicle additions

Residents are capped at 2 vehicles during initial registration. To add more, they submit a request from their portal. These requests appear in your portal for approval.

### Reviewing a vehicle request

In the Residents tab, click on a resident with pending vehicle requests. You'll see:
- The new vehicle details (plate, state, color, make, model)
- The resident's current vehicles
- The total vehicle count if approved

### What to check

- Is the plate already registered to a different resident at your property? (Duplicate plate is suspicious)
- Does the vehicle description match what you'd expect for this resident?
- Is this their N-th vehicle where N feels excessive? (One resident with 6 vehicles deserves a conversation)
- Do they have a roommate situation where the vehicle might really belong to someone who should register separately?

### Approve or decline

Click Approve or Decline. As with initial registration, no email is sent — the resident sees the status change in their portal.

---

## Updating resident information

Residents can edit some details themselves:
- Color of a vehicle
- Year of a vehicle

Residents cannot edit (manager must):
- License plate (re-verification needed)
- Unit number (typically only changes if they move within the property)
- Email (becomes a different login; equivalent to creating a new account)

### Manager-editable fields

In the resident's record, you can update:
- Name (for legal name changes, corrections)
- Unit number (when they move units)
- Phone number
- License plate of a vehicle (with appropriate verification)
- Vehicle make/model (rarely needed; usually a typo correction)

All changes are logged in the audit trail.

### Common scenarios

**Resident traded in their car for a new one:**
Either replace the old vehicle (update plate, make, model) or deactivate the old and have the resident add the new through the request flow.

**Resident swapped units within the property:**
Update their unit number in their record. Vehicles and visitor pass history stay linked.

**Resident's spouse needs their own account:**
Each adult who issues their own visitor passes or needs portal access should have their own account. Add the spouse as a separate resident, link them to the same unit. They have separate login credentials but share the unit.

---

## Lease end and deactivation

When a resident moves out:

### Step 1: Verify the move-out

Coordinate with your leasing office to confirm the lease has actually ended and the resident has moved out. Don't deactivate based on rumor or assumption.

### Step 2: Residents tab → find the resident → Deactivate

Click Deactivate. The action takes effect immediately.

### What happens after deactivation

- The resident can no longer log in
- The resident can no longer issue visitor passes
- Their registered vehicles are flagged as deactivated (drivers see this status during enforcement decisions)
- Their historical visitor passes and violations remain visible for audit
- Audit trails stay intact
- The resident slot is freed if you have a tier-based resident cap (not currently enforced, but reserved for future)

### Reactivating a former resident

If a former resident returns to the property:

1. Residents tab → find their record
2. Click Reactivate
3. Confirm their information is current (unit, vehicles, contact info)
4. They can log in with their old credentials (or you can reset password if they've forgotten)

Their previous history (vehicles, passes, violations) stays linked. No need to recreate the account.

---

## Bulk operations

For properties with high resident turnover (e.g., student housing at semester transitions), you might want bulk operations:

### Bulk approval

Not currently available — approvals are one-at-a-time. If you have many pending registrations to approve, plan time accordingly.

### Bulk deactivation

Not currently available — deactivations are one-at-a-time. For end-of-semester moves, deactivate each former resident as they actually move out.

### Bulk import

For new properties onboarding many existing residents at once, contact support@shieldmylot.com. We can help with a one-time bulk import to get you set up faster.

---

## Privacy and resident data

Resident data is sensitive. Treat it with appropriate care:

### What you can do

- Look up residents and their vehicles in the course of property management
- Approve/decline registrations and vehicle requests
- Update resident records as needed

### What you shouldn't do

- Share resident information with people who don't have a legitimate business need
- Use the resident roster for marketing or non-parking communication
- Look up resident records for personal reasons (looking up a specific resident out of curiosity is an audit-trail event)

Your access is audited. If a resident later questions whether someone improperly accessed their data, the audit trail will show every lookup, edit, and view. Use that knowledge appropriately.

For more detail, see [Account Security](../shared/14-account-security.md).

---

## Common questions

**A resident registered but their unit number is wrong. Can I fix it in my portal?**
Yes. Click on their record, edit the unit number, save. The change is logged in the audit trail.

**Two residents in the same unit both want their own accounts. Is that supported?**
Yes. Each resident has their own account, both linked to the same unit. They share the unit but have separate login credentials and separate visitor pass quotas.

**A former resident wants their data deleted. What do I do?**
Texas doesn't currently have a comprehensive privacy law requiring deletion on request, but treating reasonable requests reasonably is good business. Contact support@shieldmylot.com to discuss the right path. We can help with data export and (in appropriate cases) deletion while preserving audit-trail integrity.

**A resident's plate matches multiple violations. Can I see all their history?**
Yes. From the resident's record, you can see all violations linked to their plates. Useful for context when a resident contacts you with questions.

**Can I assign a resident to multiple units?**
Each resident is linked to one unit at a time. If they actually live across two units (rare but possible), use the larger or primary unit as their registration.

**What if a vehicle is on a resident's account but they no longer own it?**
Edit the resident's record and remove the vehicle. If you're not sure (the resident hasn't confirmed sale), leave it but make a note. Don't auto-remove based on assumptions.

---

## Best practices

- **Approve registrations within 2 business days** — Slow approval frustrates new residents during a stressful move-in
- **Communicate decline reasons clearly** — Silent declines confuse residents and create friction
- **Audit your resident roster quarterly** — Confirm active residents are still residents; catch ghost accounts early
- **Update unit assignments promptly** when residents move within the property
- **Train leasing agents on the resident workflow** — Avoids bottlenecks when you're not available
- **Document special cases in resident notes** — Future-you reading the audit trail will appreciate context

---

## Next steps

- **Manage visitor passes:** [Visitor Passes](09-visitor-passes.md)
- **Understand resident self-service:** [Resident Self-Registration](../shared/11-resident-self-registration.md)

Questions about resident management? Email support@shieldmylot.com.
