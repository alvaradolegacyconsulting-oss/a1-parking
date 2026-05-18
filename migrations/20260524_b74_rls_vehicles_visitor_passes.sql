-- ════════════════════════════════════════════════════════════════════
-- B74 — RLS hardening on vehicles + visitor_passes
-- Drafted: May 24, 2026 — NOT YET APPLIED.
--
-- B70 surfaced (Finding 2) that vehicles and visitor_passes had NO RLS
-- policies. B70 closed the immediate plate-lookup gap via the
-- SECURITY DEFINER pm_plate_lookup RPC (Path C) and explicitly deferred
-- full RLS hardening (Path B) as B74. This migration is that work.
--
-- ── ATOMIC SHIP STRATEGY ────────────────────────────────────────────
-- Single migration file in three sections. The anon-path swap on
-- /visitor (vehicles SELECT → check_resident_plate RPC, visitor_passes
-- INSERT → create_visitor_pass RPC) ships in the SAME git commit. Both
-- the SQL and the TS edit must apply together — a partial state where
-- only one side landed would break the public visitor pass flow.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   PART 1 — Two new SECURITY DEFINER RPCs:
--             check_resident_plate(p_plate, p_property) → boolean
--             create_visitor_pass(p_plate, p_visitor_name,
--                                 p_visiting_unit, p_property,
--                                 p_vehicle_desc, p_duration_hours) → bigint
--   PART 2 — vehicles RLS: ENABLE + 5 policies
--   PART 3 — visitor_passes RLS: ENABLE + 4 policies (no driver — driver
--             access goes through pm_plate_lookup RPC which is SECURITY
--             DEFINER and bypasses RLS)
--
-- ── KEY DECISIONS (LOCKED PRE-FLIGHT) ───────────────────────────────
--   • Path B (RPCs) chosen over Path A (open anon policies) for the
--     /visitor anon paths. Anon-direct SELECT on vehicles would leak the
--     entire active-vehicle registry to any anon caller; even narrowed
--     by is_active = true, row visibility is a privacy regression.
--     RPCs make the minimum-leak contract explicit at the API level.
--   • leasing_agent included alongside manager in policies via
--     `get_my_role() IN ('manager','leasing_agent')`. B40 violations
--     RLS only checks role='manager', leaving leasing_agents
--     unable to read violations via RLS. That's a B40 gap; closed
--     forward in B74. Backfill to B40 filed as B80.
--   • Resident policies use TUPLE-IN matching on (property, unit) /
--     (property, visiting_unit) rather than two independent subqueries.
--     Forward-compatible with a future residents table refactor that
--     allows one user to have multiple residents rows (roommate /
--     family-member multi-residency Phase 2 case).
--   • Field-level write enforcement on resident vehicle UPDATE stays
--     client-side at resident/page.tsx:222-224 (residents can only
--     edit cosmetic descriptors). RLS cannot enforce field-level
--     UPDATE without column-privilege machinery.
--
-- ── RESIDENT MOVED-UNIT BEHAVIOR (noted for posterity) ──────────────
-- Resident vehicle access is implicitly unit-scoped via the (property,
-- unit) tuple-IN. If a resident moves units, they LOSE access to
-- vehicle history at their old unit on next query. Almost certainly
-- the desired behavior (moved residents shouldn't keep issuing visitor
-- passes against their old unit), but documenting here so future
-- investigation doesn't mis-classify it as a bug.
--
-- ── PRE-APPLY VERIFICATION (run in SQL Editor BEFORE applying) ──────
-- 1. Column shape sanity (P9):
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='vehicles'
--   ORDER BY ordinal_position;
--   -- Expected: property=text, unit=text, plate=text, is_active=bool,
--   --           status=text, id=bigint (or similar). No property_id FK.
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='visitor_passes'
--   ORDER BY ordinal_position;
--   -- Expected: property=text, visiting_unit=text (nullable), plate=text,
--   --           is_active=bool, expires_at=timestamptz, etc.
--
-- 2. No existing RLS to clobber:
--   SELECT polname FROM pg_policy
--   WHERE polrelid IN ('vehicles'::regclass, 'visitor_passes'::regclass);
--   -- Expected: 0 rows. If anything returns, STOP and investigate before
--   --           applying this migration.
--
-- 3. user_roles role values that exist (sanity for leasing_agent gate):
--   SELECT DISTINCT role FROM user_roles ORDER BY role;
--   -- Expected: admin / company_admin / driver / manager / leasing_agent
--   --           / resident. If leasing_agent value differs (e.g.,
--   --           'leasing-agent' or 'leasingAgent'), update policy expressions.
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — SECURITY DEFINER RPCs for the anon /visitor paths
-- ════════════════════════════════════════════════════════════════════
-- Defined first so any future RLS expression that references them
-- (none today) sees them in scope. Both are GRANTed to anon +
-- authenticated. Both SECURITY DEFINER so they bypass the RLS policies
-- in PART 2/3.

-- ── check_resident_plate(p_plate, p_property) ─────────────────────
-- Boolean lookup used by /visitor BEFORE the visitor pass form
-- submission. Question being answered: "Is this plate already an
-- active resident at this property?" — if yes, the visitor form
-- redirects them to "you don't need a visitor pass." Returns boolean
-- only. No row data leaks; row count of vehicles is not enumerable.
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

  -- Same normalization pattern as pm_plate_lookup (B70).
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
-- Anon INSERT path for the public QR-code visitor pass flow. Mirrors
-- the shape that /visitor/page.tsx currently writes directly. The
-- enforce_visitor_pass_limit trigger fires on the internal INSERT and
-- raises 23514 if the per-plate concurrent limit is exceeded — the
-- caller catches the RAISE via supabase-js error.
--
-- Audit log INSERT (VISITOR_TOS_ACCEPTED) moved INTO this RPC for
-- atomicity. The previous /visitor flow did INSERT into visitor_passes
-- and then a second anon INSERT into audit_logs — if audit_logs ever
-- gets RLS (separate work), this RPC continues to function under
-- SECURITY DEFINER.
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
  -- Input sanity (matches minimum form-side validation).
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

  -- The enforce_visitor_pass_limit trigger (May 14) fires here; raises
  -- 23514 if per-plate concurrent limit exceeded. Error bubbles up.
  INSERT INTO visitor_passes (
    plate, visitor_name, visiting_unit, property,
    vehicle_desc, duration_hours, created_at, expires_at, is_active
  ) VALUES (
    v_normalized, p_visitor_name, p_visiting_unit, p_property,
    p_vehicle_desc, p_duration_hours, now(), v_expires, TRUE
  )
  RETURNING id INTO v_pass_id;

  -- Atomic audit log (was a separate anon INSERT in /visitor; now
  -- bundled here so the pass + log are inseparable).
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
-- PART 2 — vehicles RLS
-- ════════════════════════════════════════════════════════════════════
-- Five policies, mirroring B40 violations pattern except:
--   • manager policy includes leasing_agent (closes B40 gap; see B80)
--   • resident policy uses tuple-IN matching on (property, unit) for
--     multi-residency forward-compat
--   • resident policy is FOR ALL (not SELECT-only like B40 violations)
--     because residents legitimately INSERT and UPDATE their own vehicles
--   • driver policy is FOR ALL (matches B40 driver_own_violations shape;
--     drivers don't currently INSERT vehicles, but FOR ALL keeps the
--     pattern uniform and doesn't grant new client capability — there
--     are no driver-side INSERT call sites)

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

-- ── 1. admin_all_vehicles ────────────────────────────────────────
DROP POLICY IF EXISTS "admin_all_vehicles" ON vehicles;
CREATE POLICY "admin_all_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

-- ── 2. company_admin_own_vehicles ───────────────────────────────
DROP POLICY IF EXISTS "company_admin_own_vehicles" ON vehicles;
CREATE POLICY "company_admin_own_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE (properties.company ~~* get_my_company())
    ))
  );

-- ── 3. driver_own_vehicles ──────────────────────────────────────
-- Company-scoped (NOT property-assignment-scoped). Matches B40
-- driver_own_violations shape. Drivers read vehicles via plate
-- lookup during scan + may need cross-property visibility within
-- their company; the driver/page.tsx code filters client-side by
-- selectedProperty.
DROP POLICY IF EXISTS "driver_own_vehicles" ON vehicles;
CREATE POLICY "driver_own_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE (properties.company ~~* get_my_company())
    ))
  );

-- ── 4. manager_own_vehicles (includes leasing_agent) ───────────
-- DIVERGENCE FROM B40: includes leasing_agent. B80 filed as backfill.
DROP POLICY IF EXISTS "manager_own_vehicles" ON vehicles;
CREATE POLICY "manager_own_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── 5. resident_own_vehicles ────────────────────────────────────
-- Tuple-IN on (property, unit) per the multi-residency forward-compat
-- refinement. FOR ALL so residents can INSERT new vehicle requests
-- (status=pending, is_active=false) and UPDATE cosmetic descriptors.
-- WITH CHECK matches USING — INSERTs and UPDATEs must keep the row
-- within the resident's own (property, unit) tuple.
DROP POLICY IF EXISTS "resident_own_vehicles" ON vehicles;
CREATE POLICY "resident_own_vehicles" ON vehicles
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  )
  WITH CHECK (
    (get_my_role() = 'resident'::text)
    AND ((property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — visitor_passes RLS
-- ════════════════════════════════════════════════════════════════════
-- Four policies (admin / company_admin / manager+leasing_agent /
-- resident). NO driver policy — drivers don't read visitor_passes
-- directly today; the pm_plate_lookup RPC (B70, SECURITY DEFINER)
-- handles their visitor-pass lookups internally. NO anon policy —
-- the anon INSERT path goes through create_visitor_pass RPC (PART 1).
--
-- Resident policy uses tuple-IN on (property, visiting_unit) → matches
-- residents.(property, unit). Same multi-residency forward-compat.

ALTER TABLE visitor_passes ENABLE ROW LEVEL SECURITY;

-- ── 1. admin_all_visitor_passes ─────────────────────────────────
DROP POLICY IF EXISTS "admin_all_visitor_passes" ON visitor_passes;
CREATE POLICY "admin_all_visitor_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

-- ── 2. company_admin_own_visitor_passes ────────────────────────
DROP POLICY IF EXISTS "company_admin_own_visitor_passes" ON visitor_passes;
CREATE POLICY "company_admin_own_visitor_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE (properties.company ~~* get_my_company())
    ))
  );

-- ── 3. manager_own_visitor_passes (includes leasing_agent) ─────
DROP POLICY IF EXISTS "manager_own_visitor_passes" ON visitor_passes;
CREATE POLICY "manager_own_visitor_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── 4. resident_own_visitor_passes ─────────────────────────────
-- Tuple-IN on (property, visiting_unit) matched against
-- residents.(property, unit). visiting_unit IS the unit the visitor
-- is visiting — for resident-issued passes, this equals the resident's
-- own unit.
DROP POLICY IF EXISTS "resident_own_visitor_passes" ON visitor_passes;
CREATE POLICY "resident_own_visitor_passes" ON visitor_passes
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  )
  WITH CHECK (
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
--   -- Expected 5 rows (polcmd: *=ALL):
--   --   admin_all_vehicles              *
--   --   company_admin_own_vehicles      *
--   --   driver_own_vehicles             *
--   --   manager_own_vehicles            *
--   --   resident_own_vehicles           *
--
-- ── B. vehicles policy USING expressions ────────────────────────────
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy WHERE polrelid = 'vehicles'::regclass
--   ORDER BY polname;
--   -- Each using_expr should match the body of the corresponding
--   -- CREATE POLICY statement above.
--
-- ── C. visitor_passes policy inventory ──────────────────────────────
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'visitor_passes'::regclass ORDER BY polname;
--   -- Expected 4 rows (all polcmd=*):
--   --   admin_all_visitor_passes        *
--   --   company_admin_own_visitor_passes  *
--   --   manager_own_visitor_passes      *
--   --   resident_own_visitor_passes     *
--
-- ── D. visitor_passes policy USING expressions ──────────────────────
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy WHERE polrelid = 'visitor_passes'::regclass
--   ORDER BY polname;
--
-- ── E. RLS enabled on both tables ───────────────────────────────────
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('vehicles', 'visitor_passes');
--   -- Expected: both relrowsecurity = TRUE
--
-- ── F. Column shape sanity (P9 — post-apply confirmation) ───────────
--   SELECT 'vehicles.property' AS field, data_type
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='vehicles' AND column_name='property'
--   UNION ALL
--   SELECT 'visitor_passes.property', data_type
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='visitor_passes' AND column_name='property';
--   -- Expected: both 'text'
--
-- ── G. RPC functions exist + SECURITY DEFINER + correct GRANTs ──────
--   SELECT proname, prosecdef AS is_security_definer, provolatile
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('check_resident_plate', 'create_visitor_pass')
--   ORDER BY proname;
--   -- Expected:
--   --   check_resident_plate    t   s   (s = STABLE)
--   --   create_visitor_pass     t   v   (v = VOLATILE — writes)
--
--   SELECT routine_name, grantee
--   FROM information_schema.routine_privileges
--   WHERE routine_schema='public'
--     AND routine_name IN ('check_resident_plate', 'create_visitor_pass')
--     AND privilege_type='EXECUTE'
--   ORDER BY routine_name, grantee;
--   -- Expected: each routine appears with grantee IN ('anon', 'authenticated').
--
-- ── H. Anon smoke 1 — check_resident_plate returns boolean ──────────
-- As anon (run from supabase JS client in an anon session, OR via
-- impersonated anon role in SQL Editor):
--   SELECT check_resident_plate('TEST-PLATE-FAKE', 'Test Property');
--   -- Expected: false (or true if a real test plate exists at that property)
--
-- ── I. Anon smoke 2 — create_visitor_pass returns BIGINT ────────────
-- DESTRUCTIVE — only run in dev/staging.
--   SELECT create_visitor_pass(
--     'TESTVPLATE',
--     'Smoke Test Visitor',
--     'A-101',
--     'Test Property',     -- must exist or trigger may complain
--     'White sedan',
--     2
--   );
--   -- Expected: BIGINT (new visitor_passes.id). Verify post-call:
--   --   • visitor_passes row exists with normalized plate + expires_at
--   --   • audit_logs row exists with action='VISITOR_TOS_ACCEPTED'
--
-- ── J. Anon SELECT on vehicles returns zero rows (RLS blocks) ───────
-- As anon:
--   SELECT count(*) FROM vehicles;
--   -- Expected: 0. RLS allows no anon read access (no anon policy
--   -- exists; PART 2's policies are TO authenticated only).
--
-- ── K. Anon SELECT on visitor_passes returns zero rows ──────────────
-- As anon:
--   SELECT count(*) FROM visitor_passes;
--   -- Expected: 0. Same reason as J.
--
-- ── POST-APPLY SMOKE CHECKLIST (Finding 6) ──────────────────────────
-- 1. As resident — fetchVehicles returns own unit's rows only
-- 2. As resident — INSERT new vehicle succeeds; INSERT with wrong unit fails
-- 3. As manager — fetchVehicles on assigned property returns rows;
--    on unassigned property returns zero
-- 4. As leasing_agent (if test rows exist) — same as manager
-- 5. As driver — plate lookup at scanPlate returns rows for own company's
--    properties; fails on other company's
-- 6. As anon (incognito on /visitor) — plate precheck works (RPC);
--    direct .from('vehicles') would return zero
-- 7. As anon (incognito on /visitor) — visitor pass submit works (RPC);
--    direct .from('visitor_passes').insert(...) would fail
-- 8. As admin — bulk update on property completes (admin FOR ALL covers it)
--
-- ── ROLLBACK (if needed — TWO-STEP) ─────────────────────────────────
-- Step 1 (CODE): revert the /visitor page to use direct .from() calls.
--   This MUST precede the DB rollback — if the RPCs get dropped while
--   the live code still calls .rpc(), the visitor flow breaks.
-- Step 2 (DB): run the following in SQL Editor:
--
--   BEGIN;
--   DROP POLICY IF EXISTS admin_all_vehicles ON vehicles;
--   DROP POLICY IF EXISTS company_admin_own_vehicles ON vehicles;
--   DROP POLICY IF EXISTS driver_own_vehicles ON vehicles;
--   DROP POLICY IF EXISTS manager_own_vehicles ON vehicles;
--   DROP POLICY IF EXISTS resident_own_vehicles ON vehicles;
--   ALTER TABLE vehicles DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS admin_all_visitor_passes ON visitor_passes;
--   DROP POLICY IF EXISTS company_admin_own_visitor_passes ON visitor_passes;
--   DROP POLICY IF EXISTS manager_own_visitor_passes ON visitor_passes;
--   DROP POLICY IF EXISTS resident_own_visitor_passes ON visitor_passes;
--   ALTER TABLE visitor_passes DISABLE ROW LEVEL SECURITY;
--   DROP FUNCTION IF EXISTS public.check_resident_plate(TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.create_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER);
--   COMMIT;
--
-- Supabase point-in-time restore is the nuclear option if anything else
-- goes wrong.
-- ════════════════════════════════════════════════════════════════════
