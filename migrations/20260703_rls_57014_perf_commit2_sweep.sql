-- ════════════════════════════════════════════════════════════════════
-- RLS 57014 perf fix — COMMIT 2 (preventive sweep)
-- Locked: July 3, 2026
--
-- Extends the Commit 1 (e826367) InitPlan-hoist pattern to every
-- SELECT/INSERT/UPDATE/DELETE policy on the 8 remaining Commit 2-scope
-- tables. Same class-fix; scope expanded so no manager-session or
-- driver-session query 500s under the 8s statement_timeout even as A1
-- accumulates real violation + pass volume.
--
-- Scope (per live pg_policies enumeration 2026-07-03 — not migration
-- grep, per Commit 1 lesson):
--   dispute_requests          — 6 policies
--   guest_authorizations      — 4 policies
--   space_assignment_history  — 3 policies (2 correlated EXISTS)
--   space_requests            — 4 policies (incl. = ANY parity fix)
--   space_residents           — 3 policies (2 correlated EXISTS)
--   vehicles                  — 9 policies
--   violations                — 16 policies
--   visitor_passes            — 11 policies
--   TOTAL                     — 56 policies
--
-- Idioms (from Commit 1):
--   scalar  (get_my_role, get_my_company, auth.jwt)   → (SELECT fn())
--   array   (get_my_properties)                       → ANY (SELECT unnest(get_my_properties()))
--   correlated EXISTS                                 → outer wrap + inner helper wraps
--                                                       (subquery still per row; inner hoists don't help there
--                                                       but eliminate the outer per-row calls that DO dominate)
--   IN (SELECT ...) uncorrelated                      → hoists naturally; wrap inner helpers for consistency
--
-- Parity fix (rolled in — was parked as "Commit B" earlier):
--   space_requests_manager_property_scoped_space_requests:
--     was  property = ANY (get_my_properties())      -- case-SENSITIVE
--     now  property ~~* ANY (SELECT unnest(get_my_properties()))  -- matches vehicles precedent
--
-- SEMANTIC EQUIVALENCE:
--   Byte-for-byte modulo the wrap and the single case-sensitivity fix
--   noted above. Role sets preserved. Property/company matching semantics
--   preserved. IN-subquery shapes preserved. EXISTS-subquery correlation
--   preserved. Every DROP+CREATE below is idempotent — safe to re-apply.
--
-- Verification (post-apply):
--   scripts/probe-commit2-timing.ts fires spot-check timing on violations
--   + visitor_passes under manager session; targets <500ms per query.
--   Row-set equivalence per role via same probe pattern.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- dispute_requests (6 policies)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_disputes" ON public.dispute_requests;
CREATE POLICY "admin_all_disputes" ON public.dispute_requests
  FOR ALL TO public
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "resident_insert_disputes" ON public.dispute_requests;
CREATE POLICY "resident_insert_disputes" ON public.dispute_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND resident_email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
  );

DROP POLICY IF EXISTS "company_admin_own_disputes" ON public.dispute_requests;
CREATE POLICY "company_admin_own_disputes" ON public.dispute_requests
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_select_disputes" ON public.dispute_requests;
CREATE POLICY "manager_select_disputes" ON public.dispute_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_select_disputes" ON public.dispute_requests;
CREATE POLICY "resident_select_disputes" ON public.dispute_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND resident_email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
  );

DROP POLICY IF EXISTS "manager_update_disputes" ON public.dispute_requests;
CREATE POLICY "manager_update_disputes" ON public.dispute_requests
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

-- ════════════════════════════════════════════════════════════════════
-- guest_authorizations (4 policies)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_guest_auths" ON public.guest_authorizations;
CREATE POLICY "admin_all_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_guest_auths" ON public.guest_authorizations;
CREATE POLICY "company_admin_own_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND company ~~* (SELECT get_my_company())
  );

DROP POLICY IF EXISTS "manager_own_guest_auths" ON public.guest_authorizations;
CREATE POLICY "manager_own_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "driver_read_guest_auths" ON public.guest_authorizations;
CREATE POLICY "driver_read_guest_auths" ON public.guest_authorizations
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- space_assignment_history (3 policies — 2 correlated EXISTS)
-- ════════════════════════════════════════════════════════════════════
-- The EXISTS subquery is correlated (WHERE s.id = <outer>.space_id) so
-- it re-runs per outer row. We wrap the outer role check AND the inner
-- helper calls — outer wrap eliminates the per-row role-lookup entirely;
-- inner wrap gives the planner a chance to hoist inside the correlated
-- subquery. Full per-row cost of the EXISTS remains but the dominant
-- helper cost is gone.

DROP POLICY IF EXISTS "admin_all_space_history" ON public.space_assignment_history;
CREATE POLICY "admin_all_space_history" ON public.space_assignment_history
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_space_history" ON public.space_assignment_history;
CREATE POLICY "company_admin_own_space_history" ON public.space_assignment_history
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.id = space_assignment_history.space_id
        AND s.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_own_space_history" ON public.space_assignment_history;
CREATE POLICY "manager_own_space_history" ON public.space_assignment_history
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.id = space_assignment_history.space_id
        AND s.property ~~* ANY (SELECT unnest(get_my_properties()))
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- space_requests (4 policies — includes = ANY parity fix)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_space_requests" ON public.space_requests;
CREATE POLICY "admin_all_space_requests" ON public.space_requests
  FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "ca_company_scoped_space_requests" ON public.space_requests;
CREATE POLICY "ca_company_scoped_space_requests" ON public.space_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

-- PARITY FIX: was `property = ANY (get_my_properties())` — case-SENSITIVE.
-- Now `property ~~* ANY (SELECT unnest(get_my_properties()))` — matches
-- shipped vehicles/violations/visitor_passes precedent. Closes the
-- previously-parked "Commit B" residual from the parity arc.
DROP POLICY IF EXISTS "manager_property_scoped_space_requests" ON public.space_requests;
CREATE POLICY "manager_property_scoped_space_requests" ON public.space_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_own_space_requests" ON public.space_requests;
CREATE POLICY "resident_own_space_requests" ON public.space_requests
  FOR SELECT TO authenticated
  USING (lower(resident_email) = lower(((SELECT auth.jwt()) ->> 'email'::text)));

-- ════════════════════════════════════════════════════════════════════
-- space_residents (3 policies — 2 correlated EXISTS)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_space_residents" ON public.space_residents;
CREATE POLICY "admin_all_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_space_residents" ON public.space_residents;
CREATE POLICY "company_admin_own_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.id = space_residents.space_id
        AND s.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_own_space_residents" ON public.space_residents;
CREATE POLICY "manager_own_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND EXISTS (
      SELECT 1 FROM spaces s
      WHERE s.id = space_residents.space_id
        AND s.property ~~* ANY (SELECT unnest(get_my_properties()))
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- vehicles (9 policies)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_vehicles" ON public.vehicles;
CREATE POLICY "admin_all_vehicles" ON public.vehicles
  FOR ALL TO public
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_insert_vehicles" ON public.vehicles;
CREATE POLICY "company_admin_insert_vehicles" ON public.vehicles
  FOR INSERT TO public
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_insert_vehicles" ON public.vehicles;
CREATE POLICY "manager_insert_vehicles" ON public.vehicles
  FOR INSERT TO public
  WITH CHECK (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "company_admin_select_vehicles" ON public.vehicles;
CREATE POLICY "company_admin_select_vehicles" ON public.vehicles
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_read_vehicles" ON public.vehicles;
CREATE POLICY "driver_read_vehicles" ON public.vehicles
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_select_vehicles" ON public.vehicles;
CREATE POLICY "manager_select_vehicles" ON public.vehicles
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_select_vehicles" ON public.vehicles;
CREATE POLICY "resident_select_vehicles" ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
    )
  );

DROP POLICY IF EXISTS "company_admin_update_vehicles" ON public.vehicles;
CREATE POLICY "company_admin_update_vehicles" ON public.vehicles
  FOR UPDATE TO public
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_update_vehicles" ON public.vehicles;
CREATE POLICY "manager_update_vehicles" ON public.vehicles
  FOR UPDATE TO public
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  )
  WITH CHECK (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

-- ════════════════════════════════════════════════════════════════════
-- violations (16 policies)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "company_admin_delete_own_drafts" ON public.violations;
CREATE POLICY "company_admin_delete_own_drafts" ON public.violations
  FOR DELETE TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND is_confirmed = false
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_delete_own_drafts" ON public.violations;
CREATE POLICY "driver_delete_own_drafts" ON public.violations
  FOR DELETE TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND is_confirmed = false
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_delete_own_drafts" ON public.violations;
CREATE POLICY "manager_delete_own_drafts" ON public.violations
  FOR DELETE TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND is_confirmed = false
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "admin_insert_violations" ON public.violations;
CREATE POLICY "admin_insert_violations" ON public.violations
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_insert_violations" ON public.violations;
CREATE POLICY "company_admin_insert_violations" ON public.violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_insert_violations" ON public.violations;
CREATE POLICY "driver_insert_violations" ON public.violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_insert_violations" ON public.violations;
CREATE POLICY "manager_insert_violations" ON public.violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "admin_select_violations" ON public.violations;
CREATE POLICY "admin_select_violations" ON public.violations
  FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_select_violations" ON public.violations;
CREATE POLICY "company_admin_select_violations" ON public.violations
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_select_violations" ON public.violations;
CREATE POLICY "driver_select_violations" ON public.violations
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_select_violations" ON public.violations;
CREATE POLICY "manager_select_violations" ON public.violations
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_own_violations" ON public.violations;
CREATE POLICY "resident_own_violations" ON public.violations
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND plate IN (
      SELECT vehicles.plate FROM vehicles
      WHERE vehicles.property IN (
        SELECT residents.property FROM residents
        WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
      )
    )
  );

DROP POLICY IF EXISTS "admin_update_violations" ON public.violations;
CREATE POLICY "admin_update_violations" ON public.violations
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'admin'::text
    AND is_confirmed = false
  )
  WITH CHECK ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_update_violations" ON public.violations;
CREATE POLICY "company_admin_update_violations" ON public.violations
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND is_confirmed = false
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_update_violations" ON public.violations;
CREATE POLICY "driver_update_violations" ON public.violations
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND is_confirmed = false
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_update_violations" ON public.violations;
CREATE POLICY "manager_update_violations" ON public.violations
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND is_confirmed = false
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'manager'::text
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

-- ════════════════════════════════════════════════════════════════════
-- visitor_passes (11 policies)
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "admin_all_passes" ON public.visitor_passes;
CREATE POLICY "admin_all_passes" ON public.visitor_passes
  FOR ALL TO public
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_insert_passes" ON public.visitor_passes;
CREATE POLICY "company_admin_insert_passes" ON public.visitor_passes
  FOR INSERT TO public
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_insert_passes" ON public.visitor_passes;
CREATE POLICY "manager_insert_passes" ON public.visitor_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_insert_passes" ON public.visitor_passes;
CREATE POLICY "resident_insert_passes" ON public.visitor_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
    )
  );

DROP POLICY IF EXISTS "company_admin_select_passes" ON public.visitor_passes;
CREATE POLICY "company_admin_select_passes" ON public.visitor_passes
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "driver_read_passes" ON public.visitor_passes;
CREATE POLICY "driver_read_passes" ON public.visitor_passes
  FOR SELECT TO public
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_select_passes" ON public.visitor_passes;
CREATE POLICY "manager_select_passes" ON public.visitor_passes
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_select_passes" ON public.visitor_passes;
CREATE POLICY "resident_select_passes" ON public.visitor_passes
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
    )
  );

DROP POLICY IF EXISTS "company_admin_update_passes" ON public.visitor_passes;
CREATE POLICY "company_admin_update_passes" ON public.visitor_passes
  FOR UPDATE TO public
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

DROP POLICY IF EXISTS "manager_update_passes" ON public.visitor_passes;
CREATE POLICY "manager_update_passes" ON public.visitor_passes
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  )
  WITH CHECK (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

DROP POLICY IF EXISTS "resident_update_passes" ON public.visitor_passes;
CREATE POLICY "resident_update_passes" ON public.visitor_passes
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* ((SELECT auth.jwt()) ->> 'email'::text)
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- ── A. shape confirmed — 56 rows, all containing hoist idioms.
--   SELECT tablename, policyname, cmd,
--     (qual ~* 'SELECT\s+get_my_(role|company|properties)\s*\(')  AS qual_role_hoist,
--     (qual ~* 'unnest\s*\(\s*get_my_properties')                 AS qual_array_hoist,
--     (qual ~* 'SELECT\s+auth\.jwt\s*\(')                         AS qual_jwt_hoist,
--     (with_check ~* 'SELECT\s+get_my_(role|company|properties)\s*\(') AS wc_role_hoist,
--     (with_check ~* 'unnest\s*\(\s*get_my_properties')           AS wc_array_hoist
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN (
--       'dispute_requests','guest_authorizations',
--       'space_assignment_history','space_requests','space_residents',
--       'vehicles','violations','visitor_passes'
--     )
--   ORDER BY tablename, cmd, policyname;
--
-- ── B. timing spot-check (violations + visitor_passes)
--   npx tsx --env-file=.env.local scripts/probe-commit2-timing.ts
--   Target: <500ms per query per role, no 57014.
--   Row-set: manager at French Quarter sees SAME rows on both tables
--   as before (byte-for-byte modulo the space_requests case-parity fix).
--
-- ── C. semantic equivalence — cross-role
--   Same probe verifies manager / CA / admin / driver / resident row-sets
--   against super-user baseline. Any drift → HALT, do not push.
-- ════════════════════════════════════════════════════════════════════
