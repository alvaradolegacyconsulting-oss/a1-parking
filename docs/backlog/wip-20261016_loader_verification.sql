-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — the loader
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261016_loader.sql. Re-runnable, read-only, no
-- transaction. Terminal SELECT returns the PASS row.
--
-- Execution half: npm run verify:loader  (on batch 8)
--
-- 🔴 A structural gate cannot see whether one transaction is actually
-- one transaction. What it CAN see is that the status UPDATE sits
-- inside the EXCEPTION block rather than after it — which is the
-- structural fact that makes "a failed load leaves the batch approved"
-- true. G4 asserts that by position.
--
-- ── 🔴 COMMENTS ARE STRIPPED BEFORE ANY SOURCE-TEXT ASSERTION ───────
-- The first version of this file failed G4 with
--   the status UPDATE is AFTER the EXCEPTION block
--   (update at 7065, exception at 3095)
-- and the loader was fine. `position('EXCEPTION' IN prosrc)` had found
-- the loader's own comment — "The EXCEPTION block creates a
-- subtransaction" — three thousand characters before the keyword.
--
-- G5 was broken the same way and would have failed next: it counts
-- occurrences of 'resident' and expects exactly one, and the comment
-- above the INSERT says role = 'resident' in quotes. Two, not one.
--
-- 🔴 THE GENERAL SHAPE: a comment that explains a rule defeats a gate
-- that checks for the rule, and the better the comment the more likely
-- it is to quote the thing being asserted. Presence checks survive it
-- (an extra mention still proves presence); COUNT and POSITION checks
-- do not. So v_src is stripped of `--` comments once, into v_body, and
-- every count and position below reads v_body. Measured after
-- stripping: EXCEPTION once, 'resident' once, import_batch_id three
-- times, tag_number zero.
--
-- 🔴 AND G4 FAILING MEANT G5..G8 NEVER RAN. A DO block aborts at the
-- first RAISE, so a false failure early in the file hides every
-- assertion after it. The error was loud, which is the only reason
-- this was not read as "the loader is broken and everything else is
-- fine".
--
-- 🔴 Every RAISE format string counted by hand; %% is a literal percent.

DO $do$
DECLARE
  v_def  TEXT;
  v_src  TEXT;
  v_body TEXT;   -- v_src with `--` comments removed; see the header

  v_n   INT;
  v_s   TEXT;
  v_a   INT;
  v_b   INT;
BEGIN
  -- ── G1. signature, DEFINER, pinned ───────────────────────────────
  IF to_regprocedure('public.load_import_batch(bigint, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: load_import_batch(bigint, text, jsonb) is absent. A different signature is a landmine — PostgREST answers PGRST202.';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.load_import_batch(bigint, text, jsonb)'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G1 FAIL: load_import_batch could not be read'; END IF;
  IF v_def !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'G1 FAIL: load_import_batch is not SECURITY DEFINER. It writes three tables that authenticated holds no matching grant on.';
  END IF;
  IF v_def !~ 'search_path' THEN
    RAISE EXCEPTION 'G1 FAIL: load_import_batch has no pinned search_path';
  END IF;
  RAISE NOTICE 'G1 ok: signature resolves, DEFINER, pinned search_path';

  -- ── G2. grants ───────────────────────────────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid = to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::oid
     AND a.grantee = 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'G2 FAIL: PUBLIC holds EXECUTE on load_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::oid
     AND r.rolname = 'anon';
  IF v_n > 0 THEN RAISE EXCEPTION 'G2 FAIL: anon holds EXECUTE on load_import_batch'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE p.oid = to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::oid
     AND r.rolname = 'authenticated' AND a.privilege_type = 'EXECUTE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G2 FAIL: authenticated cannot EXECUTE load_import_batch — the route calls it as the operator';
  END IF;
  RAISE NOTICE 'G2 ok: authenticated only; PUBLIC and anon revoked';

  -- ── G3. the guards in the body ───────────────────────────────────
  SELECT p.prosrc INTO v_src
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::oid;
  IF v_src IS NULL THEN RAISE EXCEPTION 'G3 FAIL: body unreadable'; END IF;
  -- 🔴 The code, without the prose about the code. See the header.
  v_body := regexp_replace(v_src, '--[^\n]*', '', 'g');
  IF length(v_body) >= length(v_src) THEN
    RAISE EXCEPTION 'G3 FAIL: stripping comments removed nothing (% vs % chars). Either the loader lost its comments or the strip stopped working — and every count below would then be reading prose.', length(v_body), length(v_src);
  END IF;
  IF v_src !~ 'is_active_import_operator' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not call the operator gate';
  END IF;
  IF v_src !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not lock the batch row. Two operators clicking Load at once would both read approved.';
  END IF;
  IF v_src !~ 'sha_mismatch' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not compare the file hash';
  END IF;
  IF v_src !~ 'auth\.uid\(\)' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not record who loaded it';
  END IF;
  IF v_src !~ '''approved''' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not restrict the source status to approved';
  END IF;
  IF v_src !~ 'jsonb_array_length\(p_rows\)' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not check the payload length against the submit-time count. Without it a truncated payload loads silently.';
  END IF;
  IF v_src !~ 'count\(DISTINCT' THEN
    RAISE EXCEPTION 'G3 FAIL: the loader does not check the distinct-resident count against the submit-time count';
  END IF;
  RAISE NOTICE 'G3 ok: operator gate, row lock, hash, auth.uid, approved-only, both payload-shape checks';

  -- ── 🔴 G4. all-or-nothing, asserted by POSITION ──────────────────
  -- The status UPDATE must be INSIDE the EXCEPTION block. If it sat
  -- after it, a failure would roll back the inserts and still mark the
  -- batch loaded — the worst of both: nothing written, nothing
  -- loadable, and no button that resolves it.
  v_a := position('UPDATE public.import_batches' IN v_body);
  v_b := position('EXCEPTION' IN v_body);
  IF v_a = 0 THEN RAISE EXCEPTION 'G4 FAIL: the loader never updates import_batches'; END IF;
  IF v_b = 0 THEN
    RAISE EXCEPTION 'G4 FAIL: the loader has no EXCEPTION block, so a failure propagates and the caller cannot tell a conflict from a transient fault.';
  END IF;
  IF v_a > v_b THEN
    RAISE EXCEPTION 'G4 FAIL: the status UPDATE is AFTER the EXCEPTION block (update at %, exception at %, measured on the comment-stripped body). A failure would roll back the inserts and still mark the batch loaded.', v_a, v_b;
  END IF;
  IF v_src !~ 'WHEN unique_violation' THEN
    RAISE EXCEPTION 'G4 FAIL: the loader does not distinguish a unique violation. Offering a Retry on one is a button that fails identically every time.';
  END IF;
  IF v_src !~ 'WHEN OTHERS' THEN
    RAISE EXCEPTION 'G4 FAIL: the loader has no catch-all, so an unexpected fault escapes as a raw Postgres error';
  END IF;
  RAISE NOTICE 'G4 ok: inserts and the status change share one EXCEPTION block; unique_violation separated from the catch-all';

  -- ── 🔴 G5. the staff-role assertion, BINDING ─────────────────────
  SELECT count(*) INTO v_n FROM regexp_matches(v_body, '''resident''', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G5 FAIL: ''resident'' appears % time(s) in the loader; want exactly 1. One place writes the role, so there is one place to read.', v_n;
  END IF;
  -- Every other role the product has. None may appear.
  FOR v_s IN SELECT unnest(ARRAY['admin','company_admin','manager','leasing_agent','driver']) LOOP
    IF v_body ~ ('''' || v_s || '''') THEN
      RAISE EXCEPTION 'G5 FAIL: the loader mentions the role %. Nothing in the ingest path can express a role, and this is the last place one could enter.', v_s;
    END IF;
  END LOOP;
  -- And it does not write parking tags, which are set_vehicle_tag's.
  IF v_body ~ 'vehicle_parking_tags' OR v_body ~ 'tag_number' THEN
    RAISE EXCEPTION 'G5 FAIL: the loader touches parking tags. vehicle_parking_tags has no write policy and set_vehicle_tag owns the property switch, the one-live-tag invariant and the audit.';
  END IF;
  RAISE NOTICE 'G5 ok: role=resident exactly once, no other role named, no tag writes';

  -- ── 🔴 G6. the stamp, on all three tables it writes ──────────────
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass, 'public.user_roles'::regclass)
     AND attname = 'import_batch_id' AND NOT attisdropped;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'G6 FAIL: import_batch_id is on % of the 3 tables the loader writes. Rollback deletes by it; an unstamped table has to be derived, and a reverse that derives its targets acts on rows it never created.', v_n;
  END IF;
  SELECT count(*), string_agg(tgname, ', ' ORDER BY tgname) INTO v_n, v_s FROM pg_trigger
   WHERE tgname IN ('residents_import_batch_write_once','vehicles_import_batch_write_once','user_roles_import_batch_write_once')
     AND NOT tgisinternal;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'G6 FAIL: % of 3 write-once guards present (%). An unguarded stamp can be forged or cleared from a client, and rollback believes it.', v_n, COALESCE(v_s, '(none)');
  END IF;
  -- The loader stamps it in all three INSERTs: once per column list.
  SELECT count(*) INTO v_n FROM regexp_matches(v_body, 'import_batch_id', 'g');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'G6 FAIL: the loader names import_batch_id % time(s); want exactly 3, one per INSERT. A missing one is rows rollback cannot find.', v_n;
  END IF;
  RAISE NOTICE 'G6 ok: three stamp columns, three write-once guards, three stamped INSERTs';

  -- ── G7. what the load records about itself ───────────────────────
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid = 'public.import_batches'::regclass
     AND attname IN ('loaded_at','loaded_by','loaded_resident_count','loaded_vehicle_count')
     AND NOT attisdropped;
  IF v_n <> 4 THEN RAISE EXCEPTION 'G7 FAIL: % of 4 loaded_* columns present', v_n; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.import_batches'::regclass
     AND conname = 'import_batches_loaded_complete';
  IF v_def IS NULL THEN RAISE EXCEPTION 'G7 FAIL: import_batches_loaded_complete is missing'; END IF;
  -- 🔴 Every branch must be provably FALSE for the rows it rejects. A
  -- CHECK accepts UNKNOWN, which is how the reject_errors shape shipped
  -- with a hole; IS NOT NULL never yields UNKNOWN.
  IF v_def !~ 'loaded_at IS NOT NULL' OR v_def !~ 'loaded_by IS NOT NULL' THEN
    RAISE EXCEPTION 'G7 FAIL: the loaded-complete check does not require both when and who — %', v_def;
  END IF;
  RAISE NOTICE 'G7 ok: four loaded_* columns and a NULL-safe completeness check';

  -- ── 🔴 G8. the backstop against a double load ────────────────────
  IF to_regclass('public.vehicles_plate_norm_uniq') IS NULL THEN
    RAISE EXCEPTION 'G8 FAIL: vehicles_plate_norm_uniq is gone. It is the one thing that would refuse a second load of the same plates even if every status check were bypassed.';
  END IF;
  SELECT pg_get_expr(indpred, indrelid) INTO v_def FROM pg_index
   WHERE indexrelid = 'public.vehicles_plate_norm_uniq'::regclass;
  IF v_def !~ '\mis_active\M' OR v_def !~ '\munder_review\M' THEN
    RAISE EXCEPTION 'G8 FAIL: the plate index predicate has changed (%). The loader writes is_active with status active precisely so its rows fall inside it.', v_def;
  END IF;
  RAISE NOTICE 'G8 ok: the plate uniqueness backstop is intact and the loader writes inside its predicate';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'loader' AS verification,
  'PASS — G1..G8 (source checks read the comment-stripped body)' AS result,
  to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::TEXT AS loader,
  (SELECT count(*)::INT FROM pg_attribute
    WHERE attrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass, 'public.user_roles'::regclass)
      AND attname = 'import_batch_id' AND NOT attisdropped) AS stamp_columns,
  (SELECT count(*)::INT FROM pg_trigger
    WHERE tgname LIKE '%\_import\_batch\_write\_once' AND NOT tgisinternal) AS write_once_guards,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_loaded_complete') AS loaded_complete,
  'execution half: npm run verify:loader' AS and_then;
