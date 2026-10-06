-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — resident vehicle removal
-- ════════════════════════════════════════════════════════════════════
--
-- Re-runnable. No BEGIN/COMMIT: a partial apply must be visible, not
-- rolled back out of sight. Terminal SELECT returns the PASS row.
--
-- 🔴 WHAT THIS FILE DOES NOT PROVE. These are STRUCTURAL gates. They
-- show the functions exist with the right shape, grants and reason
-- list. They do NOT prove the ownership predicate refuses a roommate,
-- because that needs two authenticated resident sessions and real
-- fixtures, which a verification file has no business creating in
-- production. That proof is an execution gate and lives in
--     npm run verify:residentremove   (scripts/verify-resident-vehicle-removal.ts)
-- which creates two residents at one unit, signs in as each, and
-- asserts A cannot remove B's vehicle and can remove their own.
-- A green run HERE is not a green run of the feature. Run both.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_oid_mine  OID;
  v_oid_pm    OID;
  v_args      TEXT;
  v_src       TEXT;
BEGIN
  -- ── G1 — deactivate_my_vehicle exists with the exact signature ────
  -- to_regprocedure, not a name match: parameter TYPE MODIFIERS get
  -- stripped from catalog text, so a name-only check would pass on a
  -- function taking the wrong type.
  v_oid_mine := to_regprocedure('public.deactivate_my_vehicle(bigint)');
  IF v_oid_mine IS NULL THEN
    v_fail := v_fail || 'G1: deactivate_my_vehicle(bigint) does not exist';
  END IF;

  -- ── G2 — deactivate_vehicle signature SURVIVED the replacement ────
  v_oid_pm := to_regprocedure('public.deactivate_vehicle(bigint,text,text)');
  IF v_oid_pm IS NULL THEN
    v_fail := v_fail || 'G2: deactivate_vehicle(bigint,text,text) is GONE — the replacement changed the signature';
  END IF;

  -- ── G3 — the p_note DEFAULT survived ──────────────────────────────
  -- CREATE OR REPLACE silently DROPS parameter defaults when the new
  -- header omits them. Every existing 2-arg caller would then fail.
  IF v_oid_pm IS NOT NULL THEN
    v_args := pg_get_function_arguments(v_oid_pm);
    IF v_args NOT ILIKE '%DEFAULT NULL::text%' THEN
      v_fail := v_fail || format('G3: p_note DEFAULT was DROPPED. args now: %s', v_args);
    END IF;
  END IF;

  -- ── G4 — volatility + SECURITY DEFINER + search_path, both fns ────
  -- A header that differs can flip volatility silently.
  IF v_oid_mine IS NOT NULL THEN
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_oid_mine) <> 'v' THEN
      v_fail := v_fail || 'G4: deactivate_my_vehicle is not VOLATILE';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid_mine) THEN
      v_fail := v_fail || 'G4: deactivate_my_vehicle is not SECURITY DEFINER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid_mine
                    AND array_to_string(proconfig, ',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'G4: deactivate_my_vehicle has no search_path pin';
    END IF;
  END IF;
  IF v_oid_pm IS NOT NULL THEN
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_oid_pm) <> 'v' THEN
      v_fail := v_fail || 'G4: deactivate_vehicle volatility CHANGED (not VOLATILE)';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid_pm) THEN
      v_fail := v_fail || 'G4: deactivate_vehicle lost SECURITY DEFINER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid_pm
                    AND array_to_string(proconfig, ',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'G4: deactivate_vehicle lost its search_path pin';
    END IF;
  END IF;

  -- ── G5 — the reason list gained resident_removed ──────────────────
  -- The POINT of Part 2. Without it a manager can stamp a vehicle as
  -- resident-removed when the resident did nothing.
  IF v_oid_pm IS NOT NULL THEN
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_oid_pm);
    IF v_src NOT LIKE '%''resident_removed''%' THEN
      v_fail := v_fail || 'G5: deactivate_vehicle v_system_codes does NOT contain resident_removed';
    END IF;
    -- and the three originals must still be there
    IF v_src NOT LIKE '%cascade_resident_deactivated%'
       OR v_src NOT LIKE '%owner_trim%'
       OR v_src NOT LIKE '%admin_cascade%' THEN
      v_fail := v_fail || 'G5: a PRE-EXISTING system code was lost from v_system_codes';
    END IF;
  END IF;

  -- ── G6 — the ownership predicate is the NARROW one ────────────────
  -- Asserting the thing that distinguishes this from the cosmetic RPC.
  -- If someone "simplifies" it to the unit-scoped predicate, a roommate
  -- can delete another person's car and every structural gate above
  -- still passes.
  IF v_oid_mine IS NOT NULL THEN
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_oid_mine);
    IF v_src NOT LIKE '%lower(trim(v.resident_email))%' THEN
      v_fail := v_fail || 'G6: deactivate_my_vehicle does not scope on resident_email — roommate hole';
    END IF;
    IF v_src NOT LIKE '%r.is_active = true%' THEN
      v_fail := v_fail || 'G6: deactivate_my_vehicle does not require an ACTIVE residents row';
    END IF;
    IF v_src NOT LIKE '%account_deactivated%' THEN
      v_fail := v_fail || 'G6: deactivate_my_vehicle lost the account_deactivated guard';
    END IF;
    IF v_src NOT LIKE '%resident_removed%' THEN
      v_fail := v_fail || 'G6: deactivate_my_vehicle does not stamp resident_removed';
    END IF;
  END IF;

  -- ── G7 — grants, by EXECUTABILITY not by catalog text ─────────────
  -- information_schema privilege views under-report; has_function_
  -- privilege answers the question actually being asked.
  IF v_oid_mine IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', v_oid_mine, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: authenticated CANNOT execute deactivate_my_vehicle';
    END IF;
    IF has_function_privilege('anon', v_oid_mine, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: 🔴 anon CAN execute deactivate_my_vehicle';
    END IF;
  END IF;
  IF v_oid_pm IS NOT NULL THEN
    IF NOT has_function_privilege('authenticated', v_oid_pm, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: authenticated CANNOT execute deactivate_vehicle — the replacement broke grants';
    END IF;
    IF has_function_privilege('anon', v_oid_pm, 'EXECUTE') THEN
      v_fail := v_fail || 'G7: 🔴 anon CAN execute deactivate_vehicle';
    END IF;
  END IF;

  IF array_length(v_fail, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

-- ── Terminal PASS row ────────────────────────────────────────────────
SELECT
  'resident vehicle removal — STRUCTURAL'::TEXT AS target,
  'PASS'::TEXT                                  AS result,
  (SELECT pg_get_function_arguments(to_regprocedure('public.deactivate_vehicle(bigint,text,text)')))  AS pm_args_defaults_intact,
  (SELECT prosrc LIKE '%''resident_removed''%' FROM pg_proc
     WHERE oid = to_regprocedure('public.deactivate_vehicle(bigint,text,text)'))                      AS pm_rejects_resident_removed,
  'NOT PROVEN HERE: roommate refusal. Run npm run verify:residentremove.'::TEXT AS execution_proof;
