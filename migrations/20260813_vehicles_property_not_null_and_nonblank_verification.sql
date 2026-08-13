-- ══════════════════════════════════════════════════════════════════════
-- 20260813_vehicles_property_not_null_and_nonblank_verification.sql
-- POST-APPLY: both constraints present, both active, schema audit row
-- landed, and (belt-and-braces) zero existing NULL/blank rows survived
-- the ALTER.
--
-- RETURNS-ROWS v2 (no BEGIN/COMMIT wrap). Read-only assertion. Any
-- RAISE aborts the paste with the exception message visible; success
-- returns one PASS row.
--
-- Run AFTER 20260813_vehicles_property_not_null_and_nonblank.sql.
-- Paste WHOLE. Expect: one row
--   `PASS | vehicles.property | {5 gates} | <ts>`.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.NOT_NULL_APPLIED ─────────────────────────────────────────────
DO $$
DECLARE v_is_nullable TEXT;
BEGIN
  SELECT is_nullable INTO v_is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'vehicles'
     AND column_name  = 'property';
  IF v_is_nullable IS NULL THEN
    RAISE EXCEPTION 'VQ.NOT_NULL_APPLIED: column vehicles.property not found';
  END IF;
  IF v_is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'VQ.NOT_NULL_APPLIED: expected NOT NULL; is_nullable = %', v_is_nullable;
  END IF;
END $$;

-- ── VQ.NONBLANK_CHECK_PRESENT ───────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicles'
     AND c.conname = 'vehicles_property_nonblank'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.NONBLANK_CHECK_PRESENT: expected 1 CHECK vehicles_property_nonblank; got %', v_count;
  END IF;
END $$;

-- ── VQ.NONBLANK_CHECK_VALIDATED ─────────────────────────────────────
-- Constraint must be BOTH present AND validated (not NOT VALID).
-- Otherwise it applies to new writes only and past bad rows survive.
DO $$
DECLARE v_convalidated BOOLEAN;
BEGIN
  SELECT c.convalidated INTO v_convalidated
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicles'
     AND c.conname = 'vehicles_property_nonblank';
  IF NOT COALESCE(v_convalidated, false) THEN
    RAISE EXCEPTION 'VQ.NONBLANK_CHECK_VALIDATED: constraint present but NOT VALID; existing rows not covered';
  END IF;
END $$;

-- ── VQ.ZERO_NULL_OR_BLANK_ROWS ──────────────────────────────────────
-- Belt-and-braces sanity check — the ALTER would have failed if any
-- row violated, so this only fires if something goes very sideways.
-- Cheap; run it anyway.
DO $$
DECLARE v_bad_count INT;
BEGIN
  SELECT COUNT(*) INTO v_bad_count
    FROM public.vehicles
   WHERE property IS NULL OR length(trim(property)) = 0;
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'VQ.ZERO_NULL_OR_BLANK_ROWS: expected 0 NULL-or-blank property rows; got %', v_bad_count;
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_VEHICLES_PROPERTY_NOT_NULL_AND_NONBLANK'
     AND new_values->>'migration' = '20260813_vehicles_property_not_null_and_nonblank';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- ── FINAL: return one row on pass ─────────────────────────────────
-- All five DO blocks passed (any RAISE aborts the paste before this
-- SELECT). Visible evidence of pass.
SELECT
  'PASS'::TEXT                                AS status,
  'vehicles.property'::TEXT                   AS target,
  ARRAY[
    'NOT_NULL_APPLIED',
    'NONBLANK_CHECK_PRESENT',
    'NONBLANK_CHECK_VALIDATED',
    'ZERO_NULL_OR_BLANK_ROWS',
    'SCHEMA_AUDIT_ROW'
  ]                                           AS gates_verified,
  now()                                       AS verified_at;
