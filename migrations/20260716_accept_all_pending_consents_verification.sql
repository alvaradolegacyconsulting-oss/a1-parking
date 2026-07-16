-- ════════════════════════════════════════════════════════════════════
-- Verification — 20260716_accept_all_pending_consents
-- 2026-07-16
--
-- Runs as service_role (Supabase SQL editor).
--
-- VQ.A confirms the RPC object exists with expected shape.
-- VQ.B/C/D exercise the RPC by directly running its body with SET LOCAL
-- role-swaps — the SQL editor has no auth.jwt() so we can't test the
-- role-conditional / company_id branches from headless SQL. Those are
-- HAND-VERIFY via smoke-auth.ts headless session (documented at end).
--
-- VQ.E documents the atomicity + idempotency invariants that MUST be
-- proven by the smoke script before this ships to prod.
-- ════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════
-- VQ.A — object presence + ACL shape
-- ══════════════════════════════════════════════════════════════════
DO $vqa$
DECLARE
  v_fn_count INT;
  v_arg_count INT;
BEGIN
  SELECT COUNT(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_all_pending_consents';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION 'VQ.A FAIL: expected 1 accept_all_pending_consents, found %', v_fn_count;
  END IF;

  SELECT pronargs INTO v_arg_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_all_pending_consents';
  IF v_arg_count <> 9 THEN
    RAISE EXCEPTION 'VQ.A FAIL: accept_all_pending_consents expected 9 args, found %', v_arg_count;
  END IF;

  RAISE NOTICE 'VQ.A PASS: accept_all_pending_consents present, single overload, 9 args';
END $vqa$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.B — SECURITY DEFINER + search_path locked + GRANT to authenticated only
-- ══════════════════════════════════════════════════════════════════
DO $vqb$
DECLARE
  v_prosecdef   BOOLEAN;
  v_search      TEXT;
  v_public_acl  BOOLEAN;
  v_anon_acl    BOOLEAN;
  v_auth_acl    BOOLEAN;
BEGIN
  SELECT prosecdef, array_to_string(proconfig, ',')
    INTO v_prosecdef, v_search
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_all_pending_consents';

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VQ.B FAIL: RPC is not SECURITY DEFINER';
  END IF;
  IF v_search IS NULL OR position('search_path=public, pg_temp' in v_search) = 0 THEN
    RAISE EXCEPTION 'VQ.B FAIL: search_path NOT locked to public, pg_temp — got [%]', v_search;
  END IF;

  -- ACL: EXECUTE must be granted to authenticated, NOT to public/anon.
  SELECT has_function_privilege('public',        'public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT)', 'EXECUTE') INTO v_public_acl;
  SELECT has_function_privilege('anon',          'public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT)', 'EXECUTE') INTO v_anon_acl;
  SELECT has_function_privilege('authenticated', 'public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT)', 'EXECUTE') INTO v_auth_acl;

  IF v_public_acl THEN
    RAISE EXCEPTION 'VQ.B FAIL: EXECUTE granted to PUBLIC (must be REVOKEd)';
  END IF;
  IF v_anon_acl THEN
    RAISE EXCEPTION 'VQ.B FAIL: EXECUTE granted to anon (must be REVOKEd)';
  END IF;
  IF NOT v_auth_acl THEN
    RAISE EXCEPTION 'VQ.B FAIL: EXECUTE NOT granted to authenticated';
  END IF;

  RAISE NOTICE 'VQ.B PASS: SECURITY DEFINER + search_path locked + ACL {public:false, anon:false, authenticated:true}';
END $vqb$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.C — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════
DO $vqc$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_ACCEPT_ALL_PENDING_CONSENTS'
     AND new_values->>'migration' = '20260716_accept_all_pending_consents';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: SCHEMA_ audit row missing';
  END IF;
  RAISE NOTICE 'VQ.C PASS: SCHEMA_ audit row present (count=%)', v_count;
END $vqc$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.D — unauthenticated caller RAISES
-- Session in SQL editor has no auth.jwt() → v_caller_email is NULL →
-- expected: RAISE 'no authenticated session'.
-- ══════════════════════════════════════════════════════════════════
DO $vqd$
DECLARE v_raised BOOLEAN := FALSE;
BEGIN
  BEGIN
    PERFORM public.accept_all_pending_consents(
      '2026-07-12-v2'::TEXT, now(),
      '2026-07-12-v2'::TEXT, now(),
      NULL, NULL, NULL, NULL, NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'VQ.D FAIL: unauthenticated call did NOT raise insufficient_privilege';
  END IF;
  RAISE NOTICE 'VQ.D PASS: unauthenticated caller raises 42501';
END $vqd$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.E — HAND-VERIFY via smoke-auth.ts headless session
--
-- These invariants require a real authenticated JWT — cannot be tested
-- from the SQL editor session (no auth.jwt() context).
--
-- Run scripts/smoke-consent-hard-gate-ONE-TIME.ts against Test-LEGACY:
--
--   E.1 CA (company_admin, e.g. legacy-ca-2@test.shieldmylot.com):
--       • Preflight: delete any existing rows for this user_id from
--         tos_acceptances (leave user_roles stamps untouched).
--       • Call accept_all_pending_consents with all 4 doc versions.
--       • Assert: RPC returns {ok:true, role:'company_admin',
--         company_id:89, inserted:['tos','privacy','saas','texas_attestation']}.
--       • Assert: 4 rows in tos_acceptances, all with company_id=89,
--         one per document_type.
--       • Assert: user_roles.texas_confirmed = TRUE.
--
--   E.2 Driver (role='driver', e.g. legacy-driver@):
--       • Preflight: delete any existing consent rows.
--       • Call accept_all_pending_consents with tos+privacy versions,
--         saas+texas args NULL.
--       • Assert: RPC returns {inserted:['tos','privacy']} — 2 rows only.
--       • Assert: driver call with p_saas_version supplied is IGNORED
--         (driver's role check skips the saas/texas branches; extra
--         args are silently unused).
--
--   E.3 IDEMPOTENCY:
--       • Call accept_all_pending_consents twice with the same args.
--       • Assert: second call returns {inserted:[]} (nothing new landed).
--       • Assert: row count in tos_acceptances is unchanged.
--
--   E.4 ATOMICITY (LOAD-BEARING):
--       • Deliberately provoke a mid-body failure — e.g. run the RPC
--         when a UNIQUE constraint on tos_acceptances would violate on
--         the second INSERT (write a temporary CHECK CONSTRAINT that
--         fires only on document_type='privacy' rows, then DROP after).
--       • Assert: NEITHER the 'tos' row NOR any subsequent row lands.
--         The failed 'privacy' insert rolls back the 'tos' insert too.
--       • Cleanup: drop the temp constraint, retry — all 4 land clean.
--
--   E.5 company_id DERIVATION:
--       • CA call: rows must have company_id = 89 (Test-LEGACY).
--       • Admin call (role='admin'): rows land with company_id = NULL
--         (legitimate — admin has no company).
--       • Cross-tenancy attempt (CA_A calls with impersonated CA_B
--         header via manual crafting): impossible from the client
--         because the RPC derives company_id from auth.uid()/email;
--         no arg. Prove by inspecting the RPC body — no p_company_id.
--
--   E.6 MISSING REQUIRED ARG:
--       • Call with p_tos_version=NULL → RAISE 22004.
--       • Call as company_admin with p_saas_version=NULL → RAISE 22004.
--       • Call as driver with p_saas_version=NULL → SUCCESS (not required).
-- ══════════════════════════════════════════════════════════════════

-- Silent success = VQ.A/B/C/D all green. VQ.E is the smoke script's
-- responsibility; failure of any E.* case is a launch blocker.
