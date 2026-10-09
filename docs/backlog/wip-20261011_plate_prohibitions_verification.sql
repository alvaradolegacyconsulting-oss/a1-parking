-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — plate prohibitions (parts 1, 2 and 3)
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- One file for the arc rather than three, because the parts are only
-- meaningful together: a table with no trigger blocks nothing, and a
-- trigger whose helper is not DEFINER blocks nobody who matters.
--
-- 🔴 WHAT THIS DOES NOT PROVE. That a RESIDENT is actually refused.
-- That needs a resident session, and it is THE assertion that matters:
-- plate_prohibition_at() is SECURITY DEFINER precisely because the
-- trigger runs as the inserting user and residents cannot SELECT the
-- prohibition table. A manager-only test would pass against a broken
-- build. Run  npm run verify:prohibitions  — it tests as a resident, as
-- service_role, and through the direct-insert path.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_fn   OID;
  v_probe BIGINT;
  v_prop  BIGINT;
BEGIN
  -- ── PART 1 — table, constraints, indexes, RLS ────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='property_plate_prohibitions') THEN
    v_fail := v_fail || 'P1: property_plate_prohibitions does not exist';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid='public.property_plate_prohibitions'::regclass
                      AND conname='ppp_removal_is_complete') THEN
      v_fail := v_fail || 'P1: 🔴 ppp_removal_is_complete is missing — a prohibition could be removed anonymously by a direct UPDATE';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.property_plate_prohibitions'::regclass) THEN
      v_fail := v_fail || 'P1: 🔴 RLS is NOT enabled';
    END IF;
    -- Soft delete only: the absence of a DELETE policy IS the guard.
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.property_plate_prohibitions'::regclass AND polcmd='d') THEN
      v_fail := v_fail || 'P1: 🔴 a DELETE policy exists — history can be destroyed';
    END IF;
    IF has_table_privilege('anon','public.property_plate_prohibitions','SELECT') THEN
      v_fail := v_fail || 'P1: 🔴 anon can read prohibitions (reasons are manager-only)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                    AND indexname='idx_ppp_property_plate_active') THEN
      v_fail := v_fail || 'P1: the active-unique index is missing (remove + re-add would collide)';
    END IF;

    -- EXECUTION: the removal CHECK must FIRE, not merely exist.
    SELECT id INTO v_prop FROM public.properties LIMIT 1;
    IF v_prop IS NOT NULL THEN
      BEGIN
        INSERT INTO public.property_plate_prohibitions
          (property_id, plate, reason, added_by, removed_at, removed_by)
        VALUES (v_prop, 'ZZVERIFYPROBE', 'verification probe', 'verification',
                now(), 'verification')
        RETURNING id INTO v_probe;
        DELETE FROM public.property_plate_prohibitions WHERE id = v_probe;
        v_fail := v_fail || 'P1: 🔴 a removal with NO reason was ACCEPTED — ppp_removal_is_complete does not fire';
      EXCEPTION
        WHEN check_violation THEN NULL;  -- correct
        WHEN OTHERS THEN
          v_fail := v_fail || format('P1: probe refused by something OTHER than the CHECK (%s: %s) — the CHECK is UNPROVEN', SQLSTATE, SQLERRM);
      END;
    END IF;
  END IF;

  -- ── PART 2 — the helper and the three triggers ───────────────────
  v_fn := to_regprocedure('public.plate_prohibition_at(text,text)');
  IF v_fn IS NULL THEN
    v_fail := v_fail || 'P2: plate_prohibition_at(text,text) is missing';
  ELSE
    -- 🔴 THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE.
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_fn) THEN
      v_fail := v_fail || 'P2: 🔴🔴 plate_prohibition_at is NOT SECURITY DEFINER — the triggers run as the inserting user and residents cannot SELECT the table, so the feature is SILENTLY INERT for residents and visitors while still working for managers';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_fn AND array_to_string(proconfig,',') ILIKE '%search_path%') THEN
      v_fail := v_fail || 'P2: plate_prohibition_at has no search_path pin';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) NOT LIKE '%expires_at IS NULL OR%' THEN
      v_fail := v_fail || 'P2: the helper does not apply the expiry half — a lapsed prohibition would keep blocking';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='vehicles_plate_prohibition_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'P2: 🔴 no trigger on vehicles — resident registration, manager adds and the bulk import are all unguarded';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='visitor_passes_plate_prohibition_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'P2: 🔴 no trigger on visitor_passes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='guest_auth_plate_prohibition_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'P2: 🔴 no trigger on guest_authorizations';
  END IF;

  -- The triggers must cover UPDATE too, or approve_vehicle sails past.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='vehicles_plate_prohibition_trigger'
              AND (tgtype & 16) = 0) THEN
    v_fail := v_fail || 'P2: 🔴 the vehicles trigger does not fire on UPDATE — a plate prohibited AFTER submission would still be approvable';
  END IF;

  -- ── PART 3 — RPCs and the reason code ────────────────────────────
  -- Named individually so a failure says WHICH one, rather than "one of
  -- the five". to_regprocedure, not a name match: parameter type
  -- modifiers are stripped from catalog text.
  IF to_regprocedure('public.preview_plate_prohibition_impact(text,text)') IS NULL THEN
    v_fail := v_fail || 'P3: preview_plate_prohibition_impact(text,text) missing — the confirm dialog has no counts';
  END IF;
  IF to_regprocedure('public.add_plate_prohibition(text,text,text,text,timestamptz)') IS NULL THEN
    v_fail := v_fail || 'P3: add_plate_prohibition(text,text,text,text,timestamptz) missing';
  END IF;
  IF to_regprocedure('public.remove_plate_prohibition(bigint,text,text)') IS NULL THEN
    v_fail := v_fail || 'P3: remove_plate_prohibition(bigint,text,text) missing';
  END IF;
  IF to_regprocedure('public.prohibition_impact_rows(text,text)') IS NULL THEN
    v_fail := v_fail || 'P3: prohibition_impact_rows(text,text) missing — preview and executor would need separate queries, which is how they drift';
  END IF;
  IF to_regprocedure('public.may_manage_prohibitions_at(text)') IS NULL THEN
    v_fail := v_fail || 'P3: may_manage_prohibitions_at(text) missing';
  END IF;

  v_fn := to_regprocedure('public.deactivate_vehicle(bigint,text,text)');
  IF v_fn IS NULL THEN
    v_fail := v_fail || 'P3: deactivate_vehicle signature changed';
  ELSE
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) NOT LIKE '%''plate_prohibited''%' THEN
      v_fail := v_fail || 'P3: 🔴 plate_prohibited is NOT in v_system_codes — a manager could stamp it by hand and claim a prohibition that does not exist';
    END IF;
    -- Regression guards on the three earlier replacements of this fn.
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) NOT LIKE '%''resident_removed''%' THEN
      v_fail := v_fail || 'P3: 🔴 resident_removed was LOST from v_system_codes';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid=v_fn) NOT LIKE '%NOT IN (''active'', ''pending'', ''under_review'')%' THEN
      v_fail := v_fail || 'P3: 🔴 the status allowlist was LOST — a declined row can be overwritten again';
    END IF;
    IF pg_get_function_arguments(v_fn) NOT ILIKE '%DEFAULT NULL%' THEN
      v_fail := v_fail || 'P3: deactivate_vehicle p_note DEFAULT dropped';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'plate prohibitions (parts 1-3)'::TEXT AS target,
  'PASS'::TEXT                           AS result,
  (SELECT prosecdef FROM pg_proc
     WHERE oid = to_regprocedure('public.plate_prohibition_at(text,text)'))  AS helper_is_definer_must_be_true,
  (SELECT count(*) FROM pg_trigger
     WHERE tgname LIKE '%plate_prohibition_trigger' AND NOT tgisinternal)    AS triggers_installed_want_3,
  (SELECT count(*) FROM public.property_plate_prohibitions
     WHERE removed_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active_prohibitions,
  (SELECT count(*) FROM public.property_plate_prohibitions)                   AS total_including_history,
  'NOT PROVEN HERE: a RESIDENT being refused. Run npm run verify:prohibitions.'::TEXT AS execution_proof;
