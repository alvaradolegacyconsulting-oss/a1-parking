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

## Six generator sites — asymmetric write is CORRECT for cascades

The 2026-08-04 deactivation-preflight (Ask A/B) enumerated every `is_active=false` write. Six sites write `is_active=false` without touching `status`:

| Site | File:line | Semantic |
|---|---|---|
| `removeVehicle` | [manager/page.tsx:2039](app/manager/page.tsx#L2039) | manager-initiated **DEACTIVATE**, missing `status='deactivated'` — inconsistent with `deactivateVehicleCrm` |
| `trimDepartedResidentVehicles` (B166) | [manager-crm-writes.ts:117-118](app/lib/manager-crm-writes.ts#L117-L118) | system cascade |
| `cascadeVehiclesIfUnitVacant` (B150) | [manager/page.tsx:2529](app/manager/page.tsx#L2529) | system cascade |
| admin property cascade | [admin/page.tsx:482](app/admin/page.tsx#L482) | system cascade |
| admin add-resident rollback | [admin/page.tsx:643](app/admin/page.tsx#L643) | system rollback |
| CA add-resident rollback | [company_admin/page.tsx:1847](app/company_admin/page.tsx#L1847) | system rollback |

## 🔴 Fix direction: READ SIDE, not write side

**The tempting fix is wrong.** "Make every write-site touch `status` too" produces a new divergence in the opposite direction: [admin/page.tsx:512](app/admin/page.tsx#L512) reactivates a property by setting `is_active=true` without restoring `status`. If the cascade had written `status='deactivated'`, reactivation would restore `is_active` and leave `status='deactivated'` behind — enforcement would authorize a car the portal shows as deactivated. And the cascade cannot restore the pre-deactivation `status` without remembering what it was.

**The cascades are correct** to write only `is_active`. It's the reversible field; `status` is not.

**The defect is on the read side.** `countVehicles` at [pm-crm.ts:383-391](app/lib/pm-crm.ts#L383-L391) reads `status` alone, and every CRM badge, subtab, and the "Approved permits" tile derive from it. That's what shows a manager an approved car that won't scan.

**Fix scope (Mateo lock 2026-08-04):**
- Change `countVehicles` to filter on `is_active=TRUE` (matches enforcement, matches `get_unit_occupancy_summaries` shipped 2026-08-04)
- Retire the joint predicate `is_active AND status='active'` in favor of `is_active` alone across CRM reads and billing meter (or reconcile in one pass)
- One read-side change closes all six generators. Six write-side fixes would manufacture the opposite divergence.

**Exception:** `removeVehicle` (B2) IS a real bug — it's manager-initiated + permanent, so it should match `deactivateVehicleCrm` (B1) which writes both fields. B2 gets folded into the deactivation-consolidation commit (2026-08-04 preflight Commit 0).

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

## Scope options (updated 2026-08-04)

**A. Data hygiene only.** UPDATE the 8 rows to align `status` with `is_active`. Recovers current display; new divergent rows still generated by every subsequent cascade. Cheapest, doesn't prevent recurrence.

**~~B. Fix the writer.~~ REJECTED** — would produce the opposite divergence at reactivation (see "Fix direction" above).

**C. Invariant enforcement.** Add a trigger on `vehicles` that keeps `status` and `is_active` mutually consistent per the state machine. Would ALSO produce the reactivation divergence (trigger fires on any UPDATE, including the is_active=true restore) unless the trigger knows the pre-deactivation status — which requires either an extra column or a lookup path we don't have. Same class of unwanted side effect as B.

**D. Predicate reconciliation on the READ side.** Change `countVehicles` and the CRM read paths derived from it to filter on `is_active=TRUE` — matches enforcement (`check_resident_plate`), matches `get_unit_occupancy_summaries` (shipped 2026-08-04), and closes all six generator sites in a single commit. Billing meter (`countActiveRecords.permits`) uses the joint predicate today for a legitimate accounting reason (approved-and-active = the billed set); the joint stays or moves to `is_active=TRUE` after a Stripe-side impact review.

**Recommendation: A + D in one commit.** A backfills the current 8 divergent rows to `status='deactivated'` (matches enforcement's view + matches the display the manager will see after D). D changes the read-side to enforcement-truth going forward. B2 (real bug, manager-initiated + permanent) is a separate concern already scheduled for the deactivation-consolidation commit.

## Adjacent finding — this build does NOT worsen it

`get_unit_occupancy_summaries` (shipped 2026-08-04) uses `is_active=TRUE` — matches enforcement. Its count for a Green Acres property will show 59 while the "Approved permits" tile shows 66 — **two numbers on the same screen, seven apart**. That is not a reason to change the predicate; ours is the number that describes reality. The tile is the one that's wrong, and this backlog item is the fix.

## Related

- FOR_MATEO_unit_occupancy_preflight_aug4_2026 (Part A three-predicate table)
- CURRENT_STATE `vehicles.status` vs `is_active` mirror note
- [pattern_enforcement_matches_on_plate_alone.md](../../.claude/projects/-Users-ALC-a1-parking/memory/pattern_enforcement_matches_on_plate_alone.md) — standing pattern that enforcement predicates are load-bearing
