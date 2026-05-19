---
title: "Visitor Passes"
category: "Property Management Track"
audience: ["manager", "leasing_agent", "resident", "company_admin"]
tier_required: "any"
last_updated: "2026-05-19"
related: ["property-management-overview", "resident-management", "resident-self-registration"]
---

# Visitor Passes

Visitor passes let temporary vehicles park at your property without risk of being towed. This guide covers how visitor passes work, who can issue them, and what limits apply.

## When visitor passes are needed

Common scenarios:

- **Resident guests** — Friends or family visiting overnight or for the weekend
- **Service providers** — HVAC contractors, plumbers, exterminators, cleaning services
- **Delivery services** — Recurring delivery vehicles (Amazon, FedEx, USPS, UPS) typically use exempt plates, not visitor passes
- **Event parking** — Birthday parties, baby showers, family gatherings at a resident's home
- **Real estate showings** — Potential buyers/renters viewing units
- **Move-in / move-out support** — Friends helping someone move

Without visitor passes, any non-registered vehicle is potentially eligible for enforcement. Visitor passes are the formal mechanism for allowing exceptions.

---

## Who can issue visitor passes

ShieldMyLot supports two issuance paths:

### Manager-issued passes

Property managers (and leasing agents on Growth+ tiers) can issue visitor passes from the manager portal. This is the right path for:
- Walk-in requests at the leasing office
- Service provider scheduling done by the property
- Event-specific bulk passes (with property owner approval)
- Cases where the resident can't issue their own pass

### Resident-issued passes (self-service)

Registered residents can issue their own visitor passes through their resident portal. This is the right path for:
- Routine guest visits
- Service appointments scheduled by the resident
- Family gatherings
- Any case where the resident knows the visitor's plate and timing

Most properties prefer the resident-issued path when possible — it's faster, doesn't burden the manager, and creates clear accountability (the resident issued the pass, so they vouch for the visitor).

---

## Visitor pass limits

Every property has limits on visitor pass usage. These come from your tier:

### Per-plate concurrent limit

The number of active (unexpired) passes that can exist for the same license plate at the same time. Typical default: 1-2.

Why this exists: prevents a single problem vehicle from getting unlimited authorization. If a vehicle is at the property continuously, it should be a registered resident or exempt plate, not a perpetual visitor pass.

This limit is set **per property** and is configurable by the property manager. Default values are reasonable for most properties; adjust if your property has unusual needs.

### Monthly cap per property

How many total passes can be issued at a property per calendar month, summed across all residents and manager-issued passes.

| PM Tier | Monthly cap per property |
|---|---|
| Essential | 50 |
| Professional | 200 |
| Enterprise | Unlimited |

If a property is busy (lots of resident guests, frequent contractors), the cap can fill up quickly. Track usage at the start of the month — if you're using 30 passes in week 1, you'll hit the Essential cap by week 2.

### Maximum pass duration

How long a single pass can be active.

| PM Tier | Maximum duration |
|---|---|
| Essential | 12 hours |
| Professional | 24 hours |
| Enterprise | 48 hours |

For visits longer than the max (e.g., a week-long stay with family), the resident or manager would issue multiple consecutive passes.

---

## Issuing a pass (manager or leasing agent)

### Step 1: Open the manager portal

Navigate to the **Visitor Passes** tab.

[Screenshot: Manager portal Visitor Passes tab with active passes list and + Issue Pass button]

### Step 2: Click "+ Issue Pass"

Fill in:

- **License plate** — Of the visiting vehicle (any state)
- **Resident (optional)** — If issued on behalf of a specific resident, link to that resident's account
- **Start time** — When the pass becomes active (default: now)
- **End time** — When the pass expires (capped at your tier's maximum duration)
- **Notes (optional)** — Why the pass was issued (e.g., "HVAC repair scheduled for unit 14B")

### Step 3: Save

The pass is active immediately. The visiting vehicle is now protected from enforcement until the end time.

If the visit is over earlier than expected, you can manually expire the pass. If you need to extend, issue a new pass (subject to the per-plate concurrent limit and duration max).

---

## Issuing a pass (resident self-service)

If you're a resident with a registered account, you can issue your own visitor passes:

### Step 1: Log in to your resident portal

Navigate to **Visitor Passes**.

### Step 2: Click "Issue New Pass"

Fill in:

- **Visitor name (optional)** — For your own reference
- **License plate** — Of the visiting vehicle
- **Start time** — When the pass becomes active (now or scheduled for the future)
- **Duration** — How long the pass should last (within your property's maximum)
- **Reason (optional)** — Helps you remember and helps the property if there are questions

### Step 3: Submit

The pass is active immediately (or scheduled, if you set a future start time). Your visitor can park at the property until the end time.

If you try to issue a pass beyond a limit (per-plate concurrent, monthly cap, duration max), you'll see a clear message explaining why. You may need to wait, contact the property manager for an exception, or reduce the requested duration.

---

## Exempt plates (an alternative to visitor passes)

For vehicles that regularly visit and always should be authorized, **exempt plates** are a better fit than recurring visitor passes.

Examples of vehicles that should be exempt:
- Property owner's personal vehicles
- Maintenance contractors with weekly visits
- Property management firm's company vehicles
- Recurring delivery services (Amazon, FedEx, etc.) — these often handle exemptions per-property
- Permanent permit holders (under specific resident leases)

Exempt plates are added per property by the manager or company admin (see [Adding Properties](../enforcement-track/04-adding-properties.md) for the workflow on the enforcement side). The exempt list is shared with your towing partner so their drivers see the exemption during plate lookups.

**Don't issue daily visitor passes for the same recurring vehicle** — add it to the exempt list instead. Saves your monthly cap for actual visitors.

---

## Reviewing active passes

### From the manager portal

Visitor Passes tab shows:
- All currently-active passes at your property
- Recently-expired passes (for audit and review)
- Pass details: plate, resident (if linked), times, who issued, notes

### From the resident portal

Resident Visitor Passes tab shows:
- Active passes issued by that resident
- Recently-expired passes by that resident

The resident sees only their own passes — not other residents' or manager-issued passes for the property.

---

## When passes expire

When a pass's end time passes:
- The pass status changes from "active" to "expired"
- The visiting vehicle is no longer protected from enforcement
- The pass still exists in records for audit purposes
- The pass doesn't count against the active concurrent count anymore

Expired passes can be referenced for audit (e.g., "When did the HVAC contractor come last month?") but don't affect ongoing operations.

---

## Public visitor pass form (if enabled)

Some properties enable a **public visitor pass request form** at `/visitor` for self-service by visitors themselves. This lets a visitor:

1. Land at a public form (no login required)
2. Select the property they're visiting
3. Enter their plate, visit time, and (optionally) the resident they're visiting
4. Submit

The pass may be:
- **Auto-approved** within property-defined limits
- **Pending manager approval** if the property requires it
- **Rejected** if the request violates rules (e.g., requesting 72 hours when max is 24)

This feature is configured per property by the manager. It's useful for properties with high visitor volume where centralizing through the manager is impractical. It also has trade-offs — anonymous public submissions can be abused, so think carefully before enabling.

---

## Common questions

**A resident issued a visitor pass but the visitor still got towed. What happened?**
Possible causes:
1. The pass expired before the tow timestamp — check end times
2. The plate was entered incorrectly in the pass (typo) — check the pass plate against the actual vehicle
3. The pass was for the wrong property — verify the property matches
4. The tower's driver missed the pass during lookup — driver error; report to the towing company for investigation

The audit trail will show what passes existed at the violation time. Cross-reference carefully.

**Can a resident issue a pass for their own vehicle if they're temporarily driving a rental?**
Yes. Visitor passes don't have to be for someone else's vehicle — they're for any vehicle. If your registered vehicle is in the shop and you're driving a rental, issue a visitor pass for the rental's plate.

**What if a visitor stays longer than the maximum pass duration allows?**
Issue a follow-up pass when the first one expires. Subject to the per-plate concurrent limit (if "concurrent" means overlapping; if the first pass has expired, a new pass isn't concurrent).

**Can I issue a pass retroactively (for a visit that already happened)?**
Not typically — passes are forward-looking. If a visitor was towed and shouldn't have been, the right path is the dispute workflow (see [Managing Disputes](../shared/12-managing-disputes.md)), not a retroactive pass.

**How do I handle a one-time large event (wedding, holiday party)?**
For events where you expect many visitor vehicles:
1. Coordinate with your towing partner ahead of time — they may temporarily suspend enforcement
2. Issue manager passes for known attendees
3. Communicate event timing clearly so residents can issue their own guest passes
4. Consider hiring a parking valet or shuttle to keep cars off the property entirely

**Can a resident issue a pass for someone else's vehicle they don't even know?**
Yes — the pass is for a plate, not a person. But the resident is responsible for the pass. If the vehicle causes problems, the resident's account history reflects that.

---

## Best practices

- **Train residents on the self-service flow** — Reduces manager workload
- **Set sensible per-plate limits** — Default values work for most properties; adjust if you have unusual patterns
- **Use exempt plates for recurring vehicles** — Saves monthly cap
- **Audit monthly cap usage** — If you're consistently hitting it, upgrade your tier or investigate why
- **Document unusual exceptions in pass notes** — Future you will thank current you when reviewing audit logs
- **Communicate the visitor pass rules to residents** — Print signage near the leasing office or include in welcome packets

---

## Next steps

- **Manage your residents:** [Resident Management](10-resident-management.md)
- **Understand resident self-service:** [Resident Self-Registration](../shared/11-resident-self-registration.md)
- **Configure your property settings:** [Property Management Overview](08-property-management-overview.md)

Questions about visitor pass management? Email support@shieldmylot.com.
