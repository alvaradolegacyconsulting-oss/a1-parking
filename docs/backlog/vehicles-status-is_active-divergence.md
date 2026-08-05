# Backlog — `vehicles.status='active' AND is_active=FALSE` divergence

**Filed:** 2026-08-04 during unit-occupancy preflight (FOR MATEO thread).
**Priority:** MEDIUM-HIGH. Display drift from enforcement — the direction that ends in a tow.

## Observation

Jose's 2026-08-04 vehicles probe:

| Property | `n_is_active` | `n_status_active` | `n_joint` | `n_divergence` (`is_active=TRUE AND status='pending'`) |
|---|---|---|---|---|
| Green Acres | 59 | **66** | 59 | 0 |
| Test Legacy Property | 13 | 13 | 12 | 0 |

**Seven rows at Green Acres are `status='active'` with `is_active=FALSE`. One at Test Legacy Property.**

Portal displays them as approved. Enforcement (`check_resident_plate`) will not authorize them.

Visible in Jose's screenshot: the Test Legacy Property "Approved permits" tile reads **13**; the joint predicate returns **12**. The tile is showing one car that won't scan.

## Why this direction is the worse one

A manager reads the CRM, tells the resident their car is registered, and the driver's scan reads NOT AUTHORIZED — the resident's car is towed while the record shows it approved. This is the same evidentiary shape as the Green Acres timestamp gap: the system's own record argues against the resident when the record is wrong.

`CURRENT_STATE` records this asymmetry and concludes *"enforcement is safe."* That's true and it's the wrong half — **enforcement is safe; the display is not, and the display is what staff answer residents with.**

## Likely source

From the preflight Part A audit (see FOR_MATEO_unit_occupancy_preflight_aug4_2026):
- [manager-crm-writes.ts:114-121](app/lib/manager-crm-writes.ts#L114-L121) `trimDepartedResidentVehicles` writes `is_active=false` and never touches `status`.
- [manager/page.tsx:1992](app/manager/page.tsx#L1992) `removeVehicle` — same shape.
- [manager/page.tsx:1291](app/manager/page.tsx#L1291) `declineVehicle` writes BOTH `is_active=false, status='declined'` — the pattern the others should match.

Every soft-delete path that touches `is_active` needs to also update `status` to reflect the deactivation. Convention should be documented and enforced (trigger, or code-review checklist).

## Three-predicate divergence context

Same preflight Part A enumerated three predicates in production simultaneously:

| Predicate | Used at | Semantics |
|---|---|---|
| `is_active` alone | `check_resident_plate` (enforcement); CA `total_vehicles`; `complianceRate`; `trimDepartedResidentVehicles` writes; `removeVehicle` writes | ENFORCEMENT — this is the driver's ground truth |
| `status` alone | `countVehicles` and everything derived from it (badges, insights, "Approved permits" tile); `listPendingVehiclesForUnit`; `fetchVehicles` split; pending-vehicles render | User-facing counts |
| `is_active AND status='active'` | billing `countActiveRecords.permits`; CA Plan-tile `approvedPermitCount`; space `authorizedPlates` list | Billing meter |

Row states in the field:
- `is_active=TRUE, status='active'` — approved and enforcement-authorized ✓
- `is_active=FALSE, status='active'` — **DISPLAYED AS APPROVED, ENFORCEMENT DENIES** (8 rows across 2 properties, 2026-08-04)
- `is_active=TRUE, status='pending'` — hypothetical divergence, zero rows in prod as of 2026-08-04
- `is_active=FALSE, status='pending'` — pending awaiting approval ✓
- `is_active=FALSE, status='declined'` — declined ✓

## Severity — mostly settled 2026-08-04

Jose's follow-up (per FOR MATEO thread) resolved 6 of the 8 divergent rows:

- **Green Acres units `149`, `15`, `150` — inactive residents.** Departed tenants whose vehicles were `is_active`-flipped without `status` update. **Display clutter, not tow risk.**
- **Test Legacy Property unit `117` — inactive resident.** Same shape.
- **Green Acres unit `Apt 136` — LIVE, OPEN.** Belongs to `natalielop08@gmail.com`; resolution is entangled with [residents-duplicate-row-uniqueness.md](./residents-duplicate-row-uniqueness.md) — one of the two `natalielop08` residents rows is `is_active=TRUE`, the other `is_active=FALSE`. Which is the current tenant, and what state their vehicles are in, blocks this row's triage. **Potentially live tow risk** until confirmed.

**Clustering observation:** all 8 divergent rows were created within a 48-hour window on **July 27–28, 2026**. That's not gradual drift — it's one event. Worth investigating what code path or manual action caused it (a bulk deactivate flow that stopped mid-execution? a manual sweep that touched `is_active` but forgot `status`?). Add to the fix commit's diagnostic pass.

## Original follow-up query (kept for reference)

```sql
SELECT v.property, v.unit, v.plate, v.status, v.is_active,
       v.resident_email, r.is_active AS resident_is_active
FROM public.vehicles v
LEFT JOIN public.residents r ON lower(r.email) = lower(v.resident_email)
WHERE v.status = 'active' AND v.is_active = FALSE
ORDER BY v.property, v.unit;
```

## Scope options

**A. Data hygiene only.** UPDATE the 8 rows to align `status` with `is_active`. Recovers current display but doesn't prevent recurrence. Cheapest.

**B. Fix the writer.** Update `trimDepartedResidentVehicles` and `removeVehicle` to write both columns. Prevents new drift; doesn't fix historical.

**C. Invariant enforcement.** Add a trigger on `vehicles` that keeps `status` and `is_active` mutually consistent per the state machine. Belt against future writers.

**D. Predicate reconciliation.** Reduce to ONE predicate everywhere. Requires deciding whether `status` OR `is_active` is authoritative (recommend `is_active`, since it matches enforcement). Largest scope.

**Recommendation: A + B in one commit** (backfill + writer fix), C as a follow-up if similar drift returns, D as a slice-N cleanup pass.

## Adjacent finding — this build does NOT worsen it

`get_unit_occupancy_summaries` (shipped 2026-08-04) uses `is_active=TRUE` — matches enforcement. Its count for a Green Acres property will show 59 while the "Approved permits" tile shows 66 — **two numbers on the same screen, seven apart**. That is not a reason to change the predicate; ours is the number that describes reality. The tile is the one that's wrong, and this backlog item is the fix.

## Related

- FOR_MATEO_unit_occupancy_preflight_aug4_2026 (Part A three-predicate table)
- CURRENT_STATE `vehicles.status` vs `is_active` mirror note
- [pattern_enforcement_matches_on_plate_alone.md](../../.claude/projects/-Users-ALC-a1-parking/memory/pattern_enforcement_matches_on_plate_alone.md) — standing pattern that enforcement predicates are load-bearing
