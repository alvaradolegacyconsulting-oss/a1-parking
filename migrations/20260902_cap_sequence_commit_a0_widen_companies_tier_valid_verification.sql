-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_a0_widen_companies_tier_valid_verification.sql
--
-- Paired verification for Cap Commit A₀. v2 pattern. 8 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  companies_tier_valid constraint exists (exactly 1)
--   VS2  definition names all 4 values including pm_starter
--   VS3  🔴 END-TO-END EXECUTION — INSERT pm_starter company +
--        get_company_property_limit(name) returns 1 (whole cap chain
--        verified: A₀ makes pm_starter valid, Cap A branch returns 1)
--   VS4  🔴 EXECUTION — INSERT with tier='not_a_real_tier' → 23514
--        (constraint still enforcing after widening)
--   VS5  existing tier row counts preserved (0/pm_starter — the
--        migration doesn't insert; existing 3 tiers unchanged)
--   VS6  🔴 A1 SEQUENCE-CLOSE — A1 (legacy) still returns -1.
--        Load-bearing per T5; asserted at every cap-arc verification
--        + here at the sequence close.
--   VS7  Cap Commit B RAISE not fired by any existing company (no
--        drift introduced by A₀)
--   VS8  schema audit row present
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: constraint exists ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname='public' AND t.relname='companies'
     AND c.conname='companies_tier_valid'
     AND c.contype='c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: companies_tier_valid CHECK not found exactly once (got %)', v_count;
  END IF;
END $$;

-- ── VS2: definition names all 4 values ─────────────────────────────
DO $$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname='public' AND t.relname='companies'
     AND c.conname='companies_tier_valid';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: constraint definition unreadable';
  END IF;
  IF v_def NOT LIKE '%pm_only%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing pm_only. def=%', v_def; END IF;
  IF v_def NOT LIKE '%enforcement_only%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing enforcement_only. def=%', v_def; END IF;
  IF v_def NOT LIKE '%legacy%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing legacy. def=%', v_def; END IF;
  IF v_def NOT LIKE '%pm_starter%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing pm_starter (the whole point of A₀). def=%', v_def; END IF;
END $$;

-- ── VS3: 🔴 END-TO-END — pm_starter INSERT + helper returns 1 ──────
-- Whole cap chain in one gate. If this passes:
--   * A₀ made pm_starter accepted by companies_tier_valid (INSERT worked)
--   * Cap A's pm_starter branch returns 1 (helper computed correctly)
-- Fresh probe row per Sep 1 rule; cleaned up before block ends.
DO $$
DECLARE
  v_probe_id BIGINT;
  v_probe_name TEXT;
  v_limit INT;
BEGIN
  v_probe_name := 'vs3probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.companies (name, tier, tier_type, is_active)
  VALUES (v_probe_name, 'pm_starter', 'property_management', false)
  RETURNING id INTO v_probe_id;

  v_limit := public.get_company_property_limit(v_probe_name);
  IF v_limit <> 1 THEN
    DELETE FROM public.companies WHERE id = v_probe_id;
    RAISE EXCEPTION 'VS3 FAIL: pm_starter company created but get_company_property_limit returned % (want 1). Cap A branch not reachable or wrong value.', v_limit;
  END IF;

  DELETE FROM public.companies WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE
    v_sqlstate TEXT; v_msg TEXT;
  BEGIN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate = '23514' AND v_msg LIKE '%companies_tier_valid%' THEN
      RAISE EXCEPTION 'VS3 FAIL: pm_starter INSERT rejected by companies_tier_valid — widening did not take effect. sqlstate=% msg=%', v_sqlstate, v_msg;
    ELSE
      RAISE EXCEPTION 'VS3 SETUP FAILURE (not widening bug): probe failed with sqlstate=% msg=%. Fix probe fixture.', v_sqlstate, v_msg;
    END IF;
  END;
END $$;

-- ── VS4: 🔴 EXECUTION — invalid tier still REJECTS 23514 ───────────
DO $$
DECLARE v_sqlstate TEXT; v_msg TEXT;
BEGIN
  BEGIN
    INSERT INTO public.companies (name, tier, tier_type, is_active)
    VALUES ('vs4probe' || floor(extract(epoch from now()))::TEXT, 'not_a_real_tier', 'enforcement', false);
    RAISE EXCEPTION 'VS4 FAIL: invalid tier INSERT SUCCEEDED — constraint not enforcing after widening';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS4 FAIL: expected 23514; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%companies_tier_valid%' THEN
      RAISE EXCEPTION 'VS4 FAIL: got 23514 but from wrong constraint. msg=%', v_msg;
    END IF;
  END;
END $$;

-- ── VS5: existing tier row counts preserved ────────────────────────
-- Widening doesn't touch rows; counts should be ≥1 for each pre-A₀
-- tier that existed. pm_starter should be 0 (VS3 probe deleted).
DO $$
DECLARE
  v_pm_only INT;
  v_enf INT;
  v_legacy INT;
  v_pm_starter INT;
BEGIN
  SELECT COUNT(*) INTO v_pm_only    FROM public.companies WHERE tier = 'pm_only';
  SELECT COUNT(*) INTO v_enf        FROM public.companies WHERE tier = 'enforcement_only';
  SELECT COUNT(*) INTO v_legacy     FROM public.companies WHERE tier = 'legacy';
  SELECT COUNT(*) INTO v_pm_starter FROM public.companies WHERE tier = 'pm_starter';

  IF v_pm_only < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: pm_only count = 0 — widening dropped rows? Expected ≥1 (pre-A₀ baseline).';
  END IF;
  IF v_enf < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: enforcement_only count = 0 — same concern.';
  END IF;
  IF v_legacy < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: legacy count = 0 — A1 disappeared? Load-bearing tier.';
  END IF;
  IF v_pm_starter > 0 THEN
    RAISE NOTICE 'VS5 INFO: pm_starter count = % (not 0). VS3 probe should be deleted; nonzero means either the probe wasn''t cleaned up or a real pm_starter tenant already exists. Verify.', v_pm_starter;
  END IF;
END $$;

-- ── VS6: 🔴 A1 SEQUENCE-CLOSE — legacy branch still returns -1 ─────
-- Asserted at every cap arc verification (A VS6, B VS7, C via parity,
-- A₀ here). Load-bearing per T5 (Aug 28).
DO $$
DECLARE
  v_a1_name TEXT;
  v_a1_limit INT;
BEGIN
  SELECT name INTO v_a1_name
    FROM public.companies
   WHERE tier = 'legacy' AND lower(name) LIKE '%a1%'
   ORDER BY id LIMIT 1;
  IF v_a1_name IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no legacy-tier company matching A1 — env issue';
  END IF;
  v_a1_limit := public.get_company_property_limit(v_a1_name);
  IF v_a1_limit <> -1 THEN
    RAISE EXCEPTION 'VS6 FAIL: A1 (company=%) computed limit=% (want -1). SEQUENCE-CLOSE broken; A1 gets capped on Q4 rollout.',
      v_a1_name, v_a1_limit;
  END IF;
END $$;

-- ── VS7: Cap B RAISE not fired by any existing company ─────────────
-- Loop through all companies and call the helper. If ANY row raises
-- tier_unrecognized, A₀ introduced a company with a tier value that
-- the helper doesn't name — Cap B's drift-loud check would fire in
-- production. Should never happen because A₀ only ADDS pm_starter
-- to the CHECK, and Cap A already added the pm_starter branch to
-- the helper. Belt+suspenders assertion.
DO $$
DECLARE
  v_row RECORD;
  v_limit INT;
BEGIN
  FOR v_row IN SELECT id, name, tier FROM public.companies ORDER BY id LOOP
    BEGIN
      v_limit := public.get_company_property_limit(v_row.name);
    EXCEPTION WHEN OTHERS THEN
      DECLARE v_msg TEXT;
      BEGIN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg ILIKE '%tier_unrecognized%' THEN
          RAISE EXCEPTION 'VS7 FAIL: company_id=% tier=% tripped Cap B tier_unrecognized RAISE. A₀ opened the door to a tier value the helper does not name. Add a branch to public.get_company_property_limit CASE.',
            v_row.id, v_row.tier;
        ELSE
          RAISE EXCEPTION 'VS7 SETUP FAILURE: helper raised for company_id=% with unexpected msg=%', v_row.id, v_msg;
        END IF;
      END;
    END;
  END LOOP;
END $$;

-- ── VS8: schema audit row ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action='SCHEMA_CAP_SEQUENCE_COMMIT_A0'
     AND new_values->>'migration'='20260902_cap_sequence_commit_a0_widen_companies_tier_valid';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'companies_tier_valid widened to include pm_starter (Cap sequence CLOSE)'::TEXT AS target,
  ARRAY[
    'VS1  companies_tier_valid CHECK present (exactly 1)',
    'VS2  definition names all 4 values (pm_only/enforcement_only/legacy/pm_starter)',
    'VS3  🔴 END-TO-END — INSERT pm_starter company + get_company_property_limit → 1',
    'VS4  🔴 execution — invalid tier → 23514 (constraint still enforcing)',
    'VS5  existing 3-tier row counts preserved',
    'VS6  🔴 A1 SEQUENCE-CLOSE — legacy branch → -1 (load-bearing)',
    'VS7  Cap B RAISE not tripped by any existing company (no drift)',
    'VS8  SCHEMA_CAP_SEQUENCE_COMMIT_A0 audit row'
  ] AS gates_verified,
  now() AS verified_at;
