-- ══════════════════════════════════════════════════════════════════════
-- 20260904_accept_saas_agreement_relax_selfserve_preflight_verification.sql
--
-- Paired verification for the accept_saas_agreement relaxation. v2
-- pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
-- 6 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  RPC signature + SECURITY DEFINER + grants unchanged
--   VS2  🔴 EXECUTION — impersonate authenticated user with NO
--        user_roles row → RPC returns success; tos_acceptances SaaS
--        row lands with company_id IS NULL; user_roles UPDATE is a
--        natural no-op (row count stays 0)
--   VS3  🔴 EXECUTION — impersonate authenticated user WITH a
--        user_roles row → company_id derived non-NULL; row FK-linked;
--        user_roles.saas_accepted_version stamped
--   VS4  Idempotency: same version twice → exactly one row
--   VS5  🔴 LINKABILITY — pick a NULL-company_id SaaS row + resolve
--        via the auth.users → user_roles → companies join → verify
--        the derived company matches the caller's actual company
--   VS6  🔴 POST-PROVISIONING RE-CALL (Mateo VS6 sharpening) —
--        after user_roles row appears, invoking the RPC again with a
--        NEW version → user_roles.saas_accepted_version stamps
--
-- ── FIXTURE DISCIPLINE ──────────────────────────────────────────────
-- Uses fresh auth.users + user_roles rows created INSIDE each DO block
-- (never a real user). All fixtures rolled back via DELETE in the same
-- block. Impersonation via set_config, RESET role after each.
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: signature + SECURITY DEFINER + grants ═════════════════════
DO $vs1$
DECLARE
  v_count INT;
  v_prosecdef BOOLEAN;
  v_proconfig TEXT[];
BEGIN
  SELECT COUNT(*)
    INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'accept_saas_agreement';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: accept_saas_agreement has % overloads (want 1)', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig
    INTO v_prosecdef, v_proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'accept_saas_agreement'
   LIMIT 1;

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS1 FAIL: prosecdef=% (want TRUE)', v_prosecdef;
  END IF;

  IF NOT ('search_path=public' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'VS1 FAIL: proconfig=% (want [search_path=public])', v_proconfig;
  END IF;

  -- to_regprocedure signature check (strips param modifiers per
  -- feedback_function_parameter_modifiers_stripped rule)
  IF to_regprocedure('public.accept_saas_agreement(text, timestamptz, inet, text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: signature drift — expected (text, timestamptz, inet, text)';
  END IF;

  -- Grant surface: PUBLIC + anon revoked; authenticated granted
  IF has_function_privilege('anon',
    'public.accept_saas_agreement(text, timestamptz, inet, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VS1 FAIL: anon has EXECUTE on accept_saas_agreement (should be revoked)';
  END IF;
  IF NOT has_function_privilege('authenticated',
    'public.accept_saas_agreement(text, timestamptz, inet, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VS1 FAIL: authenticated lacks EXECUTE on accept_saas_agreement';
  END IF;
END $vs1$;


-- ══════════════════════════════════════════════════════════════════════
-- VS2 — 🔴 EXECUTION: no user_roles row → RPC succeeds; row lands with
--       company_id IS NULL; user_roles UPDATE is a natural no-op
-- ══════════════════════════════════════════════════════════════════════
DO $vs2$
DECLARE
  v_probe_uid    UUID   := gen_random_uuid();
  v_probe_email  TEXT   := 'vs2-probe-' || substr(v_probe_uid::text, 1, 8) || '@a1parking-verification.invalid';
  v_probe_version TEXT  := 'vs2-probe-version-' || substr(v_probe_uid::text, 1, 8);
  v_row_count    INT;
  v_row          RECORD;
BEGIN
  -- Setup: create a bare auth.users row. No user_roles row (that's
  -- the whole point).
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (v_probe_uid, v_probe_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  -- Assert no user_roles row exists (guards against a stale test-user
  -- lingering with this email from a prior failed run)
  SELECT COUNT(*) INTO v_row_count
    FROM public.user_roles
   WHERE lower(email) = lower(v_probe_email);
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'VS2 FIXTURE FAIL: unexpected user_roles row for probe email %; count=%', v_probe_email, v_row_count;
  END IF;

  -- Impersonate the probe user (authenticated role, no user_roles row)
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  -- Call the RPC — should succeed, not raise
  BEGIN
    PERFORM public.accept_saas_agreement(v_probe_version, now(), NULL, 'vs2-probe-agent');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET role';
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS2 FAIL: RPC raised on no-user_roles-row path (should succeed per relaxation): sqlstate=% msg=%',
      SQLSTATE, SQLERRM;
  END;

  EXECUTE 'RESET role';

  -- Verify: tos_acceptances SaaS row landed with company_id IS NULL
  SELECT * INTO v_row
    FROM public.tos_acceptances
   WHERE user_id = v_probe_uid
     AND document_type = 'saas'
     AND saas_version = v_probe_version;

  IF v_row IS NULL THEN
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS2 FAIL: RPC returned success but tos_acceptances row was NOT written';
  END IF;

  IF v_row.company_id IS NOT NULL THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS2 FAIL: tos_acceptances.company_id=% (want NULL for pre-checkout self-serve)', v_row.company_id;
  END IF;

  -- Verify: user_roles UPDATE was a natural no-op (row count STILL 0)
  SELECT COUNT(*) INTO v_row_count
    FROM public.user_roles
   WHERE lower(email) = lower(v_probe_email);
  IF v_row_count <> 0 THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS2 FAIL: user_roles row appeared after RPC (want 0 — UPDATE should be no-op); count=%', v_row_count;
  END IF;

  -- Cleanup
  DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
  DELETE FROM auth.users WHERE id = v_probe_uid;
END $vs2$;


-- ══════════════════════════════════════════════════════════════════════
-- VS3 — 🔴 EXECUTION: WITH user_roles row → company_id derived,
--       FK-linked, saas_accepted_version stamped
-- ══════════════════════════════════════════════════════════════════════
DO $vs3$
DECLARE
  v_probe_uid    UUID   := gen_random_uuid();
  v_probe_email  TEXT   := 'vs3-probe-' || substr(v_probe_uid::text, 1, 8) || '@a1parking-verification.invalid';
  v_probe_company TEXT  := 'VS3-Probe-Company-' || substr(v_probe_uid::text, 1, 8);
  v_probe_version TEXT  := 'vs3-probe-version-' || substr(v_probe_uid::text, 1, 8);
  v_company_id   BIGINT;
  v_row          RECORD;
  v_stamped      TEXT;
BEGIN
  -- Setup: auth.users + companies + user_roles all linked
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (v_probe_uid, v_probe_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  INSERT INTO public.companies (name, tier)
  VALUES (v_probe_company, 'enforcement_only')
  RETURNING id INTO v_company_id;

  INSERT INTO public.user_roles (email, role, company, property)
  VALUES (lower(v_probe_email), 'company_admin', v_probe_company, '{}'::text[]);

  -- Impersonate
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    PERFORM public.accept_saas_agreement(v_probe_version, now(), NULL, 'vs3-probe-agent');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET role';
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS3 FAIL: RPC raised on with-user_roles path: sqlstate=% msg=%', SQLSTATE, SQLERRM;
  END;

  EXECUTE 'RESET role';

  -- Verify: company_id derived + FK-linked
  SELECT * INTO v_row
    FROM public.tos_acceptances
   WHERE user_id = v_probe_uid
     AND document_type = 'saas'
     AND saas_version = v_probe_version;

  IF v_row IS NULL THEN
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS3 FAIL: tos_acceptances SaaS row not written';
  END IF;

  IF v_row.company_id IS DISTINCT FROM v_company_id THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS3 FAIL: tos_acceptances.company_id=% (want %); derivation join broken', v_row.company_id, v_company_id;
  END IF;

  -- Verify: user_roles.saas_accepted_version stamped
  SELECT saas_accepted_version INTO v_stamped
    FROM public.user_roles
   WHERE lower(email) = lower(v_probe_email);

  IF v_stamped IS DISTINCT FROM v_probe_version THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS3 FAIL: user_roles.saas_accepted_version=%L (want %L); UPDATE not landing', v_stamped, v_probe_version;
  END IF;

  -- Cleanup
  DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
  DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
  DELETE FROM public.companies WHERE id = v_company_id;
  DELETE FROM auth.users WHERE id = v_probe_uid;
END $vs3$;


-- ══════════════════════════════════════════════════════════════════════
-- VS4 — Idempotency: same version twice → exactly one row
-- ══════════════════════════════════════════════════════════════════════
DO $vs4$
DECLARE
  v_probe_uid    UUID   := gen_random_uuid();
  v_probe_email  TEXT   := 'vs4-probe-' || substr(v_probe_uid::text, 1, 8) || '@a1parking-verification.invalid';
  v_probe_version TEXT  := 'vs4-probe-version-' || substr(v_probe_uid::text, 1, 8);
  v_row_count    INT;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (v_probe_uid, v_probe_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    PERFORM public.accept_saas_agreement(v_probe_version, now(), NULL, 'vs4-first');
    PERFORM public.accept_saas_agreement(v_probe_version, now(), NULL, 'vs4-second');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET role';
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS4 FAIL: RPC raised on idempotency path: sqlstate=% msg=%', SQLSTATE, SQLERRM;
  END;

  EXECUTE 'RESET role';

  SELECT COUNT(*) INTO v_row_count
    FROM public.tos_acceptances
   WHERE user_id = v_probe_uid
     AND document_type = 'saas'
     AND saas_version = v_probe_version;

  IF v_row_count <> 1 THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS4 FAIL: expected exactly 1 SaaS row after 2 calls (idempotent); got %', v_row_count;
  END IF;

  DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
  DELETE FROM auth.users WHERE id = v_probe_uid;
END $vs4$;


-- ══════════════════════════════════════════════════════════════════════
-- VS5 — 🔴 LINKABILITY: pick a NULL-company_id SaaS row + resolve via
--       the join → verify it produces the expected company
--
-- This is the LOAD-BEARING linkability proof. NULL company_id is
-- tolerable only if the join chain actually resolves. Setup creates
-- BOTH the NULL row AND the resolvable user_roles + companies chain,
-- then joins them to prove the row-with-NULL-company can still be
-- attributed to its owner.
-- ══════════════════════════════════════════════════════════════════════
DO $vs5$
DECLARE
  v_probe_uid    UUID   := gen_random_uuid();
  v_probe_email  TEXT   := 'vs5-probe-' || substr(v_probe_uid::text, 1, 8) || '@a1parking-verification.invalid';
  v_probe_company TEXT  := 'VS5-Probe-Company-' || substr(v_probe_uid::text, 1, 8);
  v_probe_version TEXT  := 'vs5-probe-version-' || substr(v_probe_uid::text, 1, 8);
  v_company_id   BIGINT;
  v_resolved_id  BIGINT;
BEGIN
  -- Setup: auth.users + call RPC pre-user_roles (row lands NULL)
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (v_probe_uid, v_probe_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  PERFORM public.accept_saas_agreement(v_probe_version, now(), NULL, 'vs5-probe-agent');

  EXECUTE 'RESET role';

  -- Now simulate the webhook: create companies + user_roles (post-checkout)
  INSERT INTO public.companies (name, tier)
  VALUES (v_probe_company, 'enforcement_only')
  RETURNING id INTO v_company_id;

  INSERT INTO public.user_roles (email, role, company, property)
  VALUES (lower(v_probe_email), 'company_admin', v_probe_company, '{}'::text[]);

  -- The load-bearing join — same chain the 2026-07-13 backfill uses
  SELECT c.id INTO v_resolved_id
    FROM public.tos_acceptances ta
    JOIN auth.users u        ON u.id = ta.user_id
    JOIN public.user_roles ur ON lower(ur.email) = lower(u.email)
    JOIN public.companies c   ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ta.user_id = v_probe_uid
     AND ta.document_type = 'saas'
     AND ta.company_id IS NULL
   LIMIT 1;

  IF v_resolved_id IS NULL THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS5 FAIL (LOAD-BEARING): linkability join did NOT resolve NULL-company_id SaaS row to its company. NULL company_id is now a black hole — no way to answer "which company signed this SaaS agreement" for self-serve subscribers.';
  END IF;

  IF v_resolved_id <> v_company_id THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS5 FAIL: linkability join resolved to WRONG company (got %, want %); join predicate is broken', v_resolved_id, v_company_id;
  END IF;

  -- Cleanup
  DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
  DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
  DELETE FROM public.companies WHERE id = v_company_id;
  DELETE FROM auth.users WHERE id = v_probe_uid;
END $vs5$;


-- ══════════════════════════════════════════════════════════════════════
-- VS6 — 🔴 POST-PROVISIONING RE-CALL (Mateo VS6 sharpening)
--
-- The no-op-when-missing behavior of the UPDATE is DELIBERATE — we
-- deliberately don't RAISE. This gate proves that when user_roles
-- LATER appears (post-webhook) and the RPC is invoked again (e.g., a
-- version bump), the version stamp DOES land. Prevents the "silent
-- no-op forever" failure mode by asserting the UPDATE path is
-- functional when the row exists.
-- ══════════════════════════════════════════════════════════════════════
DO $vs6$
DECLARE
  v_probe_uid    UUID   := gen_random_uuid();
  v_probe_email  TEXT   := 'vs6-probe-' || substr(v_probe_uid::text, 1, 8) || '@a1parking-verification.invalid';
  v_probe_company TEXT  := 'VS6-Probe-Company-' || substr(v_probe_uid::text, 1, 8);
  v_probe_v1     TEXT  := 'vs6-v1-' || substr(v_probe_uid::text, 1, 8);
  v_probe_v2     TEXT  := 'vs6-v2-' || substr(v_probe_uid::text, 1, 8);
  v_company_id   BIGINT;
  v_stamped      TEXT;
BEGIN
  -- Setup: auth.users only, call RPC v1 pre-user_roles
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES (v_probe_uid, v_probe_email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  PERFORM public.accept_saas_agreement(v_probe_v1, now(), NULL, 'vs6-pre-webhook');

  EXECUTE 'RESET role';

  -- Simulate webhook: create companies + user_roles
  INSERT INTO public.companies (name, tier)
  VALUES (v_probe_company, 'enforcement_only')
  RETURNING id INTO v_company_id;

  INSERT INTO public.user_roles (email, role, company, property)
  VALUES (lower(v_probe_email), 'company_admin', v_probe_company, '{}'::text[]);

  -- Assert user_roles.saas_accepted_version is NULL post-webhook
  -- (proves the pre-webhook RPC UPDATE was a no-op as expected)
  SELECT saas_accepted_version INTO v_stamped
    FROM public.user_roles
   WHERE lower(email) = lower(v_probe_email);

  IF v_stamped IS NOT NULL THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS6 FAIL (unexpected): user_roles.saas_accepted_version=%L after webhook (want NULL — pre-webhook RPC should not have stamped it). Setup contract broken.', v_stamped;
  END IF;

  -- Now re-call RPC with a NEW version (version bump) — user_roles
  -- exists NOW, so the UPDATE should land
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_probe_uid::text, 'role', 'authenticated', 'email', v_probe_email)::text,
    true);
  PERFORM set_config('role', 'authenticated', true);

  PERFORM public.accept_saas_agreement(v_probe_v2, now(), NULL, 'vs6-post-webhook');

  EXECUTE 'RESET role';

  -- Verify: user_roles.saas_accepted_version now stamps to v_probe_v2
  SELECT saas_accepted_version INTO v_stamped
    FROM public.user_roles
   WHERE lower(email) = lower(v_probe_email);

  IF v_stamped IS DISTINCT FROM v_probe_v2 THEN
    DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
    DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
    DELETE FROM public.companies WHERE id = v_company_id;
    DELETE FROM auth.users WHERE id = v_probe_uid;
    RAISE EXCEPTION 'VS6 FAIL: user_roles.saas_accepted_version=%L (want %L) after post-webhook re-call; UPDATE path broken', v_stamped, v_probe_v2;
  END IF;

  -- Cleanup
  DELETE FROM public.tos_acceptances WHERE user_id = v_probe_uid;
  DELETE FROM public.user_roles WHERE lower(email) = lower(v_probe_email);
  DELETE FROM public.companies WHERE id = v_company_id;
  DELETE FROM auth.users WHERE id = v_probe_uid;
END $vs6$;


-- ══════════════════════════════════════════════════════════════════════
-- Audit row present (companion gate — Part 5 landed)
-- ══════════════════════════════════════════════════════════════════════
DO $vs7$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_ACCEPT_SAAS_AGREEMENT_RELAX'
     AND new_values ->> 'migration' = '20260904_accept_saas_agreement_relax_selfserve_preflight';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS7 FAIL: audit row missing';
  END IF;
END $vs7$;


-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'accept_saas_agreement selfserve preflight relaxation'::TEXT AS target,
  ARRAY[
    'VS1  signature + SECURITY DEFINER + grants unchanged',
    'VS2  🔴 execution: no user_roles row → RPC succeeds, tos_acceptances row lands with company_id IS NULL, user_roles UPDATE natural no-op',
    'VS3  🔴 execution: with user_roles row → company_id derived FK-linked, saas_accepted_version stamped',
    'VS4  idempotency: same version twice → exactly 1 row',
    'VS5  🔴 LOAD-BEARING linkability: NULL-company_id row resolves via auth.users → user_roles → companies join to correct company',
    'VS6  🔴 post-provisioning re-call: version bump after user_roles appears → saas_accepted_version stamps (proves UPDATE path functional when row exists)',
    'VS7  SCHEMA_ACCEPT_SAAS_AGREEMENT_RELAX audit row'
  ] AS gates_verified,
  now() AS verified_at;
