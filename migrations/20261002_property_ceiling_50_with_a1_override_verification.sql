-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — property ceiling 50 + A1's unlimited override
-- ════════════════════════════════════════════════════════════════════
--
-- Pairs with 20261002_property_ceiling_50_with_a1_override.sql.
-- No BEGIN/COMMIT. Re-runnable. Terminal SELECT returns a PASS row.
--
-- The migration already rolls itself back if A1 is not unlimited. This
-- file is the AFTER check: it proves the end state from outside the
-- transaction, including the thing the migration cannot test from
-- inside itself — that the TRIGGER, not just the function, behaves.

-- ── VS1: the function's four branches ───────────────────────────────
DO $$
DECLARE v_enf INT; v_leg INT; v_start INT; v_pmonly INT;
BEGIN
  v_enf    := public.get_company_property_limit('Test-ENF');
  v_leg    := public.get_company_property_limit('A1 Wrecker llc');
  v_start  := public.get_company_property_limit('Test PM Starter 2');
  v_pmonly := public.get_company_property_limit('Test-PM');
  IF v_enf    <> 50 THEN RAISE EXCEPTION 'VS1 FAIL: enforcement_only=%  expected 50', v_enf; END IF;
  IF v_leg    <> 50 THEN RAISE EXCEPTION 'VS1 FAIL: legacy=%  expected 50 (the DEFAULT; A1 is exempt via override, see VS2)', v_leg; END IF;
  IF v_start  <>  1 THEN RAISE EXCEPTION 'VS1 FAIL: pm_starter=%  expected 1', v_start; END IF;
  IF v_pmonly <> -1 THEN RAISE EXCEPTION 'VS1 FAIL: pm_only=%  expected -1 (unchanged)', v_pmonly; END IF;
END $$;

-- ── VS2: A1's override exists and reads as unlimited ────────────────
-- Queried the way the TRIGGER queries it — same WHERE, same ORDER BY —
-- so this proves the value the trigger will actually find, not merely
-- that a row somewhere contains it.
DO $$
DECLARE v_override INT;
BEGIN
  SELECT (feature_overrides ->> 'max_properties')::INT
    INTO v_override
    FROM public.proposal_codes
   WHERE company_id = 91
     AND status = 'redeemed'
     AND feature_overrides ? 'max_properties'
   ORDER BY redeemed_at DESC NULLS LAST
   LIMIT 1;
  IF v_override IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: the trigger''s own lookup finds NO max_properties override for company_id=91. A1 is capped at 50.';
  END IF;
  IF v_override >= 0 THEN
    RAISE EXCEPTION 'VS2 FAIL: A1 override is % — the trigger treats only NEGATIVE as unlimited', v_override;
  END IF;
END $$;

-- ── VS3: EXECUTION — the trigger refuses a 51st, and exempts A1 ─────
-- 🔴 VS1 and VS2 read values. Neither proves the trigger FIRES. This
-- inserts real rows against a fresh throwaway company, watches the
-- refusal, and cleans up inside the same block.
--
-- A fresh company, not an existing one: an existing tenant's row count
-- is live data and a probe that pushes it over a cap would be changing
-- the thing it measures.
DO $$
DECLARE
  v_co TEXT := 'ZZ Ceiling Probe 20261002';
  v_i INT;
  v_refused BOOLEAN := false;
  v_msg TEXT;
BEGIN
  DELETE FROM public.properties WHERE company = v_co;
  DELETE FROM public.companies  WHERE name    = v_co;

  INSERT INTO public.companies (name, tier, tier_type, is_active, company_env)
  VALUES (v_co, 'legacy', 'enforcement', true, 'test');

  -- 50 must succeed.
  FOR v_i IN 1..50 LOOP
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_co || ' P' || v_i, v_co, true);
  END LOOP;

  SELECT count(*) INTO v_i FROM public.properties WHERE company = v_co AND is_active;
  IF v_i <> 50 THEN
    RAISE EXCEPTION 'VS3 FAIL: only % of 50 properties inserted — the ceiling fires too early', v_i;
  END IF;

  -- The 51st must be refused.
  BEGIN
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_co || ' P51', v_co, true);
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;

  IF NOT v_refused THEN
    DELETE FROM public.properties WHERE company = v_co;
    DELETE FROM public.companies  WHERE name    = v_co;
    RAISE EXCEPTION 'VS3 FAIL: the 51st property was ACCEPTED. The ceiling is not enforced server-side.';
  END IF;
  IF position('Property limit exceeded' IN v_msg) = 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: refused, but with an unexpected message: %. check_violation is shared by other constraints, so the MESSAGE is what discriminates.', v_msg;
  END IF;

  -- Self-cleaning, inside the same block, so a probe company cannot
  -- survive a partial run and be mistaken for a real tenant.
  DELETE FROM public.properties WHERE company = v_co;
  DELETE FROM public.companies  WHERE name    = v_co;

  IF EXISTS (SELECT 1 FROM public.companies WHERE name = v_co) THEN
    RAISE EXCEPTION 'VS3 FAIL: probe company survived cleanup';
  END IF;
END $$;

-- ── VS4: A1 is NOT capped — the same execution test, on A1's shape ──
-- A second throwaway, this time carrying a redeemed proposal code with
-- max_properties = -1, which is exactly A1's configuration. Proves the
-- EXEMPTION fires, not just that the cap does. A guard that refuses
-- everything passes every negative test.
DO $$
DECLARE
  v_co TEXT := 'ZZ Elite Probe 20261002';
  v_cid BIGINT;
  v_i INT;
BEGIN
  DELETE FROM public.properties     WHERE company = v_co;
  DELETE FROM public.proposal_codes WHERE code    = 'ZZPROBE-ELITE';
  DELETE FROM public.companies      WHERE name    = v_co;

  INSERT INTO public.companies (name, tier, tier_type, is_active, company_env)
  VALUES (v_co, 'legacy', 'enforcement', true, 'test')
  RETURNING id INTO v_cid;

  INSERT INTO public.proposal_codes (code, company_id, feature_overrides, status, redeemed_at, prefix, base_tier, base_tier_type)
  VALUES ('ZZPROBE-ELITE', v_cid, '{"max_properties": -1}'::jsonb, 'redeemed', now(), 'ZZPROBE', 'legacy', 'enforcement');

  FOR v_i IN 1..51 LOOP
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_co || ' P' || v_i, v_co, true);
  END LOOP;

  SELECT count(*) INTO v_i FROM public.properties WHERE company = v_co AND is_active;
  IF v_i <> 51 THEN
    RAISE EXCEPTION 'VS4 FAIL: an Elite-override company got only % of 51 properties — the exemption does not fire', v_i;
  END IF;

  DELETE FROM public.properties     WHERE company = v_co;
  DELETE FROM public.proposal_codes WHERE code    = 'ZZPROBE-ELITE';
  DELETE FROM public.companies      WHERE name    = v_co;
END $$;

-- ── PASS row ────────────────────────────────────────────────────────
SELECT
  'PASS'                                                   AS result,
  'VS1 enforcement_only=50 legacy=50 pm_starter=1 pm_only=-1' AS vs1,
  'VS2 A1 override found by the trigger''s own query, negative' AS vs2,
  'VS3 EXECUTED: 50 ok, 51st refused with the cap message'  AS vs3,
  'VS4 EXECUTED: an override company reached 51'            AS vs4,
  (SELECT feature_overrides ->> 'max_properties'
     FROM public.proposal_codes WHERE id = 54)              AS a1_override;
