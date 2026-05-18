-- ════════════════════════════════════════════════════════════════════
-- PUBLIC-grant retrofit — 5 user-facing SECURITY DEFINER functions
-- Drafted: May 26, 2026 — NOT YET APPLIED.
--
-- ── CONTEXT ─────────────────────────────────────────────────────────
-- B74 verification on May 19 (query E) surfaced that every SECURITY
-- DEFINER function in production inherits a PUBLIC EXECUTE grant by
-- Postgres default. Supabase's default GRANT pipeline does not REVOKE
-- this — the explicit anon/authenticated GRANTs we've written are
-- redundant ADDITIONS on top of the implicit PUBLIC grant rather than
-- a tightening.
--
-- Filed as memory/feedback_function_public_grant_supabase_default.md
-- during the May 19 housekeeping batch. This migration executes the
-- "named-5 retrofit" phase. Two follow-ups carved out by the May 19
-- pre-flight audit:
--   • B82 — migration-defined retrofit phase 2 (accept_tos,
--     set_must_change_password, get_plate_pass_status)
--   • B68 (expanded) — capture-pass for production-only Dashboard
--     functions (insert_user_role, get_company_admin_emails) before
--     they can be grant-tightened
--
-- ── WHY NOW ─────────────────────────────────────────────────────────
-- Not a leak today — PUBLIC includes both anon and authenticated, the
-- two intended caller roles. But:
--   • B66 (Stripe-paid signup) will introduce new SECURITY DEFINER
--     functions for webhook handlers. Tightening 5 functions before
--     Stripe is cheaper than tightening 15+ functions after.
--   • The redeem + pm_plate_lookup tightenings (authenticated-only)
--     shrink attack surface below what function-body role/auth gates
--     already enforce — anon callers can't even spam-invoke now.
--   • Locks in the REVOKE-from-PUBLIC + explicit-GRANT pattern as the
--     standard for every future SECURITY DEFINER migration.
--
-- ── PRE-APPLY VERIFICATION (Jose runs in SQL Editor before applying) ─
-- P9 (now formal — see memory/feedback_query_before_inferring.md):
--
--   -- 1. Current PUBLIC grant on each of the 5 functions
--   SELECT p.proname, r.grantee, r.privilege_type
--   FROM information_schema.routine_privileges r
--   JOIN pg_proc p ON p.proname = r.routine_name
--   WHERE r.routine_schema = 'public'
--     AND r.routine_name IN (
--       'validate_proposal_code', 'redeem_proposal_code',
--       'pm_plate_lookup', 'check_resident_plate', 'create_visitor_pass'
--     )
--     AND r.privilege_type = 'EXECUTE'
--   ORDER BY p.proname, r.grantee;
--   -- Expected: each function shows grantees including at minimum
--   --           PUBLIC, anon, authenticated, postgres, service_role.
--   --           The PUBLIC grant is what this migration revokes.
--
--   -- 2. All 5 are SECURITY DEFINER (sanity)
--   SELECT proname, prosecdef AS is_security_definer
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (
--       'validate_proposal_code', 'redeem_proposal_code',
--       'pm_plate_lookup', 'check_resident_plate', 'create_visitor_pass'
--     )
--   ORDER BY proname;
--   -- Expected: all 5 with is_security_definer = true.
--   --           If any returns false, STOP and notify Jose.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1. validate_proposal_code(TEXT) → anon + authenticated
-- ────────────────────────────────────────────────────────────────────
-- Called from:
--   • /signup/redeem/page.tsx:90  (anon, pre-signup tier preview)
--   • /signup/redeem/verify/page.tsx:100 (authenticated, re-validate
--     post-PKCE before activation form renders)
-- PUBLIC was redundant — anon + authenticated already cover both
-- intended caller surfaces. Retrofit formalizes existing intent.
REVOKE EXECUTE ON FUNCTION public.validate_proposal_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_proposal_code(TEXT)
  TO anon, authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 2. redeem_proposal_code(...) → authenticated ONLY  *** TIGHTENING ***
-- ────────────────────────────────────────────────────────────────────
-- Called from:
--   • /signup/redeem/verify/page.tsx:159 (authenticated post-PKCE only;
--     user must have completed email verification + held a session)
-- Function body already raises 'unauthenticated' if auth.uid() is NULL,
-- so anon callers fail inside the function — but with PUBLIC granted,
-- they can still INVOKE it and trigger the RAISE. Removing PUBLIC means
-- anon callers can't even reach the function body. Real attack-surface
-- reduction below what the function-body gate provides.
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) TO authenticated;
-- Deliberately NOT granted to anon. Caller must hold a session.

-- ────────────────────────────────────────────────────────────────────
-- 3. pm_plate_lookup(TEXT) → authenticated ONLY  *** TIGHTENING ***
-- ────────────────────────────────────────────────────────────────────
-- Called from:
--   • /manager/page.tsx:305 (authenticated manager/leasing_agent;
--     role gate inside the RPC raises if role not in those two)
-- Same logic as redeem — function body already gates role, but PUBLIC
-- lets anon reach the body. Removing PUBLIC gates the call earlier.
REVOKE EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;
-- Deliberately NOT granted to anon. Manager portal requires session.

-- ────────────────────────────────────────────────────────────────────
-- 4. check_resident_plate(TEXT, TEXT) → anon + authenticated
-- ────────────────────────────────────────────────────────────────────
-- Called from:
--   • /visitor/page.tsx:85 (anon QR-code precheck — "is this plate
--     already an active resident at this property?" boolean)
-- Designed-anon by B74; PUBLIC was redundant.
REVOKE EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT)
  TO anon, authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 5. create_visitor_pass(...) → anon + authenticated
-- ────────────────────────────────────────────────────────────────────
-- Called from:
--   • /visitor/page.tsx:100 (anon QR-code submit — INSERT visitor pass
--     + audit_logs row in one SECURITY DEFINER call)
-- Designed-anon by B74; PUBLIC was redundant.
REVOKE EXECUTE ON FUNCTION public.create_visitor_pass(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_visitor_pass(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) TO anon, authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. PUBLIC grant absent on all 5 functions ──────────────────────
--   SELECT p.proname, r.grantee, r.privilege_type
--   FROM information_schema.routine_privileges r
--   JOIN pg_proc p ON p.proname = r.routine_name
--   WHERE r.routine_schema = 'public'
--     AND r.routine_name IN (
--       'validate_proposal_code', 'redeem_proposal_code',
--       'pm_plate_lookup', 'check_resident_plate', 'create_visitor_pass'
--     )
--     AND r.privilege_type = 'EXECUTE'
--   ORDER BY p.proname, r.grantee;
--   -- Expected: PUBLIC absent from every row. Grantees should be
--   --           anon, authenticated, postgres, service_role for the
--   --           three anon+authenticated functions, and authenticated,
--   --           postgres, service_role for the two authenticated-only
--   --           functions.
--   -- (postgres + service_role grants persist — they're owner/superuser
--   --  level and not touched by REVOKE FROM PUBLIC.)
--
-- ── B. Anon smoke — redeem_proposal_code rejected at grant level ────
-- From anon supabase client:
--   SELECT redeem_proposal_code(
--     'TEST', '00000000-0000-0000-0000-000000000000'::uuid,
--     'Test', 'Test', '555', '1.0', '1.0', NULL, NULL, NULL
--   );
--   -- Expected: 42501 insufficient_privilege (gate is now grant-level,
--   --           NOT the function body's unauthenticated RAISE).
--
-- ── C. Anon smoke — pm_plate_lookup rejected at grant level ─────────
-- From anon supabase client:
--   SELECT pm_plate_lookup('ABC123');
--   -- Expected: 42501 insufficient_privilege (was previously
--   --           'role <null> not permitted' from function-body RAISE).
--
-- ── D. Anon smoke — three anon-callable functions still work ────────
-- From anon supabase client (legitimate caller surface unchanged):
--   SELECT validate_proposal_code('TEST-CODE');
--   -- Expected: jsonb {valid: false, reason: 'not_found'} (assuming
--   --           the test code doesn't exist). No 42501.
--
--   SELECT check_resident_plate('TEST-PLATE-FAKE', 'Test Property');
--   -- Expected: false. No 42501.
--
--   SELECT create_visitor_pass('TEST', 'V', 'A-1', 'P', 'desc', 2);
--   -- Expected: BIGINT (new visitor_passes.id) OR a function-body
--   --           validation error (e.g., 'property required' if 'P'
--   --           isn't a known property). NOT 42501 — grant is intact.
--   -- DESTRUCTIVE — only run in dev/staging.
--
-- ── E. Authenticated smoke — all 5 callable from authenticated ──────
-- From any authenticated supabase client:
--   SELECT validate_proposal_code('TEST-CODE');     -- no 42501
--   SELECT check_resident_plate('X', 'Y');          -- no 42501
--   SELECT pm_plate_lookup('X');                    -- raises only the
--                                                   --   function-body
--                                                   --   role check, not
--                                                   --   42501 grant
--   -- redeem_proposal_code + create_visitor_pass would also work but
--   -- with side effects — skip unless intentionally destructive.
--
-- ── ROLLBACK (if needed) ────────────────────────────────────────────
-- Re-grants PUBLIC on each function, restoring pre-state byte-for-byte.
--
--   BEGIN;
--   GRANT EXECUTE ON FUNCTION public.validate_proposal_code(TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.redeem_proposal_code(
--     TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
--   ) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.create_visitor_pass(
--     TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
--   ) TO PUBLIC;
--   COMMIT;
--
-- No data state affected. Rollback restores exactly what existed pre-apply.
-- Supabase point-in-time restore is the nuclear option.
--
-- ── FORWARD-LOOKING NOTE ────────────────────────────────────────────
-- Going forward, every new SECURITY DEFINER migration MUST include
-- REVOKE EXECUTE ... FROM PUBLIC after the CREATE FUNCTION statement,
-- before the explicit GRANT. Template pattern:
--
--   CREATE OR REPLACE FUNCTION public.<fn>(...) ... ;
--   REVOKE EXECUTE ON FUNCTION public.<fn>(...) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.<fn>(...) TO <intended-roles>;
--
-- The REVOKE is the actual gate; the GRANT is what we want post-revoke.
-- ════════════════════════════════════════════════════════════════════
