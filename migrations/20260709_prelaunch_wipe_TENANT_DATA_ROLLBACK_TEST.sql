-- ════════════════════════════════════════════════════════════════════
-- PRE-LAUNCH SCORCHED WIPE — ROLLBACK TEST
-- (visible-output rewrite — reports via temp table + final SELECT
-- instead of RAISE NOTICE, since Supabase SQL Editor swallows NOTICEs)
-- 2026-07-11 (was 2026-07-09; body byte-identical, reporting changed)
--
-- PURPOSE
--   Prove the sibling migration
--     20260709_prelaunch_wipe_TENANT_DATA.sql
--   against live prod BEFORE it commits. Every DELETE runs (proving
--   FK order + the in-txn asserts fire correctly against real data),
--   then ROLLBACK discards everything. Zero persistent change.
--
--   Each step INSERTs into a _wipe_report TEMP TABLE. The final
--   statement before ROLLBACK is a plain SELECT of that table so
--   Supabase's Results pane shows the before→after counts + a ✅/❌
--   marker per step. A VERDICT row aggregates every ok flag.
--
--   RAISE EXCEPTIONs on hard-fail conditions (aegis missing, guard
--   >0, user_roles ≠ 1) are PRESERVED — those should still abort
--   loudly, matching the real wipe's behavior. This edit is about
--   INFORMATIONAL reporting; asserts unchanged.
--
--   Body — DELETE order, FK sequence, in-txn asserts — is otherwise
--   byte-identical to the sibling COMMIT file so the rehearsal
--   validates the real thing.
--
-- USAGE
--   Paste ENTIRE file into Supabase SQL Editor as ONE block. Run.
--
-- INTERPRETATION
--   Results pane shows a report table. Every row's result column is
--   ✅ + the VERDICT row is ✅ → apply the sibling COMMIT file.
--
--   Any ❌ row → sibling file's asserts / order need fixing.
--   Any RAISE EXCEPTION (23503 FK or a hard-guard raise) → same;
--   caught safely by the ROLLBACK.
--
-- WHAT THIS DOES NOT TEST
--   • auth.users deletion (JS Phase C — API-side, ~240 deleteUser
--     calls, not in this SQL).
--   • Actual persistence (ROLLBACK is the whole point).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _wipe_report (
  seq       SERIAL PRIMARY KEY,
  step      TEXT   NOT NULL,     -- 'aegis_check' | 'null_out' | 'guard' | 'delete' | 'VERDICT'
  detail    TEXT   NOT NULL,     -- human-readable specifier (table name / assertion name)
  before_n  BIGINT,              -- rows before the operation (NULL for aegis/guard)
  after_n   BIGINT,              -- rows after the operation
  ok        BOOLEAN NOT NULL     -- assertion passed?
);

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

  INSERT INTO _wipe_report (step, detail, ok)
  VALUES ('aegis_check', v_aegis_email || ' role=admin', TRUE);

  -- ── STEP 1: Pre-wipe null-out on 5 leftover Stripe-ID stale-pointer rows
  SELECT count(*) INTO v_pre FROM public.companies WHERE id IN (52, 53, 56, 58, 80);
  UPDATE public.companies
     SET stripe_customer_id = NULL, stripe_subscription_id = NULL
   WHERE id IN (52, 53, 56, 58, 80);
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('null_out', 'stripe IDs on ids (52,53,56,58,80) — expect 5 matched', v_pre, v_pre, v_pre = 5);

  -- ── STEP 2: Refuse-if-live GUARD
  SELECT count(*) INTO v_stripe_count
    FROM public.companies
   WHERE stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL;
  IF v_stripe_count > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: refuse-if-live GUARD failed — % companies still carry Stripe IDs post-null-out.', v_stripe_count;
  END IF;
  INSERT INTO _wipe_report (step, detail, after_n, ok)
  VALUES ('guard', 'refuse-if-live: any Stripe-ID rows post-null-out (expect 0)', v_stripe_count, v_stripe_count = 0);

  -- ══════════════════════════════════════════════════════════════════
  -- STEP 3: DELETE cascade — reverse-topological
  -- ══════════════════════════════════════════════════════════════════

  -- Phase 3a — custom stripe_prices before proposal_codes (FK RESTRICT)
  SELECT count(*) INTO v_pre  FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  DELETE FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  SELECT count(*) INTO v_post FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'stripe_prices (custom, proposal_code_id IS NOT NULL)', v_pre, v_post, v_post = 0);

  -- Phase 3b — proposal_codes
  SELECT count(*) INTO v_pre  FROM public.proposal_codes;
  DELETE FROM public.proposal_codes;
  SELECT count(*) INTO v_post FROM public.proposal_codes;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'proposal_codes', v_pre, v_post, v_post = 0);

  -- Phase 3c — history
  SELECT count(*) INTO v_pre  FROM public.audit_logs;
  DELETE FROM public.audit_logs;
  SELECT count(*) INTO v_post FROM public.audit_logs;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'audit_logs', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.tos_acceptances;
  DELETE FROM public.tos_acceptances;
  SELECT count(*) INTO v_post FROM public.tos_acceptances;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'tos_acceptances', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.stripe_events;
  DELETE FROM public.stripe_events;
  SELECT count(*) INTO v_post FROM public.stripe_events;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'stripe_events', v_pre, v_post, v_post = 0);

  -- Phase 3d — tenant leaves (children first)
  SELECT count(*) INTO v_pre  FROM public.vehicle_plate_changes;
  DELETE FROM public.vehicle_plate_changes;
  SELECT count(*) INTO v_post FROM public.vehicle_plate_changes;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'vehicle_plate_changes', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.dispute_requests;
  DELETE FROM public.dispute_requests;                          -- MUST precede violations (NO ACTION FK)
  SELECT count(*) INTO v_post FROM public.dispute_requests;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'dispute_requests (before violations, NO ACTION FK)', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.violation_photos;
  DELETE FROM public.violation_photos;
  SELECT count(*) INTO v_post FROM public.violation_photos;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'violation_photos', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.violation_videos;
  DELETE FROM public.violation_videos;
  SELECT count(*) INTO v_post FROM public.violation_videos;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'violation_videos', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.violations;
  DELETE FROM public.violations;
  SELECT count(*) INTO v_post FROM public.violations;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'violations', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.space_residents;
  DELETE FROM public.space_residents;
  SELECT count(*) INTO v_post FROM public.space_residents;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'space_residents', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.space_requests;
  DELETE FROM public.space_requests;
  SELECT count(*) INTO v_post FROM public.space_requests;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'space_requests', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.space_assignment_history;
  DELETE FROM public.space_assignment_history;
  SELECT count(*) INTO v_post FROM public.space_assignment_history;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'space_assignment_history', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.spaces;
  DELETE FROM public.spaces;
  SELECT count(*) INTO v_post FROM public.spaces;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'spaces', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.guest_authorizations;
  DELETE FROM public.guest_authorizations;
  SELECT count(*) INTO v_post FROM public.guest_authorizations;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'guest_authorizations', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.visitor_passes;
  DELETE FROM public.visitor_passes;
  SELECT count(*) INTO v_post FROM public.visitor_passes;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'visitor_passes', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.vehicles;
  DELETE FROM public.vehicles;
  SELECT count(*) INTO v_post FROM public.vehicles;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'vehicles', v_pre, v_post, v_post = 0);

  -- Phase 3e — intermediate tenant tables
  SELECT count(*) INTO v_pre  FROM public.flag_acknowledgments;
  DELETE FROM public.flag_acknowledgments;
  SELECT count(*) INTO v_post FROM public.flag_acknowledgments;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'flag_acknowledgments', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.storage_facilities;
  DELETE FROM public.storage_facilities;
  SELECT count(*) INTO v_post FROM public.storage_facilities;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'storage_facilities', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.residents;
  DELETE FROM public.residents;
  SELECT count(*) INTO v_post FROM public.residents;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'residents', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.drivers;
  DELETE FROM public.drivers;
  SELECT count(*) INTO v_post FROM public.drivers;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'drivers', v_pre, v_post, v_post = 0);

  -- Phase 3f — properties + user_roles preserve + companies
  SELECT count(*) INTO v_pre  FROM public.properties;
  DELETE FROM public.properties;
  SELECT count(*) INTO v_post FROM public.properties;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'properties', v_pre, v_post, v_post = 0);

  SELECT count(*) INTO v_pre  FROM public.user_roles;
  DELETE FROM public.user_roles WHERE lower(email) <> lower(v_aegis_email);
  SELECT count(*) INTO v_ur_count FROM public.user_roles;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'user_roles (preserve aegis — expect 1)', v_pre, v_ur_count, v_ur_count = 1);
  IF v_ur_count <> 1 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE_TEST: post-delete user_roles count=% (expected 1).', v_ur_count;
  END IF;

  SELECT count(*) INTO v_pre  FROM public.companies;
  DELETE FROM public.companies;
  SELECT count(*) INTO v_post FROM public.companies;
  INSERT INTO _wipe_report (step, detail, before_n, after_n, ok)
  VALUES ('delete', 'companies', v_pre, v_post, v_post = 0);

END
$wipe_test$;

-- VERDICT row — aggregate every ok flag so operator has one line to check first.
-- This INSERT reads _wipe_report as it stands (all prior rows), computes
-- bool_and, then adds one new row; the SELECT can't see itself.
INSERT INTO _wipe_report (step, detail, ok)
SELECT 'VERDICT', 'all asserts passed', bool_and(ok) FROM _wipe_report;

-- ────────────────────────────────────────────────────────────────────
-- FINAL DISPLAY — this is what Supabase's Results pane shows the
-- operator. VERDICT floats to top; then step-by-step in insertion
-- order. All-✅ = green light to apply the sibling COMMIT file.
-- ────────────────────────────────────────────────────────────────────
SELECT
  seq,
  step,
  detail,
  before_n,
  after_n,
  CASE WHEN ok THEN '✅' ELSE '❌ FAIL' END AS result
FROM _wipe_report
ORDER BY
  CASE step WHEN 'VERDICT' THEN 0 ELSE 1 END,   -- VERDICT floats to top
  seq;

ROLLBACK;

-- ════════════════════════════════════════════════════════════════════
-- POST-RUN CHECK (paste separately after the ROLLBACK returns):
--   SELECT count(*) FROM public.companies;
--   -- Expected: unchanged from pre-run (e.g. 16). Confirms ROLLBACK
--   -- discarded every DELETE — zero persistent change.
-- ════════════════════════════════════════════════════════════════════
