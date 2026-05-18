-- ════════════════════════════════════════════════════════════════════
-- B74 — RLS hardening on vehicles + visitor_passes (SURGICAL REVISION)
-- Drafted: May 19, 2026 — NOT YET APPLIED.
--
-- ── REVISION CONTEXT ────────────────────────────────────────────────
-- Original B74 migration (commit cd76be5) was scoped on the premise
-- that vehicles + visitor_passes had NO RLS policies. Pre-apply
-- verification on May 19 revealed both tables already have a full
-- policy set, established (likely) in the May 13 B40+B43 RLS pass.
-- The false premise propagated from B70's Finding 2 through B74's
-- pre-flight to within minutes of the apply step.
--
-- The original B70 pre-flight assertion ("neither table has RLS")
-- was wrong. The pre-apply verification caught it. Stop-before-DB (P4)
-- worked as designed. P9 candidate (query before inferring) gets
-- another recurrence — formal adoption pending.
--
-- ── ACTUAL B74 SCOPE (what's left to do) ────────────────────────────
-- After auditing existing policies against B74's design intent, only
-- three real changes remain:
--
--   1. Two anon-direct policies exist that constitute privacy leaks:
--        • public_read_active_vehicles  USING (is_active = true)
--          → anon can enumerate the entire active-vehicle registry
--        • public_insert_passes  WITH CHECK (true)
--          → anon can INSERT arbitrary visitor pass rows
--      Both must be DROPped. The /visitor anon flow gets repointed
--      to two new SECURITY DEFINER RPCs (PART 1).
--
--   2. resident_own_vehicles + resident_own_passes are property-scoped
--      only (today a resident at property X can read every vehicle
--      and pass at X, not just their own unit). Tightened to
--      (property, unit) / (property, visiting_unit) tuple-IN matching.
--      Also: resident_own_passes is SELECT-only today; broaden to
--      FOR ALL so residents can issue passes for their own unit via
--      authenticated path (was previously routed through the
--      public_insert_passes anon backdoor — which we're killing).
--
--   3. manager_own_passes checks role='manager' only, leaving
--      leasing_agents unable to read visitor_passes via RLS.
--      (Note: manager_own_vehicles ALREADY includes leasing_agent,
--      so the gap exists only on visitor_passes.)
--      Tightened to manager + leasing_agent.
--
-- ── WHAT IS NOT CHANGING ────────────────────────────────────────────
--   • admin_all_vehicles, admin_all_passes — already correct
--   • company_admin_own_vehicles, company_admin_own_passes — already correct
--   • manager_own_vehicles — already correct (includes leasing_agent)
--   • driver_read_vehicles, driver_read_passes — SELECT-only is correct;
--     drivers don't have any code paths that INSERT to either table
--   • RLS is already ENABLED on both tables (no ALTER TABLE needed)
--
-- ── ATOMIC SHIP STRATEGY ────────────────────────────────────────────
-- Single transaction. The /visitor page TS swap (vehicles SELECT →
-- check_resident_plate RPC, visitor_passes INSERT → create_visitor_pass
-- RPC) ships in the SAME commit. Both must apply together.
--
-- The TS edits in app/visitor/page.tsx from commit cd76be5 are CORRECT
-- and stay as-is. This file replaces the migration only.
--
-- ── PRE-APPLY VERIFICATION (run in SQL Editor BEFORE applying) ──────
-- Already performed May 19 — recorded outcomes:
--   • Column shapes: vehicles.property = text, visitor_passes.property = text  ✅
--   • RLS enabled on both: rowsecurity = true on both  ✅
--   • Existing policies (12 total) audited and matched against B74 intent  ✅
--   • user_roles.role values: literal 'leasing_agent' confirmed  ✅
--
-- ── ORPHAN-RESIDENT AUDIT (Finding 2 from revision pre-flight) ──────
-- The resident policy tightening below uses a tuple-IN against the
-- residents table. Any user_roles row with role='resident' that has
-- no matching residents row will silently LOSE visitor-pass INSERT
-- capability post-apply (previously worked via the dropped anon
-- public_insert_passes policy backdoor).
--
-- Verification query (run BEFORE applying):
--   SELECT ur.email, ur.company, ur.property
--   FROM user_roles ur
--   LEFT JOIN residents r ON r.email ILIKE ur.email
--   WHERE ur.role = 'resident' AND r.email IS NULL
--   ORDER BY ur.email;
--   -- Expected post-cleanup: 0 rows. If any return, decide per row:
--   --   (a) backfill residents row, OR
--   --   (b) delete user_roles + auth.users row if test fixture
--
-- Recorded outcome on May 19 — 2 orphan rows surfaced:
--   • bayouresident@bayou.com (Demo Towing LLC)
--   • jasonsmith2@email.com (Demo Towing LLC)
-- Both were May 14 test fixtures with no residents row, never used in
-- production. Cleaned up via SQL Editor:
--   DELETE FROM user_roles WHERE email IN ('bayouresident@bayou.com',
--                                          'jasonsmith2@email.com');
--   DELETE FROM auth.users WHERE email IN ('bayouresident@bayou.com',
--                                          'jasonsmith2@email.com');
-- Re-verification clean: 7 active residents, all paired with residents
-- rows. No production users affected.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — SECURITY DEFINER RPCs for the anon /visitor paths
-- ════════════════════════════════════════════════════════════════════
-- Replaces the anon-direct SELECT on vehicles and the anon-direct
-- INSERT on visitor_passes that the dropped policies in PART 2 + PART 3
-- previously enabled. Both GRANTed to anon + authenticated.

-- ── check_resident_plate(p_plate, p_property) ─────────────────────
-- Boolean lookup used by /visitor BEFORE submit. Returns true/false
-- only — no row data leaks, no enumeration possible.
CREATE OR REPLACE FUNCTION public.check_resident_plate(
  p_plate     TEXT,
  p_property  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized TEXT;
BEGIN
  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RETURN FALSE;
  END IF;
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN FALSE;
  END IF;

  -- Same normalization as pm_plate_lookup (B70).
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized) = 0 THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM vehicles
    WHERE upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND property ILIKE p_property
      AND is_active = TRUE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT)
  TO anon, authenticated;

-- ── create_visitor_pass(...) ──────────────────────────────────────
-- Anon INSERT path for /visitor. enforce_visitor_pass_limit trigger
-- still fires on the internal INSERT and raises 23514 if the per-plate
-- concurrent limit is exceeded — error bubbles to caller via supabase-js.
-- Audit log INSERT is included for atomicity (was a separate anon
-- INSERT in /visitor; moved here so the pass + log are inseparable).
CREATE OR REPLACE FUNCTION public.create_visitor_pass(
  p_plate            TEXT,
  p_visitor_name     TEXT,
  p_visiting_unit    TEXT,
  p_property         TEXT,
  p_vehicle_desc     TEXT,
  p_duration_hours   INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized TEXT;
  v_pass_id    BIGINT;
  v_expires    TIMESTAMPTZ;
BEGIN
  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RAISE EXCEPTION 'property required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_duration_hours IS NULL OR p_duration_hours <= 0 THEN
    RAISE EXCEPTION 'duration_hours must be positive' USING ERRCODE = 'check_violation';
  END IF;

  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  v_expires := now() + (p_duration_hours || ' hours')::INTERVAL;

  INSERT INTO visitor_passes (
    plate, visitor_name, visiting_unit, property,
    vehicle_desc, duration_hours, created_at, expires_at, is_active
  ) VALUES (
    v_normalized, p_visitor_name, p_visiting_unit, p_property,
    p_vehicle_desc, p_duration_hours, now(), v_expires, TRUE
  )
  RETURNING id INTO v_pass_id;

  INSERT INTO audit_logs (action, table_name, new_values)
  VALUES (
    'VISITOR_TOS_ACCEPTED',
    'visitor_passes',
    jsonb_build_object('plate', v_normalized, 'property', p_property)
  );

  RETURN v_pass_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER)
  TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — vehicles: drop the anon leak, tighten resident scoping
-- ════════════════════════════════════════════════════════════════════
-- All other vehicles policies (admin_all_vehicles, company_admin_own_vehicles,
-- driver_read_vehicles, manager_own_vehicles) are CORRECT AS-IS and not
-- touched.

-- ── Drop the anon enumeration leak ──────────────────────────────
-- USING (is_active = true) lets any anon caller SELECT every active
-- vehicle row in the database. Replaced by check_resident_plate RPC.
DROP POLICY IF EXISTS "public_read_active_vehicles" ON vehicles;

-- ── Tighten resident_own_vehicles to (property, unit) tuple-IN ──
-- Existing policy is property-scoped only. New shape uses tuple-IN
-- matching so residents only see vehicles tied to their specific
-- (property, unit) pair. Forward-compatible with future
-- multi-residency refactor.
--
-- WITH CHECK is omitted — Postgres defaults WITH CHECK to USING when
-- omitted on FOR ALL policies. Matches the B40 capture-pass byte
-- convention (all FOR ALL policies in production have polwithcheck =
-- NULL). Resident INSERTs/UPDATEs are still gated by USING via the
-- WITH-CHECK-defaults-to-USING rule.
DROP POLICY IF EXISTS "resident_own_vehicles" ON vehicles;
CREATE POLICY "resident_own_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — visitor_passes: drop the anon leak, leasing_agent + tuple-IN
-- ════════════════════════════════════════════════════════════════════
-- All other visitor_passes policies (admin_all_passes,
-- company_admin_own_passes, driver_read_passes) are correct AS-IS and
-- not touched.

-- ── Drop the anon free-INSERT leak ──────────────────────────────
-- WITH CHECK (true) lets any anon caller INSERT arbitrary rows into
-- visitor_passes. The enforce_visitor_pass_limit trigger provided
-- some protection but no scoping. Replaced by create_visitor_pass RPC.
DROP POLICY IF EXISTS "public_insert_passes" ON visitor_passes;

-- ── manager_own_passes: add leasing_agent ───────────────────────
-- Existing policy checks role='manager' only, leaving leasing_agents
-- unable to access visitor_passes via RLS. (Note: manager_own_vehicles
-- ALREADY includes leasing_agent — gap exists only on this one policy.)
DROP POLICY IF EXISTS "manager_own_passes" ON visitor_passes;
CREATE POLICY "manager_own_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── resident_own_passes: tuple-IN + broaden to FOR ALL ──────────
-- Two changes:
--   1. Property-only → (property, visiting_unit) tuple-IN matching
--      residents.(property, unit). Same multi-residency forward-compat
--      as resident_own_vehicles.
--   2. SELECT-only → FOR ALL. Residents need to INSERT visitor passes
--      for their own unit through the authenticated path; the
--      public_insert_passes anon backdoor (being dropped) was the
--      previous mechanism.
--
-- WITH CHECK omitted (defaults to USING) — matches B40 byte convention.
-- The broadening is intentional: residents now INSERT through the
-- authenticated path, gated by the same (property, visiting_unit)
-- tuple-IN that USING enforces.
DROP POLICY IF EXISTS "resident_own_passes" ON visitor_passes;
CREATE POLICY "resident_own_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. vehicles policy inventory ────────────────────────────────────
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'vehicles'::regclass ORDER BY polname;
--   -- Expected 5 rows:
--   --   admin_all_vehicles              *  (ALL)
--   --   company_admin_own_vehicles      *  (ALL)
--   --   driver_read_vehicles            r  (SELECT)  ← unchanged
--   --   manager_own_vehicles            *  (ALL)
--   --   resident_own_vehicles           *  (ALL)
--   -- public_read_active_vehicles MUST NOT appear (dropped).
--
-- ── B. visitor_passes policy inventory ──────────────────────────────
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'visitor_passes'::regclass ORDER BY polname;
--   -- Expected 5 rows:
--   --   admin_all_passes                *  (ALL)
--   --   company_admin_own_passes        *  (ALL)
--   --   driver_read_passes              r  (SELECT)  ← unchanged
--   --   manager_own_passes              *  (ALL)
--   --   resident_own_passes             *  (ALL)
--   -- public_insert_passes MUST NOT appear (dropped).
--
-- ── C. Updated USING expressions ────────────────────────────────────
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'vehicles'::regclass AND polname = 'resident_own_vehicles';
--   -- Expected: contains "(property, unit) IN (SELECT ..."
--
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'visitor_passes'::regclass
--     AND polname IN ('manager_own_passes', 'resident_own_passes');
--   -- manager_own_passes USING expr contains "ANY (ARRAY['manager'::text, 'leasing_agent'::text])"
--   -- resident_own_passes USING expr contains "(property, visiting_unit) IN (SELECT ..."
--
-- ── D. RLS still enabled on both tables ─────────────────────────────
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('vehicles', 'visitor_passes');
--   -- Expected: both relrowsecurity = TRUE (unchanged from pre-state)
--
-- ── E. RPC functions exist + SECURITY DEFINER + correct GRANTs ──────
--   SELECT proname, prosecdef AS is_security_definer, provolatile
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('check_resident_plate', 'create_visitor_pass')
--   ORDER BY proname;
--   -- Expected:
--   --   check_resident_plate    t   s   (s = STABLE)
--   --   create_visitor_pass     t   v   (v = VOLATILE)
--
--   SELECT routine_name, grantee
--   FROM information_schema.routine_privileges
--   WHERE routine_schema='public'
--     AND routine_name IN ('check_resident_plate', 'create_visitor_pass')
--     AND privilege_type='EXECUTE'
--   ORDER BY routine_name, grantee;
--   -- Expected: each routine appears with grantee IN ('anon', 'authenticated').
--
-- ── F. Anon smoke 1 — check_resident_plate ──────────────────────────
-- From anon Supabase client:
--   SELECT check_resident_plate('TEST-PLATE-FAKE', 'Test Property');
--   -- Expected: false
--
-- ── G. Anon smoke 2 — direct SELECT on vehicles returns 0 ───────────
-- From anon Supabase client:
--   SELECT count(*) FROM vehicles;
--   -- Expected: 0 (no anon policy exists now; previously returned
--   --             every active vehicle via public_read_active_vehicles)
--
-- ── H. Anon smoke 3 — direct INSERT on visitor_passes fails ─────────
-- From anon Supabase client:
--   INSERT INTO visitor_passes (plate, property, duration_hours)
--   VALUES ('XYZ', 'Some Property', 4);
--   -- Expected: PERMISSION DENIED (no anon policy exists now)
--
-- ── I. Anon smoke 4 — create_visitor_pass succeeds ──────────────────
-- DESTRUCTIVE — only run in dev/staging:
--   SELECT create_visitor_pass(
--     'TESTVPLATE', 'Smoke Visitor', 'A-101',
--     'Test Property', 'White sedan', 2
--   );
--   -- Expected: BIGINT (new visitor_passes.id), audit log row created
--
-- ── POST-APPLY SMOKE CHECKLIST ──────────────────────────────────────
-- 1. As resident — fetchVehicles returns own (property, unit) rows only
-- 2. As resident — INSERT new vehicle for own (property, unit) succeeds;
--    INSERT with wrong unit fails (tuple-IN blocks)
-- 3. As resident — INSERT visitor pass via authenticated portal for own
--    (property, unit) succeeds (validates broaden-to-FOR-ALL on
--    resident_own_passes)
-- 4. As manager — fetchVehicles + visitor_passes on assigned property
--    return rows; unassigned property returns zero
-- 5. As leasing_agent (if test rows exist) — same as manager on BOTH
--    tables (vehicles already worked; visitor_passes is the fix)
-- 6. As driver — plate lookup at scanPlate returns rows for own
--    company's properties; fails on other company's
-- 7. As anon (incognito /visitor) — plate precheck works (RPC);
--    direct .from('vehicles') returns zero
-- 8. As anon (incognito /visitor) — visitor pass submit works (RPC);
--    direct .from('visitor_passes').insert(...) fails
-- 9. As admin — bulk update on property completes (admin FOR ALL covers it)
--
-- ── ROLLBACK (TWO-STEP) ─────────────────────────────────────────────
-- Step 1 (CODE): revert /visitor page to direct .from() calls.
-- Step 2 (DB):
--
--   BEGIN;
--   -- Restore the dropped anon policies (recreates the privacy leaks
--   -- temporarily until code rollback completes)
--   CREATE POLICY "public_read_active_vehicles" ON vehicles
--     FOR SELECT USING (is_active = true);
--   CREATE POLICY "public_insert_passes" ON visitor_passes
--     FOR INSERT WITH CHECK (true);
--   -- Restore loose resident scoping
--   DROP POLICY IF EXISTS "resident_own_vehicles" ON vehicles;
--   CREATE POLICY "resident_own_vehicles" ON vehicles
--     FOR ALL TO authenticated
--     USING ((get_my_role() = 'resident'::text)
--            AND (property IN (SELECT residents.property FROM residents
--                              WHERE residents.email ~~* (auth.jwt() ->> 'email'::text))));
--   DROP POLICY IF EXISTS "resident_own_passes" ON visitor_passes;
--   CREATE POLICY "resident_own_passes" ON visitor_passes
--     FOR SELECT TO authenticated
--     USING ((get_my_role() = 'resident'::text)
--            AND (property IN (SELECT residents.property FROM residents
--                              WHERE residents.email ~~* (auth.jwt() ->> 'email'::text))));
--   -- Restore manager-only on visitor_passes (removes leasing_agent)
--   DROP POLICY IF EXISTS "manager_own_passes" ON visitor_passes;
--   CREATE POLICY "manager_own_passes" ON visitor_passes
--     FOR ALL TO authenticated
--     USING ((get_my_role() = 'manager'::text)
--            AND (property ~~* ANY (get_my_properties())));
--   -- Drop the RPCs
--   DROP FUNCTION IF EXISTS public.check_resident_plate(TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.create_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER);
--   COMMIT;
--
-- Supabase point-in-time restore is the nuclear option.
-- ════════════════════════════════════════════════════════════════════
