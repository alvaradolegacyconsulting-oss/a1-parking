-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — admin validate gate
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261015_admin_validate_gate.sql. Re-runnable, read-only,
-- no transaction. Terminal SELECT returns the PASS row AND prints the
-- new function's body, as ruled.
--
-- Execution half: npm run verify:validategate
--
-- ── 🔴 ON "ASSERT may_bulk_upload_at IS UNCHANGED BEFORE/AFTER" ─────
-- A literal before/after comparison is no longer available: the
-- migration has applied, so there is no "before" left in the database
-- to hash. Saying otherwise would be a gate asserting something it
-- cannot measure.
--
-- What IS available is the "before" of record — the function's source
-- in migrations/20261015_bulk_onboarding_bucket.sql, which is the text
-- that was applied and has never been replaced. So G2 embeds that body
-- verbatim and compares it to the live one token for token, with
-- whitespace normalised so a reformat cannot produce a false failure
-- while a changed predicate still can. The md5 of the live definition
-- is printed in the PASS row as the baseline to record for next time.
--
-- 🔴 AND A DO BLOCK IS ALL-OR-NOTHING AT COMPILE TIME. One malformed
-- RAISE format string anywhere voids every assertion in the block —
-- learned on this file's sibling, which died with
-- "42601: too many parameters specified for RAISE" and ran none of its
-- six gates while the migration's own PASS row said success. Every
-- format string below was counted by hand: %% is a literal percent and
-- takes no argument.

DO $do$
DECLARE
  v_live     TEXT;
  v_expected TEXT;
  v_def      TEXT;
  v_n        INT;
  v_s        TEXT;
BEGIN
  -- ── G1. the new helper exists and is shaped right ─────────────────
  IF to_regprocedure('public.may_bulk_validate_at(bigint)') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: may_bulk_validate_at(bigint) is absent';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure('public.may_bulk_validate_at(bigint)')) INTO v_def;
  IF v_def !~ 'SECURITY DEFINER' THEN
    RAISE EXCEPTION 'G1 FAIL: may_bulk_validate_at is not SECURITY DEFINER — the storage and RPC callers rely on it not needing companies to be readable';
  END IF;
  IF v_def !~ 'search_path' THEN
    RAISE EXCEPTION 'G1 FAIL: may_bulk_validate_at has no pinned search_path';
  END IF;
  IF v_def !~ '\mmay_bulk_upload_at\M' THEN
    RAISE EXCEPTION 'G1 FAIL: may_bulk_validate_at does not delegate to may_bulk_upload_at, so the customer half is a second copy rather than the same rule';
  END IF;
  -- The NULL guard on the admin branch. Without it an admin gets TRUE
  -- for a NULL property id, and bulk_validate_rows then compares every
  -- row against a NULL property and reports the file clean.
  IF v_def !~ 'p_property_id IS NOT NULL' THEN
    RAISE EXCEPTION 'G1 FAIL: the admin branch has no NULL-property guard';
  END IF;
  IF v_def !~ 'ur\.is_active' THEN
    RAISE EXCEPTION 'G1 FAIL: the admin branch does not require is_active';
  END IF;
  RAISE NOTICE 'G1 ok: DEFINER, pinned search_path, delegates the customer half, guards NULL, requires is_active';

  -- ── 🔴 G2. may_bulk_upload_at is byte-for-byte the applied text ───
  SELECT p.prosrc INTO v_live
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'may_bulk_upload_at';
  IF v_live IS NULL THEN RAISE EXCEPTION 'G2 FAIL: may_bulk_upload_at is absent'; END IF;

  -- Verbatim from migrations/20261015_bulk_onboarding_bucket.sql.
  v_expected :=
$expected$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.properties p ON p.id = p_property_id
      JOIN public.companies  c ON lower(trim(c.name)) = lower(trim(p.company))
     WHERE lower(trim(ur.email)) = lower(trim(auth.jwt() ->> 'email'))
       AND ur.role = 'company_admin'
       AND ur.is_active
       AND lower(trim(ur.company)) = lower(trim(p.company))
       AND p.is_active
       AND c.is_active
       AND c.account_state NOT IN ('suspended','cancelled')
       AND c.bulk_onboarding_enabled
  )
$expected$;

  IF md5(regexp_replace(btrim(v_live), '\s+', ' ', 'g'))
     IS DISTINCT FROM
     md5(regexp_replace(btrim(v_expected), '\s+', ' ', 'g')) THEN
    RAISE EXCEPTION E'G2 FAIL: may_bulk_upload_at is NOT the text that was applied. It must stay exactly as it is, because the storage INSERT policy bulk_csv_ca_insert calls it and any widening there becomes upload permission.\n--- live ---\n%\n--- expected ---\n%',
      v_live, v_expected;
  END IF;

  -- Independent of the hash, the predicates that must not have moved.
  IF v_live !~ '\mcompany_admin\M' THEN
    RAISE EXCEPTION 'G2 FAIL: may_bulk_upload_at no longer requires company_admin';
  END IF;
  IF v_live ~ 'role\s*=\s*''admin''' THEN
    RAISE EXCEPTION 'G2 FAIL: may_bulk_upload_at has gained an admin branch — that is upload permission, not validate permission';
  END IF;
  IF v_live ~ '\mOR\M' THEN
    RAISE EXCEPTION 'G2 FAIL: may_bulk_upload_at has gained an OR branch; the applied version has none';
  END IF;
  IF v_live ~ '\mmay_bulk_validate_at\M' THEN
    RAISE EXCEPTION 'G2 FAIL: may_bulk_upload_at references the new helper — the delegation is meant to run the other way';
  END IF;
  RAISE NOTICE 'G2 ok: may_bulk_upload_at matches the applied text, no OR, no admin branch';

  -- ── G3. the validator gates on the new helper and only that ──────
  SELECT p.prosrc INTO v_live
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'bulk_validate_rows';
  IF v_live IS NULL THEN RAISE EXCEPTION 'G3 FAIL: bulk_validate_rows is absent'; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_live, 'may_bulk_validate_at', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G3 FAIL: bulk_validate_rows calls may_bulk_validate_at % time(s), expected exactly 1', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_live, 'may_bulk_upload_at', 'g');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'G3 FAIL: bulk_validate_rows still calls may_bulk_upload_at % time(s) — the substitution was partial', v_n;
  END IF;
  -- The rest of the body is the function the rehearsal proved. These
  -- are its load-bearing landmarks, asserted so a "one substring"
  -- edit that was not one substring shows up here.
  IF v_live !~ 'property_not_in_scope' THEN
    RAISE EXCEPTION 'G3 FAIL: bulk_validate_rows no longer raises property_not_in_scope';
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_live, 'normalize_plate', 'g');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'G3 FAIL: normalize_plate appears % time(s), expected 3 — the body changed beyond the gate line', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_live, 'under_review', 'g');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'G3 FAIL: under_review appears % time(s), expected 2 — the body changed beyond the gate line', v_n;
  END IF;
  RAISE NOTICE 'G3 ok: one gate call, the old one gone, and the rest of the body intact (3 normalize_plate, 2 under_review)';

  -- ── G4. the storage policy still calls the NARROW gate ───────────
  -- 🔴 This is what the two-function split exists for. If the policy
  -- had been repointed at may_bulk_validate_at, an admin could upload
  -- a CSV into any property's prefix.
  SELECT count(*), string_agg(policyname, ', ') INTO v_n, v_s
    FROM pg_policies
   WHERE (qual ~ '\mmay_bulk_upload_at\M' OR with_check ~ '\mmay_bulk_upload_at\M');
  IF v_n <> 1 OR v_s IS DISTINCT FROM 'bulk_csv_ca_insert' THEN
    RAISE EXCEPTION 'G4 FAIL: expected only bulk_csv_ca_insert to call may_bulk_upload_at, found % (%)', v_n, COALESCE(v_s, '(none)');
  END IF;
  SELECT count(*), string_agg(policyname, ', ') INTO v_n, v_s
    FROM pg_policies
   WHERE (qual ~ '\mmay_bulk_validate_at\M' OR with_check ~ '\mmay_bulk_validate_at\M');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: % policy(ies) now call may_bulk_validate_at (%). No policy may: it answers "may you CHECK a file", and a policy asking it would turn that into "may you WRITE one".', v_n, v_s;
  END IF;
  RAISE NOTICE 'G4 ok: the upload policy still calls the narrow gate, and no policy calls the wide one';

  -- ── G5. grants on the new helper ─────────────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND p.proname = 'may_bulk_validate_at'
     AND r.rolname = 'anon';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G5 FAIL: anon holds EXECUTE on may_bulk_validate_at. A SECURITY DEFINER function inherits EXECUTE to PUBLIC by Supabase default; the REVOKE is not optional.';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE n.nspname = 'public' AND p.proname = 'may_bulk_validate_at'
     AND a.grantee = 0;   -- 0 is PUBLIC
  IF v_n > 0 THEN
    RAISE EXCEPTION 'G5 FAIL: PUBLIC holds EXECUTE on may_bulk_validate_at';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND p.proname = 'may_bulk_validate_at'
     AND r.rolname = 'authenticated' AND a.privilege_type = 'EXECUTE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G5 FAIL: authenticated does not hold EXECUTE on may_bulk_validate_at — the CA preview and the admin review both call it as themselves';
  END IF;
  RAISE NOTICE 'G5 ok: authenticated only; PUBLIC and anon revoked';
END
$do$;

-- ── the PASS row, with the new function's body printed as ruled ─────
SELECT
  'admin validate gate' AS verification,
  'PASS — G1..G5' AS result,
  (SELECT md5(pg_get_functiondef(to_regprocedure('public.may_bulk_upload_at(bigint)'))))
    AS may_bulk_upload_at_md5_baseline,
  (SELECT pg_get_functiondef(to_regprocedure('public.may_bulk_validate_at(bigint)')))
    AS may_bulk_validate_at_body,
  (SELECT substring(p.prosrc from 'IF NOT [^;]*;') FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'bulk_validate_rows')
    AS the_one_line_that_changed,
  'execution half: npm run verify:validategate' AS and_then;
