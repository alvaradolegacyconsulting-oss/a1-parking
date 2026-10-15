-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — approve + return RPCs
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261015_approve_and_return_rpcs.sql. Re-runnable,
-- read-only, no transaction. Terminal SELECT returns the PASS row.
--
-- Execution half: npm run verify:queue  (on batch 8)
--
-- 🔴 Signatures are resolved with to_regprocedure, not by matching
-- proname and counting arguments: parameter type modifiers get stripped
-- in catalog text, so a name-plus-arity match can pass against a
-- function with different types.
--
-- 🔴 Every RAISE format string below was counted by hand. One
-- malformed one voids every assertion in the block, because PL/pgSQL
-- checks them at compile time — see
-- wip-20261015_approval_queue_schema_verification.sql's header.

DO $do$
DECLARE
  v_def TEXT;
  v_n   INT;
  v_s   TEXT;
  v_fn  TEXT;
BEGIN
  -- ── G1. the three functions exist with the intended signatures ────
  IF to_regprocedure('public.is_active_import_operator()') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: is_active_import_operator() is absent';
  END IF;
  IF to_regprocedure('public.approve_import_batch(bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: approve_import_batch(bigint, text) is absent. A different signature is a landmine, not a near miss — PostgREST would answer PGRST202.';
  END IF;
  IF to_regprocedure('public.return_import_batch_to_company(bigint, text, jsonb, integer)') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: return_import_batch_to_company(bigint, text, jsonb, integer) is absent';
  END IF;
  RAISE NOTICE 'G1 ok: all three resolve at the intended signatures';

  -- ── G2. DEFINER, pinned search_path, on all three ────────────────
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_active_import_operator()',
    'public.approve_import_batch(bigint, text)',
    'public.return_import_batch_to_company(bigint, text, jsonb, integer)'
  ] LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_fn));
    -- 🔴 NULL FIRST, BECAUSE NULL PASSES EVERY TEST BELOW.
    -- pg_get_functiondef(NULL) is NULL, and `NULL !~ 'x'` is UNKNOWN,
    -- and `IF UNKNOWN THEN` skips the branch — so a missing function
    -- would sail through all of G2 and G3 reporting ok. G1 already
    -- proved these three resolve, but a gate that depends on an earlier
    -- gate for its own soundness is one edit away from not having one.
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'G2 FAIL: % could not be read from the catalog', v_fn;
    END IF;
    IF v_def !~ 'SECURITY DEFINER' THEN
      RAISE EXCEPTION 'G2 FAIL: % is not SECURITY DEFINER. It writes a table with no UPDATE grant to authenticated; as INVOKER it could not.', v_fn;
    END IF;
    IF v_def !~ 'search_path' THEN
      RAISE EXCEPTION 'G2 FAIL: % has no pinned search_path', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'G2 ok: all three are DEFINER with a pinned search_path';

  -- ── 🔴 G3. grants: authenticated only, PUBLIC and anon revoked ───
  -- A SECURITY DEFINER function inherits EXECUTE to PUBLIC by Supabase
  -- default, so the REVOKE is the load-bearing line and its absence is
  -- invisible without this check.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.is_active_import_operator()',
    'public.approve_import_batch(bigint, text)',
    'public.return_import_batch_to_company(bigint, text, jsonb, integer)'
  ] LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure(v_fn)::oid AND a.grantee = 0;   -- 0 is PUBLIC
    IF v_n > 0 THEN
      RAISE EXCEPTION 'G3 FAIL: PUBLIC holds EXECUTE on %', v_fn;
    END IF;
    SELECT count(*) INTO v_n
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = to_regprocedure(v_fn)::oid AND r.rolname = 'anon';
    IF v_n > 0 THEN
      RAISE EXCEPTION 'G3 FAIL: anon holds EXECUTE on %', v_fn;
    END IF;
    SELECT count(*) INTO v_n
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = to_regprocedure(v_fn)::oid
       AND r.rolname = 'authenticated' AND a.privilege_type = 'EXECUTE';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'G3 FAIL: authenticated does not hold EXECUTE on % — the routes call it as the operator, not as service_role', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'G3 ok: authenticated only on all three; PUBLIC and anon revoked';

  -- ── 🔴 G4. the operator gate reads is_active ─────────────────────
  v_def := pg_get_functiondef(to_regprocedure('public.is_active_import_operator()'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G4 FAIL: public.is_active_import_operator() could not be read'; END IF;
  IF v_def !~ 'ur\.is_active' THEN
    RAISE EXCEPTION 'G4 FAIL: is_active_import_operator does not require is_active. A deactivated operator would still be able to approve a batch — the gap requireAdmin() still has in TypeScript.';
  END IF;
  IF v_def !~ '''admin''' THEN
    RAISE EXCEPTION 'G4 FAIL: is_active_import_operator does not check for the admin role';
  END IF;
  RAISE NOTICE 'G4 ok: the operator gate requires an active admin';

  -- ── 🔴 G5. approve's own guards are in its body ──────────────────
  v_def := pg_get_functiondef(to_regprocedure('public.approve_import_batch(bigint, text)'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G5 FAIL: public.approve_import_batch(bigint, text) could not be read'; END IF;
  IF v_def !~ 'is_active_import_operator' THEN
    RAISE EXCEPTION 'G5 FAIL: approve_import_batch does not call the operator gate';
  END IF;
  IF v_def !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'G5 FAIL: approve_import_batch does not lock the row. Two operators clicking at once would both read submitted and both write.';
  END IF;
  IF v_def !~ 'sha_mismatch' THEN
    RAISE EXCEPTION 'G5 FAIL: approve_import_batch does not compare the file hash. An approval must be of bytes someone looked at.';
  END IF;
  IF v_def !~ 'auth\.uid\(\)' THEN
    RAISE EXCEPTION 'G5 FAIL: approve_import_batch does not record auth.uid() as the approver';
  END IF;
  IF v_def !~ '''submitted''' THEN
    RAISE EXCEPTION 'G5 FAIL: approve_import_batch does not restrict the source status to submitted';
  END IF;
  RAISE NOTICE 'G5 ok: operator gate, row lock, hash comparison, auth.uid(), submitted-only';

  -- ── 🔴 G6. return's own guards ───────────────────────────────────
  v_def := pg_get_functiondef(to_regprocedure('public.return_import_batch_to_company(bigint, text, jsonb, integer)'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G6 FAIL: public.return_import_batch_to_company(bigint, text, jsonb, integer) could not be read'; END IF;
  IF v_def !~ 'is_active_import_operator' THEN
    RAISE EXCEPTION 'G6 FAIL: return_import_batch_to_company does not call the operator gate';
  END IF;
  IF v_def !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'G6 FAIL: return_import_batch_to_company does not lock the row';
  END IF;
  IF v_def !~ 'jsonb_array_length' THEN
    RAISE EXCEPTION 'G6 FAIL: return_import_batch_to_company does not compare the count to the attached list. The count is the authority and must not understate the evidence.';
  END IF;
  IF v_def !~ 'reason_required' THEN
    RAISE EXCEPTION 'G6 FAIL: return_import_batch_to_company does not require a reason';
  END IF;
  -- Both source statuses, and no others.
  IF v_def !~ '''submitted''' OR v_def !~ '''approved''' THEN
    RAISE EXCEPTION 'G6 FAIL: return must accept both submitted and approved as the source status';
  END IF;
  IF v_def !~ '''rejected''' THEN
    RAISE EXCEPTION 'G6 FAIL: return does not write the rejected status. No new status was ruled, and rejected is what drops the batch out of the live duplicate index so the fixed file can come back.';
  END IF;
  RAISE NOTICE 'G6 ok: operator gate, row lock, count-vs-list, reason required, submitted/approved to rejected';

  -- ── 🔴 G7. still no client write path on the table ───────────────
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ') INTO v_n, v_s
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches' AND cmd <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G7 FAIL: % non-SELECT policy(ies) on import_batches: %. These RPCs are meant to be the only write path.', v_n, v_s;
  END IF;
  SELECT count(*), string_agg(DISTINCT a.privilege_type, ', ') INTO v_n, v_s
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid = 'public.import_batches'::regclass
     AND r.rolname IN ('authenticated','anon') AND a.privilege_type <> 'SELECT';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G7 FAIL: authenticated/anon hold % on import_batches', v_s;
  END IF;
  -- And the CA's read policy, which is how the returned error list
  -- reaches the company at all.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches'
     AND policyname = 'ib_company_admin_select';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G7 FAIL: ib_company_admin_select is missing. Without it a returned batch is invisible to the company it was returned to, and the attached error list reaches nobody.';
  END IF;
  RAISE NOTICE 'G7 ok: SELECT-only, both read policies present, no write path but the RPCs';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'approve + return RPCs' AS verification,
  'PASS — G1..G7' AS result,
  to_regprocedure('public.is_active_import_operator()')::TEXT AS operator_gate,
  to_regprocedure('public.approve_import_batch(bigint, text)')::TEXT AS approve,
  to_regprocedure('public.return_import_batch_to_company(bigint, text, jsonb, integer)')::TEXT AS return_to_company,
  (SELECT count(*)::INT FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'import_batches') AS policies_on_table,
  'execution half: npm run verify:queue' AS and_then;
