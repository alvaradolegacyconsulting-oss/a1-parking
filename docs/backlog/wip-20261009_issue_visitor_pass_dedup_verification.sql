-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — issue_visitor_pass
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- Structural + grants. That a second identical call returns the FIRST
-- pass instead of creating another is an execution property and is
-- proven by  npm run verify:visitorpass  — which calls the function
-- twice as service_role and once as a signed-in resident, and also
-- checks a resident cannot issue for someone else's unit.
-- A green run here is not a green run of the feature.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_fn   OID;
  v_old  OID;
  v_src  TEXT;
BEGIN
  v_fn := to_regprocedure('public.issue_visitor_pass(text,text,text,text,text,integer)');
  IF v_fn IS NULL THEN
    v_fail := v_fail || 'G1: issue_visitor_pass(text,text,text,text,text,integer) does not exist';
  ELSE
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_fn);

    -- G2 — liveness needs BOTH predicates
    IF v_src NOT LIKE '%vp.is_active = TRUE%' OR v_src NOT LIKE '%vp.expires_at > now()%' THEN
      v_fail := v_fail || 'G2: the existing-pass lookup does not require is_active AND expires_at > now() — 1,844 flagged-active rows are expired, so one predicate alone hands back a dead pass';
    END IF;

    -- G3 — the race is actually closed
    IF v_src NOT LIKE '%pg_advisory_xact_lock%' THEN
      v_fail := v_fail || 'G3: 🔴 no advisory lock — select-then-insert is not atomic and the double-tap race survives';
    END IF;

    -- G4 — server time, not the caller's
    IF v_src NOT LIKE '%created_at, expires_at%' THEN
      v_fail := v_fail || 'G4: unexpected INSERT column list — check created_at is still set';
    END IF;
    IF v_src LIKE '%p_created_at%' THEN
      v_fail := v_fail || 'G4: created_at is a PARAMETER — it must come from now()';
    END IF;

    -- G5 — resident scoping replaces the RLS the DEFINER bypasses
    IF v_src NOT LIKE '%not_your_unit%' THEN
      v_fail := v_fail || 'G5: 🔴 no unit scoping — an authenticated resident could issue a pass at any property/unit, which the DEFINER bypass of resident_own_passes would otherwise allow';
    END IF;
    IF v_src NOT LIKE '%service_role%' THEN
      v_fail := v_fail || 'G5: no service_role branch — the /visitor route cannot issue';
    END IF;
    IF v_src NOT LIKE '%r.is_active = TRUE%' THEN
      v_fail := v_fail || 'G5: scoping does not require an ACTIVE residents row';
    END IF;

    -- G6 — deterministic "first"
    IF v_src NOT LIKE '%ORDER BY vp.id%' THEN
      v_fail := v_fail || 'G6: the existing-pass pick is not ORDER BY id — created_at was client-supplied and cannot order reliably';
    END IF;

    -- G7 — shape
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 'v' THEN
      v_fail := v_fail || 'G7: not VOLATILE';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
      v_fail := v_fail || 'G7: not SECURITY DEFINER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                    AND array_to_string(proconfig, ',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'G7: no search_path pin';
    END IF;

    -- G8 — 🔴 THE GRANT IS A SECURITY PROPERTY, NOT HOUSEKEEPING.
    -- The unscoped service_role branch is safe only because anon cannot
    -- reach this function. If anon regains EXECUTE, the CAPTCHA that
    -- /api/visitor/create-pass enforces becomes optional.
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G8: 🔴 anon CAN execute issue_visitor_pass — the unscoped branch is now a CAPTCHA bypass';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G8: authenticated cannot execute it — the resident page is broken';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G8: service_role cannot execute it — /api/visitor/create-pass is broken';
    END IF;
  END IF;

  -- G9 — the OLD path is closed to clients
  v_old := to_regprocedure('public.create_visitor_pass(text,text,text,text,text,integer)');
  IF v_old IS NOT NULL THEN
    IF has_function_privilege('anon', v_old, 'EXECUTE') THEN
      v_fail := v_fail || 'G9: 🔴 anon can still execute create_visitor_pass — the duplicate-producing path with no dedup is still reachable, and it skips the CAPTCHA';
    END IF;
    IF has_function_privilege('authenticated', v_old, 'EXECUTE') THEN
      v_fail := v_fail || 'G9: authenticated can still execute create_visitor_pass — the un-deduped path is still reachable';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'issue_visitor_pass'::TEXT AS target,
  'PASS'::TEXT               AS result,
  has_function_privilege('anon',
    to_regprocedure('public.issue_visitor_pass(text,text,text,text,text,integer)'), 'EXECUTE')  AS anon_can_execute_must_be_false,
  has_function_privilege('anon',
    to_regprocedure('public.create_visitor_pass(text,text,text,text,text,integer)'), 'EXECUTE') AS old_anon_must_be_false,
  (SELECT count(*) FROM public.visitor_passes
     WHERE is_active AND expires_at > now())                                                    AS passes_truly_live,
  (SELECT count(*) FROM public.visitor_passes
     WHERE is_active AND expires_at <= now())                                                   AS flagged_active_but_expired,
  'NOT PROVEN HERE: dedup on a second call. Run npm run verify:visitorpass.'::TEXT               AS execution_proof;
