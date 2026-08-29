-- ══════════════════════════════════════════════════════════════════════
-- 20260829_get_auth_user_id_by_email_verification.sql
--
-- Post-apply verification for 20260829_get_auth_user_id_by_email.
-- v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row;
-- any RAISE aborts mid-DO).
--
-- 7 gates:
--   G1 function exists with 1 TEXT arg
--   G2 SECURITY DEFINER + search_path pinned to '' + LANGUAGE sql
--   G3 return type is uuid
--   G4 🔴 GRANTS — service_role=1, all others=0 (identity-oracle discipline)
--   G5 body reads auth.users (fully-qualified per search_path='')
--   G6 schema audit row present
--   G7 🔴 EXECUTION — dual-shape:
--        (a) known email in auth.users → returns non-NULL uuid
--        (b) nonexistent email → returns NULL (does not raise)
--      SQL Editor runs as postgres/service_role which has EXECUTE
--      grant; no JWT impersonation needed (function has no auth.jwt()
--      body reads and grant is service_role-only anyway).
--
-- 🔴 G4 IS THE STOP CONDITION. If anon, authenticated, or PUBLIC
-- appears in the routine_privileges output, HALT — the function is
-- an email-existence oracle and must be re-locked before any Edge
-- Function call site references it. Restore grants and re-run this
-- verification.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_args               TEXT;
  v_lang               TEXT;
  v_prosecdef          BOOLEAN;
  v_proconfig          TEXT[];
  v_rettype            TEXT;
  v_grants_public      INT;
  v_grants_anon        INT;
  v_grants_authed      INT;
  v_grants_service     INT;
  v_body               TEXT;
  v_audit_count        INT;
  v_test_email         TEXT;
  v_result_uuid        UUID;
  v_result_null        UUID;
BEGIN
  -- ── G1 exists with 1 TEXT arg ───────────────────────────────────
  SELECT pg_get_function_arguments(p.oid)
    INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_auth_user_id_by_email';
  IF v_args IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.get_auth_user_id_by_email not found';
  END IF;
  IF v_args NOT ILIKE '%p_email%text%' THEN
    RAISE EXCEPTION 'G1 FAIL: signature mismatch. Expected (p_email text); got [%]', v_args;
  END IF;

  -- ── G2 DEFINER + search_path='' + LANGUAGE sql ──────────────────
  SELECT p.prosecdef, p.proconfig, l.lanname
    INTO v_prosecdef, v_proconfig, v_lang
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname = 'get_auth_user_id_by_email';
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE (SECURITY DEFINER); got %', v_prosecdef;
  END IF;
  IF v_proconfig IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM unnest(v_proconfig) AS s
        WHERE s = 'search_path='
     ) THEN
    RAISE EXCEPTION 'G2 FAIL: expected search_path pinned to empty string via SET; got proconfig=%', v_proconfig;
  END IF;
  IF v_lang <> 'sql' THEN
    RAISE EXCEPTION 'G2 FAIL: expected LANGUAGE sql; got %', v_lang;
  END IF;

  -- ── G3 return type uuid ─────────────────────────────────────────
  SELECT pg_catalog.format_type(p.prorettype, NULL)
    INTO v_rettype
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_auth_user_id_by_email';
  IF v_rettype <> 'uuid' THEN
    RAISE EXCEPTION 'G3 FAIL: expected RETURNS uuid; got %', v_rettype;
  END IF;

  -- ── G4 🔴 GRANTS ────────────────────────────────────────────────
  -- Identity-oracle discipline. service_role=1, ALL OTHERS=0.
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC'         AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'service_role'   AND privilege_type = 'EXECUTE')
    INTO v_grants_public, v_grants_anon, v_grants_authed, v_grants_service
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'get_auth_user_id_by_email';
  IF v_grants_public <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: PUBLIC EXECUTE grant present (count=%). This is an email-existence oracle; PUBLIC access is a data-leak surface. HALT and restore grants before proceeding.', v_grants_public;
  END IF;
  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%). Anon access exposes user enumeration to the public. HALT and restore grants.', v_grants_anon;
  END IF;
  IF v_grants_authed <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant present (count=%). Any authenticated user could enumerate others by email. HALT and restore grants.', v_grants_authed;
  END IF;
  IF v_grants_service <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: service_role EXECUTE grant count=% (want 1). Function is not callable from the Edge Function.', v_grants_service;
  END IF;

  -- ── G5 body references auth.users ───────────────────────────────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_auth_user_id_by_email';
  IF v_body IS NULL OR v_body NOT ILIKE '%auth.users%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing reference to auth.users (fully-qualified name required under search_path='''')';
  END IF;

  -- ── G6 schema audit row ─────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action     = 'SCHEMA_GET_AUTH_USER_ID_BY_EMAIL'
     AND table_name = 'public.get_auth_user_id_by_email(TEXT)';
  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G6 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 6 structural gates passed. G7 execution gate next.';

  -- ── G7 EXECUTION — dual-shape ───────────────────────────────────
  -- (a) Positive: pick any real auth.users email → RPC returns id
  -- (b) Negative: nonexistent email → RPC returns NULL (does not raise)

  SELECT email INTO v_test_email
    FROM auth.users
   WHERE email IS NOT NULL
     AND length(trim(email)) > 0
   ORDER BY created_at ASC
   LIMIT 1;
  IF v_test_email IS NULL THEN
    RAISE EXCEPTION 'G7 PREREQ FAIL: no auth.users row with a non-empty email — execution gate cannot proceed';
  END IF;

  -- Positive
  v_result_uuid := public.get_auth_user_id_by_email(v_test_email);
  IF v_result_uuid IS NULL THEN
    RAISE EXCEPTION 'G7(a) FAIL: RPC returned NULL for a known-existing auth.users email (%). Body or search_path likely wrong.', v_test_email;
  END IF;

  -- Negative — construct an email guaranteed not to exist.
  -- Suffix with a timestamp so a stale probe row could not collide.
  v_result_null := public.get_auth_user_id_by_email(
    'nobody-' || floor(extract(epoch from now()))::TEXT
      || '@nowhere.example.invalid.'
  );
  IF v_result_null IS NOT NULL THEN
    RAISE EXCEPTION 'G7(b) FAIL: RPC returned non-NULL for a nonexistent email. Lookup is matching more than it should.';
  END IF;

  RAISE NOTICE 'G7 execution: positive lookup (probe email=%) → uuid returned; negative lookup → NULL. PASS.', v_test_email;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                                       AS status,
  'get_auth_user_id_by_email(TEXT)'::TEXT                            AS function_name,
  '7 gates: signature / DEFINER+searchpath+LANG / RETURNS uuid / grants (service_role only) / body-reads-auth.users / audit / EXECUTION (positive + negative NULL-safe)'::TEXT AS gates,
  'Next: hand off Commit 2 (swift-handler rewrite) to Jose for Supabase dashboard paste. Do NOT call this RPC from anywhere else — it is service_role-only by design.'::TEXT AS next_step,
  now()                                                              AS verified_at;
