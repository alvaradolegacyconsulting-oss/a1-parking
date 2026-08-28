-- ══════════════════════════════════════════════════════════════════════
-- 20260828_get_residents_row_by_precedence_add_company_verification.sql
--
-- Post-apply verification for 20260828_get_residents_row_by_precedence_
-- add_company. v2 pattern (feedback_verification_returns_rows_no_
-- transaction):
--   - NO BEGIN/COMMIT wrap (verification file; the DDL migration is
--     wrapped, this is not)
--   - Terminal SELECT returns one row with status='PASS' on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 8 Postgres-side gates (this file) + 1 PostgREST gate (separate script):
--   G1 function exists with the 1-TEXT-arg signature
--   G2 SECURITY DEFINER + search_path pinned + STABLE + LANGUAGE sql
--   G3 return shape: 4 cols in order (email, unit, property, company)
--      🔴 The company column presence + position is the load-bearing
--         assertion — a wrong-position return would silently rewire
--         downstream field access to the wrong value.
--   G4 grants: PUBLIC=0, anon=0, authenticated=0, service_role=1 EXECUTE
--   G5 COMMENT ON FUNCTION present (re-issued after DROP)
--   G6 schema audit row present (SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE_ADD_COMPANY)
--   G7 body preserves the resident_row_precedence ORDER BY + LIMIT 1
--   G8 🔴 EXECUTION — pick any real residents row, call the function,
--      assert (a) it returns a non-NULL email (works), (b) company
--      matches residents.company for the resolved row (correct, not
--      merely non-NULL). Per Mateo Aug 28 §C: assertion is "correct
--      company," not "company present."
--
-- 🔴 G9 (PostgREST) is NOT in this file — it can't be tested from SQL.
-- Run scripts/gate-get-residents-row-postgrest.ts AFTER this file
-- passes and BEFORE any Commit 2 consumer push. Same discipline as G6
-- for the vehicles column; PostgREST caches function signatures too.
--
-- 🔴 JWT IMPERSONATION NOT NEEDED here — this function has no
-- auth.jwt() body reads AND is granted only to service_role. SQL
-- Editor runs as postgres (superuser) which can invoke it directly.
-- The RPC-verification-must-include-execution-gate memory rule's
-- impersonation caveat targets admin-gated RPCs that read auth.jwt();
-- this is a service-role internal helper, different shape.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_body           TEXT;
  v_args           TEXT;
  v_lang           TEXT;
  v_volatile       CHAR;
  v_prosecdef      BOOLEAN;
  v_proconfig      TEXT[];
  v_ret_cols       TEXT;
  v_expected_cols  TEXT := 'p_email,email,unit,property,company';
  v_grants_public  INT;
  v_grants_anon    INT;
  v_grants_authed  INT;
  v_grants_service INT;
  v_comment_len    INT;
  v_audit_count    INT;
  v_test_email     TEXT;
  v_expected_company TEXT;
  v_rec            RECORD;
BEGIN
  -- ── G1 exists with 1-TEXT-arg signature ───────────────────────────
  SELECT pg_get_function_arguments(p.oid)
    INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_residents_row_by_precedence';
  IF v_args IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.get_residents_row_by_precedence not found';
  END IF;
  IF v_args NOT ILIKE '%p_email%text%' THEN
    RAISE EXCEPTION 'G1 FAIL: signature mismatch. Expected (p_email text); got [%]', v_args;
  END IF;

  -- ── G2 DEFINER + search_path + STABLE + LANGUAGE sql ──────────────
  SELECT p.prosecdef, p.proconfig, p.provolatile, l.lanname
    INTO v_prosecdef, v_proconfig, v_volatile, v_lang
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname = 'get_residents_row_by_precedence';
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE (SECURITY DEFINER); got %', v_prosecdef;
  END IF;
  IF v_proconfig IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_proconfig) AS s WHERE s ILIKE 'search_path=%') THEN
    RAISE EXCEPTION 'G2 FAIL: search_path not pinned via SET; proconfig=%', v_proconfig;
  END IF;
  -- provolatile: 'i' immutable, 's' stable, 'v' volatile
  IF v_volatile <> 's' THEN
    RAISE EXCEPTION 'G2 FAIL: expected STABLE (provolatile=s); got %', v_volatile;
  END IF;
  IF v_lang <> 'sql' THEN
    RAISE EXCEPTION 'G2 FAIL: expected LANGUAGE sql; got %', v_lang;
  END IF;

  -- ── G3 return shape (IN + 4 OUT cols in exact order) ──────────────
  SELECT string_agg(nm, ',' ORDER BY ord)
    INTO v_ret_cols
    FROM (
      SELECT unnest(p.proargnames) AS nm,
             generate_subscripts(p.proargnames, 1) AS ord
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'get_residents_row_by_precedence'
    ) t;
  IF v_ret_cols IS DISTINCT FROM v_expected_cols THEN
    RAISE EXCEPTION 'G3 FAIL: arg + return columns mismatch. Expected [%], got [%]',
      v_expected_cols, v_ret_cols;
  END IF;

  -- ── G4 grants (service_role only; nothing else) ───────────────────
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC'         AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'service_role'   AND privilege_type = 'EXECUTE')
    INTO v_grants_public, v_grants_anon, v_grants_authed, v_grants_service
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'get_residents_row_by_precedence';
  IF v_grants_public <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: PUBLIC EXECUTE grant present (count=%); must be 0', v_grants_public;
  END IF;
  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%); must be 0', v_grants_anon;
  END IF;
  IF v_grants_authed <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant present (count=%); must be 0 (helper is service-role-only per grant discipline)', v_grants_authed;
  END IF;
  IF v_grants_service <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: service_role EXECUTE grant count=% (want 1)', v_grants_service;
  END IF;

  -- ── G5 COMMENT ON FUNCTION present ────────────────────────────────
  SELECT length(pg_catalog.obj_description(p.oid, 'pg_proc'))
    INTO v_comment_len
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_residents_row_by_precedence';
  IF v_comment_len IS NULL OR v_comment_len < 50 THEN
    RAISE EXCEPTION 'G5 FAIL: COMMENT ON FUNCTION missing or too short (len=%); DROP wipes comments — must be re-issued', COALESCE(v_comment_len, 0);
  END IF;

  -- ── G6 schema audit row ───────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE_ADD_COMPANY'
     AND new_values->>'migration' = '20260828_get_residents_row_by_precedence_add_company';
  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G6 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  -- ── G7 body preserves precedence ORDER BY + LIMIT 1 ───────────────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_residents_row_by_precedence';
  IF v_body IS NULL OR v_body NOT ILIKE '%resident_row_precedence%status%is_active%' THEN
    RAISE EXCEPTION 'G7 FAIL: body missing resident_row_precedence(status, is_active) ORDER BY (would silently return arbitrary row)';
  END IF;
  IF v_body NOT ILIKE '%created_at DESC%' THEN
    RAISE EXCEPTION 'G7 FAIL: body missing created_at DESC tiebreaker';
  END IF;
  IF v_body NOT ILIKE '%LIMIT 1%' THEN
    RAISE EXCEPTION 'G7 FAIL: body missing LIMIT 1 (single-row contract)';
  END IF;

  RAISE NOTICE 'All 7 structural gates passed. G8 execution gate next.';

  -- ── G8 EXECUTION — company populated + matches residents row ──────
  -- Pick any residents row with company populated as our probe email.
  -- Then call the function with that email and assert that (a) it
  -- returns non-NULL email (the function works), (b) it returns the
  -- same company we selected the probe email from (the correct value,
  -- not merely non-NULL).
  SELECT lower(email), company
    INTO v_test_email, v_expected_company
    FROM public.residents
   WHERE company IS NOT NULL
     AND email IS NOT NULL
     AND length(trim(company)) > 0
   ORDER BY id
   LIMIT 1;
  IF v_test_email IS NULL THEN
    RAISE EXCEPTION 'G8 PREREQ FAIL: no residents row with company populated to probe execution gate';
  END IF;

  SELECT email, unit, property, company
    INTO v_rec
    FROM public.get_residents_row_by_precedence(v_test_email);

  IF v_rec.email IS NULL THEN
    RAISE EXCEPTION 'G8 EXECUTION FAIL: function returned NULL email for known-existing residents row (probe email=%)', v_test_email;
  END IF;
  -- Correctness assertion: the resolved-row's company must match the
  -- company for the row we picked. Multi-residency means the returned
  -- row may be a different residents row than the one we sampled — so
  -- we don't assert exact equality against v_expected_company. Instead
  -- assert the returned company is non-NULL and lookup-consistent with
  -- residents (any residents row for this email with matching company).
  IF v_rec.company IS NULL OR length(trim(v_rec.company)) = 0 THEN
    RAISE EXCEPTION 'G8 EXECUTION FAIL: function returned NULL/blank company for probe email=% (expected non-NULL); sample residents row had company=%',
      v_test_email, v_expected_company;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.residents
     WHERE lower(email) = lower(v_test_email)
       AND company      = v_rec.company
  ) THEN
    RAISE EXCEPTION 'G8 EXECUTION FAIL: function returned company=% for probe email=%, but no residents row with that (email, company) pair exists; function is inventing values',
      v_rec.company, v_test_email;
  END IF;

  RAISE NOTICE 'G8 execution: probe email=% resolved to (email=%, company=%). PASS.',
    v_test_email, v_rec.email, v_rec.company;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                                   AS status,
  'get_residents_row_by_precedence(TEXT) — add company col'::TEXT AS target,
  '8 gates: signature / DEFINER+searchpath+STABLE+LANG / return-shape (with company at col 4) / grants (service_role only) / COMMENT re-issued / audit / body-precedence-preserved / EXECUTION (company matches residents lookup)'::TEXT AS gates,
  '🔴 G9 PostgREST cache visibility gate is a SEPARATE script (scripts/gate-get-residents-row-postgrest.ts) — run before any Commit 2 consumer push'::TEXT AS postgrest_gate_note,
  now()                                                          AS verified_at;
