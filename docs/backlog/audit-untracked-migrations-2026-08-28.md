# AUDIT — Untracked files in `migrations/` (2026-08-28)

**Report only. No commits, no applies.** Per Mateo Aug 28 §3-and-4.
**By:** Claude, 2026-08-28 evening.
**Method:** File-content enumeration + tracked-code cross-reference. Each row includes a Jose query so production is authoritative — repo evidence is inference, `pg_catalog` is truth.

---

## Top-line

**20 untracked files. High-confidence buckets:**

- **APPLIED-UNCOMMITTED × 18** — every migration whose object shows up in tracked-code call-sites (5-45 refs each), plus objects that LATER tracked migrations depend on. Cannot be "never applied" and still have live production features working.
- **DIAGNOSTIC (not a migration) × 2** — read-only preflight/retrospective docs kept alongside a migration. Commit as-is if wanted, but they don't affect production state.
- **NEVER-APPLIED × 0** — none identified. That's what the tree says; Jose queries below are the check.
- **SUPERSEDED × 0** — none identified. Would need a later tracked migration that redefines the same object; I don't see any.

**Recommended action after Jose confirms:** commit the 18 as a single "backfill: untracked migrations confirmed live in prod" commit + the 2 diagnostic files as a separate small commit. No re-apply.

---

## Master Jose query — check all objects at once

Paste in SQL Editor. Every `present_in_prod` should be `true`. Any `false` = investigate that specific migration.

```sql
SELECT 'TABLE  space_requests'              AS object, to_regclass('public.space_requests') IS NOT NULL AS present_in_prod
UNION ALL SELECT 'FN     regenerate_tow_ticket',       EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='regenerate_tow_ticket')
UNION ALL SELECT 'FN     stamp_tow_ticket',            EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='stamp_tow_ticket')
UNION ALL SELECT 'FN     get_enforcement_insights',    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_enforcement_insights')
UNION ALL SELECT 'FN     generate_spaces_from_pool',   EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='generate_spaces_from_pool')
UNION ALL SELECT 'FN     get_unit_occupancy_summaries',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_unit_occupancy_summaries')
UNION ALL SELECT 'FN     current_date_central',        EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='current_date_central')
UNION ALL SELECT 'FN     pm_plate_lookup',             EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='pm_plate_lookup')
UNION ALL SELECT 'IDX    user_roles_lower_email_uidx', EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='user_roles_lower_email_uidx')
UNION ALL SELECT 'COL    user_roles.can_regenerate_tow_ticket', EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='can_regenerate_tow_ticket')
UNION ALL SELECT 'COL    violations.regenerate_reason',         EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='regenerate_reason')
UNION ALL SELECT 'COL    violations.regenerated_from',          EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='regenerated_from')
UNION ALL SELECT 'COL    violations.tow_mileage_fee',           EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='tow_mileage_fee')
UNION ALL SELECT 'COL    violations.vehicle_vin',               EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='vehicle_vin')
ORDER BY object;
```

Optional companion — the SCHEMA_ audit rows each migration writes on apply. If present, that's a second confirmation (though a hand-applied migration might have skipped the audit INSERT, so absence is not proof-of-non-application):

```sql
SELECT action, new_values->>'migration' AS migration, created_at
  FROM public.audit_logs
 WHERE action LIKE 'SCHEMA_%'
   AND new_values->>'migration' IN (
     '20260626_space_requests_v1',
     '20260626_tow_ticket_regenerate_layer_1',
     '20260628_enforcement_insights_layer_4_regen_metric',
     '20260629_violations_mileage_vin_persistence',
     '20260704_user_roles_unique_lower_email',
     '20260711_manager_bulk_add_spaces_extension',
     '20260804_get_unit_occupancy_summaries',
     '20260805_current_date_central_helper',
     '20260805_pm_plate_lookup_current_date_central_sweep'
   )
 ORDER BY created_at;
```

---

## Per-file breakdown

### APPLIED-UNCOMMITTED — high-confidence-live

| # | File | Object(s) created | Evidence — tracked refs |
|---|------|-------------------|--------------------------|
| 1 | `20260626_space_requests_v1.sql` (+ verification) | TABLE `public.space_requests` + 3 indexes + RLS | **19 tracked refs** across app/lib + later migrations |
| 2 | `20260626_tow_ticket_regenerate_layer_1.sql` (+ verification) | FN `regenerate_tow_ticket()`, FN `stamp_tow_ticket()`, COLs `user_roles.can_regenerate_tow_ticket`, `violations.regenerate_reason`, `violations.regenerate_reason_note`, `violations.regenerated_from` FK | 21 refs to regenerate_tow_ticket + 24 to stamp_tow_ticket. LATER tracked migrations (`20260723_dnt_*`, `20260726_six_site_*`) call these functions — they'd fail to load if these definitions didn't exist |
| 3 | `20260628_enforcement_insights_layer_4_regen_metric.sql` (+ verification) | FN `get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)` | 7 tracked refs — powers the CA Enforcement Insights dashboard tiles |
| 4 | `20260629_violations_mileage_vin_persistence.sql` (+ verification) | COLs `violations.tow_mileage_fee`, `violations.vehicle_vin` + updated FN signatures for `stamp_tow_ticket`, `regenerate_tow_ticket` (adds params) | Companion to #2 — signatures with NUMERIC + TEXT extras are what tracked callers pass today |
| 5 | `20260704_user_roles_unique_lower_email.sql` (+ verification) | IDX `user_roles_lower_email_uidx` | 🔴 **CONFIRMED LIVE** by Jose F1 query this morning (Mateo Aug 28 §3) |
| 6 | `20260711_manager_bulk_add_spaces_extension.sql` | FN `generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT)` extended | 12 refs — manager bulk-add-spaces path in manager/page.tsx calls this |
| 7 | `20260804_get_unit_occupancy_summaries.sql` (+ verification) | FN `get_unit_occupancy_summaries(TEXT, TEXT[])` | 9 refs — CA Occupancy tile + manager Occupancy report |
| 8 | `20260805_current_date_central_helper.sql` (+ verification) | FN `current_date_central()` | 2 refs — used by pm_plate_lookup + others |
| 9 | `20260805_pm_plate_lookup_current_date_central_sweep.sql` (+ verification) | FN `pm_plate_lookup(TEXT, TEXT)` rewritten to use current_date_central | **45 tracked refs** — manager Plate Lookup tab, B234 driver plate lookup call |

**Only-file (no verification companion)**: #6 (`manager_bulk_add_spaces_extension`) — an extension of an existing function, so possibly the earlier definition's verification still applies; worth confirming whether a paired verification exists and was just misfiled.

### DIAGNOSTIC — not a migration

| # | File | What it is | Recommendation |
|---|------|-----------|----------------|
| A | `20260805_pm_plate_lookup_current_date_central_sweep_retrospective.sql` | Read-only PRE-APPLY diagnostic for #9 above. "Zero rows is the expected outcome." No side effects. | Commit as-is alongside #9. Docs value. Not a state-changing migration. |
| B | `20260806_no_authorized_vehicle_preflight_diagnostic.sql` | Read-only diagnostic for the "No authorized vehicle" manager panel design (Mateo Aug 6). Populates bucketing decisions. | Commit as-is. Kept alongside the panel's design decisions. Not a migration. |

Neither file has DDL / DML statements — both are diagnostic SELECTs wrapped in comments.

---

## Confidence — what makes this a strong report

**Signals used:**
- **Tracked-code references.** The app/ tree at HEAD calls each of these functions and reads these columns. `npm run build` passes. `tsc --noEmit` passes. If the objects weren't in prod, `pm_plate_lookup` alone (45 tracked refs) would break at every manager-portal load.
- **Downstream-migration dependency.** Later tracked migrations (`20260723_dnt_*`, `20260726_six_site_*`) call functions defined in these untracked ones. Those tracked migrations were applied (per past PASS rows). They'd fail their own migration DO blocks if the untracked prerequisites weren't already live.
- **Explicit Mateo confirmation on one item.** F1 query returned `user_roles_lower_email_uidx` present. Establishes at least one file is provably applied.

**Signals I did NOT rely on** (deliberate):
- File `mtime` — not authoritative; touching a file changes it without proving apply state
- Presence of a `_verification.sql` companion — a verification file existing doesn't prove the pair was applied
- Absence of a `SCHEMA_` audit row — a hand-applied migration might have had its audit INSERT skipped for various reasons, so absence is not proof-of-non-application (audit-row presence IS a signal, but its absence is soft)

**What Jose's master query does:**
Queries `pg_catalog` / `information_schema` / `pg_indexes` directly. If any row returns `present_in_prod=false`, that specific migration is either never-applied OR the object was renamed/dropped after apply. Investigate the specific file, then move it out of `migrations/` (per tonight's standing rule).

---

## After Jose confirms

**Assuming all 14 objects report `present_in_prod=true`** (the expected outcome):

1. Small "backfill" commit — add the 20 files to the tree with a commit message that:
   - Names each file
   - Says "confirmed live in prod via `pg_catalog` sweep 2026-08-XX"
   - Cites Jose's row of results
   - Includes the master query in the commit body for future auditors

2. Filed as its own line: **audit whether other tracked migration files have companion `_verification.sql` files that were never committed** (mirror check). Search: does every `migrations/*_verification.sql` have its `*.sql` pair, and vice versa? A companion-verification-missing situation is the same class of drift.

3. Root cause reflection (not this file): 20 files sitting untracked over 2 months suggests a class-level workflow gap. Worth a two-line addition to CLAUDE.md or AGENTS.md — perhaps a git pre-push hook that flags `migrations/*.sql` present in the working tree but absent from HEAD.

**If any object reports `present_in_prod=false`:**

That specific migration is either never-applied (rare — the build would've broken by now) OR was applied then rolled back or renamed. Report the specific object; do not commit its migration file until the state is understood.
