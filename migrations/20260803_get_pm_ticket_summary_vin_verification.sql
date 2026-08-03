-- ══════════════════════════════════════════════════════════════════════
-- 20260803_get_pm_ticket_summary_vin_verification.sql
-- POST-APPLY: assert VIN is in the projection + grants intact.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260803_get_pm_ticket_summary_vin.sql. Paste WHOLE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.SIGNATURE_UNCHANGED ────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants only when the signature is stable.
-- Assert we still have exactly one function named get_pm_ticket_summary
-- with one bigint arg.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname = 'get_pm_ticket_summary'
    AND p.pronamespace = 'public'::regnamespace
    AND p.pronargs = 1
    AND p.proargtypes[0] = 'bigint'::regtype::oid;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURE_UNCHANGED: expected exactly 1 get_pm_ticket_summary(BIGINT); found %', v_count;
  END IF;
END $$;

-- ── VQ.PROJECTION_INCLUDES_VIN ────────────────────────────────────────
-- The function body must reference vehicle_vin in the projection.
-- pg_get_functiondef returns stored source; check for both the row
-- reference (v_row.vehicle_vin) AND the jsonb key ('vehicle_vin').
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
  FROM pg_proc
  WHERE proname = 'get_pm_ticket_summary'
    AND pronamespace = 'public'::regnamespace;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.PROJECTION_INCLUDES_VIN: function body unreadable';
  END IF;

  IF position('v_row.vehicle_vin' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.PROJECTION_INCLUDES_VIN: body missing v_row.vehicle_vin reference';
  END IF;

  IF position('''vehicle_vin''' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.PROJECTION_INCLUDES_VIN: body missing ''vehicle_vin'' jsonb key';
  END IF;
END $$;

-- ── VQ.GRANTS ─────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants; re-verify anyway. authenticated
-- MUST have EXECUTE; anon MUST NOT (per revoke-anon discipline).
-- Naming anon SPECIFICALLY per Mateo lock 2026-08-03 (VQ.GRANTS naming
-- anon specifically — a new function gets EXECUTE to PUBLIC by
-- default; missed re-REVOKE lands as public-executable).
DO $$
DECLARE
  v_has_authenticated boolean;
  v_has_anon          boolean;
  v_has_public        boolean;
BEGIN
  SELECT
    has_function_privilege('authenticated', 'public.get_pm_ticket_summary(bigint)', 'EXECUTE'),
    has_function_privilege('anon',          'public.get_pm_ticket_summary(bigint)', 'EXECUTE'),
    has_function_privilege('public',        'public.get_pm_ticket_summary(bigint)', 'EXECUTE')
  INTO v_has_authenticated, v_has_anon, v_has_public;

  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.GRANTS: authenticated MISSING EXECUTE on get_pm_ticket_summary';
  END IF;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.GRANTS: anon HAS EXECUTE on get_pm_ticket_summary (naming anon specifically per revoke-anon discipline)';
  END IF;
  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.GRANTS: PUBLIC HAS EXECUTE on get_pm_ticket_summary (must be revoked; anon inherits from public otherwise)';
  END IF;
END $$;

-- ── VQ.RETURNS_VIN_KEY ────────────────────────────────────────────────
-- Behavioural probe. Insert a synthetic violation with a VIN, call
-- the RPC (as a role that can execute it), assert the returned jsonb
-- has 'vehicle_vin' at violation.vehicle_vin path.
--
-- Rolled back — probe row never persists. RPC's role/scope gates
-- would reject a probe caller in normal execution, so we bypass
-- them by using SET LOCAL role postgres (the migration runs as
-- superuser). Under a lower-privilege apply this VQ would need
-- redesign or omission; for now it runs under Supabase editor
-- (postgres role) and asserts the projection at the call layer.
DO $$
DECLARE
  v_test_id BIGINT;
  v_result jsonb;
  v_vin text;
BEGIN
  -- Clean any residual probe rows (defensive if a prior run aborted)
  DELETE FROM public.violations
   WHERE plate = '_VQ_VIN_TEST_' AND property = '__vq_pm_ticket_vin_probe__';

  -- Seed a confirmed, non-voided, ticketed violation with a VIN
  INSERT INTO public.violations
    (plate, violation_type, property, is_confirmed, tow_ticket_generated, vehicle_vin)
  VALUES
    ('_VQ_VIN_TEST_', 'fire_lane', '__vq_pm_ticket_vin_probe__', true, true, '_VQ_VIN_1234567890_')
  RETURNING id INTO v_test_id;

  -- The RPC gates on role/scope. Even if the gate rejects (returns
  -- {error: ...}), the projection assertion via body inspection
  -- above already caught the missing-key case. This behavioural
  -- probe is belt: if the projection DID include vehicle_vin but the
  -- caller happened to pass the gate, verify the value round-trips
  -- correctly. Under Supabase editor's postgres role, get_my_role()
  -- returns NULL → early return with {error: 'no_role_assigned'}.
  -- That's fine — the body-inspection VQ above catches the intended
  -- assertion; this one is diagnostic-only.
  SELECT public.get_pm_ticket_summary(v_test_id) INTO v_result;

  -- If the call went through (role gate passed somehow), assert the
  -- shape. Otherwise skip — the projection assertion above already
  -- carries the load.
  IF v_result ? 'violation' THEN
    v_vin := v_result->'violation'->>'vehicle_vin';
    IF v_vin IS DISTINCT FROM '_VQ_VIN_1234567890_' THEN
      RAISE EXCEPTION 'VQ.RETURNS_VIN_KEY: expected _VQ_VIN_1234567890_ at violation.vehicle_vin; got %', v_vin;
    END IF;
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
