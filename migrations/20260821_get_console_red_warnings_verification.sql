-- ══════════════════════════════════════════════════════════════════════
-- 20260821_get_console_red_warnings_verification.sql
--
-- Post-apply verification for 20260821_get_console_red_warnings.
-- v2 pattern (feedback_verification_returns_rows_no_transaction):
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with `status='PASS'` on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 7 gates:
--   G1 function exists with exact signature (1 TEXT arg)
--   G2 SECURITY DEFINER + search_path pinned
--   G3 return shape: 11 columns, correct order
--   G4 grants: anon=0, service_role=0, authenticated=1 EXECUTE
--   G5 body contains admin role-gate literal (forbidden_not_admin ERRCODE 42501)
--   G6 body mirrors TS predicate literals verbatim (both branches present)
--   G7 schema audit row present (SCHEMA_GET_CONSOLE_RED_WARNINGS)
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

  -- G6: both TS-mirroring predicate branches present. If either is
  -- silently removed in a future CREATE OR REPLACE, this fires.
  IF v_body NOT ILIKE '%status = ''active''%is_active = FALSE%' THEN
    RAISE EXCEPTION 'G6 FAIL: red predicate #1 (status=active AND is_active=FALSE) not present in body';
  END IF;
  IF v_body NOT ILIKE '%status = ''pending''%is_active = TRUE%' THEN
    RAISE EXCEPTION 'G6 FAIL: red predicate #2 (status=pending AND is_active=TRUE) not present in body';
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

  RAISE NOTICE 'All 7 gates passed.';
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                   AS status,
  'get_console_red_warnings(TEXT)'::TEXT         AS function_name,
  '7 gates: signature+default / definer+searchpath / arg+return-shape / grants / role-gate / TS-parity predicates / audit'::TEXT AS gates,
  now()                                          AS verified_at;
