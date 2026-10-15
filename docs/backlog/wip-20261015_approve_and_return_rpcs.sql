-- ════════════════════════════════════════════════════════════════════
-- APPROVE and RETURN — the two queue transitions
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-15. Apply after the approval-queue schema and the
-- reject_errors NULL fix.
--
-- Paired: wip-20261015_approve_and_return_rpcs_verification.sql
-- Execution half: npm run verify:queue
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block below into SQL Editor as ONE
-- block, then click Run ONCE. Do NOT click Run on individual
-- statements — that breaks BEGIN/COMMIT atomicity and can produce a
-- partial-apply state.
--
-- ── WHY RPCs AND NOT POLICIES ───────────────────────────────────────
-- import_batches has two SELECT policies, no INSERT/UPDATE/DELETE
-- policy, and no write grant to authenticated — deliberately, so "a
-- forgotten policy cannot become a write path". These are the only two
-- ways a batch's status moves until the loader exists.
--
-- ── WRITER SWEEP (binding rule) ─────────────────────────────────────
-- Writers of import_batches.status today:
--   api/bulk-onboarding/submit   INSERT with status forced 'submitted'
--   (nothing else — status is never written after insert)
-- Writers of approved_by / approved_at / reject_reason /
-- reject_errors / reject_error_count:
--   🔴 NONE. These two functions are the first.
-- Repo sweep for approved_by over app/ and scripts/: zero readers,
-- zero writers. Part 0 re-checks the catalog half, because a policy or
-- grant added from the dashboard never enters the repo.
--
-- ── 🔴 WHAT THESE FUNCTIONS DO NOT DO ───────────────────────────────
-- They do not re-validate. They cannot: half the validator
-- (validateBulkRows, dbFlagErrors) is TypeScript, and the file itself
-- lives in storage where no SQL function can read it. Re-validation is
-- the route's job, and the route is the enforcement point.
--
-- What these DO enforce, which is the part that can be:
--   • an active admin, read from user_roles, not from a parameter;
--   • the status transition is the one expected, under FOR UPDATE, so
--     two operators clicking at once cannot both win;
--   • for approve, that the bytes being approved are the bytes the
--     operator was shown — p_file_sha256 must match the row.
-- The trust boundary for "was it re-validated" is the operator's own
-- session. That is stated rather than implied.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — sweep
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE v_n INT; v_s TEXT;
BEGIN
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_n, v_s
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches' AND cmd <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'sweep: import_batches has % non-SELECT policy(ies): %. These RPCs are meant to be the only write path.', v_n, v_s;
  END IF;

  SELECT count(*), string_agg(DISTINCT a.privilege_type, ', ') INTO v_n, v_s
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid = 'public.import_batches'::regclass
     AND r.rolname IN ('authenticated','anon')
     AND a.privilege_type <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'sweep: authenticated/anon hold % on import_batches', v_s;
  END IF;

  -- The schema these depend on.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_status_allowed'
     AND pg_get_constraintdef(oid) ~ '''approved''';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'sweep: the status allowlist does not include approved. Apply wip-20261015_approval_queue_schema.sql first.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_reject_errors_shape'
     AND pg_get_constraintdef(oid) ~ 'reject_errors IS NOT NULL';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'sweep: the reject_errors NULL fix is not applied. Apply wip-20261015_reject_errors_null_fix.sql first.';
  END IF;
  RAISE NOTICE 'sweep clean: no write path, schema prerequisites present';
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — who may operate the queue
-- ════════════════════════════════════════════════════════════════════
-- 🔴 Read from user_roles with is_active spelled out, the same shape as
-- may_bulk_upload_at and may_bulk_validate_at, so all three gates in
-- this feature read the same way and none depends on what another
-- helper happens to mean today.
CREATE OR REPLACE FUNCTION public.is_active_import_operator()
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE lower(trim(ur.email)) = lower(trim(auth.jwt() ->> 'email'))
       AND ur.role = 'admin'
       AND ur.is_active
  )
$fn$;

COMMENT ON FUNCTION public.is_active_import_operator() IS
  'Is the JWT holder an ACTIVE super-admin? The gate on approve_import_batch and return_import_batch_to_company. Reads user_roles directly with is_active spelled out, matching may_bulk_upload_at and may_bulk_validate_at, so every gate in the bulk-onboarding feature reads the same way.';

REVOKE ALL ON FUNCTION public.is_active_import_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_active_import_operator() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_active_import_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_import_operator() TO service_role;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — approve
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.approve_import_batch(
  p_batch_id    BIGINT,
  p_file_sha256 TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid    UUID;
  v_status TEXT;
  v_sha    TEXT;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;

  -- 🔴 auth.uid() must exist. approved_by is required by
  -- import_batches_approval_complete, so a service_role call would
  -- otherwise reach the UPDATE and die on the CHECK with a constraint
  -- name instead of an answer. Refused here with a reason.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_caller_identity',
      'detail', 'An approval records who approved it. A call with no auth.uid() cannot.');
  END IF;

  -- FOR UPDATE so two operators clicking at once cannot both win: the
  -- second waits, then sees status 'approved' and is told so.
  SELECT status, file_sha256 INTO v_status, v_sha
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;

  IF v_status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status',
      'status', v_status,
      'detail', 'Only a submitted batch can be approved.');
  END IF;

  -- 🔴 THE BYTES BEING APPROVED ARE THE BYTES THE OPERATOR SAW.
  -- The caller passes the hash its review screen displayed. A mismatch
  -- means the screen was stale, and an approval of a file nobody looked
  -- at is the one thing this transition must not become.
  IF v_sha IS DISTINCT FROM lower(btrim(p_file_sha256)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sha_mismatch',
      'expected', v_sha,
      'detail', 'This batch is not the file you reviewed. Reload the batch and look again.');
  END IF;

  UPDATE public.import_batches
     SET status = 'approved', approved_by = v_uid, approved_at = now()
   WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id,
                            'status', 'approved', 'approved_by', v_uid);
END
$fn$;

COMMENT ON FUNCTION public.approve_import_batch(BIGINT, TEXT) IS
  'Moves a submitted batch to approved, recording auth.uid() and now(). Active-admin only. 🔴 Takes the file hash the operator''s review screen displayed and refuses on a mismatch, so an approval is always of bytes someone looked at. FOR UPDATE, so two operators cannot both win. It does NOT re-validate: half the validator is TypeScript and the file lives in storage where no SQL function can read it, so re-validation is the route''s job and the route is the enforcement point.';

REVOKE ALL ON FUNCTION public.approve_import_batch(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_import_batch(BIGINT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_import_batch(BIGINT, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — return to company
-- ════════════════════════════════════════════════════════════════════
-- The stale outcome, and also the ordinary reject from review. One
-- transition, because what the CA needs is identical in both cases: a
-- reason they can act on and the row numbers to fix.
--
-- 🔴 FROM 'approved' AS WELL AS 'submitted', AND NO NEW STATUS. A load
-- that fails re-validation returns the batch to the company; the
-- approval is not preserved, because the file the CA resubmits is a
-- different file and will need approving on its own merits.
CREATE OR REPLACE FUNCTION public.return_import_batch_to_company(
  p_batch_id    BIGINT,
  p_reason      TEXT,
  p_errors      JSONB,
  p_error_count INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status TEXT;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;

  IF COALESCE(btrim(p_reason), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required',
      'detail', 'A rejection without a reason is not a rejection the company can act on.');
  END IF;

  -- 🔴 The error list is the evidence for the count, and the count is
  -- the authority. Checked here so the caller gets an answer rather
  -- than a constraint name, and the constraint stays as the backstop.
  IF p_errors IS NULL OR jsonb_typeof(p_errors) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'errors_required',
      'detail', 'Return attaches the row-numbered errors. An empty return gives the company nothing to fix.');
  END IF;
  IF p_error_count IS NULL OR p_error_count <= 0
     OR p_error_count < jsonb_array_length(p_errors) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_error_count',
      'detail', 'The count must be positive and at least the number of errors attached.');
  END IF;

  SELECT status INTO v_status
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;

  IF v_status NOT IN ('submitted', 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status',
      'status', v_status,
      'detail', 'Only a submitted or approved batch can be returned. A loaded batch is rolled back, not returned.');
  END IF;

  UPDATE public.import_batches
     SET status = 'rejected',
         reject_reason = btrim(p_reason),
         reject_errors = p_errors,
         reject_error_count = p_error_count
   WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id,
                            'status', 'rejected', 'from_status', v_status,
                            'error_count', p_error_count);
END
$fn$;

COMMENT ON FUNCTION public.return_import_batch_to_company(BIGINT, TEXT, JSONB, INT) IS
  'Returns a submitted or approved batch to the company as rejected, with a reason and the row-numbered errors the company needs to fix. Active-admin only. 🔴 The stale-load outcome AND the ordinary review reject are one transition, because what the CA needs is identical in both. No new status: rejected drops the batch out of the live duplicate index, which is what makes the fixed file resubmittable. The approval is not preserved — the file the CA sends back is a different file and is approved on its own merits.';

REVOKE ALL ON FUNCTION public.return_import_batch_to_company(BIGINT, TEXT, JSONB, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.return_import_batch_to_company(BIGINT, TEXT, JSONB, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.return_import_batch_to_company(BIGINT, TEXT, JSONB, INT) TO authenticated;

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'approve + return RPCs' AS migration,
  to_regprocedure('public.is_active_import_operator()')::TEXT      AS operator_gate,
  to_regprocedure('public.approve_import_batch(bigint, text)')::TEXT AS approve,
  to_regprocedure('public.return_import_batch_to_company(bigint, text, jsonb, integer)')::TEXT AS return_to_company,
  'execution half: npm run verify:queue' AS and_then;
