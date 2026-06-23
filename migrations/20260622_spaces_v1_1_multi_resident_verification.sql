-- Spaces v1.1 — verification queries (run AFTER the schema migration applies).
--
-- Standalone SELECT statements. Pasting the whole file is safe.
-- The TWO LOAD-BEARING checks are A2 (backfill-count assertion) and
-- E (audit-write confirmation) — do not skip those before declaring
-- the commit applied-and-verified.

-- ════════════════════════════════════════════════════════════════════
-- A. space_residents table + indexes + RLS exist
-- ════════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'space_residents'
 ORDER BY ordinal_position;
-- Expected 4 rows: space_id (bigint, NO), resident_email (text, NO),
-- added_at (timestamp with time zone, NO), added_by_email (text, NO).

SELECT indexname
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'space_residents'
 ORDER BY indexname;
-- Expected: space_residents_pkey + space_residents_resident_lookup.

SELECT polname, polcmd
  FROM pg_policy
 WHERE polrelid = 'public.space_residents'::regclass
 ORDER BY polname;
-- Expected 3 rows:
--   admin_all_space_residents          (ALL)
--   company_admin_own_space_residents  (ALL)
--   manager_own_space_residents        (ALL)
-- NO driver_*. NO resident_*.

SELECT relrowsecurity FROM pg_class WHERE relname='space_residents';
-- Expected: TRUE.


-- ════════════════════════════════════════════════════════════════════
-- A2. ★ BACKFILL-COUNT ASSERTION (load-bearing — Jose lock 2026-06-22)
-- ════════════════════════════════════════════════════════════════════
-- Catches a backfill that silently dropped rows. If FAIL, the
-- deactivation trigger will be operating on an incomplete set and
-- v1.1 ships with phantom 1:1 assignments missing from the join table.

SELECT
  (SELECT COUNT(*) FROM public.spaces
    WHERE assigned_to_resident_email IS NOT NULL AND is_active = TRUE) AS legacy_count,
  (SELECT COUNT(*) FROM public.space_residents) AS new_count,
  CASE
    WHEN (SELECT COUNT(*) FROM public.spaces
           WHERE assigned_to_resident_email IS NOT NULL AND is_active = TRUE)
       = (SELECT COUNT(*) FROM public.space_residents)
    THEN 'PASS — backfill complete; new_count matches legacy_count'
    ELSE 'FAIL — backfill silently dropped rows; abort rollout and investigate'
  END AS verdict;
-- Expected: verdict = 'PASS — backfill complete; new_count matches legacy_count'


-- ════════════════════════════════════════════════════════════════════
-- B. RPCs present + SECURITY DEFINER + correct GRANTs
-- ════════════════════════════════════════════════════════════════════

SELECT proname, prosecdef
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN (
     'assign_space',
     'free_space',
     'decommission_space',
     'derive_space_allowed_plates',
     'free_spaces_on_resident_deactivate'
   )
 ORDER BY proname;
-- Expected 5 rows, prosecdef=TRUE on all.

-- reassign_space MUST be gone (locked decision #4).
SELECT proname FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'reassign_space';
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- C. RPC GRANTs — anon + PUBLIC ABSENT on every new/changed RPC
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name IN (
     'assign_space', 'free_space', 'decommission_space',
     'derive_space_allowed_plates'
   )
 ORDER BY routine_name, grantee;
-- Expected: each granted to 'authenticated' (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- D. Trigger present + correctly scoped
-- ════════════════════════════════════════════════════════════════════

SELECT
  t.tgname,
  c.relname        AS table_name,
  pg_get_triggerdef(t.oid) AS trigger_def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname = 'residents_deactivate_free_spaces';
-- Expected 1 row: table_name='residents'; trigger_def contains
-- 'AFTER UPDATE OF is_active' AND 'WHEN ((old.is_active = true) AND (new.is_active = false))'.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ AUDIT-WRITE CONFIRMATION (load-bearing — Jose lock 2026-06-22)
-- ════════════════════════════════════════════════════════════════════
-- A trigger that frees correctly but fails to audit is a silent gap on
-- the exact capacity event we most want recorded. Confirm the function
-- has DEFINER + search_path + the audit_logs INSERT path will work.

SELECT
  proname,
  pg_get_userbyid(proowner)        AS owner,
  prosecdef                         AS is_security_definer,
  proconfig                         AS config_settings
FROM pg_proc
WHERE proname = 'free_spaces_on_resident_deactivate';
-- Expected:
--   is_security_definer = TRUE
--   owner = postgres (or supabase_admin) — has unrestricted INSERT on audit_logs
--   config_settings includes 'search_path=public, pg_temp'

-- After running the smoke (Jose deactivates a test fixture with a tied
-- space), confirm AUTH_SPACE_FREE_AUTO renders with sensible new_values:
SELECT created_at, user_email, action, record_id, new_values
  FROM public.audit_logs
 WHERE action = 'AUTH_SPACE_FREE_AUTO'
 ORDER BY created_at DESC
 LIMIT 5;
-- Expected post-smoke: rows present with new_values JSON containing:
--   space_id, freed_resident_email, remaining_residents,
--   trigger_source='residents_deactivate_free_spaces',
--   space_freed_completely (true|false)
-- The action name AUTH_SPACE_FREE_AUTO is distinct from manual
-- AUTH_SPACE_FREE so log viewers can filter trigger-driven frees.


-- ════════════════════════════════════════════════════════════════════
-- F. Smoke (SQL Editor caller — role guards should refuse all writes)
-- ════════════════════════════════════════════════════════════════════
-- The SQL Editor caller has no user_roles row → role_not_allowed on
-- every write RPC. This is the strongest possible proof that role-pin
-- holds (it refuses even postgres in the Editor context).

-- SELECT public.assign_space(1, 'test@example.com');
-- Expected: ERROR 'role_not_allowed'.

-- SELECT public.free_space(1, 'manual_free', 'test@example.com');
-- Expected: ERROR 'role_not_allowed'.

-- SELECT public.derive_space_allowed_plates('Bayou Heights Apartments', 'test@example.com');
-- Expected: ERROR 'role_not_allowed' (driver-pinned; SQL Editor not a driver).


-- ════════════════════════════════════════════════════════════════════
-- G. Dual-write sanity (post-apply state of legacy column)
-- ════════════════════════════════════════════════════════════════════
-- The backfill should have set every space_residents row's space to
-- legacy assigned_to_resident_email = that resident's email. After
-- the migration, every space with a tie should have the legacy column
-- populated (single-resident state) since the backfill only created
-- 1-row sets.

SELECT
  (SELECT COUNT(*) FROM public.spaces
    WHERE id IN (SELECT space_id FROM public.space_residents)
      AND assigned_to_resident_email IS NOT NULL) AS expected_consistent,
  (SELECT COUNT(*) FROM public.spaces
    WHERE id IN (SELECT space_id FROM public.space_residents)
      AND assigned_to_resident_email IS NULL) AS unexpected_inconsistent;
-- Expected: unexpected_inconsistent = 0 (every backfilled space has its
-- legacy column populated with the single tie). The "NULL on 2+" state
-- only happens AFTER commit 2-5 deploys and managers start adding
-- second residents to spaces.
