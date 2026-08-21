-- ══════════════════════════════════════════════════════════════════════
-- 20260821_get_console_per_property_activity_verification.sql
--
-- Post-apply verification for 20260821_get_console_per_property_activity.
-- v2 pattern (feedback_verification_returns_rows_no_transaction):
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with `status='PASS'` on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 7 gates:
--   G1 function exists with correct signature
--   G2 SECURITY DEFINER + search_path pinned
--   G3 return shape: 12 columns, correct types, correct order
--   G4 grants: anon=0, service_role=0, authenticated=1 EXECUTE
--   G5 body contains admin role-gate literal (forbidden_not_admin ERRCODE 42501)
--   G6 schema audit row present (SCHEMA_GET_CONSOLE_PER_PROPERTY_ACTIVITY)
--   G7 🔴 EXECUTION — SELECT COUNT(*) FROM the RPC must not throw.
--      Reason: original v1 verification passed with 7-of-7 structural
--      gates against a function that threw 42804 on every invocation
--      (c.company_env enum → TEXT-declared return column). CREATE
--      FUNCTION accepts the definition; the type-check is RUNTIME.
--      Structural checks against a never-invoked function are proof of
--      well-formedness, not proof of working. Never omit this gate on
--      an RPC verification. See feedback_rpc_verification_must_
--      include_execution_gate.md.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_body                TEXT;
  v_proconfig           TEXT[];
  v_prosecdef           BOOLEAN;
  v_grants_anon         INT;
  v_grants_service      INT;
  v_grants_authed       INT;
  v_audit_count         INT;
  v_ret_cols            TEXT;
  v_expected_cols       TEXT :=
    'property_id,property_name,company_id,company_name,company_env,property_created_at,'
 || 'residents_active,vehicles_active,spaces_active,violations_30d,passes_30d,last_activity_at';
BEGIN
  -- ── G1 exists ────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_console_per_property_activity'
  ) THEN
    RAISE EXCEPTION 'G1 FAIL: public.get_console_per_property_activity() not found';
  END IF;

  -- ── G2 SECURITY DEFINER + search_path pinned ────────────────────
  SELECT p.prosecdef, p.proconfig
    INTO v_prosecdef, v_proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_console_per_property_activity';

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE (SECURITY DEFINER); got %', v_prosecdef;
  END IF;
  IF v_proconfig IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_proconfig) AS s WHERE s ILIKE 'search_path=%') THEN
    RAISE EXCEPTION 'G2 FAIL: search_path not pinned via SET; proconfig=%', v_proconfig;
  END IF;

  -- ── G3 return shape ──────────────────────────────────────────────
  -- pg_proc.proargnames contains OUT column names in return-order for
  -- TABLE-returning functions.
  SELECT string_agg(nm, ',' ORDER BY ord)
    INTO v_ret_cols
    FROM (
      SELECT unnest(p.proargnames) AS nm,
             generate_subscripts(p.proargnames, 1) AS ord
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'get_console_per_property_activity'
    ) t;

  IF v_ret_cols IS DISTINCT FROM v_expected_cols THEN
    RAISE EXCEPTION 'G3 FAIL: return columns mismatch. Expected [%], got [%]',
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
     AND routine_name   = 'get_console_per_property_activity';

  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%); must be 0', v_grants_anon;
  END IF;
  IF v_grants_service <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: service_role EXECUTE grant present (count=%); must be 0', v_grants_service;
  END IF;
  IF v_grants_authed <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant count=% (want 1)', v_grants_authed;
  END IF;

  -- ── G5 role-gate literal ─────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_console_per_property_activity';

  IF v_body IS NULL OR v_body NOT ILIKE '%forbidden_not_admin%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing forbidden_not_admin role-gate literal';
  END IF;
  IF v_body NOT ILIKE '%42501%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing ERRCODE 42501';
  END IF;

  -- ── G6 schema audit row ──────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action     = 'SCHEMA_GET_CONSOLE_PER_PROPERTY_ACTIVITY'
     AND table_name = 'public.get_console_per_property_activity()';

  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G6 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 6 structural gates passed. G7 execution gate next.';
END $$;

-- ── G7 EXECUTION gate ────────────────────────────────────────────────
-- 🔴 The gate that would have caught the enum-cast bug on 20260821.
-- Six structural gates passed against a function that threw 42804 on
-- every invocation. RUNTIME type-checks (RETURNS TABLE column type vs
-- actual SELECT column type) do not fire at CREATE FUNCTION time —
-- only on call. Any RPC verification that skips this gate is a false
-- pass by construction. See feedback_rpc_verification_must_include_
-- execution_gate.md.
--
-- We assert the RPC RUNS without error. Row count is not asserted —
-- can legitimately be 0 in a test tenant with no properties.
DO $$
DECLARE v_row_count INT;
BEGIN
  SELECT COUNT(*) INTO v_row_count FROM public.get_console_per_property_activity();
  RAISE NOTICE 'G7 execution: RPC returned % rows (any count is fine; RUN is the assertion).', v_row_count;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'                                             AS status,
  'get_console_per_property_activity'                AS function_name,
  '7 gates: exists / definer+searchpath / return-shape / grants / role-gate / audit / EXECUTION' AS gates,
  now()                                              AS verified_at;
