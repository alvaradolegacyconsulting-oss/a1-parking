-- Spaces v1 contract-phase — verification queries (run AFTER the DROP applies).
--
-- These are standalone SELECT statements. Pasting the whole file is safe.

-- ════════════════════════════════════════════════════════════════════
-- A. Column gone
-- ════════════════════════════════════════════════════════════════════

SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'properties'
   AND column_name IN ('total_spaces', 'visitor_capacity');
-- Expected: 1 row, 'visitor_capacity'. total_spaces MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- B. visitor_capacity values intact (no data loss)
-- ════════════════════════════════════════════════════════════════════

SELECT
  COUNT(*)                                         AS total_properties,
  COUNT(*) FILTER (WHERE visitor_capacity IS NOT NULL) AS with_visitor_capacity,
  COUNT(*) FILTER (WHERE visitor_capacity IS NULL)     AS without
FROM public.properties;
-- Expected: with_visitor_capacity matches the count from commit-1
-- verification A's legacy_set. without == any properties that legitimately
-- had no total_spaces in legacy data (NULL → NULL through the rename).


-- ════════════════════════════════════════════════════════════════════
-- C. Dependency enumeration STILL returns 0 (gate would still pass if
--    the migration were re-run — no residual references anywhere)
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
  ) AS trigger_count;
-- Expected: all 4 columns return 0. (The column is gone; the pg_depend
-- query gracefully returns 0 because the attname filter no longer matches.)


-- ════════════════════════════════════════════════════════════════════
-- D. Audit_logs row stamping the drop (optional — read for posterity)
-- ════════════════════════════════════════════════════════════════════
-- The DROP itself doesn't write an audit row (it's DDL, not application
-- action). For audit trail you can manually note the migration apply in
-- your operational log. This section is intentionally empty — DDL events
-- live in pg_event_trigger if a project subscribes to one, not audit_logs.
