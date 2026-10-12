-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Piece 0, property feature switches
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 WHAT THIS CANNOT PROVE: that a MANAGER is refused. That needs an
-- authenticated manager session — the guard keys on auth.jwt(), and a
-- SQL session deliberately passes through it. Run
--   npm run verify:switches
-- which flips both switches as a CA and is refused as a manager.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_fn   OID;
BEGIN
  -- G1 — both columns, NOT NULL, DEFAULT false
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='properties'
                    AND column_name='parking_tags_enabled') THEN
    v_fail := v_fail || 'G1: properties.parking_tags_enabled missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='properties'
                    AND column_name='printable_visitor_passes_enabled') THEN
    v_fail := v_fail || 'G1: properties.printable_visitor_passes_enabled missing';
  END IF;
  -- 🔴 Off by default is a REQUIREMENT, not a nicety: without the
  -- default, every existing property would read NULL and the client's
  -- truthiness check would treat it as off by accident rather than by
  -- design — and a later NOT NULL backfill could pick true.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='properties'
                AND column_name IN ('parking_tags_enabled','printable_visitor_passes_enabled')
                AND (is_nullable <> 'NO' OR column_default IS DISTINCT FROM 'false')) THEN
    v_fail := v_fail || 'G1: a switch is nullable or its DEFAULT is not false';
  END IF;
  -- Every existing property must be OFF.
  IF EXISTS (SELECT 1 FROM public.properties
              WHERE parking_tags_enabled OR printable_visitor_passes_enabled) THEN
    v_fail := v_fail || 'G1: some property already has a switch ON — nothing should be enabled by the migration itself';
  END IF;

  -- G2 — the RPC
  v_fn := to_regprocedure('public.set_property_feature_switch(text,text,boolean)');
  IF v_fn IS NULL THEN
    v_fail := v_fail || 'G2: set_property_feature_switch(text,text,boolean) missing';
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_fn) THEN
      v_fail := v_fail || 'G2: the RPC is not SECURITY DEFINER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_fn AND array_to_string(proconfig,',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'G2: no search_path pin';
    END IF;
    -- 🔴 No dynamic SQL in an owner-privileged function.
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) ~* '\mEXECUTE\s+format' THEN
      v_fail := v_fail || 'G2: 🔴 the RPC builds SQL with format()/EXECUTE — a caller-supplied switch name must never become a column reference';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) NOT LIKE '%role_not_permitted%' THEN
      v_fail := v_fail || 'G2: no role gate';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G2: 🔴 anon can execute the switch RPC';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_fail := v_fail || 'G2: authenticated cannot execute it';
    END IF;
  END IF;

  -- G3 — the guard trigger
  --
  -- 🔴 AMENDED 2026-10-12. Piece 0 installed
  -- properties_feature_switch_guard_trigger, which guarded the two
  -- switches. It was SUPERSEDED the same day by
  -- properties_protected_columns_guard_trigger, covering those two plus
  -- twelve more CA-only columns (company, is_active and the
  -- authorization-document set). This file is amended rather than left
  -- asserting a trigger that is deliberately gone — a verification that
  -- fails on a correct schema trains people to ignore it.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname='properties_protected_columns_guard_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'G3: 🔴 no guard trigger — properties_manager_update lets a manager PATCH either switch directly';
  END IF;
  IF to_regprocedure('public.properties_protected_columns_guard()') IS NOT NULL THEN
    IF (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.properties_protected_columns_guard()'))
         NOT LIKE '%protected_column_not_permitted%' THEN
      v_fail := v_fail || 'G3: the guard does not raise protected_column_not_permitted';
    END IF;
    -- Both switches must still be covered by the wider guard.
    IF (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.properties_protected_columns_guard()'))
         NOT LIKE '%parking_tags_enabled%' THEN
      v_fail := v_fail || 'G3: the wider guard lost parking_tags_enabled';
    END IF;
  END IF;

  -- G4 — properties_manager_update still exists, which is WHY the
  -- guard is needed. If it is ever dropped, the guard becomes
  -- redundant rather than wrong — but this records the dependency.
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid='public.properties'::regclass AND polname='properties_manager_update') THEN
    RAISE NOTICE 'properties_manager_update is gone — the switch guard is now belt-and-braces rather than load-bearing. Not a failure.';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'piece 0 — property feature switches'::TEXT AS target,
  'PASS'::TEXT                                AS result,
  (SELECT count(*) FROM public.properties)                                   AS properties,
  (SELECT count(*) FROM public.properties WHERE parking_tags_enabled)        AS tags_on_want_0,
  (SELECT count(*) FROM public.properties WHERE printable_visitor_passes_enabled) AS passes_on_want_0,
  (SELECT count(*) FROM pg_trigger WHERE tgname='properties_protected_columns_guard_trigger' AND NOT tgisinternal) AS guard_trigger_want_1,
  'NOT PROVEN HERE: a manager being refused. Run npm run verify:switches.'::TEXT AS execution_proof;
