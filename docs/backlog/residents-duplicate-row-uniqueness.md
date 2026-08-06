# Backlog — `residents` table has no email-uniqueness constraint

**Filed:** 2026-08-04 during unit-occupancy preflight (FOR MATEO thread).
**Priority:** MEDIUM. Real duplicate exists in prod today; consumers must dedup defensively until this closes.

## Observation

Jose's 2026-08-04 vehicles probe surfaced a LEFT JOIN fan-out on Green Acres `Apt 136`:
**two `residents` rows for `natalielop08@gmail.com`, one `is_active=TRUE` and one `is_active=FALSE`.**

The 2026-07-04 `UNIQUE(lower(email))` index (`user_roles_lower_email_uidx`) is on `user_roles` — **it does not protect `residents`.** No CHECK, UNIQUE, or trigger on `residents.email` prevents this state.

## 🔴 Live instance surfaced 2026-08-05 — resident 690 at Green Acres

The deactivation-cascade orphan diagnostic (2026-08-05, `20260805_deactivation_cascade_orphan_diagnostic.sql`) returned ONE row:

- Resident **690** — `natalielop08@gmail.com`, Natalie, at Green Acres (LIVE ENFORCEMENT)
- `residents.is_active = TRUE` (surviving row at unit `136`)
- Both vehicles `HBK8088` and `WFY2571` under this email at Green Acres have `is_active = FALSE`
- **Both plates scan unauthorized while the CRM shows her as an active resident with vehicles**

Root cause: this issue and [unit-value-normalization-green-acres.md](./unit-value-normalization-green-acres.md) **firing jointly**. Natalie has two residents rows — one at unit `136` (surviving active), one at `Apt 136` (deactivated). Her vehicles were registered under the `Apt 136` spelling. `trimDepartedResidentVehicles` matches on (email, property, unit) — so deactivating the duplicate at `Apt 136` trimmed the vehicles at that unit-string. The cascade did exactly what it was told; both this defect and the unit-value defect had to be present for the harm to land. Neither alone is sufficient.

Jose is reconciling with A1 and restoring the vehicles in the meantime — wrongly authorizing is recoverable; wrongly towing is a Chapter 2308 record.

## Two questions to settle before scoping the fix

**1. Is it a duplicate, or is it the collision with the unit-normalization item?**

If the two rows sit at `[136]` and `[Apt 136]`, then the "duplicate" is actually one row per unit-spelling and closes when [unit-value-normalization-green-acres.md](./unit-value-normalization-green-acres.md) resolves. If both rows sit at the same unit key, it's a genuine duplicate independent of the normalization work.

**Query for Jose:**
```sql
SELECT id, email, property, unit, status, is_active, created_at
FROM public.residents
WHERE lower(email) = 'natalielop08@gmail.com'
ORDER BY created_at;
```

**2. Is it isolated or a pattern?**

```sql
SELECT lower(email) AS lowered_email, property,
       COUNT(*) AS dup_count,
       array_agg(id ORDER BY created_at)         AS ids,
       array_agg(status ORDER BY created_at)     AS statuses,
       array_agg(is_active ORDER BY created_at)  AS actives
FROM public.residents
WHERE email IS NOT NULL
GROUP BY lower(email), property
HAVING COUNT(*) > 1
ORDER BY dup_count DESC, lowered_email;
```

Zero rows → isolated data-entry incident, closes with a targeted UPDATE. Non-zero → pattern.

## What consumers must do until this closes

**Dedup by `lower(email)` defensively at read time.** The 2026-08-04 `get_unit_occupancy_summaries` RPC ships with this dedup baked in (`DISTINCT ON (lower(r.email))` on the residents array + `COUNT(DISTINCT lower(r.email))` on the total). Any new consumer that reads `residents` and does per-email aggregation must do the same until the uniqueness constraint lands.

`countVehicles` and `residentsPerUnit` map ([pm-crm.ts:243-246](app/lib/pm-crm.ts#L243-L246)) — audit for the same class before this closes.

## Fix options

**A. Data-only.** Identify duplicates via the pattern query above; UPDATE-then-DELETE (keep the most recent `is_active=TRUE` row; delete the rest). Recovers current data but doesn't prevent recurrence.

**B. Fix + constraint.** A + `CREATE UNIQUE INDEX residents_lower_email_uidx ON residents (lower(email))`. Same pattern as `20260704_user_roles_unique_lower_email` — including the fail-closed semantic (index create fails with 23505 if duplicates remain, surfacing the missed dedup loudly). Precedent + gates identical.

**C. Fix + partitioned constraint.** Maybe residents can legitimately have multiple rows if scoped to different properties (a person renting units at two properties)? If so, the unique index is on `(lower(email), property)`, not `lower(email)` alone. Requires product decision.

**Recommendation:** B if same-email-across-properties is disallowed by product; C if it's allowed. Jose's second query above decides which by revealing the shape.

## Data-shape prerequisite for C

If C is on the table, need to know whether cross-property duplicates are legitimate:

```sql
SELECT lower(email) AS lowered_email,
       array_agg(DISTINCT property) AS properties,
       COUNT(*)                     AS row_count
FROM public.residents
WHERE email IS NOT NULL
GROUP BY lower(email)
HAVING COUNT(DISTINCT property) > 1
ORDER BY row_count DESC;
```

Any row = a person on multiple properties — needs product to say "legitimate multi-property tenant" vs "should never happen."

## Adjacent

- [20260704_user_roles_unique_lower_email.sql](../../migrations/20260704_user_roles_unique_lower_email.sql) — precedent for the constraint
- [migrations/20260804_get_unit_occupancy_summaries.sql](../../migrations/20260804_get_unit_occupancy_summaries.sql) — first consumer to dedup defensively
- [unit-value-normalization-green-acres.md](./unit-value-normalization-green-acres.md) — related; may share resolution
