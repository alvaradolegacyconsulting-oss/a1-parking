-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — reject + audit
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261016_reject_and_audit.sql. Re-runnable, read-only, no
-- transaction. Terminal SELECT returns the PASS row.
--
-- Execution half: npm run verify:queue
--
-- 🔴 Every RAISE format string counted by hand; %% is a literal percent
-- and takes no argument. A malformed one voids every gate in the block,
-- because PL/pgSQL checks them at compile time.

DO $do$
DECLARE
  v_def TEXT;
  v_n   INT;
  v_s   TEXT;
BEGIN
  -- ── 🔴 G1. the equivalence, which the ruling asked to be confirmed
  -- Measured by execution before this migration: ([], 0) was REFUSED
  -- and ([], 5) was ALLOWED. Both the wrong way round.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_reject_errors_shape';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: import_batches_reject_errors_shape is missing';
  END IF;
  IF v_def !~ 'jsonb_array_length\(reject_errors\) = 0' THEN
    RAISE EXCEPTION 'G1 FAIL: the count-is-zero-iff-list-is-empty equivalence is not in the constraint. Without it the clean-Reject pairing ([], 0) is refused and a claim with no evidence ([], 5) is allowed. def=%', v_def;
  END IF;
  IF v_def !~ 'reject_errors IS NOT NULL' THEN
    RAISE EXCEPTION 'G1 FAIL: the NULL-list guard is gone — a CHECK accepts UNKNOWN, so jsonb_typeof(NULL) would make the branch pass. def=%', v_def;
  END IF;
  IF v_def ~ 'reject_error_count > 0' THEN
    RAISE EXCEPTION 'G1 FAIL: the old `count > 0` bound survives and refuses the clean-Reject pairing. def=%', v_def;
  END IF;
  IF v_def !~ 'reject_error_count >= jsonb_array_length' THEN
    RAISE EXCEPTION 'G1 FAIL: the count no longer has to be at least the attached list. A capped list is allowed; an understated count is not.';
  END IF;
  RAISE NOTICE 'G1 ok: NULL guard, count >= length, and count = 0 exactly when the list is empty';

  -- ── G2. reject exists, gated, locked ─────────────────────────────
  IF to_regprocedure('public.reject_import_batch(bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch(bigint, text) is absent';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.reject_import_batch(bigint, text)'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G2 FAIL: reject_import_batch could not be read'; END IF;
  IF v_def !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch is not SECURITY DEFINER';
  END IF;
  IF v_def !~ 'search_path' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch has no pinned search_path';
  END IF;
  IF v_def !~ 'is_active_import_operator' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch does not call the operator gate';
  END IF;
  IF v_def !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch does not lock the row';
  END IF;
  IF v_def !~ 'reason_too_short' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch accepts any non-blank reason. The table CHECK only requires non-blank, and "x" is non-blank — this sentence is the only thing the company is told.';
  END IF;
  -- 🔴 The clean-reject shape, written literally.
  IF v_def !~ '''\[\]''::jsonb' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch does not write an empty array. NULL would mean "never rejected", and this batch has been.';
  END IF;
  IF v_def !~ 'reject_error_count = 0' THEN
    RAISE EXCEPTION 'G2 FAIL: reject_import_batch does not write a zero count';
  END IF;
  IF v_def !~ '''submitted''' OR v_def !~ '''approved''' THEN
    RAISE EXCEPTION 'G2 FAIL: reject must accept both submitted and approved as the source status';
  END IF;
  RAISE NOTICE 'G2 ok: DEFINER, pinned, operator-gated, locked, reason floor, writes ([], 0)';

  -- ── G3. grants on reject ─────────────────────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid = to_regprocedure('public.reject_import_batch(bigint, text)')::oid
     AND a.grantee = 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'G3 FAIL: PUBLIC holds EXECUTE on reject_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.reject_import_batch(bigint, text)')::oid
     AND r.rolname = 'anon';
  IF v_n > 0 THEN RAISE EXCEPTION 'G3 FAIL: anon holds EXECUTE on reject_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.reject_import_batch(bigint, text)')::oid
     AND r.rolname = 'authenticated' AND a.privilege_type = 'EXECUTE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G3 FAIL: authenticated cannot EXECUTE reject_import_batch — the route calls it as the operator';
  END IF;
  RAISE NOTICE 'G3 ok: authenticated only; PUBLIC and anon revoked';

  -- ── 🔴 G4. the audit trigger, named and scoped ───────────────────
  SELECT count(*), string_agg(tgname, ', ') INTO v_n, v_s
    FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal;
  IF v_n <> 1 OR v_s IS DISTINCT FROM 'import_batches_status_audit' THEN
    RAISE EXCEPTION 'G4 FAIL: expected exactly import_batches_status_audit on this table, found % (%)', v_n, COALESCE(v_s, '(none)');
  END IF;
  -- AFTER, not BEFORE: it must record what landed, not what a CHECK
  -- then refused. tgtype bit 1 set = BEFORE.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass
     AND tgname = 'import_batches_status_audit'
     AND (tgtype & 2) <> 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G4 FAIL: the audit trigger is BEFORE. It would write an audit row for a transition a CHECK then refused.';
  END IF;
  -- Scoped to the status column on UPDATE, so it is inert for every
  -- other write to this table.
  SELECT count(*) INTO v_n FROM pg_trigger t
    CROSS JOIN LATERAL unnest(t.tgattr) AS att
    JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = att
   WHERE t.tgrelid = 'public.import_batches'::regclass
     AND t.tgname = 'import_batches_status_audit'
     AND a.attname = 'status';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: the audit trigger is not scoped UPDATE OF status (matched % column(s)). Unscoped it would fire for every write to the table.', v_n;
  END IF;
  RAISE NOTICE 'G4 ok: one named trigger, AFTER, scoped to the status column';

  -- ── 🔴 G5. the audit function carries no resident data ───────────
  -- An audit table is read by more people and kept longer than the row
  -- it describes. reject_errors holds messages naming plates and
  -- addresses; none of it may be copied.
  v_def := pg_get_functiondef(to_regprocedure('public.import_batch_status_audit()'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G5 FAIL: import_batch_status_audit() could not be read'; END IF;
  IF v_def ~ '\mNEW\.reject_errors\M' THEN
    RAISE EXCEPTION 'G5 FAIL: the audit function copies reject_errors, which names plates and addresses';
  END IF;
  IF v_def !~ 'NEW\.reject_error_count' THEN
    RAISE EXCEPTION 'G5 FAIL: the audit function does not record the error COUNT, which is the part a reviewer needs';
  END IF;
  IF v_def !~ 'NEW\.file_sha256' THEN
    RAISE EXCEPTION 'G5 FAIL: the audit function does not record the file hash — the one field that identifies which file moved';
  END IF;
  IF v_def !~ 'IS NOT DISTINCT FROM OLD\.status' THEN
    RAISE EXCEPTION 'G5 FAIL: the audit function is not inert for a write that sends status with its existing value. It would record a change that did not happen.';
  END IF;
  IF v_def !~ 'auth\.jwt\(\)' THEN
    RAISE EXCEPTION 'G5 FAIL: the audit function does not record who did it';
  END IF;
  -- Not callable by a client; it is a trigger function.
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.import_batch_status_audit()')::oid
     AND r.rolname IN ('authenticated', 'anon');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G5 FAIL: a client role holds EXECUTE on the audit trigger function';
  END IF;
  RAISE NOTICE 'G5 ok: counts, ids and hash but no resident data; inert on a no-op; records the operator; not client-callable';

  -- ── G6. the three transitions all still exist ────────────────────
  IF to_regprocedure('public.approve_import_batch(bigint, text)') IS NULL
     OR to_regprocedure('public.return_import_batch_to_company(bigint, text, jsonb, integer)') IS NULL THEN
    RAISE EXCEPTION 'G6 FAIL: approve or return is missing. 🔴 Re-applying an earlier one-time migration after this one would revert part of it — only verification files are re-runnable.';
  END IF;
  RAISE NOTICE 'G6 ok: approve, return and reject all present';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'reject + audit' AS verification,
  'PASS — G1..G6' AS result,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_reject_errors_shape') AS reject_shape,
  to_regprocedure('public.reject_import_batch(bigint, text)')::TEXT AS reject,
  (SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal) AS audit_trigger,
  'execution half: npm run verify:queue' AS and_then;
