-- Spaces v1 — CONTRACT PHASE: DROP COLUMN properties.total_spaces
--
-- ORIGIN
--   Closes the expand-contract pattern locked 2026-06-21 (commit 1 ADD +
--   commit 4 reader-rename + 24h Vercel log tail clean). The expand phase
--   left both `total_spaces` and `visitor_capacity` coexisting so the deploy
--   window had no read-NULL risk; commit 4 moved all 18 readers (CA + admin
--   + manager + scripts) to `visitor_capacity` and ships in production with
--   the legacy column still present-but-untouched. This migration drops it.
--
-- SELF-GATING ON DEPENDENCY ENUMERATION (Jose lock 2026-06-22)
--   The repo grep is structurally BLIND to Dashboard-created objects
--   (triggers, views, function bodies, generated columns) that may reference
--   `properties.total_spaces`. The pre-deploy repo grep verified clean
--   (13/13 allowlist match; 0 hits in active code paths). This migration
--   adds the DB-side gate: a DO block enumerates ALL dependent objects via
--   pg_depend + information_schema + pg_proc + pg_trigger + pg_attrdef and
--   RAISES an exception if ANY dependency exists. The exception aborts the
--   transaction, so the ALTER TABLE...DROP COLUMN below NEVER RUNS on a
--   non-empty dependency set. Drop is unreachable if dependencies exist.
--
--   The companion file `20260622_spaces_v1_drop_total_spaces_enumerate.sql`
--   runs the SAME 5 enumeration queries individually (with per-object
--   detail) — useful to run FIRST so Jose sees WHICH objects exist (if any)
--   before the gate fires, rather than just seeing the abort message.
--
-- WHY EACH ENUMERATION SECTION
--   1. pg_depend (filtered to user deptypes 'n'/'e'/'x'; excludes 'a' auto
--      + 'i' internal which are the column's own statistics/itself)
--   2. information_schema.view_column_usage (views referencing the column)
--   3. pg_proc.prosrc word-boundary regex (function/RPC bodies)
--   4. pg_get_triggerdef() word-boundary regex (trigger bodies via text)
--   5. pg_attrdef expression scan (generated/default columns on OTHER
--      columns that compute from total_spaces)
--
-- SCOPE
--   ONLY drops the column. No reader changes (commit 4 moved them all).
--   No data backfill needed (visitor_capacity was populated from
--   total_spaces in commit 1 and has been the source-of-truth read since
--   commit 4 deploy). Single BEGIN/COMMIT, single logical change.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- DEPENDENCY GATE — aborts the transaction if any object references
-- properties.total_spaces. The ALTER TABLE below is unreachable on a
-- non-empty dependency set.
-- ════════════════════════════════════════════════════════════════════

DO $gate$
DECLARE
  v_pg_depend_count    INTEGER := 0;
  v_view_count         INTEGER := 0;
  v_function_count     INTEGER := 0;
  v_trigger_count      INTEGER := 0;
  v_default_expr_count INTEGER := 0;
  v_total              INTEGER;
BEGIN
  -- 1. Direct catalog dependencies (FKs, indexes, defaults reflected in pg_depend)
  SELECT COUNT(*) INTO v_pg_depend_count
    FROM pg_depend d
    JOIN pg_attribute a
      ON a.attrelid = d.refobjid
     AND a.attnum   = d.refobjsubid
   WHERE d.refobjid = 'public.properties'::regclass
     AND a.attname  = 'total_spaces'
     AND d.deptype NOT IN ('a', 'i');  -- exclude column-itself / internal

  -- 2. Views referencing the column
  SELECT COUNT(*) INTO v_view_count
    FROM information_schema.view_column_usage
   WHERE table_schema = 'public'
     AND table_name   = 'properties'
     AND column_name  = 'total_spaces';

  -- 3. Function / RPC bodies containing 'total_spaces' (word boundary)
  SELECT COUNT(*) INTO v_function_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND p.prosrc ~ '\mtotal_spaces\M';

  -- 4. Trigger bodies (via pg_get_triggerdef text scan, word boundary)
  SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND pg_get_triggerdef(t.oid) ~ '\mtotal_spaces\M';

  -- 5. Default / generated column expressions on OTHER columns
  --    (excludes total_spaces's own default if any)
  SELECT COUNT(*) INTO v_default_expr_count
    FROM pg_attrdef ad
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
   WHERE pg_get_expr(ad.adbin, ad.adrelid) ~ '\mtotal_spaces\M'
     AND NOT (a.attrelid = 'public.properties'::regclass AND a.attname = 'total_spaces');

  v_total := v_pg_depend_count + v_view_count + v_function_count
           + v_trigger_count + v_default_expr_count;

  IF v_total > 0 THEN
    RAISE EXCEPTION
      'DROP COLUMN total_spaces ABORTED — % dependent object(s) found: '
      'pg_depend=%, views=%, functions=%, triggers=%, default_exprs=%. '
      'The repo grep is structurally blind to Dashboard-created objects; '
      'this DB-side gate caught what the grep missed. Run '
      '20260622_spaces_v1_drop_total_spaces_enumerate.sql to see WHICH '
      'objects exist, investigate each, then re-attempt this migration.',
      v_total,
      v_pg_depend_count, v_view_count, v_function_count,
      v_trigger_count, v_default_expr_count
    USING HINT = 'Either migrate each dependent object to read visitor_capacity, or document why the drop is unsafe and abort the cleanup.';
  END IF;

  RAISE NOTICE 'Dependency gate PASSED — 0 objects reference properties.total_spaces. Drop is safe to proceed within this transaction.';
END
$gate$;

-- ════════════════════════════════════════════════════════════════════
-- DROP (only reached if the gate above raised no exception)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.properties DROP COLUMN total_spaces;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- ===== STOP: verification queries are in a SEPARATE file:
-- =====     migrations/20260622_spaces_v1_drop_total_spaces_verification.sql
-- ===== Apply the BEGIN/COMMIT block above as a single paste in SQL Editor.
-- ===== If the gate aborts the txn, run the enumerate.sql companion to see
-- ===== WHICH objects exist, fix them, and re-attempt.
-- ════════════════════════════════════════════════════════════════════
