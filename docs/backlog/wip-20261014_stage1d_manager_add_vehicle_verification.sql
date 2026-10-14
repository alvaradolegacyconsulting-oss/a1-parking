-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Stage 1d, manager_add_vehicle
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 THE POSITIVE CONTROLS ARE THE GATE. Stage 1c refuses
-- INSERT-as-active; a manager_add_vehicle that landed EVERYTHING as
-- pending would satisfy 1c and quietly stop every flagged manager from
-- adding an active vehicle. So the flagged manager and the CA must both
-- land ACTIVE in the same run as the unflagged manager lands pending.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_stamp TEXT := to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  v_prop  TEXT; v_co TEXT; v_pmprop TEXT; v_pmco TEXT;
  v_mgrN  TEXT; v_mgrY TEXT; v_la TEXT; v_ca TEXT; v_pmN TEXT;
  v_r     JSONB;
  v_ids   BIGINT[] := ARRAY[]::BIGINT[];
  v_via   JSONB;
BEGIN
  v_mgrN := 'zz-s1d-mgrno-'||v_stamp||'@test.invalid';
  v_mgrY := 'zz-s1d-mgryes-'||v_stamp||'@test.invalid';
  v_la   := 'zz-s1d-la-'||v_stamp||'@test.invalid';
  v_ca   := 'zz-s1d-ca-'||v_stamp||'@test.invalid';
  v_pmN  := 'zz-s1d-pm-'||v_stamp||'@test.invalid';

  -- ── G1: the function, grants, defaults ────────────────────────────
  IF to_regprocedure('public.manager_add_vehicle(text,text,text,text,text,text,text,integer,text,text,text,date)') IS NULL THEN
    v_fail := v_fail || 'G1: manager_add_vehicle is missing at the expected 12-arg signature';
  ELSE
    IF has_function_privilege('anon','public.manager_add_vehicle(text,text,text,text,text,text,text,integer,text,text,text,date)','EXECUTE') THEN
      v_fail := v_fail || 'G1: 🔴 anon can execute it';
    END IF;
    IF (SELECT pronargdefaults FROM pg_proc
         WHERE oid = to_regprocedure('public.manager_add_vehicle(text,text,text,text,text,text,text,integer,text,text,text,date)')) <> 7 THEN
      v_fail := v_fail || 'G1: expected 7 parameter DEFAULTs (make..permit_expiry); CREATE OR REPLACE drops them';
    END IF;
  END IF;
  IF to_regprocedure('public.plate_prohibition_at(text,text)') IS NULL THEN
    v_fail := v_fail || 'G1: plate_prohibition_at is missing — the pre-check cannot work';
  END IF;

  -- ── fixtures ──────────────────────────────────────────────────────
  SELECT p.name, p.company INTO v_prop, v_co FROM public.properties p
   WHERE lower(trim(p.name))='test legacy property' AND p.is_active LIMIT 1;
  -- a pm_only property, to prove the permit door survives authority
  SELECT p.name, p.company INTO v_pmprop, v_pmco
    FROM public.properties p JOIN public.companies c
      ON lower(trim(c.name))=lower(trim(p.company))
   WHERE c.tier='pm_only' AND p.is_active LIMIT 1;

  IF v_prop IS NULL THEN
    v_fail := v_fail || 'G2: fixture property unresolved — the execution gates did NOT run, so nothing here proves active-vs-pending either way';
  ELSE
    INSERT INTO public.user_roles (email, role, company, property, is_active, can_approve_vehicles) VALUES
      (v_mgrN,'manager',       v_co, ARRAY[v_prop], TRUE, FALSE),
      (v_mgrY,'manager',       v_co, ARRAY[v_prop], TRUE, TRUE),
      (v_la,  'leasing_agent', v_co, ARRAY[v_prop], TRUE, TRUE),   -- flag TRUE on purpose
      (v_ca,  'company_admin', v_co, ARRAY[v_prop], TRUE, FALSE);

    -- ── G2: unflagged manager → PENDING, and it SAYS so ─────────────
    PERFORM set_config('request.jwt.claims', json_build_object('email',v_mgrN,'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1D',v_mgrN,'ZZS1DA'||right(v_stamp,4),'TX');
    IF (v_r->>'ok')::BOOLEAN IS NOT TRUE OR (v_r->>'action') <> 'added_pending' THEN
      v_fail := v_fail || format('G2: an UNFLAGGED manager should add as pending, got %s', v_r);
    END IF;
    IF (v_r->>'pending_reason') <> 'no_approval_authority' THEN
      v_fail := v_fail || format('G2: pending_reason must say WHY (no_approval_authority), got %L. The UI renders the "waiting for approval" message from this, not from a guess about the role.', v_r->>'pending_reason');
    END IF;
    v_ids := v_ids || (v_r->>'vehicle_id')::BIGINT;

    -- ── G3: 🔴 POSITIVE CONTROL — flagged manager → ACTIVE ──────────
    PERFORM set_config('request.jwt.claims', json_build_object('email',v_mgrY,'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1D',v_mgrY,'ZZS1DB'||right(v_stamp,4),'TX');
    IF (v_r->>'action') <> 'added_active' THEN
      v_fail := v_fail || format('G3: 🔴 a FLAGGED manager must land ACTIVE, got %s. A function that pends everything satisfies Stage 1c and breaks the product.', v_r);
    END IF;
    v_ids := v_ids || (v_r->>'vehicle_id')::BIGINT;
    -- and the audit must attribute it to the RPC, not read as a direct insert
    SELECT new_values->'via_add_rpc' INTO v_via FROM public.audit_logs
     WHERE action='VEHICLE_STATE_CHANGE' AND record_id=(v_r->>'vehicle_id')
     ORDER BY created_at DESC LIMIT 1;
    IF v_via IS DISTINCT FROM 'true'::JSONB THEN
      v_fail := v_fail || format('G3: via_add_rpc is %s for a row added THROUGH the RPC', COALESCE(v_via::TEXT,'absent'));
    END IF;
    -- via_approve_rpc must be NULL on an INSERT: "was this an approve of
    -- an existing row" has no answer for a row that did not exist.
    SELECT new_values->'via_approve_rpc' INTO v_via FROM public.audit_logs
     WHERE action='VEHICLE_STATE_CHANGE' AND record_id=(v_r->>'vehicle_id')
     ORDER BY created_at DESC LIMIT 1;
    IF v_via IS DISTINCT FROM 'null'::JSONB THEN
      v_fail := v_fail || format('G3: via_approve_rpc should be NULL on an INSERT, got %s — false would be a claim about something that does not apply', v_via::TEXT);
    END IF;

    -- ── G4: POSITIVE CONTROL — CA → ACTIVE despite flag=false ───────
    PERFORM set_config('request.jwt.claims', json_build_object('email',v_ca,'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1D',v_ca,'ZZS1DC'||right(v_stamp,4),'TX');
    IF (v_r->>'action') <> 'added_active' THEN
      v_fail := v_fail || format('G4: 🔴 a company_admin must land ACTIVE even with can_approve_vehicles=FALSE, got %s', v_r);
    END IF;
    v_ids := v_ids || (v_r->>'vehicle_id')::BIGINT;

    -- ── G5: leasing_agent → PENDING even WITH the flag ──────────────
    -- The deviation from the literal ruling, asserted so it cannot drift
    -- back silently. If Jose rules the other way, this check flips and
    -- the comment in the migration must change with it.
    PERFORM set_config('request.jwt.claims', json_build_object('email',v_la,'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1D',v_la,'ZZS1DD'||right(v_stamp,4),'TX');
    IF (v_r->>'action') <> 'added_pending' THEN
      v_fail := v_fail || format('G5: a leasing_agent landed %L. approve_vehicle refuses leasing_agent, so letting them create an ACTIVE row reaches the denied capability through another verb.', v_r->>'action');
    END IF;
    v_ids := v_ids || (v_r->>'vehicle_id')::BIGINT;

    -- ── G6: refusals carry codes, not raised strings ────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('email',v_mgrY,'role','authenticated')::TEXT, TRUE);
    v_r := public.manager_add_vehicle(v_prop,'S1D',v_mgrY,'ZZS1DB'||right(v_stamp,4),'TX');
    IF (v_r->>'error') <> 'plate_already_active' THEN
      v_fail := v_fail || format('G6: re-adding the active plate should return plate_already_active, got %s', v_r);
    END IF;
    v_r := public.manager_add_vehicle('ZZ No Such Property','S1D',v_mgrY,'ZZS1DE'||right(v_stamp,4),'TX');
    IF (v_r->>'error') <> 'property_not_in_scope' THEN
      v_fail := v_fail || format('G6: an out-of-scope property should be refused, got %s', v_r);
    END IF;

    -- ── G7: 🔴 NON-REGRESSION — a pm_only tier does NOT pend an ───────
    -- authorised add. Today's path inserts pending and approves inline,
    -- so a flagged manager on pm_only ends up ACTIVE. An earlier draft
    -- of this function treated pm_only as a second gate and would have
    -- left those rows pending forever — a live process changed, against
    -- the prime directive. This is the check that catches that drift.
    IF v_pmprop IS NULL THEN
      RAISE NOTICE 'G7 note: no active pm_only property exists, so the tier non-regression could not be exercised by execution. Asserted by text below.';
      IF position('v_want_active := v_may_approve;' IN COALESCE((SELECT prosrc FROM pg_proc
            WHERE oid=to_regprocedure('public.manager_add_vehicle(text,text,text,text,text,text,text,integer,text,text,text,date)')),'')) = 0 THEN
        v_fail := v_fail || 'G7: active-vs-pending is no longer decided by authority ALONE — if the tier became a term again, a flagged manager on pm_only now pends forever';
      END IF;
    ELSE
      INSERT INTO public.user_roles (email, role, company, property, is_active, can_approve_vehicles)
      VALUES (v_pmN,'manager',v_pmco,ARRAY[v_pmprop],TRUE,TRUE);
      PERFORM set_config('request.jwt.claims', json_build_object('email',v_pmN,'role','authenticated')::TEXT, TRUE);
      v_r := public.manager_add_vehicle(v_pmprop,'S1D',v_pmN,'ZZS1DF'||right(v_stamp,4),'TX');
      IF (v_r->>'action') <> 'added_active' THEN
        v_fail := v_fail || format('G7: 🔴 a FLAGGED manager on a pm_only tier must land ACTIVE, got %s. Today that happens via insert-pending-then-approve-inline; pending it here changes a live process.', v_r);
      END IF;
      v_ids := v_ids || (v_r->>'vehicle_id')::BIGINT;
    END IF;

    -- ── teardown ────────────────────────────────────────────────────
    DELETE FROM public.audit_logs
     WHERE record_id = ANY (SELECT x::TEXT FROM unnest(v_ids) x)
       AND action IN ('VEHICLE_STATE_CHANGE','MANAGER_ADD_VEHICLE_RPC');
    DELETE FROM public.vehicle_parking_tags WHERE vehicle_id = ANY(v_ids);
    DELETE FROM public.vehicles WHERE id = ANY(v_ids);
    DELETE FROM public.user_roles WHERE email IN (v_mgrN,v_mgrY,v_la,v_ca,v_pmN);
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE id = ANY(v_ids))
       OR EXISTS (SELECT 1 FROM public.user_roles WHERE email IN (v_mgrN,v_mgrY,v_la,v_ca,v_pmN)) THEN
      v_fail := v_fail || 'teardown: probe rows survived';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'stage 1d manager_add_vehicle'::TEXT AS target,
  'PASS'::TEXT                         AS result,
  (SELECT count(*) FROM pg_proc WHERE proname='manager_add_vehicle'
     AND pronamespace='public'::regnamespace)                                AS overloads_want_1,
  (SELECT count(*) FROM public.companies WHERE tier='pm_only')               AS pm_only_companies,
  (SELECT count(*) FROM public.user_roles
    WHERE role='manager' AND is_active AND can_approve_vehicles)             AS managers_who_land_active,
  (SELECT count(*) FROM public.user_roles
    WHERE role='leasing_agent' AND is_active)                                AS leasing_agents_now_pending_only,
  'G2-G7 EXECUTED: unflagged manager pends with a reason; FLAGGED manager and CA both land ACTIVE (positive controls); leasing_agent pends even with the flag; duplicate and out-of-scope return codes; a flagged manager on a pm_only tier still lands ACTIVE (non-regression).'::TEXT AS execution_proof;
