-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Stage 1b, approve_vehicle authority
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G4 EXECUTES, AND THE POSITIVE CONTROL IS THE POINT. A function
-- that returned authority_not_permitted to everyone would close the
-- hole and break every approval in the product — and would pass every
-- refusal check on its own. So the flagged manager and the CA must
-- SUCCEED in the same run.
--
-- Impersonation is set_config('request.jwt.claims', ...), the pattern
-- the original approve_vehicle verification already uses. get_my_role()
-- reads user_roles by JWT email, so the probe roles need no auth user.

DO $$
DECLARE
  v_fail   TEXT[] := ARRAY[]::TEXT[];
  v_src    TEXT;
  v_anchor TEXT;
  v_prop   TEXT;
  v_co     TEXT;
  v_stamp  TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_noflag TEXT;
  v_flag   TEXT;
  v_ca     TEXT;
  v_v1     BIGINT; v_v2 BIGINT; v_v3 BIGINT;
  v_r      JSONB;
  v_via    BOOLEAN;
BEGIN
  v_noflag := 'zz-s1b-noflag-' || v_stamp || '@test.invalid';
  v_flag   := 'zz-s1b-flag-'   || v_stamp || '@test.invalid';
  v_ca     := 'zz-s1b-ca-'     || v_stamp || '@test.invalid';

  -- ── G1: signature, overloads, grants ──────────────────────────────
  IF (SELECT count(*) FROM pg_proc
       WHERE proname='approve_vehicle' AND pronamespace='public'::regnamespace) <> 1 THEN
    v_fail := v_fail || 'G1: approve_vehicle no longer has exactly one overload';
  END IF;
  IF to_regprocedure('public.approve_vehicle(bigint,text)') IS NULL THEN
    v_fail := v_fail || 'G1: the (bigint,text) signature is gone';
  ELSE
    -- CREATE OR REPLACE DROPS parameter defaults. p_manager_note must
    -- still default, or every 1-arg caller breaks.
    IF (SELECT pronargdefaults FROM pg_proc
         WHERE oid = to_regprocedure('public.approve_vehicle(bigint,text)')) < 1 THEN
      v_fail := v_fail || 'G1: 🔴 p_manager_note lost its DEFAULT — CREATE OR REPLACE drops defaults, and 1-arg callers now fail';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.approve_vehicle(bigint,text)')) THEN
      v_fail := v_fail || 'G1: SECURITY DEFINER lost';
    END IF;
    IF has_function_privilege('anon','public.approve_vehicle(bigint,text)','EXECUTE') THEN
      v_fail := v_fail || 'G1: 🔴 anon can execute approve_vehicle';
    END IF;
    IF NOT has_function_privilege('authenticated','public.approve_vehicle(bigint,text)','EXECUTE') THEN
      v_fail := v_fail || 'G1: authenticated lost execute — approvals are dead';
    END IF;
  END IF;

  -- ── G2: the preserved body ────────────────────────────────────────
  v_src := COALESCE((SELECT prosrc FROM pg_proc
                      WHERE oid = to_regprocedure('public.approve_vehicle(bigint,text)')), '');
  FOREACH v_anchor IN ARRAY ARRAY[
    'v_caller_role NOT IN (''manager'', ''company_admin'')',
    'v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);',
    'AND p.company ~~* v_caller_company',
    '''action'',  ''noop_already_active'',',
    'public.normalize_plate(v.plate) = public.normalize_plate(v_vehicle.plate)',
    'EXCEPTION WHEN unique_violation THEN',
    '''raced'',                   TRUE,',
    'resident_read = TRUE,'
  ] LOOP
    IF position(v_anchor IN v_src) = 0 THEN
      v_fail := v_fail || format('G2: 🔴 a preserved clause is MISSING: %s', v_anchor);
    END IF;
  END LOOP;
  -- 🔴 The role list must NOT have been widened under cover of a
  -- security fix. leasing_agent cannot approve, and must still not.
  IF v_src ~ 'leasing_agent' THEN
    v_fail := v_fail || 'G2: 🔴 leasing_agent appears in approve_vehicle. It was never a caller; adding it while "fixing authority" would GRANT approval, not restrict it.';
  END IF;
  IF position('authority_not_permitted' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: the authority check is missing';
  END IF;
  IF position('app.vehicle_approve_id' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: the audit annotation (set_config) is missing';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- G3/G4 — EXECUTION on fresh probe rows
  -- ════════════════════════════════════════════════════════════════
  SELECT p.name, p.company INTO v_prop, v_co
    FROM public.properties p
   WHERE lower(trim(p.name)) = 'test legacy property' AND p.is_active
   LIMIT 1;

  IF v_prop IS NULL THEN
    v_fail := v_fail || 'G3: fixture property unresolved — the execution gates did NOT run, so nothing here proves the hole is closed OR that approvals still work';
  ELSE
    INSERT INTO public.user_roles (email, role, company, property, is_active, can_approve_vehicles)
    VALUES (v_noflag, 'manager',       v_co, ARRAY[v_prop], TRUE, FALSE),
           (v_flag,   'manager',       v_co, ARRAY[v_prop], TRUE, TRUE),
           (v_ca,     'company_admin', v_co, ARRAY[v_prop], TRUE, FALSE);

    INSERT INTO public.vehicles (plate, state, make, model, property, company, unit, resident_email, status, is_active)
    VALUES ('ZZS1B1' || right(v_stamp,4), 'TX', 'Probe', 'S1b', v_prop, v_co, 'S1B', 'zz-s1b-res@test.invalid', 'pending', FALSE)
    RETURNING id INTO v_v1;
    INSERT INTO public.vehicles (plate, state, make, model, property, company, unit, resident_email, status, is_active)
    VALUES ('ZZS1B2' || right(v_stamp,4), 'TX', 'Probe', 'S1b', v_prop, v_co, 'S1B', 'zz-s1b-res@test.invalid', 'pending', FALSE)
    RETURNING id INTO v_v2;
    INSERT INTO public.vehicles (plate, state, make, model, property, company, unit, resident_email, status, is_active)
    VALUES ('ZZS1B3' || right(v_stamp,4), 'TX', 'Probe', 'S1b', v_prop, v_co, 'S1B', 'zz-s1b-res@test.invalid', 'pending', FALSE)
    RETURNING id INTO v_v3;

    -- ── G3: the hole is CLOSED ──────────────────────────────────────
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_noflag, 'role', 'authenticated')::TEXT, TRUE);
    v_r := public.approve_vehicle(v_v1, 'gate');
    IF COALESCE(v_r ->> 'error', '') <> 'authority_not_permitted' THEN
      v_fail := v_fail || format(
        'G3: 🔴 THE HOLE IS STILL OPEN. A manager with can_approve_vehicles=FALSE got: %s', v_r);
    END IF;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE id = v_v1 AND (is_active OR status = 'active')) THEN
      v_fail := v_fail || 'G3: 🔴 the refused call still changed the vehicle';
    END IF;

    -- ── G4: POSITIVE CONTROLS — approvals must still work ───────────
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_flag, 'role', 'authenticated')::TEXT, TRUE);
    v_r := public.approve_vehicle(v_v2, 'gate');
    IF COALESCE((v_r ->> 'ok')::BOOLEAN, FALSE) IS NOT TRUE OR (v_r ->> 'action') <> 'approved' THEN
      v_fail := v_fail || format('G4: 🔴 a FLAGGED manager was refused: %s', v_r);
    END IF;

    -- CAs are always allowed, and this CA row carries the flag FALSE —
    -- which is exactly the case that proves the check is scoped to
    -- managers rather than applied to everyone.
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_ca, 'role', 'authenticated')::TEXT, TRUE);
    v_r := public.approve_vehicle(v_v3, 'gate');
    IF COALESCE((v_r ->> 'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
      v_fail := v_fail || format('G4: 🔴 a company_admin with can_approve_vehicles=FALSE was refused: %s. CAs are always allowed (ruled).', v_r);
    END IF;

    -- ── G5: via_approve_rpc now tells the truth ─────────────────────
    -- It read FALSE for every genuine approval before this change,
    -- because nothing set the GUC. A field that always says "not via
    -- the RPC" is a wrong positive claim, not a missing value.
    SELECT (new_values ->> 'via_approve_rpc')::BOOLEAN INTO v_via
      FROM public.audit_logs
     WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_v2::TEXT
       AND new_values ->> 'status' = 'active'
     ORDER BY created_at DESC LIMIT 1;
    IF COALESCE(v_via, FALSE) IS NOT TRUE THEN
      v_fail := v_fail || format('G5: via_approve_rpc is %s for an approval made THROUGH approve_vehicle; it must be true', COALESCE(v_via::TEXT,'null'));
    END IF;
    -- and it must stay FALSE for a direct write
    UPDATE public.vehicles SET status = 'pending', is_active = FALSE WHERE id = v_v3;
    SELECT (new_values ->> 'via_approve_rpc')::BOOLEAN INTO v_via
      FROM public.audit_logs
     WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_v3::TEXT
     ORDER BY created_at DESC LIMIT 1;
    IF COALESCE(v_via, FALSE) IS NOT FALSE THEN
      v_fail := v_fail || 'G5: 🔴 via_approve_rpc is TRUE for a direct SQL write — the annotation is leaking across statements';
    END IF;

    -- ── teardown ────────────────────────────────────────────────────
    DELETE FROM public.audit_logs
     WHERE record_id IN (v_v1::TEXT, v_v2::TEXT, v_v3::TEXT)
       AND action = 'VEHICLE_STATE_CHANGE';
    DELETE FROM public.vehicle_parking_tags WHERE vehicle_id IN (v_v1, v_v2, v_v3);
    DELETE FROM public.vehicles WHERE id IN (v_v1, v_v2, v_v3);
    DELETE FROM public.user_roles WHERE email IN (v_noflag, v_flag, v_ca);
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE id IN (v_v1, v_v2, v_v3))
       OR EXISTS (SELECT 1 FROM public.user_roles WHERE email IN (v_noflag, v_flag, v_ca)) THEN
      v_fail := v_fail || 'G5: probe rows were not fully removed';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'stage 1b approve_vehicle authority'::TEXT AS target,
  'PASS'::TEXT                               AS result,
  (SELECT count(*) FROM pg_proc
    WHERE proname='approve_vehicle' AND pronamespace='public'::regnamespace)     AS overloads_want_1,
  (SELECT pronargdefaults FROM pg_proc
    WHERE oid = to_regprocedure('public.approve_vehicle(bigint,text)'))          AS param_defaults_want_1,
  (SELECT count(*) FROM public.user_roles
    WHERE role = 'manager' AND is_active AND COALESCE(can_approve_vehicles,FALSE) = FALSE) AS managers_now_blocked,
  (SELECT count(*) FROM public.user_roles
    WHERE role = 'manager' AND is_active AND can_approve_vehicles)               AS managers_with_authority,
  (SELECT count(*) FROM public.user_roles ur JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
    WHERE ur.role='manager' AND ur.is_active
      AND COALESCE(ur.can_approve_vehicles,FALSE) = FALSE
      AND c.name = 'A1 Wrecker llc')                                             AS a1_managers_blocked_want_0,
  'G3-G5 EXECUTED: unflagged manager refused with authority_not_permitted and the row unchanged; FLAGGED manager and company_admin both approved (positive controls); via_approve_rpc true for the RPC path and false for a direct write.'::TEXT AS execution_proof;
