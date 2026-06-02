-- ════════════════════════════════════════════════════════════════════
-- B155.1 — user_roles privilege-escalation hotfix
-- Drafted: 2026-06-02 — NOT YET APPLIED.
--
-- STANDALONE HOTFIX commit, ahead of the broader B155.2 transcription
-- arc. Closes a live exploit chain on the user_roles table that
-- escalates anon → admin via a single REST POST.
--
-- ── THE CHAIN, AS CONFIRMED IN PRE-FLIGHT ───────────────────────────
-- 1. anon has table-level INSERT grant on user_roles (Supabase default;
--    not REVOKE'd). [confirmed via information_schema.role_table_grants]
-- 2. The production policy `public_insert_user_roles` is INSERT /
--    {public} / WITH CHECK true → admits any anon INSERT.
-- 3. Attacker REST POSTs {email: 'attacker', role: 'admin'} → row lands.
-- 4. Attacker obtains an auth session for that email (signUp via the
--    public Supabase Auth API, or via /register which is publicly
--    routable). Email confirmation handled via attacker's own inbox.
-- 5. Once authenticated, get_my_role() does
--    `SELECT role FROM user_roles WHERE email ILIKE auth.jwt() ->>
--    'email' LIMIT 1` (no ORDER BY — first physical row wins, which
--    is typically the planted admin row inserted before any other).
-- 6. admin_all_* policies on every scoped table admit cross-tenant
--    CRUD. Full takeover.
--
-- This works TODAY against production. Not gated by public_signup_open
-- (app-level form flag, not the policy). The /register route is on
-- middleware.ts publicPaths so the auth-session second link is
-- reachable through multiple doors.
--
-- ── FIX SHAPE (Jose-greenlit) ───────────────────────────────────────
-- 1. DROP public_insert_user_roles.
-- 2. CREATE authenticated_self_insert_resident — a tight replacement
--    that admits ONLY the /register fallback path: must be
--    authenticated, role pinned to 'resident', email must match JWT.
-- 3. Transcribe the 3 sibling user_roles policies into migration source
--    in the same commit (so the table becomes fully migration-sourced
--    at once, ahead of B155.2 picking up the rest). All four end up
--    {authenticated} (away from {public}) — belt-and-suspenders since
--    the body gates already exclude anon, but the role-grant tightening
--    eliminates the brittleness concern Jose called out.
--
-- ── /REGISTER FALLBACK CONTROL FLOW (pre-flight confirmed safe) ─────
-- The legit caller of public_insert_user_roles is /register/page.tsx
-- line 127, fired ONLY when the insert_user_role RPC errors. Trace:
--   line 56-117  hard-return on auth-create / signin / residents fail
--   line 119-124 rpc('insert_user_role', { p_email, p_role: 'resident',
--                                          p_company, p_property })
--   line 125-133 IF rpc error → direct INSERT fallback
-- By the time the fallback runs:
--   • Active session for account.email (signInWithPassword succeeded)
--   • email column written as .toLowerCase() (matches JWT under
--     case-insensitive comparison)
--   • role hardcoded to 'resident'
-- The tightened policy admits this exact shape. No SECURITY DEFINER
-- RPC alternative needed (the fallback is the only legit dependency).
--
-- ── 3 OTHER user_roles CALLERS DO NOT DEPEND ON THIS POLICY ─────────
-- /admin/page.tsx:654    (admin createDriver) → admitted by
--                         admin_all_user_roles (get_my_role()='admin')
-- /company_admin/page.tsx:905 (CA createDriver) → admitted by
--                         company_admin_own_users (CA's company match)
-- /scripts/provision-uat-accounts.ts:242 → service_role (RLS bypass)
-- (Various other sites use insert_user_role RPC, SECURITY DEFINER,
--  bypasses RLS entirely.)
--
-- ── BAR-2 ADJACENT FINDINGS (filed, NOT in this hotfix) ─────────────
-- • audit_logs.auth_insert_audit_logs — {public} INSERT WITH CHECK
--   `(auth.role() = 'authenticated')`. Any authenticated user can write
--   audit_logs with arbitrary user_email. Tighten to
--   `user_email = auth.jwt() ->> 'email'` during B155.2's audit_logs
--   transcription pass.
-- • get_my_role() — body is `SELECT role FROM user_roles WHERE
--   email ILIKE auth.jwt() ->> 'email' LIMIT 1` with NO ORDER BY.
--   Non-deterministic if duplicate-email rows ever exist. Filed as
--   B155.x. When picked up, first check whether user_roles.email
--   SHOULD be UNIQUE (one email = one role?). A UNIQUE constraint
--   may be the cleaner fix than adding ORDER BY — investigate
--   intent before choosing the path.
--
-- ── DEPENDENCIES (verified via pre-flight) ──────────────────────────
-- • user_roles RLS already enabled in production (confirmed via
--   relrowsecurity probe in B155 pre-flight Phase 2).
-- • get_my_role() + get_my_company() functions exist (B40 captured
--   their bodies into migrations/20260518_b40_violations_rls_capture).
-- • All 4 user_roles policies named below confirmed present in the
--   production policy dump.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. BEGIN/COMMIT atomic — any
-- statement failing rolls back the whole hotfix. All DDL idempotent
-- (DROP POLICY IF EXISTS + CREATE POLICY). Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Drop the privilege-escalation vector
-- ════════════════════════════════════════════════════════════════════
-- Original prod definition: INSERT / {public} / WITH CHECK true.
-- Admitted any anon INSERT including {email, role: 'admin'}. Gone.

DROP POLICY IF EXISTS public_insert_user_roles ON user_roles;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — Tight replacement: authenticated_self_insert_resident
-- ════════════════════════════════════════════════════════════════════
-- Admits the /register line-127 fallback path EXACTLY:
--   • role pinned to 'resident' (blocks escalation to admin / CA /
--     manager / etc.)
--   • email column must match the caller's JWT email
--     (case-insensitive via lower() — robust to any casing variation
--     between signInWithPassword input and the INSERTed email)
--   • {authenticated} role grant (anon has no JWT, no email,
--     can't satisfy the check anyway — belt-and-suspenders)
-- Idempotent via IF EXISTS DROP before CREATE.

DROP POLICY IF EXISTS authenticated_self_insert_resident ON user_roles;
CREATE POLICY authenticated_self_insert_resident ON user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    role = 'resident'
    AND lower(email) = lower(auth.jwt() ->> 'email')
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Transcribe admin_all_user_roles (was {public}, now {authenticated})
-- ════════════════════════════════════════════════════════════════════
-- Production original: FOR ALL TO {public} USING (get_my_role()='admin'),
-- WITH CHECK NULL.
-- For FOR ALL, when WITH CHECK is omitted, Postgres uses USING as
-- the write-check substitute. Match production behavior — leave
-- WITH CHECK unspecified.

DROP POLICY IF EXISTS admin_all_user_roles ON user_roles;
CREATE POLICY admin_all_user_roles ON user_roles
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin');

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Transcribe company_admin_own_users
-- ════════════════════════════════════════════════════════════════════
-- Production original: FOR ALL TO {public} USING (get_my_role() =
-- 'company_admin' AND company ~~* get_my_company()), WITH CHECK NULL.
-- Same FOR ALL behavior — USING acts as write check substitute.

DROP POLICY IF EXISTS company_admin_own_users ON user_roles;
CREATE POLICY company_admin_own_users ON user_roles
  FOR ALL TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND company ~~* get_my_company()
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Transcribe user_read_own_role
-- ════════════════════════════════════════════════════════════════════
-- Production original: FOR SELECT TO {public} USING (email ~~*
-- (auth.jwt() ->> 'email')). SELECT-only, body matches.

DROP POLICY IF EXISTS user_read_own_role ON user_roles;
CREATE POLICY user_read_own_role ON user_roles
  FOR SELECT TO authenticated
  USING (email ~~* (auth.jwt() ->> 'email'));

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Confirm 4 policies on user_roles (no public_insert_user_roles) ─
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'user_roles'
--   ORDER BY policyname;
--   -- Expected 4 rows:
--   --   admin_all_user_roles                   | ALL    | {authenticated} | get_my_role()='admin'                                              | null
--   --   authenticated_self_insert_resident     | INSERT | {authenticated} | null                                                                | role='resident' AND lower(email)=lower(auth.jwt()->>'email')
--   --   company_admin_own_users                | ALL    | {authenticated} | get_my_role()='company_admin' AND company ~~* get_my_company()    | null
--   --   user_read_own_role                     | SELECT | {authenticated} | email ~~* (auth.jwt()->>'email')                                   | null
--   -- public_insert_user_roles should NOT appear (dropped).
--
-- ── B. Acceptance probe (script-driven, see scripts/_b155_1_probe.ts) ─
-- 6 assertions = 4 NEG + 2 POS:
--   • NEG-1: anon REST POST {email:Z, role:'admin'} → RLS BLOCKED
--   • NEG-2: authenticated-as-X INSERT {email:X, role:'admin'} →
--            WITH CHECK BLOCKED (role pinned)
--   • NEG-3: authenticated-as-X INSERT {email:Y, role:'resident'} →
--            WITH CHECK BLOCKED (email mismatch)
--   • NEG-4: anon REST POST tries ALL role variants {admin,
--            company_admin, manager, driver} → ALL BLOCKED
--            (chain dead at link 1 regardless of escalation target)
--   • POS-1: authenticated-as-X INSERT {email:X, role:'resident',
--            company, property:[Z]} → OK
--            (mirrors /register fallback line-127 payload exactly)
--   • POS-2: authenticated-as-CA INSERT {email:Y, role:'driver',
--            company:CA's company} → OK
--            (validates admin_all_user_roles + company_admin_own_users
--            still admit their respective paths under {authenticated})
-- Self-cleaning, prints pass/fail, exits non-zero on failure.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent. BEGIN/COMMIT atomic. Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════
