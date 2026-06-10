-- ═══════════════════════════════════════════════════════════════════
-- B155.2 F10 — FOR-ALL-admits-DELETE sweep (5 tables)
-- Date:   2026-06-10
-- Branch: b155-2-f10/for-all-delete-sweep
--
-- WHAT'S CHANGING
-- ───────────────
-- The F1-F7 audit summary missed that several `FOR ALL` policies on
-- non-admin roles silently admitted DELETE — same Postgres mechanic
-- as F7 user_roles (WITH CHECK doesn't gate DELETE; FOR ALL admits
-- it). F10 sweeps the same pattern across 5 more tables, splitting
-- each FOR ALL into separate SELECT / INSERT / UPDATE policies that
-- preserve the existing USING/WITH-CHECK scope, and recreates DELETE
-- per role per the locked intent:
--
--   properties / drivers / vehicles / visitor_passes
--     → DELETE = admin only (admin still admits via admin_all_X
--       which stays FOR ALL — unchanged)
--
--   violations
--     → DELETE = NO admin policy (confirmed violations are immutable)
--       PLUS three per-role draft-discard policies gated on
--       `is_confirmed = false` (the existing 8 hard-delete UI sites
--       all operate on drafts; this preserves them unchanged)
--
-- WHY (the security finding)
-- ──────────────────────────
-- The original F7 user_roles fix was one instance of the FOR-ALL
-- mechanic. The matrix discipline requires sweeping every sibling —
-- same arc as B166's wildcard fix generalizing from owner-trim to
-- B150 cascade. The catalog dump shows 5 more tables with the same
-- shape. The June 10 lock #3 ("hard delete = admin only" for
-- residents/properties/drivers and the "analogous removal-vs-
-- deactivation" cells) is the intent these tightens encode.
--
-- WHAT'S NOT CHANGING
-- ───────────────────
-- spaces × CA / manager DELETE — parking-space configuration is
-- legitimate management action (re-stripe / renumber / remove).
-- Left FOR ALL.
--
-- storage_facilities × CA DELETE — CA may legitimately retire their
-- own VSF lot. Left FOR ALL. (F6 already removed manager/leasing
-- *read* on storage_facilities; CA management is separate.)
--
-- residents — already correctly split (residents_admin_all FOR ALL;
-- separate residents_company_admin_insert / _read / _update +
-- residents_manager_insert / _read / _update + residents_self_insert
-- + resident_read_own). No CA DELETE policy exists. ✓
--
-- ILIKE on property/company names — left intact. B174 sweeps these
-- as a separate arc with the matrix as the regression gate.
--
-- IMMUTABILITY PRECONDITION (verified before drafting)
-- ────────────────────────────────────────────────────
-- 1. is_confirmed exists (migration 20260514, default flipped to
--    FALSE in 20260515).
-- 2. NO revert path: only two `.update({ is_confirmed: true })`
--    sites in the codebase (driver:509, CA:1360); zero
--    `.update({ is_confirmed: false })` anywhere. The
--    immutability guarantee holds at the code level.
-- 3. All 8 draft-discard UI sites filter on is_confirmed=false
--    before delete; the new gated DELETE policies admit them
--    unchanged.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste single-run. Pre-apply verification dumps current
-- FOR ALL policies on the 5 tables; post-apply confirms split shape.
-- Must apply AFTER:
--   1. 20260610_b155_2_f9_helper_lower_match.sql
--   2. 20260610_b155_2_policy_tightens.sql
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Expected current FOR ALL policies on the 5 tables.
SELECT tablename, policyname, cmd AS verb, roles,
       qual AS using_clause, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND (tablename, policyname) IN (
     ('properties',     'company_admin_own_properties'),
     ('drivers',        'company_admin_own_drivers'),
     ('vehicles',       'company_admin_own_vehicles'),
     ('vehicles',       'manager_own_vehicles'),
     ('vehicles',       'resident_own_vehicles'),
     ('visitor_passes', 'company_admin_own_passes'),
     ('visitor_passes', 'manager_own_passes'),
     ('visitor_passes', 'resident_own_passes'),
     ('violations',     'admin_all_violations'),
     ('violations',     'company_admin_own_violations'),
     ('violations',     'driver_own_violations'),
     ('violations',     'manager_own_violations')
   )
 ORDER BY tablename, policyname;


-- ═══════════════════════════════════════════════════════════════════
-- PROPERTIES — CA: FOR ALL → S/I/U (admin DELETE preserved via
-- admin_all_properties FOR ALL — untouched)
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS company_admin_own_properties ON properties;

CREATE POLICY company_admin_select_properties ON properties
  FOR SELECT TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

CREATE POLICY company_admin_insert_properties ON properties
  FOR INSERT TO public
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

CREATE POLICY company_admin_update_properties ON properties
  FOR UPDATE TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );


-- ═══════════════════════════════════════════════════════════════════
-- DRIVERS — CA: FOR ALL → S/I/U (admin DELETE preserved via
-- admin_all_drivers FOR ALL — untouched)
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS company_admin_own_drivers ON drivers;

CREATE POLICY company_admin_select_drivers ON drivers
  FOR SELECT TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

CREATE POLICY company_admin_insert_drivers ON drivers
  FOR INSERT TO public
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

CREATE POLICY company_admin_update_drivers ON drivers
  FOR UPDATE TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );


-- ═══════════════════════════════════════════════════════════════════
-- VEHICLES — CA / manager / resident: FOR ALL → S/I/U
-- (admin DELETE preserved via admin_all_vehicles FOR ALL — untouched)
-- All hard-delete paths verified absent (grep clean); B166 lifecycle
-- is is_active=false.
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS company_admin_own_vehicles ON vehicles;

CREATE POLICY company_admin_select_vehicles ON vehicles
  FOR SELECT TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_insert_vehicles ON vehicles
  FOR INSERT TO public
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_update_vehicles ON vehicles
  FOR UPDATE TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );


DROP POLICY IF EXISTS manager_own_vehicles ON vehicles;

CREATE POLICY manager_select_vehicles ON vehicles
  FOR SELECT TO public
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_insert_vehicles ON vehicles
  FOR INSERT TO public
  WITH CHECK (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_update_vehicles ON vehicles
  FOR UPDATE TO public
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  )
  WITH CHECK (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );


DROP POLICY IF EXISTS resident_own_vehicles ON vehicles;

CREATE POLICY resident_select_vehicles ON vehicles
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

CREATE POLICY resident_insert_vehicles ON vehicles
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'resident'::text)
    AND ((property, unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

CREATE POLICY resident_update_vehicles ON vehicles
  FOR UPDATE TO authenticated
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


-- ═══════════════════════════════════════════════════════════════════
-- VISITOR_PASSES — CA / manager / resident: FOR ALL → S/I/U
-- (admin DELETE preserved via admin_all_passes FOR ALL — untouched)
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS company_admin_own_passes ON visitor_passes;

CREATE POLICY company_admin_select_passes ON visitor_passes
  FOR SELECT TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_insert_passes ON visitor_passes
  FOR INSERT TO public
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_update_passes ON visitor_passes
  FOR UPDATE TO public
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );


DROP POLICY IF EXISTS manager_own_passes ON visitor_passes;

CREATE POLICY manager_select_passes ON visitor_passes
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_insert_passes ON visitor_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_update_passes ON visitor_passes
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  )
  WITH CHECK (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );


DROP POLICY IF EXISTS resident_own_passes ON visitor_passes;

CREATE POLICY resident_select_passes ON visitor_passes
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND ((property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

CREATE POLICY resident_insert_passes ON visitor_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'resident'::text)
    AND ((property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
    ))
  );

CREATE POLICY resident_update_passes ON visitor_passes
  FOR UPDATE TO authenticated
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


-- ═══════════════════════════════════════════════════════════════════
-- VIOLATIONS — Option A: confirmed = immutable; drafts discardable
-- by creator-role.
--
-- Split admin/CA/driver/manager FOR ALL into S/I/U; recreate DELETE
-- ONLY for CA/driver/manager gated on is_confirmed=false (drafts).
-- NO admin DELETE policy → admin cannot delete (drafts or confirmed).
-- Service-role bypasses RLS for any DB-level cleanup.
-- ═══════════════════════════════════════════════════════════════════

-- ── admin (NO DELETE) ──────────────────────────────────────────────
DROP POLICY IF EXISTS admin_all_violations ON violations;

CREATE POLICY admin_select_violations ON violations
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin'::text);

CREATE POLICY admin_insert_violations ON violations
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'admin'::text);

CREATE POLICY admin_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'admin'::text)
  WITH CHECK (get_my_role() = 'admin'::text);
-- NO admin DELETE policy. Admin must use the void mechanism (B175).


-- ── company_admin (DELETE = drafts only) ────────────────────────────
DROP POLICY IF EXISTS company_admin_own_violations ON violations;

CREATE POLICY company_admin_select_violations ON violations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_insert_violations ON violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY company_admin_delete_own_drafts ON violations
  FOR DELETE TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (is_confirmed = false)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );


-- ── driver (DELETE = drafts only) ───────────────────────────────────
DROP POLICY IF EXISTS driver_own_violations ON violations;

CREATE POLICY driver_select_violations ON violations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY driver_insert_violations ON violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY driver_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

CREATE POLICY driver_delete_own_drafts ON violations
  FOR DELETE TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (is_confirmed = false)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );


-- ── manager (DELETE = drafts only) ──────────────────────────────────
-- leasing_agent REMOVED from the role array (was previously included
-- via manager_own_violations FOR ALL). Violations are the enforcement
-- evidence surface; leasing_agent is a leasing-office role with no
-- enforcement function. Same family as F5 (drivers manager-only) and
-- F6 (storage_facilities PM-track read removed). NEG is specific to
-- violations — leasing_agent retains writes on vehicles, visitor_
-- passes, and residents per the existing intent.
DROP POLICY IF EXISTS manager_own_violations ON violations;

CREATE POLICY manager_select_violations ON violations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_insert_violations ON violations
  FOR INSERT TO authenticated
  WITH CHECK (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  )
  WITH CHECK (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

CREATE POLICY manager_delete_own_drafts ON violations
  FOR DELETE TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND (is_confirmed = false)
    AND (property ~~* ANY (get_my_properties()))
  );


-- ── POST-APPLY VERIFICATION (policy inventory per table) ────────────
SELECT tablename, policyname, cmd AS verb, roles
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('properties','drivers','vehicles','visitor_passes','violations')
 ORDER BY tablename, cmd, policyname;


-- ── POST-APPLY VERIFICATION (per-cell sanity) ───────────────────────

-- properties: company_admin_own_properties GONE; 3 split policies
-- present (no _delete_ policy for CA).
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='properties' AND policyname LIKE 'company_admin_%';
-- Expected: 3 rows (company_admin_select_properties, _insert_, _update_).

-- drivers: same shape.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='drivers' AND policyname LIKE 'company_admin_%';
-- Expected: 3 rows.

-- vehicles: company_admin_own/manager_own/resident_own all GONE;
-- 9 split policies present (3 per role, no _delete_ policies).
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='vehicles'
   AND policyname NOT LIKE 'admin_%' AND policyname NOT LIKE 'driver_%';
-- Expected: 9 rows (3 CA + 3 manager + 3 resident).

-- visitor_passes: same shape — 9 split policies.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='visitor_passes'
   AND policyname NOT LIKE 'admin_%';
-- Expected: 9 rows.

-- violations: admin/CA/driver/manager FOR ALL all GONE; 12 split
-- policies + 3 DELETE-draft policies present.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='violations'
 ORDER BY policyname;
-- Expected:
--   admin_select_violations          SELECT  (NEW; no admin DELETE)
--   admin_insert_violations          INSERT
--   admin_update_violations          UPDATE
--   company_admin_select_violations  SELECT
--   company_admin_insert_violations  INSERT
--   company_admin_update_violations  UPDATE
--   company_admin_delete_own_drafts  DELETE  (gated is_confirmed=false)
--   driver_select_violations         SELECT
--   driver_insert_violations         INSERT
--   driver_update_violations         UPDATE
--   driver_delete_own_drafts         DELETE  (gated is_confirmed=false)
--   manager_select_violations        SELECT
--   manager_insert_violations        INSERT
--   manager_update_violations        UPDATE
--   manager_delete_own_drafts        DELETE  (gated is_confirmed=false)
--   resident_own_violations          SELECT  (unchanged)

-- Confirm violations DELETE policies require is_confirmed=false:
SELECT policyname, qual AS using_clause FROM pg_policies
 WHERE schemaname='public' AND tablename='violations' AND cmd='DELETE';
-- Expected: 3 rows, each USING clause contains 'is_confirmed = false'.

-- Confirm NO admin DELETE policy on violations exists:
SELECT count(*) AS admin_delete_policies FROM pg_policies
 WHERE schemaname='public' AND tablename='violations'
   AND cmd='DELETE'
   AND policyname LIKE 'admin%';
-- Expected: 0.


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- 1. Smoke (consolidated) — 5 original B155.2 checks + F10 DELETE
--    checks against the complete F9 + tightens + F10 state.
-- 2. Encode the full spec table (clean post-F10 intent) for Jose's
--    cell-by-cell review (fresh session).
-- 3. Probe build, after spec lock.
-- 4. B175 — confirmed-violation void mechanism. NOT bundled here;
--    A1-launch-gate fast-follow (voided_at / voided_by / void_reason
--    columns + UI + VIOLATION_VOIDED audit). Without B175, a
--    mistyped confirmed violation is permanent in prod.
