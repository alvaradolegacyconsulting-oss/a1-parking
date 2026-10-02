-- VERIFICATION — get_effective_property_limit. No BEGIN/COMMIT.
-- Re-runnable. Terminal SELECT returns a PASS row.

-- ── VS1: signature + grants ─────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_effective_property_limit(text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: function does not resolve';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.get_effective_property_limit(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VS1 FAIL: authenticated cannot EXECUTE';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('public.get_effective_property_limit(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VS1 FAIL: anon can EXECUTE';
  END IF;
END $$;

-- ── VS2: A1 — the override wins over the tier default ───────────────
-- 🔴 THE POINT OF THE FUNCTION. A1's tier default is 50; its override
-- is -1. If this returns 50, the UI blocks A1 at 50 properties.
DO $$
DECLARE v_eff INT; v_default INT;
BEGIN
  v_eff     := public.get_effective_property_limit('A1 Wrecker llc');
  v_default := public.get_company_property_limit('A1 Wrecker llc');
  IF v_default <> 50 THEN
    RAISE EXCEPTION 'VS2 FAIL: A1''s tier DEFAULT is %, expected 50 — the ceiling migration did not apply as expected', v_default;
  END IF;
  IF v_eff >= 0 THEN
    RAISE EXCEPTION 'VS2 FAIL: A1''s EFFECTIVE limit is % — the override is not winning, and the UI would cap A1', v_eff;
  END IF;
END $$;

-- ── VS3: a company with no override falls through to the default ────
DO $$
DECLARE v_enf INT; v_start INT;
BEGIN
  v_enf   := public.get_effective_property_limit('Test-ENF');
  v_start := public.get_effective_property_limit('Test PM Starter 2');
  IF v_enf   <> 50 THEN RAISE EXCEPTION 'VS3 FAIL: Test-ENF effective=%, expected 50', v_enf; END IF;
  IF v_start <>  1 THEN RAISE EXCEPTION 'VS3 FAIL: Test PM Starter 2 effective=%, expected 1', v_start; END IF;
END $$;

-- ── VS4: it agrees with the TRIGGER, which is the whole claim ───────
-- 🔴 Asserting the two give the same answer, by making the trigger
-- actually fire. A function that returns the right number while the
-- trigger does something else would pass VS2 and VS3 and still be a
-- lie. Fresh probe company; self-cleaning.
DO $$
DECLARE
  v_co TEXT := 'ZZ Effective Limit Probe';
  v_eff INT; v_i INT; v_refused BOOLEAN := false;
BEGIN
  DELETE FROM public.properties WHERE company = v_co;
  DELETE FROM public.companies  WHERE name    = v_co;
  INSERT INTO public.companies (name, tier, tier_type, is_active, company_env)
  VALUES (v_co, 'enforcement_only', 'enforcement', true, 'test');

  v_eff := public.get_effective_property_limit(v_co);
  IF v_eff <> 50 THEN
    DELETE FROM public.companies WHERE name = v_co;
    RAISE EXCEPTION 'VS4 FAIL: effective limit for a fresh enforcement_only company is %, expected 50', v_eff;
  END IF;

  FOR v_i IN 1..v_eff LOOP
    INSERT INTO public.properties (name, company, is_active) VALUES (v_co || ' P' || v_i, v_co, true);
  END LOOP;
  BEGIN
    INSERT INTO public.properties (name, company, is_active) VALUES (v_co || ' OVER', v_co, true);
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;

  DELETE FROM public.properties WHERE company = v_co;
  DELETE FROM public.companies  WHERE name    = v_co;

  IF NOT v_refused THEN
    RAISE EXCEPTION 'VS4 FAIL: the trigger accepted one MORE than the effective limit this function reported. The UI and the DB would disagree.';
  END IF;
END $$;

SELECT 'PASS' AS result,
  'VS1 resolves; authenticated EXECUTE, anon revoked'       AS vs1,
  'VS2 A1 override (-1) beats the tier default (50)'        AS vs2,
  'VS3 no-override companies fall through to the default'   AS vs3,
  'VS4 EXECUTED: the trigger refuses at exactly this number' AS vs4,
  public.get_effective_property_limit('A1 Wrecker llc')     AS a1_effective;
