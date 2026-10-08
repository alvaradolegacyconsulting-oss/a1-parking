-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — duplicate plate handling
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- Includes EXECUTION gates where it can (normalize_plate is pure, so it
-- can simply be called). The manager-facing plate_already_active shape
-- and the resident-facing refusals need authenticated sessions and are
-- proven by  npm run verify:dupeplate  — a green run here is not a
-- green run of the feature.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_app  OID;
  v_req  OID;
  v_src  TEXT;
  v_idx  INT;
  v_bad  INT;
BEGIN
  -- ── G1 — normalize_plate is aggressive now. EXECUTION, not prosrc. ─
  IF public.normalize_plate('ABC-123') <> 'ABC123' THEN
    v_fail := v_fail || format('G1: normalize_plate(''ABC-123'') = %L, want ABC123', public.normalize_plate('ABC-123'));
  END IF;
  IF public.normalize_plate('abc 123') <> 'ABC123' THEN
    v_fail := v_fail || 'G1: whitespace + case handling regressed';
  END IF;
  IF public.normalize_plate(NULL) <> '' THEN
    v_fail := v_fail || 'G1: NULL no longer returns empty string';
  END IF;
  -- Underscore must be stripped too — \W would have kept it.
  IF public.normalize_plate('A_B1') <> 'AB1' THEN
    v_fail := v_fail || 'G1: underscore not stripped — body probably uses \W';
  END IF;

  -- ── G2 — it still agrees with the CLIENT rule on live data ─────────
  -- The point of PART 3. Recomputed against the TS rule's regex.
  SELECT count(*) INTO v_bad
    FROM public.vehicles
   WHERE public.normalize_plate(plate)
         <> upper(regexp_replace(COALESCE(plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF v_bad > 0 THEN
    v_fail := v_fail || format('G2: %s vehicle row(s) still normalize differently from the client rule', v_bad);
  END IF;

  -- ── G3 — every dependent index exists AND IS VALID ────────────────
  -- A failed REINDEX can leave indisvalid=false, which stops enforcing
  -- uniqueness while still looking present.
  SELECT count(*) INTO v_idx
    FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%normalize_plate%';
  IF v_idx = 0 THEN
    v_fail := v_fail || 'G3: no indexes reference normalize_plate — vehicles_plate_norm_uniq is missing';
  END IF;
  SELECT count(*) INTO v_bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE pg_get_indexdef(i.indexrelid) ILIKE '%normalize_plate%'
     AND NOT (i.indisvalid AND i.indisready);
  IF v_bad > 0 THEN
    v_fail := v_fail || format('G3: 🔴 %s dependent index(es) are INVALID or NOT READY — uniqueness is not being enforced', v_bad);
  END IF;

  -- ── G4 — approve_vehicle: shape preserved, handler present ────────
  v_app := to_regprocedure('public.approve_vehicle(bigint,text)');
  IF v_app IS NULL THEN
    v_fail := v_fail || 'G4: approve_vehicle(bigint,text) is GONE';
  ELSE
    IF pg_get_function_arguments(v_app) NOT ILIKE '%DEFAULT NULL%' THEN
      v_fail := v_fail || format('G4: p_manager_note DEFAULT dropped. args: %s', pg_get_function_arguments(v_app));
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid=v_app) <> 'v' THEN
      v_fail := v_fail || 'G4: approve_vehicle volatility changed';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_app) THEN
      v_fail := v_fail || 'G4: approve_vehicle lost SECURITY DEFINER';
    END IF;
    v_src := (SELECT prosrc FROM pg_proc WHERE oid=v_app);
    IF v_src NOT LIKE '%plate_already_active%' THEN
      v_fail := v_fail || 'G5: approve_vehicle does not return plate_already_active';
    END IF;
    -- 🔴 The backstop, not just the pre-check. Without the handler the
    -- race path is still a raw 23505 and still hangs the button.
    IF v_src NOT LIKE '%unique_violation%' THEN
      v_fail := v_fail || 'G5: approve_vehicle has NO unique_violation handler — the race still raises a raw 409';
    END IF;
    IF v_src NOT LIKE '%same_resident%' THEN
      v_fail := v_fail || 'G5: approve_vehicle does not report same_resident — the UI cannot pick its message';
    END IF;
    IF v_src NOT LIKE '%existing_unit%' OR v_src NOT LIKE '%existing_resident_email%' THEN
      v_fail := v_fail || 'G5: approve_vehicle does not report the existing record''s unit/resident';
    END IF;
  END IF;

  -- ── G6 — request_my_vehicle refuses at the source ─────────────────
  v_req := to_regprocedure('public.request_my_vehicle(text,text,text,text,integer,text)');
  IF v_req IS NULL THEN
    v_fail := v_fail || 'G6: request_my_vehicle signature changed or missing';
  ELSE
    v_src := (SELECT prosrc FROM pg_proc WHERE oid=v_req);
    IF v_src NOT LIKE '%vehicle_already_registered%' THEN
      v_fail := v_fail || 'G6: request_my_vehicle does not refuse an already-ACTIVE plate';
    END IF;
    IF v_src NOT LIKE '%vehicle_already_pending%' THEN
      v_fail := v_fail || 'G6: request_my_vehicle does not refuse an already-PENDING plate';
    END IF;
    IF v_src NOT LIKE '%account_deactivated%' THEN
      v_fail := v_fail || 'G6: request_my_vehicle lost the effective-active guard';
    END IF;
    -- The pre-existing company stamp must survive the replacement.
    IF v_src NOT LIKE '%v_company%' THEN
      v_fail := v_fail || 'G6: request_my_vehicle lost the vehicles.company stamp (2026-08-28 arc)';
    END IF;
  END IF;

  -- ── G7 — grants by executability ──────────────────────────────────
  IF v_app IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', v_app, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: authenticated cannot execute approve_vehicle';
    END IF;
    IF has_function_privilege('anon', v_app, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: 🔴 anon can execute approve_vehicle';
    END IF;
  END IF;
  IF v_req IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', v_req, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: authenticated cannot execute request_my_vehicle';
    END IF;
    IF has_function_privilege('anon', v_req, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: 🔴 anon can execute request_my_vehicle';
    END IF;
  END IF;

  -- ── G8 — deactivate_vehicle: pending is no longer "already deactivated"
  DECLARE v_dv OID; BEGIN
    v_dv := to_regprocedure('public.deactivate_vehicle(bigint,text,text)');
    IF v_dv IS NULL THEN
      v_fail := v_fail || 'G8: deactivate_vehicle(bigint,text,text) missing';
    ELSE
      v_src := (SELECT prosrc FROM pg_proc WHERE oid=v_dv);
      IF v_src NOT LIKE '%v_vehicle.status = ''deactivated''%' THEN
        v_fail := v_fail || 'G8: the shortcut is not keyed on status=deactivated — a pending row still short-circuits and Clear duplicate silently no-ops';
      END IF;
      IF v_src LIKE '%IF v_vehicle.is_active = false THEN%' THEN
        v_fail := v_fail || 'G8: the OLD is_active=false shortcut is still present';
      END IF;
      -- Regression guard on the 2026-10-06 arc: that change must survive
      -- this replacement.
      IF v_src NOT LIKE '%''resident_removed''%' THEN
        v_fail := v_fail || 'G8: 🔴 resident_removed was LOST from v_system_codes — the 2026-10-06 replacement was reverted';
      END IF;
      IF pg_get_function_arguments(v_dv) NOT ILIKE '%DEFAULT NULL%' THEN
        v_fail := v_fail || 'G8: deactivate_vehicle p_note DEFAULT dropped';
      END IF;
    END IF;
  END;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'duplicate plate handling'::TEXT                                  AS target,
  'PASS'::TEXT                                                      AS result,
  public.normalize_plate('ABC-123')                                 AS norm_abc_123,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname='public' AND indexdef ILIKE '%normalize_plate%') AS dependent_indexes_rebuilt,
  (SELECT count(*) FROM public.vehicles
    WHERE status='pending' AND EXISTS (
      SELECT 1 FROM public.vehicles a
       WHERE a.is_active AND a.status='active'
         AND lower(trim(a.property)) = lower(trim(vehicles.property))
         AND public.normalize_plate(a.plate) = public.normalize_plate(vehicles.plate)
    ))                                                              AS pending_still_colliding,
  (SELECT prosrc LIKE '%v_vehicle.status = ''deactivated''%' FROM pg_proc
     WHERE oid = to_regprocedure('public.deactivate_vehicle(bigint,text,text)')) AS pending_is_not_deactivated,
  'NOT PROVEN HERE: manager + resident messages. Run npm run verify:dupeplate.'::TEXT AS execution_proof;
