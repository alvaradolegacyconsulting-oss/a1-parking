-- Spaces v1 metadata RPC — verification queries (run AFTER
-- 20260621_spaces_v1_metadata_rpc.sql applies).
--
-- Standalone queries, not a migration. Run individually in the SQL Editor;
-- each block below is ready to copy/paste/execute and returns a result you
-- compare against the expected line.

-- ════════════════════════════════════════════════════════════════════
-- A. RPC exists + SECURITY DEFINER
-- ════════════════════════════════════════════════════════════════════

SELECT proname, prosecdef
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'update_space_metadata';
-- Expected: 1 row, prosecdef = TRUE.


-- ════════════════════════════════════════════════════════════════════
-- B. GRANTs — authenticated only (NOT anon, NOT PUBLIC)
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name = 'update_space_metadata'
 ORDER BY grantee;
-- Expected: 1 grantee 'authenticated' (plus the function owner row, usually
-- postgres). 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- C. Smoke: role guard (SQL Editor caller has no user_roles row)
-- ════════════════════════════════════════════════════════════════════

SELECT public.update_space_metadata(1, 'TEST', NULL, 'regular', FALSE);
-- Expected: ERROR 'role_not_allowed' (SQL Editor caller is not a manager
-- or company_admin; the role check fires before any DB write).


-- ════════════════════════════════════════════════════════════════════
-- D / E / F — MANAGER-SESSION SMOKE (the load-bearing test of this RPC)
-- ════════════════════════════════════════════════════════════════════
-- IMPORTANT (Jose lock 2026-06-21): D/E/F MUST be run as a MANAGER, NOT
-- from the SQL Editor. The SQL Editor caller has no user_roles row and
-- trips `role_not_allowed` BEFORE the path that exercises label collision,
-- type validation, or label-required validation. A test that can't reach
-- the path is a false green.
--
-- Two ways to exercise (Jose's pick):
--
-- Option 1 — IN-PRODUCT UI SMOKE (after commit 3 deploys)
--   The manager Spaces tab's "Edit metadata" modal calls this RPC. Smoke
--   D/E/F naturally as part of the commit-5 12-row matrix:
--     row 13 (D): rename space A to space B's label → "label_already_exists"
--     row 14 (E): submit edit with type='not_real' (UI shouldn't allow but defense in depth)
--     row 15 (F): clear label field, submit → "label_required"
--
-- Option 2 — STANDALONE PROBE SCRIPT (pre-deploy, before commit 3 code ships)
--   scripts/probe-spaces-metadata-rpc.ts authenticates as a manager (via
--   signInWithPassword against a UAT manager account) and exercises D/E/F
--   directly. Catches a broken catch BEFORE users see the raw constraint
--   error. Same pattern as scripts/probe-b209-register-vehicle.ts.
--
-- PRE-REQUISITE FOR D (real-data setup):
--   Post-commit-1 backfill produced 126 'available' spaces with labels
--   backfilled from the legacy space_number. The UAT Test Property
--   contains most of these. Pick any two space ids at the same property
--   (likely both will be from UAT Test Property), note their labels, and
--   attempt to rename one to match the other. The collision will fire if
--   the catch works.
--
-- Concrete query templates (substitute your actual ids + labels):

--   D — collision (substitute id_A + label_B from the same property):
-- SELECT public.update_space_metadata(<id_A>, '<label_B>', NULL, 'carport', FALSE);
-- Expected: ERROR 'label_already_exists' with HINT containing
-- 'Another space at this property already uses label "<label_B>"'.
-- NOT the raw "duplicate key value violates unique constraint
-- spaces_label_unique_per_property" Postgres-speak.

--   E — invalid type:
-- SELECT public.update_space_metadata(<any_space_id>, 'NEW-LABEL', NULL, 'not_a_real_type', FALSE);
-- Expected: ERROR 'invalid_type' with HINT listing the 6 valid types.

--   F — empty label:
-- SELECT public.update_space_metadata(<any_space_id>, '', NULL, 'carport', FALSE);
-- Expected: ERROR 'label_required' (NULLIF + trim catches NULL AND '').


-- ════════════════════════════════════════════════════════════════════
-- G. Smoke: AUTH_SPACE_UPDATE_METADATA audit row written on success
-- ════════════════════════════════════════════════════════════════════
-- After a successful rename (e.g. id=42 from 'CP-1' to 'CP-1-PREMIUM'):
SELECT created_at, user_email, action, record_id, new_values
  FROM public.audit_logs
 WHERE action = 'AUTH_SPACE_UPDATE_METADATA'
 ORDER BY created_at DESC LIMIT 5;
-- Expected: top row shows old_label='CP-1', new_label='CP-1-PREMIUM',
-- type, is_bundled, description_set, company in new_values.
