-- ══════════════════════════════════════════════════════════════════════
-- 20260803_violation_snapshot_verification.sql
-- POST-APPLY: assert the pass-snapshot migration landed correctly.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260803_violation_snapshot.sql. Paste WHOLE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.PARENT_COLUMNS ─────────────────────────────────────────────────
DO $$
DECLARE
  v_has_scanned_at   boolean;
  v_has_headline     boolean;
  v_has_snap_status  boolean;
BEGIN
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='scanned_at'),
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='headline_status_at_scan'),
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='violations' AND column_name='snapshot_status')
  INTO v_has_scanned_at, v_has_headline, v_has_snap_status;
  IF NOT v_has_scanned_at THEN RAISE EXCEPTION 'VQ.PARENT_COLUMNS: violations.scanned_at MISSING'; END IF;
  IF NOT v_has_headline THEN RAISE EXCEPTION 'VQ.PARENT_COLUMNS: violations.headline_status_at_scan MISSING'; END IF;
  IF NOT v_has_snap_status THEN RAISE EXCEPTION 'VQ.PARENT_COLUMNS: violations.snapshot_status MISSING'; END IF;
END $$;

-- ── VQ.SNAPSHOT_STATUS_CHECK ──────────────────────────────────────────
-- Constraint must reject unknown snapshot_status values.
DO $$
DECLARE
  v_raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.violations (plate, violation_type, property, snapshot_status, is_confirmed)
    VALUES ('_VQTEST_SS_', 'fire_lane', '__vq_probe__', 'bogus_value', false);
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'VQ.SNAPSHOT_STATUS_CHECK: expected check_violation on bogus snapshot_status; insert succeeded';
  END IF;
END $$;

-- ── VQ.CHILD_TABLE_EXISTS ─────────────────────────────────────────────
DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='violation_context_records')
    INTO v_exists;
  IF NOT v_exists THEN RAISE EXCEPTION 'VQ.CHILD_TABLE_EXISTS: violation_context_records MISSING'; END IF;
END $$;

-- ── VQ.CHILD_FK_CASCADE ───────────────────────────────────────────────
-- FK must be ON DELETE CASCADE so child rows drop with parent.
DO $$
DECLARE
  v_confdeltype char;
BEGIN
  SELECT confdeltype INTO v_confdeltype
  FROM pg_constraint
  WHERE conrelid = 'public.violation_context_records'::regclass
    AND contype = 'f'
    AND conname LIKE '%violation_id%';
  IF v_confdeltype IS NULL THEN
    RAISE EXCEPTION 'VQ.CHILD_FK_CASCADE: FK on violation_id NOT FOUND';
  END IF;
  IF v_confdeltype <> 'c' THEN
    RAISE EXCEPTION 'VQ.CHILD_FK_CASCADE: FK on violation_id has confdeltype=% (expected c/CASCADE)', v_confdeltype;
  END IF;
END $$;

-- ── VQ.CHILD_RECORD_TYPE_CHECK ────────────────────────────────────────
-- CHECK must reject unknown record_type values.
DO $$
DECLARE
  v_test_violation_id INT;
  v_raised boolean := false;
BEGIN
  INSERT INTO public.violations (plate, violation_type, property, is_confirmed)
  VALUES ('_VQTEST_RT_', 'fire_lane', '__vq_probe__', false)
  RETURNING id INTO v_test_violation_id;

  BEGIN
    INSERT INTO public.violation_context_records
      (violation_id, record_type, was_live_at_scan)
    VALUES (v_test_violation_id, 'bogus_type', true);
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'VQ.CHILD_RECORD_TYPE_CHECK: expected check_violation on bogus record_type; insert succeeded';
  END IF;
END $$;

-- ── VQ.RPC_EXISTS ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'driver_create_violation_with_snapshot'
      AND pronamespace = 'public'::regnamespace
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: driver_create_violation_with_snapshot NOT FOUND';
  END IF;
END $$;

-- ── VQ.RPC_GRANTS ─────────────────────────────────────────────────────
-- authenticated must have EXECUTE; anon must NOT (per revoke-on-anon
-- discipline).
DO $$
DECLARE
  v_has_authenticated boolean;
  v_has_anon          boolean;
BEGIN
  SELECT
    has_function_privilege('authenticated', 'public.driver_create_violation_with_snapshot(jsonb,jsonb)', 'EXECUTE'),
    has_function_privilege('anon',          'public.driver_create_violation_with_snapshot(jsonb,jsonb)', 'EXECUTE')
  INTO v_has_authenticated, v_has_anon;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: authenticated MISSING EXECUTE on driver_create_violation_with_snapshot';
  END IF;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: anon HAS EXECUTE on driver_create_violation_with_snapshot (per revoke-anon discipline, must be revoked)';
  END IF;
END $$;

-- ── VQ.CHILD_TABLE_RLS_ENABLED ────────────────────────────────────────
DO $$
DECLARE
  v_rls_enabled boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls_enabled
  FROM pg_class WHERE oid = 'public.violation_context_records'::regclass;
  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION 'VQ.CHILD_TABLE_RLS_ENABLED: RLS NOT ENABLED on violation_context_records';
  END IF;
END $$;

-- ── VQ.CHILD_TABLE_ANON_REVOKED ───────────────────────────────────────
-- anon must have NO privileges on the table (defense in depth even
-- with RLS enabled).
DO $$
DECLARE
  v_has_select boolean;
BEGIN
  SELECT has_table_privilege('anon', 'public.violation_context_records', 'SELECT')
    INTO v_has_select;
  IF v_has_select THEN
    RAISE EXCEPTION 'VQ.CHILD_TABLE_ANON_REVOKED: anon HAS SELECT on violation_context_records — must be revoked';
  END IF;
END $$;

-- ── VQ.NO_PII_COLUMNS ─────────────────────────────────────────────────
-- Guard against a future migration adding PII columns to the child
-- table (visitor_name, vehicle_*, visiting_unit, resident_email,
-- non_resident_reason — all excluded by B225 discipline).
DO $$
DECLARE
  v_pii_cols text[];
BEGIN
  SELECT array_agg(column_name)
    INTO v_pii_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='violation_context_records'
    AND column_name IN (
      'visitor_name', 'guest_name', 'vehicle_make', 'vehicle_model',
      'vehicle_color', 'vehicle_year', 'visiting_unit', 'resident_email',
      'phone', 'notes', 'non_resident_reason'
    );
  IF v_pii_cols IS NOT NULL AND array_length(v_pii_cols, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.NO_PII_COLUMNS: violation_context_records has PII columns: %', array_to_string(v_pii_cols, ', ');
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
