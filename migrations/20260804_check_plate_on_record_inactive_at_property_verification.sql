-- ══════════════════════════════════════════════════════════════════════
-- 20260804_check_plate_on_record_inactive_at_property_verification.sql
-- POST-APPLY: assert the new RPC exists, is granted, and returns the
-- correct booleans for the four vehicle states (pending, declined,
-- expired, deactivated) + the miss case.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260804_check_plate_on_record_inactive_at_property.sql.
-- Paste WHOLE.
--
-- Behavioural probes create test vehicle rows inside the transaction
-- and query the RPC; the outer ROLLBACK removes all probe rows. No
-- persistent state.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RPC_EXISTS ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'check_plate_on_record_inactive_at_property'
      AND pronamespace = 'public'::regnamespace
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: check_plate_on_record_inactive_at_property NOT FOUND';
  END IF;
END $$;

-- ── VQ.RPC_GRANTS ─────────────────────────────────────────────────────
-- anon AND authenticated must have EXECUTE (parallels
-- check_resident_plate grants — /visitor is anon-facing).
DO $$
DECLARE
  v_has_anon          boolean;
  v_has_authenticated boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.check_plate_on_record_inactive_at_property(text,text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.check_plate_on_record_inactive_at_property(text,text)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated;
  IF NOT v_has_anon THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: anon MISSING EXECUTE (parallels check_resident_plate — /visitor is anon-facing)';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: authenticated MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.EMPTY_INPUTS_RETURN_FALSE ──────────────────────────────────────
-- Match check_resident_plate's input guards — null/empty/all-punct
-- return FALSE (never TRUE by accident).
DO $$
DECLARE
  v_result boolean;
BEGIN
  SELECT public.check_plate_on_record_inactive_at_property(NULL,  '__vq_probe__') INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.EMPTY_INPUTS_RETURN_FALSE: NULL plate returned % (expected FALSE)', v_result;
  END IF;
  SELECT public.check_plate_on_record_inactive_at_property('',    '__vq_probe__') INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.EMPTY_INPUTS_RETURN_FALSE: empty plate returned % (expected FALSE)', v_result;
  END IF;
  SELECT public.check_plate_on_record_inactive_at_property('---',  '__vq_probe__') INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.EMPTY_INPUTS_RETURN_FALSE: all-punct plate returned % (expected FALSE)', v_result;
  END IF;
  SELECT public.check_plate_on_record_inactive_at_property('ABC123', NULL) INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.EMPTY_INPUTS_RETURN_FALSE: NULL property returned % (expected FALSE)', v_result;
  END IF;
END $$;

-- ── VQ.STATUS_MATRIX ──────────────────────────────────────────────────
-- Behavioural: seed one vehicle per status; RPC must return the
-- correct boolean for each. Rolled back — no persistent rows.
--
-- Uses a probe property name that shouldn't collide with real data.
-- Vehicles table INSERT bypasses RLS in this SECURITY INVOKER
-- verification context because we're running as the migration
-- superuser (Supabase editor via postgres role). If this ever runs
-- via a lower-privilege role, the seed INSERTs would need SET LOCAL
-- role or a different fixture strategy.
DO $$
DECLARE
  v_probe_property TEXT := '__vq_probe_prop_08b7c__';
  v_result boolean;
BEGIN
  -- Clean any residual probe rows (defensive if a prior run aborted
  -- outside its ROLLBACK).
  DELETE FROM public.vehicles WHERE property = v_probe_property;

  -- Seed one vehicle per relevant status
  INSERT INTO public.vehicles (plate, property, is_active, status, resident_email)
  VALUES
    ('VQPEND01',  v_probe_property, FALSE, 'pending',     'vqprobe@example.com'),
    ('VQDECL01',  v_probe_property, FALSE, 'declined',    'vqprobe@example.com'),
    ('VQEXPI01',  v_probe_property, FALSE, 'expired',     'vqprobe@example.com'),
    ('VQDEAC01',  v_probe_property, FALSE, 'deactivated', 'vqprobe@example.com'),
    ('VQACTV01',  v_probe_property, TRUE,  'active',      'vqprobe@example.com');

  -- PENDING → TRUE
  SELECT public.check_plate_on_record_inactive_at_property('VQPEND01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: pending returned % (expected TRUE)', v_result;
  END IF;

  -- DECLINED → TRUE
  SELECT public.check_plate_on_record_inactive_at_property('VQDECL01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: declined returned % (expected TRUE)', v_result;
  END IF;

  -- EXPIRED → TRUE (Mateo addition 2026-08-04)
  SELECT public.check_plate_on_record_inactive_at_property('VQEXPI01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: expired returned % (expected TRUE — Mateo lock 2026-08-04)', v_result;
  END IF;

  -- DEACTIVATED → FALSE (moved-out residents can be visitors)
  SELECT public.check_plate_on_record_inactive_at_property('VQDEAC01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: deactivated returned % (expected FALSE — moved-out residents can be visitors)', v_result;
  END IF;

  -- ACTIVE → FALSE (that's what check_resident_plate is for)
  SELECT public.check_plate_on_record_inactive_at_property('VQACTV01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: active returned % (expected FALSE — check_resident_plate handles active)', v_result;
  END IF;

  -- UNKNOWN plate → FALSE
  SELECT public.check_plate_on_record_inactive_at_property('NOSUCH99', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'VQ.STATUS_MATRIX: unknown plate returned % (expected FALSE)', v_result;
  END IF;
END $$;

-- ── VQ.NORMALIZATION_PARITY ──────────────────────────────────────────
-- Both sides normalized identically (upper + strip non-alnum).
-- Behavioural: stored as 'VQPEND01', query with 'vq-pend-01' or
-- 'vqpend01' or 'VQ Pend 01' must all resolve.
DO $$
DECLARE
  v_probe_property TEXT := '__vq_probe_prop_08b7c__';
  v_result boolean;
BEGIN
  -- lowercase input
  SELECT public.check_plate_on_record_inactive_at_property('vqpend01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.NORMALIZATION_PARITY: lowercase returned % (expected TRUE)', v_result;
  END IF;

  -- punctuated input
  SELECT public.check_plate_on_record_inactive_at_property('VQ-PEND-01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.NORMALIZATION_PARITY: punctuated returned % (expected TRUE)', v_result;
  END IF;

  -- spaced input
  SELECT public.check_plate_on_record_inactive_at_property('VQ PEND 01', v_probe_property) INTO v_result;
  IF v_result IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.NORMALIZATION_PARITY: spaced returned % (expected TRUE)', v_result;
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
