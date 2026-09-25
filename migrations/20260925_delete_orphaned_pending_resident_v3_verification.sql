-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — delete_orphaned_pending_resident v3
-- ════════════════════════════════════════════════════════════════════
--
-- Pairs with 20260925_delete_orphaned_pending_resident_v3.sql.
-- No BEGIN/COMMIT. Re-runnable. Terminal SELECT returns a PASS row.
--
-- 🔴 WHAT THIS FILE CAN AND CANNOT MEASURE
--
-- The function's first statement is `auth.jwt() ->> 'email'`. The SQL
-- editor has no JWT, so a direct call can only ever reach the
-- 'unauthenticated' guard. VS5 asserts exactly that and nothing more —
-- it proves the function EXECUTES rather than merely parses, which a
-- structural gate cannot, but it does not exercise a delete.
--
-- VS6 covers the part that actually broke, by evaluating the v3
-- predicate itself against live auth.users rows: it must PERMIT for a
-- banned address and BLOCK for an unbanned one. That is the whole
-- difference between v2 and v3, tested as an expression.
--
-- The end-to-end proof is the operator positive control, on BOTH the
-- manager and company_admin add-resident paths. This file does not
-- replace it and does not claim to.

-- ── VS1: exact signature still resolves ─────────────────────────────
-- to_regprocedure, not a proname lookup: parameter type MODIFIERS are
-- stripped from pg_proc, so matching on text would pass a signature
-- that no caller can actually reach.
DO $$
BEGIN
  IF to_regprocedure('public.delete_orphaned_pending_resident(text, text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.delete_orphaned_pending_resident(text, text) does not resolve';
  END IF;
END $$;

-- ── VS2: p_property DEFAULT NULL survived the replace ───────────────
-- 🔴 CREATE OR REPLACE DROPS parameter defaults unless restated. Every
-- caller passes two arguments today, so a dropped default would not
-- show up until something called the one-arg form.
DO $$
DECLARE v_defaults int;
BEGIN
  SELECT pronargdefaults INTO v_defaults
    FROM pg_proc
   WHERE oid = to_regprocedure('public.delete_orphaned_pending_resident(text, text)');
  IF v_defaults IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'VS2 FAIL: expected exactly 1 parameter default (p_property), found %', coalesce(v_defaults::text, 'NULL');
  END IF;
END $$;

-- ── VS3: the guard is narrowed, in all three branches ───────────────
-- Asserts the measurement, not the intent: three occurrences of
-- banned_until, one per branch, and the v3 audit source. A body with
-- two would mean a branch was missed — which is precisely how v2's
-- guard could have been partial and nobody would have known.
DO $$
DECLARE
  v_body     text;
  v_banned   int;
  v_notexist int;
BEGIN
  SELECT prosrc INTO v_body
    FROM pg_proc
   WHERE oid = to_regprocedure('public.delete_orphaned_pending_resident(text, text)');

  v_banned   := (length(v_body) - length(replace(v_body, 'banned_until', ''))) / length('banned_until');
  v_notexist := (length(v_body) - length(replace(v_body, 'NOT EXISTS', ''))) / length('NOT EXISTS');

  IF v_notexist <> 3 THEN
    RAISE EXCEPTION 'VS3 FAIL: expected 3 NOT EXISTS guards (manager, company_admin, admin), found %', v_notexist;
  END IF;
  -- two mentions per branch: the IS NULL test and the <= now() test
  IF v_banned <> 6 THEN
    RAISE EXCEPTION 'VS3 FAIL: expected 6 banned_until references (2 per branch x 3), found %. A branch still carries the v2 bare auth-existence guard.', v_banned;
  END IF;
  IF position('delete_orphaned_pending_resident_v3' IN v_body) = 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: audit source is not bumped to _v3';
  END IF;
  IF position('delete_orphaned_pending_resident_v2' IN v_body) > 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: body still emits the _v2 audit source';
  END IF;
END $$;

-- ── VS4: grants unchanged ───────────────────────────────────────────
-- pg_proc.proacl, NOT information_schema.routine_privileges — the
-- information_schema views under-report grants.
DO $$
DECLARE v_acl aclitem[];
BEGIN
  SELECT proacl INTO v_acl
    FROM pg_proc
   WHERE oid = to_regprocedure('public.delete_orphaned_pending_resident(text, text)');

  IF v_acl IS NULL THEN
    -- NULL proacl means DEFAULT privileges, which for a function is
    -- EXECUTE to PUBLIC. Fail closed: that is the opposite of intent.
    RAISE EXCEPTION 'VS4 FAIL: proacl is NULL (default = EXECUTE TO PUBLIC). The REVOKEs did not apply.';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.delete_orphaned_pending_resident(text, text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VS4 FAIL: authenticated cannot EXECUTE';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('public.delete_orphaned_pending_resident(text, text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VS4 FAIL: anon can EXECUTE';
  END IF;
END $$;

-- ── VS5: EXECUTION gate ─────────────────────────────────────────────
-- Structural gates prove the text exists, not that the function runs.
-- Calling it here must raise 'unauthenticated' — the editor has no JWT.
-- Any OTHER sqlstate means the body fails before its first guard.
DO $$
DECLARE v_returned int;
BEGIN
  BEGIN
    SELECT public.delete_orphaned_pending_resident('vs5-probe@example.invalid', 'VS5 Probe Property') INTO v_returned;

    -- It executed and returned, which means this session DOES carry a
    -- JWT. Execution is proven either way, so this is a pass — but say
    -- so loudly, because the function ALWAYS writes an audit row and one
    -- just landed in production.
    IF v_returned <> 0 THEN
      RAISE EXCEPTION 'VS5 FAIL: probe address deleted % row(s). It should match nothing.', v_returned;
    END IF;
    RAISE WARNING 'VS5 executed WITH a JWT and returned 0 (correct for an address that matches nothing). 🔴 A ROLLBACK_DELETE_RESIDENT audit row was written for vs5-probe@example.invalid — delete it if probe rows in audit_logs matter to you.';
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      -- RAISE EXCEPTION 'unauthenticated' is P0001. Discriminate on the
      -- MESSAGE: P0001 is shared by every RAISE in this body, so the
      -- sqlstate alone would also accept 'role_not_authorized' or
      -- 'manager_scope_required' — different failures entirely.
      IF SQLERRM <> 'unauthenticated' THEN
        RAISE EXCEPTION 'VS5 FAIL: executed but raised "%" — expected "unauthenticated"', SQLERRM;
      END IF;
      -- No JWT, no artifact. This is the expected editor path.
  END;
END $$;

-- ── VS6: the predicate that broke, tested as an expression ──────────
-- v2 blocked whenever ANY auth.users row existed. v3 must block only on
-- an UNBANNED one. Evaluated against live rows, so it measures the real
-- column semantics rather than a restatement of them.
DO $$
DECLARE
  v_banned_email   text;
  v_unbanned_email text;
  v_permits        boolean;
  v_blocks         boolean;
BEGIN
  SELECT lower(email) INTO v_banned_email
    FROM auth.users
   WHERE banned_until IS NOT NULL AND banned_until > now()
   LIMIT 1;

  SELECT lower(email) INTO v_unbanned_email
    FROM auth.users
   WHERE banned_until IS NULL OR banned_until <= now()
   LIMIT 1;

  -- 🔴 Absence is not a pass. If there is no banned account to test
  -- against, this gate measured nothing and must say so.
  IF v_banned_email IS NULL THEN
    RAISE EXCEPTION 'VS6 COULD NOT MEASURE: no currently-banned auth.users row exists, so the permit case is untestable. This is NOT a pass.';
  END IF;
  IF v_unbanned_email IS NULL THEN
    RAISE EXCEPTION 'VS6 COULD NOT MEASURE: no unbanned auth.users row exists, so the block case is untestable. This is NOT a pass.';
  END IF;

  -- The guard PERMITS when the NOT EXISTS is true.
  SELECT NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE lower(auth.users.email) = v_banned_email
       AND (auth.users.banned_until IS NULL OR auth.users.banned_until <= now())
  ) INTO v_permits;

  SELECT NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE lower(auth.users.email) = v_unbanned_email
       AND (auth.users.banned_until IS NULL OR auth.users.banned_until <= now())
  ) INTO v_blocks;

  IF NOT v_permits THEN
    RAISE EXCEPTION 'VS6 FAIL: a BANNED address (%) still blocks the delete. This is the v2 bug.', v_banned_email;
  END IF;
  IF v_blocks THEN
    RAISE EXCEPTION 'VS6 FAIL: an UNBANNED address (%) does NOT block the delete. The guard is not protecting live logins.', v_unbanned_email;
  END IF;
END $$;

-- ── PASS row ────────────────────────────────────────────────────────
SELECT
  'PASS'                                                      AS result,
  'VS1 signature (text, text) resolves'                       AS vs1,
  'VS2 p_property DEFAULT preserved'                          AS vs2,
  'VS3 3 guards, 6 banned_until refs, source _v3'             AS vs3,
  'VS4 authenticated EXECUTE; anon and PUBLIC revoked'        AS vs4,
  'VS5 executes (unauthenticated without a JWT, else 0)'       AS vs5,
  'VS6 predicate permits banned, blocks unbanned'             AS vs6,
  'END-TO-END IS THE OPERATOR CONTROL ON BOTH PATHS'          AS still_required;
