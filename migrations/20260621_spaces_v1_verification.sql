-- Spaces v1 — verification queries (run AFTER 20260621_spaces_v1_schema.sql applies).
--
-- These are STANDALONE QUERIES, not a migration. Run individually in the
-- SQL Editor; each query block below is ready to copy/paste/execute and
-- returns a result you compare against the expected line.
--
-- Pasting this whole file is also safe — every section is independent
-- SELECT statements (no DDL, no writes).

-- ════════════════════════════════════════════════════════════════════
-- A. visitor_capacity added + backfilled (expand-contract)
-- ════════════════════════════════════════════════════════════════════

SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'properties'
   AND column_name IN ('total_spaces', 'visitor_capacity');
-- Expected: 2 rows, both present (expand phase — drop total_spaces in the
-- cleanup migration after rollout).

SELECT COUNT(*) FILTER (WHERE total_spaces IS NOT NULL)                                 AS legacy_set,
       COUNT(*) FILTER (WHERE visitor_capacity IS NOT NULL)                             AS new_set,
       COUNT(*) FILTER (WHERE total_spaces IS DISTINCT FROM visitor_capacity)           AS divergent
  FROM public.properties;
-- Expected: legacy_set == new_set; divergent == 0 (backfill copied every
-- total_spaces value to visitor_capacity).


-- ════════════════════════════════════════════════════════════════════
-- B. New spaces columns present
-- ════════════════════════════════════════════════════════════════════

SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'spaces'
   AND column_name IN (
     'company', 'label', 'type', 'description', 'is_active',
     'assigned_to_resident_email', 'assigned_at', 'assigned_by_email',
     'is_bundled', 'created_at', 'created_by_email', 'migration_note'
   )
 ORDER BY column_name;
-- Expected: 12 rows.


-- ════════════════════════════════════════════════════════════════════
-- C. Backfill verification (Jose audit data: 123 / 2 / 1)
-- ════════════════════════════════════════════════════════════════════

SELECT status,
       COUNT(*)                                                  AS row_count,
       COUNT(*) FILTER (WHERE company IS NOT NULL)               AS with_company,
       COUNT(*) FILTER (WHERE label IS NOT NULL)                 AS with_label,
       COUNT(*) FILTER (WHERE migration_note IS NOT NULL)        AS flagged
  FROM public.spaces
 GROUP BY status
 ORDER BY status;
-- Expected (simplified per Jose 2026-06-21 — no preservation path):
--   status='available' → 126 rows (123 original + 2 reserved + 1 occupied),
--                         with_company=126, with_label=126, flagged=0
-- No 'assigned' rows post-migration (the occupied test-data row's
-- assignment is intentionally NOT preserved). 126 total, all w/ company+label.


-- ════════════════════════════════════════════════════════════════════
-- D. RPCs exist + SECURITY DEFINER
-- ════════════════════════════════════════════════════════════════════

SELECT proname, prosecdef
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('assign_space', 'reassign_space', 'free_space',
                   'generate_spaces_from_pool', 'decommission_space')
 ORDER BY proname;
-- Expected: 5 rows, prosecdef = TRUE on all.


-- ════════════════════════════════════════════════════════════════════
-- E. RPC GRANTs (anon + PUBLIC absent)
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name IN ('assign_space', 'reassign_space', 'free_space',
                        'generate_spaces_from_pool', 'decommission_space')
 ORDER BY routine_name, grantee;
-- Expected: each routine granted to 'authenticated' (and owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- F. RLS enabled + 6 policies on spaces
-- ════════════════════════════════════════════════════════════════════

SELECT polname, polcmd
  FROM pg_policy
 WHERE polrelid = 'public.spaces'::regclass
 ORDER BY polname;
-- Expected 6 rows (Jose live-verify 2026-06-21 — production already had
-- driver_read_spaces + resident_read_spaces Dashboard-created policies,
-- which are correct per the locked design and were not re-created by
-- this migration):
--   admin_all_spaces            (ALL)      ← created by this migration
--   company_admin_own_spaces    (ALL)      ← created by this migration
--   driver_read_spaces          (SELECT)   ← PRE-EXISTING (Dashboard)
--   leasing_agent_read_spaces   (SELECT)   ← created by this migration
--   manager_own_spaces          (ALL)      ← created by this migration
--   resident_read_spaces        (SELECT)   ← PRE-EXISTING (Dashboard)
--
-- NOTE: the driver_read_spaces and resident_read_spaces policies handle the
-- read-paths that v1's RLS design doesn't grant via the new policies (driver
-- needs spaces.label + location_notes for the post-PII-sweep scan display;
-- resident may need to see their own assignment via spaces table directly
-- if the residents.space text-field fallback ever proves insufficient).

SELECT relrowsecurity
  FROM pg_class
 WHERE relname = 'spaces';
-- Expected: TRUE.


-- ════════════════════════════════════════════════════════════════════
-- G. space_assignment_history present + 3 policies
-- ════════════════════════════════════════════════════════════════════

SELECT polname, polcmd
  FROM pg_policy
 WHERE polrelid = 'public.space_assignment_history'::regclass
 ORDER BY polname;
-- Expected 3 rows:
--   admin_all_space_history          (ALL)
--   company_admin_own_space_history  (SELECT)
--   manager_own_space_history        (SELECT)


-- ════════════════════════════════════════════════════════════════════
-- H. Smoke: role guard (SQL Editor caller has no user_roles row)
-- ════════════════════════════════════════════════════════════════════

SELECT public.assign_space(1, 'test@example.com');
-- Expected: ERROR 'role_not_allowed' (SQL Editor caller is not a manager).


-- ════════════════════════════════════════════════════════════════════
-- I. Smoke: 1001-row generate safety cap
-- ════════════════════════════════════════════════════════════════════

-- Run AS A MANAGER (not SQL Editor — the role guard fires first there):
SELECT public.generate_spaces_from_pool('SomeProperty', 'regular', 1001, NULL);
-- Expected: ERROR 'count_exceeds_safety_cap'.


-- ════════════════════════════════════════════════════════════════════
-- J. Flagged migration rows (should be empty for v1)
-- ════════════════════════════════════════════════════════════════════

SELECT id, property, assigned_to_unit, migration_note
  FROM public.spaces
 WHERE migration_note IS NOT NULL;
-- Expected: 0 rows. The migration_note column + manager-banner UX in
-- commit 3 stay in place as defensive scaffolding for any future
-- per-customer rollout that imports legacy assignments.
