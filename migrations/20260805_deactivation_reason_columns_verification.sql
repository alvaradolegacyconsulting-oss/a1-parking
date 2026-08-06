-- ══════════════════════════════════════════════════════════════════════
-- 20260805_deactivation_reason_columns_verification.sql
-- POST-APPLY: 4 columns on residents + 4 on vehicles, correct types,
-- nullable, no CHECK constraint on reason, COMMENT ON present.
-- BEGIN…COMMIT wrap. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260805_deactivation_reason_columns.sql. Paste WHOLE.
-- Inspection only. No probe rows.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.COLUMNS_ADDED ─────────────────────────────────────────────────
-- 8 columns total across 2 tables. Correct types (TEXT + TIMESTAMPTZ).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (
       (table_name = 'residents' AND column_name IN ('deactivation_reason','deactivation_note','deactivated_by','deactivated_at'))
     OR
       (table_name = 'vehicles'  AND column_name IN ('deactivation_reason','deactivation_note','deactivated_by','deactivated_at'))
     );
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'VQ.COLUMNS_ADDED: expected 8 columns total (4 residents + 4 vehicles); found %', v_count;
  END IF;
END $$;

-- ── VQ.COLUMN_TYPES ──────────────────────────────────────────────────
-- reason/note/by = TEXT; at = TIMESTAMPTZ.
DO $$
DECLARE
  r record;
  v_bad text;
BEGIN
  FOR r IN
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('residents','vehicles')
       AND column_name IN ('deactivation_reason','deactivation_note','deactivated_by','deactivated_at')
  LOOP
    IF r.column_name = 'deactivated_at' AND r.data_type <> 'timestamp with time zone' THEN
      v_bad := format('%I.%I is %s (expected timestamp with time zone)', r.table_name, r.column_name, r.data_type);
      RAISE EXCEPTION 'VQ.COLUMN_TYPES: %', v_bad;
    ELSIF r.column_name IN ('deactivation_reason','deactivation_note','deactivated_by') AND r.data_type <> 'text' THEN
      v_bad := format('%I.%I is %s (expected text)', r.table_name, r.column_name, r.data_type);
      RAISE EXCEPTION 'VQ.COLUMN_TYPES: %', v_bad;
    END IF;
  END LOOP;
END $$;

-- ── VQ.NO_NOT_NULL ───────────────────────────────────────────────────
-- All 8 columns must be nullable. NOT NULL DEFAULT would destroy the
-- "NULL-as-signal" regression detector — see migration header.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('residents','vehicles')
       AND column_name IN ('deactivation_reason','deactivation_note','deactivated_by','deactivated_at')
  LOOP
    IF r.is_nullable <> 'YES' THEN
      RAISE EXCEPTION 'VQ.NO_NOT_NULL: %.% is NOT NULL (must be nullable — NULL-on-post-migration-row is the bypass detector)', r.table_name, r.column_name;
    END IF;
  END LOOP;
END $$;

-- ── VQ.NO_DEFAULT ────────────────────────────────────────────────────
-- All 4 reason/note/by/at columns must have NO default. A default
-- would silently populate on rows the write helper bypassed, which is
-- exactly the signal we want to preserve.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name, column_name, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('residents','vehicles')
       AND column_name IN ('deactivation_reason','deactivation_note','deactivated_by','deactivated_at')
  LOOP
    IF r.column_default IS NOT NULL THEN
      RAISE EXCEPTION 'VQ.NO_DEFAULT: %.% has DEFAULT % (must be NULL — see NULL-as-signal in migration header)',
        r.table_name, r.column_name, r.column_default;
    END IF;
  END LOOP;
END $$;

-- ── VQ.NO_CHECK_ON_REASON ────────────────────────────────────────────
-- Deliberate: TS module owns the code list. A SQL CHECK would
-- duplicate it and produce tier-config-style drift. If a future
-- migration adds a CHECK on deactivation_reason, this VQ fires.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
    JOIN pg_attribute  a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
   WHERE n.nspname = 'public'
     AND t.relname IN ('residents','vehicles')
     AND a.attname = 'deactivation_reason'
     AND c.contype = 'c';   -- CHECK
  IF v_count > 0 THEN
    RAISE EXCEPTION 'VQ.NO_CHECK_ON_REASON: unexpected CHECK constraint on deactivation_reason (% found). TS module owns the code list — a SQL CHECK duplicates the list and produces tier-config-style drift.', v_count;
  END IF;
END $$;

-- ── VQ.COMMENT_ON_PRESENT ────────────────────────────────────────────
-- Each of the 8 columns must have a COMMENT ON. Comments are where
-- the "why" lives — see migration header for what they should record.
DO $$
DECLARE
  r record;
  v_comment text;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['residents','residents','residents','residents','vehicles','vehicles','vehicles','vehicles']) AS tbl,
           unnest(ARRAY['deactivation_reason','deactivation_note','deactivated_by','deactivated_at',
                        'deactivation_reason','deactivation_note','deactivated_by','deactivated_at']) AS col
  LOOP
    SELECT col_description((r.tbl)::regclass, ordinal_position)
      INTO v_comment
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = r.tbl
       AND column_name = r.col;
    IF v_comment IS NULL OR length(v_comment) < 20 THEN
      RAISE EXCEPTION 'VQ.COMMENT_ON_PRESENT: %.% missing COMMENT ON (or truncated)', r.tbl, r.col;
    END IF;
  END LOOP;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ──────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DEACTIVATION_REASON_COLUMNS'
     AND new_values->>'migration' = '20260805_deactivation_reason_columns';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

COMMIT;
