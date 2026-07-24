-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_ap_manage_trigger_removed_at_server_clock_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies AP-MANAGE-TRIGGER (removed_at server-side stamping).
--
-- ── Negative controls (pre-apply state) ───────────────────────────────
--   AP.TRIGGER_REMOVED_AT — expect FAIL pre-apply (line not in source yet)
--   AP.TRIGGER_SCOPE      — expect FAIL pre-apply (same; replaces the
--                            prior AP.TRIGGER_ORDERING which asserted a
--                            cosmetic formatting preference — see the
--                            block comment on that VQ)
--   AP.TRIGGER_INSERT_NULL— expect FAIL pre-apply (NEW.removed_at :=
--                            NULL line not in source yet). Presence-
--                            only assertion by design — see block
--                            comment for the failure-mode reasoning.
--   AP.TRIGGER_PRESERVED  — expect PASS pre AND post (immutability +
--                            attribution + empty-check lines preserved
--                            byte-identical from AP-SCHEMA)
--   AP.AUDIT              — expect FAIL pre; PASS post
--
-- ── Scope disclaimer ──────────────────────────────────────────────────
-- STRUCTURAL only. Behavioral proof requires the AP-MANAGE-CLIENT smoke
-- (add plate → remove → confirm removed_at is server timestamp, not
-- client). Runs alongside the three-role acceptance smoke.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- AP.TRIGGER_REMOVED_AT — source contains NEW.removed_at := now()
-- ══════════════════════════════════════════════════════════════════════
DO $ap_trigger_removed_at$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.TRIGGER_REMOVED_AT FAILED — trigger function not found';
  END IF;

  IF v_def NOT LIKE '%NEW.removed_at := now()%' THEN
    RAISE EXCEPTION 'AP.TRIGGER_REMOVED_AT FAILED — server-side removed_at stamping (NEW.removed_at := now()) not present in trigger function';
  END IF;
END $ap_trigger_removed_at$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.TRIGGER_SCOPE — removed_at stamp is INSIDE the soft-delete branch
-- ══════════════════════════════════════════════════════════════════════
-- Replaces the prior AP.TRIGGER_ORDERING (which asserted a cosmetic
-- formatting preference, not an invariant). The relative order of the
-- removed_at and removed_by assignments has no semantic effect — both
-- live in the same branch and either sequence behaves identically. What
-- is NOT cosmetic is the stamp escaping the branch: hoisted to the top
-- of the function, EVERY update would set removed_at, so editing a
-- label would silently remove the plate. The vehicle stops reading as
-- Authorized and the manager has no idea why.
--
-- Bracket the assignment between the branch opener and the branch's
-- closing RAISE. Zero-guarded on all three positions per the template's
-- Ordering-assertions rule.
--
-- Branch-opener string must match the source byte for byte (single
-- quotes around 'UPDATE' included) — same LIKE-pattern discipline as
-- other source-inspection VQs in this arc.
DO $ap_trigger_scope$
DECLARE
  v_def    TEXT;
  v_branch INTEGER;
  v_at     INTEGER;
  v_raise  INTEGER;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger function not found';
  END IF;

  v_branch := position('IF TG_OP = ''UPDATE'' AND NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL' in v_def);
  v_at     := position('NEW.removed_at := now()' in v_def);
  v_raise  := position('removed_by unresolvable' in v_def);

  IF v_branch = 0 OR v_at = 0 OR v_raise = 0 OR v_at <= v_branch OR v_at >= v_raise THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — removed_at stamp not inside the soft-delete branch (branch=% at=% raise=%)',
      v_branch, v_at, v_raise;
  END IF;
END $ap_trigger_scope$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.TRIGGER_INSERT_NULL — born-removed guard present in INSERT branch
-- ══════════════════════════════════════════════════════════════════════
-- Presence assertion only, deliberately (per Mateo 2026-07-23):
-- deletion of the NEW.removed_at := NULL line fails SILENTLY — an
-- INSERT supplying removed_at creates a row invisible in every list
-- (all queries filter removed_at IS NULL) while still holding the
-- partial unique index; re-adding that plate fails "already
-- authorized" against a row nobody can see. That's the failure mode
-- worth asserting.
-- Moving the line outside the INSERT branch fails LOUDLY — it would
-- run on UPDATE too, NULLing removed_at on every update, so
-- soft-delete stops working on the first Remove click. Self-reporting,
-- needs no assertion.
DO $ap_trigger_insert_null$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  IF v_def NOT LIKE '%NEW.removed_at := NULL%' THEN
    RAISE EXCEPTION 'AP.TRIGGER_INSERT_NULL FAILED — born-removed guard missing from INSERT branch';
  END IF;
END $ap_trigger_insert_null$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.TRIGGER_PRESERVED — untouched guards + attribution lines
-- ══════════════════════════════════════════════════════════════════════
-- Same class as B1's VQ.6 preservation check. This migration only ADDS
-- one line; all pre-existing invariants must survive. Any drift means
-- the CREATE OR REPLACE dropped something unintended.
DO $ap_trigger_preserved$
DECLARE
  v_def TEXT;
  v_missing TEXT[];
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  v_missing := ARRAY[]::TEXT[];

  IF v_def NOT LIKE '%plate is immutable%' THEN
    v_missing := v_missing || 'plate-immutability guard';
  END IF;
  IF v_def NOT LIKE '%removed rows cannot be reactivated%' THEN
    v_missing := v_missing || 'no-reactivation guard';
  END IF;
  IF v_def NOT LIKE '%UPPER(regexp_replace(COALESCE(NEW.plate,''''), ''[^A-Za-z0-9]'', '''', ''g'')%' THEN
    v_missing := v_missing || 'plate-normalize expression';
  END IF;
  IF v_def NOT LIKE '%NEW.added_by := COALESCE(auth.jwt() ->> ''email''%' THEN
    v_missing := v_missing || 'added_by server stamp';
  END IF;
  IF v_def NOT LIKE '%added_by unresolvable%' THEN
    v_missing := v_missing || 'added_by empty-check RAISE';
  END IF;
  IF v_def NOT LIKE '%removed_by unresolvable%' THEN
    v_missing := v_missing || 'removed_by empty-check RAISE';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_PRESERVED FAILED — pre-existing guards missing after CREATE OR REPLACE: %', v_missing;
  END IF;
END $ap_trigger_preserved$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.AUDIT — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════════
DO $ap_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_AP_MANAGE_TRIGGER_REMOVED_AT_SERVER_CLOCK'
    AND new_values->>'migration' = '20260723_ap_manage_trigger_removed_at_server_clock';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.AUDIT FAILED — SCHEMA_AP_MANAGE_TRIGGER_REMOVED_AT_SERVER_CLOCK row missing';
  END IF;
END $ap_audit$;

COMMIT;
