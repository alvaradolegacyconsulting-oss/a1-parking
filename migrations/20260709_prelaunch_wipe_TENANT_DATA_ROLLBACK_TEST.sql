-- ════════════════════════════════════════════════════════════════════
-- PRE-LAUNCH SCORCHED WIPE — ROLLBACK TEST
-- (visible-output v2 — reports via RAISE EXCEPTION on a TEXT
-- accumulator, since Supabase's SQL Editor swallows RAISE NOTICE and
-- also drops SELECT results before a ROLLBACK, and drops the temp
-- table AFTER a ROLLBACK. An error message is the one channel that
-- survives — Postgres sends it to the client as the txn aborts.)
-- 2026-07-11 (was 2026-07-09; body byte-identical, reporting changed)
--
-- PURPOSE
--   Prove the sibling migration
--     20260709_prelaunch_wipe_TENANT_DATA.sql
--   against live prod BEFORE it commits. Every DELETE runs (proving
--   FK order + the in-txn asserts fire correctly against real data),
--   then the RAISE EXCEPTION aborts the transaction → automatic
--   rollback discards everything. Zero persistent change.
--
--   Each step appends a line to v_report (TEXT). Manual asserts
--   (aegis, refuse-if-live guard, user_roles=1) SOFT-TRACK into v_ok
--   rather than hard-raising — so the operator sees the full report
--   even if one assert fails. Postgres-native errors (23503 FK
--   violations from a DELETE) still hard-abort, which is the primary
--   thing this rehearsal validates.
--
--   Body — DELETE order, predicates, FK sequence — is otherwise
--   byte-identical to the sibling COMMIT file so the rehearsal
--   validates the real thing.
--
--   Bonus safety: terminal state is a RAISE, not a ROLLBACK. Cannot
--   accidentally commit even if someone fat-fingers.
--
-- USAGE
--   Paste ENTIRE file into Supabase SQL Editor as ONE block. Run.
--
-- INTERPRETATION
--   Error pane (RED — expected, that's the delivery mechanism)
--   contains the report. Read the VERDICT line at the bottom:
--
--     "=== VERDICT: ALL ASSERTS PASSED ==="        → apply sibling
--     "=== VERDICT: *** FAIL — DO NOT WIPE *** ===" → stop
--
--   Any Postgres-native error (23503, permission_denied) instead of
--   the report → also stop; fix the sibling COMMIT file.
--
--   The RED framing is cosmetic. The exception IS the delivery,
--   not a failure signal. Read the VERDICT line, not the error style.
--
-- WHAT THIS DOES NOT TEST
--   • auth.users deletion (JS Phase C — API-side, ~240 deleteUser
--     calls, not in this SQL).
--   • Actual persistence (RAISE + rollback is the whole point).
-- ════════════════════════════════════════════════════════════════════

DO $wipe_test$
DECLARE
  v_aegis_id     UUID    := 'a767da27-b452-475a-adda-1b75ae393c59';
  v_aegis_email  TEXT;
  v_aegis_role   TEXT;
  v_before       BIGINT;
  v_after        BIGINT;
  v_n            BIGINT;
  v_ok           BOOLEAN := TRUE;
  v_step_ok      BOOLEAN;
  v_report       TEXT := E'\n═══ PRE-LAUNCH WIPE — ROLLBACK REHEARSAL ═══\n';
BEGIN
  -- ── SAFETY: aegis exists in auth.users + carries super-admin role
  --
  -- Soft-track: if aegis is missing, v_aegis_email = NULL and the
  -- downstream user_roles preserve predicate (email <> lower(NULL))
  -- evaluates NULL, so no rows are preserved. That failure surfaces
  -- as v_ok=FALSE on the user_roles assert too, giving the operator
  -- the full picture of what would happen.
  SELECT email INTO v_aegis_email
    FROM auth.users WHERE id = v_aegis_id LIMIT 1;
  IF v_aegis_email IS NOT NULL THEN
    SELECT role INTO v_aegis_role
      FROM public.user_roles
     WHERE lower(email) = lower(v_aegis_email) LIMIT 1;
  END IF;
  v_step_ok := (v_aegis_email IS NOT NULL AND v_aegis_role = 'admin');
  v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] aegis_check          : email=%s role=%s (expect admin)\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END,
                                 COALESCE(v_aegis_email, '<not found>'),
                                 COALESCE(v_aegis_role, '<null>'));

  -- ── STEP 1: Pre-wipe null-out on 5 leftover Stripe-ID stale-pointer rows
  UPDATE public.companies
     SET stripe_customer_id = NULL, stripe_subscription_id = NULL
   WHERE id IN (52, 53, 56, 58, 80);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_step_ok := (v_n = 5);
  v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] null_out             : matched %s (expect 5)\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_n);

  -- ── STEP 2: Refuse-if-live GUARD (soft-tracked)
  SELECT count(*) INTO v_n
    FROM public.companies
   WHERE stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL;
  v_step_ok := (v_n = 0);
  v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] guard_refuse_if_live : %s rows carry Stripe IDs post-null-out (expect 0)\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_n);

  -- ══════════════════════════════════════════════════════════════════
  -- STEP 3: DELETE cascade — reverse-topological. FK order is the
  -- primary thing this rehearsal validates: a real 23503 error from
  -- any DELETE will HARD-ABORT the block (that IS the fail signal).
  -- ══════════════════════════════════════════════════════════════════

  -- Phase 3a — custom stripe_prices before proposal_codes (FK RESTRICT)
  SELECT count(*) INTO v_before FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  DELETE FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  SELECT count(*) INTO v_after  FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete stripe_prices (custom) : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- Phase 3b — proposal_codes
  SELECT count(*) INTO v_before FROM public.proposal_codes;
  DELETE FROM public.proposal_codes;
  SELECT count(*) INTO v_after  FROM public.proposal_codes;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete proposal_codes         : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- Phase 3c — history
  SELECT count(*) INTO v_before FROM public.audit_logs;
  DELETE FROM public.audit_logs;
  SELECT count(*) INTO v_after  FROM public.audit_logs;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete audit_logs             : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.tos_acceptances;
  DELETE FROM public.tos_acceptances;
  SELECT count(*) INTO v_after  FROM public.tos_acceptances;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete tos_acceptances        : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.stripe_events;
  DELETE FROM public.stripe_events;
  SELECT count(*) INTO v_after  FROM public.stripe_events;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete stripe_events          : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- Phase 3d — tenant leaves (children first)
  SELECT count(*) INTO v_before FROM public.vehicle_plate_changes;
  DELETE FROM public.vehicle_plate_changes;
  SELECT count(*) INTO v_after  FROM public.vehicle_plate_changes;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete vehicle_plate_changes  : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.dispute_requests;
  DELETE FROM public.dispute_requests;                          -- MUST precede violations (NO ACTION FK)
  SELECT count(*) INTO v_after  FROM public.dispute_requests;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete dispute_requests       : %s -> %s  (before violations, NO ACTION FK)\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.violation_photos;
  DELETE FROM public.violation_photos;
  SELECT count(*) INTO v_after  FROM public.violation_photos;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete violation_photos       : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.violation_videos;
  DELETE FROM public.violation_videos;
  SELECT count(*) INTO v_after  FROM public.violation_videos;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete violation_videos       : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.violations;
  DELETE FROM public.violations;
  SELECT count(*) INTO v_after  FROM public.violations;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete violations             : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.space_residents;
  DELETE FROM public.space_residents;
  SELECT count(*) INTO v_after  FROM public.space_residents;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete space_residents        : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.space_requests;
  DELETE FROM public.space_requests;
  SELECT count(*) INTO v_after  FROM public.space_requests;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete space_requests         : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.space_assignment_history;
  DELETE FROM public.space_assignment_history;
  SELECT count(*) INTO v_after  FROM public.space_assignment_history;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete space_assignment_hist  : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.spaces;
  DELETE FROM public.spaces;
  SELECT count(*) INTO v_after  FROM public.spaces;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete spaces                 : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.guest_authorizations;
  DELETE FROM public.guest_authorizations;
  SELECT count(*) INTO v_after  FROM public.guest_authorizations;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete guest_authorizations   : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.visitor_passes;
  DELETE FROM public.visitor_passes;
  SELECT count(*) INTO v_after  FROM public.visitor_passes;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete visitor_passes         : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.vehicles;
  DELETE FROM public.vehicles;
  SELECT count(*) INTO v_after  FROM public.vehicles;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete vehicles               : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- Phase 3e — intermediate tenant tables
  SELECT count(*) INTO v_before FROM public.flag_acknowledgments;
  DELETE FROM public.flag_acknowledgments;
  SELECT count(*) INTO v_after  FROM public.flag_acknowledgments;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete flag_acknowledgments   : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.storage_facilities;
  DELETE FROM public.storage_facilities;
  SELECT count(*) INTO v_after  FROM public.storage_facilities;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete storage_facilities     : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.residents;
  DELETE FROM public.residents;
  SELECT count(*) INTO v_after  FROM public.residents;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete residents              : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.drivers;
  DELETE FROM public.drivers;
  SELECT count(*) INTO v_after  FROM public.drivers;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete drivers                : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- Phase 3f — properties + user_roles preserve + companies
  SELECT count(*) INTO v_before FROM public.properties;
  DELETE FROM public.properties;
  SELECT count(*) INTO v_after  FROM public.properties;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete properties             : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.user_roles;
  DELETE FROM public.user_roles WHERE lower(email) <> lower(v_aegis_email);
  SELECT count(*) INTO v_after  FROM public.user_roles;
  v_step_ok := (v_after = 1); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete user_roles            : %s -> %s  (expect 1 = aegis preserved)\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  SELECT count(*) INTO v_before FROM public.companies;
  DELETE FROM public.companies;
  SELECT count(*) INTO v_after  FROM public.companies;
  v_step_ok := (v_after = 0); v_ok := v_ok AND v_step_ok;
  v_report := v_report || format(E'[%s] delete companies              : %s -> %s\n',
                                 CASE WHEN v_step_ok THEN 'OK' ELSE 'FAIL' END, v_before, v_after);

  -- ── VERDICT + raise (aborts + rolls back EVERYTHING) ────────────
  v_report := v_report || E'\n═══ VERDICT: ' ||
              CASE WHEN v_ok THEN 'ALL ASSERTS PASSED' ELSE '*** FAIL — DO NOT WIPE ***' END ||
              E' ═══\n(transaction rolled back — nothing persisted)\n';

  RAISE EXCEPTION E'%', v_report;
END
$wipe_test$;

-- ════════════════════════════════════════════════════════════════════
-- POST-RUN CHECK (paste separately after the raise fires):
--   SELECT count(*) FROM public.companies;
--   -- Expected: unchanged from pre-run (e.g. 16). Confirms the RAISE
--   -- rolled back every DELETE — zero persistent change.
-- ════════════════════════════════════════════════════════════════════
