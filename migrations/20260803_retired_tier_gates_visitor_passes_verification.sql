-- ══════════════════════════════════════════════════════════════════════
-- 20260803_retired_tier_gates_visitor_passes_verification.sql
-- POST-APPLY: assert triggers dropped, RAISE strings clean, rolling-30
-- still bites, PM driver boundary still blocks with new copy.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260803_retired_tier_gates_visitor_passes.sql.
-- Paste WHOLE.
--
-- Behavioural probes create test rows inside the transaction; the
-- outer ROLLBACK removes all probe rows. No persistent state.
--
-- Probe names use `__vq_...__08b7c__` convention to avoid collision
-- with any real data. If a prior run aborted before ROLLBACK, the
-- opening DELETE in each DO block cleans residuals.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.TRIGGER_INVENTORY ─────────────────────────────────────────────
-- Exactly ONE non-internal trigger on visitor_passes:
-- enforce_visitor_pass_limit_trigger (rolling-30, 20260729). The two
-- mis-keyed triggers are gone. If a third we didn't know about is
-- attached, this catches it before the drop lands (belt for pre-apply
-- inventory).
DO $$
DECLARE
  v_count int;
  v_names text;
BEGIN
  SELECT COUNT(*), string_agg(tgname, ', ' ORDER BY tgname)
  INTO v_count, v_names
  FROM pg_trigger
  WHERE tgrelid = 'public.visitor_passes'::regclass
    AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.TRIGGER_INVENTORY: expected 1 non-internal trigger on visitor_passes; found % (%)', v_count, v_names;
  END IF;
  IF v_names NOT ILIKE '%enforce_visitor_pass_limit%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_INVENTORY: sole trigger is not rolling-30 (%)', v_names;
  END IF;
END $$;

-- ── VQ.ROLLING_30_STILL_BITES ────────────────────────────────────────
-- The risk in this commit is not the triggers we mean to remove — it's
-- removing a third by accident and finding out the day A1 sets a
-- limit. Set a temp limit on a scratch property, insert past it,
-- assert the exception. Probe rows disappear on outer ROLLBACK.
--
-- CRITICAL — SAME plate across all three inserts. Rolling-30 counts
-- per NORMALIZED plate per property (see 20260729:94-98). Three
-- different plates each count 0 and the gate never fires — an easy
-- probe defect (which is precisely what the 2026-08-03 first-run of
-- this file did). All three inserts MUST carry the same plate.
--
-- Self-diagnosing: RAISE NOTICE prints the resolved limit + the
-- count the trigger will see at the 3rd insert. A future failure
-- distinguishes a setup issue from a gate issue instead of both
-- reading as "gate broken".
DO $$
DECLARE
  v_probe_company  TEXT := '__vq_rl30_company_08b7c__';
  v_probe_property TEXT := '__vq_rl30_property_08b7c__';
  v_probe_plate    TEXT := 'VQRL30SAME';   -- SAME plate all 3 inserts
  v_limit_resolved INT;
  v_count_before_3 INT;
  v_caught         boolean := FALSE;
BEGIN
  DELETE FROM public.visitor_passes WHERE property = v_probe_property;
  DELETE FROM public.properties     WHERE name     = v_probe_property;
  DELETE FROM public.companies      WHERE name     = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'enforcement_only', 'enforcement', 'active', TRUE);
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_property, v_probe_company, TRUE);
  UPDATE public.properties SET visitor_pass_limit = 2 WHERE name = v_probe_property;

  -- Setup-vs-gate split: assert the trigger's own lookup succeeds
  -- before drawing any conclusion about the trigger's behaviour.
  SELECT visitor_pass_limit INTO v_limit_resolved
  FROM public.properties WHERE name = v_probe_property;
  IF v_limit_resolved IS NULL THEN
    RAISE EXCEPTION 'VQ.ROLLING_30_STILL_BITES: SETUP FAILED — property lookup returned NULL limit (not a trigger defect; check properties.name exact-match, whitespace, casing)';
  END IF;

  INSERT INTO public.visitor_passes
    (plate, visitor_name, visiting_unit, property, vehicle_desc, duration_hours, created_at, expires_at, is_active)
  VALUES
    (v_probe_plate, 'VQ Probe 1', '1', v_probe_property, NULL, 2, now(), now() + interval '2 hours', TRUE);
  INSERT INTO public.visitor_passes
    (plate, visitor_name, visiting_unit, property, vehicle_desc, duration_hours, created_at, expires_at, is_active)
  VALUES
    (v_probe_plate, 'VQ Probe 2', '1', v_probe_property, NULL, 2, now(), now() + interval '2 hours', TRUE);

  -- Mirror the trigger's exact count expression for observability.
  SELECT COUNT(*) INTO v_count_before_3
  FROM public.visitor_passes
  WHERE property = v_probe_property
    AND UPPER(regexp_replace(plate,        '[^A-Z0-9]', '', 'gi'))
      = UPPER(regexp_replace(v_probe_plate, '[^A-Z0-9]', '', 'gi'))
    AND created_at > now() - interval '30 days';
  RAISE NOTICE 'VQ.ROLLING_30_STILL_BITES: limit=%, count-before-3rd-insert=%', v_limit_resolved, v_count_before_3;

  BEGIN
    INSERT INTO public.visitor_passes
      (plate, visitor_name, visiting_unit, property, vehicle_desc, duration_hours, created_at, expires_at, is_active)
    VALUES
      (v_probe_plate, 'VQ Probe 3', '1', v_probe_property, NULL, 2, now(), now() + interval '2 hours', TRUE);
  EXCEPTION WHEN check_violation THEN
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'VQ.ROLLING_30_STILL_BITES: 3rd insert did not raise check_violation (limit=%, count-before=%) — gate broken', v_limit_resolved, v_count_before_3;
  END IF;
END $$;

-- ── VQ.PM_DRIVER_BOUNDARY_MESSAGE ────────────────────────────────────
-- PM driver INSERT still blocked; new message avoids support address,
-- "tier", "proposal_code"; message contains the new boundary copy.
DO $$
DECLARE
  v_probe_company TEXT := '__vq_pm_drv_company_08b7c__';
  v_msg  text;
  v_caught boolean := FALSE;
BEGIN
  DELETE FROM public.drivers   WHERE company = v_probe_company;
  DELETE FROM public.companies WHERE name    = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'pm_only', 'property_management', 'active', TRUE);

  BEGIN
    INSERT INTO public.drivers (email, name, company, is_active)
    VALUES ('vqprobe@example.com', 'VQ Probe', v_probe_company, TRUE);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_caught := TRUE;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'VQ.PM_DRIVER_BOUNDARY_MESSAGE: PM driver insert did not raise check_violation';
  END IF;
  IF v_msg ILIKE '%support@shieldmylot%' THEN
    RAISE EXCEPTION 'VQ.PM_DRIVER_BOUNDARY_MESSAGE: message leaks support address: %', v_msg;
  END IF;
  IF v_msg ILIKE '%tier%' THEN
    RAISE EXCEPTION 'VQ.PM_DRIVER_BOUNDARY_MESSAGE: message contains "tier": %', v_msg;
  END IF;
  IF v_msg ILIKE '%proposal_code%' THEN
    RAISE EXCEPTION 'VQ.PM_DRIVER_BOUNDARY_MESSAGE: message contains "proposal_code": %', v_msg;
  END IF;
  IF v_msg NOT ILIKE '%not part of the Property Management plan%' THEN
    RAISE EXCEPTION 'VQ.PM_DRIVER_BOUNDARY_MESSAGE: expected new boundary copy; got: %', v_msg;
  END IF;
END $$;

-- ── VQ.HIGH_VOLUME_VISITOR_PASS_SUCCEEDS ─────────────────────────────
-- With visitor_pass_monthly_limit_check gone, 60 inserts succeed
-- against a property with NO rolling-30 limit set (limit=NULL → the
-- rolling-30 trigger returns early without raising).
DO $$
DECLARE
  v_probe_property TEXT := '__vq_bulk_property_08b7c__';
  v_probe_company  TEXT := '__vq_bulk_company_08b7c__';
  i INTEGER;
BEGIN
  DELETE FROM public.visitor_passes WHERE property = v_probe_property;
  DELETE FROM public.properties     WHERE name     = v_probe_property;
  DELETE FROM public.companies      WHERE name     = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'enforcement_only', 'enforcement', 'active', TRUE);
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_property, v_probe_company, TRUE);
  -- visitor_pass_limit left NULL → rolling-30 inert

  FOR i IN 1..60 LOOP
    INSERT INTO public.visitor_passes
      (plate, visitor_name, visiting_unit, property, vehicle_desc, duration_hours, created_at, expires_at, is_active)
    VALUES
      ('VQBULK' || LPAD(i::text, 3, '0'), 'VQ Bulk ' || i, '1', v_probe_property, NULL, 2, now(), now() + interval '2 hours', TRUE);
  END LOOP;
END $$;

-- ── VQ.LONG_DURATION_VISITOR_PASS_SUCCEEDS ───────────────────────────
-- With visitor_pass_duration_check gone, an insert with expires_at
-- 90 days out succeeds.
DO $$
DECLARE
  v_probe_property TEXT := '__vq_dur_property_08b7c__';
  v_probe_company  TEXT := '__vq_dur_company_08b7c__';
BEGIN
  DELETE FROM public.visitor_passes WHERE property = v_probe_property;
  DELETE FROM public.properties     WHERE name     = v_probe_property;
  DELETE FROM public.companies      WHERE name     = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'enforcement_only', 'enforcement', 'active', TRUE);
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_property, v_probe_company, TRUE);

  INSERT INTO public.visitor_passes
    (plate, visitor_name, visiting_unit, property, vehicle_desc, duration_hours, created_at, expires_at, is_active)
  VALUES
    ('VQDUR001', 'VQ Long Duration', '1', v_probe_property, NULL, 2160, now(), now() + interval '90 days', TRUE);
END $$;

-- ── VQ.SUPPORT_ADDRESS_ZERO ──────────────────────────────────────────
-- The rule-close: no function body in public schema references the
-- support address OR "Upgrade tier" copy after this migration. Proves
-- the standing-rule violation (feedback_platform_states_facts_not_
-- permissions) is closed at the SQL layer, not relocated.
DO $$
DECLARE
  v_leaks int;
  v_names text;
BEGIN
  SELECT COUNT(*), string_agg(p.oid::regprocedure::text, ', ')
  INTO v_leaks, v_names
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND (p.prosrc ILIKE '%support@shieldmylot%' OR p.prosrc ILIKE '%Upgrade tier%');
  IF v_leaks <> 0 THEN
    RAISE EXCEPTION 'VQ.SUPPORT_ADDRESS_ZERO: expected 0 support-address/Upgrade-tier leaks in public fns; found % — %', v_leaks, v_names;
  END IF;
END $$;

-- ── VQ.SIGNATURES_STABLE ─────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants only when signature is stable.
-- Confirm both reworded functions still exist with the expected
-- signature (0 args, returns trigger).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'enforce_driver_limit'
    AND p.pronargs = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURES_STABLE: expected 1 enforce_driver_limit(); found %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'enforce_property_limit'
    AND p.pronargs = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURES_STABLE: expected 1 enforce_property_limit(); found %', v_count;
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
