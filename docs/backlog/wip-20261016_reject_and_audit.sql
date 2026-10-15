-- ════════════════════════════════════════════════════════════════════
-- REJECT for clean files, + audit on every status transition
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-15. Apply AFTER wip-20261015_approve_and_return_rpcs.sql.
--
-- 🔴 ORDERING HAZARD, READ THIS. Once this file is applied, do NOT
-- re-apply wip-20261015_approve_and_return_rpcs.sql or
-- wip-20261015_reject_errors_null_fix.sql. Both are one-time migrations
-- and re-applying either would silently revert part of this one — the
-- older CHECK would come back and refuse the clean-reject pairing
-- below. Verification files are the re-runnable ones.
--
-- Paired: wip-20261016_reject_and_audit_verification.sql
-- Execution half: npm run verify:queue
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block below as ONE block and click Run
-- ONCE. Do not run individual statements.
--
-- ── 🔴 PART 1 ANSWERS THE RULING'S OWN QUESTION, AND THE ANSWER WAS NO
-- "confirm the null-fix CHECK allows exactly that pairing and refuses
-- count>0 with an empty list" — measured by execution 2026-10-15
-- against the applied constraint:
--
--   ([], 0)   the RULED clean-reject pairing   → REFUSED
--   ([], 5)   a claim with no evidence          → ALLOWED
--   ([e,e], 2)                                 → allowed (correct)
--   ([e,e], 40) capped                         → allowed (correct)
--   ([e,e], 0)  count understates              → refused (correct)
--   (NULL, 0)                                  → refused (correct)
--
-- Both halves were the wrong way round. `reject_error_count > 0`
-- blocked the clean reject, and the NULL-list guard added in the last
-- fix did nothing about the EMPTY list — so "a claim with no evidence"
-- was still storable in a second disguise. One guard closed one shape
-- of the same hole.
--
-- The rule the three cases actually need is an EQUIVALENCE, not a
-- bound: the count is zero exactly when the list is empty.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — count = 0 ⟺ the list is empty
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE v_n INT;
BEGIN
  -- Nothing stored through the hole. There should be none: no batch has
  -- been returned or rejected yet.
  SELECT count(*) INTO v_n FROM public.import_batches
   WHERE reject_errors IS NOT NULL
     AND jsonb_typeof(reject_errors) = 'array'
     AND jsonb_array_length(reject_errors) = 0
     AND COALESCE(reject_error_count, 0) > 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'part 1: % row(s) claim errors with an empty list attached. Resolve by hand — only a person can say whether the count or the list was right.', v_n;
  END IF;
END
$do$;

ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_reject_errors_shape;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_reject_errors_shape
  CHECK (
    -- Never returned and never rejected.
    (reject_errors IS NULL AND reject_error_count IS NULL)
    OR (
      reject_errors IS NOT NULL
      AND jsonb_typeof(reject_errors) = 'array'
      AND reject_error_count IS NOT NULL
      AND reject_error_count >= 0
      -- The stored list may be shorter than the count (capped) but
      -- never longer: the count is the authority and cannot understate
      -- the evidence attached to it.
      AND reject_error_count >= jsonb_array_length(reject_errors)
      -- 🔴 THE EQUIVALENCE, WHICH IS THE FIX. Zero errors and an empty
      -- list go together or not at all.
      --   ([], 0)  a clean Reject — nothing for the company to fix,
      --            the typed reason is the whole message
      --   ([], 5)  a claim with no evidence: the company is told five
      --            rows are wrong and shown none of them
      --   ([e], 0) a list with no claim
      AND (reject_error_count = 0) = (jsonb_array_length(reject_errors) = 0)
    )
  );

COMMENT ON COLUMN public.import_batches.reject_error_count IS
  'The TRUE number of validation errors found, which may exceed jsonb_array_length(reject_errors) if the stored list was capped. 🔴 Zero exactly when the list is empty, which is the clean-Reject shape: an operator rejecting a file that validates fine gives a typed reason and no rows, and a count above zero with an empty list would tell the company N rows are wrong while showing none of them. Separate from the list because a truncated error file that does not say it is truncated sends the company to fix some of their rows and resubmit into the same rejection.';

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — reject, for a file that validates fine
-- ════════════════════════════════════════════════════════════════════
-- 🔴 WHY A THIRD ACTION AND NOT A RELAXED RETURN. Return's entire
-- payload is the row numbers, and it generates its own reason from
-- them. A file that validates fine has no rows to attach, so a Return
-- of it would carry a generated sentence about rows that do not exist.
-- The two actions mean different things to the company:
--   Return  "your file was fine; the property moved under it; fix
--            these rows"       → reason generated from the errors
--   Reject  "this file is not what we can load"
--                              → reason typed by the operator
-- Only a person can write the second one, which is why it is required
-- rather than generated.
CREATE OR REPLACE FUNCTION public.reject_import_batch(
  p_batch_id BIGINT,
  p_reason   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status TEXT;
  v_reason TEXT;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required',
      'detail', 'A rejection without a reason is not a rejection the company can act on.');
  END IF;
  -- 🔴 A LENGTH FLOOR, BECAUSE THIS SENTENCE REACHES A CUSTOMER.
  -- The table CHECK only requires non-blank, and "x" is non-blank. A
  -- rejection is the only thing the company is told about a file they
  -- spent time preparing, and ten characters is the lowest bar at which
  -- it can carry a thought.
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_too_short',
      'detail', 'Say what is wrong with the file. This sentence is the only thing the company is told.');
  END IF;

  SELECT status INTO v_status
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;

  IF v_status NOT IN ('submitted', 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status',
      'status', v_status,
      'detail', 'Only a submitted or approved batch can be rejected. A loaded batch is rolled back.');
  END IF;

  UPDATE public.import_batches
     SET status = 'rejected',
         reject_reason = v_reason,
         -- 🔴 An EMPTY ARRAY and a ZERO count, together. Not NULL: NULL
         -- means "never rejected", and this batch has been. The
         -- equivalence in part 1 is what makes this the only valid
         -- zero-error shape.
         reject_errors = '[]'::jsonb,
         reject_error_count = 0
   WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id,
                            'status', 'rejected', 'from_status', v_status,
                            'error_count', 0);
END
$fn$;

COMMENT ON FUNCTION public.reject_import_batch(BIGINT, TEXT) IS
  'Rejects a submitted or approved batch whose file validates fine, with a reason TYPED by the operator — the only thing the company is told about it. Active-admin only, FOR UPDATE, submitted/approved only. Writes reject_errors = ''[]'' and reject_error_count = 0, the clean-reject shape the equivalence in import_batches_reject_errors_shape permits. 🔴 Separate from return_import_batch_to_company because that one''s whole payload is row numbers and it generates its reason from them; a file with no bad rows would get a generated sentence about rows that do not exist. The blocked check (inactive property, suspended company, upload flag off) is the route''s, the same as for Return.';

REVOKE ALL ON FUNCTION public.reject_import_batch(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_import_batch(BIGINT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_import_batch(BIGINT, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — audit, as a trigger rather than three copies
-- ════════════════════════════════════════════════════════════════════
-- 🔴 A TRIGGER, NOT A LINE IN EACH RPC. The ruling asks for audit on
-- Reject. Putting it in each function would mean three copies today and
-- a fourth and fifth when the loader and rollback arrive — and the one
-- that gets forgotten is the one nobody notices, because a missing
-- audit row looks exactly like a transition that never happened.
--
-- As a trigger it also covers transitions written outside the RPCs:
-- the loader, rollback, and any service-role correction. Those are
-- precisely the writes most worth having a record of.
--
-- 🔴 AND IT CARRIES NO RESIDENT DATA. reject_errors holds messages that
-- name plates and addresses; none of it is copied here. Counts, ids and
-- the hash only. An audit table is read by more people and kept longer
-- than the row it describes.
--
-- 🔴 AFTER, not BEFORE: it records what actually landed. A BEFORE
-- trigger would write an audit row for a transition a CHECK then
-- refused.
CREATE OR REPLACE FUNCTION public.import_batch_status_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_old TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Inert unless the status actually moved. The trigger is already
    -- scoped UPDATE OF status, but a writer that sends the column with
    -- its existing value must not produce an audit row for a change
    -- that did not happen.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    v_old := OLD.status;
  ELSE
    v_old := NULL;
  END IF;

  INSERT INTO public.audit_logs
    (user_email, action, table_name, record_id, old_values, new_values, notes, created_at)
  VALUES (
    -- The operator, from the request JWT. A trigger sees the session's
    -- claims even when it fires inside a SECURITY DEFINER function,
    -- because they are a session setting and not a role property. NULL
    -- for a service-role write, which is itself worth recording.
    NULLIF(btrim(COALESCE(auth.jwt() ->> 'email', '')), ''),
    'IMPORT_BATCH_' || upper(NEW.status),
    'import_batches',
    NEW.id::TEXT,
    CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('status', v_old) END,
    jsonb_build_object(
      'status',             NEW.status,
      'company_id',         NEW.company_id,
      'property_id',        NEW.property_id,
      'resident_count',     NEW.resident_count,
      'vehicle_count',      NEW.vehicle_count,
      'file_sha256',        NEW.file_sha256,
      'approved_by',        NEW.approved_by,
      'reject_error_count', NEW.reject_error_count
    ),
    -- The reason is operator-written or generated from row numbers; it
    -- names no resident. Truncated, because an audit note is a summary.
    CASE WHEN NEW.reject_reason IS NULL THEN NULL
         ELSE left(NEW.reject_reason, 500) END,
    now()
  );
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.import_batch_status_audit() IS
  'Writes one audit_logs row per import_batches status transition, including the INSERT that creates a batch. 🔴 A trigger rather than a line in each RPC: three copies today would be five once the loader and rollback exist, and a missing audit row looks exactly like a transition that never happened. It also covers writes made outside the RPCs, which are the ones most worth a record. Carries counts, ids and the hash but 🔴 NO RESIDENT DATA — reject_errors names plates and addresses and none of it is copied, because an audit table is read by more people and kept longer than the row it describes. AFTER, so it records what landed rather than what a CHECK then refused.';

REVOKE ALL ON FUNCTION public.import_batch_status_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_batch_status_audit() FROM anon;
REVOKE ALL ON FUNCTION public.import_batch_status_audit() FROM authenticated;

DROP TRIGGER IF EXISTS import_batches_status_audit ON public.import_batches;
CREATE TRIGGER import_batches_status_audit
  AFTER INSERT OR UPDATE OF status ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.import_batch_status_audit();

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'reject + audit' AS migration,
  (SELECT (pg_get_constraintdef(oid) ~ 'jsonb_array_length\(reject_errors\) = 0')::TEXT
     FROM pg_constraint WHERE conrelid = 'public.import_batches'::regclass
       AND conname = 'import_batches_reject_errors_shape') AS equivalence_present,
  to_regprocedure('public.reject_import_batch(bigint, text)')::TEXT AS reject,
  (SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal) AS audit_trigger,
  'execution half: npm run verify:queue' AS and_then;
