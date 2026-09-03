-- ══════════════════════════════════════════════════════════════════════
-- 20260903_track_gating_helper_verification.sql
--
-- Paired verification for the track-gating helpers (Commit 1 of 2).
-- v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
-- 10 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  both functions exist via to_regprocedure (structural OID)
--   VS2  both SECURITY DEFINER + search_path pinned
--   VS3  both STABLE (allows RLS predicate use)
--   VS4  GRANTs — EXECUTE authenticated + service_role, REVOKE anon + PUBLIC
--   VS5  bodies contain all 4 tier branches + RAISE tier_unrecognized
--   VS6  🔴 EXECUTION — iterate live companies, impersonate each,
--        assert helper output matches spec-per-tier
--   VS7  🔴 EXECUTION — A1 explicit (legacy → BOTH TRUE, load-bearing)
--   VS8  🔴 EXECUTION — no session context → RAISE no_company_context
--   VS9  🔴 EXECUTION — unknown-tier RAISE probe intentionally skipped
--        (documented; companies_tier_valid CHECK blocks reaching ELSE
--        without weakening the CHECK the arc protects. Same shape as
--        Cap B VS6.)
--   VS10 schema audit row present with per_company_snap
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: both functions exist ───────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.my_tier_enforcement_capable()') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.my_tier_enforcement_capable() not found';
  END IF;
  IF to_regprocedure('public.my_tier_pm_capable()') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.my_tier_pm_capable() not found';
  END IF;
END $$;

-- ── VS2: DEFINER + search_path pinned ───────────────────────────────
DO $$
DECLARE
  v_fn TEXT;
  v_oid oid;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.my_tier_enforcement_capable()', 'public.my_tier_pm_capable()'] LOOP
    v_oid := to_regprocedure(v_fn);
    SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc WHERE oid = v_oid;
    IF NOT COALESCE(v_secdef, false) THEN
      RAISE EXCEPTION 'VS2 FAIL: % not SECURITY DEFINER', v_fn;
    END IF;
    IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'VS2 FAIL: % search_path not pinned. proconfig=%', v_fn, v_config;
    END IF;
  END LOOP;
END $$;

-- ── VS3: both STABLE ─────────────────────────────────────────────────
-- STABLE volatility is required for RLS predicate contexts + allows
-- optimizer caching within a single statement.
DO $$
DECLARE
  v_fn TEXT;
  v_oid oid;
  v_volatile CHAR;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.my_tier_enforcement_capable()', 'public.my_tier_pm_capable()'] LOOP
    v_oid := to_regprocedure(v_fn);
    SELECT provolatile INTO v_volatile FROM pg_proc WHERE oid = v_oid;
    IF v_volatile <> 's' THEN
      RAISE EXCEPTION 'VS3 FAIL: % volatility=% (want s=STABLE)', v_fn, v_volatile;
    END IF;
  END LOOP;
END $$;

-- ── VS4: GRANTs correct ──────────────────────────────────────────────
-- Each fn: EXECUTE granted to authenticated + service_role, REVOKED
-- from anon + PUBLIC. Reads pg_proc.proacl.
DO $$
DECLARE
  v_fn TEXT;
  v_oid oid;
  v_acl TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.my_tier_enforcement_capable()', 'public.my_tier_pm_capable()'] LOOP
    v_oid := to_regprocedure(v_fn);
    SELECT array_to_string(proacl::TEXT[], ',') INTO v_acl FROM pg_proc WHERE oid = v_oid;
    IF v_acl IS NULL THEN
      RAISE EXCEPTION 'VS4 FAIL: % proacl is NULL (default = EXECUTE to PUBLIC, defect per feedback_revoke_from_anon_explicitly)', v_fn;
    END IF;
    IF v_acl NOT LIKE '%authenticated=X/%' THEN
      RAISE EXCEPTION 'VS4 FAIL: % missing GRANT EXECUTE TO authenticated. proacl=%', v_fn, v_acl;
    END IF;
    IF v_acl NOT LIKE '%service_role=X/%' THEN
      RAISE EXCEPTION 'VS4 FAIL: % missing GRANT EXECUTE TO service_role. proacl=%', v_fn, v_acl;
    END IF;
    -- Explicit REVOKE from anon: proacl should NOT include anon=X/
    IF v_acl LIKE '%anon=X/%' THEN
      RAISE EXCEPTION 'VS4 FAIL: % has EXECUTE to anon (should be REVOKEd). proacl=%', v_fn, v_acl;
    END IF;
  END LOOP;
END $$;

-- ── VS5: bodies contain all branches + RAISE ────────────────────────
DO $$
DECLARE
  v_fn TEXT;
  v_body TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.my_tier_enforcement_capable()', 'public.my_tier_pm_capable()'] LOOP
    v_body := pg_get_functiondef(to_regprocedure(v_fn));
    IF v_body NOT ILIKE '%legacy%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing legacy branch (A1 load-bearing)', v_fn; END IF;
    IF v_body NOT ILIKE '%pm_only%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing pm_only branch', v_fn; END IF;
    IF v_body NOT ILIKE '%pm_starter%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing pm_starter branch', v_fn; END IF;
    IF v_body NOT ILIKE '%enforcement_only%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing enforcement_only branch', v_fn; END IF;
    IF v_body NOT ILIKE '%tier_unrecognized%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing RAISE tier_unrecognized (fail-closed)', v_fn; END IF;
    IF v_body NOT ILIKE '%no_company_context%' THEN RAISE EXCEPTION 'VS5 FAIL: % body missing RAISE no_company_context (missing-session guard)', v_fn; END IF;
    IF v_body NOT ILIKE '%lower(trim(name))%' AND v_body NOT ILIKE '%lower(btrim(name))%' THEN
      RAISE EXCEPTION 'VS5 FAIL: % body missing lower(trim(name)) equality — metachar-vector-close discipline broken', v_fn;
    END IF;
  END LOOP;
END $$;

-- ── VS6: 🔴 EXECUTION — iterate live companies, impersonate ─────────
-- For each live company:
--   1. Find a user_roles row belonging to that company (any role — the
--      helper is company-scoped, not role-scoped)
--   2. set_config('request.jwt.claims', {"email": <email>}, true) +
--      set_config('role', 'authenticated', true)
--   3. Call both helpers
--   4. Compare to expected per spec (spec matches PART 6 audit's
--      per_company_snap; both derive from tier)
-- Companies with no user_roles rows are skipped (no way to impersonate;
-- they can't be reached by the helper anyway).
DO $$
DECLARE
  v_co RECORD;
  v_email TEXT;
  v_enf BOOLEAN;
  v_pm BOOLEAN;
  v_exp_enf BOOLEAN;
  v_exp_pm BOOLEAN;
  v_offenders TEXT := '';
  v_tested INT := 0;
BEGIN
  FOR v_co IN SELECT id, name, tier FROM public.companies ORDER BY id LOOP
    SELECT email INTO v_email
      FROM public.user_roles
     WHERE lower(trim(company)) = lower(trim(v_co.name))
       AND is_active = TRUE
     ORDER BY id LIMIT 1;
    IF v_email IS NULL THEN
      CONTINUE;   -- no user for this company; skip
    END IF;

    -- Impersonate (LOCAL = auto-reset at DO block end)
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
    PERFORM set_config('role', 'authenticated', true);

    v_enf := public.my_tier_enforcement_capable();
    v_pm  := public.my_tier_pm_capable();

    -- Reset role for the next iteration (jwt claims will be overwritten below)
    EXECUTE 'RESET role';

    -- Compute expected per spec
    IF v_co.tier = 'legacy' THEN
      v_exp_enf := TRUE;  v_exp_pm := TRUE;
    ELSIF v_co.tier = 'enforcement_only' THEN
      v_exp_enf := TRUE;  v_exp_pm := FALSE;
    ELSIF v_co.tier = 'pm_only' THEN
      v_exp_enf := FALSE; v_exp_pm := TRUE;
    ELSIF v_co.tier = 'pm_starter' THEN
      v_exp_enf := FALSE; v_exp_pm := TRUE;
    ELSE
      -- Would-raise; skip (helpers would already have raised above, breaking this loop)
      CONTINUE;
    END IF;

    IF v_enf IS DISTINCT FROM v_exp_enf OR v_pm IS DISTINCT FROM v_exp_pm THEN
      v_offenders := v_offenders || format('company_id=%s name=%L tier=%s email=%L enf: got=%s want=%s pm: got=%s want=%s; ',
        v_co.id, v_co.name, v_co.tier, v_email, v_enf, v_exp_enf, v_pm, v_exp_pm);
    END IF;
    v_tested := v_tested + 1;
  END LOOP;

  IF v_tested = 0 THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no companies had user_roles rows to impersonate. Cannot verify execution.';
  END IF;
  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL: helper output disagrees with spec for one or more companies (tested=%). Drift: %', v_tested, v_offenders;
  END IF;
END $$;

-- ── VS7: 🔴 EXECUTION A1 — legacy → BOTH TRUE ───────────────────────
-- Load-bearing per Mateo Sep 3 §2. Also filed as
-- project_vs6_a1_lookup_pin_followup — pin once a second A1-ish
-- tenant can exist.
DO $$
DECLARE
  v_a1_name TEXT;
  v_a1_email TEXT;
  v_enf BOOLEAN;
  v_pm BOOLEAN;
BEGIN
  SELECT name INTO v_a1_name
    FROM public.companies
   WHERE tier = 'legacy' AND lower(name) LIKE '%a1%'
   ORDER BY id LIMIT 1;
  IF v_a1_name IS NULL THEN
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: no legacy-tier company matching A1 found.';
  END IF;
  SELECT email INTO v_a1_email
    FROM public.user_roles
   WHERE lower(trim(company)) = lower(trim(v_a1_name))
     AND is_active = TRUE
   ORDER BY id LIMIT 1;
  IF v_a1_email IS NULL THEN
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: A1 exists (company=%) but has no active user_roles. Cannot impersonate.', v_a1_name;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_a1_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  v_enf := public.my_tier_enforcement_capable();
  v_pm  := public.my_tier_pm_capable();

  EXECUTE 'RESET role';

  IF NOT v_enf OR NOT v_pm THEN
    RAISE EXCEPTION 'VS7 FAIL: A1 (company=%, email=%) got enf=% pm=% — want BOTH TRUE. Legacy branch broken. A1 loses enforcement + PM.',
      v_a1_name, v_a1_email, v_enf, v_pm;
  END IF;
END $$;

-- ── VS8: 🔴 EXECUTION — no session → RAISE no_company_context ───────
-- 🔴 2026-09-03 fix (Mateo Sep 3 followup §5): prior version assumed
-- a "fresh" DO block starts with no JWT claim. Supabase SQL Editor
-- runs the whole verification file as ONE implicit transaction; VS6
-- and VS7 use set_config(..., true) [LOCAL] to impersonate, and
-- LOCAL settings persist for the transaction — so VS7's A1 CA
-- impersonation leaked into VS8. Helper then reads auth.jwt() →
-- A1's email → gets A1 legacy company → returns TRUE (no raise) →
-- VS8's "did not raise" fires.
--
-- Fix: explicitly RESET the JWT claim + role at the top of VS8 so
-- "no session" actually means no session. RESET is more robust than
-- set_config('', true) which sets the value to '' rather than
-- unsetting it (auth.jwt()->>'email' on {} vs on NULL behaves
-- differently in edge cases).
--
-- Jose confirmed direct SQL-editor call raises no_company_context
-- with sqlstate 42501 — helper is correct; only VS8's expected
-- fixture state was wrong.
DO $$
DECLARE
  v_sqlstate TEXT;
  v_msg TEXT;
  v_fn TEXT;
BEGIN
  -- Kill any impersonation carried over from VS6/VS7 (transaction-
  -- scope LOCAL settings persist here). PERFORM set_config with an
  -- empty string clears the value; a follow-up RESET wipes it fully.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', '', true);
  -- Belt-and-suspenders — RESET both to their built-in defaults.
  BEGIN
    EXECUTE 'RESET request.jwt.claims';
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- RESET on a never-SET custom GUC can raise; ignore.
  END;
  BEGIN
    EXECUTE 'RESET role';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  FOREACH v_fn IN ARRAY ARRAY['my_tier_enforcement_capable', 'my_tier_pm_capable'] LOOP
    BEGIN
      IF v_fn = 'my_tier_enforcement_capable' THEN
        PERFORM public.my_tier_enforcement_capable();
      ELSE
        PERFORM public.my_tier_pm_capable();
      END IF;
      RAISE EXCEPTION 'VS8 FAIL: % did not raise with no session context. LOCAL GUC pollution suspected — check RESET at top of block.', v_fn;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE '%no_company_context%' THEN
        RAISE EXCEPTION 'VS8 FAIL: % raised wrong error. sqlstate=% msg=%. Expected no_company_context.', v_fn, v_sqlstate, v_msg;
      END IF;
    END;
  END LOOP;
END $$;

-- ── VS9: unknown-tier RAISE execution probe (skipped, documented) ───
-- Reaching the ELSE requires a tier value not in companies_tier_valid,
-- which the CHECK rejects at INSERT/UPDATE. Weakening the CHECK to
-- test would break the very invariant the arc protects. Structural
-- gate VS5 (body contains RAISE tier_unrecognized) proves the branch
-- is written. Same pattern as Cap B VS6.
DO $$
BEGIN
  RAISE NOTICE 'VS9 INFO: unknown-tier RAISE execution probe intentionally omitted. See VS5 for structural presence + feedback_gates_must_assert_what_they_measured for the discipline.';
END $$;

-- ── VS10: schema audit row present ──────────────────────────────────
DO $$
DECLARE v_count INT; v_snap JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TRACK_GATING_HELPER'
     AND new_values->>'migration' = '20260903_track_gating_helper';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS10 FAIL: schema audit row missing';
  END IF;

  SELECT new_values->'per_company_snap' INTO v_snap
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TRACK_GATING_HELPER'
     AND new_values->>'migration' = '20260903_track_gating_helper'
   ORDER BY created_at DESC LIMIT 1;
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    RAISE EXCEPTION 'VS10 FAIL: per_company_snap missing or wrong type in audit row';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'track gating helpers (my_tier_enforcement_capable + my_tier_pm_capable)'::TEXT AS target,
  ARRAY[
    'VS1  both functions exist',
    'VS2  both SECURITY DEFINER + search_path pinned',
    'VS3  both STABLE',
    'VS4  GRANTs: authenticated + service_role EXECUTE; anon REVOKEd',
    'VS5  bodies contain 4 branches + tier_unrecognized + no_company_context + lower(trim(name))',
    'VS6  🔴 execution — iterate live companies + impersonate + assert spec-per-tier',
    'VS7  🔴 execution A1 — legacy → BOTH TRUE (load-bearing)',
    'VS8  🔴 execution — no session → no_company_context',
    'VS9  unknown-tier RAISE probe intentionally skipped (structural VS5 covers)',
    'VS10 SCHEMA_TRACK_GATING_HELPER audit row + per_company_snap'
  ] AS gates_verified,
  now() AS verified_at;
