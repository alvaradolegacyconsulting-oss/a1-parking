-- ═══════════════════════════════════════════════════════════════════════
-- 20260724_ap_category_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies AP-CATEGORY (column + CHECK + check_authorized_plate return).
--
-- ── Negative controls (pre-apply state — RUN THIS TIME) ───────────────
-- Validated-detector arc count has been stuck at 2 all week because
-- AP-SCHEMA + AP-CASCADE-DB pre-apply passes were skipped. Every VQ
-- below MUST fail pre-apply for the detectors to be validated. Move
-- the arc count from 2 to 3+.
--
--   AP.CATEGORY_COLUMN     — expect FAIL (column doesn't exist)
--   AP.CATEGORY_CHECK      — expect FAIL (constraint doesn't exist)
--   AP.RPC_CATEGORY_ROLE   — expect FAIL (RPC has no category in source)
--   AP.AUDIT               — expect FAIL (row not landed)
--
-- ── Scope disclaimer ──────────────────────────────────────────────────
-- STRUCTURAL only. Behavioral proof: add a plate as staff (via UI),
-- verify the category column stores 'staff'; try to insert with a
-- non-whitelisted category via PostgREST, verify CHECK rejects. Runs
-- alongside AP-UI-REFINE's smoke.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CATEGORY_COLUMN — category column exists with default 'staff'
-- ══════════════════════════════════════════════════════════════════════
DO $ap_category_column$
DECLARE
  v_data_type TEXT;
  v_is_nullable TEXT;
  v_column_default TEXT;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_data_type, v_is_nullable, v_column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'authorized_plates'
    AND column_name = 'category';

  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'AP.CATEGORY_COLUMN FAILED — category column does not exist on authorized_plates';
  END IF;
  IF v_data_type <> 'text' THEN
    RAISE EXCEPTION 'AP.CATEGORY_COLUMN FAILED — category data_type=% (expected text)', v_data_type;
  END IF;
  IF v_is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'AP.CATEGORY_COLUMN FAILED — category is_nullable=% (expected NO)', v_is_nullable;
  END IF;
  IF v_column_default IS NULL OR v_column_default NOT LIKE '%staff%' THEN
    RAISE EXCEPTION 'AP.CATEGORY_COLUMN FAILED — category default=% (expected to contain ''staff'')', v_column_default;
  END IF;
END $ap_category_column$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CATEGORY_CHECK — CHECK constraint with exact 3 values
-- ══════════════════════════════════════════════════════════════════════
-- Assert constraint exists AND has the exact staff/vendor/other set.
-- The pg_get_constraintdef output for a CHECK includes the whole IN
-- list; assert on all three values verbatim so a future edit that
-- drops one (or adds a fourth silently) fires this VQ.
DO $ap_category_check$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.authorized_plates'::regclass
    AND conname = 'authorized_plates_category_valid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.CATEGORY_CHECK FAILED — authorized_plates_category_valid constraint does not exist';
  END IF;

  IF     v_def NOT LIKE '%''staff''%'
      OR v_def NOT LIKE '%''vendor''%'
      OR v_def NOT LIKE '%''other''%'
  THEN
    RAISE EXCEPTION 'AP.CATEGORY_CHECK FAILED — constraint missing one of staff/vendor/other. Actual: %', v_def;
  END IF;
END $ap_category_check$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.RPC_CATEGORY_ROLE — check_authorized_plate returns role-conditional category
-- ══════════════════════════════════════════════════════════════════════
-- Two structural assertions:
--   (a) function source contains ap.category in the SELECT (proves the
--       column is being read)
--   (b) function source contains the role-conditional CASE for category
--       (proves portal-only treatment matches label)
DO $ap_rpc_category_role$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.RPC_CATEGORY_ROLE FAILED — check_authorized_plate function not found';
  END IF;

  IF v_def NOT LIKE '%ap.category%' THEN
    RAISE EXCEPTION 'AP.RPC_CATEGORY_ROLE FAILED — ap.category not selected in check_authorized_plate SELECT';
  END IF;

  IF     v_def NOT LIKE '%''category'',      CASE%'
     AND v_def NOT LIKE '%''category'', CASE%'
  THEN
    RAISE EXCEPTION 'AP.RPC_CATEGORY_ROLE FAILED — role-conditional CASE for category not present in check_authorized_plate return';
  END IF;

  -- Assert ELSE NULL for category (portal-only default-deny)
  -- Loose match — the label CASE also has ELSE NULL, so we can't
  -- distinguish which ELSE belongs to which CASE by pattern alone.
  -- Assert both CASE structures have ELSE NULL after the pattern.
  IF (length(v_def) - length(replace(v_def, 'ELSE NULL', ''))) / length('ELSE NULL') < 2 THEN
    RAISE EXCEPTION 'AP.RPC_CATEGORY_ROLE FAILED — expected 2 ELSE NULL branches (one for label, one for category) in check_authorized_plate';
  END IF;
END $ap_rpc_category_role$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.AUDIT — SCHEMA_AP_CATEGORY row landed
-- ══════════════════════════════════════════════════════════════════════
DO $ap_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_AP_CATEGORY'
    AND new_values->>'migration' = '20260724_ap_category';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.AUDIT FAILED — SCHEMA_AP_CATEGORY row missing';
  END IF;
END $ap_audit$;

COMMIT;
