-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_drop_creation_trigger_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies DNT Commit A — pure removal of the creation trigger.
--
-- All queries are silent on pass. Any failure RAISEs with a named reason.
-- Run in sequence — safe to run repeatedly (all read-only).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.A — Trigger is gone from public.violations
-- ══════════════════════════════════════════════════════════════════════
DO $vq_a$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'violations'
    AND t.tgname  = 'dnt_reject_violation_insert_trigger'
    AND NOT t.tgisinternal;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VQ.A FAILED — dnt_reject_violation_insert_trigger still exists (count=%)', v_count;
  END IF;
END $vq_a$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.B — Trigger function is gone from public
-- ══════════════════════════════════════════════════════════════════════
DO $vq_b$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'dnt_reject_violation_insert';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VQ.B FAILED — public.dnt_reject_violation_insert() still exists (count=%)', v_count;
  END IF;
END $vq_b$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.C — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════════
DO $vq_c$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action    = 'SCHEMA_DNT_DROP_CREATION_TRIGGER'
    AND new_values->>'migration' = '20260723_dnt_drop_creation_trigger';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'VQ.C FAILED — SCHEMA_DNT_DROP_CREATION_TRIGGER audit row missing';
  END IF;
END $vq_c$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.D — do_not_tow_plates table survives untouched (0 rows expected)
-- ══════════════════════════════════════════════════════════════════════
-- Belt-and-suspenders: confirm we didn't accidentally drop or mutate the
-- table Commit 2 shipped. This commit is pure removal; the DNT table
-- must remain intact.
DO $vq_d$
DECLARE
  v_exists BOOLEAN;
  v_row_count INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'do_not_tow_plates'
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'VQ.D FAILED — public.do_not_tow_plates does not exist (Commit 2 table missing?)';
  END IF;

  SELECT COUNT(*) INTO v_row_count FROM public.do_not_tow_plates;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION 'VQ.D FAILED — public.do_not_tow_plates has % rows, expected 0 (safety assumption violated — rerun path analysis)', v_row_count;
  END IF;
END $vq_d$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.E — Tow-decision RPCs remain intact (guards from earlier Commit 3 preserved)
-- ══════════════════════════════════════════════════════════════════════
-- We didn't touch these functions in Commit A, but verify their DNT
-- guards from the earlier cascade migration are still present. Any
-- drift here means Commit A's DROPs cascaded somewhere they shouldn't
-- have, or another migration silently overwrote them.
DO $vq_e$
DECLARE
  v_stamp  BOOLEAN;
  v_setst  BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(oid) LIKE '%do_not_tow_plates%' INTO v_stamp
    FROM pg_proc
    WHERE proname = 'stamp_tow_ticket'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1;

  SELECT pg_get_functiondef(oid) LIKE '%do_not_tow_plates%' INTO v_setst
    FROM pg_proc
    WHERE proname = 'set_violation_status'
      AND pronamespace = 'public'::regnamespace
    LIMIT 1;

  IF v_stamp IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.E FAILED — stamp_tow_ticket lost its DNT guard (v_stamp=%)', v_stamp;
  END IF;
  IF v_setst IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.E FAILED — set_violation_status lost its DNT guard (v_setst=%)', v_setst;
  END IF;
END $vq_e$;

COMMIT;
