-- ══════════════════════════════════════════════════════════════════════
-- 20260829_get_user_role_by_email_verification.sql
--
-- Post-apply verification for 20260829_get_user_role_by_email.
-- v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
--
-- 7 gates (same shape as get_auth_user_id_by_email_verification):
--   G1 function exists with 1 TEXT arg
--   G2 SECURITY DEFINER + search_path pinned to '' + LANGUAGE sql
--      (uses the robust btrim+split_part predicate — Mateo Aug 29
--      correction against my initial exact-equality that missed
--      Postgres's `search_path=""` empty-value normalization)
--   G3 return type is text
--   G4 🔴 GRANTS — service_role=1, all others=0 (role oracle discipline)
--   G5 body reads public.user_roles (fully-qualified per search_path='')
--      + contains lower(email) = lower(trim(p_email)) case-insensitive
--   G6 schema audit row present
--   G7 🔴 EXECUTION — dual-shape + CASE-INSENSITIVITY probe:
--        (a) known email lowercased → returns non-NULL role
--        (b) same email UPPERCASED → also returns non-NULL role
--            (proves case-insensitive lookup — the whole reason
--            this RPC exists rather than a PostgREST .eq() filter)
--        (c) nonexistent email → returns NULL (does not raise)
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
  v_expected_role      TEXT;
  v_result_lower       TEXT;
  v_result_upper       TEXT;
  v_result_null        TEXT;
BEGIN
  -- ── G1 exists with 1 TEXT arg ───────────────────────────────────
  SELECT pg_get_function_arguments(p.oid)
    INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_user_role_by_email';
  IF v_args IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.get_user_role_by_email not found';
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
     AND p.proname = 'get_user_role_by_email';
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE (SECURITY DEFINER); got %', v_prosecdef;
  END IF;
  -- Robust predicate — strip prefix + quotes, check empty. Handles
  -- both `search_path=""` (Postgres normalization) and `search_path=`
  -- (unquoted). Same shape as get_auth_user_id_by_email_verification.
  IF v_proconfig IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM unnest(v_proconfig) AS s
        WHERE s LIKE 'search_path=%'
          AND btrim(split_part(s, '=', 2), '"') = ''
     ) THEN
    RAISE EXCEPTION 'G2 FAIL: search_path not pinned to empty. proconfig=%', v_proconfig;
  END IF;
  IF v_lang <> 'sql' THEN
    RAISE EXCEPTION 'G2 FAIL: expected LANGUAGE sql; got %', v_lang;
  END IF;

  -- ── G3 return type text ─────────────────────────────────────────
  SELECT pg_catalog.format_type(p.prorettype, NULL)
    INTO v_rettype
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_user_role_by_email';
  IF v_rettype <> 'text' THEN
    RAISE EXCEPTION 'G3 FAIL: expected RETURNS text; got %', v_rettype;
  END IF;

  -- ── G4 🔴 GRANTS ────────────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC'         AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'service_role'   AND privilege_type = 'EXECUTE')
    INTO v_grants_public, v_grants_anon, v_grants_authed, v_grants_service
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'get_user_role_by_email';
  IF v_grants_public <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: PUBLIC EXECUTE grant present (count=%). Role-by-email oracle; PUBLIC access exposes role enumeration. HALT.', v_grants_public;
  END IF;
  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%). HALT.', v_grants_anon;
  END IF;
  IF v_grants_authed <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant present (count=%). Any authenticated user could enumerate others'' roles. HALT.', v_grants_authed;
  END IF;
  IF v_grants_service <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: service_role EXECUTE grant count=% (want 1). Function is not callable from the Edge Function.', v_grants_service;
  END IF;

  -- ── G5 body references user_roles + case-insensitive lookup ──────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_user_role_by_email';
  IF v_body IS NULL OR v_body NOT ILIKE '%public.user_roles%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing reference to public.user_roles (fully-qualified name required under search_path='''')';
  END IF;
  IF v_body NOT ILIKE '%lower(email)%lower(trim(p_email))%' THEN
    RAISE EXCEPTION 'G5 FAIL: body missing case-insensitive lookup pattern lower(email) = lower(trim(p_email)). Without this the whole point of this RPC (case-insensitive match) is defeated.';
  END IF;

  -- ── G6 schema audit row ─────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action     = 'SCHEMA_GET_USER_ROLE_BY_EMAIL'
     AND table_name = 'public.get_user_role_by_email(TEXT)';
  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G6 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 6 structural gates passed. G7 execution gate next.';

  -- ── G7 EXECUTION — dual-shape + case-insensitivity probe ────────
  -- Pick any real user_roles row with a non-empty email + role.
  SELECT email, role INTO v_test_email, v_expected_role
    FROM public.user_roles
   WHERE email IS NOT NULL
     AND length(trim(email)) > 0
     AND role IS NOT NULL
     AND length(trim(role)) > 0
   ORDER BY id
   LIMIT 1;
  IF v_test_email IS NULL THEN
    RAISE EXCEPTION 'G7 PREREQ FAIL: no user_roles row with a non-empty email + role to probe';
  END IF;

  -- (a) Lowered
  v_result_lower := public.get_user_role_by_email(lower(v_test_email));
  IF v_result_lower IS NULL THEN
    RAISE EXCEPTION 'G7(a) FAIL: RPC returned NULL for a known user_roles email (probe=%, expected role=%). Body or search_path likely wrong.', lower(v_test_email), v_expected_role;
  END IF;
  IF v_result_lower <> v_expected_role THEN
    RAISE EXCEPTION 'G7(a) FAIL: RPC returned role=% for probe email=%, expected %. Body is matching more than one row.', v_result_lower, lower(v_test_email), v_expected_role;
  END IF;

  -- (b) UPPERCASED — the whole point of this RPC over PostgREST .eq()
  v_result_upper := public.get_user_role_by_email(upper(v_test_email));
  IF v_result_upper IS NULL THEN
    RAISE EXCEPTION 'G7(b) FAIL: RPC returned NULL for uppercased email (%). Case-insensitive lookup is broken — this is the failure mode that motivated this RPC over .eq(lower).', upper(v_test_email);
  END IF;
  IF v_result_upper <> v_expected_role THEN
    RAISE EXCEPTION 'G7(b) FAIL: uppercase probe returned role=%, expected %.', v_result_upper, v_expected_role;
  END IF;

  -- (c) Nonexistent
  v_result_null := public.get_user_role_by_email(
    'nobody-' || floor(extract(epoch from now()))::TEXT
      || '@nowhere.example.invalid.'
  );
  IF v_result_null IS NOT NULL THEN
    RAISE EXCEPTION 'G7(c) FAIL: RPC returned non-NULL for a nonexistent email. Lookup is matching more than it should.';
  END IF;

  RAISE NOTICE 'G7 execution: probe email=%, expected role=%. Lowered → %, uppercased → % (case-insensitive PASS), nonexistent → NULL. PASS.',
    v_test_email, v_expected_role, v_result_lower, v_result_upper;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                                       AS status,
  'get_user_role_by_email(TEXT)'::TEXT                               AS function_name,
  '7 gates: signature / DEFINER+searchpath+LANG / RETURNS text / grants (service_role only) / body-reads-user_roles-case-insensitive / audit / EXECUTION (lower + upper + null case-insensitive proof)'::TEXT AS gates,
  'Ready for swift-handler paste: reset_password admin guard uses this via .rpc() with fail-closed error handling per the handoff doc.'::TEXT AS next_step,
  now()                                                              AS verified_at;
