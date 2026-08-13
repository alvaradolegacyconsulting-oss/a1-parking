-- ══════════════════════════════════════════════════════════════════════
-- 20260813_vehicles_property_not_null_and_nonblank.sql
--
-- Mateo Aug 13 constraint 2a — GREENLIT after writer audit + data check.
--
-- Closes the vehicles.property NULL-scope-gate bypass class at the
-- schema level. The 20260809 deactivate_vehicle + approve_vehicle
-- hardening added function-body guards; this constraint kills the
-- reachability of NULL-property rows entirely, so the guards become
-- unreachable defense-in-depth (and the malformed-anchor branch in
-- the notify-vehicle-deactivation route can be deleted in a
-- follow-up commit).
--
-- DATA PRECONDITIONS (Jose 2026-08-13):
--   - vehicles row count: 207
--   - rows with NULL property:   0
--   - rows with blank property:  0
--
-- WRITER AUDIT (2026-08-13):
--   Every live writer supplies non-null property:
--     - request_my_vehicle RPC: explicit IF v_property IS NULL RAISE
--     - manager Add Vehicle / Add Resident: manager.name
--     - /register companion route + CA bulk-invite: derived from
--       server-side residents/CSV row data (soft-flag only — would
--       DB-error hard if upstream ever ships NULL, no silent bypass)
--     - seed / dev-only: hardcoded literals
--   No trigger writes to vehicles. Direct resident INSERT RLS policy
--   was dropped in 20260617 — residents write only via
--   request_my_vehicle (which has the RAISE guard).
--
-- TWO CONSTRAINTS APPLIED (both live in the same commit — same
-- writers, same failure surface, cleaner atomic apply):
--
--   1. `SET NOT NULL` on public.vehicles.property
--      Blocks NULL, which was the D-8 exploit vector.
--
--   2. `CHECK (length(trim(property)) > 0)` — companion
--      SET NOT NULL does not block empty-string. The D-9 gate treats
--      blank as equally bad as NULL (same v_in_scope=NULL bypass on
--      the `lower(trim(NULL)) IN (...)` path collapses when trim is
--      empty too — actually returns FALSE for empty, but the
--      Layer-1 guard in the RPC explicitly rejects both). Adding this
--      makes both classes structurally unreachable, closing the
--      full RPC guard's condition at the schema level.
--
-- ACCESS EXCLUSIVE LOCK WINDOW: negligible at 207 rows. Not
-- streamed / not concurrent — the ALTER is fine to run inline.
--
-- ROLLBACK: separate migration reversing both (drop CHECK, drop
-- NOT NULL). Not scripted here — production is expected to hold
-- these constraints permanently.
--
-- APPLY: Test Legacy first via SQL Editor, verify with the paired
-- verification (v2 returns-rows pattern), then production.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- Layer 1 — NOT NULL
ALTER TABLE public.vehicles
  ALTER COLUMN property SET NOT NULL;

-- Layer 2 — non-blank companion CHECK
ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_property_nonblank
  CHECK (length(trim(property)) > 0);

COMMENT ON CONSTRAINT vehicles_property_nonblank ON public.vehicles IS
  '2026-08-13 Mateo Aug 13 constraint 2a companion. Kills empty-string bypass of the SET NOT NULL applied in the same migration. Together they make NULL-or-blank vehicles.property structurally unreachable, retiring the D-8 (NULL) and D-9 (blank) exploit vectors at the schema level. Function-body guards in approve_vehicle / deactivate_vehicle (20260809 Layer 1) become unreachable defense-in-depth. Notify-vehicle-deactivation route malformed-anchor branch will be deleted in a follow-up commit.';

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_VEHICLES_PROPERTY_NOT_NULL_AND_NONBLANK',
  'public.vehicles',
  'property',
  jsonb_build_object(
    'migration',        '20260813_vehicles_property_not_null_and_nonblank',
    'constraint_1',     'ALTER COLUMN property SET NOT NULL',
    'constraint_2',     'CHECK (length(trim(property)) > 0) [vehicles_property_nonblank]',
    'root_cause',       'NULL/blank property propagated through DEFINER RPC scope gates (D-8, D-9)',
    'data_preconds',    jsonb_build_object(
      'row_count',      207,
      'null_property',  0,
      'blank_property', 0
    ),
    'audited_by',       'writer audit + data check (Mateo Aug 13)'
  )
);

COMMIT;
