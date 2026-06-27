-- Verification queries for stripe_prices 3-tier + per_permit migration.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (proves pre-state: table populated,
--      6-value tier_name CHECK, no per_permit value valid, no
--      price_model column)
--   2. Apply 20260626_stripe_prices_3tier_per_permit.sql (single paste)
--   3. Sections B–F post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: new constraints + dropped/replaced constraints present in
--        correct form (catches a partial-apply or wrong-quotes paste)
--   - C: unit_amount_cents nullability flip (required for graduated
--        rows; if NOT NULL persists, catalog script will error on
--        per_permit row inserts)
--   - D: new columns price_model + tiers present with correct types
--        (catches a forgotten ADD COLUMN)
--   - E: BEHAVIORAL — the new permit_pm_only constraint actually
--        rejects a permit-row-on-enforcement-track INSERT. Catches a
--        wrong-direction CHECK clause (line_item = vs <>, OR vs AND).
--   - F: pg_proc row count unchanged (sanity — no functions touched)
--
-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — confirm pre-state before mutation
-- ════════════════════════════════════════════════════════════════════

SELECT
  (SELECT COUNT(*) FROM public.stripe_prices) > 0                                                AS pre_table_has_rows,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.stripe_prices'::regclass
             AND conname='stripe_prices_tier_name_valid'
             AND pg_get_constraintdef(oid) ~ 'starter')                                          AS pre_tier_name_still_6value,
  NOT EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid='public.stripe_prices'::regclass
                 AND conname='stripe_prices_permit_pm_only')                                     AS pre_no_permit_pm_only,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='stripe_prices'
                 AND column_name='price_model')                                                  AS pre_no_price_model,
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stripe_prices'
      AND column_name='unit_amount_cents') = 'NO'                                                AS pre_unit_amount_still_not_null;
-- Expected PRE-APPLY: all 5 TRUE.
-- If pre_table_has_rows = FALSE → table already empty (likely re-run
--   scenario; safe to proceed if other pre-checks still TRUE).
-- If any others FALSE → migration already partially applied; STOP and
--   investigate before re-running.


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — new + dropped constraints present in correct form
-- ════════════════════════════════════════════════════════════════════

SELECT
  -- B.1 tier_name CHECK swapped to 3-value set
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.stripe_prices'::regclass
             AND conname='stripe_prices_tier_name_valid'
             AND pg_get_constraintdef(oid) ~ 'pm_only'
             AND pg_get_constraintdef(oid) ~ 'enforcement_only'
             AND pg_get_constraintdef(oid) ~ 'legacy'
             AND pg_get_constraintdef(oid) !~ 'starter')                                         AS tier_name_now_3value,
  -- B.2 line_item CHECK includes per_permit
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.stripe_prices'::regclass
             AND conname='stripe_prices_line_item_valid'
             AND pg_get_constraintdef(oid) ~ 'per_permit'
             AND pg_get_constraintdef(oid) ~ 'per_driver')                                       AS line_item_has_per_permit_and_per_driver,
  -- B.3 NEW permit_pm_only constraint present
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.stripe_prices'::regclass
             AND conname='stripe_prices_permit_pm_only'
             AND pg_get_constraintdef(oid) ~ 'per_permit'
             AND pg_get_constraintdef(oid) ~ 'property_management')                              AS permit_pm_only_constraint_present,
  -- B.4 driver_enforcement_only SURVIVES (sibling pattern; not touched)
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.stripe_prices'::regclass
             AND conname='stripe_prices_driver_enforcement_only')                                AS driver_enforcement_only_survived,
  -- B.5 2 partial UNIQUEs survive
  EXISTS (SELECT 1 FROM pg_indexes
           WHERE schemaname='public' AND tablename='stripe_prices'
             AND indexname='stripe_prices_unique_combo_standard')                                AS unique_standard_survived,
  EXISTS (SELECT 1 FROM pg_indexes
           WHERE schemaname='public' AND tablename='stripe_prices'
             AND indexname='stripe_prices_unique_combo_proposal')                                AS unique_proposal_survived;
-- Expected: all 6 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — unit_amount_cents nullability flip
-- ════════════════════════════════════════════════════════════════════

SELECT is_nullable
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name='stripe_prices'
   AND column_name='unit_amount_cents';
-- Expected: 'YES' (nullable). If 'NO' persists → graduated row INSERTs
-- in commit 3 will fail with not-null-violation.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — new columns present with correct types
-- ════════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='stripe_prices'
   AND column_name IN ('price_model','tiers')
 ORDER BY column_name;
-- Expected 2 rows:
--   price_model | text  | NO  | 'flat'::text
--   tiers       | jsonb | YES | (null)

-- And the price_model CHECK constraint
SELECT EXISTS (
  SELECT 1 FROM pg_constraint
   WHERE conrelid='public.stripe_prices'::regclass
     AND pg_get_constraintdef(oid) ~ 'price_model'
     AND pg_get_constraintdef(oid) ~ 'flat'
     AND pg_get_constraintdef(oid) ~ 'graduated'
) AS price_model_check_present;
-- Expected: TRUE.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — BEHAVIORAL: permit_pm_only constraint actually fires
-- ════════════════════════════════════════════════════════════════════
-- Attempt to INSERT a per_permit row on the enforcement track. The
-- new constraint must reject it with a check_violation. Wraps the
-- INSERT in BEGIN/EXCEPTION so the rollback is automatic + the
-- assertion captures the SQLSTATE. If the INSERT SUCCEEDS, the
-- constraint clause direction is wrong (e.g., line_item = vs <>);
-- the DO block RAISEs and the assertion fails LOUDLY.

DO $permit_pm_only_test$
DECLARE
  v_caught_error TEXT := NULL;
  v_caught_state TEXT := NULL;
BEGIN
  BEGIN
    INSERT INTO public.stripe_prices (
      stripe_price_id, stripe_product_id,
      tier_track, tier_name, line_item, cycle, mode,
      price_model, tiers
    ) VALUES (
      'test_should_reject', 'prod_test_should_reject',
      'enforcement', 'enforcement_only', 'per_permit', 'monthly', 'test',
      'graduated', '[]'::jsonb
    );
  EXCEPTION
    WHEN check_violation THEN
      v_caught_state := SQLSTATE;
      v_caught_error := SQLERRM;
  END;

  RAISE NOTICE '── Section E — permit_pm_only behavioral test ──';
  RAISE NOTICE '  caught_state = % (expected 23514 = check_violation)', v_caught_state;
  RAISE NOTICE '  caught_error = %', v_caught_error;

  IF v_caught_state IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'Section E FAIL — INSERT of per_permit on enforcement track did NOT raise check_violation (caught_state=%). Constraint direction is wrong.', v_caught_state;
  END IF;
  IF v_caught_error IS NULL OR v_caught_error !~ 'stripe_prices_permit_pm_only' THEN
    RAISE EXCEPTION 'Section E FAIL — check_violation fired but not from stripe_prices_permit_pm_only (got: %). Wrong constraint blocked the INSERT.', v_caught_error;
  END IF;
END;
$permit_pm_only_test$;

-- Leak check — the failed INSERT should have been rolled back by the
-- EXCEPTION sub-block; this confirms no row leaked through.
SELECT COUNT(*) AS leaked_test_rows
  FROM public.stripe_prices
 WHERE stripe_price_id = 'test_should_reject';
-- Expected: 0.


-- ════════════════════════════════════════════════════════════════════
-- F. pg_proc untouched (no functions in this commit)
-- ════════════════════════════════════════════════════════════════════
-- This migration is schema-only — no CREATE FUNCTION / DROP FUNCTION /
-- CREATE OR REPLACE FUNCTION. Sanity-confirm by name-scanning for
-- anything that might collide with billing surfaces touched in later
-- commits (no expected hits today).

SELECT proname
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN (
     'approve_vehicle',           -- commit 4 candidate; should NOT exist yet
     'sync_permit_count'          -- commit 4 candidate; should NOT exist yet
   )
 ORDER BY proname;
-- Expected: 0 rows. If any appear → commit 4 work already partially
-- applied; investigate before commit 4 runs.


-- ════════════════════════════════════════════════════════════════════
-- G. Migration audit row landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE action = 'SCHEMA_TABLE_REBUILT'
   AND new_values->>'migration' = '20260626_stripe_prices_3tier_per_permit'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.
