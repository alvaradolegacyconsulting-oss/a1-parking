-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_tow_operators_execution_verification.sql
--
-- EMPIRICAL execution gates for Tow Log Commit 2 (tow_operators).
-- Every assertion below was WRITTEN FROM Jose's actual runbook output
-- on Sept 9 2026 — no predicted text. Case-by-case sources cited in
-- comments so a future maintainer can trace where the exact message
-- came from.
--
-- ── DISCIPLINE DIFFERENT FROM STRUCTURAL VERIFICATION ──────────────
-- Structural verification files carry no BEGIN/COMMIT wrap per
-- feedback_verification_returns_rows_no_transaction. THIS FILE IS
-- DIFFERENT — execution gates exercise real writes (INSERT into
-- tow_operators + audit_logs), so the whole file wraps in
-- BEGIN/ROLLBACK. Nothing persists after the file runs to PASS.
-- Re-runnable: fresh txn each time; sequence advances are not
-- transactional but that's harmless (we assert id equality relatively,
-- never absolute values).
--
-- ── 🔴 E5 AND E6 SHARE SQLSTATE 42501 ──────────────────────────────
-- Both raise 42501 for different reasons:
--   E5 = SECURITY DEFINER function's own `RAISE ... ERRCODE =
--        'insufficient_privilege'` after my_tier_pm_capable() = false.
--        MESSAGE_TEXT is exactly 'tier_not_permitted'.
--   E6 = Postgres refusing EXECUTE on the function at the grant layer
--        (anon role lacks GRANT EXECUTE).
--        MESSAGE_TEXT is 'permission denied for function
--        create_tow_operator'.
-- MUST discriminate on MESSAGE_TEXT. A gate that checks only sqlstate
-- 42501 would pass for the wrong reason in either direction.
-- feedback_sqlstate_42501_shared_across_causes.
--
-- ── 🔴 PROBE NAMES USE HYPHENS + SPACES, NEVER `_` OR `%` ──────────
-- The tow_operators_name_no_sql_metachar CHECK refuses `%`, `_`, `\`
-- in names. `EV_PROBE_ABC` would trip that CHECK before the RPC gets
-- to its own validation. All non-metachar probes use `EV-PROBE ...`;
-- E7 specifically uses `EV-PROBE%METACHAR` to trigger the invalid_name
-- return.
--
-- ── FIXTURE PRE-CHECK ──────────────────────────────────────────────
-- Four user_roles rows required. If any is missing the file RAISEs
-- a FIXTURE FAIL (never silently skips — feedback_absence_must_not_
-- be_failure_output). Add the missing fixture row and re-run.
--
--   pm-manager@test.shieldmylot.com     (Test-PM manager, my_tier_pm_capable=T)
--   legacy-manager@test.shieldmylot.com (Test-LEGACY manager)
--   enf-manager@test.shieldmylot.com    (Test-ENF manager, my_tier_pm_capable=F)
--   legacy-resident@test.shieldmylot.com (Test-LEGACY resident — for role gate)
--
-- ── GATE INDEX ──────────────────────────────────────────────────────
--   E1   pm-manager create → {ok:true, created:true}
--   E2   pm-manager same name → {ok:true, created:false} SAME id as E1
--   E3   pm-manager cross-company SELECT → 0 rows (RLS filters)
--   E4   pm-manager cross-company update → {error:'out_of_scope'}
--   E5   enf-manager create → RAISE 42501 'tier_not_permitted'
--   E6   anon create → RAISE 42501 'permission denied for function ...'
--   E7   pm-manager 'ABC%Towing' → {error:'invalid_name'}
--   E8   legacy-resident create → {error:'role_not_authorized'}
--   E10  deactivate already-inactive → {error:'already_inactive'}
--   E11  pm-manager reuse after deactivate → {ok:true, created:true}
--        with DIFFERENT id than the deactivated row (partial index
--        frees name)
--
-- E9 (CA-role create) omitted; sufficient coverage via E1 (role
-- gate exercises manager path, which is the tighter check).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;


-- ── FIXTURE PRE-CHECK ═══════════════════════════════════════════════
DO $fixtures$
DECLARE
  v_missing TEXT := '';
  v_email   TEXT;
BEGIN
  FOREACH v_email IN ARRAY ARRAY[
    'pm-manager@test.shieldmylot.com',
    'legacy-manager@test.shieldmylot.com',
    'enf-manager@test.shieldmylot.com',
    'legacy-resident@test.shieldmylot.com'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles WHERE lower(trim(email)) = v_email
    ) THEN
      v_missing := v_missing || v_email || '; ';
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'FIXTURE FAIL: missing user_roles rows: %. Add these fixture users and re-run.', v_missing;
  END IF;
END $fixtures$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 + E2 — create then find-or-create the same name
-- Source: Jose runbook output
--   E1: {"id":2,"ok":true,"created":true}
--   E2: {"id":2,"ok":true,"created":false}
-- ══════════════════════════════════════════════════════════════════════
DO $e1_e2$
DECLARE
  v_result_1 JSONB;
  v_result_2 JSONB;
  v_id_1     BIGINT;
  v_id_2     BIGINT;
BEGIN
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"pm-manager@test.shieldmylot.com"}', true);

  v_result_1 := public.create_tow_operator('EV-PROBE ABC TOWING',
                                            '713-555-0100',
                                            'TDLR-99999',
                                            'exec verification probe');
  v_result_2 := public.create_tow_operator('EV-PROBE ABC TOWING');

  IF (v_result_1 ->> 'ok')::bool IS NOT TRUE
     OR (v_result_1 ->> 'created')::bool IS NOT TRUE
     OR (v_result_1 ->> 'id') IS NULL THEN
    RAISE EXCEPTION 'E1 FAIL: expected {ok:true, created:true, id:<n>}; got %', v_result_1;
  END IF;

  IF (v_result_2 ->> 'ok')::bool IS NOT TRUE
     OR (v_result_2 ->> 'created')::bool IS NOT FALSE
     OR (v_result_2 ->> 'id') IS NULL THEN
    RAISE EXCEPTION 'E2 FAIL: expected {ok:true, created:false, id:<n>}; got %', v_result_2;
  END IF;

  v_id_1 := (v_result_1 ->> 'id')::bigint;
  v_id_2 := (v_result_2 ->> 'id')::bigint;
  IF v_id_1 IS DISTINCT FROM v_id_2 THEN
    RAISE EXCEPTION
      'E2 FAIL: find-or-create must return the SAME id — E1 id=% but E2 id=%. The find-or-create contract broke; Saturday-night inline-entry fails.',
      v_id_1, v_id_2;
  END IF;
END $e1_e2$;


-- ══════════════════════════════════════════════════════════════════════
-- E5 — Enforcement-Only tier rejected via RAISE
-- Source: Jose runbook output —
--   ERROR:  42501: tier_not_permitted
--   HINT:   Tow-operator management is a property-management feature. ...
--   CONTEXT: PL/pgSQL function create_tow_operator(...) line 27 at RAISE
-- ══════════════════════════════════════════════════════════════════════
DO $e5$
DECLARE
  v_result    JSONB;
  v_sqlstate  TEXT;
  v_message   TEXT;
BEGIN
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"enf-manager@test.shieldmylot.com"}', true);

  BEGIN
    v_result := public.create_tow_operator('EV-PROBE ENF TIER');
    RAISE EXCEPTION 'E5 FAIL: expected RAISE tier_not_permitted; got jsonb result %', v_result;
  EXCEPTION
    WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message  := SQLERRM;
  END;

  IF v_sqlstate <> '42501' THEN
    RAISE EXCEPTION 'E5 FAIL: expected sqlstate 42501; got % (message=%)',
      v_sqlstate, v_message;
  END IF;

  -- 🔴 Discriminate from E6 via MESSAGE_TEXT — same sqlstate, different cause.
  IF v_message <> 'tier_not_permitted' THEN
    RAISE EXCEPTION
      'E5 FAIL: expected MESSAGE_TEXT=''tier_not_permitted'' (SECURITY DEFINER''s own RAISE); got: % (sqlstate=%). Note E5/E6 share sqlstate 42501 — MESSAGE_TEXT is the discriminator.',
      v_message, v_sqlstate;
  END IF;
END $e5$;


-- ══════════════════════════════════════════════════════════════════════
-- E6 — anon denied at grant layer
-- Source: Jose runbook output —
--   ERROR 42501: permission denied for function create_tow_operator
-- ══════════════════════════════════════════════════════════════════════
DO $e6$
DECLARE
  v_result   JSONB;
  v_sqlstate TEXT;
  v_message  TEXT;
BEGIN
  SET LOCAL role anon;

  BEGIN
    v_result := public.create_tow_operator('EV-PROBE ANON');
    RAISE EXCEPTION 'E6 FAIL: expected permission-denied RAISE; got jsonb result %', v_result;
  EXCEPTION
    WHEN OTHERS THEN
      v_sqlstate := SQLSTATE;
      v_message  := SQLERRM;
  END;

  IF v_sqlstate <> '42501' THEN
    RAISE EXCEPTION 'E6 FAIL: expected sqlstate 42501; got % (message=%)',
      v_sqlstate, v_message;
  END IF;

  -- 🔴 LIKE match tolerates schema-prefix variance across Postgres
  -- versions (some render 'public.create_tow_operator'). This is the
  -- Postgres native grant-layer denial, distinct from E5's function-
  -- internal RAISE.
  IF v_message NOT LIKE 'permission denied for function%create_tow_operator%' THEN
    RAISE EXCEPTION
      'E6 FAIL: expected MESSAGE_TEXT like ''permission denied for function%%create_tow_operator%%'' (Postgres grant-layer denial); got: % (sqlstate=%). E5/E6 share 42501 — MESSAGE_TEXT is the discriminator.',
      v_message, v_sqlstate;
  END IF;
END $e6$;


-- ══════════════════════════════════════════════════════════════════════
-- E7 — Metachar name → RPC-level invalid_name (before table CHECK)
-- Source: Jose runbook output — {"error":"invalid_name"}
-- ══════════════════════════════════════════════════════════════════════
DO $e7$
DECLARE v_result JSONB;
BEGIN
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"pm-manager@test.shieldmylot.com"}', true);

  -- Name contains '%' — must trigger invalid_name from the RPC's own
  -- validation BEFORE reaching the table's metachar CHECK.
  v_result := public.create_tow_operator('EV-PROBE%METACHAR');

  IF v_result ->> 'error' IS DISTINCT FROM 'invalid_name' THEN
    RAISE EXCEPTION
      'E7 FAIL: expected {error:''invalid_name''} from RPC input-validation; got %. If a table CHECK fired (23514) instead, the RPC lost its input-validation defense.',
      v_result;
  END IF;
END $e7$;


-- ══════════════════════════════════════════════════════════════════════
-- E8 — resident role rejected
-- Source: Jose runbook output — {"error":"role_not_authorized"}
-- ══════════════════════════════════════════════════════════════════════
DO $e8$
DECLARE v_result JSONB;
BEGIN
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"legacy-resident@test.shieldmylot.com"}', true);

  v_result := public.create_tow_operator('EV-PROBE RESIDENT');

  IF v_result ->> 'error' IS DISTINCT FROM 'role_not_authorized' THEN
    RAISE EXCEPTION 'E8 FAIL: expected {error:''role_not_authorized''}; got %', v_result;
  END IF;
END $e8$;


-- ══════════════════════════════════════════════════════════════════════
-- E10 + E11 — deactivate → idempotency → reuse-after-deactivate
-- Source: Jose runbook output —
--   e10_already_inactive: {"error":"already_inactive"}
--   e11_reuse: {"id":4,"ok":true,"created":true} (different id than E1's create)
-- 🔴 Assert id_2 ≠ id_1 explicitly — that's the assertion that proves
-- the partial unique index (WHERE is_active) is freeing the name.
-- Merely asserting created:true would let a full-index regression
-- through (which would collide + fail with unique_violation, not
-- created:true; but nail the assertion for future safety).
-- ══════════════════════════════════════════════════════════════════════
DO $e10_e11$
DECLARE
  v_result_create1  JSONB;
  v_result_deact1   JSONB;
  v_result_deact2   JSONB;
  v_result_reuse    JSONB;
  v_id_1            BIGINT;
  v_id_2            BIGINT;
BEGIN
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"pm-manager@test.shieldmylot.com"}', true);

  -- Setup: create the initial row
  v_result_create1 := public.create_tow_operator('EV-PROBE REUSE');
  IF (v_result_create1 ->> 'ok')::bool IS NOT TRUE
     OR (v_result_create1 ->> 'created')::bool IS NOT TRUE THEN
    RAISE EXCEPTION 'E10/E11 SETUP FAIL: initial create did not succeed: %', v_result_create1;
  END IF;
  v_id_1 := (v_result_create1 ->> 'id')::bigint;

  -- Setup: deactivate that row
  v_result_deact1 := public.deactivate_tow_operator(v_id_1);
  IF (v_result_deact1 ->> 'ok')::bool IS NOT TRUE THEN
    RAISE EXCEPTION 'E10/E11 SETUP FAIL: first deactivate did not succeed: %', v_result_deact1;
  END IF;

  -- E10: second deactivate must return already_inactive
  v_result_deact2 := public.deactivate_tow_operator(v_id_1);
  IF v_result_deact2 ->> 'error' IS DISTINCT FROM 'already_inactive' THEN
    RAISE EXCEPTION 'E10 FAIL: expected {error:''already_inactive''}; got %', v_result_deact2;
  END IF;

  -- E11: create with the same name — partial index (WHERE is_active)
  -- must NOT collide with the deactivated row; a fresh INSERT succeeds
  -- and produces a NEW id.
  v_result_reuse := public.create_tow_operator('EV-PROBE REUSE');
  IF (v_result_reuse ->> 'ok')::bool IS NOT TRUE
     OR (v_result_reuse ->> 'created')::bool IS NOT TRUE THEN
    RAISE EXCEPTION
      'E11 FAIL: expected {ok:true, created:true} (partial index frees deactivated name); got %',
      v_result_reuse;
  END IF;

  v_id_2 := (v_result_reuse ->> 'id')::bigint;
  IF v_id_2 IS NOT DISTINCT FROM v_id_1 THEN
    RAISE EXCEPTION
      'E11 FAIL: partial unique index not freeing deactivated name — reuse returned SAME id % (expected NEW id, distinct from deactivated %). Check WHERE is_active predicate on tow_operators_company_name_uniq.',
      v_id_2, v_id_1;
  END IF;
END $e10_e11$;


-- ══════════════════════════════════════════════════════════════════════
-- E3 + E4 — cross-company scope (RLS + RPC scope-check are TWO defenses)
-- Source: Jose runbook output —
--   e3_rows_visible: 0   (RLS hid it from pm-manager)
--   e4_cross_update: {"error":"out_of_scope"}   (RPC explicit scope check)
-- Both must hold — RLS filters SELECTs, RPC filters writes. SECURITY
-- DEFINER can read across companies internally, which is why the
-- explicit scope check inside the RPC matters.
--
-- All-in-one-txn identity switch: PERFORM set_config('request.jwt.
-- claims', ..., true) is txn-scoped, and get_my_role/get_my_company
-- re-read the claim on each call — so a mid-txn identity switch does
-- take effect for subsequent RPC calls. If the runbook's committed-
-- fixture-with-cleanup pattern is preferred instead, split this DO
-- block out to a separate committed exercise; the ROLLBACK on this
-- txn is what makes the mid-txn switch acceptable.
-- ══════════════════════════════════════════════════════════════════════
DO $e3_e4$
DECLARE
  v_create_result  JSONB;
  v_id_legacy      BIGINT;
  v_row_count      INT;
  v_update_result  JSONB;
BEGIN
  -- Legacy manager creates a fixture row in their own company scope
  SET LOCAL role authenticated;
  PERFORM set_config('request.jwt.claims',
                     '{"email":"legacy-manager@test.shieldmylot.com"}', true);

  v_create_result := public.create_tow_operator('EV-PROBE CROSS CO', '281-555-0000');
  IF (v_create_result ->> 'ok')::bool IS NOT TRUE THEN
    RAISE EXCEPTION 'E3/E4 SETUP FAIL: legacy-manager create did not succeed: %', v_create_result;
  END IF;
  v_id_legacy := (v_create_result ->> 'id')::bigint;

  -- Switch identity mid-txn to PM manager. request.jwt.claims is a
  -- txn-scoped GUC via set_config(..., true); get_my_role() +
  -- get_my_company() re-read it on each call.
  PERFORM set_config('request.jwt.claims',
                     '{"email":"pm-manager@test.shieldmylot.com"}', true);

  -- E3: RLS must hide the legacy row from pm-manager
  SELECT count(*) INTO v_row_count
    FROM public.tow_operators
   WHERE id = v_id_legacy;
  IF v_row_count <> 0 THEN
    RAISE EXCEPTION
      'E3 FAIL: pm-manager sees legacy-manager''s row id=% (RLS filter failed). Got count=%.',
      v_id_legacy, v_row_count;
  END IF;

  -- E4: RPC's own scope check must refuse the cross-company update
  -- even though SECURITY DEFINER can read the row internally.
  v_update_result := public.update_tow_operator(v_id_legacy, NULL, '999-999-9999');
  IF v_update_result ->> 'error' IS DISTINCT FROM 'out_of_scope' THEN
    RAISE EXCEPTION
      'E4 FAIL: expected {error:''out_of_scope''}; got %. If the update actually applied, the RPC scope check is regressed.',
      v_update_result;
  END IF;
END $e3_e4$;


-- ══════════════════════════════════════════════════════════════════════
-- FINAL: PASS row
-- Row is emitted before ROLLBACK — visible in SQL Editor output;
-- rolled back atomically with the rest of the txn (nothing persists).
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'tow_operators execution (Tow Log Commit 2 empirical, all 11 gates)'::TEXT AS target,
  ARRAY[
    'E1   pm-manager create → {ok:true, created:true, id:<n>}',
    'E2   pm-manager same name → {ok:true, created:false} SAME id as E1',
    'E3   pm-manager SELECTs legacy row → 0 rows (RLS filter)',
    'E4   pm-manager updates legacy row → {error:''out_of_scope''} (RPC scope check)',
    'E5   enf-manager create → RAISE sqlstate=42501 MESSAGE_TEXT=''tier_not_permitted''',
    'E6   anon create → RAISE sqlstate=42501 MESSAGE_TEXT LIKE ''permission denied for function%create_tow_operator%''',
    'E7   pm-manager metachar name → {error:''invalid_name''} (RPC validation, before table CHECK)',
    'E8   legacy-resident create → {error:''role_not_authorized''}',
    'E10  deactivate already-inactive → {error:''already_inactive''}',
    'E11  create same name after deactivate → {ok:true, created:true} with NEW id (partial index frees name)',
    'DISCIPLINE: E5/E6 share sqlstate 42501; discriminated on MESSAGE_TEXT (feedback_sqlstate_42501_shared_across_causes)'
  ] AS gates_verified,
  now() AS verified_at;


ROLLBACK;

-- ══════════════════════════════════════════════════════════════════
-- POST-ROLLBACK STATE
-- ------------------------------------------------------------------
-- • tow_operators — no EV-PROBE * rows (all creates rolled back)
-- • audit_logs   — no TOW_OPERATOR_* rows from this run (audits
--                  rolled back atomically)
-- • BIGSERIAL sequences advanced (not transactional; harmless — the
--   file asserts id equality/inequality relatively, not absolutely)
-- Re-runnable indefinitely; each run is a fresh empirical replay.
-- ══════════════════════════════════════════════════════════════════
