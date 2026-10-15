-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — same-day rollback
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261016_rollback.sql. Re-runnable, read-only, no
-- transaction. Terminal SELECT returns the PASS row.
--
-- Execution half: npm run verify:rollback  (on batch 8)
--
-- 🔴 Comments are stripped before every count and position check, for
-- the reason the loader verification records: a comment that explains a
-- rule defeats a gate that checks for the rule. Expected counts were
-- measured after stripping, not reasoned about.
--
-- 🔴 Every RAISE format string counted by hand; %% is a literal percent.

DO $do$
DECLARE
  v_def  TEXT;
  v_src  TEXT;
  v_body TEXT;
  v_n    INT;
  v_s    TEXT;
  v_a    INT;
  v_b    INT;
BEGIN
  -- ── G1. signature, DEFINER, pinned, grants ───────────────────────
  IF to_regprocedure('public.rollback_import_batch(bigint)') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: rollback_import_batch(bigint) is absent';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.rollback_import_batch(bigint)'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G1 FAIL: rollback_import_batch could not be read'; END IF;
  IF v_def !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'G1 FAIL: not SECURITY DEFINER. It deletes from three tables and reads auth.users, neither of which authenticated can do.';
  END IF;
  IF v_def !~ 'search_path' THEN RAISE EXCEPTION 'G1 FAIL: no pinned search_path'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid = to_regprocedure('public.rollback_import_batch(bigint)')::oid AND a.grantee = 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'G1 FAIL: PUBLIC holds EXECUTE on rollback_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.rollback_import_batch(bigint)')::oid AND r.rolname = 'anon';
  IF v_n > 0 THEN RAISE EXCEPTION 'G1 FAIL: anon holds EXECUTE on rollback_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.rollback_import_batch(bigint)')::oid
     AND r.rolname = 'authenticated' AND a.privilege_type = 'EXECUTE';
  IF v_n <> 1 THEN RAISE EXCEPTION 'G1 FAIL: authenticated cannot EXECUTE it — the route calls it as the operator'; END IF;
  RAISE NOTICE 'G1 ok: DEFINER, pinned, authenticated only';

  SELECT p.prosrc INTO v_src
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.rollback_import_batch(bigint)')::oid;
  v_body := regexp_replace(v_src, '--[^\n]*', '', 'g');
  IF length(v_body) >= length(v_src) THEN
    RAISE EXCEPTION 'G1 FAIL: stripping comments removed nothing (% vs % chars) — every count below would be reading prose.', length(v_body), length(v_src);
  END IF;

  -- ── G2. the gates ────────────────────────────────────────────────
  IF v_body !~ 'is_active_import_operator' THEN
    RAISE EXCEPTION 'G2 FAIL: no operator gate';
  END IF;
  IF v_body !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'G2 FAIL: the batch row is not locked. Two operators clicking Roll back at once would both read loaded.';
  END IF;
  IF v_body !~ '''loaded''' THEN
    RAISE EXCEPTION 'G2 FAIL: the source status is not restricted to loaded';
  END IF;
  IF v_body !~ 'auth\.uid\(\)' THEN
    RAISE EXCEPTION 'G2 FAIL: it does not record who rolled it back';
  END IF;
  RAISE NOTICE 'G2 ok: operator gate, row lock, loaded-only, auth.uid';

  -- ── 🔴 G3. same day means the PROPERTY'S day ─────────────────────
  IF v_body !~ 'current_date_central' THEN
    RAISE EXCEPTION 'G3 FAIL: same-day is not decided by current_date_central(). The session is UTC and the business is in Texas: a batch loaded at 8pm Central is already tomorrow in UTC, so CURRENT_DATE would refuse an undo an hour after the mistake.';
  END IF;
  IF v_body ~ '\mCURRENT_DATE\M' THEN
    RAISE EXCEPTION 'G3 FAIL: it uses CURRENT_DATE somewhere. That is the bug the 2026-08-05 sweep removed from pm_plate_lookup.';
  END IF;
  IF v_body !~ 'America/Chicago' THEN
    RAISE EXCEPTION 'G3 FAIL: loaded_at is not converted to Central before being compared to a Central date. Comparing a UTC instant to a Central date is off by the offset for part of every day.';
  END IF;
  IF v_body !~ 'not_same_day' THEN
    RAISE EXCEPTION 'G3 FAIL: there is no same-day refusal';
  END IF;
  -- A batch marked loaded with no load time cannot be judged.
  IF v_body !~ 'no_load_time' THEN
    RAISE EXCEPTION 'G3 FAIL: a NULL loaded_at is not refused. Same-day cannot be decided without it, and a NULL comparison would make the refusal UNKNOWN — which an IF treats as false and lets through.';
  END IF;
  RAISE NOTICE 'G3 ok: same-day via current_date_central, Central conversion, no CURRENT_DATE, NULL load time refused';

  -- ── 🔴 G4. a claimed resident stops everything ───────────────────
  IF v_body !~ 'already_claimed' THEN
    RAISE EXCEPTION 'G4 FAIL: there is no refusal for a resident who has claimed. A login is the one thing no transaction can undo.';
  END IF;
  IF v_body !~ 'auth\.users' THEN
    RAISE EXCEPTION 'G4 FAIL: it does not look at auth.users, so it cannot know who has claimed';
  END IF;
  -- Listed, not counted: the operator must be able to see who.
  IF v_body !~ 'jsonb_agg' OR v_body !~ '''email''' THEN
    RAISE EXCEPTION 'G4 FAIL: the claimed residents are not listed by address. "3 residents have logins" is not something anyone can act on.';
  END IF;
  -- 🔴 And it must NOT delete auth users.
  IF v_body ~ 'DELETE FROM auth' OR v_body ~ 'auth\.admin' THEN
    RAISE EXCEPTION 'G4 FAIL: it touches auth accounts. No auth-user deletion, as ruled — and no transaction could cover it anyway.';
  END IF;
  RAISE NOTICE 'G4 ok: claimed residents refuse the whole rollback, by name, and no auth account is touched';

  -- ── 🔴 G5. dependents are DISCOVERED, not listed ─────────────────
  IF v_body !~ 'pg_constraint' THEN
    RAISE EXCEPTION 'G5 FAIL: the dependent check does not walk pg_constraint. A hardcoded list of referencing tables silently misses the next one added, and an FK added from the dashboard never enters the repo at all.';
  END IF;
  IF v_body !~ 'has_dependents' THEN
    RAISE EXCEPTION 'G5 FAIL: there is no dependent refusal';
  END IF;
  IF v_body !~ 'confrelid' THEN
    RAISE EXCEPTION 'G5 FAIL: the walk does not filter on the referenced table';
  END IF;
  -- A composite FK read through conkey[1] would be half-checked, and
  -- half-checked reports "no dependents".
  IF v_body !~ 'array_length\(con\.conkey, 1\) = 1' THEN
    RAISE EXCEPTION 'G5 FAIL: the walk does not restrict to single-column FKs, so a composite one would be half-checked and report clean.';
  END IF;
  -- The foreign_key_violation catch is the backstop for anything the
  -- pre-flight missed.
  IF v_body !~ 'WHEN foreign_key_violation' THEN
    RAISE EXCEPTION 'G5 FAIL: no foreign_key_violation handler. Something the pre-flight missed would escape as a raw Postgres error.';
  END IF;
  RAISE NOTICE 'G5 ok: dependents discovered from pg_constraint, single-column only, with an FK-violation backstop';

  -- ── 🔴 G6. all-or-nothing, by position ───────────────────────────
  v_a := position('UPDATE public.import_batches' IN v_body);
  v_b := position('EXCEPTION' IN v_body);
  IF v_a = 0 THEN RAISE EXCEPTION 'G6 FAIL: it never updates import_batches'; END IF;
  IF v_b = 0 THEN RAISE EXCEPTION 'G6 FAIL: no EXCEPTION block'; END IF;
  IF v_a > v_b THEN
    RAISE EXCEPTION 'G6 FAIL: the status UPDATE is AFTER the EXCEPTION block (update at %, exception at %, on the comment-stripped body). A failure would undo the deletes and still mark the batch rolled back — nothing removed, nothing loadable.', v_a, v_b;
  END IF;
  -- Three deletes, one per stamped table, all by the stamp.
  SELECT count(*) INTO v_n FROM regexp_matches(v_body, 'DELETE FROM public\.', 'g');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'G6 FAIL: % DELETE statement(s); want exactly 3 — vehicles, user_roles, residents.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_body, 'import_batch_id = p_batch_id', 'g');
  IF v_n < 3 THEN
    RAISE EXCEPTION 'G6 FAIL: only % delete(s) are scoped by import_batch_id. A delete scoped any other way removes rows the batch never created.', v_n;
  END IF;
  FOR v_s IN SELECT unnest(ARRAY['public.vehicles','public.user_roles','public.residents']) LOOP
    IF v_body !~ ('DELETE FROM ' || replace(v_s, '.', '\.')) THEN
      RAISE EXCEPTION 'G6 FAIL: % is never deleted from. The loader writes all three, so a rollback that skips one leaves rows behind that nothing will ever find.', v_s;
    END IF;
  END LOOP;
  RAISE NOTICE 'G6 ok: three deletes, all by the stamp, sharing one EXCEPTION block with the status change';

  -- ── G7. the audit trigger still covers the transition ────────────
  SELECT count(*), string_agg(tgname, ', ') INTO v_n, v_s FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal;
  IF v_n <> 1 OR v_s IS DISTINCT FROM 'import_batches_status_audit' THEN
    RAISE EXCEPTION 'G7 FAIL: expected the audit trigger and only it, found % (%). The ruling says the trigger records the rollback, so without it the transition is unrecorded.', v_n, COALESCE(v_s, '(none)');
  END IF;
  -- rolled_back must be a reachable status and must NOT be live, so
  -- the company can send a corrected file.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass AND conname = 'import_batches_status_allowed';
  IF v_def !~ '''rolled_back''' THEN
    RAISE EXCEPTION 'G7 FAIL: rolled_back is not in the status allowlist';
  END IF;
  SELECT pg_get_expr(indpred, indrelid) INTO v_def FROM pg_index
   WHERE indexrelid = 'public.import_batches_one_live_per_file'::regclass;
  IF v_def ~ '''rolled_back''' THEN
    RAISE EXCEPTION 'G7 FAIL: rolled_back counts as live for the duplicate guard, so a corrected file could not be resubmitted after a rollback — %', v_def;
  END IF;
  RAISE NOTICE 'G7 ok: audited by the trigger, rolled_back allowed and not live';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'rollback' AS verification,
  'PASS — G1..G7 (source checks read the comment-stripped body)' AS result,
  to_regprocedure('public.rollback_import_batch(bigint)')::TEXT AS rollback_fn,
  (SELECT count(*)::INT FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass))
    AS fks_discovered,
  public.current_date_central() AS today_central,
  'execution half: npm run verify:rollback' AS and_then;
