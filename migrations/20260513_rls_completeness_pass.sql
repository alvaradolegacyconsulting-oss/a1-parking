-- ════════════════════════════════════════════════════════════════════
-- B12 — RLS completeness pass (+ B11 residents read fix + B6 ToS fix)
-- Locked: May 13, 2026
--
-- The May 13 audit showed most tables have proper RLS already. Three
-- real gaps remain:
--   1. residents SELECT/UPDATE — manager + company_admin can't see or
--      modify residents on their property/company (B11).
--   2. properties UPDATE — manager can't save visitor_pass_limit,
--      exempt_plates, or property settings.
--   3. user_roles UPDATE for self — ToS acceptance fails silently
--      because there's no self-UPDATE policy (B6).
--
-- Decisions locked by Jose:
--   - Manager scoping: STRICT per-property (property = ANY(ur.property)).
--   - DELETE policies: SKIPPED. Soft delete via is_active=false; covered
--     by the new UPDATE policies.
--   - ToS persistence: SECURITY DEFINER accept_tos() RPC — single-purpose
--     and auditable. NO user_roles self-UPDATE policy added (intentional;
--     keeps the table's write surface narrow).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. residents SELECT for manager / leasing_agent (own properties) ─
DROP POLICY IF EXISTS residents_manager_read ON residents;
CREATE POLICY residents_manager_read ON residents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND residents.property = ANY(ur.property)
    )
  );

-- ── A. residents SELECT for company_admin (own company) ──────────────
DROP POLICY IF EXISTS residents_company_admin_read ON residents;
CREATE POLICY residents_company_admin_read ON residents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role = 'company_admin'
        AND ur.company IS NOT NULL
        AND residents.company ILIKE ur.company
    )
  );

-- ── A. residents UPDATE for manager / leasing_agent (own properties) ─
-- Predicate mirrors the SELECT policy so a row visible to the manager
-- is also writable. WITH CHECK uses the same predicate to ensure the
-- post-UPDATE row still belongs to one of the manager's properties
-- (prevents reassigning a resident to a property they don't manage).
DROP POLICY IF EXISTS residents_manager_update ON residents;
CREATE POLICY residents_manager_update ON residents
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND residents.property = ANY(ur.property)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND residents.property = ANY(ur.property)
    )
  );

-- ── A. residents UPDATE for company_admin (own company) ──────────────
DROP POLICY IF EXISTS residents_company_admin_update ON residents;
CREATE POLICY residents_company_admin_update ON residents
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role = 'company_admin'
        AND ur.company IS NOT NULL
        AND residents.company ILIKE ur.company
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role = 'company_admin'
        AND ur.company IS NOT NULL
        AND residents.company ILIKE ur.company
    )
  );

-- ── B. properties UPDATE for manager / leasing_agent (own properties)
-- For settings flows: visitor_pass_limit, exempt_plates, pm_phone, etc.
-- Property reassignment is blocked at WITH CHECK time — manager can't
-- rename a property to one outside their assignment list.
DROP POLICY IF EXISTS properties_manager_update ON properties;
CREATE POLICY properties_manager_update ON properties
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND properties.name = ANY(ur.property)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email ILIKE (auth.jwt() ->> 'email')
        AND ur.role IN ('manager', 'leasing_agent')
        AND ur.property IS NOT NULL
        AND properties.name = ANY(ur.property)
    )
  );

-- ── C. accept_tos() SECURITY DEFINER RPC ────────────────────────────
-- Persists ToS acceptance for the caller. Idempotent: only sets the
-- timestamp if it's currently NULL, so re-running is a no-op.
-- Bypasses the missing user_roles self-UPDATE policy by design.

CREATE OR REPLACE FUNCTION accept_tos()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_email TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'No authenticated session' USING ERRCODE = '42501';
  END IF;

  UPDATE user_roles
  SET tos_accepted_at = now()
  WHERE email ILIKE v_caller_email
    AND tos_accepted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION accept_tos() TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification (run after migration applies):
--
-- 1) Confirm new policies attached (expect 5 rows):
--   SELECT polname, polcmd
--   FROM pg_policy
--   WHERE polrelid IN ('residents'::regclass, 'properties'::regclass)
--     AND polname IN (
--       'residents_manager_read',
--       'residents_company_admin_read',
--       'residents_manager_update',
--       'residents_company_admin_update',
--       'properties_manager_update'
--     )
--   ORDER BY polname;
--
-- 2) Confirm RPC exists:
--   SELECT proname FROM pg_proc WHERE proname='accept_tos';
--
-- 3) Smoke test (as compadmin@demotowing.com or any logged-in user
--    with tos_accepted_at IS NULL):
--   SELECT accept_tos();
--   SELECT email, tos_accepted_at FROM user_roles
--   WHERE email ILIKE '<your test email>';
--   -- expect: recent timestamp
-- ════════════════════════════════════════════════════════════════════
