-- ════════════════════════════════════════════════════════════════════
-- PRE-LAUNCH SCORCHED WIPE — ROLLBACK TEST (byte-identical body,
-- final COMMIT replaced with ROLLBACK, RAISE NOTICE counts added)
-- 2026-07-09
--
-- PURPOSE
--   Prove the sibling migration
--     20260709_prelaunch_wipe_TENANT_DATA.sql
--   against live prod BEFORE it commits. Every DELETE runs (proving
--   FK order + the in-txn asserts fire correctly against real data),
--   then ROLLBACK discards everything. Zero persistent change.
--
--   Also: NOTICE lines after each delete report the transient
--   row-count change, so SQL Editor's messages pane confirms the
--   sequence executed correctly.
--
-- USAGE
--   Paste ENTIRE file into Supabase SQL Editor as ONE block. Run.
--
-- INTERPRETATION
--   CLEAN FINISH (no 23503, NOTICE counts all reach 0, aegis-role
--     assertion passes, refuse-if-live guard passes, user_roles=1
--     assertion passes) → FK order + in-txn asserts proven → apply
--     the sibling COMMIT file with confidence.
--
--   ANY FK ERROR (23503 foreign_key_violation) → caught safely by
--     the ROLLBACK → fix delete order in BOTH files, re-run this
--     test.
--
--   ANY OTHER ERROR (raise from aegis-role / guard / user_roles
--     assertions) → also caught safely; investigate the root cause.
--
-- WHAT THIS DOES NOT TEST
--   • auth.users deletion (JS Phase C — API-side, 240 deleteUser
--     calls, not in this SQL). Snapshot covers it during the real
--     apply.
--   • Actual persistence of the wipe (ROLLBACK is the whole point).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DO $wipe_test$
DECLARE
  v_aegis_id     UUID    := 'a767da27-b452-475a-adda-1b75ae393c59';
  v_aegis_email  TEXT;
  v_aegis_role   TEXT;
  v_stripe_count INT;
  v_ur_count     INT;
  v_pre          INT;
  v_post         INT;
BEGIN
  -- ── SAFETY: aegis exists in auth.users + carries super-admin role
  SELECT email INTO v_aegis_email
    FROM auth.users WHERE id = v_aegis_id LIMIT 1;
  IF v_aegis_email IS NULL THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: aegis (%) not in auth.users — refuse', v_aegis_id;
  END IF;

  SELECT role INTO v_aegis_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_aegis_email) LIMIT 1;
  IF v_aegis_role IS NULL OR v_aegis_role <> 'admin' THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: aegis user_roles.role=% (expected admin) — refuse', v_aegis_role;
  END IF;

  RAISE NOTICE 'PRELAUNCH_WIPE_TEST: aegis (%) confirmed as super-admin', v_aegis_email;

  -- ── STEP 1: Pre-wipe null-out on 5 leftover Stripe-ID stale-pointer rows
  SELECT count(*) INTO v_pre FROM public.companies WHERE id IN (52, 53, 56, 58, 80);
  UPDATE public.companies
     SET stripe_customer_id = NULL, stripe_subscription_id = NULL
   WHERE id IN (52, 53, 56, 58, 80);
  RAISE NOTICE 'PRELAUNCH_WIPE_TEST: null-out complete on % rows', v_pre;

  -- ── STEP 2: Refuse-if-live GUARD
  SELECT count(*) INTO v_stripe_count
    FROM public.companies
   WHERE stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL;
  IF v_stripe_count > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: refuse-if-live GUARD failed — % companies still carry Stripe IDs post-null-out. Would ROLLBACK.', v_stripe_count;
  END IF;
  RAISE NOTICE 'PRELAUNCH_WIPE_TEST: refuse-if-live guard passed (0 Stripe-ID rows)';

  -- ══════════════════════════════════════════════════════════════════
  -- STEP 3: DELETE cascade — reverse-topological
  -- Each DELETE prints (before → after) via NOTICE for legibility.
  -- ══════════════════════════════════════════════════════════════════

  -- Phase 3a — custom stripe_prices before proposal_codes (FK RESTRICT)
  SELECT count(*) INTO v_pre  FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  DELETE FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  SELECT count(*) INTO v_post FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  RAISE NOTICE '  stripe_prices (custom): % → %', v_pre, v_post;

  -- Phase 3b — proposal_codes
  SELECT count(*) INTO v_pre  FROM public.proposal_codes;
  DELETE FROM public.proposal_codes;
  SELECT count(*) INTO v_post FROM public.proposal_codes;
  RAISE NOTICE '  proposal_codes:         % → %', v_pre, v_post;

  -- Phase 3c — history
  SELECT count(*) INTO v_pre  FROM public.audit_logs;
  DELETE FROM public.audit_logs;
  SELECT count(*) INTO v_post FROM public.audit_logs;
  RAISE NOTICE '  audit_logs:             % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.tos_acceptances;
  DELETE FROM public.tos_acceptances;
  SELECT count(*) INTO v_post FROM public.tos_acceptances;
  RAISE NOTICE '  tos_acceptances:        % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.stripe_events;
  DELETE FROM public.stripe_events;
  SELECT count(*) INTO v_post FROM public.stripe_events;
  RAISE NOTICE '  stripe_events:          % → %', v_pre, v_post;

  -- Phase 3d — tenant leaves (children first)
  SELECT count(*) INTO v_pre  FROM public.vehicle_plate_changes;
  DELETE FROM public.vehicle_plate_changes;
  SELECT count(*) INTO v_post FROM public.vehicle_plate_changes;
  RAISE NOTICE '  vehicle_plate_changes:  % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.dispute_requests;
  DELETE FROM public.dispute_requests;                          -- MUST precede violations (NO ACTION FK)
  SELECT count(*) INTO v_post FROM public.dispute_requests;
  RAISE NOTICE '  dispute_requests:       % → %  (before violations — NO ACTION FK honored)', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.violation_photos;
  DELETE FROM public.violation_photos;
  SELECT count(*) INTO v_post FROM public.violation_photos;
  RAISE NOTICE '  violation_photos:       % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.violation_videos;
  DELETE FROM public.violation_videos;
  SELECT count(*) INTO v_post FROM public.violation_videos;
  RAISE NOTICE '  violation_videos:       % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.violations;
  DELETE FROM public.violations;
  SELECT count(*) INTO v_post FROM public.violations;
  RAISE NOTICE '  violations:             % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.space_residents;
  DELETE FROM public.space_residents;
  SELECT count(*) INTO v_post FROM public.space_residents;
  RAISE NOTICE '  space_residents:        % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.space_requests;
  DELETE FROM public.space_requests;
  SELECT count(*) INTO v_post FROM public.space_requests;
  RAISE NOTICE '  space_requests:         % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.space_assignment_history;
  DELETE FROM public.space_assignment_history;
  SELECT count(*) INTO v_post FROM public.space_assignment_history;
  RAISE NOTICE '  space_assignment_history: % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.spaces;
  DELETE FROM public.spaces;
  SELECT count(*) INTO v_post FROM public.spaces;
  RAISE NOTICE '  spaces:                 % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.guest_authorizations;
  DELETE FROM public.guest_authorizations;
  SELECT count(*) INTO v_post FROM public.guest_authorizations;
  RAISE NOTICE '  guest_authorizations:   % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.visitor_passes;
  DELETE FROM public.visitor_passes;
  SELECT count(*) INTO v_post FROM public.visitor_passes;
  RAISE NOTICE '  visitor_passes:         % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.vehicles;
  DELETE FROM public.vehicles;
  SELECT count(*) INTO v_post FROM public.vehicles;
  RAISE NOTICE '  vehicles:               % → %', v_pre, v_post;

  -- Phase 3e — intermediate tenant tables
  SELECT count(*) INTO v_pre  FROM public.flag_acknowledgments;
  DELETE FROM public.flag_acknowledgments;
  SELECT count(*) INTO v_post FROM public.flag_acknowledgments;
  RAISE NOTICE '  flag_acknowledgments:   % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.storage_facilities;
  DELETE FROM public.storage_facilities;
  SELECT count(*) INTO v_post FROM public.storage_facilities;
  RAISE NOTICE '  storage_facilities:     % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.residents;
  DELETE FROM public.residents;
  SELECT count(*) INTO v_post FROM public.residents;
  RAISE NOTICE '  residents:              % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.drivers;
  DELETE FROM public.drivers;
  SELECT count(*) INTO v_post FROM public.drivers;
  RAISE NOTICE '  drivers:                % → %', v_pre, v_post;

  -- Phase 3f — properties + user_roles preserve + companies
  SELECT count(*) INTO v_pre  FROM public.properties;
  DELETE FROM public.properties;
  SELECT count(*) INTO v_post FROM public.properties;
  RAISE NOTICE '  properties:             % → %', v_pre, v_post;

  SELECT count(*) INTO v_pre  FROM public.user_roles;
  DELETE FROM public.user_roles WHERE lower(email) <> lower(v_aegis_email);
  SELECT count(*) INTO v_ur_count FROM public.user_roles;
  RAISE NOTICE '  user_roles:             % → %  (preserving aegis)', v_pre, v_ur_count;
  IF v_ur_count <> 1 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: post-delete user_roles count=% (expected 1). Would ROLLBACK.', v_ur_count;
  END IF;

  SELECT count(*) INTO v_pre  FROM public.companies;
  DELETE FROM public.companies;
  SELECT count(*) INTO v_post FROM public.companies;
  RAISE NOTICE '  companies:              % → %', v_pre, v_post;

  RAISE NOTICE 'PRELAUNCH_WIPE_TEST: STEP 3 complete — all tenant data deletes exercised';
  RAISE NOTICE 'PRELAUNCH_WIPE_TEST: ROLLBACK about to fire — no persistent change';

END
$wipe_test$;

-- Every DELETE above ran without FK error and every assertion passed.
-- ROLLBACK discards everything — zero persistent change.
ROLLBACK;
