-- ══════════════════════════════════════════════════════════════════════
-- 20260902_properties_unique_company_name_ci_verification.sql
--
-- Paired verification. v2 pattern (no BEGIN/COMMIT wrap; terminal
-- SELECT returns PASS row). 8 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  properties_company_name_ci_unique index exists
--   VS2  index is UNIQUE + expression-based + NOT partial
--   VS3  🔴 EXECUTION — duplicate INSERT (same normalized) → 23505
--        + msg names our index (setup-vs-real failure discriminator)
--   VS4  🔴 EXECUTION — case + whitespace variation, same normalized
--        → 23505 (asserts normalization actually works)
--   VS5  🔴 EXECUTION — same name at DIFFERENT company → SUCCEEDS
--        (asserts scoping is per-company, not global)
--   VS6  🔴 EXECUTION — clean unique name → SUCCEEDS (over-restriction
--        guardrail, same shape as §4 VS7; catches accidents like
--        dropping the company column from the index expression)
--   VS7  post-apply pre-flight parity — still 0 duplicate groups
--   VS8  schema audit row
--
-- All execution probes use fresh probe rows with letters+digits-only
-- names (per feedback_fresh_probe_rows_for_check_verification).
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: index exists ───────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'properties'
     AND indexname  = 'properties_company_name_ci_unique';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: properties_company_name_ci_unique index not found (got %)', v_count;
  END IF;
END $$;

-- ── VS2: UNIQUE + expression + NOT partial ──────────────────────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname='public' AND tablename='properties'
     AND indexname='properties_company_name_ci_unique';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: index definition unreadable';
  END IF;
  IF v_def NOT LIKE '%UNIQUE INDEX%' THEN
    RAISE EXCEPTION 'VS2 FAIL: index is not UNIQUE. def=%', v_def;
  END IF;
  IF v_def NOT LIKE '%lower(btrim(company))%' AND v_def NOT LIKE '%lower(trim(company))%' THEN
    RAISE EXCEPTION 'VS2 FAIL: index expression missing normalized company. def=%', v_def;
  END IF;
  IF v_def NOT LIKE '%lower(btrim(name))%' AND v_def NOT LIKE '%lower(trim(name))%' THEN
    RAISE EXCEPTION 'VS2 FAIL: index expression missing normalized name. def=%', v_def;
  END IF;
  IF v_def ILIKE '%WHERE%' THEN
    RAISE EXCEPTION 'VS2 FAIL: index is PARTIAL (has WHERE clause). Migration header specifies FULL index — see partial_rationale. def=%', v_def;
  END IF;
END $$;

-- ── VS3: 🔴 execution — duplicate → 23505 ──────────────────────────
-- INSERT two rows with the same (company, name); second must fail.
-- Fresh company row for the probes so no external side effects.
-- Both probes are deleted before block ends; whole DO is atomic —
-- any raise rolls back everything.
DO $$
DECLARE
  v_company TEXT;
  v_probe_a_id BIGINT;
  v_probe_b_id BIGINT;
  v_probe_name TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT name INTO v_company FROM public.companies ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS3 FIXTURE FAIL: no companies exist to attach probes to';
  END IF;
  v_probe_name := 'vs3probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company, false)
  RETURNING id INTO v_probe_a_id;

  BEGIN
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_probe_name, v_company, false)
    RETURNING id INTO v_probe_b_id;
    -- Should NOT reach here. If we do, clean up + raise.
    DELETE FROM public.properties WHERE id IN (v_probe_a_id, v_probe_b_id);
    RAISE EXCEPTION 'VS3 FAIL: duplicate INSERT SUCCEEDED — UNIQUE index not enforcing';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23505' THEN
      RAISE EXCEPTION 'VS3 FAIL: expected 23505 unique_violation; got sqlstate=% msg=%. If not-null or FK, adjust the probe fixture.', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%properties_company_name_ci_unique%' THEN
      RAISE EXCEPTION 'VS3 FAIL: got 23505 but from wrong index. msg=%. Expected properties_company_name_ci_unique.', v_msg;
    END IF;
  END;

  -- Duplicate correctly rejected; clean up probe A (probe B never landed).
  DELETE FROM public.properties WHERE id = v_probe_a_id;
END $$;

-- ── VS4: 🔴 execution — case + whitespace variation → 23505 ─────────
-- Asserts normalization actually works: `Green Acres` and `  green
-- acres  ` should collide.
DO $$
DECLARE
  v_company TEXT;
  v_probe_a_id BIGINT;
  v_probe_b_id BIGINT;
  v_probe_name TEXT;
  v_variant_name TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT name INTO v_company FROM public.companies ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS4 FIXTURE FAIL: no companies exist';
  END IF;
  v_probe_name := 'Vs4Probe' || floor(extract(epoch from now()))::TEXT;
  v_variant_name := '  ' || lower(v_probe_name) || '  ';

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company, false)
  RETURNING id INTO v_probe_a_id;

  BEGIN
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_variant_name, v_company, false)
    RETURNING id INTO v_probe_b_id;
    DELETE FROM public.properties WHERE id IN (v_probe_a_id, v_probe_b_id);
    RAISE EXCEPTION 'VS4 FAIL: case+whitespace variant INSERT SUCCEEDED — normalization not working (index expression may not use lower(trim(...)))';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23505' THEN
      RAISE EXCEPTION 'VS4 FAIL: expected 23505; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%properties_company_name_ci_unique%' THEN
      RAISE EXCEPTION 'VS4 FAIL: got 23505 but from wrong index. msg=%', v_msg;
    END IF;
    -- Note: trg_properties_name_trim (DB trigger) will strip whitespace
    -- at write; the client would also strim. But the INSERT here goes
    -- direct — if trg_properties_name_trim converts '  x  ' → 'x'
    -- before UNIQUE fires, the index still catches the collision via
    -- the trimmed value. Either way, 23505 from our index means
    -- normalization is doing what it should.
  END;

  DELETE FROM public.properties WHERE id = v_probe_a_id;
END $$;

-- ── VS5: 🔴 execution — same name, DIFFERENT company → SUCCEEDS ────
-- Asserts scope is per-company, not global. Requires TWO distinct
-- companies to exist.
DO $$
DECLARE
  v_company_a TEXT;
  v_company_b TEXT;
  v_probe_a_id BIGINT;
  v_probe_b_id BIGINT;
  v_probe_name TEXT;
BEGIN
  SELECT name INTO v_company_a FROM public.companies ORDER BY id ASC  LIMIT 1;
  SELECT name INTO v_company_b FROM public.companies ORDER BY id DESC LIMIT 1;
  IF v_company_a IS NULL OR v_company_b IS NULL THEN
    RAISE EXCEPTION 'VS5 FIXTURE FAIL: fewer than 2 companies exist to cross-check per-company scoping';
  END IF;
  IF v_company_a = v_company_b THEN
    RAISE EXCEPTION 'VS5 FIXTURE FAIL: only 1 company exists (ORDER BY ASC and DESC returned same). Per-company scoping cannot be tested with a single tenant.';
  END IF;
  v_probe_name := 'vs5probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company_a, false)
  RETURNING id INTO v_probe_a_id;

  -- Same name, different company — MUST succeed.
  BEGIN
    INSERT INTO public.properties (name, company, is_active)
    VALUES (v_probe_name, v_company_b, false)
    RETURNING id INTO v_probe_b_id;
  EXCEPTION WHEN OTHERS THEN
    DECLARE
      v_sqlstate TEXT; v_msg TEXT;
    BEGIN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_sqlstate = '23505' AND v_msg LIKE '%properties_company_name_ci_unique%' THEN
        RAISE EXCEPTION 'VS5 FAIL: same-name-different-company INSERT rejected — index is scoping globally rather than per-company. company_a=% company_b=%', v_company_a, v_company_b;
      ELSE
        RAISE EXCEPTION 'VS5 SETUP FAILURE (not a scoping bug): probe INSERT failed with sqlstate=% msg=%. Fix probe fixture.', v_sqlstate, v_msg;
      END IF;
    END;
  END;

  DELETE FROM public.properties WHERE id IN (v_probe_a_id, v_probe_b_id);
END $$;

-- ── VS6: 🔴 execution — clean unique name → SUCCEEDS ────────────────
-- Guardrail against accidents like "the index expression got typoed
-- to always-collide" or "trigger dropped the value pre-UNIQUE-check".
-- If a clean unique-per-company name can't INSERT, something is wrong.
-- SUCCESS-probe pattern: discriminate real fault vs setup fault.
DO $$
DECLARE
  v_company TEXT;
  v_probe_id BIGINT;
BEGIN
  SELECT name INTO v_company FROM public.companies ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no companies exist';
  END IF;

  INSERT INTO public.properties (name, company, is_active)
  VALUES ('vs6probe' || floor(extract(epoch from now()))::TEXT, v_company, false)
  RETURNING id INTO v_probe_id;

  DELETE FROM public.properties WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE
    v_sqlstate TEXT; v_msg TEXT;
  BEGIN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate = '23505' AND v_msg LIKE '%properties_company_name_ci_unique%' THEN
      RAISE EXCEPTION 'VS6 FAIL: clean unique name REJECTED by our UNIQUE index — index expression or trigger interaction is over-rejecting. sqlstate=% msg=%', v_sqlstate, v_msg;
    ELSE
      RAISE EXCEPTION 'VS6 SETUP FAILURE (not an over-restriction bug): probe INSERT failed with sqlstate=% msg=%. Fix probe fixture.', v_sqlstate, v_msg;
    END IF;
  END;
END $$;

-- ── VS7: post-apply pre-flight parity — still 0 duplicate groups ────
-- The CREATE UNIQUE INDEX would have refused to build against
-- duplicates, so this is tautologically 0 for the pre-index state.
-- Belt-and-suspenders assertion.
DO $$
DECLARE v_dup_group_count INT;
BEGIN
  SELECT COUNT(*) INTO v_dup_group_count
    FROM (
      SELECT lower(trim(company)), lower(trim(name))
        FROM public.properties
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
    ) g;
  IF v_dup_group_count <> 0 THEN
    RAISE EXCEPTION 'VS7 FAIL: post-apply scan found % duplicate groups (should be impossible with UNIQUE index active). Investigate.', v_dup_group_count;
  END IF;
END $$;

-- ── VS8: schema audit row ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action='SCHEMA_PROPERTIES_UNIQUE_COMPANY_NAME_CI'
     AND new_values->>'migration'='20260902_properties_unique_company_name_ci';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'properties (lower(trim(company)), lower(trim(name))) UNIQUE INDEX'::TEXT AS target,
  ARRAY[
    'VS1  properties_company_name_ci_unique index exists',
    'VS2  UNIQUE + expression + NOT partial',
    'VS3  🔴 execution — duplicate → 23505 + msg names our index',
    'VS4  🔴 execution — case+whitespace variation → 23505 (normalization works)',
    'VS5  🔴 execution — same name, different company → SUCCEEDS (per-company scoping)',
    'VS6  🔴 execution — clean unique name → SUCCEEDS (over-restriction guardrail)',
    'VS7  post-apply parity — 0 duplicate groups',
    'VS8  SCHEMA_PROPERTIES_UNIQUE_COMPANY_NAME_CI audit row'
  ] AS gates_verified,
  now() AS verified_at;
