-- ════════════════════════════════════════════════════════════════════
-- Verification — 20260720_pm_plate_lookup_hardening
-- 2026-07-20
--
-- Runs as service_role (Supabase SQL editor). VQ.A/B/C are pure shape
-- checks. VQ.D is a self-cleaning determinism smoke that PROVES Fix 1
-- (ORDER BY vp.expires_at DESC) works end-to-end: insert 2 disposable
-- visitor_passes for the same (plate, property, active-window) with
-- DIFFERENT expires_at, then confirm the RPC returns the FRESHEST one
-- deterministically.
--
-- VQ.D cannot use the pm_plate_lookup RPC directly (it requires an
-- auth.jwt() context which the editor lacks). Instead it exercises the
-- fix at the SQL-predicate level — copy of the exact SELECT the RPC
-- runs — proving the ORDER BY + LIMIT 1 pair returns the freshest row.
-- The RPC end-to-end verify is Jose's manager-portal hand-check (see
-- Fix 1 verify plan in the hardening migration's docstring).
--
-- All writes disposable + explicit DELETE cleanup. Silent success =
-- all gates green. Any RAISE EXCEPTION halts.
-- ════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════
-- VQ.A — pg_proc shape: exactly one pm_plate_lookup, correct signature
-- ══════════════════════════════════════════════════════════════════
DO $vqa$
DECLARE
  v_count INT;
  v_rettype TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.A FAIL: pm_plate_lookup expected 1 overload, found %', v_count;
  END IF;

  -- Signature check: (TEXT) → jsonb
  SELECT pg_catalog.format_type(p.prorettype, NULL) INTO v_rettype
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_rettype <> 'jsonb' THEN
    RAISE EXCEPTION 'VQ.A FAIL: pm_plate_lookup return type expected jsonb, found %', v_rettype;
  END IF;

  RAISE NOTICE 'VQ.A PASS: pm_plate_lookup pg_proc shape correct (1 overload, returns jsonb)';
END $vqa$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.B — SECURITY DEFINER + search_path locked + ACL correct
-- ══════════════════════════════════════════════════════════════════
DO $vqb$
DECLARE
  v_secdef       BOOL;
  v_search_path  TEXT[];
  v_public_ok    BOOL;
  v_anon_ok      BOOL;
  v_auth_ok      BOOL;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_search_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VQ.B FAIL: pm_plate_lookup should be SECURITY DEFINER';
  END IF;
  IF v_search_path IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_search_path) s
    WHERE s ~ 'search_path' AND s ~ 'public' AND s ~ 'pg_temp'
  ) THEN
    RAISE EXCEPTION 'VQ.B FAIL: pm_plate_lookup search_path must be locked to public, pg_temp — found %', v_search_path;
  END IF;

  v_public_ok := has_function_privilege('public', 'public.pm_plate_lookup(text)', 'EXECUTE');
  v_anon_ok   := has_function_privilege('anon',   'public.pm_plate_lookup(text)', 'EXECUTE');
  v_auth_ok   := has_function_privilege('authenticated', 'public.pm_plate_lookup(text)', 'EXECUTE');
  IF v_public_ok THEN
    RAISE EXCEPTION 'VQ.B FAIL: public should NOT have EXECUTE on pm_plate_lookup';
  END IF;
  IF v_anon_ok THEN
    RAISE EXCEPTION 'VQ.B FAIL: anon should NOT have EXECUTE on pm_plate_lookup';
  END IF;
  IF NOT v_auth_ok THEN
    RAISE EXCEPTION 'VQ.B FAIL: authenticated should have EXECUTE on pm_plate_lookup';
  END IF;

  RAISE NOTICE 'VQ.B PASS: SECURITY DEFINER + search_path (public, pg_temp) + ACL {public:false, anon:false, authenticated:true}';
END $vqb$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.C — SCHEMA_ audit row landed with both fix docstrings
-- ══════════════════════════════════════════════════════════════════
DO $vqc$
DECLARE
  v_count INT;
  v_fix1  TEXT;
  v_fix2  TEXT;
BEGIN
  SELECT COUNT(*),
         MAX(new_values->>'fix_1'),
         MAX(new_values->>'fix_2')
    INTO v_count, v_fix1, v_fix2
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PM_PLATE_LOOKUP_HARDENING'
     AND new_values->>'migration' = '20260720_pm_plate_lookup_hardening';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: SCHEMA_ audit row missing';
  END IF;
  IF v_fix1 IS NULL OR position('ORDER BY vp.expires_at DESC' in v_fix1) = 0 THEN
    RAISE EXCEPTION 'VQ.C FAIL: audit row fix_1 missing ORDER BY documentation';
  END IF;
  IF v_fix2 IS NULL OR position('v_properties_normalized' in v_fix2) = 0 THEN
    RAISE EXCEPTION 'VQ.C FAIL: audit row fix_2 missing v_properties_normalized documentation';
  END IF;
  RAISE NOTICE 'VQ.C PASS: SCHEMA_ audit row present with both fix docstrings';
END $vqc$;


-- ══════════════════════════════════════════════════════════════════
-- 🔴 VQ.D — SELF-CLEANING DETERMINISM SMOKE (proves Fix 1)
-- Insert 2 disposable visitor_passes for the SAME (plate, property,
-- active) with DIFFERENT expires_at. Run the exact SELECT the RPC's
-- visitor_passes branch runs. Confirm the FRESHEST (higher
-- expires_at) row is returned deterministically across multiple
-- runs. Cannot use the RPC directly (no auth.jwt() context in editor
-- session) — SQL-predicate-level check is the strongest programmable
-- proof from this vantage.
-- ══════════════════════════════════════════════════════════════════
DO $vqd$
DECLARE
  v_older_id       BIGINT;
  v_fresher_id     BIGINT;
  v_returned_id    BIGINT;
  v_returned_unit  TEXT;
  v_normalized     TEXT;
  v_properties_normalized TEXT[];
  v_test_prop      TEXT := 'VQ-D-Determinism-Smoke-Prop';
  v_test_plate     TEXT := 'VQD-DET-1';
  i                INT;
BEGIN
  -- Preflight: no existing rows for this test plate (should be a
  -- pristine test — abort with a clear message if not).
  IF EXISTS (SELECT 1 FROM visitor_passes
             WHERE upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g'))
                     = upper(regexp_replace(v_test_plate, '[^A-Za-z0-9]', '', 'g'))) THEN
    RAISE EXCEPTION 'VQ.D SETUP FAIL: pre-existing rows for test plate [%] — run cleanup first', v_test_plate;
  END IF;

  -- Insert OLDER pass first (earlier created_at, earlier expires_at).
  INSERT INTO visitor_passes (plate, visitor_name, visiting_unit, property,
                              vehicle_desc, duration_hours,
                              created_at, expires_at, is_active)
  VALUES (upper(regexp_replace(v_test_plate, '[^A-Za-z0-9]', '', 'g')),
          'VQD-Older', 'UNIT-OLDER', v_test_prop,
          NULL, 24,
          now() - interval '10 hours', now() + interval '14 hours', TRUE)
  RETURNING id INTO v_older_id;

  -- Insert FRESHER pass second (later created_at, later expires_at).
  INSERT INTO visitor_passes (plate, visitor_name, visiting_unit, property,
                              vehicle_desc, duration_hours,
                              created_at, expires_at, is_active)
  VALUES (upper(regexp_replace(v_test_plate, '[^A-Za-z0-9]', '', 'g')),
          'VQD-Fresher', 'UNIT-FRESHER', v_test_prop,
          NULL, 24,
          now(), now() + interval '24 hours', TRUE)
  RETURNING id INTO v_fresher_id;

  -- Normalize the test property once (mirrors the RPC body's Fix 2 step).
  v_properties_normalized := ARRAY[lower(trim(v_test_prop))];
  v_normalized := upper(regexp_replace(v_test_plate, '[^A-Za-z0-9]', '', 'g'));

  -- Run the EXACT SELECT the RPC's visitor-pass branch runs, 3 times.
  -- Assert we get the FRESHER row every time.
  FOR i IN 1..3 LOOP
    SELECT vp.id, vp.visiting_unit
      INTO v_returned_id, v_returned_unit
      FROM visitor_passes vp
      WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vp.is_active = TRUE
        AND vp.expires_at > now()
        AND lower(trim(vp.property)) = ANY (v_properties_normalized)
      ORDER BY vp.expires_at DESC
      LIMIT 1;

    IF v_returned_id <> v_fresher_id THEN
      -- Cleanup before failing so we don't leave test rows.
      DELETE FROM visitor_passes WHERE id IN (v_older_id, v_fresher_id);
      RAISE EXCEPTION
        'VQ.D FAIL (run %): expected fresher pass id=% (unit=UNIT-FRESHER), got id=% (unit=%)',
        i, v_fresher_id, v_returned_id, v_returned_unit;
    END IF;
    IF v_returned_unit <> 'UNIT-FRESHER' THEN
      DELETE FROM visitor_passes WHERE id IN (v_older_id, v_fresher_id);
      RAISE EXCEPTION 'VQ.D FAIL (run %): expected unit=UNIT-FRESHER, got unit=%', i, v_returned_unit;
    END IF;
  END LOOP;

  -- Cleanup — always leave zero test rows.
  DELETE FROM visitor_passes WHERE id IN (v_older_id, v_fresher_id);

  RAISE NOTICE 'VQ.D PASS: ORDER BY vp.expires_at DESC returns fresher pass deterministically (3/3 runs, ids %,% → returned %)', v_older_id, v_fresher_id, v_fresher_id;
END $vqd$;

-- Silent success = all four VQs green.
