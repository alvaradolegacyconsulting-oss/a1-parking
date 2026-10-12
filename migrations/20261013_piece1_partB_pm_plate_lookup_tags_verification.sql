-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Piece 1 Part B, pm_plate_lookup tags + prohibited
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G5 EXECUTES BOTH ARITIES. The ruling: "enforcement must behave
-- identically when no tag is passed." That is provable only by calling
-- the 2-arg form and the 3-arg form with a NULL tag and comparing the
-- answers — which is what G5 does, on the same plate, in the same
-- transaction.
--
-- Execution needs a JWT: the function raises 'unauthenticated' without
-- one. set_config('request.jwt.claims', ...) is the impersonation
-- pattern already used by the approve_vehicle verification.
--
-- The client half is NOT provable here. Run `npm run verify:lookuptypes`
-- — it reads this migration, extracts every result_type, and proves each
-- is whitelisted, rendered and backed by PLATE_STATUS_META. That gate
-- exists because 'do_not_tow' was missing from the whitelist for months
-- with only a comment guarding it.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_src   TEXT;
  v_anchor TEXT;
  v_mgr   TEXT;
  v_prop  TEXT;
  v_plate TEXT;
  v_two   JSONB;
  v_three JSONB;
  v_tagged JSONB;
  v_n     INT;
BEGIN
  -- ── G1: exactly one overload, at the new signature ────────────────
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE proname = 'pm_plate_lookup' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    v_fail := v_fail || format(
      'G1: 🔴 %s overloads of pm_plate_lookup exist. The 2-arg form must be DROPPED, not left beside the 3-arg one — PostgREST answers PGRST203 on the ambiguous call. Present: %s',
      v_n, (SELECT string_agg('(' || pg_get_function_identity_arguments(oid) || ')', ' | ')
              FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace));
  END IF;
  IF to_regprocedure('public.pm_plate_lookup(text,text,text)') IS NULL THEN
    v_fail := v_fail || 'G1: the 3-arg signature does not exist';
  END IF;

  -- ── G2: the header facts the capture recorded ─────────────────────
  IF to_regprocedure('public.pm_plate_lookup(text,text,text)') IS NOT NULL THEN
    PERFORM 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pm_plate_lookup(text,text,text)');
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')) THEN
      v_fail := v_fail || 'G2: SECURITY DEFINER was lost';
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')) <> 'v' THEN
      v_fail := v_fail || 'G2: volatility is no longer VOLATILE';
    END IF;
    IF NOT (SELECT COALESCE(array_to_string(proconfig, ','), '') LIKE '%search_path=public, pg_temp%'
              FROM pg_proc WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')) THEN
      v_fail := v_fail || format('G2: search_path pin changed: %s',
        (SELECT COALESCE(array_to_string(proconfig,','),'(none)') FROM pg_proc
          WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')));
    END IF;
    -- Grants: exactly authenticated + service_role, never anon.
    IF has_function_privilege('anon', 'public.pm_plate_lookup(text,text,text)', 'EXECUTE') THEN
      v_fail := v_fail || 'G2: 🔴 anon can execute it';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.pm_plate_lookup(text,text,text)', 'EXECUTE') THEN
      v_fail := v_fail || 'G2: authenticated LOST execute — the manager lookup is dead';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.pm_plate_lookup(text,text,text)', 'EXECUTE') THEN
      v_fail := v_fail || 'G2: service_role lost execute (captured proacl had it)';
    END IF;
    IF (SELECT array_to_string(proacl, ',') FROM pg_proc
         WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')) ~ '(^|,)=X' THEN
      v_fail := v_fail || 'G2: 🔴 PUBLIC holds EXECUTE';
    END IF;
  END IF;

  -- ── G3: everything OUTSIDE the tag branch is unchanged ────────────
  -- Anchored on the predicates that carry the enforcement semantics.
  -- Substring matching is fine here because each anchor is a full
  -- multi-token clause, not a bare identifier — the `notes` ⊂
  -- `auth_notes` trap needs single words to bite.
  v_src := COALESCE((SELECT prosrc FROM pg_proc
                      WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)')), '');
  FOREACH v_anchor IN ARRAY ARRAY[
    'lower(trim(dnt_p.company)) = lower(trim(get_my_company()))',
    'AND (dnt.expires_at IS NULL OR dnt.expires_at > now())',
    'public.check_authorized_plate(v_normalized, p_viewing_property)',
    'AND v.status    = ''pending''',
    'ORDER BY vpc.submitted_at DESC',
    'ga.start_date <= public.current_date_central()',
    'AND vp.expires_at > now()',
    '''properties_in_scope'',  to_jsonb(v_properties)',
    'RAISE EXCEPTION ''unauthenticated'' USING ERRCODE = ''check_violation''',
    'v_role NOT IN (''manager'', ''leasing_agent'')'
  ] LOOP
    IF position(v_anchor IN v_src) = 0 THEN
      v_fail := v_fail || format('G3: 🔴 a preserved clause is MISSING from the body: %s', v_anchor);
    END IF;
  END LOOP;
  -- Branch 1 must STILL test is_active only. Ruled intentional:
  -- under-review vehicles stay protected during plate review.
  IF position('AND v.is_active = TRUE' IN v_src) = 0 THEN
    v_fail := v_fail || 'G3: branch 1 no longer tests is_active';
  END IF;
  IF v_src ~ 'v\.is_active = TRUE\s*\n\s*AND v\.status\s*=\s*''active''' THEN
    v_fail := v_fail || 'G3: 🔴 branch 1 gained a status=''active'' test. That makes the 2 under-review vehicles unauthorized, i.e. towable — the opposite of the ruling.';
  END IF;
  -- and the additions must be there
  IF position('v_result_type := ''prohibited''' IN v_src) = 0 THEN
    v_fail := v_fail || 'G3: the prohibited branch is missing';
  END IF;
  IF position('v_result_type := ''tag_voided''' IN v_src) = 0
     OR position('v_result_type := ''tag_mismatch''' IN v_src) = 0 THEN
    v_fail := v_fail || 'G3: a tag result_type is missing';
  END IF;

  -- ── G4: the tag relabel is confined to unauthorized ───────────────
  -- 🔴 The load-bearing invariant. A protective result must never be
  -- replaced because a tag was swapped: towing an authorized resident
  -- over a wrong hangtag is a false negative on enforcement.
  IF v_src !~ 'IF v_result_type = ''unauthorized'' THEN\s*\n\s*IF v_tag_status = ''voided''' THEN
    v_fail := v_fail || 'G4: 🔴 the tag relabel is not gated on result_type = ''unauthorized'' — a wrong tag could downgrade a protected plate';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- G5 — EXECUTION. Both arities, same plate, same transaction.
  -- ════════════════════════════════════════════════════════════════
  SELECT ur.email, p.name INTO v_mgr, v_prop
    FROM public.user_roles ur
    JOIN public.properties p ON lower(trim(p.name)) = ANY (
           ARRAY(SELECT lower(trim(x)) FROM unnest(ur.property) x))
   WHERE ur.role = 'manager' AND ur.is_active
     AND lower(trim(ur.company)) = 'test-legacy'
   ORDER BY ur.email LIMIT 1;

  SELECT v.plate INTO v_plate FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_prop))
     AND v.is_active AND v.status = 'active'
   ORDER BY v.id LIMIT 1;

  IF v_mgr IS NULL OR v_prop IS NULL OR v_plate IS NULL THEN
    -- Absence must not read as a pass.
    v_fail := v_fail || format(
      'G5: fixtures unresolved (manager=%s property=%s plate=%s) — the execution gate did NOT run, so nothing here proves the 2-arg and 3-arg forms agree',
      v_mgr, v_prop, v_plate);
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_mgr, 'role', 'authenticated')::TEXT, TRUE);

    -- 2-arg: the existing call shape, which must be untouched
    v_two := public.pm_plate_lookup(v_plate, v_prop);
    IF COALESCE(v_two ->> 'result_type', '') = '' THEN
      v_fail := v_fail || format('G5: 🔴 the 2-ARG call returned no result_type: %s', v_two);
    END IF;

    -- 3-arg with a NULL tag must be IDENTICAL outside the tag fields
    v_three := public.pm_plate_lookup(v_plate, v_prop, NULL);
    IF (v_two - 'tag_number' - 'tag_status') IS DISTINCT FROM (v_three - 'tag_number' - 'tag_status') THEN
      v_fail := v_fail || format(
        'G5: 🔴 passing no tag CHANGED the answer. 2-arg=%s 3-arg=%s. Enforcement must behave identically when no tag is passed.',
        v_two, v_three);
    END IF;
    IF COALESCE(v_three ->> 'tag_status', 'null') <> 'null' AND v_three ->> 'tag_status' IS NOT NULL THEN
      v_fail := v_fail || format('G5: a NULL tag produced tag_status=%s; it must be null', v_three ->> 'tag_status');
    END IF;

    -- a tag that was never issued must NOT change the plate's answer
    v_tagged := public.pm_plate_lookup(v_plate, v_prop, 'ZZ-NEVER-ISSUED-0001');
    IF (v_two - 'tag_number' - 'tag_status') IS DISTINCT FROM (v_tagged - 'tag_number' - 'tag_status') THEN
      v_fail := v_fail || format(
        'G5: 🔴 an UNKNOWN tag changed the plate result (%s -> %s). A tag corroborates; it never decides.',
        v_two ->> 'result_type', v_tagged ->> 'result_type');
    END IF;
    IF COALESCE(v_tagged ->> 'tag_status', '') <> 'unknown' THEN
      v_fail := v_fail || format('G5: an unissued tag should report tag_status=unknown, got %s', v_tagged ->> 'tag_status');
    END IF;

    -- 🔴 POSITIVE CONTROL on the normalizer: the tag is echoed back
    -- normalized, so the manager sees what was actually searched.
    IF COALESCE(v_tagged ->> 'tag_number', '') <> 'ZZNEVERISSUED0001' THEN
      v_fail := v_fail || format('G5: tag_number not normalized in the response: %s', v_tagged ->> 'tag_number');
    END IF;

    -- the function audits every call; remove this block's rows
    DELETE FROM public.audit_logs
     WHERE action = 'plate_lookup'
       AND user_email = lower(v_mgr)
       AND new_values ->> 'tag_number' = 'ZZNEVERISSUED0001';
    DELETE FROM public.audit_logs
     WHERE action = 'plate_lookup'
       AND user_email = lower(v_mgr)
       AND created_at > now() - interval '1 minute';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'piece 1 part B pm_plate_lookup'::TEXT AS target,
  'PASS'::TEXT                           AS result,
  (SELECT count(*) FROM pg_proc
    WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace)        AS overloads_want_1,
  (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
    WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text,text)'))          AS signature,
  (SELECT count(*) FROM public.property_plate_prohibitions WHERE removed_at IS NULL) AS live_prohibitions,
  (SELECT count(*) FROM public.do_not_tow_plates WHERE removed_at IS NULL)          AS live_dnt,
  (SELECT count(*) FROM public.vehicle_parking_tags WHERE voided_at IS NULL)        AS live_tags,
  'G5 EXECUTED: 2-arg and 3-arg agree outside the tag fields, an unknown tag does not change the plate answer, and the tag is echoed back normalized.'::TEXT AS execution_proof;
