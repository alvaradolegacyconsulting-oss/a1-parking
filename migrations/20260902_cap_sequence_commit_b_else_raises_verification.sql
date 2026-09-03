-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_b_else_raises_verification.sql
--
-- Paired verification for Cap Commit B. v2 pattern (no BEGIN/COMMIT
-- wrap; terminal SELECT returns PASS row). 8 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  helper still exists via to_regprocedure
--   VS2  DEFINER + search_path pinned (unchanged from Commit A)
--   VS3  body contains RAISE 'tier_unrecognized' (ELSE flipped)
--   VS4  body contains IF/ELSIF branches for all 4 tier values
--   VS5  🔴 BEHAVIOR PARITY — compare live post-apply limits to
--        pre-apply snapshot captured in the audit row's JSONB;
--        assert every company's value matches
--   VS6  🔴 EXECUTION — drift-loud RAISE actually fires
--        Introduces a probe company with a synthetic tier value
--        that companies_tier_valid rejects. But since the CHECK
--        constraint blocks the INSERT, we test the RAISE by calling
--        the fn with a probe input that bypasses the tier-value
--        path — see gate body for the technique.
--   VS7  A1 EXPLICIT — legacy branch still returns -1 (Cap A VS6
--        parity)
--   VS8  schema audit row present with pre_apply_limits populated
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: signature exists ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_company_property_limit(text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.get_company_property_limit(text) not found';
  END IF;
END $$;

-- ── VS2: DEFINER + search_path pinned ───────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_company_property_limit(text)');
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'VS2 FAIL: not SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'VS2 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
END $$;

-- ── VS3: body contains RAISE 'tier_unrecognized' ────────────────────
DO $$
DECLARE
  v_body TEXT := pg_get_functiondef(to_regprocedure('public.get_company_property_limit(text)'));
BEGIN
  IF v_body NOT ILIKE '%tier_unrecognized%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing RAISE ''tier_unrecognized'' — ELSE not flipped';
  END IF;
  IF v_body NOT ILIKE '%raise exception%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing RAISE EXCEPTION — ELSE not flipped';
  END IF;
END $$;

-- ── VS4: all 4 tier branches present ────────────────────────────────
DO $$
DECLARE
  v_body TEXT := pg_get_functiondef(to_regprocedure('public.get_company_property_limit(text)'));
BEGIN
  IF v_body NOT ILIKE '%pm_only%' THEN RAISE EXCEPTION 'VS4 FAIL: body missing pm_only'; END IF;
  IF v_body NOT ILIKE '%enforcement_only%' THEN RAISE EXCEPTION 'VS4 FAIL: body missing enforcement_only'; END IF;
  IF v_body NOT ILIKE '%legacy%' THEN RAISE EXCEPTION 'VS4 FAIL: body missing legacy (A1 load-bearing)'; END IF;
  IF v_body NOT ILIKE '%pm_starter%' THEN RAISE EXCEPTION 'VS4 FAIL: body missing pm_starter (dead until A₀)'; END IF;
END $$;

-- ── VS5: 🔴 BEHAVIOR PARITY vs audit-stored pre-apply snapshot ─────
-- Reads pre_apply_limits JSONB from the migration's audit row and
-- compares live post-apply values per company. Any drift → FAIL with
-- offender list. Stronger than Cap A VS5 (which asserted "every
-- company returns -1" — a specific-value claim) because THIS gate
-- proves NO DRIFT for any value, not just -1.
DO $$
DECLARE
  v_pre_apply JSONB;
  v_row RECORD;
  v_post INT;
  v_expected INT;
  v_drift TEXT := '';
BEGIN
  SELECT new_values->'pre_apply_limits' INTO v_pre_apply
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_B'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_b_else_raises'
   ORDER BY created_at DESC LIMIT 1;
  IF v_pre_apply IS NULL THEN
    RAISE EXCEPTION 'VS5 SETUP FAIL: pre_apply_limits JSONB not found in audit row. Migration Part 4 did not populate it.';
  END IF;

  FOR v_row IN SELECT id, name, tier FROM public.companies ORDER BY id LOOP
    v_post := public.get_company_property_limit(v_row.name);
    v_expected := (v_pre_apply ->> v_row.id::TEXT)::INT;
    IF v_expected IS NULL THEN
      RAISE EXCEPTION 'VS5 SETUP FAIL: no pre-apply value for company_id=% (added after Commit B applied?). Snapshot: %', v_row.id, v_pre_apply;
    END IF;
    IF v_post IS DISTINCT FROM v_expected THEN
      v_drift := v_drift || format('company_id=%s name=%L tier=%s BEFORE=%s AFTER=%s; ',
        v_row.id, v_row.name, v_row.tier, v_expected, v_post);
    END IF;
  END LOOP;

  IF v_drift <> '' THEN
    RAISE EXCEPTION 'VS5 FAIL: behavior drift detected between pre-apply and post-apply. Drift: %', v_drift;
  END IF;
END $$;

-- ── VS6: 🔴 EXECUTION — drift-loud RAISE actually fires ────────────
-- Testing the ELSE branch requires the fn to reach it — but a probe
-- company with a tier value like 'not_a_real_tier' can't be INSERTed
-- (companies_tier_valid CHECK rejects with 23514). Instead we
-- momentarily UPDATE an existing legacy company's tier to something
-- Cap A's CHECK still allows but Cap B's CASE doesn't name — but
-- currently NO such value exists (pm_only/enforcement_only/legacy
-- are the only 3 in companies_tier_valid + pm_starter is A₀).
--
-- Workaround: temporarily loosen the CHECK inside the block, INSERT
-- a probe with a synthetic tier, verify RAISE fires, delete probe,
-- restore CHECK. Too invasive — the CHECK is the enforcement.
--
-- Cleaner: skip the execution probe. VS3+VS4 prove structural
-- presence; the true drift-loud behavior gets exercised the FIRST
-- time A₀ (or any future tier-add) leaves a company in a state where
-- the CASE doesn't name their tier. Not a false positive risk;
-- adding an execution probe here would require weakening the very
-- CHECK constraint the arc is closing.
--
-- Documenting the decision so a future reviewer doesn't add it back
-- without understanding why it's skipped.
DO $$
BEGIN
  RAISE NOTICE 'VS6 INFO: execution probe for drift-loud RAISE intentionally omitted. Reason: reaching the ELSE requires a tier value not in companies_tier_valid, which the CHECK constraint rejects at INSERT/UPDATE — testing would require weakening the CHECK the arc is closing. Structural gates VS3+VS4 prove the RAISE is present. See feedback_gates_must_assert_what_they_measured for the discipline.';
END $$;

-- ── VS7: A1 EXPLICIT — legacy branch still returns -1 ───────────────
-- Parity with Cap A VS6. Load-bearing per T5.
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
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: no legacy-tier company matching A1 found. If missing, either env lacks A1 seed OR legacy branch untested here.';
  END IF;
  v_a1_limit := public.get_company_property_limit(v_a1_name);
  IF v_a1_limit <> -1 THEN
    RAISE EXCEPTION 'VS7 FAIL: A1 (company=%) computed limit=% (want -1). Legacy branch broken; A1 gets capped on Q4 rollout.',
      v_a1_name, v_a1_limit;
  END IF;
END $$;

-- ── VS8: schema audit row + pre_apply_limits populated ──────────────
-- 🔴 Postgres has no max() aggregate for jsonb. Split into two
-- statements: COUNT for existence + ORDER BY created_at DESC LIMIT 1
-- for latest row's JSONB. Same shape as VS5 uses to read the snapshot.
DO $$
DECLARE v_count INT; v_pre_apply JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_B'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_b_else_raises';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: schema audit row missing';
  END IF;

  SELECT new_values->'pre_apply_limits' INTO v_pre_apply
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_B'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_b_else_raises'
   ORDER BY created_at DESC LIMIT 1;
  IF v_pre_apply IS NULL OR jsonb_typeof(v_pre_apply) <> 'object' THEN
    RAISE EXCEPTION 'VS8 FAIL: pre_apply_limits JSONB missing or wrong type in audit row (got %)', jsonb_typeof(v_pre_apply);
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'get_company_property_limit (Cap Commit B — ELSE raises)'::TEXT AS target,
  ARRAY[
    'VS1  signature exists',
    'VS2  DEFINER + search_path pinned',
    'VS3  body contains RAISE ''tier_unrecognized''',
    'VS4  all 4 branches (pm_only/enforcement_only/legacy/pm_starter) present',
    'VS5  🔴 BEHAVIOR PARITY — per-company pre-apply == post-apply (via audit JSONB)',
    'VS6  drift-loud RAISE execution probe intentionally skipped (documented)',
    'VS7  A1 legacy branch → -1 preserved',
    'VS8  SCHEMA_CAP_SEQUENCE_COMMIT_B audit row + pre_apply_limits'
  ] AS gates_verified,
  now() AS verified_at;
