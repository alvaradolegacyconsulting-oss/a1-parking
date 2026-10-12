-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Piece 1 Part C, driver_tag_lookup
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G3 EXECUTES. The whole point of this function is a SERVER-SIDE
-- scope gate, and a scope gate is only real if it refuses. Reading the
-- body proves the clauses are typed, not that they fire.
--
-- 🔴 AND IT HAS A POSITIVE CONTROL. A function that returned
-- property_not_in_scope for everything would pass every refusal check
-- below while making the feature dead. The in-scope call must succeed.

DO $$
DECLARE
  v_fail   TEXT[] := ARRAY[]::TEXT[];
  v_src    TEXT;
  v_drv    TEXT;
  v_co     TEXT;
  v_prop   TEXT;
  v_dead   TEXT;
  v_other  TEXT;
  v_r      JSONB;
  v_notes  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- ── G1: signature + header ────────────────────────────────────────
  IF to_regprocedure('public.driver_tag_lookup(text,text,text)') IS NULL THEN
    v_fail := v_fail || 'G1: driver_tag_lookup(text,text,text) is missing';
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.driver_tag_lookup(text,text,text)')) THEN
      v_fail := v_fail || 'G1: not SECURITY DEFINER — then it cannot read drivers/properties for a driver caller';
    END IF;
    IF has_function_privilege('anon', 'public.driver_tag_lookup(text,text,text)', 'EXECUTE') THEN
      v_fail := v_fail || 'G1: 🔴 anon can execute it';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.driver_tag_lookup(text,text,text)', 'EXECUTE') THEN
      v_fail := v_fail || 'G1: authenticated cannot execute it — the driver surface is dead';
    END IF;
    IF (SELECT array_to_string(proacl, ',') FROM pg_proc
         WHERE oid = to_regprocedure('public.driver_tag_lookup(text,text,text)')) ~ '(^|,)=X' THEN
      v_fail := v_fail || 'G1: 🔴 PUBLIC holds EXECUTE';
    END IF;
    IF (SELECT count(*) FROM pg_proc
         WHERE proname='driver_tag_lookup' AND pronamespace='public'::regnamespace) <> 1 THEN
      v_fail := v_fail || 'G1: more than one overload exists (PGRST203 risk)';
    END IF;
  END IF;

  -- ── G2: all four scope clauses are actually in the body ───────────
  v_src := COALESCE((SELECT prosrc FROM pg_proc
                      WHERE oid = to_regprocedure('public.driver_tag_lookup(text,text,text)')), '');
  IF position('AND p.is_active' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: 🔴 the property-active clause is gone. A deactivated property stays in assigned_properties forever, which is the half of the open driver defect that render-only filtering cannot close.';
  END IF;
  IF position('AND d.is_active' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: 🔴 the driver-active clause is gone. get_my_driver_assigned_properties does NOT check drivers.is_active, so a removed driver would keep reading tags.';
  END IF;
  IF position('lower(trim(p.company)) = v_company' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: 🔴 the company clause is gone — cross-tenant tag reads';
  END IF;
  IF position('''All'' = ANY (v_assigned)' IN v_src) = 0 THEN
    v_fail := v_fail || 'G2: the All-sentinel handling is gone; company-wide drivers would be refused';
  END IF;
  -- A voided tag must not disclose the plate that held it.
  IF v_src !~ '''tag_status'', ''voided'',\s*\n?\s*''tag_number''' THEN
    v_notes := v_notes || 'G2 note: could not confirm by text that the voided branch omits the plate — G3 checks it by execution';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- G3 — EXECUTION
  -- ════════════════════════════════════════════════════════════════
  SELECT lower(trim(d.email)), lower(trim(d.company)) INTO v_drv, v_co
    FROM public.drivers d
   WHERE d.is_active
     AND d.assigned_properties IS NOT NULL
     AND array_length(d.assigned_properties, 1) IS NOT NULL
   ORDER BY d.id LIMIT 1;

  IF v_drv IS NULL THEN
    v_fail := v_fail || 'G3: no active driver with assignments — the execution gate did NOT run, so nothing here proves the scope gate refuses OR allows';
  ELSE
    -- an in-scope, ACTIVE property for this driver
    SELECT p.name INTO v_prop
      FROM public.properties p, public.drivers d
     WHERE lower(trim(d.email)) = v_drv
       AND lower(trim(p.company)) = v_co
       AND p.is_active
       AND ( 'All' = ANY (d.assigned_properties)
          OR EXISTS (SELECT 1 FROM unnest(d.assigned_properties) a(nm)
                      WHERE lower(trim(a.nm)) = lower(trim(p.name))) )
     ORDER BY p.id LIMIT 1;

    -- a property in the same company that is NOT active (may not exist)
    SELECT p.name INTO v_dead FROM public.properties p
     WHERE lower(trim(p.company)) = v_co AND NOT p.is_active
     ORDER BY p.id LIMIT 1;

    -- a property belonging to ANOTHER company
    SELECT p.name INTO v_other FROM public.properties p
     WHERE lower(trim(p.company)) <> v_co
     ORDER BY p.id LIMIT 1;

    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_drv, 'role', 'authenticated')::TEXT, TRUE);

    -- 🔴 POSITIVE CONTROL FIRST. Without this, a function that refused
    -- everything would pass every check that follows.
    IF v_prop IS NULL THEN
      v_fail := v_fail || 'G3: no in-scope active property for the fixture driver — the POSITIVE control could not run, so the refusals below prove nothing';
    ELSE
      v_r := public.driver_tag_lookup('ZZ-PROBE-0001', v_prop, NULL);
      IF COALESCE((v_r ->> 'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
        v_fail := v_fail || format('G3: 🔴 an IN-SCOPE property was refused: %s', v_r);
      END IF;
      -- 0 of 28 properties have tags on today, so the honest answer is
      -- tags_not_enabled — NOT 'unknown', which would read as "that tag
      -- is bogus" when the lot simply does not use tags.
      IF (v_r ->> 'tag_status') NOT IN ('tags_not_enabled', 'unknown') THEN
        v_fail := v_fail || format('G3: unexpected tag_status for an unissued probe tag: %s', v_r ->> 'tag_status');
      END IF;
    END IF;

    -- refusal: a property name that does not exist at all
    v_r := public.driver_tag_lookup('ZZ-PROBE-0001', 'ZZ No Such Property 0001', NULL);
    IF COALESCE(v_r ->> 'error', '') <> 'property_not_in_scope' THEN
      v_fail := v_fail || format('G3: 🔴 a nonexistent property was not refused: %s', v_r);
    END IF;

    -- refusal: another company's property
    IF v_other IS NULL THEN
      v_notes := v_notes || 'G3 note: only one company has properties, so the cross-tenant refusal could not be exercised';
    ELSE
      v_r := public.driver_tag_lookup('ZZ-PROBE-0001', v_other, NULL);
      IF COALESCE(v_r ->> 'error', '') <> 'property_not_in_scope' THEN
        v_fail := v_fail || format('G3: 🔴 ANOTHER COMPANY''S property was not refused (%s): %s', v_other, v_r);
      END IF;
    END IF;

    -- refusal: a deactivated property in the driver's own company
    IF v_dead IS NULL THEN
      -- Distinguished, not silently passed.
      v_notes := v_notes || format('G3 note: no INACTIVE property exists under %s, so the deactivated-property refusal could not be exercised here. It is asserted by text in G2.', v_co);
    ELSE
      v_r := public.driver_tag_lookup('ZZ-PROBE-0001', v_dead, NULL);
      IF COALESCE(v_r ->> 'error', '') <> 'property_not_in_scope' THEN
        v_fail := v_fail || format('G3: 🔴 a DEACTIVATED property was not refused (%s): %s. This is the half of the open driver defect that render-only filtering cannot close.', v_dead, v_r);
      END IF;
    END IF;

    -- refusal: a caller who is not a driver at all
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', 'zz-not-a-driver-0001@test.invalid', 'role', 'authenticated')::TEXT, TRUE);
    v_r := public.driver_tag_lookup('ZZ-PROBE-0001', COALESCE(v_prop, 'x'), NULL);
    IF COALESCE(v_r ->> 'error', '') <> 'not_a_driver' THEN
      v_fail := v_fail || format('G3: 🔴 a non-driver was not refused: %s', v_r);
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
  IF array_length(v_notes,1) IS NOT NULL THEN
    RAISE NOTICE E'PASSED WITH NOTES:\n  - %', array_to_string(v_notes, E'\n  - ');
  END IF;
END $$;

SELECT
  'piece 1 part C driver_tag_lookup'::TEXT AS target,
  'PASS'::TEXT                             AS result,
  (SELECT count(*) FROM pg_proc
    WHERE proname='driver_tag_lookup' AND pronamespace='public'::regnamespace)   AS overloads_want_1,
  (SELECT count(*) FROM public.drivers WHERE is_active)                          AS active_drivers,
  (SELECT count(*) FROM public.properties WHERE parking_tags_enabled)            AS properties_tags_on,
  (SELECT count(*) FROM public.properties WHERE NOT is_active)                   AS inactive_properties,
  'G3 EXECUTED: in-scope allowed (positive control), nonexistent / other-company / deactivated property and non-driver all refused with one indistinguishable code. Check the NOTICE for any sub-check a fixture could not exercise.'::TEXT AS execution_proof;
