-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — deactivate_my_vehicle refuses honestly
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- Structural only. That a PENDING row is actually refused needs an
-- authenticated resident session and is proven by
--   npm run verify:residentremove
-- which now asserts it. A green run here is not a green run of the fix.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_fn   OID;
  v_src  TEXT;
BEGIN
  v_fn := to_regprocedure('public.deactivate_my_vehicle(bigint)');
  IF v_fn IS NULL THEN
    v_fail := v_fail || 'G1: deactivate_my_vehicle(bigint) is missing';
  ELSE
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_fn);

    -- G2 — the lying branch is gone
    IF v_src LIKE '%IF v_vehicle.is_active = false THEN%' THEN
      v_fail := v_fail || 'G2: the is_active=false idempotency branch is still present — a PENDING row still returns ok:true for a no-op';
    END IF;
    IF v_src NOT LIKE '%v_vehicle.status = ''deactivated''%' THEN
      v_fail := v_fail || 'G2: idempotency is not keyed on status=deactivated';
    END IF;

    -- G3 — the refusal exists, and requires BOTH halves of "active"
    IF v_src NOT LIKE '%not_active%' THEN
      v_fail := v_fail || 'G3: no not_active refusal — a non-active row is still silently accepted';
    END IF;
    IF v_src NOT LIKE '%v_vehicle.status = ''active'' AND v_vehicle.is_active = true%' THEN
      v_fail := v_fail || 'G3: the guard does not require status=active AND is_active — an orphaned plate (status active, is_active false) could be stamped by a resident';
    END IF;

    -- G4 — everything the 2026-10-06 arc established must survive
    IF v_src NOT LIKE '%lower(trim(v.resident_email))%' THEN
      v_fail := v_fail || 'G4: 🔴 the ownership predicate was LOST — roommate hole reopened';
    END IF;
    IF v_src NOT LIKE '%r.is_active = true%' THEN
      v_fail := v_fail || 'G4: 🔴 the active-residency requirement was LOST';
    END IF;
    IF v_src NOT LIKE '%account_deactivated%' THEN
      v_fail := v_fail || 'G4: the effective-active guard was lost';
    END IF;
    IF v_src NOT LIKE '%resident_removed%' THEN
      v_fail := v_fail || 'G4: no longer stamps resident_removed';
    END IF;
    IF v_src NOT LIKE '%RESIDENT_DEACTIVATE_VEHICLE%' THEN
      v_fail := v_fail || 'G4: the audit write was lost';
    END IF;

    -- G5 — shape + grants
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 'v' THEN
      v_fail := v_fail || 'G5: volatility changed';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
      v_fail := v_fail || 'G5: lost SECURITY DEFINER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                    AND array_to_string(proconfig, ',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'G5: lost the search_path pin';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G5: authenticated cannot execute it';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G5: 🔴 anon can execute it';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'deactivate_my_vehicle honest refusal'::TEXT AS target,
  'PASS'::TEXT                                 AS result,
  (SELECT prosrc LIKE '%not_active%' FROM pg_proc
     WHERE oid = to_regprocedure('public.deactivate_my_vehicle(bigint)'))            AS refuses_non_active,
  (SELECT prosrc NOT LIKE '%IF v_vehicle.is_active = false THEN%' FROM pg_proc
     WHERE oid = to_regprocedure('public.deactivate_my_vehicle(bigint)'))            AS lying_branch_removed,
  'NOT PROVEN HERE: the refusal firing. Run npm run verify:residentremove.'::TEXT    AS execution_proof;
