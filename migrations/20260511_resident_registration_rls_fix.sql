-- ════════════════════════════════════════════════════════════════════
-- Resident registration RLS fix (B1 + B2)
-- Locked: May 11, 2026
--
-- Audit (May 11) showed only ONE policy on residents:
--   resident_read_own (SELECT, email ILIKE auth.jwt() ->> 'email')
-- No INSERT/UPDATE/DELETE policies → all writes denied by default.
-- This is what broke:
--   B1: /register self-registration INSERT denied
--   B2: manager.bayou@demotowing.com adding residents — INSERT denied
--
-- Fix: four INSERT policies (admin via FOR ALL; self via email match;
-- manager / leasing_agent via property-array membership; company_admin
-- via company match). Multiple INSERT policies are OR'd by Postgres,
-- so any one passing allows the write.
--
-- Self-register prereq: app/register/page.tsx now calls
-- supabase.auth.signInWithPassword() between the swift-handler auth
-- user creation and the residents INSERT, so the client's JWT carries
-- the new user's email at write time.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Admin: full CRUD. Wrapped as FOR ALL so it covers SELECT/INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "residents_admin_all" ON residents;
CREATE POLICY "residents_admin_all" ON residents
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Self-registration: caller's JWT email matches the residents.email
-- being inserted. Used by /register.
DROP POLICY IF EXISTS "residents_self_insert" ON residents;
CREATE POLICY "residents_self_insert" ON residents
  FOR INSERT TO authenticated
  WITH CHECK (lower(auth.jwt() ->> 'email') = lower(email));

-- Manager / leasing_agent: target residents.property is in caller's
-- assigned property[]. Used by /manager addResident.
DROP POLICY IF EXISTS "residents_manager_insert" ON residents;
CREATE POLICY "residents_manager_insert" ON residents
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE lower(ur.email) = lower(auth.jwt() ->> 'email')
        AND lower(ur.role) IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND residents.property = ANY(ur.property)
    )
  );

-- Company_admin: target residents.company matches caller's company.
-- Used by /company_admin addResident.
DROP POLICY IF EXISTS "residents_company_admin_insert" ON residents;
CREATE POLICY "residents_company_admin_insert" ON residents
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE lower(ur.email) = lower(auth.jwt() ->> 'email')
        AND lower(ur.role) = 'company_admin'
        AND ur.company IS NOT NULL
        AND lower(residents.company) = lower(ur.company)
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) All five policies present:
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'residents'::regclass ORDER BY polname;
--   Expected (polcmd: a=INSERT, r=SELECT, *=ALL):
--     resident_read_own                 r
--     residents_admin_all               *
--     residents_company_admin_insert    a
--     residents_manager_insert          a
--     residents_self_insert             a
--
-- 2) Self-registration end-to-end:
--   Open /register in incognito → complete 3 steps → Submit.
--   Should redirect to "Registration Submitted!" page.
--   Confirm row exists:
--     SELECT id, email, status, property FROM residents
--     WHERE email = '<test email>' ORDER BY created_at DESC LIMIT 1;
--
-- 3) Manager INSERT (as manager.bayou@demotowing.com):
--   Log in → /manager → Residents tab → + Add Resident → submit.
--   Should not error. Row should appear with property = manager's
--   assigned property.
--
-- 4) Company_admin INSERT (as compadmin@demotowing.com):
--   Log in → /company_admin → Residents → + Add Resident → submit.
--   Should not error. Row's company should match Demo Towing.
--
-- 5) Admin regression (as admin@alc.com):
--   Log in → /admin → use any flow that inserts a resident.
--   Should still work (covered by residents_admin_all).
-- ════════════════════════════════════════════════════════════════════
