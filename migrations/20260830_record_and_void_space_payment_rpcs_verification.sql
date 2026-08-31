-- ══════════════════════════════════════════════════════════════════════
-- 20260830_record_and_void_space_payment_rpcs_verification.sql
--
-- Paired verification for 20260830_record_and_void_space_payment_rpcs.
-- v2 pattern: no BEGIN/COMMIT wrap; terminal SELECT returns PASS row.
--
-- ── LESSONS APPLIED (not iterated to) ───────────────────────────────
-- Every rule from feedback_gates_must_assert_what_they_measured.md
-- baked into the initial file, not patched in later:
--   1. to_regprocedure for signature checks (base type names only)
--   2. ONE consolidated DO block for the execution section
--   3. SETUP uses one JOIN to link manager + space at the same
--      property — no two-independent-SELECTs pattern
--   4. Impersonation: SET → test → RESET each section
--   5. CLEANUP at end of the consolidated block (or transaction
--      rollback handles it on failure)
--   6. user_roles.property is text[] — array ops, never trim() on it
--   7. Period uses CURRENT_DATE (bare DATE, no TZ conversion)
--   8. Failure messages state observations, list candidate causes,
--      never assert a cause the gate did not test
--
-- ── 12 GATES ────────────────────────────────────────────────────────
--   STRUCTURAL
--     VS1  record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) exists
--     VS2  void_space_payment(BIGINT, TEXT) exists
--     VS3  both are SECURITY DEFINER with search_path pinned
--     VS4  grants: authenticated has EXECUTE on both; PUBLIC/anon do NOT
--     VS5  schema audit row present
--   EXECUTION (in one consolidated block)
--     VE1  manager records: row lands with all snapshots correct +
--          recorded_by_email = JWT email (unforgeable-attribution proof)
--     VE2  period_month non-first-of-month INPUT normalizes to first-of-month
--     VE3  amount = 0 rejected with amount_not_positive
--     VE4  cross-property manager rejected with space_not_in_your_properties
--     VE5  double-submit within 60s rejected with duplicate_payment_suspected
--     VE6  void sets voided_at + voided_by_email + void_reason; other
--          columns untouched
--     VE7  second void rejected with already_voided
--     VE8  void with blank reason rejected with void_reason_required
--     (NOT tested here — filed as manual/follow-up:
--      • 2+ tied resident case for NULL snapshots — needs specific seed)
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: record_space_payment signature ─────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.record_space_payment(bigint, date, numeric, text, text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.record_space_payment(bigint, date, numeric, text, text) does not exist (to_regprocedure returned NULL). CREATE FUNCTION did not run, or landed with a different signature.';
  END IF;
END $$;

-- ── VS2: void_space_payment signature ───────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.void_space_payment(bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: public.void_space_payment(bigint, text) does not exist.';
  END IF;
END $$;

-- ── VS3: DEFINER + search_path pinned on both ───────────────────────
DO $$
DECLARE
  v_rec_oid oid := to_regprocedure('public.record_space_payment(bigint, date, numeric, text, text)');
  v_void_oid oid := to_regprocedure('public.void_space_payment(bigint, text)');
  v_rec_definer  BOOLEAN;
  v_void_definer BOOLEAN;
  v_rec_config   TEXT[];
  v_void_config  TEXT[];
BEGIN
  SELECT prosecdef, proconfig INTO v_rec_definer, v_rec_config FROM pg_proc WHERE oid = v_rec_oid;
  SELECT prosecdef, proconfig INTO v_void_definer, v_void_config FROM pg_proc WHERE oid = v_void_oid;
  IF NOT COALESCE(v_rec_definer, false) THEN
    RAISE EXCEPTION 'VS3 FAIL: record_space_payment is not SECURITY DEFINER';
  END IF;
  IF NOT COALESCE(v_void_definer, false) THEN
    RAISE EXCEPTION 'VS3 FAIL: void_space_payment is not SECURITY DEFINER';
  END IF;
  IF v_rec_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_rec_config) s WHERE s LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VS3 FAIL: record_space_payment has no pinned search_path. proconfig=%', v_rec_config;
  END IF;
  IF v_void_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_void_config) s WHERE s LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VS3 FAIL: void_space_payment has no pinned search_path. proconfig=%', v_void_config;
  END IF;
END $$;

-- ── VS4: grants ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_rec_authed INT;
  v_rec_public INT;
  v_rec_anon   INT;
  v_void_authed INT;
  v_void_public INT;
  v_void_anon   INT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC' AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon' AND privilege_type = 'EXECUTE')
    INTO v_rec_authed, v_rec_public, v_rec_anon
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'record_space_payment';
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC' AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon' AND privilege_type = 'EXECUTE')
    INTO v_void_authed, v_void_public, v_void_anon
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'void_space_payment';
  IF v_rec_authed <> 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: record_space_payment authenticated EXECUTE grants=% (want 1)', v_rec_authed;
  END IF;
  IF v_rec_public <> 0 OR v_rec_anon <> 0 THEN
    RAISE EXCEPTION 'VS4 FAIL: record_space_payment has non-authenticated grants: PUBLIC=% anon=%', v_rec_public, v_rec_anon;
  END IF;
  IF v_void_authed <> 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: void_space_payment authenticated EXECUTE grants=% (want 1)', v_void_authed;
  END IF;
  IF v_void_public <> 0 OR v_void_anon <> 0 THEN
    RAISE EXCEPTION 'VS4 FAIL: void_space_payment has non-authenticated grants: PUBLIC=% anon=%', v_void_public, v_void_anon;
  END IF;
END $$;

-- ── VS5: schema audit row ───────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_SPACE_PAYMENT_RPCS_V1'
     AND new_values->>'migration' = '20260830_record_and_void_space_payment_rpcs';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: SCHEMA_SPACE_PAYMENT_RPCS_V1 audit row missing';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- ── CONSOLIDATED EXECUTION BLOCK (VE1-VE8) ───────────────────────────
-- ══════════════════════════════════════════════════════════════════════
-- One DO block, one transaction. If any gate raises, the whole block
-- rolls back including any INSERTs — no orphan cleanup needed.
-- If all pass, the DELETE at the end runs inside the same transaction.
--
-- Setup: LINKED via one JOIN — pick a Test-LEGACY manager together with
-- a space at ONE OF that manager's user_roles.property values (text[]).
-- Guarantees the RPC's property-scope check will admit for VE1.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_mgr_email       TEXT;
  v_mgr_properties  TEXT[];
  v_space_id        BIGINT;
  v_space_property  TEXT;
  v_space_company   TEXT;
  v_other_space_id  BIGINT;
  v_other_property  TEXT;
  v_period_input    DATE;  -- non-first-of-month input for VE2
  v_period_expected DATE;  -- expected normalized value
  v_payment_id      BIGINT;
  v_payment_id_2    BIGINT;
  v_amount_stored   NUMERIC(10,2);
  v_recorded_by     TEXT;
  v_snap_property   TEXT;
  v_snap_label      TEXT;
  v_voided_at       TIMESTAMPTZ;
  v_voided_by       TEXT;
  v_void_reason     TEXT;
  v_amount_after    NUMERIC(10,2);
  v_period_after    DATE;
  v_expected_raise  BOOLEAN;
BEGIN
  -- ── STEP 1: LINKED SETUP — one JOIN ─────────────────────────────
  -- user_roles.property is text[]. get_my_properties() reads it directly.
  -- Space.property is text. Match via lower(trim()) = ANY(unnest()).
  SELECT ur.email, ur.property, s.id, s.property, s.company
    INTO v_mgr_email, v_mgr_properties, v_space_id, v_space_property, v_space_company
    FROM public.user_roles ur
    JOIN public.spaces s
      ON lower(trim(s.property)) = ANY (SELECT lower(trim(p)) FROM unnest(ur.property) p)
   WHERE lower(trim(ur.company)) = 'test-legacy'
     AND ur.role = 'manager'
     AND lower(coalesce(ur.is_active::text, 'true')) <> 'false'
     AND s.is_active
     AND lower(trim(s.company)) = 'test-legacy'
   ORDER BY ur.id, s.id
   LIMIT 1;
  IF v_mgr_email IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no Test-LEGACY manager+space pair found. Cannot build linked fixture. Check that at least one manager has a non-empty user_roles.property AND at least one active space exists at one of those properties.';
  END IF;
  RAISE NOTICE 'SETUP: manager=% properties=% linked_space_id=% at property="%"',
    v_mgr_email, v_mgr_properties, v_space_id, v_space_property;

  -- Also find a space at a DIFFERENT property (for VE4 cross-scope test).
  -- If none exists, skip VE4 with a NOTICE (can't test without one).
  SELECT s.id, s.property
    INTO v_other_space_id, v_other_property
    FROM public.spaces s
   WHERE s.is_active
     AND lower(trim(s.company)) = 'test-legacy'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(v_mgr_properties) AS p
        WHERE lower(trim(p)) = lower(trim(s.property))
     )
   ORDER BY s.id
   LIMIT 1;

  -- ── VE1: manager records; row lands with correct snapshots ──────
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  v_period_expected := date_trunc('month', CURRENT_DATE)::date;
  BEGIN
    v_payment_id := public.record_space_payment(
      p_space_id     => v_space_id,
      p_period_month => v_period_expected,
      p_amount       => 37.50,
      p_method       => 'cash',
      p_note         => 'VE1 probe'
    );
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: manager (%) record_space_payment raised %: %. Manager is scoped to properties % linked to space id=% at property "%".',
      v_mgr_email, SQLSTATE, SQLERRM, v_mgr_properties, v_space_id, v_space_property;
  END;
  IF v_payment_id IS NULL THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: record_space_payment returned NULL id';
  END IF;

  -- Read-back to verify snapshots. RLS lets the manager see own-property rows.
  SELECT amount, recorded_by_email, property, space_label
    INTO v_amount_stored, v_recorded_by, v_snap_property, v_snap_label
    FROM public.space_payments WHERE id = v_payment_id;
  IF v_amount_stored IS DISTINCT FROM 37.50 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: amount stored=% (want 37.50)', v_amount_stored;
  END IF;
  IF lower(trim(v_recorded_by)) <> lower(trim(v_mgr_email)) THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: recorded_by_email="%" (want "%"). Attribution should come from JWT, not payload.',
      v_recorded_by, v_mgr_email;
  END IF;
  IF lower(trim(v_snap_property)) <> lower(trim(v_space_property)) THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE1 FAIL: snapshotted property="%" (want "%")', v_snap_property, v_space_property;
  END IF;
  RAISE NOTICE 'VE1 PASS: payment id=% amount=% recorded_by=% snapshot property="% " label="%"',
    v_payment_id, v_amount_stored, v_recorded_by, v_snap_property, v_snap_label;

  -- ── VE2: non-first-of-month INPUT normalizes ────────────────────
  -- Input any mid-month date; expect stored period_month = first of that month.
  v_period_input    := (date_trunc('month', CURRENT_DATE) + interval '14 days')::date;
  v_period_expected := date_trunc('month', v_period_input)::date;
  BEGIN
    v_payment_id_2 := public.record_space_payment(
      p_space_id     => v_space_id,
      p_period_month => v_period_input,
      p_amount       => 12.34,   -- different amount so duplicate-guard doesn't fire
      p_method       => NULL,
      p_note         => 'VE2 probe'
    );
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE2 FAIL: record with mid-month input (%) raised %: %. Expected server-side normalization.',
      v_period_input, SQLSTATE, SQLERRM;
  END;
  SELECT period_month INTO v_period_after FROM public.space_payments WHERE id = v_payment_id_2;
  IF v_period_after IS DISTINCT FROM v_period_expected THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE2 FAIL: normalized period stored=% (want % for input %)', v_period_after, v_period_expected, v_period_input;
  END IF;
  RAISE NOTICE 'VE2 PASS: input % normalized to % as stored', v_period_input, v_period_after;

  -- ── VE3: amount = 0 rejected ─────────────────────────────────────
  v_expected_raise := FALSE;
  BEGIN
    PERFORM public.record_space_payment(
      p_space_id => v_space_id, p_period_month => v_period_expected,
      p_amount => 0, p_method => NULL, p_note => NULL
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%amount_not_positive%' THEN
        v_expected_raise := TRUE;
      ELSE
        EXECUTE 'RESET role';
        RAISE EXCEPTION 'VE3 FAIL: amount=0 raised but not amount_not_positive: %', SQLERRM;
      END IF;
    WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE3 FAIL: amount=0 raised unexpected SQLSTATE=%: %', SQLSTATE, SQLERRM;
  END;
  IF NOT v_expected_raise THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE3 FAIL: amount=0 was ACCEPTED (no exception raised).';
  END IF;
  RAISE NOTICE 'VE3 PASS: amount=0 rejected with amount_not_positive';

  -- ── VE4: cross-property manager rejected ────────────────────────
  -- 🔴 2026-08-30 Mateo §1 correction: this gate must NOT skip
  -- itself with a NOTICE. VE4 is the gate covering the property-
  -- scope enforcement we deliberately chose NOT to inherit from
  -- update_space_metadata's company-only gap — the most security-
  -- relevant gate in this verification. A gate that passes by not
  -- running is the VQ2-false-pass shape again. Absence of a fixture
  -- is a finding, not a pass.
  IF v_other_space_id IS NULL THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE4 FIXTURE FAIL: could not find an active Test-LEGACY space at a property OUTSIDE manager %''s assignment (%). Cross-property rejection was NOT tested — the property-scope enforcement gate did not execute. Test-LEGACY has multiple properties; verify one exists outside this manager''s scope, or seed a space at a different property. If Test-LEGACY genuinely has only one property in scope for this manager, THIS ENVIRONMENT CANNOT VERIFY THE CROSS-PROPERTY REJECTION and that must be reported explicitly.',
      v_mgr_email, v_mgr_properties;
  ELSE
    v_expected_raise := FALSE;
    BEGIN
      PERFORM public.record_space_payment(
        p_space_id => v_other_space_id, p_period_month => v_period_expected,
        p_amount => 5.00, p_method => NULL, p_note => NULL
      );
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM LIKE '%space_not_in_your_properties%' THEN
          v_expected_raise := TRUE;
        ELSE
          EXECUTE 'RESET role';
          RAISE EXCEPTION 'VE4 FAIL: cross-property record raised but not space_not_in_your_properties: %', SQLERRM;
        END IF;
      WHEN others THEN
        EXECUTE 'RESET role';
        RAISE EXCEPTION 'VE4 FAIL: cross-property record raised unexpected SQLSTATE=%: %', SQLSTATE, SQLERRM;
    END;
    IF NOT v_expected_raise THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE4 FAIL: cross-property record was ACCEPTED. Manager scoped to % but record at space % (property="%") succeeded.',
        v_mgr_properties, v_other_space_id, v_other_property;
    END IF;
    RAISE NOTICE 'VE4 PASS: cross-property record (space id=% at "%") rejected', v_other_space_id, v_other_property;
  END IF;

  -- ── VE5: double-submit within 60s rejected ───────────────────────
  -- Try to record the SAME (space, period, amount, recorder) as VE1.
  v_expected_raise := FALSE;
  BEGIN
    PERFORM public.record_space_payment(
      p_space_id => v_space_id,
      p_period_month => date_trunc('month', CURRENT_DATE)::date,
      p_amount => 37.50,  -- SAME as VE1
      p_method => 'cash',
      p_note => NULL
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%duplicate_payment_suspected%' THEN
        v_expected_raise := TRUE;
      ELSE
        EXECUTE 'RESET role';
        RAISE EXCEPTION 'VE5 FAIL: double-submit raised but not duplicate_payment_suspected: %', SQLERRM;
      END IF;
    WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE5 FAIL: double-submit raised unexpected SQLSTATE=%: %', SQLSTATE, SQLERRM;
  END;
  IF NOT v_expected_raise THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE5 FAIL: double-submit was ACCEPTED — guard did not fire.';
  END IF;
  RAISE NOTICE 'VE5 PASS: double-submit within 60s rejected with duplicate_payment_suspected';

  -- ── VE6: void sets voided_at + voided_by_email + void_reason ────
  -- Uses VE1's payment id. Verify only void columns changed.
  BEGIN
    PERFORM public.void_space_payment(v_payment_id, 'VE6 test void');
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: void_space_payment raised %: %', SQLSTATE, SQLERRM;
  END;
  SELECT voided_at, voided_by_email, void_reason, amount, period_month
    INTO v_voided_at, v_voided_by, v_void_reason, v_amount_after, v_period_after
    FROM public.space_payments WHERE id = v_payment_id;
  IF v_voided_at IS NULL OR v_voided_by IS NULL OR v_void_reason IS NULL THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: void triple not all set. at=% by=% reason=%', v_voided_at, v_voided_by, v_void_reason;
  END IF;
  IF lower(trim(v_voided_by)) <> lower(trim(v_mgr_email)) THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: voided_by_email=% (want %). Attribution should come from JWT.',
      v_voided_by, v_mgr_email;
  END IF;
  IF v_void_reason <> 'VE6 test void' THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: void_reason="%" (want "VE6 test void")', v_void_reason;
  END IF;
  IF v_amount_after IS DISTINCT FROM 37.50 THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: amount changed after void: now=% (want unchanged 37.50). Void should NEVER touch amount.', v_amount_after;
  END IF;
  IF v_period_after IS DISTINCT FROM date_trunc('month', CURRENT_DATE)::date THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE6 FAIL: period_month changed after void: now=% (want unchanged). Void should NEVER touch period.', v_period_after;
  END IF;
  RAISE NOTICE 'VE6 PASS: void set triple correctly (by=% reason="%"), amount + period untouched',
    v_voided_by, v_void_reason;

  -- ── VE7: second void on already-voided rejected ──────────────────
  v_expected_raise := FALSE;
  BEGIN
    PERFORM public.void_space_payment(v_payment_id, 'VE7 double void attempt');
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%already_voided%' THEN
        v_expected_raise := TRUE;
      ELSE
        EXECUTE 'RESET role';
        RAISE EXCEPTION 'VE7 FAIL: second void raised but not already_voided: %', SQLERRM;
      END IF;
    WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE7 FAIL: second void raised unexpected SQLSTATE=%: %', SQLSTATE, SQLERRM;
  END;
  IF NOT v_expected_raise THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE7 FAIL: second void was ACCEPTED — already_voided guard did not fire.';
  END IF;
  RAISE NOTICE 'VE7 PASS: second void rejected with already_voided';

  -- ── VE8: void with blank reason rejected ─────────────────────────
  -- Use VE2's payment (still not voided) to test blank reason.
  v_expected_raise := FALSE;
  BEGIN
    PERFORM public.void_space_payment(v_payment_id_2, '   ');
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%void_reason_required%' THEN
        v_expected_raise := TRUE;
      ELSE
        EXECUTE 'RESET role';
        RAISE EXCEPTION 'VE8 FAIL: blank reason raised but not void_reason_required: %', SQLERRM;
      END IF;
    WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VE8 FAIL: blank reason raised unexpected SQLSTATE=%: %', SQLSTATE, SQLERRM;
  END;
  IF NOT v_expected_raise THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VE8 FAIL: blank reason was ACCEPTED — validation did not fire.';
  END IF;
  RAISE NOTICE 'VE8 PASS: void with blank reason rejected with void_reason_required';

  -- ── RESET role back to superuser for cleanup ────────────────────
  EXECUTE 'RESET role';

  -- ── CLEANUP: delete both probe payments ─────────────────────────
  DELETE FROM public.space_payments WHERE id IN (v_payment_id, v_payment_id_2);
  RAISE NOTICE 'CLEANUP: deleted probe payments id=% id=%', v_payment_id, v_payment_id_2;
END $$;

-- ── FINAL: one PASS row ─────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'record_space_payment + void_space_payment'::TEXT AS target,
  ARRAY[
    'VS1  record_space_payment signature exists',
    'VS2  void_space_payment signature exists',
    'VS3  both SECURITY DEFINER + search_path pinned',
    'VS4  authenticated has EXECUTE on both; PUBLIC/anon do not',
    'VS5  SCHEMA_SPACE_PAYMENT_RPCS_V1 audit row present',
    'VE1  EXECUTION manager records + snapshots + recorded_by_email = JWT',
    'VE2  EXECUTION mid-month input normalizes to first-of-month',
    'VE3  EXECUTION amount=0 rejected with amount_not_positive',
    'VE4  EXECUTION cross-property manager rejected with space_not_in_your_properties (RAISES FIXTURE FAIL if no cross-property space seeded — no skip path)',
    'VE5  EXECUTION double-submit within 60s rejected with duplicate_payment_suspected',
    'VE6  EXECUTION void sets triple, amount + period untouched',
    'VE7  EXECUTION second void rejected with already_voided',
    'VE8  EXECUTION void with blank reason rejected with void_reason_required'
  ] AS gates_verified,
  'NOT tested here (manual/follow-up): 2+ tied resident case for NULL snapshots — needs specific seed'::TEXT AS deferred,
  now() AS verified_at;

-- ══════════════════════════════════════════════════════════════════════
-- MANUAL CLEANUP (only if a VE gate raised mid-sequence AND the outer
-- transaction did NOT roll back — should not happen in Supabase SQL
-- Editor autocommit, but the cleanup one-liner is here for the safe case):
--
--   DELETE FROM public.space_payments
--    WHERE note LIKE 'VE% probe';
-- ══════════════════════════════════════════════════════════════════════
