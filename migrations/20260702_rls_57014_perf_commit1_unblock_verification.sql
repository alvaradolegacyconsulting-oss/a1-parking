-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — RLS 57014 perf fix Commit 1
-- Run these AFTER applying 20260702_rls_57014_perf_commit1_unblock.sql.
-- Each query is standalone; paste one at a time in the SQL Editor.
-- ════════════════════════════════════════════════════════════════════

-- A. Policy shape confirmed — expect 10 rows.
--    Regex-based (position() didn't match the rendered
--    "( SELECT get_my_role() AS get_my_role)" form). Each policy body
--    should contain at least one of the hoisted-helper forms.
SELECT
  tablename,
  policyname,
  cmd,
  (qual ~* 'SELECT\s+get_my_(role|company|properties)\s*\(') AS qual_has_hoisted_helper,
  (qual ~* 'unnest\s*\(\s*get_my_properties') AS qual_has_array_unnest,
  (qual ~* 'SELECT\s+auth\.jwt\s*\(') AS qual_has_hoisted_jwt,
  (with_check ~* 'SELECT\s+get_my_(role|company|properties)\s*\(') AS wc_has_hoisted_helper,
  qual,
  with_check
FROM pg_policies
WHERE tablename IN ('residents','spaces')
  AND policyname IN (
    -- spaces
    'manager_own_spaces',
    'leasing_agent_read_spaces',
    'admin_all_spaces',
    'company_admin_own_spaces',
    'driver_read_spaces',
    'resident_read_own_spaces',
    -- residents
    'residents_manager_read',
    'residents_manager_update',
    'residents_manager_insert',
    'residents_admin_all',
    'residents_company_admin_read',
    'resident_read_own'
  )
ORDER BY tablename, policyname;

-- B. Row-set equivalence — count the rows the test manager should see.
--    (Run as super-user; simulates a scan the RLS SHOULD admit.)
--    Expected: 3 residents at French Quarter, ~60 spaces at French Quarter.
SELECT COUNT(*) AS residents_at_french_quarter
FROM residents WHERE property ILIKE 'French Quarter';

SELECT COUNT(*) AS spaces_at_french_quarter
FROM spaces WHERE property ILIKE 'French Quarter';

-- C. Session-side timing + row equivalence.
--    Run the throwaway probe:
--      npx tsx --env-file=.env.local scripts/probe-residents-500.ts
--    Expected AFTER: <500ms per query, no 57014.
--    Row counts identical to BEFORE (probe already dumps them).

-- D. Negative isolation — pick a manager on a DIFFERENT property
--    (any row in user_roles WHERE role='manager' AND
--    NOT ('French Quarter' ILIKE ANY(property))). Update the email
--    below to that manager's email, then run the same probe script
--    with MANAGER swapped. Expected: 0 residents at French Quarter.
--
--    Handy query to pick one:
--      SELECT email, property FROM user_roles
--      WHERE role='manager'
--        AND NOT ('French Quarter' ILIKE ANY(property))
--      LIMIT 5;
