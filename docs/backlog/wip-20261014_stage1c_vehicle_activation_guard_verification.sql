-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Stage 1c, the vehicle activation guard
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G4 PROVES THE REFUSAL AS `authenticated`, not by simulation.
-- set_config('request.jwt.claims') changes auth.jwt() but NOT
-- current_user, which is the only thing this guard reads. So the gate
-- uses SET LOCAL ROLE authenticated — the same current_user PostgREST
-- presents — and then asserts the exception by MESSAGE_TEXT.
--
-- 🔴 AND IT DISTINGUISHES THE REASONS. Under SET ROLE authenticated,
-- RLS also applies, so an UPDATE can come back 0 ROWS (filtered) rather
-- than raising. 0 rows would look like "refused" while proving nothing
-- about the guard. The gate therefore requires the SPECIFIC message and
-- fails if the statement merely matched nothing — the sqlstate-42501
-- lesson, applied to a different shared symptom.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_stamp TEXT := to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  v_prop  TEXT; v_co TEXT;
  v_mgr   TEXT;
  v_vid   BIGINT;
  v_n     INT;
  v_msg   TEXT;
  v_r     JSONB;
BEGIN
  v_mgr := 'zz-s1c-mgr-'||v_stamp||'@test.invalid';

  -- ── G1: 🔴 the guard must NOT be SECURITY DEFINER ─────────────────
  -- The single most important structural assertion in this file. As
  -- DEFINER, current_user would be the owner for every caller and the
  -- guard would pass everything while looking installed.
  IF to_regprocedure('public.vehicles_activation_guard()') IS NULL THEN
    v_fail := v_fail || 'G1: vehicles_activation_guard() is missing';
  ELSE
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.vehicles_activation_guard()')) THEN
      v_fail := v_fail || 'G1: 🔴 the guard is SECURITY DEFINER. current_user then resolves to the OWNER for every caller, so the guard silently permits everything. It must be INVOKER.';
    END IF;
    IF position('current_user' IN COALESCE((SELECT prosrc FROM pg_proc
         WHERE oid = to_regprocedure('public.vehicles_activation_guard()')),'')) = 0 THEN
      v_fail := v_fail || 'G1: the guard no longer reads current_user — the discriminator is gone';
    END IF;
  END IF;

  -- ── G2: the trigger, on BOTH events ───────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.vehicles'::regclass
       AND t.tgname = 'vehicles_activation_guard_trigger'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid) ~ 'BEFORE INSERT OR UPDATE'
  ) THEN
    v_fail := v_fail || format('G2: trigger missing or not BEFORE INSERT OR UPDATE. Found: %s',
      COALESCE((SELECT pg_get_triggerdef(oid) FROM pg_trigger
                 WHERE tgrelid='public.vehicles'::regclass
                   AND tgname='vehicles_activation_guard_trigger'), '(none)'));
  END IF;

  -- ── fixtures ──────────────────────────────────────────────────────
  SELECT p.name, p.company INTO v_prop, v_co FROM public.properties p
   WHERE lower(trim(p.name))='test legacy property' AND p.is_active LIMIT 1;

  IF v_prop IS NULL THEN
    v_fail := v_fail || 'G3: fixture property unresolved — the execution gates did NOT run, so nothing here proves the guard refuses OR that legitimate paths still work';
  ELSE
    INSERT INTO public.user_roles (email, role, company, property, is_active, can_approve_vehicles)
    VALUES (v_mgr, 'manager', v_co, ARRAY[v_prop], TRUE, TRUE);

    -- ── G3: 🔴 POSITIVE CONTROL FIRST ───────────────────────────────
    -- A DEFINER RPC must still be able to activate. If this fails the
    -- guard has broken the product, and every refusal below is
    -- meaningless.
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_mgr, 'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1C',v_mgr,'ZZS1C1'||right(v_stamp,4),'TX');
    IF (v_r->>'action') <> 'added_active' THEN
      v_fail := v_fail || format('G3: 🔴 manager_add_vehicle can no longer create an ACTIVE vehicle: %s. The guard is refusing a DEFINER path, which means current_user is not resolving as expected.', v_r);
    END IF;
    v_vid := (v_r->>'vehicle_id')::BIGINT;

    -- a plain SQL UPDATE (current_user = postgres) must also pass
    BEGIN
      UPDATE public.vehicles SET status='pending', is_active=FALSE WHERE id=v_vid;
      UPDATE public.vehicles SET status='active',  is_active=TRUE  WHERE id=v_vid;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail || format('G3: 🔴 a plain SQL activation was refused (%s). Migrations and backfills run this way.', SQLERRM);
    END;

    -- ── G4: 🔴 THE REFUSAL, as a real `authenticated` session ───────
    UPDATE public.vehicles SET status='pending', is_active=FALSE WHERE id=v_vid;

    SET LOCAL ROLE authenticated;
    v_msg := NULL; v_n := -1;
    BEGIN
      UPDATE public.vehicles SET is_active=TRUE, status='active' WHERE id=v_vid;
      v_n := 0;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
    END;
    RESET ROLE;

    IF v_msg IS DISTINCT FROM 'vehicle_activation_not_permitted' THEN
      IF v_msg IS NULL AND v_n = 0 THEN
        -- The honest failure: nothing raised AND nothing matched. RLS
        -- filtered the row, so this run proved nothing about the guard.
        v_fail := v_fail || 'G4: the UPDATE matched 0 rows and raised nothing — RLS filtered it before the trigger could fire, so the guard was NOT exercised. Fix the fixture (the probe manager must have this property in scope), do not accept this as a pass.';
      ELSIF v_msg IS NULL THEN
        v_fail := v_fail || format('G4: 🔴 THE GUARD DID NOT FIRE. An `authenticated` session activated the vehicle directly (%s row(s)).', v_n);
      ELSE
        v_fail := v_fail || format('G4: refused, but not by the guard: %L. Another cause raising here would read as success.', v_msg);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE id=v_vid AND (is_active OR status='active')) THEN
      v_fail := v_fail || 'G4: 🔴 the refused UPDATE still changed the row';
    END IF;

    -- ── G5: an authenticated INSERT that arrives ACTIVE is refused ──
    SET LOCAL ROLE authenticated;
    v_msg := NULL;
    BEGIN
      INSERT INTO public.vehicles (plate,state,make,model,property,company,unit,resident_email,status,is_active)
      VALUES ('ZZS1C2'||right(v_stamp,4),'TX','P','S1c',v_prop,v_co,'S1C','zz-s1c-res@test.invalid','active',TRUE);
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
    END;
    RESET ROLE;
    IF v_msg IS DISTINCT FROM 'vehicle_activation_not_permitted' THEN
      v_fail := v_fail || format('G5: 🔴 an INSERT arriving ACTIVE was not refused by the guard (got %L). manager_insert_vehicles'' WITH CHECK validates role and property but NOT status, so this was a self-approval with no approve call.', COALESCE(v_msg,'no error'));
    END IF;
    DELETE FROM public.vehicles WHERE plate='ZZS1C2'||right(v_stamp,4);

    -- ── G6: POSITIVE CONTROLS — what must STILL be allowed ──────────
    -- A guard that refused every authenticated write would pass G4 and
    -- G5 and take decline, remove and cosmetic edits down with it.
    SET LOCAL ROLE authenticated;
    v_msg := NULL;
    BEGIN
      UPDATE public.vehicles SET color='ZZGUARD', model='Cosmetic' WHERE id=v_vid;      -- cosmetic
      UPDATE public.vehicles SET is_active=FALSE, status='declined' WHERE id=v_vid;      -- decline
      UPDATE public.vehicles SET is_active=FALSE, status='deactivated' WHERE id=v_vid;   -- remove
      INSERT INTO public.vehicles (plate,state,make,model,property,company,unit,resident_email,status,is_active)
      VALUES ('ZZS1C3'||right(v_stamp,4),'TX','P','S1c',v_prop,v_co,'S1C','zz-s1c-res@test.invalid','pending',FALSE);
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
    END;
    RESET ROLE;
    IF v_msg IS NOT NULL THEN
      v_fail := v_fail || format('G6: 🔴 the guard refused a LEGITIMATE authenticated write: %L. Decline, remove, cosmetic edits and pending INSERTs must all still work — only approval is gated.', v_msg);
    END IF;

    -- ── teardown ────────────────────────────────────────────────────
    DELETE FROM public.audit_logs
     WHERE action IN ('VEHICLE_STATE_CHANGE','MANAGER_ADD_VEHICLE_RPC')
       AND record_id IN (SELECT id::TEXT FROM public.vehicles WHERE plate LIKE 'ZZS1C%'||right(v_stamp,4));
    DELETE FROM public.vehicle_parking_tags WHERE vehicle_id IN
      (SELECT id FROM public.vehicles WHERE plate LIKE 'ZZS1C%');
    DELETE FROM public.vehicles WHERE plate LIKE 'ZZS1C%';
    DELETE FROM public.user_roles WHERE email = v_mgr;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE plate LIKE 'ZZS1C%')
       OR EXISTS (SELECT 1 FROM public.user_roles WHERE email = v_mgr) THEN
      v_fail := v_fail || 'teardown: probe rows survived';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'stage 1c vehicle activation guard'::TEXT AS target,
  'PASS'::TEXT                              AS result,
  (SELECT prosecdef FROM pg_proc
    WHERE oid = to_regprocedure('public.vehicles_activation_guard()'))            AS security_definer_want_false,
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.vehicles'::regclass AND NOT tgisinternal)               AS vehicles_triggers,
  (SELECT count(*) FROM public.vehicles WHERE is_active AND status='active')      AS active_vehicles,
  (SELECT count(*) FROM public.vehicles WHERE is_active AND status<>'active')     AS divergent_want_2,
  'G3-G6 EXECUTED under SET LOCAL ROLE authenticated: a DEFINER RPC and plain SQL still activate (positive controls); a direct UPDATE and an INSERT-arriving-active are both refused by MESSAGE_TEXT, with 0-rows-from-RLS failed as "not exercised" rather than passed; decline, remove, cosmetic and pending INSERT all still permitted.'::TEXT AS execution_proof;
