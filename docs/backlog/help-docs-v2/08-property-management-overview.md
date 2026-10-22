---
title: "Property Management Overview"
category: "Property Management Track"
audience: ["company_admin", "manager"]
tier_required: "any"
last_updated: "2026-10-22"
related: ["visitor-passes", "resident-management", "resident-self-registration"]
---

# Property Management Overview

If your business is property management — running residential communities, mixed-use buildings, or commercial properties where you manage tenants and visitors — this guide covers how ShieldMyLot™ fits your workflow.

If you're a towing company, see [Adding Properties](04-adding-properties.md) and [Provisioning Drivers](05-provisioning-drivers.md) instead.

## What the PM track is for

Property managers use ShieldMyLot to:

- **Register residents** and track their vehicles for parking authorization
- **Issue visitor passes** for guests, contractors, and delivery services
- **Maintain exempt plate lists** for vehicles that should never be towed
- **Coordinate with towing companies** that enforce on your properties

What ShieldMyLot does NOT do for PM customers:

- **Submit violations** — That's the towing company's job, not yours
- **Tow vehicles** — Your towing partner handles this
- **Issue tow tickets** — Same; that's enforcement-side work

PM customers use the platform as a **management layer**. Your towing partner uses the platform as an **enforcement layer**. Together, the two sides give residents a coherent experience: register once, get visitor passes when needed, and any enforcement decisions can be checked against your authorized vehicles list.

---

## How PM and Enforcement work together

The two tracks aren't the same company by default. Most properties work with a separate towing company for the actual enforcement. Here's the typical relationship:

**You (Property Manager):**
- Set parking rules for your property
- Manage your resident roster and their authorized vehicles
- Issue visitor passes for legitimate guests
- Maintain exempt plate lists for property owner vehicles, contractors, etc.

**Your Towing Partner (Enforcement company):**
- Patrols your property looking for violations
- Submits violations against unauthorized vehicles
- Coordinates with you on unusual situations

Both sides have visibility into the same property data through ShieldMyLot. Your towing partner can see your registered residents and visitor passes when deciding whether to tow. You can see violations submitted at your property when responding to resident inquiries.

This shared-visibility model only works if both companies use ShieldMyLot. If your towing partner uses a different platform, you'd need to coordinate manually.

---

## What you'll set up

When you start with ShieldMyLot on the PM track, here's the typical setup sequence:

### 1. Account setup

Complete your company profile, support contact, and admin users. See [Account Setup](02-account-setup.md).

### 2. Add your properties

Each property you manage becomes a property record. PM Starter covers one property; PM Pro covers up to 50.

For each property:
- Name, address, type (apartments, condos, retail, etc.)
- Visitor pass settings: the per-plate visitor pass limit (rolling 30 days) and the exempt list. See [Visitor Passes](09-visitor-passes.md).
- Exempt plate list (property owner vehicles, regular delivery services, maintenance contractors)

### 3. Add your managers and leasing agents

If you have on-site staff who manage day-to-day operations, give them their own accounts.

- **Property managers** are assigned to specific properties; they handle resident registration approvals and visitor pass operations. There is no cap on the number of property manager accounts.
- **Leasing agents** have read-mostly access to assist managers without making changes. Your Plan tab shows whether your plan includes them.

### 4. Set up resident QR codes

Each property gets a QR code for resident self-registration. Print the QR code and post it where new residents will see it (leasing office, welcome packets, building entrances).

See [Resident Self-Registration](11-resident-self-registration.md) for the resident workflow and manager setup details.

### 5. Coordinate with your towing partner

Make sure your towing partner has access to ShieldMyLot for your properties. Your tower's company admin and your company admin should connect to ensure your properties are visible to their enforcement drivers.

---

## Daily operations

Once setup is complete, here's what daily operations look like:

### Manager activities

- **Approve resident self-registrations** — Verify new residents are real tenants and approve their account
- **Approve vehicle additions** — When existing residents request additional vehicles
- **Issue visitor passes manually** — For walk-in requests at the leasing office
- **Update exempt plates** — As new contractors or recurring visitors come on board
- **Monitor unusual activity** — Watch for patterns that signal a problem (lots of visitor passes from one resident, repeated complaints about one tower, etc.)

### Resident activities (self-service)

- **Register their vehicles** during move-in
- **Issue visitor passes** for guests, delivery services, contractors
- **Update their vehicle info** if they get a new car, change colors, etc.

### Tower activities (separate company)

- **Patrol the property** looking for unauthorized vehicles
- **Cross-reference plates** with resident roster and active visitor passes
- **Submit violations** with photo and video evidence
- **Coordinate tows** if necessary

This separation of responsibilities is intentional. You're not the enforcer; you're the manager. Your tower isn't the property manager; they're enforcement.

---

## Which plan does PM run on?

Property managers sign up on one of two self-serve plans:

- **PM Starter** ($149/mo): one property, with 500 approved permits a month included.
- **PM Pro** ($249/mo + $15 per property for the first 20; properties 21–50 included): up to 50 properties, with no permit meter.

Both include:
- Resident registration and approvals
- Reserved parking (Spaces)
- Visitor passes
- Guest authorizations
- Unlimited property manager and leasing agent accounts

For more than 50 properties or non-standard terms, ask about **Elite**.

For the full pricing model, see [Understanding Your Plan](03-understanding-your-tier.md) and [Billing and Plan Changes](13-billing-and-tier-changes.md).

---

## Multi-property management

If you manage multiple properties, ShieldMyLot is designed to handle that cleanly:

### One company, many properties

Your business is a single ShieldMyLot company; each property is a separate property record under that company. You configure managers and leasing agents per property.

- **Cross-property visibility:** Company admins see all properties; managers see only their assigned properties
- **Per-property settings:** Each property has its own visitor pass rules, exempt plates, signage notes
- **Unified billing:** One subscription covers all your properties (up to your plan's property limit)

### Manager assignment strategies

How you assign managers depends on your operation:

- **One manager per property** — Simplest model; clear ownership
- **Regional managers** — One manager assigned to multiple geographically-close properties
- **Specialist managers** — Different managers for residential vs. commercial properties

Managers can only see and act on properties they're explicitly assigned to. Assigning a manager to multiple properties is fine; managers without assignments see nothing.

### Property-specific configuration

Each property has its own:
- Visitor pass settings (the per-plate limit and the exempt list)
- Exempt plate list
- Manager assignments
- Resident roster
- QR code for resident self-registration
- Signage notes

Don't try to use one property record for multiple physical locations. Each physical property should have its own record.

---

## Working with multiple towing companies

If different properties use different towing partners, that's supported:

- Each property has its own enforcement relationship
- A driver from Tower A can submit violations only at properties where Tower A has been granted access
- Drivers from Tower B work on Tower B's properties
- Cross-tower visibility doesn't happen — each tower sees only their own properties

For a property to be enforced by multiple towers simultaneously (rare but possible), each tower would maintain their own property record. This isn't ideal — coordination is harder — but the platform doesn't prevent it.

For most cases: one property → one tower → clean operations.

---

## Common questions

**Can we run our own enforcement on our properties?**
The PM plans don't include violation or tow tools. Enforcement runs on the Operator plans, and **Operator Pro** includes both enforcement and the full resident and visitor toolset. If you want to run your own enforcement, email support@shieldmylot.com and we'll talk through the right setup.

**Can we set parking rules per-spot, not just per-property?**
Not currently. Properties have property-wide rules. If you have a specific complex setup (e.g., "Building A spots 1-50 are visitor-only, Building B spots 1-100 are resident-only"), you'd communicate that through signage and use the violation submission notes to capture details when enforcement happens.

**How do we handle visitor parking for events (weddings, parties, etc.)?**
Issue visitor passes covering the event timeframe. If guests would hit the property's visitor-pass limit, raise the limit or add their plates to the exempt list for the event, and let your towing partner know the event timing.

**Do we need to do anything when a resident moves out?**
Yes — deactivate their account in your manager portal. This removes their vehicles from the authorized list and prevents future visitor pass issuance from their account. See [Resident Management](10-resident-management.md).

---

## Next steps

- **Set up visitor pass rules:** [Visitor Passes](09-visitor-passes.md)
- **Manage your resident roster:** [Resident Management](10-resident-management.md)
- **Provide QR codes to new residents:** [Resident Self-Registration](11-resident-self-registration.md)

Questions about PM setup? Email support@shieldmylot.com.

