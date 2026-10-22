-- Verification for wip-20261022_driver_property_guard.sql
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
--
-- 🔴 EXECUTED ON A DEACTIVATED CANARY PROPERTY AT A TEST TENANT, never
-- on A1. It creates its own property, flips it inactive, proves both
-- guards refuse, proves an ACTIVE property still accepts (the control
-- that matters most — 18 live A1 driver/property pairs depend on it),
-- and removes everything with a read-back.
DO $do$
DECLARE
  v_fail     TEXT[] := '{}';
  v_co       TEXT;
  v_live     TEXT;
  v_dead     TEXT;
  v_live_id  BIGINT;
  v_dead_id  BIGINT;
  v_vid      BIGINT;
  v_sqlstate TEXT;
  v_msg      TEXT;
BEGIN
  SELECT name INTO v_co FROM public.companies WHERE company_env = 'test' ORDER BY id LIMIT 1;
  IF v_co IS NULL THEN RAISE EXCEPTION 'VERIFICATION INCONCLUSIVE: no test-env company'; END IF;
  v_live := 'zzguard-live-'  || extract(epoch FROM now())::BIGINT;
  v_dead := 'zzguard-dead-'  || extract(epoch FROM now())::BIGINT;

  INSERT INTO public.properties (name, company, is_active) VALUES (v_live, v_co, TRUE)  RETURNING id INTO v_live_id;
  INSERT INTO public.properties (name, company, is_active) VALUES (v_dead, v_co, FALSE) RETURNING id INTO v_dead_id;

  -- ── G1 — the control: an ACTIVE property still accepts ───────────
  -- 🔴 FIRST, AND IT IS THE POINT. A guard that refuses everything
  -- passes every negative test. 18 (active A1 driver × active assigned
  -- property) pairs must keep working, and this is that assertion in
  -- miniature. No JWT is set, so get_my_role() is NULL and the
  -- assignment half is correctly skipped — this leg tests the
  -- is_active half only.
  BEGIN
    INSERT INTO public.violations (plate, violation_type, location, property, driver_name, is_confirmed)
    VALUES ('ZZGUARD01', 'No Permit', 'canary', v_live, 'verification', FALSE)
    RETURNING id INTO v_vid;
    DELETE FROM public.violations WHERE id = v_vid;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_fail := array_append(v_fail, format('G1: an ACTIVE property was REFUSED (%s: %s) — the guard would break live enforcement', v_sqlstate, v_msg));
  END;

  -- ── G2 — a citation at a deactivated property is refused ─────────
  BEGIN
    INSERT INTO public.violations (plate, violation_type, location, property, driver_name, is_confirmed)
    VALUES ('ZZGUARD02', 'No Permit', 'canary', v_dead, 'verification', FALSE)
    RETURNING id INTO v_vid;
    DELETE FROM public.violations WHERE id = v_vid;
    v_fail := array_append(v_fail, 'G2: a citation was CREATED at a deactivated property');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE '%Enforcement is not active%' THEN
      v_fail := array_append(v_fail, format('G2: refused, but by something else: %s', v_msg));
    END IF;
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_fail := array_append(v_fail, format('G2: refused with %s (%s), not the guard', v_sqlstate, v_msg));
  END;

  -- ── G3 — a property NAME that matches nothing is refused too ─────
  -- Absence is not permission. The phantom-property class wrote rows
  -- against names with no matching property.
  BEGIN
    INSERT INTO public.violations (plate, violation_type, location, property, driver_name, is_confirmed)
    VALUES ('ZZGUARD03', 'No Permit', 'canary', 'zzguard-no-such-property', 'verification', FALSE)
    RETURNING id INTO v_vid;
    DELETE FROM public.violations WHERE id = v_vid;
    v_fail := array_append(v_fail, 'G3: a citation was created against a property name that does not exist');
  EXCEPTION WHEN check_violation THEN NULL;
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    v_fail := array_append(v_fail, format('G3: refused with %s, not the guard', v_sqlstate));
  END;

  -- ── G4 — the TOW guard, on a citation written while live ─────────
  -- The citation is created at the ACTIVE property, the property is
  -- then deactivated, and only then is the tow attempted — which is
  -- the real sequence: a ticket written legitimately, a contract that
  -- ended, and a truck dispatched afterwards.
  INSERT INTO public.violations (plate, violation_type, location, property, driver_name, is_confirmed)
  VALUES ('ZZGUARD04', 'No Permit', 'canary', v_live, 'verification', TRUE)
  RETURNING id INTO v_vid;

  UPDATE public.properties SET is_active = FALSE WHERE id = v_live_id;

  BEGIN
    UPDATE public.violations SET tow_ticket_generated = TRUE WHERE id = v_vid;
    v_fail := array_append(v_fail, 'G4: a TOW was stamped at a deactivated property');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE '%No tow ticket can be issued%' THEN
      v_fail := array_append(v_fail, format('G4: refused, but by something else: %s', v_msg));
    END IF;
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_fail := array_append(v_fail, format('G4: refused with %s (%s), not the guard', v_sqlstate, v_msg));
  END;

  -- ── G5 — and the corrective paths still work on that row ─────────
  -- 🔴 The deactivation must not strand a live ticket. If voiding or
  -- resolving were blocked too, a property ending its contract would
  -- freeze every open citation on it.
  BEGIN
    UPDATE public.violations SET status = 'resolved' WHERE id = v_vid;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_fail := array_append(v_fail, format('G5: a citation at a deactivated property could not be RESOLVED (%s: %s)', v_sqlstate, v_msg));
  END;

  -- ── cleanup, checked ─────────────────────────────────────────────
  DELETE FROM public.violations WHERE plate LIKE 'ZZGUARD%';
  DELETE FROM public.properties WHERE id IN (v_live_id, v_dead_id);
  IF EXISTS (SELECT 1 FROM public.violations WHERE plate LIKE 'ZZGUARD%') THEN
    v_fail := array_append(v_fail, 'G6: canary violations survived cleanup');
  END IF;
  IF EXISTS (SELECT 1 FROM public.properties WHERE id IN (v_live_id, v_dead_id)) THEN
    v_fail := array_append(v_fail, 'G6: canary properties survived cleanup');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n%', array_to_string(v_fail, E'\n');
  END IF;
END
$do$;

SELECT 'PASS — active property still accepts; deactivated and nonexistent properties refuse the citation; the tow is refused at a deactivated property; resolve still works there; canaries removed' AS result;
