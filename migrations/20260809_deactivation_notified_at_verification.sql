-- ══════════════════════════════════════════════════════════════════════
-- 20260809_deactivation_notified_at_verification.sql
-- POST-APPLY: columns exist on both tables, nullable, no default, no
-- CHECK constraint, correct type. COMMENT ON present on both.
-- SCHEMA_ audit row present.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260809_deactivation_notified_at.sql. Paste WHOLE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RESIDENTS_COLUMN_SHAPE ────────────────────────────────────────
DO $$
DECLARE
  v_data_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_data_type, v_is_nullable, v_column_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'residents'
     AND column_name  = 'deactivation_notified_at';
  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'VQ.RESIDENTS_COLUMN_SHAPE: column missing on residents';
  END IF;
  IF v_data_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'VQ.RESIDENTS_COLUMN_SHAPE: expected TIMESTAMPTZ; got %', v_data_type;
  END IF;
  IF v_is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VQ.RESIDENTS_COLUMN_SHAPE: expected nullable; got is_nullable=%', v_is_nullable;
  END IF;
  IF v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.RESIDENTS_COLUMN_SHAPE: expected no DEFAULT; got %', v_column_default;
  END IF;
END $$;

-- ── VQ.VEHICLES_COLUMN_SHAPE ─────────────────────────────────────────
DO $$
DECLARE
  v_data_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_data_type, v_is_nullable, v_column_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'vehicles'
     AND column_name  = 'deactivation_notified_at';
  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'VQ.VEHICLES_COLUMN_SHAPE: column missing on vehicles';
  END IF;
  IF v_data_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'VQ.VEHICLES_COLUMN_SHAPE: expected TIMESTAMPTZ; got %', v_data_type;
  END IF;
  IF v_is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VQ.VEHICLES_COLUMN_SHAPE: expected nullable; got is_nullable=%', v_is_nullable;
  END IF;
  IF v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.VEHICLES_COLUMN_SHAPE: expected no DEFAULT; got %', v_column_default;
  END IF;
END $$;

-- ── VQ.NO_CHECK_CONSTRAINTS_ON_NEW_COLUMNS ───────────────────────────
-- The migration explicitly forbids a CHECK against deactivated_at
-- (the dedup semantic needs both directions of the comparison).
-- Guard against a future migration adding one silently.
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu USING (constraint_name, constraint_schema)
   WHERE ccu.table_schema = 'public'
     AND ccu.table_name IN ('residents', 'vehicles')
     AND ccu.column_name = 'deactivation_notified_at';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'VQ.NO_CHECK_CONSTRAINTS_ON_NEW_COLUMNS: found % CHECK constraint(s) on deactivation_notified_at; the dedup predicate requires unconstrained ordering', v_count;
  END IF;
END $$;

-- ── VQ.COMMENTS_PRESENT ──────────────────────────────────────────────
-- COMMENT ON is the durable spec for the dedup predicate + the
-- three-cars-one-email-doesn't-need-this note. Fail loudly if either
-- comment is missing.
DO $$
DECLARE
  v_residents_comment TEXT;
  v_vehicles_comment  TEXT;
BEGIN
  SELECT col_description(c.oid, a.attnum) INTO v_residents_comment
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'residents'
     AND a.attname = 'deactivation_notified_at';
  IF v_residents_comment IS NULL OR length(v_residents_comment) < 50 THEN
    RAISE EXCEPTION 'VQ.COMMENTS_PRESENT: residents.deactivation_notified_at COMMENT missing or truncated (len=%)', COALESCE(length(v_residents_comment), 0);
  END IF;

  SELECT col_description(c.oid, a.attnum) INTO v_vehicles_comment
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicles'
     AND a.attname = 'deactivation_notified_at';
  IF v_vehicles_comment IS NULL OR length(v_vehicles_comment) < 50 THEN
    RAISE EXCEPTION 'VQ.COMMENTS_PRESENT: vehicles.deactivation_notified_at COMMENT missing or truncated (len=%)', COALESCE(length(v_vehicles_comment), 0);
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ──────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_ADD_DEACTIVATION_NOTIFIED_AT'
     AND new_values->>'migration' = '20260809_deactivation_notified_at';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- ── VQ.ZERO_ROWS_POPULATED ───────────────────────────────────────────
-- Additive migration; every existing row's deactivation_notified_at
-- must be NULL. If any row is populated, either the migration was
-- re-run destructively or something wrote before Commit C landed.
DO $$
DECLARE
  v_residents_populated INT;
  v_vehicles_populated  INT;
BEGIN
  SELECT COUNT(*) INTO v_residents_populated
    FROM public.residents
   WHERE deactivation_notified_at IS NOT NULL;
  IF v_residents_populated > 0 THEN
    RAISE EXCEPTION 'VQ.ZERO_ROWS_POPULATED: expected 0 residents with deactivation_notified_at set; got %', v_residents_populated;
  END IF;

  SELECT COUNT(*) INTO v_vehicles_populated
    FROM public.vehicles
   WHERE deactivation_notified_at IS NOT NULL;
  IF v_vehicles_populated > 0 THEN
    RAISE EXCEPTION 'VQ.ZERO_ROWS_POPULATED: expected 0 vehicles with deactivation_notified_at set; got %', v_vehicles_populated;
  END IF;
END $$;

COMMIT;
