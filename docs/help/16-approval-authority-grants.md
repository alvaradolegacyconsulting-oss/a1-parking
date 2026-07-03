---
title: "Approval-Authority Grants"
category: "Shared"
audience: ["company_admin"]
tier_required: "any"
last_updated: "2026-07-02"
related: ["account-setup", "resident-management", "tow-tickets-and-evidence", "property-management-overview"]
---

# Approval-Authority Grants

Some field-and-onboarding actions on ShieldMyLot™ are gated by an **authority grant** from the company admin. Without the grant, the user (a property manager, or a driver) can do most of their job — but a specific high-consequence action stays disabled until you turn it on.

This is intentional. Approving a resident vehicle or voiding a tow ticket are decisions that carry consequences (billing changes, legal exposure, resident trust). The default posture is "user can't do this until the account owner explicitly says they can." You (the company admin) are the account owner.

There are two authority grants today:

- **Manager approval authority** — lets a property manager approve resident vehicles
- **Driver regenerate/void authority** — lets a driver void and regenerate their own tow tickets in the field

Both live in the **Users** tab of your Company Admin portal.

---

## Grant 1 — Manager approval authority

### What it does

When granted, a property manager can:

- Approve pending resident vehicles at their property
- Approve pending resident registrations (which typically includes approving any vehicles the resident registered at signup)

Without it, that same manager can still:

- View pending vehicles and residents
- Decline vehicles and residents
- Add residents and vehicles themselves via the Add flows
- Everything else on their property

The specific action the grant unlocks is **approving** — the point at which a resident vehicle becomes an active, authorized permit at your property.

### Why it's gated

Approving a resident vehicle on PM-Only is the point at which billing counts a permit. The grant means the person approving is someone you (the company admin) trust to make that call.

On Enforcement-Only and Legacy, approval doesn't affect billing but still commits a resident vehicle to your enforcement roster — the same trust logic applies.

Regardless of tier, the grant is your choice about who among your managers has approval authority.

### Where to set it

**Company Admin → Users tab → Property Managers list**

Each manager row shows an authority pill:

- **✓ Can Approve** (green) — authority granted; the manager sees Approve buttons in their portal
- **No Approve** (grey) — authority not granted; the manager sees no Approve buttons, only Decline

Click the pill to flip the state. A confirmation dialog fires with a copy that varies by tier:

- **PM-Only** — mentions the billing impact ("this initiates billing at the graduated permit rate")
- **Enforcement-Only / Legacy** — plain authorization copy

### When you create a new manager

Adding a new manager (Users → Add User → role = Manager) requires you to pick **YES or NO** on approval authority at creation time. There is no default — you make the deliberate choice. You can change it later via the pill.

### What the manager sees

If **without authority**: the manager's portal shows pending vehicles and residents with only a **Decline** button on each row. There is no "Approve" button visible. Approving is not a UI they can find and act on.

If **with authority**: the manager sees the full **Approve** + **Decline** button pair. There's also a property-wide **Approve All Pending** button in the header for bulk onboarding.

### What if the manager tries to approve without authority?

They can't. The Approve button doesn't exist in the UI without the grant. Even if they attempt the underlying action directly (via a saved link or scripted call), the server rejects it with `forbidden_manager_approval_not_authorized`. The rule is enforced end-to-end.

### Common scenario — "the manager can't see the approve button"

**#1 support call pattern.** A new manager reports pending vehicles but no way to approve them. Ninety percent of the time: authority hasn't been granted. Go to Users → Property Managers → their row → click the pill from "No Approve" to "✓ Can Approve." Confirm the copy. They'll see the button on their next portal load or after a refresh.

---

## Grant 2 — Driver regenerate/void authority

### What it does

When granted, an enforcement driver can:

- **Void a tow ticket they generated** — needed when the ticket was created in error (wrong plate, wrong property, resolved on-site)
- **Regenerate a corrected tow ticket** — after voiding, they can immediately re-issue with the corrected information; the void reason is captured in the audit log

Without it, that same driver can still:

- Submit violations
- Generate tow tickets from confirmed violations
- Do their normal enforcement workflow

The specific action the grant unlocks is **voiding and re-issuing a stamped tow ticket in the field**.

### Why it's gated

A stamped tow ticket is a Texas Chapter 2308 compliance document. Voiding one carries legal implications; the driver who voids should be someone the company admin trusts to make that call — and every void needs a reason captured for audit.

Drivers who don't have the grant can still do their normal enforcement workflow. If they generate a ticket in error and don't have the grant, they contact their company admin, who can void it from the admin surface.

### Where to set it

**Company Admin → Drivers list**

Each driver row shows a regenerate-authority state (similar to the manager pill). Click the toggle to flip.

The confirmation copy explains what the grant does:

> Grant regenerate permission to *Driver Name*?  
> This lets the driver void and replace their own tow tickets in the field (with a reason captured per regenerate). Audited.

Revoking is similarly a one-click flip with a confirm. The revoke takes effect at the server immediately; a currently-signed-in driver session catches up on the next portal load.

### What the driver sees

If **without authority**: no **Regenerate** button on stamped tickets. Violations still submit; tickets still generate; the field workflow works.

If **with authority**: the **Regenerate** button appears on the driver's stamped tickets. Tapping it walks through a void-with-reason step, then a re-issue step.

### Common scenario — "the driver can't fix a ticket they issued in error"

Same pattern as the manager. If a driver reports they can't void a mis-issued ticket: go to Drivers → their row → grant regenerate authority. From that point forward they can void + reissue in the field. A ticket already issued in error can be voided by an admin from the admin surface immediately, regardless of the driver's grant state.

---

## Who can grant these authorities?

**Only company admins.** The server enforces this — the DEFINER RPCs behind the toggle check the caller's role (`role_not_authorized: only company admins can change this permission`). Managers, drivers, leasing agents, and residents cannot grant themselves authority, and they cannot grant it to others.

Super-admin (the ShieldMyLot team) can also grant on behalf of a company via internal tooling, in support situations where a company admin is temporarily unavailable. We only do that on your explicit request via support@shieldmylot.com.

---

## What's audited

Every grant and revoke is logged:

- Who changed the setting (email)
- Who's affected (manager or driver email)
- What changed (granted vs revoked)
- When
- (Optional) The reason if one was captured at the confirmation step

You can review these events in the Audit Log tab.

---

## What if a manager or driver leaves the company?

Deactivate them via the Users list or Drivers list — that's the primary "off" switch and it clears all their authority automatically. You don't need to individually revoke the grant before deactivating; deactivation covers both.

---

## Common questions

**Do I have to grant authority to a manager on setup?**
Yes — the Add User form for a Manager role requires you to pick YES or NO at creation time. There is no default. You can change it later.

**Can I grant authority to a leasing agent?**
Not currently. Leasing agents are read-mostly by design. Approval authority is manager-only.

**What if I want ALL my managers to have approval authority?**
Grant it individually as you create or edit each one. There's no "grant to all" action today; the deliberate choice is intentional.

**Does the manager grant apply to all their properties?**
Yes. A manager's approval authority is per-account, not per-property. If they manage three properties, they have approval authority on all three (or none).

**How fast does a grant take effect?**
Server-side: immediately. In the user's live portal: on their next page load or after a refresh. B211 auto-logout (12 hours) will pick it up on their next re-login regardless.

**Can the driver see whether they have the regenerate grant?**
The button's presence or absence answers the question. There isn't a separate "your permissions" screen for drivers today — the UI just shows what they can do.

**Is there a granular permission for "approve residents but not vehicles" (or vice versa)?**
No. Approval authority is a single grant covering both.

---

## Next steps

- [Account Setup](02-account-setup.md) — inviting managers and drivers
- [Property Management Overview](08-property-management-overview.md) — where manager approval fits in the PM workflow
- [Tow Tickets and Evidence](07-tow-tickets-and-evidence.md) — where driver regenerate fits in the enforcement workflow

Questions? Email support@shieldmylot.com.
