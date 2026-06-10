-- ═══════════════════════════════════════════════════════════════════
-- B155.2 — Policy tightens for F1 / F2 / F4 / F5 / F6 / F7
-- Date:   2026-06-10
-- Branch: b155-2/helper-fix-plus-policy-tightens
--
-- WHAT'S CHANGING
-- ───────────────
-- Six locked-intent diffs vs as-built. Each closes an over-permission
-- surfaced by the Phase A catalog dump on 2026-06-10.
--
-- F1 — dispute_requests × manager: FOR ALL → SELECT + UPDATE only.
--      Manager reads + resolves. No INSERT (residents file), no DELETE
--      (audit-relevant records; don't allow erase).
--
-- F2 — dispute_requests × resident: FOR ALL → SELECT + INSERT only.
--      Resident files + views own dispute. No UPDATE (edit-after-
--      filing), no DELETE (withdraw-by-erase).
--
-- F4 — audit_logs INSERT: wide-open → self-attribution.
--      WITH CHECK tightened to
--        auth.role() = 'authenticated'
--        AND lower(user_email) = lower(auth.jwt() ->> 'email')
--      Audit row must be self-attributed. SECURITY DEFINER RPCs
--      (pm_plate_lookup, create_visitor_pass) bypass RLS by design —
--      unaffected. Client-side audit writes have been patched in the
--      same release to (a) drop the 'unknown' fallback, (b) add a
--      user_email key to the registration-consent audit at
--      register/page.tsx (the legal-evidence row), (c) add defensive
--      early-return guards on the admin + CA auditLog helpers.
--
-- F5 — drivers × manager SELECT: company-wide → property-assignment.
--      Was `company ILIKE get_my_company()` (manager saw every driver
--      in the company). Now manager sees only drivers whose
--      assigned_properties overlap with get_my_properties(), OR drivers
--      tagged with 'All' (case-insensitive — defensive belt-and-
--      suspenders for any future / imported / bulk-loaded row).
--      Leasing_agent stays NEG (drivers are pure enforcement; LA has
--      no operational need — same logic as F6 removing PM-track
--      storage_facilities read).
--
-- F6 — storage_facilities × manager + leasing_agent: REMOVE.
--      Storage facilities are enforcement/driver + CA concerns (tow
--      operator's VSF lots). PM-track has no UI surface that reads
--      this table (grep across app/manager/page.tsx returned zero
--      references). Dropping both PM-track SELECT policies leaves
--      nothing broken.
--
-- F7 — user_roles × CA FOR ALL: remove DELETE.
--      Was FOR ALL with WITH CHECK pinning role to the
--      ('manager','leasing_agent','driver','resident') set per B155.4.
--      Postgres applies WITH CHECK only to rows being written —
--      DELETE doesn't write a target row → CA could hard-delete any
--      of those user_roles rows, including their own. Split into
--      SELECT + INSERT + UPDATE; INSERT + UPDATE retain the role-pin.
--      DELETE = admin only (mirrors residents/properties/drivers per
--      the June 10 lock #3).
--
-- WHAT'S NOT CHANGING (intentionally)
-- ───────────────────────────────────
-- F3 (dispute_requests × leasing_agent) — stays NEG (as-built). The
-- June 10 reversal kept disputes manager-and-up; LA has no policy on
-- dispute_requests.
--
-- F8 (residents × leasing_agent INSERT + UPDATE) — kept as-built.
-- LA does normal leasing-office resident onboarding; scope is
-- already property-assignment via residents_manager_insert/update.
--
-- ILIKE in non-email predicates (property/company names) — left
-- intact. F9 covers helper bodies only; B174 will sweep policy
-- predicates as a separate arc with the matrix as the regression
-- gate. Don't half-convert in this migration.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste, single-run. Pre-apply verification dumps the
-- current policies-of-interest; post-apply verification confirms
-- the new shapes. Must apply AFTER:
--   1. The B155.2 F9 helper migration (helpers use lower()=lower())
--   2. The paired code patches deploy to Vercel (audit.ts /
--      register/page.tsx / admin auditLog / CA auditLog guards)
-- Otherwise legitimate audit-writes will silently fail in the gap
-- between the policy tightening and the code deploying.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Expected current shapes (the over-permissions about to be closed).
SELECT tablename, policyname, cmd AS verb, roles,
       qual AS using_clause, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND (tablename, policyname) IN (
     ('dispute_requests',  'manager_own_disputes'),
     ('dispute_requests',  'resident_own_disputes'),
     ('audit_logs',        'auth_insert_audit_logs'),
     ('drivers',           'manager_read_drivers'),
     ('storage_facilities','manager_read_own_facilities'),
     ('storage_facilities','leasing_agent_read_own_facilities'),
     ('user_roles',        'company_admin_own_users')
   )
 ORDER BY tablename, policyname;


-- ═══════════════════════════════════════════════════════════════════
-- F1 — dispute_requests × manager: FOR ALL → SELECT + UPDATE
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS manager_own_disputes ON dispute_requests;

CREATE POLICY manager_select_disputes ON dispute_requests
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property ~~* ANY (get_my_properties())
  );

CREATE POLICY manager_update_disputes ON dispute_requests
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property ~~* ANY (get_my_properties())
  )
  WITH CHECK (
    get_my_role() = 'manager'
    AND property ~~* ANY (get_my_properties())
  );


-- ═══════════════════════════════════════════════════════════════════
-- F2 — dispute_requests × resident: FOR ALL → SELECT + INSERT
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS resident_own_disputes ON dispute_requests;

CREATE POLICY resident_select_disputes ON dispute_requests
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'resident'
    AND resident_email ~~* (auth.jwt() ->> 'email')
  );

CREATE POLICY resident_insert_disputes ON dispute_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'resident'
    AND resident_email ~~* (auth.jwt() ->> 'email')
  );


-- ═══════════════════════════════════════════════════════════════════
-- F4 — audit_logs INSERT: wide-open → self-attribution
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS auth_insert_audit_logs ON audit_logs;

CREATE POLICY auth_insert_audit_logs_self ON audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.role() = 'authenticated'
    AND lower(user_email) = lower(auth.jwt() ->> 'email')
  );


-- ═══════════════════════════════════════════════════════════════════
-- F5 — drivers × manager SELECT: company-wide → property-assignment
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS manager_read_drivers ON drivers;

CREATE POLICY manager_read_drivers ON drivers
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'manager'
    AND company ILIKE get_my_company()
    AND (
      EXISTS (
        SELECT 1 FROM unnest(assigned_properties) ap
         WHERE lower(ap) = ANY (SELECT lower(p) FROM unnest(get_my_properties()) p)
      )
      OR EXISTS (
        SELECT 1 FROM unnest(assigned_properties) ap
         WHERE lower(ap) = 'all'
      )
    )
  );


-- ═══════════════════════════════════════════════════════════════════
-- F6 — storage_facilities × manager + leasing_agent: REMOVE
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS manager_read_own_facilities ON storage_facilities;
DROP POLICY IF EXISTS leasing_agent_read_own_facilities ON storage_facilities;


-- ═══════════════════════════════════════════════════════════════════
-- F7 — user_roles × CA FOR ALL: remove DELETE; split into S/I/U
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS company_admin_own_users ON user_roles;

CREATE POLICY company_admin_select_users ON user_roles
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND company ILIKE get_my_company()
  );

CREATE POLICY company_admin_insert_users ON user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND company ILIKE get_my_company()
    AND role = ANY (ARRAY['manager'::text, 'leasing_agent'::text, 'driver'::text, 'resident'::text])
  );

CREATE POLICY company_admin_update_users ON user_roles
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND company ILIKE get_my_company()
  )
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND company ILIKE get_my_company()
    AND role = ANY (ARRAY['manager'::text, 'leasing_agent'::text, 'driver'::text, 'resident'::text])
  );


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────
-- New policy inventory on the touched tables. Confirm by relation:
--   dispute_requests:  admin_all_disputes (unchanged), company_admin_own_disputes (unchanged SELECT),
--                      manager_select_disputes (NEW), manager_update_disputes (NEW),
--                      resident_select_disputes (NEW), resident_insert_disputes (NEW)
--   audit_logs:        admin_all_audit_logs (unchanged), auth_insert_audit_logs_self (NEW),
--                      company_admin_own_audit / driver_own_audit / manager_own_audit (unchanged)
--   drivers:           admin_all_drivers (unchanged), company_admin_own_drivers (unchanged),
--                      driver_read_own (unchanged), manager_read_drivers (NEW shape)
--   storage_facilities: admin_all_facilities (unchanged), company_admin_own_facilities (unchanged),
--                      driver_read_own_facilities (unchanged)
--                      [manager_read_own_facilities + leasing_agent_read_own_facilities REMOVED]
--   user_roles:        admin_all_user_roles (unchanged),
--                      company_admin_select_users / company_admin_insert_users /
--                      company_admin_update_users (NEW; replaces company_admin_own_users),
--                      authenticated_self_insert_resident (unchanged),
--                      user_read_own_role (unchanged)
SELECT tablename, policyname, cmd AS verb, roles,
       qual AS using_clause, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('dispute_requests','audit_logs','drivers','storage_facilities','user_roles')
 ORDER BY tablename, cmd, policyname;


-- ── POST-APPLY VERIFICATION (specific cells locked) ─────────────────
-- These six queries each return the post-change shape for the F1-F7
-- cells. Useful as a fast smoke check separate from the full inventory.

-- F1: manager_own_disputes should be GONE; manager_select_disputes +
--     manager_update_disputes should be PRESENT.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='dispute_requests'
   AND policyname LIKE 'manager_%';
-- Expected: 2 rows (manager_select_disputes, SELECT; manager_update_disputes, UPDATE).

-- F2: resident_own_disputes should be GONE; resident_select_disputes +
--     resident_insert_disputes should be PRESENT.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='dispute_requests'
   AND policyname LIKE 'resident_%';
-- Expected: 2 rows (resident_select_disputes, SELECT; resident_insert_disputes, INSERT).

-- F4: auth_insert_audit_logs should be GONE; auth_insert_audit_logs_self PRESENT
--     with WITH CHECK referencing user_email.
SELECT policyname, cmd, with_check FROM pg_policies
 WHERE schemaname='public' AND tablename='audit_logs'
   AND policyname LIKE 'auth_insert%';
-- Expected: 1 row, auth_insert_audit_logs_self, WITH CHECK contains
-- 'lower(user_email) = lower(auth.jwt()'.

-- F5: manager_read_drivers should have the new EXISTS predicate referencing
--     unnest(assigned_properties).
SELECT policyname, qual FROM pg_policies
 WHERE schemaname='public' AND tablename='drivers' AND policyname='manager_read_drivers';
-- Expected: USING contains 'unnest(assigned_properties)' and 'lower(p)'.

-- F6: Neither manager_read_own_facilities nor leasing_agent_read_own_facilities
--     should exist.
SELECT policyname FROM pg_policies
 WHERE schemaname='public' AND tablename='storage_facilities'
   AND policyname IN ('manager_read_own_facilities','leasing_agent_read_own_facilities');
-- Expected: 0 rows.

-- F7: company_admin_own_users should be GONE; company_admin_{select,insert,update}_users PRESENT.
SELECT policyname, cmd FROM pg_policies
 WHERE schemaname='public' AND tablename='user_roles'
   AND policyname LIKE 'company_admin_%';
-- Expected: 3 rows (select / insert / update), NO 'company_admin_own_users'.


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- After this migration applies, the spec-table encode step runs:
-- every relation × role × verb (including the NEW post-tighten cells)
-- gets a row for Jose's cell-by-cell review. NO probe code is written
-- until the spec table is locked.
