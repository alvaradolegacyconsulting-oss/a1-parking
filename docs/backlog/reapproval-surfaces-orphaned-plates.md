# Backlog — Resident re-approval must surface previously-trimmed plates

**Filed:** 2026-08-05 during deactivation Commit 2 midpoint review (FOR MATEO thread).
**Priority:** HIGH — this is the item that would have prevented resident 690's live incident, not the cascade guards.

## The gap

**Commit 2's ownership guards prevent a cascade from creating orphaned plates. They do nothing about the *approval* that fails to notice existing ones.**

Natalie's actual defect timeline:
1. Registered → approved (vehicles active)
2. **July 31**: Deactivated. `B166_OWNER_TRIM` fired and trimmed her vehicles to `is_active=FALSE`.
3. Some time between Jul 31 and Aug 3: **Re-registered** under a different unit spelling (`136` vs `Apt 136`) — new `residents` row
4. **August 3**: Amanda approved the new registration
5. Amanda saw an active resident with no vehicles surfaced. The two previously-trimmed plates sat under the same lowered email at Green Acres, `is_active=FALSE, status='active'`, with **no signal to Amanda that they existed**

The **two-day gap** between the trim (Jul 31) and the re-approval (Aug 3) is the shape that matters — the plates had been trimmed and forgotten by the time re-approval happened. Approval didn't fail. Approval succeeded silently on incomplete state. Amanda had no way to know.

## Why this beats the rest of the arc for prevention value

The August 5 Commit 2 guards close the *cascade-produces-orphan* path. This backlog item closes the *approval-inherits-orphan* path.

- **Guards** stop a future Natalie-shape from being created
- **This item** would have caught Natalie's *actual* incident at approval time, weeks after she was trimmed

Jose told A1 we're fixing what happened. This is what happened.

## Design shape

At resident approval time, surface any vehicles under `lower(resident.email)` at the same property with `is_active = FALSE` AND `status = 'active'` (the "previously-approved-then-trimmed" signature). Let the manager restore them in the same action.

**Data query at approval time:**

```sql
SELECT id, plate, unit, deactivated_at, deactivation_reason
FROM public.vehicles
WHERE lower(resident_email) = lower(:approved_email)
  AND property ILIKE :approved_property
  AND is_active = FALSE
  AND status = 'active'
ORDER BY deactivated_at DESC NULLS LAST;
```

Any row = a plate this resident owned before, that enforcement will refuse today, that the manager just implicitly re-authorized this person for. Surface as a **restore panel** inside the approval flow.

**UI shape sketch** — inside `PmResidentCrm.tsx` approval flow, when the approve-resident button is clicked but before the RPC fires, if the query above returns rows, show:

> **This resident has 2 previously-registered plates at Green Acres:**
> - `HBK8088` — deactivated Aug 3, reason: (from B166_OWNER_TRIM cascade)
> - `WFY2571` — deactivated Aug 3, reason: (from B166_OWNER_TRIM cascade)
>
> **[Restore all]** • **[Approve without restoring]** • [Cancel]

Analogous to the **unit-occupancy panel** shipped 2026-08-04 in `5f92557` — same design language (surfacing context at decision-time), same fail-quiet rule (RPC error → render nothing, never invent a zero).

## Coordination points

- **`app/lib/unit-occupancy.ts`** — this is the natural sibling. Could extend `get_unit_occupancy_summaries` OR add a peer RPC `get_previously_trimmed_plates(p_property, p_email)`. My inclination: peer RPC, because occupancy is per-unit and this query is per-resident-email.
- **`PmResidentCrm.tsx`** — where the approve button lives; where the restore panel goes
- **`manager-crm-writes.ts` approveResidentWrite** — needs to accept an optional `restorePlates: string[]` and re-run `approveVehicle` per row (permit-granting → same `can_approve_vehicles` gate)
- **Audit** — `APPROVE_RESIDENT` new_values should carry `restored_plate_ids` alongside the existing `occupancy_at_decision` key so a future audit reader sees what the manager was shown AND what they chose to restore

## 🔴 Metering consequence — decide before build

**Restoring a plate re-runs `approveVehicle`, which is permit-granting and fires `callSyncOnAdd('permit')`.** Immaterial for A1 on Legacy today. But when a PM-tier subscriber uses this surface, restoring N previously-trimmed plates meters N permit-adds against their subscription.

This is arguably correct — the plates ARE authorized permits again, and the meter should reflect that. But it should be a decision in this build's scope, not a surprise the first PM-tier subscriber notices on their bill.

Two shapes to consider:
- **A. Meter every restore** (default of the existing `approveVehicle` path). Simple, consistent with initial approval — but a restore of a plate the resident owned yesterday and lost to a bureaucratic cascade lands like a re-charge.
- **B. `approveVehicle` takes an optional `{restore: true}` flag** that skips `callSyncOnAdd('permit')` because the plate was previously metered. Requires proof the plate was previously metered (a prior sync record, or an audit_logs history that says the same plate id was previously synced). More correct, more coordination cost.

Recommendation: **A for v1**, name the choice in the entry, and file a Slice-N follow-up if PM subscribers complain. The alternative is a build that ships with an unresolved billing story — worse than an intentional simple one.

## Guarded against duplicate-identity ambiguity

Natalie's case has two `residents` rows for the same lowered email. Whichever row is the "approved" one, the query above joins on lowered email + property — so it surfaces the trimmed plates regardless of which row spelling the manager is currently approving. That's the correct shape: the plates belong to the person (identified by email), not to a specific residents row.

Once `residents-duplicate-row-uniqueness.md` closes with a unique-lowered-email constraint, "the approved row" becomes unambiguous. Until then, this surface remains correct because it doesn't consult residents-row identity at all.

## Not this arc

- **Do not fold into Commit 2** — Commit 2 is the write-core + reason field + guards arc. This is a *read + UI surface* arc. Different files, different mental model.
- Ships after Commit 2's reason infrastructure is present, so the restore action can carry a reactivation reason that mirrors the deactivation reason set.

## Adjacent

- Deactivation Commit 2 guards (this session) — prevent the *creation* of this state going forward
- Unit occupancy `5f92557` — the design precedent for "surface context at decision-time"
- [residents-duplicate-row-uniqueness.md](./residents-duplicate-row-uniqueness.md) — the underlying data issue that makes duplicate-identity approvals possible in the first place
- Natalie / resident 690 at Green Acres — the live incident this would have prevented
