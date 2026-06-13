-- ═══════════════════════════════════════════════════════════════════
-- D2 + B68 capture + B155.2 RPC-path escalation closure
-- Date:   2026-06-13
-- Applied: 2026-06-13 via Supabase SQL Editor (single-paste single-run);
--          post-apply verification + 12-test probe ran green.
-- Branch: feat/d2-user-roles-name-with-rpc-guard
--
-- ONE ATOMIC MIGRATION — THREE CONCERNS
--
-- 1. D2 SCHEMA — user_roles.name TEXT column (the user-facing goal).
--    Mirrors the existing drivers.name / residents.name single-column
--    pattern. Captured by Add-User form ("Full Name" input) on managers
--    and leasing_agents; flows through insert_user_role's new p_name
--    parameter; backward-compatible for existing 4-arg callers via
--    DEFAULT NULL.
--
-- 2. B68 CAPTURE — insert_user_role had lived only in Supabase Dashboard
--    SQL Editor since B65 (self-serve signup era). This file is the
--    FIRST time the source-of-truth body lands in repo. Closes half of
--    the B68 "production-only DEFINER capture" backlog item
--    (get_company_admin_emails stays open for a separate sweep).
--
-- 3. B155.2 ESCALATION CLOSURE (RPC PATH) — The Dashboard body was
--    LANGUAGE sql, SECURITY DEFINER, no SET search_path, bare INSERT
--    with ZERO guards. SECURITY DEFINER bypasses RLS, so the morning's
--    B155.4 lockdown on the direct-INSERT path did NOT reach this
--    DEFINER path. Empirical probe today (scripts/probe-b155-2-rpc-
--    escalation.ts) confirmed three escalations pre-fix:
--       • CA → rpc({p_role:'admin'})         INSERTED
--       • CA → rpc({p_role:'company_admin'}) INSERTED
--       • CA → rpc({p_role:'noop'})          INSERTED (no validation)
--    The original B155.2 probe (probe-b155-2-escalation.ts) only tested
--    the direct .from('user_roles').insert(...) path; the RPC path was
--    always wide open. This migration moves role + scope guards INTO
--    the function body so SECURITY DEFINER's RLS bypass no longer
--    matters. Post-apply re-probe: 12/12 PASS (all four caller branches
--    + all denial + legit paths).
--
-- WHY ONE ATOMIC APPLY (PART 1 + PART 2 + grants)
-- Separating them creates a window where the schema lands on the still-
-- vulnerable RPC. Single paste / single run removes that race. Supabase
-- SQL Editor wraps the paste in an implicit transaction; a mid-run
-- failure rolls back cleanly (verified during the initial apply attempt
-- which failed on an ambiguous-oid verification SELECT and rolled back
-- the entire DDL — corrected version applied clean on the second pass).
--
-- BACKWARD COMPATIBILITY (verified against all 8 call sites in app/)
-- All 8 existing callers use named-arg `.rpc(...)` and pass exactly
-- p_email, p_role, p_company, p_property. After this migration:
--   • The 4-arg overload is gone (DROP FUNCTION).
--   • The 5-arg signature has p_name DEFAULT NULL — PostgREST resolves
--     named-arg calls without p_name to the new signature with
--     p_name=NULL by default.
--   • Each call site's caller-role + p_role + p_company combination
--     satisfies the new body guards (verified in the pre-apply audit
--     against admin/manager/CA/bulk-invite/self-reg paths).
--
-- AUTH-CONTEXT VERIFICATION (the blocking checks Jose required)
--   • bulk-invite/route.ts:57 uses createSupabaseServerClient() for the
--     RPC call — JWT-carrying, get_my_role() returns 'company_admin'.
--     Confirmed no service-role bypass on that path.
--   • get_my_role() returns true SQL NULL (not empty string) for an
--     authenticated user with no user_roles row yet. Confirmed
--     empirically via roleless-authenticated-user probe. The self-reg
--     branch (v_caller_role IS NULL) fires correctly.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────

SELECT pg_get_functiondef(p.oid) AS current_body
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'insert_user_role';

SELECT c.column_name FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'user_roles' AND c.column_name = 'name';

SELECT p.proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('get_my_role', 'get_my_company')
 ORDER BY p.proname;


-- ═══════════════════════════════════════════════════════════════════
-- PART 1 — Schema: user_roles.name column
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.user_roles ADD COLUMN name TEXT;


-- ═══════════════════════════════════════════════════════════════════
-- PART 2 — Drop 4-arg + create 5-arg with role + scope guards
-- ═══════════════════════════════════════════════════════════════════
-- Hard signature change (4 → 5 args) requires DROP + CREATE.
-- CREATE OR REPLACE cannot change argument lists; without DROP the
-- 4-arg version remains as a sibling overload and existing
-- .rpc('insert_user_role', {4 args}) calls would still hit the
-- escalation-vulnerable version. Hard cut.

DROP FUNCTION IF EXISTS public.insert_user_role(TEXT, TEXT, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION public.insert_user_role(
  p_email     TEXT,
  p_role      TEXT,
  p_company   TEXT,
  p_property  TEXT[],
  p_name      TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
BEGIN
  -- ── AUTH CONTEXT ────────────────────────────────────────────────
  -- v_caller_role is NULL for first-time self-reg users (no user_roles
  -- row yet, but auth.jwt() carries their confirmed email).
  v_caller_email := auth.jwt() ->> 'email';
  v_caller_role := get_my_role();

  -- ── CALLER-ROLE-CONDITIONAL GUARDS ──────────────────────────────
  -- Each branch enforces what role the caller can mint + what scope.
  -- The Dashboard-applied body had ZERO of these checks; the probe
  -- (scripts/probe-b155-2-rpc-escalation.ts) confirmed empirically
  -- pre-apply and 12/12 PASS post-apply.

  IF v_caller_role = 'admin' THEN
    -- Admin: full provisioning power. Can mint any role for any company.
    -- This preserves app/admin/page.tsx Add-User's legitimate flow
    -- (admin dropdown at :1081 exposes all 6 roles including admin +
    -- company_admin). Admin-creation should still PREFER service-role
    -- migrations for audit traceability — this RPC is the operational
    -- fallback admin keeps for runtime provisioning.
    NULL;

  ELSIF v_caller_role IN ('company_admin', 'manager', 'leasing_agent') THEN
    -- Tenant provisioner: role-IN-set + company-scope guards.
    --
    -- ROLE-IN-SET: admin/company_admin must NEVER be mintable by
    -- non-admin callers. This is the B155.2 RPC-path closure.
    IF p_role NOT IN ('manager', 'leasing_agent', 'driver', 'resident') THEN
      RAISE EXCEPTION 'role_not_allowed: %', p_role
        USING HINT = 'admin/company_admin can only be minted by admin callers (or via service-role migration). This RPC restricts non-admin callers to tenant-level roles.';
    END IF;
    -- COMPANY-SCOPE: caller can only insert into their own company.
    -- Strict case-insensitive equality (LOWER = LOWER), not ILIKE —
    -- this is an auth guard, not a search predicate; wildcard
    -- semantics on % or _ in company names would be a defect.
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL
       OR p_company IS NULL
       OR LOWER(p_company) <> LOWER(v_caller_company)
    THEN
      RAISE EXCEPTION 'company_scope_violation: caller scoped to "%" cannot insert into "%"', v_caller_company, p_company
        USING HINT = 'Tenant roles can only provision users for their own company. Admin caller required for cross-company provisioning.';
    END IF;

  ELSIF v_caller_role IS NULL THEN
    -- Self-reg first-time path: caller is authenticated (email just
    -- confirmed) but has no user_roles row yet. Allowed ONLY if:
    --   • p_role = 'resident' (self-reg cannot mint elevated roles)
    --   • p_email matches the caller's own auth.jwt() email (caller
    --     can ONLY mint their own row, never someone else's)
    IF p_role <> 'resident' THEN
      RAISE EXCEPTION 'self_reg_role_violation: self-reg can only mint resident roles (got %)', p_role
        USING HINT = 'New users in self-reg flow can only create their own resident row. Other roles require a CA or admin caller.';
    END IF;
    IF v_caller_email IS NULL OR LOWER(p_email) <> LOWER(v_caller_email) THEN
      RAISE EXCEPTION 'self_reg_email_violation: self-reg can only mint own email'
        USING HINT = 'Self-registering user can only create a user_roles row for their own authenticated email.';
    END IF;

  ELSE
    -- driver, resident, or anything else. Not a legit caller anywhere
    -- in the app code. Default deny.
    RAISE EXCEPTION 'caller_role_not_authorized: %', v_caller_role
      USING HINT = 'insert_user_role is callable only by admin, company_admin, manager, leasing_agent, or first-time self-reg users.';
  END IF;

  -- ── INSERT ──────────────────────────────────────────────────────
  -- All guards passed. p_property is TEXT[]; NULL is allowed and means
  -- "no property scope" (admin / CA / self-reg residents can have
  -- property=NULL or []).
  INSERT INTO public.user_roles (email, role, company, property, name)
  VALUES (p_email, p_role, p_company, p_property, p_name);
END
$func$;

-- Grant discipline (explicit REVOKE FROM anon — load-bearing per
-- [[feedback-revoke-from-anon-explicitly]]). The 5-arg signature is
-- new in this migration; specify it explicitly so the REVOKEs target
-- the correct overload.
REVOKE EXECUTE ON FUNCTION public.insert_user_role(TEXT, TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.insert_user_role(TEXT, TEXT, TEXT, TEXT[], TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.insert_user_role(TEXT, TEXT, TEXT, TEXT[], TEXT) TO authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────

SELECT p.proname,
       p.prosecdef AS is_security_definer,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'insert_user_role';
-- Applied 2026-06-13 returned: prosecdef=true, language=plpgsql,
-- returns=void, args='p_email text, p_role text, p_company text,
-- p_property text[], p_name text DEFAULT NULL::text'.

SELECT pg_get_function_arguments(p.oid)
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'insert_user_role';
-- Applied returned: exactly 1 row (no leftover 4-arg overload).

SELECT p.proname, p.proconfig
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'insert_user_role';
-- Applied returned: proconfig = {"search_path=public, pg_temp"}.

SELECT r.routine_name, r.grantee, r.privilege_type
  FROM information_schema.routine_privileges r
 WHERE r.specific_schema = 'public'
   AND r.routine_name = 'insert_user_role'
   AND r.grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY r.grantee;
-- Applied returned: authenticated|EXECUTE (only). 'anon' / 'PUBLIC'
-- absent. postgres / service_role visible in unfiltered view (expected
-- backend roles; not security-relevant).

SELECT c.column_name, c.data_type, c.is_nullable
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'user_roles' AND c.column_name = 'name';
-- Applied returned: 1 row, data_type=text, is_nullable=YES.


-- ── BEHAVIORAL VERIFICATION (probe re-run, all 4 caller branches) ──
-- Post-apply: scripts/probe-b155-2-rpc-escalation.ts ran 12/12 PASS.
--
-- Denial flips (FAIL pre-apply → PASS post-apply):
--   escalation.admin_insert            → role_not_allowed: admin
--   escalation.company_admin_insert    → role_not_allowed: company_admin
--   escalation.noop_insert             → role_not_allowed: noop
--   scope.cross_company                → company_scope_violation
--   denial.self_reg_other_email        → self_reg_email_violation
--   denial.self_reg_other_role         → self_reg_role_violation
--
-- Legit paths (must still land + p_name persists):
--   legit.tenant_manager_with_name     → row landed, name persisted
--   legit.tenant_driver_with_name      → row landed, name persisted
--   legit.self_reg_resident            → row landed, name persisted
--   admin.mint_admin                   → admin bypass, role=admin minted
--   admin.mint_company_admin           → admin bypass, role=CA minted
--   admin.cross_company_with_name      → admin cross-company + name
