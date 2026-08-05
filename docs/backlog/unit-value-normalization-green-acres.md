# Backlog — Unit-value normalization at Green Acres

**Filed:** 2026-08-04 during unit-occupancy preflight (FOR MATEO thread).
**Priority:** MEDIUM. Data-hygiene item; has already caused a live blind spot in `get_unit_occupancy_summaries` (2026-08-04).

## Observation

Green Acres has multiple text spellings for what appear to be the same physical units:

- `[136]` and `[Apt 136]` — same unit, different keys
- `[#67]` — will not reconcile with `67` under `lower(trim())`

Surfaced during Jose's 2026-08-04 residents + vehicles probes for the unit-occupancy preflight. Not exhaustive — the collision detector query below should be run to enumerate the full set.

**Two consumers today are affected, and a third is about to arrive:**

1. **`get_unit_occupancy_summaries` (2026-08-04, shipped as-designed).** Matches unit with `lower(trim(...))`. `Apt 136` and `136` are distinct keys — the occupancy flag will show "1 active resident here" when the physical unit has three. **This is a documented fail-open** — the RPC header notes it and does NOT paper over it (a flag firing confidently against the wrong household is worse than no flag). Data hygiene resolves it upstream.

2. **Guest-auth hosting-resident picker** at [manager/page.tsx:4622-4646](app/manager/page.tsx#L4622-L4646). Uses `r.unit === u` — case-sensitive, no trim. Already wrong today for any variant mismatch.

3. Any future per-unit surface. The class recurs each time unit is matched.

## Root cause

`residents.unit` and `vehicles.unit` are free-text `TEXT` columns with no normalization at write time. Managers add residents through forms that pass the unit string through verbatim. Different data-entry conventions (with/without "Apt", with/without leading `#`, with/without trailing zeros) accumulate over time.

No trigger, CHECK constraint, or normalization function exists.

## Detection

**Collision detector (Jose, read-only):**

```sql
-- Residents: units whose "normalized core" has multiple raw spellings
SELECT regexp_replace(lower(trim(unit)), '^(apt|unit|lot|#)[\s.#]*', '') AS unit_core,
       array_agg(DISTINCT unit) AS raw_variants,
       COUNT(DISTINCT unit)     AS variant_count
FROM public.residents
WHERE property ILIKE 'Green Acres' AND unit IS NOT NULL
GROUP BY 1
HAVING COUNT(DISTINCT unit) > 1
ORDER BY variant_count DESC, unit_core;

-- Same, against vehicles
SELECT regexp_replace(lower(trim(unit)), '^(apt|unit|lot|#)[\s.#]*', '') AS unit_core,
       array_agg(DISTINCT unit) AS raw_variants,
       COUNT(DISTINCT unit)     AS variant_count
FROM public.vehicles
WHERE property ILIKE 'Green Acres' AND unit IS NOT NULL
GROUP BY 1
HAVING COUNT(DISTINCT unit) > 1
ORDER BY variant_count DESC, unit_core;
```

Repeat against Test Legacy Property + any other property with >1 resident per unit.

## Fix options

**A. Data-only backfill.** One-time UPDATE to canonicalize the variants (e.g., strip leading `Apt `, `#`, `Unit `; normalize whitespace and case). No code change. Cheapest, targeted at known collisions from the detector.

**B. Fix + block regression.** Backfill + add a `BEFORE INSERT OR UPDATE` trigger on `residents` and `vehicles` that canonicalizes `unit` on write. Prevents new variants. Analogous to `20260715_property_name_trim_triggers` (property-name trim on write). Recommended.

**C. Full normalization.** A `normalize_unit(TEXT)` SQL function that returns a canonical form; all readers pass through it. Overkill unless the normalization becomes complex; B + `lower(trim(...))` in readers is generally sufficient.

**Recommendation:** B. The trigger precedent already exists on property_name; residents/vehicles unit is the missing sibling. Backfill in the same commit against detector output.

## Related

- FOR_MATEO_unit_occupancy_preflight_aug4_2026 (unit-normalization section)
- [migrations/20260804_get_unit_occupancy_summaries.sql](../../migrations/20260804_get_unit_occupancy_summaries.sql) header — UNIT NORMALIZATION LIMIT block
- [migrations/20260715_property_name_trim_triggers.sql](../../migrations/20260715_property_name_trim_triggers.sql) — precedent trigger pattern for the property_name analog
- [feedback_property_name_whitespace_class](../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_property_name_whitespace_class.md) — standing pattern for the property_name analog
