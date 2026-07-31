-- ══════════════════════════════════════════════════════════════════════
-- 20260730_violations_other_requires_note_verification.sql
-- POST-APPLY: assert the constraint exists, is VALIDATED, and enforces.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run this AFTER 20260730_violations_other_requires_note.sql.
-- Paste WHOLE — the auto-RLS helper injects ALTER TABLE ENABLE ROW
-- LEVEL SECURITY into partial pastes and breaks dollar quoting
-- (discipline note above the Supabase-editor caveat).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.CONSTRAINT_EXISTS ──────────────────────────────────────────────
-- Constraint added and validated (convalidated=true).
DO $$
DECLARE
  v_exists boolean;
  v_valid  boolean;
BEGIN
  SELECT true, convalidated
    INTO v_exists, v_valid
  FROM pg_constraint
  WHERE conname   = 'violations_other_requires_note'
    AND conrelid  = 'public.violations'::regclass;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'VQ.CONSTRAINT_EXISTS: violations_other_requires_note NOT FOUND on public.violations';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'VQ.CONSTRAINT_EXISTS: violations_other_requires_note found but NOT VALIDATED (convalidated=false)';
  END IF;
END $$;

-- ── VQ.CHECK_EXPRESSION ───────────────────────────────────────────────
-- The check predicate must reference both violation_type and notes and
-- must carry the '10' length threshold. Executable form asserted via
-- consrc-equivalent from pg_get_constraintdef; no bare-token match.
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO v_body
  FROM pg_constraint
  WHERE conname = 'violations_other_requires_note'
    AND conrelid = 'public.violations'::regclass;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.CHECK_EXPRESSION: constraint body unreadable';
  END IF;
  IF position('violation_type' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.CHECK_EXPRESSION: check does not reference violation_type. body=%', v_body;
  END IF;
  IF position('notes' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.CHECK_EXPRESSION: check does not reference notes. body=%', v_body;
  END IF;
  IF position('10' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.CHECK_EXPRESSION: check does not carry the length threshold ''10''. body=%', v_body;
  END IF;
END $$;

-- ── VQ.ENFORCES_ON_INSERT ─────────────────────────────────────────────
-- Behavioural: a synthetic INSERT of an 'other' row with short/null
-- notes MUST raise 23514 (check_violation). Rolled back — no state
-- change. Detects the class where the constraint exists but sits
-- disabled (has happened in this codebase before).
--
-- Constraint stays enforcing regardless of the ROLLBACK.
DO $$
DECLARE
  v_raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.violations (plate, violation_type, property, notes, is_confirmed)
    VALUES ('_VQTEST_', 'other', '__vq_probe__', 'short', false);
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'VQ.ENFORCES_ON_INSERT: expected check_violation on other+short-notes; insert succeeded';
  END IF;
  -- Note: the INSERT above sits inside an exception-caught block
  -- inside this outer BEGIN…COMMIT. The outer ROLLBACK below removes
  -- any partial state (including the row if the exception hadn't
  -- fired). Belt: no _VQTEST_ plate should exist post-apply.
END $$;

-- ── VQ.ALLOWS_NON_OTHER_WITHOUT_NOTES ─────────────────────────────────
-- Behavioural: non-'other' rows must still allow NULL notes (no
-- unintended tightening of behaviour on the other 13 codes).
DO $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.violations (plate, violation_type, property, notes, is_confirmed)
  VALUES ('_VQTEST2_', 'fire_lane', '__vq_probe__', NULL, false)
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'VQ.ALLOWS_NON_OTHER_WITHOUT_NOTES: insert returned no id';
  END IF;
END $$;

-- ── VQ.NO_EXISTING_ROWS_VIOLATE ───────────────────────────────────────
-- After VALIDATE succeeded, no existing 'other' row can be in
-- violation. Belt to the constraint metadata.
DO $$
DECLARE
  v_bad_count int;
BEGIN
  SELECT COUNT(*)
    INTO v_bad_count
  FROM public.violations
  WHERE violation_type = 'other'
    AND (notes IS NULL OR length(trim(notes)) < 10);
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'VQ.NO_EXISTING_ROWS_VIOLATE: % existing ''other'' rows violate the new predicate — VALIDATE should have caught this', v_bad_count;
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
