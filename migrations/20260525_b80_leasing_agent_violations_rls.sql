-- ════════════════════════════════════════════════════════════════════
-- B80 — leasing_agent backfill into B40 violations RLS
-- Drafted: May 25, 2026 — NOT YET APPLIED.
--
-- ── CONTEXT ─────────────────────────────────────────────────────────
-- B40's manager_own_violations policy (captured in
-- migrations/20260518_b40_violations_rls_capture.sql:139-145) checks
-- get_my_role() = 'manager' only. Leasing_agents — who hit the same
-- /manager portal per the NavBar — fail this role check and cannot
-- read or modify violations through RLS.
--
-- B74 (fa6ad9a, May 19) closed the same gap forward on visitor_passes
-- (manager_own_passes) and confirmed manager_own_vehicles already
-- included leasing_agent. B80 backfills the violations side.
--
-- ── PRE-APPLY VERIFICATION (Jose runs in SQL Editor before applying) ─
-- P9 (now formal — see [[feedback-query-before-inferring]]):
--
--   -- 1. Confirm pre-state still matches the May 19 audit
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--     AND polname ~ 'manager';
--   -- Expected: manager_own_violations USING expression WITHOUT
--   --           leasing_agent. If leasing_agent is already present
--   --           (fixed out-of-band), STOP — no work to do.
--
--   -- 2. Full policy inventory on violations — confirm no surprises
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--   ORDER BY polname;
--   -- Expected: 5 rows — admin_all_violations,
--   --           company_admin_own_violations, driver_own_violations,
--   --           manager_own_violations, resident_own_violations.
--   --           If anything unexpected appears, STOP.
--
--   -- 3. user_roles role values still include literal 'leasing_agent'
--   SELECT DISTINCT role FROM user_roles ORDER BY role;
--   -- Expected: 'leasing_agent' present (confirmed May 19; re-verify
--   --           in case role taxonomy shifted).
--
-- ── SHAPE ───────────────────────────────────────────────────────────
-- Single DROP+CREATE on manager_own_violations. Mirror
-- manager_own_vehicles (already correct in production with
-- leasing_agent included) byte-for-byte except table name + policy name.
--
-- WITH CHECK omitted per B40 byte-convention (defaults to USING on
-- FOR ALL policies; all B40 policies have polwithcheck = NULL).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── manager_own_violations: add leasing_agent ─────────────────────
-- Pre-state USING expression (per B40 capture migration):
--   ((get_my_role() = 'manager'::text)
--    AND (property ~~* ANY (get_my_properties())))
--
-- Post-state — leasing_agent added via ANY(ARRAY[...]), matching
-- manager_own_vehicles + manager_own_passes shape.
DROP POLICY IF EXISTS "manager_own_violations" ON violations;
CREATE POLICY "manager_own_violations" ON violations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. manager_own_violations USING expr contains leasing_agent ─────
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--     AND polname = 'manager_own_violations';
--   -- Expected: using_expr contains "leasing_agent". The exact
--   --           pg_get_expr serialization should match manager_own_vehicles'
--   --           expression byte-for-byte except for the table reference.
--
-- ── B. Policy inventory on violations unchanged in count ───────────
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--   ORDER BY polname;
--   -- Expected 5 rows (polcmd: r=SELECT, *=ALL):
--   --   admin_all_violations            *
--   --   company_admin_own_violations    *
--   --   driver_own_violations           *
--   --   manager_own_violations          *  ← updated
--   --   resident_own_violations         r
--
-- ── C. RLS still enabled on violations ─────────────────────────────
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname = 'violations';
--   -- Expected: relrowsecurity = TRUE
--
-- ── POST-APPLY SMOKE (Jose runs in browser, optional) ──────────────
-- As leasing_agent user (Demo Towing has leasing.bayou@demotowing.com):
-- navigate to /manager → Violations tab → confirm violations appear
-- for assigned property where previously they showed zero.
--
-- ── ROLLBACK (if needed) ────────────────────────────────────────────
--   BEGIN;
--   DROP POLICY IF EXISTS "manager_own_violations" ON violations;
--   CREATE POLICY "manager_own_violations" ON violations
--     FOR ALL TO authenticated
--     USING (
--       (get_my_role() = 'manager'::text)
--       AND (property ~~* ANY (get_my_properties()))
--     );
--   COMMIT;
-- Restores the B40 pre-state byte-for-byte. No data state affected
-- (rollback only changes policy gate, not row contents).
-- ════════════════════════════════════════════════════════════════════
