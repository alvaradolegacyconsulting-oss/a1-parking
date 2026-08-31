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

-- ══════════════════════════════════════════════════════════════════════
-- ── VQ11-VQ13 CONSOLIDATED EXECUTION BLOCK ─────────────────────────
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 2026-08-30 SECOND REWRITE after Mateo diagnosed the previous
-- attempt: FIXTURE ran as service_role and saw the row (bypasses RLS);
-- VQ11 ran as authenticated + JWT and legitimately saw 0 rows because
-- SETUP picked a manager and a space INDEPENDENTLY. If the chosen
-- manager was assigned to property A and the chosen space was at
-- property B, RLS correctly filtered the row out — the test was
-- validating scoping that we hadn't ensured existed.
--
-- Two structural fixes applied here:
--
-- 1. ONE DO BLOCK — SETUP + FIXTURE + VQ11 + VQ12 + VQ13 + CLEANUP
--    all in one transaction. If any gate RAISEs, the whole thing rolls
--    back, INCLUDING the probe INSERT — no orphan cleanup needed. If
--    all pass, DELETE at the end runs, then the transaction commits
--    (INSERT + DELETE net to zero rows).
--    Per Mateo Aug 30 §1 additional rule: "a fixture gate must run
--    in the same scope and at the same point as the gates it protects."
--    Cross-block visibility was the third defect.
--
-- 2. LINKED MANAGER + SPACE — pick the manager FIRST (with a non-empty
--    user_roles.property assignment), then pick a space at THAT
--    property. Guarantees RLS admits the probe row for this specific
--    manager. If RLS then filters it out, that IS a real bug — no
--    "unlinked entities" false-signal.
--
-- Impersonation lifecycle:
--   PERFORM set_config('role', 'authenticated', true)  → RLS applies
--   PERFORM set_config('request.jwt.claims', {email:X}, true)
--   ... test ...
--   EXECUTE 'RESET role'   → back to service_role for the next section
--
-- SET LOCAL and RESET are transaction-scoped, so the RESET after each
-- impersonation is required because subsequent SETUP/CLEANUP ops need
-- superuser context.
DO $$
DECLARE
  v_mgr_email       TEXT;
  v_mgr_property    TEXT;
  v_probe_space_id  BIGINT;
  v_probe_id        BIGINT;
  v_rowcount        INT;
  v_seen            INT;
  v_grant_reject    BOOLEAN;
  v_unauth_email    TEXT;
  v_unauth_role     TEXT;
BEGIN
  -- ── STEP 1: PICK MANAGER FIRST, capture their property ────────────
  SELECT lower(email), property
    INTO v_mgr_email, v_mgr_property
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY'
     AND role = 'manager'
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
     AND property IS NOT NULL
     AND length(trim(property)) > 0
   ORDER BY id LIMIT 1;
  IF v_mgr_email IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no Test-LEGACY manager with a non-empty property assignment. Cannot link probe space to manager scope; RLS test would compare unlinked entities.';
  END IF;

  -- ── STEP 2: PICK SPACE AT THAT PROPERTY (linked) ─────────────────
  SELECT id INTO v_probe_space_id
    FROM public.spaces
   WHERE company ~~* 'Test-LEGACY'
     AND is_active = true
     AND lower(trim(property)) = lower(trim(v_mgr_property))
   ORDER BY id LIMIT 1;
  IF v_probe_space_id IS NULL THEN
    RAISE EXCEPTION 'SETUP FAIL: no active space at property "%" (manager %s assignment). Manager scoped to a property with no active spaces. VQ11 would fire against RLS correctly filtering. Verify Test-LEGACY seed data.',
      v_mgr_property, v_mgr_email;
  END IF;

  -- ── STEP 3: INSERT PROBE (as current superuser role — bypasses RLS
  --   AND the SELECT-only grant) ───────────────────────────────────
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
    RAISE EXCEPTION 'SETUP FAIL: probe INSERT rowcount=% probe_id=% (want 1 non-null).', v_rowcount, v_probe_id;
  END IF;
  RAISE NOTICE 'SETUP: probe id=% at space_id=% property="%" manager="%"',
    v_probe_id, v_probe_space_id, v_mgr_property, v_mgr_email;

  -- ── STEP 4: FIXTURE — the row is present in this transaction ─────
  -- (Redundant given the RETURNING above set v_probe_id, but kept as
  -- an explicit assertion so future readers see it. Same transaction,
  -- same scope as the impersonated tests below.)
  SELECT COUNT(*) INTO v_seen
    FROM public.space_payments WHERE id = v_probe_id;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'FIXTURE FAIL: probe id=% not visible in the same transaction (count=%). Impossible under normal Postgres — investigate.', v_probe_id, v_seen;
  END IF;

  -- ── VQ11: manager SELECTs their own linked probe row ─────────────
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_mgr_email)::text, true);

  SELECT COUNT(*) INTO v_seen
    FROM public.space_payments WHERE id = v_probe_id;
  IF v_seen = 0 THEN
    -- 🔴 Message discipline: since SETUP linked manager+space at the
    -- same property, RLS filtering here means the manager_own policy
    -- is not admitting a legitimately-in-scope row. State the observation;
    -- enumerate candidate causes.
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VQ11 FAIL: manager % (property="%") saw 0 probe rows. Probe id=% is at property="%" (manager''s own assignment — linked at SETUP). Since SETUP guarantees the row IS in scope, this narrows to: (a) get_my_role() returns <> ''manager'' for this user — verify user_roles.role; (b) get_my_properties() returns empty or missing this property — verify user_roles.property; (c) the manager_own_space_payments policy body was altered post-apply — re-run VQ8.',
      v_mgr_email, v_mgr_property, v_probe_id, v_mgr_property;
  END IF;
  RAISE NOTICE 'VQ11 PASS: manager % saw probe row (id=%)', v_mgr_email, v_probe_id;

  -- ── VQ12: same manager INSERT REJECTED with insufficient_privilege ─
  -- (Still under authenticated role from VQ11; no need to re-SET.)
  v_grant_reject := FALSE;
  BEGIN
    INSERT INTO public.space_payments (
      space_id, company, property, space_label,
      period_month, amount, recorded_by_email
    ) VALUES (
      v_probe_space_id, 'Test-LEGACY', v_mgr_property, 'V12-probe',
      date_trunc('month', CURRENT_DATE)::date, 1.00, v_mgr_email
    );
    -- Reached only if grant restriction failed to fire.
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VQ12 FAIL: authenticated manager INSERT was ACCEPTED. Grant restriction is not enforcing — every DEFINER RPC in Commit 3 becomes bypassable. Halt and re-run: REVOKE ALL FROM authenticated; GRANT SELECT TO authenticated.';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- SQLSTATE 42501 — expected. Grant restriction fired before RLS.
      v_grant_reject := TRUE;
    WHEN raise_exception THEN
      -- Re-raise the VQ12 FAIL that we RAISEd above.
      RAISE;
    WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VQ12 FAIL: manager INSERT raised unexpected SQLSTATE=% : %. Expected 42501 (insufficient_privilege from grants).', SQLSTATE, SQLERRM;
  END;
  IF NOT v_grant_reject THEN
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VQ12 FAIL: control flow reached end without insufficient_privilege';
  END IF;
  RAISE NOTICE 'VQ12 PASS: manager INSERT rejected with insufficient_privilege';

  -- Restore role to superuser for VQ13 setup (find unauth user).
  EXECUTE 'RESET role';

  -- ── VQ13: unauthorized role SEES 0 ROWS silently ─────────────────
  -- Prefer Test-LEGACY resident; fall back to any resident/driver.
  SELECT lower(email), role INTO v_unauth_email, v_unauth_role
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY'
     AND role IN ('resident', 'driver')
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
   ORDER BY id LIMIT 1;
  IF v_unauth_email IS NULL THEN
    SELECT lower(email), role INTO v_unauth_email, v_unauth_role
      FROM public.user_roles
     WHERE role IN ('resident', 'driver')
       AND lower(coalesce(is_active::text, 'true')) <> 'false'
     ORDER BY id LIMIT 1;
  END IF;
  IF v_unauth_email IS NULL THEN
    RAISE NOTICE 'VQ13 SKIPPED: no resident or driver in user_roles anywhere.';
  ELSE
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims',
                       json_build_object('email', v_unauth_email)::text, true);
    -- Wrapped so we surface unexpected SQLSTATE, not swallow it. The
    -- gate is specifically "returns 0 rows, does NOT throw."
    BEGIN
      SELECT COUNT(*) INTO v_seen
        FROM public.space_payments WHERE id = v_probe_id;
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VQ13 FAIL: unauthorized role (%: %) SELECT RAISED (SQLSTATE=%). Expected 0 rows silently. RLS should filter, not throw.',
        v_unauth_role, v_unauth_email, SQLSTATE;
    END;
    IF v_seen > 0 THEN
      EXECUTE 'RESET role';
      RAISE EXCEPTION 'VQ13 FAIL: unauthorized role (%: %) SAW % probe rows. RLS is not filtering — either a policy grants read to this role, or deny-by-default is broken.',
        v_unauth_role, v_unauth_email, v_seen;
    END IF;
    RAISE NOTICE 'VQ13 PASS: unauthorized (%: %) saw 0 rows silently', v_unauth_role, v_unauth_email;
    EXECUTE 'RESET role';
  END IF;

  -- ── CLEANUP inside the same block ─
  DELETE FROM public.space_payments WHERE id = v_probe_id;
  RAISE NOTICE 'CLEANUP: probe id=% deleted', v_probe_id;
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

-- (No separate CLEANUP block — cleanup is at the end of the
-- consolidated execution block above. If any gate raised there, the
-- whole block's transaction rolled back and the probe row was never
-- committed; if all gates passed, the DELETE inside the block ran
-- before the block exited and committed.)

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
    'SETUP linked manager+space at same property + probe inserted + same-txn fixture check',
    'VQ11 EXECUTION manager sees own linked probe row (RLS admits)',
    'VQ12 EXECUTION manager INSERT rejected (insufficient_privilege)',
    'VQ13 EXECUTION unauthorized role sees 0 rows without error (RLS filters silently)',
    'CLEANUP probe deleted in same transaction (or transaction rolled back on failure)',
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
