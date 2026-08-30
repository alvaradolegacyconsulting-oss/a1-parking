-- ══════════════════════════════════════════════════════════════════════
-- 20260830_space_payments_v1_table_verification.sql
--
-- Paired verification for 20260830_space_payments_v1_table.
-- v2 pattern: no BEGIN/COMMIT wrap; terminal SELECT returns one PASS
-- row on success; any gate failure surfaces via RAISE EXCEPTION.
--
-- ── 12 GATES ────────────────────────────────────────────────────────
--   STRUCTURAL
--     VQ1  table exists
--     VQ2  every column present with expected type + nullability
--     VQ3  CHECK amount > 0 present
--     VQ4  CHECK period_month = date_trunc('month', period_month)::date
--     VQ5  CHECK void coherence (all-three-null or all-three-set)
--     VQ6  FK on space_id with ON DELETE RESTRICT
--     VQ7  3 indexes present
--     VQ8  RLS enabled
--   🔴 GRANTS — the commit's main claim
--     VQ9  authenticated has SELECT
--     VQ10 authenticated does NOT have INSERT, UPDATE, or DELETE
--          (assertion of ABSENCE — using to_regprocedure-style
--          COUNT(*)=0-must-mean-truly-zero discipline per Mateo Aug 29;
--          the gate reads information_schema.role_table_grants directly,
--          no fragile string filter)
--   🔴 EXECUTION — RLS + grants under real role
--     VQ11 impersonated Test-LEGACY manager SELECTs their own probe row
--     VQ12 same manager's INSERT is REJECTED with permission_denied
--          (SQLSTATE 42501 — from grants, before RLS check)
--     VQ13 impersonated unauthorized role (resident preferred, else
--          cross-company user) SEES ZERO ROWS — NOT an exception. RLS
--          filters. A test expecting an exception false-passes.
--   AUDIT
--     VQ14 schema audit row present
--
-- ── PROBE ROW LIFECYCLE ─────────────────────────────────────────────
-- One synthetic Test-LEGACY probe row created as service_role (current
-- SQL Editor role bypasses RLS) BEFORE the execution gates. Deleted at
-- the end. If any execution gate raises, the row survives; cleanup
-- one-liner at the bottom of the file.
--
-- ── EXECUTION GATE PREREQ — SET LOCAL ROLE + JWT ────────────────────
-- The SQL Editor typically runs as service_role or postgres, which
-- BYPASS RLS. To test RLS as it applies to real users, each execution
-- DO block does:
--   PERFORM set_config('role', 'authenticated', true);
--   PERFORM set_config('request.jwt.claims',
--                       json_build_object('email', v_email)::text, true);
-- LOCAL settings are transaction-scoped; each DO block is its own
-- transaction under autocommit, so the role reverts when the block
-- exits — no explicit RESET needed between blocks.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ1: table exists ───────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.space_payments') IS NULL THEN
    RAISE EXCEPTION 'VQ1 FAIL: public.space_payments does not exist. CREATE TABLE did not run.';
  END IF;
END $$;

-- ── VQ2: columns with expected type + nullability ───────────────────
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  WITH expected(name, dtype, nullable) AS (VALUES
    ('id',                'bigint',                     'NO'),
    ('space_id',          'bigint',                     'NO'),
    ('company',           'text',                       'NO'),
    ('property',          'text',                       'NO'),
    ('space_label',       'text',                       'NO'),
    ('period_month',      'date',                       'NO'),
    ('amount',            'numeric',                    'NO'),
    ('method',            'text',                       'YES'),
    ('resident_email',    'text',                       'YES'),
    ('resident_name',     'text',                       'YES'),
    ('unit',              'text',                       'YES'),
    ('note',              'text',                       'YES'),
    ('recorded_by_email', 'text',                       'NO'),
    ('recorded_at',       'timestamp with time zone',   'NO'),
    ('voided_at',         'timestamp with time zone',   'YES'),
    ('voided_by_email',   'text',                       'YES'),
    ('void_reason',       'text',                       'YES')
  )
  SELECT string_agg(e.name || ' (want ' || e.dtype || '/' || e.nullable || ', got ' ||
                    COALESCE(c.data_type, 'MISSING') || '/' ||
                    COALESCE(c.is_nullable, 'MISSING') || ')', ', ')
    INTO v_missing
    FROM expected e
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = 'space_payments' AND c.column_name = e.name
   WHERE c.column_name IS NULL
      OR c.data_type <> e.dtype
      OR c.is_nullable <> e.nullable;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VQ2 FAIL: column shape mismatch — %', v_missing;
  END IF;
END $$;

-- ── VQ3: CHECK amount > 0 ──────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.space_payments'::regclass
       AND conname = 'space_payments_amount_positive'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'VQ3 FAIL: CHECK space_payments_amount_positive missing';
  END IF;
END $$;

-- ── VQ4: CHECK period_month first-of-month ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.space_payments'::regclass
       AND conname = 'space_payments_period_first_of_month'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'VQ4 FAIL: CHECK space_payments_period_first_of_month missing';
  END IF;
END $$;

-- ── VQ5: CHECK void coherence ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.space_payments'::regclass
       AND conname = 'space_payments_void_coherence'
       AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'VQ5 FAIL: CHECK space_payments_void_coherence missing';
  END IF;
END $$;

-- ── VQ6: FK ON DELETE RESTRICT ──────────────────────────────────────
DO $$
DECLARE
  v_confdeltype "char";
BEGIN
  SELECT confdeltype INTO v_confdeltype
    FROM pg_constraint
   WHERE conrelid = 'public.space_payments'::regclass
     AND contype  = 'f'
     AND (SELECT conname FROM pg_constraint c2 WHERE c2.oid = pg_constraint.oid) LIKE '%space_id%';
  IF v_confdeltype IS NULL THEN
    -- Fallback lookup by referenced-column name
    SELECT confdeltype INTO v_confdeltype
      FROM pg_constraint
     WHERE conrelid = 'public.space_payments'::regclass
       AND contype  = 'f'
       AND confrelid = 'public.spaces'::regclass;
  END IF;
  IF v_confdeltype IS NULL THEN
    RAISE EXCEPTION 'VQ6 FAIL: FK from space_payments.space_id to spaces not found';
  END IF;
  -- confdeltype: 'r' = RESTRICT, 'a' = NO ACTION, 'c' = CASCADE, 'n' = SET NULL, 'd' = SET DEFAULT
  IF v_confdeltype <> 'r' THEN
    RAISE EXCEPTION 'VQ6 FAIL: FK on space_id has ON DELETE type=% (want r=RESTRICT). Hard-delete of a space would % payment rows — catastrophic for the append-only ledger.',
      v_confdeltype,
      CASE v_confdeltype WHEN 'c' THEN 'CASCADE-delete' WHEN 'n' THEN 'orphan' WHEN 'a' THEN 'quietly break' ELSE 'unpredictably affect' END;
  END IF;
END $$;

-- ── VQ7: 3 indexes present ──────────────────────────────────────────
DO $$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT array_agg(want) INTO v_missing
    FROM (VALUES
      ('space_payments_space_period_idx'),
      ('space_payments_company_period_idx'),
      ('space_payments_resident_email_lower_idx')
    ) AS w(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename  = 'space_payments'
        AND indexname  = w.want
   );
  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ7 FAIL: missing indexes: %', v_missing;
  END IF;
END $$;

-- ── VQ8: RLS enabled ────────────────────────────────────────────────
DO $$
DECLARE
  v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class
   WHERE oid = 'public.space_payments'::regclass;
  IF NOT COALESCE(v_rls, false) THEN
    RAISE EXCEPTION 'VQ8 FAIL: RLS not enabled on public.space_payments';
  END IF;
END $$;

-- ── VQ9: authenticated has SELECT ───────────────────────────────────
DO $$
DECLARE
  v_has_select INT;
BEGIN
  SELECT COUNT(*) INTO v_has_select
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name   = 'space_payments'
     AND grantee      = 'authenticated'
     AND privilege_type = 'SELECT';
  IF v_has_select <> 1 THEN
    RAISE EXCEPTION 'VQ9 FAIL: authenticated missing SELECT grant on space_payments (count=%). No reader can access.', v_has_select;
  END IF;
END $$;

-- ── VQ10: 🔴 authenticated does NOT have INSERT/UPDATE/DELETE ───────
-- The commit's main claim. Assertion of ABSENCE; a broken filter
-- always returns 0 = pass would be catastrophic, so we filter on the
-- exact grantee + IN-list of privilege types and require count=0.
DO $$
DECLARE
  v_bad_grants TEXT;
BEGIN
  SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) INTO v_bad_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name   = 'space_payments'
     AND grantee      = 'authenticated'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad_grants IS NOT NULL THEN
    RAISE EXCEPTION 'VQ10 FAIL: authenticated has write grants (%). Append-only-by-grant invariant broken. Every DEFINER RPC design depends on this being empty. Revoke and re-run.',
      v_bad_grants;
  END IF;
END $$;

-- ── SETUP for VQ11-VQ13 — insert probe row as current (superuser) ──
-- Runs as SQL Editor's default role (service_role/postgres), bypassing
-- RLS. Provides a Test-LEGACY row for the manager SELECT gate to find
-- and for the cross-role gate to be filtered out from.
--
-- 🔴 2026-08-30 REWRITE after VQ11 mis-diagnosed an empty-table state
-- as "RLS filtering." Two changes:
--   1. period_month uses date_trunc('month', CURRENT_DATE)::date —
--      NOT date_trunc('month', now())::date. now() is TIMESTAMPTZ; the
--      cast to date depends on session timezone and can land on the
--      last day of the PRIOR month, tripping the first-of-month CHECK.
--      CURRENT_DATE is a bare DATE and stays first-of-month
--      unambiguously.
--   2. Explicit ROW_COUNT check after INSERT — RAISE loudly if 0 rows
--      landed. Silent 0-row INSERT was the class that produced a
--      confidently-wrong VQ11 message. A separate FIXTURE gate below
--      the SETUP block then re-verifies existence before VQ11 runs,
--      distinguishing "SETUP failed" from "RLS filtered."
DO $$
DECLARE
  v_probe_space_id  BIGINT;
  v_probe_id        BIGINT;
  v_rowcount        INT;
BEGIN
  -- Find any Test-LEGACY space to attach the probe to
  SELECT id INTO v_probe_space_id
    FROM public.spaces
   WHERE company ~~* 'Test-LEGACY'
     AND is_active = true
   ORDER BY id LIMIT 1;
  IF v_probe_space_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no active Test-LEGACY space found for probe row. Cannot proceed to VQ11-VQ13.';
  END IF;
  INSERT INTO public.space_payments (
    space_id, company, property, space_label,
    period_month, amount, method,
    resident_email, resident_name, unit,
    note, recorded_by_email
  )
  SELECT
    s.id, s.company, s.property, s.label,
    date_trunc('month', CURRENT_DATE)::date, 25.00, 'cash',
    NULL, NULL, NULL,
    '__V-COMMIT-2-PROBE-' || floor(extract(epoch from now()))::text,
    'system_verification'
    FROM public.spaces s WHERE s.id = v_probe_space_id
  RETURNING id INTO v_probe_id;
  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount <> 1 OR v_probe_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: probe INSERT returned rowcount=% (want 1) and probe_id=% (want non-null). Silent 0-row INSERT means either the SELECT sub-query missed the row or a race dropped it. VQ11-VQ13 will not run correctly; halt here and diagnose.',
      v_rowcount, v_probe_id;
  END IF;
  RAISE NOTICE 'SETUP: probe row inserted id=% space_id=% period_month=%',
    v_probe_id, v_probe_space_id, date_trunc('month', CURRENT_DATE)::date;
END $$;

-- ── FIXTURE GATE — probe row exists before VQ11 runs ────────────────
-- 🔴 2026-08-30 NEW GATE. VQ11 previously RAISED "RLS is filtering
-- out own-company rows or manager policy body is wrong" against an
-- empty table — because the SETUP silently failed and nothing
-- checked. A gate that depends on a fixture must verify the fixture
-- first, and it must fail with a DIFFERENT message than the thing
-- under test.
--
-- Runs as service_role/postgres (bypasses RLS). If the row is not
-- here, SETUP failed silently AND the failure was not caught. VQ11
-- would produce meaningless output. Halt with a clear "FIXTURE FAIL"
-- so the downstream noise never reaches the operator.
DO $$
DECLARE
  v_fixture_count INT;
BEGIN
  SELECT COUNT(*) INTO v_fixture_count
    FROM public.space_payments
   WHERE note LIKE '__V-COMMIT-2-PROBE-%';
  IF v_fixture_count = 0 THEN
    RAISE EXCEPTION 'FIXTURE FAIL: no probe row present after SETUP. VQ11-VQ13 will NOT be run — their results would be meaningless (any "manager saw 0 rows" is unreadable when there are no rows to see). Investigate SETUP for silent INSERT failure: check for CHECK-constraint violation, non-matching space company, or the period_month TZ trap that this rewrite fixed.';
  END IF;
  IF v_fixture_count > 1 THEN
    RAISE NOTICE 'FIXTURE: % probe rows present (>1 — likely from a prior partial verification run). Not fatal; VQ11 counts >= 1 as pass.', v_fixture_count;
  END IF;
  RAISE NOTICE 'FIXTURE: % probe row(s) present. VQ11-VQ13 have real state to test against.', v_fixture_count;
END $$;

-- ── VQ11: 🔴 EXECUTION — Test-LEGACY manager SELECTs own probe row ─
DO $$
DECLARE
  v_mgr_email TEXT;
  v_seen      INT;
BEGIN
  SELECT lower(email) INTO v_mgr_email
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY'
     AND role = 'manager'
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
   ORDER BY id LIMIT 1;
  IF v_mgr_email IS NULL THEN
    RAISE EXCEPTION 'VQ11 PREREQ FAIL: no Test-LEGACY manager found to impersonate';
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  SELECT COUNT(*) INTO v_seen
    FROM public.space_payments
   WHERE note LIKE '__V-COMMIT-2-PROBE-%';
  IF v_seen = 0 THEN
    -- 🔴 Message discipline: state what was observed, list candidate
    -- causes, do not assert one. The FIXTURE gate above already
    -- confirmed a probe row exists — so "0 rows seen under
    -- impersonation" narrows the cause to something the RLS predicate
    -- decided. Enumerate the specific things to check rather than
    -- naming a cause the gate never tested.
    RAISE EXCEPTION 'VQ11 FAIL: manager % impersonation returned 0 probe rows (FIXTURE confirmed >=1 row exists). Candidate causes to check, in order: (a) get_my_role() returns something other than "manager" for this user — verify user_roles.role; (b) get_my_properties() returns [] or doesn''t include the probe row''s property — verify user_roles.property for this user; (c) the probe row''s property does not match get_my_properties() output under lower(trim()) — compare literally; (d) the manager_own_space_payments policy body was replaced or dropped after apply — re-run VQ8 policy inspection.',
      v_mgr_email;
  END IF;
  RAISE NOTICE 'VQ11: manager % saw % probe row(s).', v_mgr_email, v_seen;
END $$;

-- ── VQ12: 🔴 EXECUTION — same manager INSERT REJECTED (permission_denied) ─
DO $$
DECLARE
  v_mgr_email        TEXT;
  v_test_space_id    BIGINT;
  v_grant_reject     BOOLEAN := FALSE;
BEGIN
  SELECT lower(email) INTO v_mgr_email
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY' AND role = 'manager'
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
   ORDER BY id LIMIT 1;
  SELECT id INTO v_test_space_id
    FROM public.spaces WHERE company ~~* 'Test-LEGACY' AND is_active LIMIT 1;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  BEGIN
    INSERT INTO public.space_payments (
      space_id, company, property, space_label,
      period_month, amount, recorded_by_email
    ) VALUES (
      v_test_space_id, 'Test-LEGACY', 'placeholder', 'placeholder',
      date_trunc('month', now())::date, 1.00, v_mgr_email
    );
    -- If we reach here, grant restriction did NOT fire. The row is
    -- committed. Manual cleanup will be needed.
    RAISE EXCEPTION 'VQ12 FAIL: authenticated manager INSERT was ACCEPTED. Grant restriction is not enforcing — every DEFINER RPC in Commit 3 becomes bypassable. Halt and re-run REVOKE.';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- SQLSTATE 42501 — expected. Grant restriction fired before RLS check.
      v_grant_reject := TRUE;
    WHEN raise_exception THEN
      RAISE;  -- re-raise the VQ12 FAIL from above
    WHEN others THEN
      RAISE EXCEPTION 'VQ12 FAIL: manager INSERT raised unexpected SQLSTATE=% : %. Expected 42501 (insufficient_privilege from grants).', SQLSTATE, SQLERRM;
  END;

  IF NOT v_grant_reject THEN
    RAISE EXCEPTION 'VQ12 FAIL: control flow reached the end without insufficient_privilege — should be unreachable';
  END IF;
  RAISE NOTICE 'VQ12: manager INSERT correctly rejected with insufficient_privilege.';
END $$;

-- ── VQ13: 🔴 EXECUTION — unauthorized role SEES 0 ROWS (not error) ──
-- Prefer a resident at Test-LEGACY; fall back to any resident/driver
-- from ANY company (their RLS-role has no policy on this table AND/OR
-- no matching scope, so RLS filters to 0 rows).
DO $$
DECLARE
  v_unauth_email TEXT;
  v_unauth_role  TEXT;
  v_seen         INT;
BEGIN
  -- Try a resident at Test-LEGACY first
  SELECT lower(email), role INTO v_unauth_email, v_unauth_role
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY'
     AND role IN ('resident', 'driver')
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
   ORDER BY id LIMIT 1;
  IF v_unauth_email IS NULL THEN
    -- Fallback: any resident or driver anywhere
    SELECT lower(email), role INTO v_unauth_email, v_unauth_role
      FROM public.user_roles
     WHERE role IN ('resident', 'driver')
       AND lower(coalesce(is_active::text, 'true')) <> 'false'
     ORDER BY id LIMIT 1;
  END IF;
  IF v_unauth_email IS NULL THEN
    RAISE NOTICE 'VQ13 SKIPPED: no resident or driver in user_roles anywhere. Cannot impersonate for the RLS-filter test.';
    RETURN;
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_unauth_email)::text, true);

  -- Wrapped so we surface unexpected SQLSTATE, not swallow it. The
  -- gate is specifically "returns 0 rows, does NOT throw."
  BEGIN
    SELECT COUNT(*) INTO v_seen
      FROM public.space_payments
     WHERE note LIKE '__V-COMMIT-2-PROBE-%';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'VQ13 FAIL: unauthorized role (%: %) SELECT RAISED (SQLSTATE=%). Expected zero rows silently. RLS should filter, not throw. Investigate the policy for role=%.', v_unauth_role, v_unauth_email, SQLSTATE, v_unauth_role;
  END;
  IF v_seen > 0 THEN
    RAISE EXCEPTION 'VQ13 FAIL: unauthorized role (%: %) SAW % probe row(s). RLS is not filtering — either a policy grants read to this role, or the deny-by-default is broken.', v_unauth_role, v_unauth_email, v_seen;
  END IF;
  RAISE NOTICE 'VQ13: unauthorized role (%: %) correctly saw 0 probe rows (no error).', v_unauth_role, v_unauth_email;
END $$;

-- ── VQ14: schema audit row ──────────────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_SPACE_PAYMENTS_TABLE_V1'
     AND new_values->>'migration' = '20260830_space_payments_v1_table';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ14 FAIL: SCHEMA_SPACE_PAYMENTS_TABLE_V1 audit row missing';
  END IF;
END $$;

-- ── CLEANUP — remove probe row(s) ───────────────────────────────────
-- Runs as service_role/postgres (bypasses RLS + grants).
DO $$
BEGIN
  DELETE FROM public.space_payments WHERE note LIKE '__V-COMMIT-2-PROBE-%';
END $$;

-- ── FINAL: one PASS row ─────────────────────────────────────────────
SELECT
  'PASS'::TEXT                                 AS status,
  'space_payments v1 table + RLS + grants'::TEXT AS target,
  ARRAY[
    'VQ1  table exists',
    'VQ2  columns + types + nullability',
    'VQ3  CHECK amount > 0',
    'VQ4  CHECK period_month first-of-month',
    'VQ5  CHECK void coherence',
    'VQ6  FK space_id ON DELETE RESTRICT',
    'VQ7  3 indexes present',
    'VQ8  RLS enabled',
    'VQ9  authenticated has SELECT',
    'VQ10 authenticated does NOT have INSERT/UPDATE/DELETE',
    'SETUP+FIXTURE probe row inserted AND independently verified present',
    'VQ11 EXECUTION manager sees own probe row',
    'VQ12 EXECUTION manager INSERT rejected (insufficient_privilege)',
    'VQ13 EXECUTION unauthorized role sees 0 rows without error',
    'VQ14 SCHEMA_SPACE_PAYMENTS_TABLE_V1 audit row'
  ]                                            AS gates_verified,
  now()                                        AS verified_at;

-- ══════════════════════════════════════════════════════════════════════
-- MANUAL CLEANUP (only needed if a VQ raised mid-sequence, leaving the
-- probe row behind):
--
--   DELETE FROM public.space_payments WHERE note LIKE '__V-COMMIT-2-PROBE-%';
--
-- Manual cleanup for VQ12 phantom-if-grant-restriction-failed:
--   Should not occur (VQ12 raises before returning); but if the manager
--   INSERT succeeded and the transaction committed before the RAISE:
--
--   DELETE FROM public.space_payments
--    WHERE property = 'placeholder' AND recorded_by_email LIKE '%test%';
-- ══════════════════════════════════════════════════════════════════════
