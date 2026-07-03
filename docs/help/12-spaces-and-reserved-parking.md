---
title: "Spaces and Reserved Parking"
category: "Property Management Track"
audience: ["company_admin", "manager", "resident"]
tier_required: "pm_only_or_legacy"
last_updated: "2026-07-02"
related: ["property-management-overview", "resident-management", "understanding-your-tier"]
---

# Spaces and Reserved Parking

Reserved-space management on ShieldMyLot™ lets a property manager track which parking space is assigned to which resident, handle resident space requests, and see space status across a whole portfolio.

Reserved spaces are a PM-Only and Legacy feature. Enforcement-Only accounts do not have reserved-space management (enforcement operators are running the tow-and-scan workflow, not managing on-site parking assignments).

Reserved-space management is included at no additional cost.

## What a "space" is on ShieldMyLot

A space is a specific numbered parking spot at a property (e.g., "A-12", "Garage 4", "Carport 07"). Each space carries:

- A **type** — regular, carport, garage, covered, handicap, or employee
- A **status** — available, assigned, or (temporarily) reserved
- An **assignment** — one or more residents whose vehicles are authorized for that space

Spaces are property-scoped. A single company can manage spaces across many properties; each property has its own space pool.

## Where each role sees Spaces

### Property manager — the Spaces tab (property portal)

Property managers see a **Spaces** tab in their portal for the property they manage. It has:

- An **occupancy dashboard** at the top — one card per space type showing X of Y assigned
- A **list of all spaces** at the property with search + filters (by type, by status, by resident name)
- **Pending Space Requests** section — resident requests waiting on a manager decision (see below)
- **Add-Space controls** for creating additional spaces from the property's pool

The manager can:
- Assign a space to a resident
- Free a space (whole-space or per-resident when there's more than one assigned)
- Reassign a space (equivalent to free + assign)
- Approve or decline a resident space request

### Company admin — the Spaces tab (cross-property)

Company admins see a **Spaces** tab in their portal that spans **all** the company's properties. This is a cross-property single-view of the same data the property manager sees, with a property selector to focus. Useful for portfolio owners who want to see space utilization across their whole footprint without switching portals.

The CA has the same assign / reassign / free / decision actions available on their view.

### Resident — the resident portal

Residents see:
- Their **assigned space** (if any) on their My Info tab
- The ability to **request a specific space** if the property has unassigned spaces available
- Status updates on their requests (pending / approved / declined)

## Assigning a space (property manager)

### Direct assignment

1. **Property portal → Spaces tab**
2. Locate the target space in the list. If it's already assigned, the resident row appears under it.
3. Click **Assign** on the row.
4. Search or select the resident from the picker.
5. Confirm.

The space's status flips to "assigned" and the resident's vehicles authorized at that unit become linked to the space.

### At resident-add time

When creating a new resident via **Add Resident** on the Residents tab, the manager can optionally pick a space for them in the same form. On save, the resident is created + assigned to the space in one action.

### At approval time (resident registration cascade)

When approving a pending resident whose registration form included a preferred space, the manager can grant the space as part of the approval. If no preferred space was requested, approval alone doesn't assign one — that happens separately later.

## Freeing a space

There are two modes:

- **Whole-space** — Removes all resident ties from the space; status returns to available. Use when the space is genuinely being vacated (resident moved out, restructuring the space pool).
- **Per-resident** — Removes one resident's tie while keeping others. If the last tie is removed, the space auto-frees. Use when one resident of a shared space leaves but roommates remain.

Freeing a space does NOT touch the resident's vehicles or authorization — the resident stays registered; only their space assignment goes away. Their vehicles remain authorized to park at the property until deactivation or removal.

## Space requests (resident-driven)

Residents can request a specific space from their portal.

### Resident submits a request

1. Resident portal → space request area
2. Resident picks a specific available space from the list of currently unassigned spaces at their property
3. Adds an optional note explaining the request
4. Submits

The request lands in the **Pending Space Requests** queue in the property manager's Spaces tab.

### Manager decides

The manager reviews each request and can:

- **Approve + assign** — the resident is assigned to the space they requested (or to a different one the manager picks from the available pool if the requested one is no longer available)
- **Decline** — with an optional reason surfaced back to the resident

### Resident sees the outcome

The resident's portal shows the decision. If approved, the space appears on their My Info. If declined, they see the reason (if the manager provided one) and can submit a new request later.

### Rate limits

A resident with a pending request cannot submit another until the first is decided. This prevents queue spam without limiting legitimate use.

## Multiple residents per space (roommates)

A single space can be assigned to more than one resident — for example, roommates sharing a spot. Both residents' vehicles authorized at that unit become linked. The per-property configuration determines whether roommate tying is supported, and if so, the max residents per space.

- Freeing one resident from a shared space leaves the other(s) intact.
- Freeing the last resident from a shared space auto-frees the whole space.

## Adding more spaces to a property

If your property has room for more spaces than currently exist in the system, the manager can generate additional spaces from the space pool:

1. Property portal → Spaces tab → **Add spaces**
2. Pick the type (regular, carport, garage, covered, handicap, employee)
3. Enter the count
4. Optionally provide a label prefix (auto-derived from type if not set)
5. Confirm

The new spaces land as available and can be assigned right away.

## What a resident sees on My Info

- **Assigned Space** — the space label (e.g., "A-12") if the resident has one assigned; "—" if not
- **Approved vehicles** — the resident's currently-approved vehicles that are linked to the space

If the space assignment or vehicle approval changes, the My Info surface updates on next portal load.

## Audit trail

Every space action is audited: who assigned, who freed, who decided a request, when, and (where relevant) the reason provided. The audit log is visible to admins and to the company admin who owns the property.

---

## Common questions

**Do spaces cost extra?**
No. Reserved-space management is included on PM-Only and Legacy at no additional cost.

**Can Enforcement-Only accounts use Spaces?**
No. Enforcement-Only doesn't have the reserved-space feature. Legacy accounts that include the PM track do have it.

**Can a resident have more than one space?**
Not currently — a single resident is assigned to at most one space. The reverse case (multiple residents per space) is supported for shared/roommate scenarios.

**What happens to spaces when a resident is deactivated?**
When a resident is deactivated (moved out, unit vacated), their space ties are automatically cleared. The space returns to available for reassignment.

**What if the resident requests a space that gets assigned to someone else before I decide?**
The manager can decline the original request with a note ("This space was assigned before your request was reviewed — please pick another") and the resident can submit a new one.

---

## Next steps

- [Property Management Overview](08-property-management-overview.md) — where Spaces fits in the PM workflow
- [Resident Management](10-resident-management.md) — how spaces tie to resident onboarding
- [Understanding Your Tier](03-understanding-your-tier.md) — pricing model and what's included

Questions? Email support@shieldmylot.com.
