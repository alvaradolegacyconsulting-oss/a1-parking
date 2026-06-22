-- Spaces v1 contract-phase — DEPENDENCY ENUMERATION (read-only).
--
-- OPTIONAL pre-flight. Run BEFORE 20260622_spaces_v1_drop_total_spaces.sql
-- to SEE which objects (if any) depend on properties.total_spaces. The drop
-- migration itself self-gates on the same enumeration (5 counts; aborts if
-- any are non-zero), but this file lets Jose see WHICH objects exist before
-- the gate fires, so he can investigate rather than just get an abort.
--
-- Expected: every section returns ZERO rows. Repo grep is structurally
-- blind to Dashboard-created objects (triggers, views, function bodies);
-- these queries enumerate from pg_depend / information_schema / pg_proc /
-- pg_trigger / pg_attrdef — the DB-side source of truth.
--
-- If any section returns non-zero, investigate that object BEFORE running
-- the drop migration. The drop migration will abort with the per-section
-- counts; this file shows the per-OBJECT detail.

-- ════════════════════════════════════════════════════════════════════
-- 1. pg_depend — direct catalog dependencies (FKs, defaults, etc.)
-- ════════════════════════════════════════════════════════════════════
-- Filters: refobjid = properties table, refobjsubid = total_spaces attnum.
-- Excludes deptype 'a' (auto: the column's own statistics/itself) and 'i'
-- (internal: implementation reflections). Anything left is user-created.

SELECT
  d.deptype,
  dep_obj.relname    AS dependent_object,
  dep_obj.relkind    AS dependent_kind,    -- r=table, v=view, m=matview, f=function, i=index...
  pg_get_userbyid(dep_obj.relowner) AS owner
FROM pg_depend d
JOIN pg_attribute a
  ON a.attrelid = d.refobjid
 AND a.attnum   = d.refobjsubid
JOIN pg_class dep_obj
  ON dep_obj.oid = d.objid
WHERE d.refobjid = 'public.properties'::regclass
  AND a.attname = 'total_spaces'
  AND d.deptype NOT IN ('a', 'i')
ORDER BY d.deptype, dep_obj.relname;
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- 2. information_schema.view_column_usage — views referencing the column
-- ════════════════════════════════════════════════════════════════════

SELECT
  view_schema,
  view_name,
  table_schema AS referenced_schema,
  table_name   AS referenced_table,
  column_name  AS referenced_column
FROM information_schema.view_column_usage
WHERE table_schema = 'public'
  AND table_name   = 'properties'
  AND column_name  = 'total_spaces'
ORDER BY view_schema, view_name;
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- 3. pg_proc — function / RPC bodies containing 'total_spaces' (word boundary)
-- ════════════════════════════════════════════════════════════════════
-- Word-boundary regex (\m...\M) so we don't false-positive on a column
-- like 'total_spaces_extended'. Skips system schemas.

SELECT
  n.nspname                                  AS schema_name,
  p.proname                                  AS function_name,
  p.prokind                                  AS kind,    -- f=function, p=procedure, a=agg, w=window
  pg_get_userbyid(p.proowner)                AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND p.prosrc ~ '\mtotal_spaces\M'
ORDER BY n.nspname, p.proname;
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- 4. pg_trigger — trigger bodies referencing 'total_spaces' (via triggerdef)
-- ════════════════════════════════════════════════════════════════════
-- pg_trigger.tgargs is binary; safer to scan pg_get_triggerdef() text which
-- includes the WHEN clause + the function name. Skips internal triggers.

SELECT
  n.nspname              AS schema_name,
  c.relname              AS table_name,
  t.tgname               AS trigger_name,
  pg_get_triggerdef(t.oid) AS trigger_def
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND pg_get_triggerdef(t.oid) ~ '\mtotal_spaces\M'
ORDER BY n.nspname, c.relname, t.tgname;
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- 5. pg_attrdef — default/generated column expressions on OTHER columns
--    that reference total_spaces (e.g., a generated column computed from it)
-- ════════════════════════════════════════════════════════════════════

SELECT
  c.relname                          AS table_name,
  a.attname                          AS column_name,
  pg_get_expr(ad.adbin, ad.adrelid)  AS default_expr
FROM pg_attrdef ad
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
JOIN pg_class     c ON c.oid      = ad.adrelid
WHERE pg_get_expr(ad.adbin, ad.adrelid) ~ '\mtotal_spaces\M'
  -- Exclude the total_spaces column's own default (if any)
  AND NOT (a.attrelid = 'public.properties'::regclass AND a.attname = 'total_spaces')
ORDER BY c.relname, a.attname;
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- ROLLUP — single number; if it's 0, the drop is safe
-- ════════════════════════════════════════════════════════════════════

SELECT
  (SELECT COUNT(*) FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refobjid = 'public.properties'::regclass
      AND a.attname = 'total_spaces' AND d.deptype NOT IN ('a','i')
  ) AS pg_depend_count,
  (SELECT COUNT(*) FROM information_schema.view_column_usage
    WHERE table_schema='public' AND table_name='properties' AND column_name='total_spaces'
  ) AS view_count,
  (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND p.prosrc ~ '\mtotal_spaces\M'
  ) AS function_count,
  (SELECT COUNT(*) FROM pg_trigger t
    WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~ '\mtotal_spaces\M'
  ) AS trigger_count,
  (SELECT COUNT(*) FROM pg_attrdef ad
    JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE pg_get_expr(ad.adbin, ad.adrelid) ~ '\mtotal_spaces\M'
      AND NOT (a.attrelid = 'public.properties'::regclass AND a.attname = 'total_spaces')
  ) AS default_expr_count;
-- Expected: all 5 columns return 0. If any is > 0, sections 1-5 above
-- show the per-object detail.
