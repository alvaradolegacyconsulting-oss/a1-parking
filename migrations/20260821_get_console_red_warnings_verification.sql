-- ══════════════════════════════════════════════════════════════════════
-- 20260821_get_console_red_warnings_verification.sql
--
-- Post-apply verification for 20260821_get_console_red_warnings.
-- v2 pattern (feedback_verification_returns_rows_no_transaction):
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with `status='PASS'` on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 8 gates (G6 updated 2026-08-22 for kind #1 retirement):
--   G1 function exists with exact signature (1 TEXT arg)
--   G2 SECURITY DEFINER + search_path pinned
--   G3 return shape: 11 columns, correct order
--   G4 grants: anon=0, service_role=0, authenticated=1 EXECUTE
--   G5 body contains admin role-gate literal (forbidden_not_admin ERRCODE 42501)
--   G6 🟢 TS-parity — surviving red predicate (kind #5) PRESENT +
--      retired kind #1 predicate EXPLICITLY ABSENT. Was "both
--      branches present"; kind #1 retired 2026-08-22 (see migration
--      20260822_get_console_red_warnings_retire_kind1.sql). The
--      absent-assertion catches a well-meaning re-addition — if
--      someone recreates the kind #1 branch, this gate fails loudly.
--   G7 schema audit row present (SCHEMA_GET_CONSOLE_RED_WARNINGS,
--      original migration + also SCHEMA_GET_CONSOLE_RED_WARNINGS_
--      RETIRE_KIND1 if the retirement was applied)
--   G8 🔴 EXECUTION — SELECT COUNT(*) FROM RPC (both signatures) must
--      not throw. Reason: original v1 passed 7-of-7 structural gates
--      against a function that threw 42804 on every invocation
--      (c.company_env enum → TEXT-declared return column). CREATE
--      FUNCTION accepts the definition; type-check is RUNTIME. See
--      feedback_rpc_verification_must_include_execution_gate.md.
--
-- NOTE: no gate for "p_company_env DEFAULT preserved" — pg_proc.proargdefaults
-- storage of TEXT literals is stable across CREATE OR REPLACE only when
-- the DEFAULT clause is verbatim in the CREATE statement, so gate this
-- structurally by checking pg_get_function_arguments contains
-- "p_company_env text DEFAULT 'production'::text" (see G1).
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_body                TEXT;
  v_args_with_defaults  TEXT;
  v_proconfig           TEXT[];
  v_prosecdef           BOOLEAN;
  v_grants_anon         INT;
  v_grants_service      INT;
  v_grants_authed       INT;
  v_audit_count         INT;
  v_ret_cols            TEXT;
  v_expected_cols       TEXT :=
    'p_company_env,'
 || 'company_id,company_name,company_env,property,unit,plate,kind,'
 || 'vehicle_status,vehicle_is_active,vehicle_id,vehicle_created_at';
BEGIN
  -- ── G1 exists with 1 TEXT arg + DEFAULT 'production' preserved ─
  SELECT pg_get_function_arguments(p.oid)
    INTO v_args_with_defaults
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_console_red_warnings';

  IF v_args_with_defaults IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.get_console_red_warnings not found';
  END IF;
  IF v_args_with_defaults NOT ILIKE '%p_company_env%text%DEFAULT%''production''%' THEN
    RAISE EXCEPTION 'G1 FAIL: signature mismatch. Expected p_company_env text DEFAULT ''production''; got [%]',
      v_args_with_defaults;
  END IF;

  -- ── G2 SECURITY DEFINER + search_path pinned ────────────────────
  SELECT p.prosecdef, p.proconfig
    INTO v_prosecdef, v_proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_console_red_warnings';

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE (SECURITY DEFINER); got %', v_prosecdef;
  END IF;
  IF v_proconfig IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_proconfig) AS s WHERE s ILIKE 'search_path=%') THEN
    RAISE EXCEPTION 'G2 FAIL: search_path not pinned via SET; proconfig=%', v_proconfig;
  END IF;

  -- ── G3 return shape ──────────────────────────────────────────────
  -- pg_proc.proargnames includes IN + OUT names in argument-order.
  -- With one IN (p_company_env) + 11 OUT (return TABLE), expected order
  -- is the IN name first then the 11 return names.
  SELECT string_agg(nm, ',' ORDER BY ord)
    INTO v_ret_cols
    FROM (
      SELECT unnest(p.proargnames) AS nm,
             generate_subscripts(p.proargnames, 1) AS ord
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'get_console_red_warnings'
    ) t;

  IF v_ret_cols IS DISTINCT FROM v_expected_cols THEN
    RAISE EXCEPTION 'G3 FAIL: arg + return columns mismatch. Expected [%], got [%]',
      v_expected_cols, v_ret_cols;
  END IF;

  -- ── G4 grants ────────────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'anon'          AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'service_role'  AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'EXECUTE')
    INTO v_grants_anon, v_grants_service, v_grants_authed
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'get_console_red_warnings';

  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%); must be 0', v_grants_anon;
  END IF;
  IF v_grants_service <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: service_role EXECUTE grant present (count=%); must be 0', v_grants_service;
  END IF;
  IF v_grants_authed <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant count=% (want 1)', v_grants_authed;
  END IF;

  -- ── G5 role-gate literal + G6 predicate parity ──────────────────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_console_red_warnings';

  IF v_body IS NULL OR v_body NOT ILIKE '%forbidden_not_admin%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing forbidden_not_admin role-gate literal';
  END IF;
  IF v_body NOT ILIKE '%42501%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing ERRCODE 42501';
  END IF;

  -- G6 (updated 2026-08-22): kind #5 predicate PRESENT, kind #1 ABSENT.
  --   PRESENT check: same TS-parity discipline as before — the
  --     surviving red predicate must appear verbatim in the body.
  --   ABSENT check: catches a well-meaning re-addition of the retired
  --     kind #1 predicate. If someone recreates it, this fires — the
  --     absent-assertion is the enforcement mechanism for the
  --     "do not re-add" note in the retirement migration.
  IF v_body NOT ILIKE '%status = ''pending''%is_active = TRUE%' THEN
    RAISE EXCEPTION 'G6 FAIL (present): red predicate kind #5 (status=pending AND is_active=TRUE) not present in body';
  END IF;
  IF v_body ILIKE '%status = ''active''%is_active = FALSE%' THEN
    RAISE EXCEPTION 'G6 FAIL (absent): retired kind #1 predicate (status=active AND is_active=FALSE) reappeared. See migration 20260822_get_console_red_warnings_retire_kind1.sql for the retirement rationale — do not re-add without revisiting the alignment history.';
  END IF;

  -- ── G7 schema audit row ──────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action     = 'SCHEMA_GET_CONSOLE_RED_WARNINGS'
     AND table_name = 'public.get_console_red_warnings(TEXT)';

  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G7 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 7 structural gates passed. G8 execution gate next.';
END $$;

-- ── G8 EXECUTION gate ────────────────────────────────────────────────
-- 🔴 The gate that would have caught the enum-cast bug. See header.
-- Assert BOTH call shapes run:
--   (a) with the default argument path (no arg passed) — exercises
--       DEFAULT 'production' resolution
--   (b) with explicit NULL — exercises the "all envs" branch the
--       client calls with at mount
-- Row count is not asserted; RUN is the assertion.
--
-- 🔴 JWT IMPERSONATION — MANDATORY for admin-gated RPCs
--
-- The RPC's role gate (line 9 of get_console_red_warnings body) reads
-- auth.jwt() ->> 'email'. In the SQL Editor context, auth.jwt() is
-- NULL (no JWT — the caller is service_role/postgres, not an
-- authenticated user), so the RPC aborts with 42501 'unauthenticated'
-- BEFORE its typed SELECT runs. That defeats the entire point of an
-- execution gate — the gate exists to catch runtime type errors in
-- the SELECT (enum→TEXT, column-order drift), which are only visible
-- once the SELECT actually executes.
--
-- Fix: set request.jwt.claims LOCAL to this DO block so the RPC's
-- auth.jwt() call sees an impersonated admin email. LOCAL scope
-- (third arg TRUE) auto-clears when this DO block's implicit
-- transaction ends — no session bleed into subsequent queries.
--
-- This is safe: the verification runs by an authorized deployer
-- (Jose) in SQL Editor. Any actor with SQL Editor access already has
-- full DB privilege — impersonating an admin's email is not an
-- escalation, only a way to reach the RPC body.
--
-- Discovered 2026-08-22 (Jose's first execution-gate run failed with
-- exactly this 42501). Class rule updated: feedback_rpc_verification_
-- must_include_execution_gate.md.
DO $$
DECLARE
  v_admin_email  TEXT;
  v_default_rows INT;
  v_all_env_rows INT;
BEGIN
  -- Find any active admin to impersonate. If none exists, the RPC's
  -- role gate could not pass in ANY caller context — surface as a
  -- PREREQ failure with a distinct message so it's not conflated with
  -- an RPC-body bug.
  SELECT email INTO v_admin_email
    FROM public.user_roles
   WHERE role = 'admin'
     AND is_active = TRUE
   LIMIT 1;
  IF v_admin_email IS NULL THEN
    RAISE EXCEPTION 'G8 PREREQ FAIL: no active admin user_roles row to impersonate — execution gate cannot proceed';
  END IF;

  -- Impersonate: set the JWT claims GUC LOCAL to this txn. Third arg
  -- TRUE means LOCAL scope — reset at end of DO block. Included
  -- 'role':'authenticated' for parity with what PostgREST sets in
  -- normal request flow (some Supabase helpers read it).
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('email', v_admin_email, 'role', 'authenticated')::text,
    TRUE
  );

  SELECT COUNT(*) INTO v_default_rows FROM public.get_console_red_warnings();
  SELECT COUNT(*) INTO v_all_env_rows FROM public.get_console_red_warnings(NULL);
  RAISE NOTICE 'G8 execution (impersonated %): default-arg call → % rows; NULL-arg call → % rows.',
    v_admin_email, v_default_rows, v_all_env_rows;
  -- Sanity: NULL-arg (all envs) must be >= default-arg (production only).
  -- Enforces the filter actually filters — if NULL returned FEWER than
  -- 'production', something is very wrong (e.g. WHERE inverted).
  IF v_all_env_rows < v_default_rows THEN
    RAISE EXCEPTION 'G8 SANITY FAIL: NULL-arg (all envs, %) < default-arg (production only, %); filter inverted?',
      v_all_env_rows, v_default_rows;
  END IF;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                   AS status,
  'get_console_red_warnings(TEXT)'::TEXT         AS function_name,
  '8 gates: signature+default / definer+searchpath / arg+return-shape / grants / role-gate / TS-parity predicates / audit / EXECUTION (default + NULL + filter-not-inverted)'::TEXT AS gates,
  now()                                          AS verified_at;
