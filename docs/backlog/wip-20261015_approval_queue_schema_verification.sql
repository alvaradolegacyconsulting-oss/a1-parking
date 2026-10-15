-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — approval-queue schema
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261015_approval_queue_schema.sql.
-- Re-runnable, read-only, no transaction. Terminal SELECT returns the
-- PASS row.
--
-- 🔴 STRUCTURAL ONLY, AND THE EXECUTION HALF IS A SEPARATE GATE:
--   npm run verify:approvalschema
-- Phase A set that split for a reason. import_batches has FORCE ROW
-- LEVEL SECURITY and no INSERT policy, so a probe INSERT from the SQL
-- editor depends on whether the editor's role carries BYPASSRLS —
-- which would make a failure here read as a broken CHECK when it was
-- actually a refused write. The execution gate runs as service_role,
-- which demonstrably can write (batch 8 exists), so the constraint
-- under test is the only thing that can refuse it.
--
-- A structural gate cannot see whether a CHECK actually fires. That is
-- the whole point of the pairing: this proves the definitions are the
-- ones intended, the execution gate proves they bite.
--
-- 🔴 AND A DO BLOCK IS ALL-OR-NOTHING AT COMPILE TIME.
-- The first version of this file died on
--   ERROR: 42601: too many parameters specified for RAISE
-- because one format string wrote %% — which is an ESCAPED LITERAL
-- PERCENT, not a placeholder — and then passed two arguments for the
-- one placeholder that was left. PL/pgSQL checks RAISE argument counts
-- when it COMPILES the block, so nothing in it ran: not G1, not G6,
-- none of it. The migration had already applied and printed its own
-- PASS row, so the only thing distinguishing "verified" from "the
-- verification never executed" was that one error line.
--
-- The lesson for every file like this one: a typo in any format string
-- anywhere in the block voids every assertion in the block. There is no
-- partial run.

DO $do$
DECLARE
  v  TEXT;
  n  INT;
  s  TEXT;
BEGIN
  -- ── 1. the status allowlist ───────────────────────────────────────
  SELECT pg_get_constraintdef(oid) INTO v FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_status_allowed';
  IF v IS NULL THEN RAISE EXCEPTION 'G1 FAIL: import_batches_status_allowed is missing'; END IF;
  IF v !~ '''approved''' THEN
    RAISE EXCEPTION 'G1 FAIL: the allowlist does not include approved — %', v;
  END IF;
  -- Every one of the five, and 🔴 ASSERT THE COUNT so a sixth value
  -- cannot slip in unnoticed: the allowlist is meant to be exhaustive,
  -- and a status nobody ruled on is a state nothing handles.
  FOR s IN SELECT unnest(ARRAY['submitted','approved','rejected','loaded','rolled_back']) LOOP
    IF v !~ ('''' || s || '''') THEN
      RAISE EXCEPTION 'G1 FAIL: the allowlist lost % — %', s, v;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM regexp_matches(v, '''[a-z_]+''', 'g');
  IF n <> 5 THEN
    RAISE EXCEPTION 'G1 FAIL: the allowlist holds % values, expected exactly 5 — %', n, v;
  END IF;
  RAISE NOTICE 'G1 ok: status allowlist is exactly the five ruled values';

  -- ── 2. 🔴 the duplicate guard counts approved as live ─────────────
  SELECT pg_get_expr(indpred, indrelid) INTO v FROM pg_index
   WHERE indexrelid = 'public.import_batches_one_live_per_file'::regclass;
  IF v IS NULL THEN RAISE EXCEPTION 'G2 FAIL: import_batches_one_live_per_file is missing'; END IF;
  IF v !~ '''approved''' THEN
    RAISE EXCEPTION 'G2 FAIL: approved is not live for the duplicate guard, so an approved batch can be resubmitted and loaded twice — %', v;
  END IF;
  IF v !~ '''submitted''' OR v !~ '''loaded''' THEN
    RAISE EXCEPTION 'G2 FAIL: the predicate lost submitted or loaded — %', v;
  END IF;
  IF v ~ '''rejected''' OR v ~ '''rolled_back''' THEN
    RAISE EXCEPTION 'G2 FAIL: a rejected or rolled-back batch must NOT be live — a fixed file has to be resubmittable — %', v;
  END IF;
  SELECT count(*) INTO n FROM pg_index
   WHERE indexrelid = 'public.import_batches_one_live_per_file'::regclass AND indisunique;
  IF n <> 1 THEN RAISE EXCEPTION 'G2 FAIL: the live index is not UNIQUE'; END IF;
  -- The columns, in case a rebuild changed them.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(att, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.att
   WHERE i.indexrelid = 'public.import_batches_one_live_per_file'::regclass;
  IF v <> 'property_id,file_sha256' THEN
    RAISE EXCEPTION 'G2 FAIL: the live index is on (%), expected (property_id,file_sha256)', v;
  END IF;
  RAISE NOTICE 'G2 ok: UNIQUE (property_id, file_sha256) WHERE submitted/approved/loaded';

  -- ── 3. an approval names who and when ─────────────────────────────
  SELECT pg_get_constraintdef(oid) INTO v FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_approval_complete';
  IF v IS NULL THEN RAISE EXCEPTION 'G3 FAIL: import_batches_approval_complete is missing'; END IF;
  IF v !~ '''approved''' THEN
    RAISE EXCEPTION 'G3 FAIL: approved is not covered, so a batch can be approved with approved_by NULL — %', v;
  END IF;
  IF v !~ 'approved_by' OR v !~ 'approved_at' THEN
    RAISE EXCEPTION 'G3 FAIL: the constraint no longer requires both who and when — %', v;
  END IF;
  RAISE NOTICE 'G3 ok: approved/loaded/rolled_back all require approved_by and approved_at';

  -- ── 4. approved_by is the approver's user id ──────────────────────
  SELECT format_type(atttypid, atttypmod) INTO v FROM pg_attribute
   WHERE attrelid = 'public.import_batches'::regclass AND attname = 'approved_by' AND NOT attisdropped;
  IF v IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'G4 FAIL: approved_by is %, expected uuid', COALESCE(v, 'absent');
  END IF;
  -- And the customer's half is still a uid, which is the whole reason
  -- the operator's half changed.
  SELECT format_type(atttypid, atttypmod) INTO v FROM pg_attribute
   WHERE attrelid = 'public.import_batches'::regclass AND attname = 'attested_by_user_id' AND NOT attisdropped;
  IF v IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'G4 FAIL: attested_by_user_id is %, expected uuid', COALESCE(v, 'absent');
  END IF;
  RAISE NOTICE 'G4 ok: both halves of the provenance are uuids';

  -- ── 5. where the returned error list lives ────────────────────────
  SELECT format_type(atttypid, atttypmod) INTO v FROM pg_attribute
   WHERE attrelid = 'public.import_batches'::regclass AND attname = 'reject_errors' AND NOT attisdropped;
  IF v IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'G5 FAIL: reject_errors is %, expected jsonb', COALESCE(v, 'absent');
  END IF;
  SELECT format_type(atttypid, atttypmod) INTO v FROM pg_attribute
   WHERE attrelid = 'public.import_batches'::regclass AND attname = 'reject_error_count' AND NOT attisdropped;
  IF v IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION 'G5 FAIL: reject_error_count is %, expected integer', COALESCE(v, 'absent');
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_reject_errors_shape';
  IF v IS NULL THEN RAISE EXCEPTION 'G5 FAIL: import_batches_reject_errors_shape is missing'; END IF;
  IF v !~ 'jsonb_array_length' THEN
    RAISE EXCEPTION 'G5 FAIL: the shape check does not compare the count to the stored list, so a truncated error file could claim to be complete — %', v;
  END IF;
  RAISE NOTICE 'G5 ok: reject_errors jsonb + reject_error_count integer, count >= stored length';

  -- ── 6. still no client write path ─────────────────────────────────
  -- 🔴 RE-ASSERTED, NOT INHERITED FROM THE MIGRATION'S SWEEP. This file
  -- is re-runnable and the property is standing: a new reachable status
  -- is only safe while the only way to reach it is an RPC.
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO n, s
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches' AND cmd <> 'SELECT';
  IF n > 0 THEN RAISE EXCEPTION 'G6 FAIL: % non-SELECT policy(ies) on import_batches: %', n, s; END IF;
  SELECT count(*), string_agg(DISTINCT a.privilege_type, ', ') INTO n, s
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid = 'public.import_batches'::regclass
     AND r.rolname IN ('authenticated','anon')
     AND a.privilege_type <> 'SELECT';
  IF n > 0 THEN RAISE EXCEPTION 'G6 FAIL: authenticated/anon hold % on import_batches', s; END IF;
  -- Both SELECT policies still there: the CA reads their own company's
  -- batches (which is how the returned error list reaches them) and an
  -- active admin reads all.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches'
     AND policyname IN ('ib_company_admin_select','ib_admin_select');
  IF n <> 2 THEN
    RAISE EXCEPTION 'G6 FAIL: expected both SELECT policies, found %. Without ib_company_admin_select the CA cannot read the error list a return attaches.', n;
  END IF;
  -- 🔴 EXACTLY ONE TRIGGER, NAMED. This gate said "no trigger" until
  -- 2026-10-16, when the status audit was added as a trigger rather
  -- than as a line in each RPC. Asserting the NAME and the COUNT rather
  -- than relaxing to "zero or more": the audit is expected, anything
  -- else on this table is an unswept writer of every column above.
  SELECT count(*), string_agg(tgname, ', ') INTO n, s FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal;
  IF n <> 1 OR s IS DISTINCT FROM 'import_batches_status_audit' THEN
    RAISE EXCEPTION 'G6 FAIL: expected exactly import_batches_status_audit on this table, found % (%). Anything else is an unswept writer.', n, COALESCE(s, '(none)');
  END IF;
  RAISE NOTICE 'G6 ok: two SELECT policies, SELECT-only grants, one named audit trigger, no write path';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'approval-queue schema' AS verification,
  'PASS — G1..G6 (G6 expects the audit trigger)' AS result,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_status_allowed') AS status_allowlist,
  (SELECT pg_get_expr(indpred, indrelid) FROM pg_index
    WHERE indexrelid = 'public.import_batches_one_live_per_file'::regclass) AS live_predicate,
  (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'public.import_batches'::regclass AND attname = 'approved_by') AS approved_by_type,
  'execution half: npm run verify:approvalschema' AS and_then;
