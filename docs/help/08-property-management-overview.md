---
title: "Property Management Overview"
category: "Property Management Track"
audience: ["company_admin", "manager"]
tier_required: "any"
last_updated: "2026-05-19"
related: ["visitor-passes", "resident-management", "resident-self-registration"]
---

# Property Management Overview

If your business is property management — running residential communities, mixed-use buildings, or commercial properties where you manage tenants and visitors — this guide covers how ShieldMyLot™ fits your workflow.

If you're a towing company, you want the [Enforcement Track](../enforcement-track/04-adding-properties.md) instead.

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

Complete your company profile, support contact, and admin users. See [Account Setup](../getting-started/02-account-setup.md).

### 2. Add your properties

Each property you manage becomes a property record. PM-tier limits apply (3 / 10 / unlimited depending on tier).

For each property:
- Name, address, type (apartments, condos, retail, etc.)
- Visitor pass settings (concurrent per-plate limit, monthly volume cap, max duration)
- Exempt plate list (property owner vehicles, regular delivery services, maintenance contractors)

### 3. Add your managers and leasing agents

If you have on-site staff who manage day-to-day operations, give them their own accounts.

- **Property managers** are assigned to specific properties; they handle resident registration approvals and visitor pass operations.
- **Leasing agents** (Growth+ tiers) have read-mostly access to assist managers without making changes.

### 4. Set up resident QR codes

Each property gets a QR code for resident self-registration. Print the QR code and post it where new residents will see it (leasing office, welcome packets, building entrances).

See [Resident Self-Registration](../shared/11-resident-self-registration.md) for the resident workflow and manager setup details.

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

## PM tier features

The PM track has three tiers with different limits and features:

### Essential

For small portfolios (1-3 properties) with modest visitor pass volume.

- Up to 3 active properties
- 50 visitor passes per property per month
- Maximum visitor pass duration: 12 hours
- Standard analytics
- Resident self-registration

### Professional

For mid-size portfolios (4-10 properties) with higher visitor activity.

- Up to 10 active properties
- 200 visitor passes per property per month
- Maximum visitor pass duration: 24 hours
- Advanced analytics
- Leasing agent role (read-mostly assist role)
- AI-powered docs search

### Enterprise

For large portfolios (unlimited properties) with full feature access.

- Unlimited active properties
- Unlimited visitor passes per property per month
- Maximum visitor pass duration: 48 hours
- All Professional features
- API access (read-only)
- Premium video tutorial library
- Priority support

For full tier details, see [Understanding Your Tier](../getting-started/03-understanding-your-tier.md).

---

## Multi-property management

If you manage multiple properties, ShieldMyLot is designed to handle that cleanly:

### One company, many properties

Your business is a single ShieldMyLot company; each property is a separate property record under that company. You configure managers and leasing agents per property.

- **Cross-property visibility:** Company admins see all properties; managers see only their assigned properties
- **Per-property settings:** Each property has its own visitor pass rules, exempt plates, signage notes
- **Unified billing:** One subscription covers all properties (up to your tier's property limit)

### Manager assignment strategies

How you assign managers depends on your operation:

- **One manager per property** — Simplest model; clear ownership
- **Regional managers** — One manager assigned to multiple geographically-close properties
- **Specialist managers** — Different managers for residential vs. commercial properties

Managers can only see and act on properties they're explicitly assigned to. Assigning a manager to multiple properties is fine; managers without assignments see nothing.

### Property-specific configuration

Each property has its own:
- Visitor pass settings (per-plate limit, monthly cap, max duration)
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

**Can we run our own enforcement on PM track properties?**
PM track doesn't include violation submission tools. If you want to handle your own enforcement, you'd need either:
- An Enforcement-track account (separate from your PM-track account), OR
- A staff member who works for a separate towing company entity that has its own ShieldMyLot Enforcement account

Mixing enforcement and management in a single PM-track account isn't currently supported.

**Can we set parking rules per-spot, not just per-property?**
Not currently. Properties have property-wide rules. If you have a specific complex setup (e.g., "Building A spots 1-50 are visitor-only, Building B spots 1-100 are resident-only"), you'd communicate that through signage and use the violation submission notes to capture details when enforcement happens.

**How do we handle visitor parking for events (weddings, parties, etc.)?**
Issue visitor passes covering the event timeframe. If you'd exceed your monthly limit for that property, contact your towing partner to coordinate temporary suspension of enforcement, or upgrade your tier.

**Do we need to do anything when a resident moves out?**
Yes — deactivate their account in your manager portal. This removes their vehicles from the authorized list and prevents future visitor pass issuance from their account. See [Resident Management](10-resident-management.md).

---

## Next steps

- **Set up visitor pass rules:** [Visitor Passes](09-visitor-passes.md)
- **Manage your resident roster:** [Resident Management](10-resident-management.md)
- **Provide QR codes to new residents:** [Resident Self-Registration](../shared/11-resident-self-registration.md)

Questions about PM-track setup? Email support@shieldmylot.com.
