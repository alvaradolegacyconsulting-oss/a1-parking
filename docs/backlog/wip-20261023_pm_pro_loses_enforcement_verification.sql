-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — pairs with wip-20261023_pm_pro_loses_enforcement.sql
-- ════════════════════════════════════════════════════════════════════
--
-- Covers the HELPER and the trigger's STRUCTURE. The role-dependent
-- half — a signed-in PostgREST insert being refused while service_role
-- and the DEFINER RPC pass — cannot be exercised honestly from a DO
-- block, because the trigger's whole mechanism is current_user and
-- SET ROLE inside a shared transaction risks leaving the session as
-- 'authenticated' with cleanup still to do. That half is
-- npm run verify:pmpronoenforcement, the same split the vehicles
-- activation guard uses (SQL for structure, TS for the role paths).
--
-- 🔴 A1 IS READ-ONLY HERE. VS2 resolves the helper for every real
-- company by setting request.jwt.claims to an email that ALREADY exists
-- in user_roles for that company, transaction-locally. Nothing is
-- written to A1, to its users, or to any production-env tenant.
--
-- No BEGIN/COMMIT. Re-runnable. Terminal SELECT returns a PASS row.
-- ════════════════════════════════════════════════════════════════════

-- ── VS1: structure ──────────────────────────────────────────────────
DO $$
DECLARE
  v_src     TEXT;
  v_secdef  BOOLEAN;
  v_timing  TEXT;
  v_ev      TEXT;
BEGIN
  -- The helper must actually read tier_type, or legacy is still
  -- unconditional and this whole change is cosmetic.
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.my_tier_enforcement_capable()');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: my_tier_enforcement_capable() does not exist';
  END IF;
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');
  IF position('tier_type' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: the helper body never reads tier_type, so legacy is still unconditional';
  END IF;
  IF position('property_management' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: the helper body does not branch on property_management';
  END IF;

  -- 🔴 The trigger function must NOT be SECURITY DEFINER. If it is,
  -- current_user is the owner for every caller, the first branch always
  -- returns early, and the guard is silently inert while every
  -- structural check still passes.
  SELECT prosecdef INTO v_secdef FROM pg_proc
   WHERE oid = to_regprocedure('public.reject_violation_without_enforcement_capability()');
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: reject_violation_without_enforcement_capability() does not exist';
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'VS1 FAIL: the trigger function is SECURITY DEFINER — current_user would be the owner for every caller and the guard is inert';
  END IF;

  SELECT CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END,
         CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' ELSE 'other' END
    INTO v_timing, v_ev
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.violations'::regclass
     AND t.tgname = 'violations_require_enforcement_capability'
     AND NOT t.tgisinternal;
  IF v_timing IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: trigger violations_require_enforcement_capability is not on public.violations';
  END IF;
  IF v_timing <> 'BEFORE' OR v_ev <> 'INSERT' THEN
    RAISE EXCEPTION 'VS1 FAIL: trigger is % %, expected BEFORE INSERT', v_timing, v_ev;
  END IF;

  RAISE NOTICE 'VS1 PASS: helper reads tier_type, trigger is BEFORE INSERT, trigger fn is INVOKER';
END $$;

-- ── VS2: the helper, resolved for every REAL company (read-only) ────
DO $$
DECLARE
  r         RECORD;
  v_email   TEXT;
  v_got     BOOLEAN;
  v_want    BOOLEAN;
  v_checked INTEGER := 0;
  v_a1_seen BOOLEAN := FALSE;
  v_fail    TEXT[] := '{}';
BEGIN
  FOR r IN SELECT id, name, tier, tier_type FROM public.companies ORDER BY id LOOP
    SELECT email INTO v_email FROM public.user_roles
     WHERE lower(trim(company)) = lower(trim(r.name)) AND is_active IS NOT FALSE
     ORDER BY id LIMIT 1;

    IF v_email IS NULL THEN
      -- 🔴 Absence must not read as a pass. Say which company could not
      -- be exercised rather than skipping it silently.
      RAISE NOTICE 'VS2 NOT EXERCISED: % (%/%) has no active user_roles row to borrow',
        r.name, r.tier_type, r.tier;
      CONTINUE;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
    PERFORM set_config('request.jwt.claim.email', v_email, true);

    v_want := CASE
                WHEN r.tier = 'legacy' AND r.tier_type = 'enforcement' THEN TRUE
                WHEN r.tier = 'legacy' AND r.tier_type = 'property_management' THEN FALSE
                WHEN r.tier = 'enforcement_only' THEN TRUE
                ELSE FALSE
              END;
    v_got := public.my_tier_enforcement_capable();
    v_checked := v_checked + 1;
    IF lower(trim(r.name)) = lower(trim('A1 Wrecker llc')) THEN
      v_a1_seen := TRUE;
      IF v_got IS NOT TRUE THEN
        v_fail := array_append(v_fail,
          '🔴 A1 Wrecker llc lost enforcement capability — it is enforcement/legacy and MUST keep it');
      END IF;
    END IF;
    IF v_got IS DISTINCT FROM v_want THEN
      v_fail := array_append(v_fail, format('%s (%s/%s): helper=%s expected=%s',
        r.name, r.tier_type, r.tier, v_got, v_want));
    ELSE
      RAISE NOTICE 'VS2  %-24s %s/%-20s -> %s', r.name, r.tier_type, r.tier, v_got;
    END IF;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE EXCEPTION 'VS2 FAIL: not a single company was exercised — nothing was verified';
  END IF;
  IF NOT v_a1_seen THEN
    RAISE EXCEPTION 'VS2 FAIL: A1 Wrecker llc was never exercised, so the most important positive control did not run';
  END IF;
  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VS2 FAIL:\n%', array_to_string(v_fail, E'\n');
  END IF;
  RAISE NOTICE 'VS2 PASS: % companies, A1 among them, all resolve as ruled', v_checked;
END $$;

-- ── VS3: a probe PM Pro tenant is refused, by execution ─────────────
DO $$
DECLARE
  v_co    TEXT := 'ZZ PM Pro Probe ' || floor(random() * 1e6)::TEXT;
  v_email TEXT := 'zz-pmpro-' || floor(random() * 1e9)::TEXT || '@test.invalid';
  v_got   BOOLEAN;
  v_id    BIGINT;
BEGIN
  INSERT INTO public.companies (name, tier, tier_type, is_active, company_env)
  VALUES (v_co, 'legacy', 'property_management', TRUE, 'test')
  RETURNING id INTO v_id;

  INSERT INTO public.user_roles (email, role, company, is_active)
  VALUES (v_email, 'driver', v_co, TRUE);

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('request.jwt.claim.email', v_email, true);

  v_got := public.my_tier_enforcement_capable();
  IF v_got IS NOT FALSE THEN
    -- Clean up before raising, or a failed run leaves a probe tenant.
    DELETE FROM public.user_roles WHERE email = v_email;
    DELETE FROM public.companies WHERE name = v_co;
    RAISE EXCEPTION 'VS3 FAIL: a property_management/legacy tenant resolved enforcement_capable=%', v_got;
  END IF;

  DELETE FROM public.user_roles WHERE email = v_email;
  DELETE FROM public.companies  WHERE name  = v_co;

  IF EXISTS (SELECT 1 FROM public.companies WHERE name = v_co)
     OR EXISTS (SELECT 1 FROM public.user_roles WHERE email = v_email) THEN
    RAISE EXCEPTION 'VS3 FAIL: probe rows survived the delete';
  END IF;

  RAISE NOTICE 'VS3 PASS: a PM Pro tenant resolves FALSE; probe company and role removed and read back';
END $$;

-- ── terminal PASS row ────────────────────────────────────────────────
SELECT 'PASS — the helper reads tier_type and branches on the track; every real company resolves as ruled with A1 Wrecker llc explicitly confirmed TRUE; a probe property_management/legacy tenant resolves FALSE and was removed and read back; the trigger is BEFORE INSERT on violations and its function is SECURITY INVOKER, so current_user still discriminates. Role-path execution: npm run verify:pmpronoenforcement' AS result;
