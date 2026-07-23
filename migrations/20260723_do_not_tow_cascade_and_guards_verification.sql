-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_do_not_tow_cascade_and_guards_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260723_do_not_tow_cascade_and_guards.sql.
-- Run AFTER the migration lands.
--
-- Pattern: DO-block assertions. Silent = pass. Behavioral probes use
-- Test-LEGACY data (company_env='test') and self-cleaning.
--
-- ── Paste discipline ───────────────────────────────────────────────────
-- 🔴 Paste the whole file — Supabase editor's auto-RLS helper can inject
-- ALTER TABLE inside partial DO-block pastes (previously observed
-- 2026-07-23 with do_not_tow_plates verification).

-- ══════════════════════════════════════════════════════════════════════
-- STAGE 1 — STRUCTURAL
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.A — pm_plate_lookup still exactly 1 overload ───────────────────
DO $vqa$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.A FAIL: pm_plate_lookup has % overloads; expected 1', v_count;
  END IF;
END $vqa$;

-- ── VQ.B — pm_plate_lookup source contains DNT branch 0 ───────────────
DO $vqb$
DECLARE v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_src NOT LIKE '%do_not_tow_plates%' THEN
    RAISE EXCEPTION 'VQ.B FAIL: pm_plate_lookup source does not reference do_not_tow_plates';
  END IF;
  IF v_src NOT LIKE '%do_not_tow%' THEN
    RAISE EXCEPTION 'VQ.B FAIL: pm_plate_lookup source does not set v_result_type = do_not_tow';
  END IF;
  IF v_src NOT LIKE '%v_dnt_reason%' THEN
    RAISE EXCEPTION 'VQ.B FAIL: pm_plate_lookup source missing v_dnt_reason variable';
  END IF;
END $vqb$;

-- ── VQ.C — set_violation_status source contains DNT guard for tow_ticket ─
DO $vqc$
DECLARE v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_violation_status';
  IF v_src NOT LIKE '%do_not_tow_plates%' THEN
    RAISE EXCEPTION 'VQ.C FAIL: set_violation_status source does not reference do_not_tow_plates';
  END IF;
  IF v_src NOT LIKE '%do_not_tow_active%' THEN
    RAISE EXCEPTION 'VQ.C FAIL: set_violation_status source does not return do_not_tow_active error';
  END IF;
END $vqc$;

-- ── VQ.D — stamp_tow_ticket source contains DNT guard ────────────────
DO $vqd$
DECLARE v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'stamp_tow_ticket';
  IF v_src NOT LIKE '%do_not_tow_plates%' THEN
    RAISE EXCEPTION 'VQ.D FAIL: stamp_tow_ticket source does not reference do_not_tow_plates';
  END IF;
END $vqd$;

-- ── VQ.E — Creation trigger + check_dnt_plate present + admin_all-ish grants ─
DO $vqe$
DECLARE v_count INT;
BEGIN
  -- Trigger + function
  SELECT COUNT(*) INTO v_count FROM pg_trigger
   WHERE tgname = 'dnt_reject_violation_insert_trigger' AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.E FAIL: dnt_reject_violation_insert_trigger not bound';
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_dnt_plate';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.E FAIL: check_dnt_plate has % overloads; expected 1', v_count;
  END IF;

  -- check_dnt_plate GRANTS: authenticated has EXECUTE, anon does not
  IF NOT has_function_privilege('authenticated', 'public.check_dnt_plate(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.E FAIL: authenticated missing EXECUTE on check_dnt_plate';
  END IF;
  IF has_function_privilege('anon', 'public.check_dnt_plate(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.E FAIL: anon has EXECUTE on check_dnt_plate (should be REVOKE)';
  END IF;
END $vqe$;

-- ══════════════════════════════════════════════════════════════════════
-- STAGE 2 — BEHAVIORAL (uses Test-LEGACY data, self-cleaning)
-- ══════════════════════════════════════════════════════════════════════
-- Setup for all Stage 2 probes: pick a Test-LEGACY property, insert
-- one DNT plate (via service_role). Track ids for cleanup. If Test-
-- LEGACY has no property, SKIP Stage 2 with a NOTICE (structural
-- assertions above still pass).

-- INSERT columns verified against real violations schema (Jose 2026-07-23
-- information_schema.columns query — NOT guessed from memory).
-- Third guess-column-from-memory failure this week (audit_logs_id_seq,
-- tos_acceptances.created_at, then violations.driver_email + timestamp)
-- is why. Read-not-remember discipline codified in
-- docs/development/migration-verification-template.md.
--
-- Real NOT NULL columns (probe must supply all): id (serial),
-- created_at, is_confirmed, was_authorized_at_time, status.
-- Also: violations has NO actor column — attribution lives in
-- audit_logs. driver_name/driver_license are the OFFENDING VEHICLE's
-- driver, not the enforcement driver. Don't populate those in a probe.
--
-- Uses TEST-LEGACY property (company_env='test').
DO $stage2$
DECLARE
  v_test_prop_id      BIGINT;
  v_test_prop_name    TEXT;
  v_dnt_id            BIGINT := NULL;
  v_fake_violation_id BIGINT := NULL;
  v_probe_plate       TEXT := 'VQE' || floor(random()*10000)::text;
  v_probe_reason      TEXT := 'VQ probe — auto-delete';
  v_stored_status     TEXT;
BEGIN
  SELECT p.id, p.name
    INTO v_test_prop_id, v_test_prop_name
    FROM public.properties p
    JOIN public.companies c ON c.name = p.company
   WHERE c.company_env = 'test'
   LIMIT 1;

  IF v_test_prop_id IS NULL THEN
    RAISE NOTICE 'Stage 2 SKIP: no test-env property to run behavioral probes against';
    RETURN;
  END IF;

  -- ── Defensive WHEN OTHERS wrapper (Mateo 2026-07-23) ──────────────
  -- Outer BEGIN...EXCEPTION so ANY unexpected error (schema drift,
  -- typo'd column, unavailable role) triggers explicit cleanup +
  -- rethrow. In principle the DO block is atomic (any exception
  -- rolls back the whole txn), but Supabase editor's DO-block
  -- handling has surprised us before — belt + suspenders. The
  -- cleanup DELETEs use v_XXX_id IS NOT NULL guards so a mid-setup
  -- failure doesn't error on the DELETEs themselves.
  BEGIN
    -- Insert DNT plate for the probe (INSIDE the WHEN OTHERS scope)
    INSERT INTO public.do_not_tow_plates (property_id, plate, reason, added_by)
    VALUES (v_test_prop_id, v_probe_plate, v_probe_reason, 'vq_verification@internal')
    RETURNING id INTO v_dnt_id;

    -- ── VQ.F — Creation trigger REJECTS violation INSERT for DNT plate ─
    -- AND the row does not exist afterward.
    -- Columns: EXACTLY the 6 NOT NULL columns per Jose's information_
    -- schema read 2026-07-23. created_at explicit (defaults not verified
    -- in the info-schema read; explicit is safer for a probe).
    BEGIN
      INSERT INTO public.violations (
        plate,
        property,
        created_at,
        is_confirmed,
        was_authorized_at_time,
        status
      ) VALUES (
        v_probe_plate,
        v_test_prop_name,
        now(),
        false,
        false,
        'new'
      );
      -- If we reach here, the trigger did NOT reject. Fail.
      RAISE EXCEPTION 'VQ.F FAIL: creation trigger did not reject violation for DNT plate %', v_probe_plate;
    EXCEPTION
      WHEN check_violation THEN
        -- Expected. Verify row does NOT exist (savepoint rolled back cleanly).
        IF EXISTS (SELECT 1 FROM public.violations WHERE plate = v_probe_plate AND property = v_test_prop_name) THEN
          RAISE EXCEPTION 'VQ.F FAIL: trigger raised but row exists — RAISE did not roll back INSERT';
        END IF;
    END;

    -- ── VQ.G/H/I/J setup — insert a fake violation for the CA-only ────
    -- RPC probes (deferred to application-level smoke; here we just
    -- prove the setup INSERT works via trigger DISABLE + ENABLE cycle).
    -- Same NOT NULL column set as VQ.F.
    ALTER TABLE public.violations DISABLE TRIGGER dnt_reject_violation_insert_trigger;
    INSERT INTO public.violations (
      plate,
      property,
      created_at,
      is_confirmed,
      was_authorized_at_time,
      status
    ) VALUES (
      v_probe_plate,
      v_test_prop_name,
      now(),
      true,
      false,
      'new'
    ) RETURNING id INTO v_fake_violation_id;
    ALTER TABLE public.violations ENABLE TRIGGER dnt_reject_violation_insert_trigger;

    -- VQ.J structural check — probe violation still has status='new'
    SELECT status INTO v_stored_status FROM public.violations WHERE id = v_fake_violation_id;
    IF v_stored_status <> 'new' THEN
      RAISE EXCEPTION 'VQ.J SETUP FAIL: probe violation status = % (expected new)', v_stored_status;
    END IF;

    -- ── VQ.G — set_violation_status REFUSAL of tow_ticket ─────────────
    -- ── VQ.H — set_violation_status ALLOWS resolved/disputed ──────────
    -- ── VQ.I — stamp_tow_ticket refusal ────────────────────────────────
    -- ── VQ.J — void_violation succeeds on DNT plate ────────────────────
    -- All FOUR of the above are CA-only RPCs. DO blocks run as the
    -- migration-applier (service_role/superuser) → get_my_role() returns
    -- NULL → role checks refuse. Can't sessionAs from inside SQL.
    -- Behavioral proofs DEFERRED to application-level smoke that
    -- sessionAs a Test-LEGACY CA and calls each RPC.

    -- ── Cleanup (happy path) ─────────────────────────────────────────
    ALTER TABLE public.violations DISABLE TRIGGER dnt_reject_violation_insert_trigger;
    DELETE FROM public.violations WHERE id = v_fake_violation_id;
    ALTER TABLE public.violations ENABLE TRIGGER dnt_reject_violation_insert_trigger;
    DELETE FROM public.do_not_tow_plates WHERE id = v_dnt_id;
    v_fake_violation_id := NULL;
    v_dnt_id := NULL;

  EXCEPTION WHEN OTHERS THEN
    -- Defensive cleanup — attempt best-effort DELETEs then rethrow.
    -- Each in its own nested BEGIN so a failure doesn't block the next.
    -- If the outer txn is aborted, these will no-op (Postgres marks
    -- aborted-txn statements as errors that we swallow with WHEN OTHERS).
    -- Either way the outer DO block still exits with error, and the
    -- top-level txn rolls back per DO-block atomicity — DNT row will
    -- NOT persist to a subsequent SELECT.
    BEGIN ALTER TABLE public.violations ENABLE TRIGGER dnt_reject_violation_insert_trigger;
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_fake_violation_id IS NOT NULL THEN
      BEGIN DELETE FROM public.violations WHERE id = v_fake_violation_id;
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    IF v_dnt_id IS NOT NULL THEN
      BEGIN DELETE FROM public.do_not_tow_plates WHERE id = v_dnt_id;
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    RAISE;  -- rethrow original error so verification fails loud
  END;

  RAISE NOTICE 'Stage 2 complete: creation trigger proven; RPC-level CA-only paths (VQ.G/H/I/J) deferred to application-level smoke';
END $stage2$;

-- ══════════════════════════════════════════════════════════════════════
-- STAGE 3 — REGRESSION (VQ.K — the half that protects A1)
-- ══════════════════════════════════════════════════════════════════════
-- Non-DNT plate cascade returns IDENTICALLY across the 3 most-hit paths:
-- resident, visitor_pass, unauthorized. Proves branch 0 wrap didn't
-- shift any existing branch's return shape.
--
-- Uses Test-LEGACY data. Doesn't insert any DNT rows — pure read-side
-- regression. If Test-LEGACY has no plates of the relevant type, that
-- specific sub-check is SKIPPED with NOTICE.

DO $vqk$
DECLARE
  v_test_prop_id       BIGINT;
  v_test_prop_name     TEXT;
  v_manager_email      TEXT;
  v_resident_plate     TEXT;
  v_resident_unit      TEXT;
  v_visitor_plate      TEXT;
  v_visitor_unit       TEXT;
  v_test_svc_result    jsonb;
BEGIN
  -- We can't sessionAs from inside a SQL DO block. Instead, structurally
  -- verify the FUNCTION SOURCE still contains the exact branch bodies
  -- for resident + visitor + unauthorized fallback.
  --
  -- Application-level smoke (post-migration) does the true behavioral
  -- regression: sessionAs a Test-LEGACY manager, call pm_plate_lookup
  -- for a known resident plate → assert result_type='resident' +
  -- unit_number = <known>. Same for a visitor pass plate. Same for a
  -- fake unregistered plate → 'unauthorized'.
  --
  -- Here: source-inspection prove branch 1 (resident) + branch 5
  -- (visitor) + branch 6 (unauthorized) STRINGS still appear in the
  -- function body. Catches transcription errors (missing branch,
  -- typo'd result_type).
  DECLARE v_src TEXT;
  BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';

    IF v_src NOT LIKE '%v_result_type := ''resident''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 1 (resident) — regression risk';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''pending''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 2 (pending)';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''plate_under_review''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 3 (plate_under_review)';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''guest_authorized''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 4 (guest_authorized)';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''visitor''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 5 (visitor)';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''unauthorized''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 6 (unauthorized)';
    END IF;
    IF v_src NOT LIKE '%v_result_type := ''do_not_tow''%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: pm_plate_lookup missing branch 0 (do_not_tow)';
    END IF;

    -- Terminal RETURN preserves all fields consumers expect
    IF v_src NOT LIKE '%''result_type'',%v_result_type%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: terminal RETURN missing result_type field';
    END IF;
    IF v_src NOT LIKE '%''unit_number'',%v_unit_number%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: terminal RETURN missing unit_number field';
    END IF;
    IF v_src NOT LIKE '%''guest_name'',%v_guest_name%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: terminal RETURN missing guest_name field';
    END IF;
    IF v_src NOT LIKE '%''valid_through'',%v_guest_end%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: terminal RETURN missing valid_through field';
    END IF;
    IF v_src NOT LIKE '%''reason'',%v_dnt_reason%' THEN
      RAISE EXCEPTION 'VQ.K FAIL: terminal RETURN missing reason field (DNT Commit 3 addition)';
    END IF;
  END;
END $vqk$;

-- ══════════════════════════════════════════════════════════════════════
-- STAGE 4 — check_dnt_plate SCOPE probe (Mateo's added security test)
-- ══════════════════════════════════════════════════════════════════════
-- Call check_dnt_plate as an out-of-scope user — must return
-- {is_dnt:false, reason:null} even when a DNT plate exists at the
-- target property. Proves the caller-scope fix works.
--
-- Same session-role limitation: DO blocks run as the migration
-- applier (service_role/superuser). Can't sessionAs from inside SQL.
-- This structural check verifies the SOURCE CONTAINS the scope
-- branches; the behavioral check is deferred to application-level
-- smoke that uses sessionAs to test each role's scope.

DO $vq_scope$
DECLARE v_src TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_dnt_plate';

  -- All 5 role branches must be present
  IF v_src NOT LIKE '%v_role = ''admin''%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate missing admin branch';
  END IF;
  IF v_src NOT LIKE '%v_role IN (''manager'', ''leasing_agent'')%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate missing manager/leasing_agent branch';
  END IF;
  IF v_src NOT LIKE '%v_role = ''driver''%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate missing driver branch';
  END IF;
  IF v_src NOT LIKE '%v_role = ''company_admin''%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate missing company_admin branch';
  END IF;

  -- CA branch MUST use lower(trim()) on BOTH company AND property name.
  -- ILIKE (~~*) on p.company would be the security bug this fix closes.
  IF v_src LIKE '%p.company ~~*%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate CA branch uses ILIKE on p.company — security fix reverted?';
  END IF;
  IF v_src NOT LIKE '%lower(trim(p.company))%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate CA branch missing lower(trim(p.company)) match';
  END IF;

  -- Fail-closed default: if role is NULL or resident, deny.
  IF v_src NOT LIKE '%v_authorized := FALSE%' THEN
    RAISE EXCEPTION 'VQ.SCOPE FAIL: check_dnt_plate missing v_authorized := FALSE default (residents / unknown roles)';
  END IF;
END $vq_scope$;

-- ══════════════════════════════════════════════════════════════════════
-- STAGE 5 — SCHEMA_ audit row
-- ══════════════════════════════════════════════════════════════════════
DO $vq_audit$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DNT_CASCADE_AND_GUARDS'
     AND user_email = 'system_migration_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.AUDIT FAIL: no SCHEMA_DNT_CASCADE_AND_GUARDS audit row found';
  END IF;
END $vq_audit$;

-- ── All green ──────────────────────────────────────────────────────────
-- Silent completion = migration applied correctly. Structural + trigger-
-- behavioral proofs done. CA-only RPC behavioral proofs (VQ.G/H/I/J
-- + scope) deferred to application-level smoke that can sessionAs a
-- Test-LEGACY CA / manager / driver.
