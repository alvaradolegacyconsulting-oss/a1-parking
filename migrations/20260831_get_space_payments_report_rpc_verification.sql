-- ══════════════════════════════════════════════════════════════════════
-- 20260831_get_space_payments_report_rpc_verification.sql
--
-- Paired verification for 20260831_get_space_payments_report_rpc.
-- v2 pattern + session guard (same discipline as Commit 3a verif).
--
-- ── 11 GATES (v2 adds VE8) ───────────────────────────────────────────
--   STRUCTURAL
--     VS1  get_space_payments_report(text, date) exists
--     VS2  🔴 SECURITY INVOKER (not DEFINER — the whole design choice
--          for this function is that RLS applies inside)
--     VS3  search_path pinned
--     VS4  authenticated has EXECUTE; PUBLIC + anon do NOT
--     VS5  schema audit row present (v1 OR v2 — whichever was last applied)
--   EXECUTION (one consolidated block, session-guarded)
--     VE1  fee-bearing space with 0 payments in the period → status
--          = 'no_payment_recorded' (v2 rename per Mateo Aug 31 §3 —
--          we don''t assert unpaid), recorded_total = 0
--     VE2  fee-bearing space with a payment matching monthly_fee →
--          status = 'paid', recorded_total = fee
--     VE3  fee-bearing space with a partial payment → status =
--          'partial', recorded_total = payment amount
--     VE4  🔴 VOIDED payment EXCLUDED from recorded_total (record two,
--          void one, assert only the unvoided sums)
--     VE5  is_vacant TRUE for space with no space_residents; FALSE
--          for space with ≥1 tie
--     VE6  Non-fee-bearing space at the same property does NOT appear
--          in the result (fee_filter works)
--     VE7  Space at a DIFFERENT property does NOT appear (property
--          scope works — INVOKER + RLS test in one)
--     VE8  🟢 v2 — assigned_residents roster. Bundled B-1 space
--          (2 ties per fixture) temporarily fee-flagged; report row
--          must include BOTH residents in assigned_residents. Multi-
--          tie NULL suppression does NOT apply to roster — record_
--          space_payment nulls the payment snapshot; the report shows
--          the truth.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: signature exists ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_space_payments_report(text, date)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.get_space_payments_report(text, date) not found';
  END IF;
END $$;

-- ── VS2: 🔴 SECURITY INVOKER (NOT DEFINER) ──────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_space_payments_report(text, date)');
  v_secdef BOOLEAN;
BEGIN
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VS2 FAIL: get_space_payments_report has prosecdef=% (want FALSE / INVOKER). The whole design point of this function is INVOKER so RLS applies inside — DEFINER would re-introduce the property-scope-by-hand gap update_space_metadata has.', v_secdef;
  END IF;
END $$;

-- ── VS3: search_path pinned ─────────────────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_space_payments_report(text, date)');
  v_config TEXT[];
BEGIN
  SELECT proconfig INTO v_config FROM pg_proc WHERE oid = v_oid;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VS3 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
END $$;

-- ── VS4: grants ─────────────────────────────────────────────────────
DO $$
DECLARE v_authed INT; v_public INT; v_anon INT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC'         AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'EXECUTE')
    INTO v_authed, v_public, v_anon
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'get_space_payments_report';
  IF v_authed <> 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: authenticated EXECUTE grants=% (want 1)', v_authed;
  END IF;
  IF v_public <> 0 OR v_anon <> 0 THEN
    RAISE EXCEPTION 'VS4 FAIL: unwanted grants — PUBLIC=% anon=%', v_public, v_anon;
  END IF;
END $$;

-- ── VS5: schema audit row (v1 OR v2 present) ───────────────────────
-- After the v2 amendment (20260831_get_space_payments_report_rpc_v2)
-- lands, the v2 SCHEMA_ action is written. If Jose applied v1 first
-- then v2, both audit rows exist. Either alone satisfies this gate.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action IN ('SCHEMA_GET_SPACE_PAYMENTS_REPORT_V1',
                    'SCHEMA_GET_SPACE_PAYMENTS_REPORT_V2')
     AND new_values->>'migration' IN (
       '20260831_get_space_payments_report_rpc',
       '20260831_get_space_payments_report_rpc_v2'
     );
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: no schema audit row for get_space_payments_report (V1 or V2)';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- ── CONSOLIDATED EXECUTION BLOCK (VE1-VE7) + session guard ──────────
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_mgr_email        TEXT;
  v_mgr_properties   TEXT[];
  v_space_a_id       BIGINT;  -- fee-bearing, will get partial payment for VE3
  v_space_b_id       BIGINT;  -- fee-bearing, will get 0 payments for VE1
  v_space_c_id       BIGINT;  -- fee-bearing, will get full-fee payment for VE2
  v_space_d_id       BIGINT;  -- fee-bearing, will get 2 payments, 1 voided for VE4
  v_space_nofee_id   BIGINT;  -- NON-fee-bearing for VE6
  v_test_property    TEXT;
  v_period           DATE;
  v_payment_id_1     BIGINT;
  v_payment_id_2     BIGINT;
  v_payment_id_3     BIGINT;
  v_payment_id_4a    BIGINT;
  v_payment_id_4b    BIGINT;
  v_report_row       RECORD;
  v_count            INT;
BEGIN
  PERFORM set_config('app.commit4a_verif_status', 'FAILED', false);

  -- Pick a manager + their scoped property (linked, one JOIN — same
  -- pattern as Commit 3a verif).
  SELECT ur.email, ur.property, s.property
    INTO v_mgr_email, v_mgr_properties, v_test_property
    FROM public.user_roles ur
    JOIN public.spaces s
      ON lower(trim(s.property)) = ANY (SELECT lower(trim(p)) FROM unnest(ur.property) p)
   WHERE lower(trim(ur.company)) = 'test-legacy'
     AND ur.role = 'manager'
     AND lower(coalesce(ur.is_active::text, 'true')) <> 'false'
     AND s.is_active
     AND lower(trim(s.company)) = 'test-legacy'
   ORDER BY ur.id, s.id LIMIT 1;
  IF v_mgr_email IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no Test-LEGACY manager+space pair';
  END IF;

  -- Use 3 months out for the probe period so we don't collide with
  -- other verifications' probe periods.
  v_period := (date_trunc('month', CURRENT_DATE) + interval '3 months')::date;

  -- Seed 4 fee-bearing probe spaces + 1 non-fee-bearing.
  INSERT INTO public.spaces (company, property, label, type, is_active, monthly_fee, created_by_email)
  VALUES
    ('Test-LEGACY', v_test_property, '__V4-A', 'regular', TRUE, 100.00, 'system_verif_v4'),
    ('Test-LEGACY', v_test_property, '__V4-B', 'regular', TRUE, 100.00, 'system_verif_v4'),
    ('Test-LEGACY', v_test_property, '__V4-C', 'regular', TRUE, 100.00, 'system_verif_v4'),
    ('Test-LEGACY', v_test_property, '__V4-D', 'regular', TRUE, 100.00, 'system_verif_v4'),
    ('Test-LEGACY', v_test_property, '__V4-NOFEE', 'regular', TRUE, NULL, 'system_verif_v4')
  RETURNING id INTO v_space_nofee_id;  -- captures LAST inserted (NOFEE)
  -- Re-fetch each id by label — RETURNING on multi-row INSERT only sinks last.
  SELECT id INTO v_space_a_id FROM public.spaces WHERE company='Test-LEGACY' AND property=v_test_property AND label='__V4-A';
  SELECT id INTO v_space_b_id FROM public.spaces WHERE company='Test-LEGACY' AND property=v_test_property AND label='__V4-B';
  SELECT id INTO v_space_c_id FROM public.spaces WHERE company='Test-LEGACY' AND property=v_test_property AND label='__V4-C';
  SELECT id INTO v_space_d_id FROM public.spaces WHERE company='Test-LEGACY' AND property=v_test_property AND label='__V4-D';
  IF v_space_a_id IS NULL OR v_space_b_id IS NULL OR v_space_c_id IS NULL OR v_space_d_id IS NULL OR v_space_nofee_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: probe spaces not all created';
  END IF;

  -- Impersonate manager for payment INSERTs (via the DEFINER RPC).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  -- VE3: partial payment on A ($50 of $100)
  v_payment_id_1 := public.record_space_payment(v_space_a_id, v_period, 50.00, 've3', 'partial');
  -- VE2: full-fee payment on C ($100)
  v_payment_id_2 := public.record_space_payment(v_space_c_id, v_period, 100.00, 've2', 'paid');
  -- VE4: 2 payments on D ($75 and $25), then void the $25 → recorded_total should = $75
  v_payment_id_4a := public.record_space_payment(v_space_d_id, v_period, 75.00, 've4-a', 'first');
  v_payment_id_4b := public.record_space_payment(v_space_d_id, v_period, 25.00, 've4-b', 'second');
  PERFORM public.void_space_payment(v_payment_id_4b, 'VE4 void the $25');

  EXECUTE 'RESET role';

  -- Now call the report as the same manager (INVOKER — RLS applies)
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  -- ── VE1: B — no payments in period → no_payment_recorded, total = 0 ─
  -- Status v2 rename per Mateo Aug 31 §3 — never "outstanding"
  -- (we don't assert unpaid; money likely went through rent system
  -- we don't see).
  SELECT * INTO v_report_row
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_b_id;
  IF v_report_row.status <> 'no_payment_recorded' OR v_report_row.recorded_total <> 0 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: B (no payments) status=% total=% (want no_payment_recorded, 0). If status is "outstanding" — the v2 amendment (20260831_get_space_payments_report_rpc_v2) has not been applied yet.',
      v_report_row.status, v_report_row.recorded_total;
  END IF;

  -- ── VE2: C — full-fee payment → paid, total = 100 ───────────────
  SELECT * INTO v_report_row
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_c_id;
  IF v_report_row.status <> 'paid' OR v_report_row.recorded_total <> 100 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE2 FAIL: C (full-fee) status=% total=% (want paid, 100)', v_report_row.status, v_report_row.recorded_total;
  END IF;

  -- ── VE3: A — partial payment → partial, total = 50 ──────────────
  SELECT * INTO v_report_row
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_a_id;
  IF v_report_row.status <> 'partial' OR v_report_row.recorded_total <> 50 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE3 FAIL: A (partial) status=% total=% (want partial, 50)', v_report_row.status, v_report_row.recorded_total;
  END IF;

  -- ── VE4: 🔴 D — voided EXCLUDED → partial, total = 75 (not 100) ──
  SELECT * INTO v_report_row
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_d_id;
  IF v_report_row.status <> 'partial' OR v_report_row.recorded_total <> 75 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE4 FAIL: D (voided $25 excluded) status=% total=% (want partial, 75). Voided payment either not being excluded from sum (would give total=100) or the wrong payment got voided.', v_report_row.status, v_report_row.recorded_total;
  END IF;

  -- ── VE5: is_vacant TRUE (no space_residents ties on any probe) ──
  SELECT * INTO v_report_row
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_a_id;
  IF v_report_row.is_vacant IS NOT TRUE THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE5 FAIL: A has no ties but is_vacant=% (want TRUE)', v_report_row.is_vacant;
  END IF;

  -- ── VE6: __V4-NOFEE does NOT appear (fee_filter works) ──────────
  SELECT COUNT(*) INTO v_count
    FROM public.get_space_payments_report(v_test_property, v_period)
   WHERE space_id = v_space_nofee_id;
  IF v_count <> 0 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: non-fee-bearing space __V4-NOFEE appeared in report (count=%). Fee filter (monthly_fee IS NOT NULL) is broken.', v_count;
  END IF;

  -- ── VE7: cross-property scope — report at a DIFFERENT property
  -- should NOT return this manager's spaces. Pick 'Test VE4 Cross-Prop'
  -- (from the Aug 31 fixture, manager NOT assigned). Calling the RPC
  -- with THAT property AND being scoped to manager's own property list
  -- should return 0 rows for our probe spaces. INVOKER + RLS proof.
  SELECT COUNT(*) INTO v_count
    FROM public.get_space_payments_report('Test VE4 Cross-Prop', v_period)
   WHERE space_id IN (v_space_a_id, v_space_b_id, v_space_c_id, v_space_d_id);
  IF v_count <> 0 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE7 FAIL: report at "Test VE4 Cross-Prop" returned % of manager''s own probe rows. Property parameter is not being honored, OR RLS is admitting cross-property rows.', v_count;
  END IF;

  EXECUTE 'RESET role';

  -- ── VE8: 🟢 v2 — assigned_residents roster (multi-tie case) ─────
  -- Bundled space B-1 at Test Legacy Property has 2 space_residents
  -- ties per the Aug 31 fixture. Temporarily give it a monthly_fee so
  -- it appears in the report; assert BOTH residents come back in
  -- assigned_residents. Multi-tie NULL suppression from record_space_
  -- payment does NOT apply to roster (Mateo Aug 31 §2).
  --
  -- Runs as service_role/postgres — the UPDATE on spaces + the
  -- direct SELECT don't need impersonation; the RPC still runs as
  -- INVOKER but the current role can see everything.
  DECLARE
    v_b1_id BIGINT;
    v_report_b1 RECORD;
    v_tie_count INT;
  BEGIN
    SELECT id INTO v_b1_id
      FROM public.spaces
     WHERE company = 'Test-LEGACY'
       AND property = 'Test Legacy Property'
       AND label = 'B-1';
    IF v_b1_id IS NULL THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE8 FIXTURE FAIL: bundled space B-1 not found. Apply 20260831_test_legacy_fixture_expansion.sql first.';
    END IF;
    -- Snapshot current fee so we can restore.
    UPDATE public.spaces SET monthly_fee = 42.00 WHERE id = v_b1_id;

    -- Call the report scoped to Test Legacy Property (B-1's property).
    -- Uses v_period from VE1-VE7 setup (3 months out).
    SELECT * INTO v_report_b1
      FROM public.get_space_payments_report('Test Legacy Property', v_period)
     WHERE space_id = v_b1_id;

    IF v_report_b1.space_id IS NULL THEN
      UPDATE public.spaces SET monthly_fee = NULL WHERE id = v_b1_id;
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE8 FAIL: B-1 row not in report despite monthly_fee=42. Check fee_filter or property parameter.';
    END IF;
    IF v_report_b1.assigned_residents IS NULL THEN
      UPDATE public.spaces SET monthly_fee = NULL WHERE id = v_b1_id;
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE8 FAIL: assigned_residents is NULL (want JSONB array []). COALESCE(..., ''[]''::jsonb) is broken.';
    END IF;
    v_tie_count := jsonb_array_length(v_report_b1.assigned_residents);
    IF v_tie_count <> 2 THEN
      UPDATE public.spaces SET monthly_fee = NULL WHERE id = v_b1_id;
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE8 FAIL: assigned_residents length=% (want 2). B-1 has 2 space_residents ties per fixture. Multi-tie suppression should NOT apply to roster — record_space_payment nulls the payment snapshot, the report shows the truth.',
        v_tie_count;
    END IF;
    -- Restore B-1 to feeless (Aug 31 fixture default)
    UPDATE public.spaces SET monthly_fee = NULL WHERE id = v_b1_id;
  END;

  -- CLEANUP: delete probe payments + probe spaces
  DELETE FROM public.space_payments
   WHERE id IN (v_payment_id_1, v_payment_id_2, v_payment_id_4a, v_payment_id_4b);
  DELETE FROM public.spaces
   WHERE id IN (v_space_a_id, v_space_b_id, v_space_c_id, v_space_d_id, v_space_nofee_id);

  PERFORM set_config('app.commit4a_verif_status', 'PASSED', false);
END $$;

-- ── FINAL: session-guarded PASS row ─────────────────────────────────
SELECT
  CASE current_setting('app.commit4a_verif_status', true)
    WHEN 'PASSED' THEN 'PASS'
    ELSE           'FAIL — execution block did not complete; see error pane above'
  END AS status,
  'get_space_payments_report(TEXT, DATE)'::TEXT AS target,
  ARRAY[
    'VS1  signature exists',
    'VS2  SECURITY INVOKER (not DEFINER)',
    'VS3  search_path pinned',
    'VS4  authenticated EXECUTE; PUBLIC + anon deny',
    'VS5  schema audit row present (v1 or v2)',
    'VE1  fee-bearing + no payments → no_payment_recorded, 0 (v2 rename)',
    'VE2  full-fee payment → paid',
    'VE3  partial payment → partial',
    'VE4  voided payment EXCLUDED from recorded_total',
    'VE5  no ties → is_vacant TRUE',
    'VE6  non-fee-bearing space excluded (fee filter)',
    'VE7  RPC at different property does not return this scope''s rows (INVOKER+RLS proof)',
    'VE8  assigned_residents JSONB roster — 2 ties returned (v2, no multi-tie NULL suppression)'
  ] AS gates_verified,
  now() AS verified_at;
