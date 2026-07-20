# Backlog — `pm_plate_lookup` vehicles branches (139/156) determinism

**Filed:** 2026-07-20 during `pm_plate_lookup` hardening (Fix 1 + Fix 2 for
the visitor_passes branch + property-match safety across all 5 branches).

## The assumption

`pm_plate_lookup` at
[migrations/20260708_b230_pm_plate_lookup_pending_states.sql:135-157](../../migrations/20260708_b230_pm_plate_lookup_pending_states.sql#L135-L157)
has two `SELECT ... FROM vehicles ... LIMIT 1` blocks with **no `ORDER BY`**:

- Line 139 — active vehicle match (`v.is_active = TRUE`)
- Line 156 — expired/pending vehicle match (`v.is_active = FALSE AND v.status = 'pending'`)

Both rely on the implicit assumption that **there is at most one active
vehicle per (plate, property)** — so `LIMIT 1` is unambiguous and no
`ORDER BY` is needed to disambiguate.

## When the assumption breaks

For a manager assigned to **multiple properties**, the same plate registered
at two of those properties returns an arbitrary row. Same wrongful-tow class
as the B224 visitor_passes bug fixed by `57a9160`, different trigger:

- **Visitor passes:** duplicates arise from visitor re-registration behavior
  (common, closed by 57a9160 read + the later hardening this file follows).
- **Vehicles:** duplicates require the same plate to be registered as an
  active resident vehicle at two of one manager's properties. Requires two
  properties (multi-property PM) + two active resident registrations for
  the same plate at both. Almost certainly non-existent in practice.

## Why NOT fixed in the current hardening commit

- The threat is genuinely rarer than the visitor-pass class — this is
  registered-vehicle data, not walk-in-visitor data. Two active
  registrations for the same plate at two properties in one company would
  be a data-quality anomaly worth investigating on its own before
  papering over.
- The `pm_plate_lookup` hardening commit was scoped to the two Mateo-named
  fixes (visitor_passes determinism + property-match safety across all
  branches). Expanding to also fix the vehicles-branch class would grow
  the diff without a demonstrated live incident.
- File the assumption so future work knows it's implicit rather than
  intentional — that's this doc's job.

## The fix, when opened

Add explicit `ORDER BY v.created_at DESC` (or `v.id DESC` — either
deterministic tiebreaker) to both branches:

```sql
-- Active match (line 135 approximate)
SELECT v.unit INTO v_vehicle_unit
FROM vehicles v
WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
  AND v.is_active = TRUE
  AND lower(trim(v.property)) = ANY (v_properties_normalized)  -- Fix 2 shape
ORDER BY v.created_at DESC   -- NEW: deterministic tiebreaker
LIMIT 1;
```

Same shape for the expired branch, same ordering.

## Priority

**Low.** File and forget until:
- (a) A duplicate-vehicle-across-properties incident surfaces on a live
  customer, OR
- (b) The FK migration retires the whole `.property`-name-keyed pattern
  and this becomes a no-op.

Whichever comes first.

## Cross-references

- `pm_plate_lookup` hardening commit (visitor_passes determinism + all-5
  property-match safety) — filed once shipped
- B224 driver read-side fix (`57a9160`) — same class on visitor_passes,
  different surface
- `project_fk_property_id_migration` — the structural close that retires
  this whole pattern
