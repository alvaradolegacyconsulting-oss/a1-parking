-- ════════════════════════════════════════════════════════════════════
-- FIX — import_batches_reject_errors_shape passed on NULL
-- ════════════════════════════════════════════════════════════════════
-- Apply after wip-20261015_approval_queue_schema.sql, which introduced
-- the constraint this corrects. Found by the paired execution gate
-- (npm run verify:approvalschema) on the first run against the applied
-- schema.
--
-- ── 🔴 THE DEFECT: A CHECK CONSTRAINT PASSES WHEN IT EVALUATES TO NULL
-- A CHECK rejects a row only on FALSE. UNKNOWN is accepted. The
-- constraint as shipped was:
--
--   (reject_errors IS NULL AND reject_error_count IS NULL)
--   OR (jsonb_typeof(reject_errors) = 'array'
--       AND reject_error_count IS NOT NULL
--       AND reject_error_count >= jsonb_array_length(reject_errors)
--       AND reject_error_count > 0)
--
-- With reject_errors NULL and reject_error_count 9:
--   first branch   → FALSE          (the count is not NULL)
--   jsonb_typeof(NULL) → NULL, not an error
--   NULL = 'array'     → NULL
--   second branch  → NULL           (NULL AND TRUE AND … is NULL)
--   FALSE OR NULL  → NULL           → the CHECK ACCEPTS the row
--
-- So "a count with no list" — a claim of 9 errors with no evidence
-- attached — was storable. The CA's page would show "9 errors found"
-- and offer a download of nothing. The constraint read as if it
-- covered the case, and the gate measured that it did not.
--
-- ── THE FIX: AN EXPLICIT IS NOT NULL, SO THE BRANCH IS FALSE NOT NULL
-- Adding `reject_errors IS NOT NULL` as the first conjunct makes the
-- second branch evaluate to FALSE rather than NULL whenever the list is
-- absent, and FALSE OR FALSE is FALSE, which a CHECK rejects.
--
-- 🔴 The general shape, worth carrying: in a CHECK, every branch must
-- be provably FALSE for the rows it is meant to reject. A function that
-- returns NULL for NULL input — jsonb_typeof, and most of them — turns
-- a comparison into UNKNOWN, and UNKNOWN is a pass.
--
-- The other three constraints on this table were re-audited for the
-- same class and are sound: status is NOT NULL so its IN-list cannot be
-- UNKNOWN; approval_complete compares with IS NOT NULL, which never
-- yields UNKNOWN; reject_has_reason wraps its column in COALESCE.
--
-- Paired: wip-20261015_reject_errors_null_fix_verification.sql
-- Execution half: npm run verify:approvalschema (the same gate that
-- found it — its "a count with NO list is refused" check goes green)

BEGIN;

DO $do$
DECLARE v_n INT;
BEGIN
  -- 🔴 Anything already stored through the hole. There should be none —
  -- no batch has been returned yet — but the fix adds a constraint that
  -- such a row would now violate, and NOT VALID is not wanted here:
  -- the whole point is that the rule holds for every row.
  SELECT count(*) INTO v_n FROM public.import_batches
   WHERE reject_error_count IS NOT NULL AND reject_errors IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'fix: % row(s) carry a reject_error_count with no reject_errors. Resolve them by hand — the count is a claim and the list is its evidence, and only a person can say which was right.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.import_batches
   WHERE reject_errors IS NOT NULL AND jsonb_typeof(reject_errors) <> 'array';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'fix: % row(s) hold a non-array reject_errors.', v_n;
  END IF;
END
$do$;

ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_reject_errors_shape;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_reject_errors_shape
  CHECK (
    (reject_errors IS NULL AND reject_error_count IS NULL)
    OR (
      -- 🔴 THIS CONJUNCT IS THE FIX. Without it, a NULL list makes
      -- jsonb_typeof return NULL, the comparison UNKNOWN, the branch
      -- UNKNOWN, and the constraint accepts the row.
      reject_errors IS NOT NULL
      AND jsonb_typeof(reject_errors) = 'array'
      AND reject_error_count IS NOT NULL
      AND reject_error_count > 0
      AND reject_error_count >= jsonb_array_length(reject_errors)
    )
  );

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'reject_errors NULL fix' AS migration,
  pg_get_constraintdef(oid) AS constraint_now,
  (pg_get_constraintdef(oid) ~ 'reject_errors IS NOT NULL')::TEXT AS has_the_fix
  FROM pg_constraint
 WHERE conrelid = 'public.import_batches'::regclass
   AND conname = 'import_batches_reject_errors_shape';
