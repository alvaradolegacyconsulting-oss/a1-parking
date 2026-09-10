-- ══════════════════════════════════════════════════════════════════════
-- 20260910_record_vehicle_removal_plate_normalize_fix_verification.sql
--
-- Paired verification for 20260910_record_vehicle_removal_plate_
-- normalize_fix.sql. STRUCTURAL gates VS1-VS7 + EXECUTION gates E1-E3.
--
-- ── 🔴 HYBRID FILE — TWO DISCIPLINES IN ONE PASTE ───────────────────
-- Structural verifications carry NO transaction wrap (the terminal
-- SELECT must be the last statement or the SQL Editor eats the PASS
-- row — feedback_verification_returns_rows_no_transaction). Execution
-- gates DO real writes and must roll back
-- (20260909_tow_log_tow_operators_execution_verification.sql pattern).
--
-- Reconciled by ordering:
--   1. VS1-VS7  — read-only, unwrapped
--   2. BEGIN;   — execution gates (real INSERTs into vehicle_removals,
--                 vehicle_removals' audit rows, tow_operators, vehicles)
--   3. ROLLBACK;
--   4. Terminal PASS SELECT — LAST statement in the paste, AFTER the
--      ROLLBACK, so its rows are what the SQL Editor returns.
--
-- ── PASS ROW VISIBILITY — CORRECTED 2026-09-10 ──────────────────────
-- An earlier draft of this header claimed the Commit 2 execution file
-- was silently passing because it emits its PASS row BEFORE its
-- ROLLBACK. That was WRONG. That file displayed all 11 gates when Jose
-- ran it on 2026-09-09 at 21:32:03.
--
-- 🔴 THE RULE, so this does not get re-flagged every time someone reads
-- a v2-shaped file: a verification file's PASS row is display-visible
-- whether it sits INSIDE or OUTSIDE the transaction. Two reasons:
--   1. The SQL Editor shows the last statement that RETURNED ROWS.
--      ROLLBACK and COMMIT return none, so it falls back to the
--      preceding SELECT.
--   2. A rollback cannot retract output — the rows already streamed to
--      the client before the transaction ended.
-- (The same fallback explains the set_config row surfacing when a final
-- SELECT came back empty, seen twice this week.)
--
-- Placement AFTER the ROLLBACK — as here — is still the better form,
-- because it does not depend on editor fallback behaviour at all. Use
-- it going forward. Do NOT retrofit applied files that already passed.
--
-- No false-green risk from the ordering: any RAISE aborts the whole
-- multi-statement paste, so the terminal SELECT never runs after a
-- failed gate.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Paste the ENTIRE file as ONE block, click Run ONCE. Running gates
-- individually breaks the BEGIN/ROLLBACK and can leave probe rows
-- behind.
--
-- ── STRUCTURAL GATE INDEX ───────────────────────────────────────────
--   VS1  15-arg record_vehicle_removal exists + SECURITY DEFINER
--   VS2  14-arg signature still GONE (regression lock — CREATE OR
--        REPLACE must not have resurrected an overload)
--   VS3  ⚠ ALL NINE parameter defaults intact (pronargdefaults = 9 AND
--        p_removal_type still renders its 'tow' default)
--        — feedback_create_or_replace_drops_defaults
--   VS4  🔴 prosrc: normalize_plate(p_plate) appears ZERO times and
--        normalize_plate(v.plate) EXACTLY ONCE, and v_plate_norm is
--        present. The regression lock on the asymmetry.
--   VS5  grants — EXECUTE to authenticated only (no anon, no PUBLIC)
--   VS6  COMMENT ON FUNCTION present on BOTH record_vehicle_removal
--        and vehicle_removal_plate_normalize (the do-not-drop note)
--   VS7  SCHEMA_RECORD_VEHICLE_REMOVAL_PLATE_NORMALIZE_FIX audit row
--
-- ── EXECUTION GATE INDEX ────────────────────────────────────────────
--   E1  punctuation-only plate '---' → {"error":"plate_required"}
--       AND NO EXCEPTION RAISED. 🔴 Asserting "an error came back"
--       would PASS on the broken version — the bug's signature is an
--       exception where a clean rejection belongs. E1 catches any
--       exception and fails naming its sqlstate.
--   E2  dashed input 'EV-PROBE-X9' against an active vehicles row
--       holding 'EVPROBEX9' at the same property → linked_vehicle_id
--       POPULATED with that vehicle's id. The soft link has never been
--       proven working; this is the first gate that does it.
--   E3  same call → audit new_values->>'plate' EQUALS the stored row's
--       plate AND both equal the expected normalized 'EVPROBEX9'.
--       (Equality alone would pass if both held the raw dashed form —
--       the expected value is asserted explicitly.)
--
-- ── NOT IN THIS FILE ────────────────────────────────────────────────
-- A gate proving vehicle_removal_plate_normalize() still RAISES 22004
-- belongs in the Commit 3 execution file and MUST insert into
-- public.vehicle_removals directly as service_role. That trigger is
-- now unreachable through the RPC by design — routing such a gate
-- through record_vehicle_removal asserts the bug, not the fix. See
-- COMMENT ON FUNCTION public.vehicle_removal_plate_normalize().
--
-- ── FIXTURES REQUIRED ───────────────────────────────────────────────
--   user_roles  pm-manager@test.shieldmylot.com (manager, Test-PM,
--               property = ARRAY['Test PM Property'])
--   properties  'Test PM Property' in company 'Test-PM'
-- Missing fixtures RAISE a FIXTURE FAIL — never a silent skip
-- (feedback_absence_must_not_be_failure_output).
-- ══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
-- STRUCTURAL GATES — read-only, no transaction wrap
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: 15-arg exists + SECURITY DEFINER ══════════════════════════
DO $vs1$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: 15-arg public.record_vehicle_removal not found';
  END IF;

  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS1 FAIL: record_vehicle_removal is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs1$;


-- ── VS2: 14-arg signature still GONE ══════════════════════════════
-- CREATE OR REPLACE on the same arity cannot create an overload, so
-- this is a regression lock rather than a new claim. If it fires,
-- something OTHER than this migration re-created the 14-arg form and
-- PostgREST is seeing ambiguous candidates.
DO $vs2$
DECLARE v_old_oid OID;
BEGIN
  v_old_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT'
    || ')'
  );
  IF v_old_oid IS NOT NULL THEN
    RAISE EXCEPTION
      'VS2 FAIL: 14-arg record_vehicle_removal EXISTS again (oid=%). Overload trap — PostgREST will see ambiguous candidates when clients omit p_notes.',
      v_old_oid;
  END IF;
END $vs2$;


-- ── VS3: ⚠ all nine parameter defaults survived CREATE OR REPLACE ══
-- CREATE OR REPLACE silently DROPS any default not re-typed. A lost
-- default on p_removal_type turns every call that omits it into an
-- error at the client, not here — so assert it in the catalog.
DO $vs3$
DECLARE
  v_oid       OID;
  v_ndefaults INT;
  v_args      TEXT;
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: function not found (VS1 should have caught)';
  END IF;

  SELECT pronargdefaults INTO v_ndefaults FROM pg_proc WHERE oid = v_oid;
  v_args := pg_get_function_arguments(v_oid);

  IF v_ndefaults <> 9 THEN
    RAISE EXCEPTION
      'VS3 FAIL: pronargdefaults = % (expected 9). CREATE OR REPLACE dropped % parameter default(s). Rendered args: %',
      v_ndefaults, 9 - v_ndefaults, v_args;
  END IF;

  -- p_removal_type is the only non-NULL default and the only one whose
  -- loss changes behaviour rather than just erroring. Assert its value
  -- explicitly. Pattern is deliberately tolerant of how Postgres
  -- re-renders the literal ('tow' vs 'tow'::text).
  IF v_args NOT LIKE '%p_removal_type text DEFAULT %tow%' THEN
    RAISE EXCEPTION
      'VS3 FAIL: p_removal_type default not present or not ''tow''. Rendered args: %',
      v_args;
  END IF;
END $vs3$;


-- ── VS4: 🔴 prosrc — the asymmetry regression lock ═════════════════
-- prosrc stores the body VERBATIM as submitted, INCLUDING COMMENTS —
-- no parse-tree re-rendering, so substring matching is stable here
-- (unlike pg_get_expr, which normalizes). The corollary is that a body
-- COMMENT mentioning the wrong normalizer in call syntax fails this
-- gate. That is intentional; the explanation belongs in COMMENT ON
-- FUNCTION (pg_description), which never appears in prosrc.
--
-- Precedent for the comment-trips-the-gate case: Sept 4, a section
-- header inside driver_create_violation_with_snapshot tripped a body
-- check looking for jsonb_populate_record.
DO $vs4$
DECLARE
  v_oid       OID;
  v_src       TEXT;
  v_bad_count INT;
  v_ok_count  INT;
  v_pos       INT;
  v_context   TEXT;
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: function not found (VS1 should have caught)';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;

  -- Condition A — the whitespace-only normalizer must NOT be applied
  -- to the incoming parameter anywhere in the body.
  v_bad_count := (length(v_src) - length(replace(v_src, 'normalize_plate(p_plate)', ''))) / length('normalize_plate(p_plate)');

  IF v_bad_count <> 0 THEN
    v_pos := position('normalize_plate(p_plate)' IN v_src);
    v_context := substr(v_src, greatest(v_pos - 90, 1), 200);
    RAISE EXCEPTION
      'VS4 FAIL (condition A): body applies the whitespace-only normalizer to the plate PARAMETER % time(s). Validation must track vehicle_removal_plate_normalize() (aggressive strip), not this. If the match is inside a COMMENT, rewrite the comment in prose and move the detail to COMMENT ON FUNCTION — prosrc includes comments. Context: ...%...',
      v_bad_count, v_context;
  END IF;

  -- Condition B — the STORED side of the soft link must still use it,
  -- exactly once, so the expression keeps matching
  -- vehicles_plate_norm_uniq. Zero means someone "harmonized" both
  -- sides and the index is no longer usable for that lookup; more than
  -- one means a second comparison appeared that this gate has not
  -- reasoned about.
  v_ok_count := (length(v_src) - length(replace(v_src, 'normalize_plate(v.plate)', ''))) / length('normalize_plate(v.plate)');

  IF v_ok_count <> 1 THEN
    RAISE EXCEPTION
      'VS4 FAIL (condition B): normalize_plate(v.plate) appears % time(s), expected exactly 1. The soft-link STORED side must keep the whitespace-only normalizer so the expression matches vehicles_plate_norm_uniq. Asymmetry is deliberate — see COMMENT ON FUNCTION and 20260909_tow_log_vehicle_removals.sql:127-135.',
      v_ok_count;
  END IF;

  -- Condition C — assert what the gate actually measured: the local
  -- exists. Without this, a body that dropped normalization entirely
  -- would satisfy A and B.
  IF position('v_plate_norm' IN v_src) = 0 THEN
    RAISE EXCEPTION
      'VS4 FAIL (condition C): v_plate_norm not present in the body. Conditions A and B pass trivially on a body with no plate normalization at all.';
  END IF;
END $vs4$;


-- ── VS5: grants — EXECUTE authenticated only ══════════════════════
DO $vs5$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS5 FAIL: function not found (VS1 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS5 FAIL: proacl NULL — default PUBLIC EXECUTE grant not revoked (feedback_function_public_grant_supabase_default)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%') THEN
    v_bad := v_bad || format('missing authenticated EXECUTE (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%') THEN
    v_bad := v_bad || format('anon EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%') THEN
    v_bad := v_bad || format('PUBLIC EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS5 FAIL: %', v_bad;
  END IF;
END $vs5$;


-- ── VS6: COMMENT ON FUNCTION on both functions ════════════════════
-- The trigger comment is load-bearing: vehicle_removal_plate_normalize
-- is unreachable in production after this migration and reads as dead
-- code in the catalog. pg_description is where someone looks before
-- dropping it; a migration file three weeks back is not.
DO $vs6$
DECLARE
  v_rpc_oid     OID;
  v_trg_oid     OID;
  v_rpc_comment TEXT;
  v_trg_comment TEXT;
BEGIN
  v_rpc_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  v_trg_oid := to_regprocedure('public.vehicle_removal_plate_normalize()');

  IF v_trg_oid IS NULL THEN
    RAISE EXCEPTION 'VS6 FAIL: public.vehicle_removal_plate_normalize() not found — the trigger function was dropped. It is the FLOOR for any future non-RPC write path.';
  END IF;

  v_rpc_comment := obj_description(v_rpc_oid, 'pg_proc');
  v_trg_comment := obj_description(v_trg_oid, 'pg_proc');

  IF v_rpc_comment IS NULL OR position('PLATE NORMALIZATION CONTRACT' IN v_rpc_comment) = 0 THEN
    RAISE EXCEPTION
      'VS6 FAIL: record_vehicle_removal comment missing or does not carry the PLATE NORMALIZATION CONTRACT section. Got: %',
      COALESCE(left(v_rpc_comment, 200), 'NULL');
  END IF;

  IF v_trg_comment IS NULL OR position('DO NOT DROP' IN v_trg_comment) = 0 THEN
    RAISE EXCEPTION
      'VS6 FAIL: vehicle_removal_plate_normalize comment missing or does not carry the DO NOT DROP note. Without it the trigger reads as dead code to an auditor. Got: %',
      COALESCE(left(v_trg_comment, 200), 'NULL');
  END IF;
END $vs6$;


-- ── VS7: audit row present ════════════════════════════════════════
DO $vs7$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_RECORD_VEHICLE_REMOVAL_PLATE_NORMALIZE_FIX'
     AND new_values ->> 'migration' = '20260910_record_vehicle_removal_plate_normalize_fix';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS7 FAIL: audit row missing';
  END IF;
END $vs7$;


-- ══════════════════════════════════════════════════════════════════════
-- EXECUTION GATES — real writes, rolled back
-- ══════════════════════════════════════════════════════════════════════
BEGIN;


-- ── FIXTURE PRE-CHECK ═══════════════════════════════════════════════
DO $fixtures$
DECLARE
  v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing
    FROM public.user_roles
   WHERE lower(trim(email)) = 'pm-manager@test.shieldmylot.com';
  IF v_missing < 1 THEN
    RAISE EXCEPTION 'FIXTURE FAIL: user_roles row for pm-manager@test.shieldmylot.com missing. Seed the test tenants (seed_test_tenants) and re-run.';
  END IF;

  SELECT COUNT(*) INTO v_missing
    FROM public.properties
   WHERE lower(trim(name))    = lower(trim('Test PM Property'))
     AND lower(trim(company)) = lower(trim('Test-PM'));
  IF v_missing < 1 THEN
    RAISE EXCEPTION 'FIXTURE FAIL: property ''Test PM Property'' in company ''Test-PM'' missing. Seed the test tenants and re-run.';
  END IF;

  -- Probe-plate collision guard. E2 inserts a vehicles row and asserts
  -- the soft link resolves to THAT id. If a row already carries the
  -- probe plate at this property, the gate would resolve to someone
  -- else's row and pass for the wrong reason.
  -- (feedback_probes_collide_with_production_state)
  SELECT COUNT(*) INTO v_missing
    FROM public.vehicles v
   WHERE normalize_plate(v.plate)   = 'EVPROBEX9'
     AND lower(trim(v.property))    = lower(trim('Test PM Property'))
     AND v.is_active                = true;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'FIXTURE FAIL: % active vehicles row(s) already carry probe plate EVPROBEX9 at Test PM Property. E2 would resolve the soft link to a pre-existing row and pass for the wrong reason. Change the probe plate constant in E2 and re-run.', v_missing;
  END IF;
END $fixtures$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 — punctuation-only plate → clean rejection, NO exception
-- 🔴 The bug's signature was an EXCEPTION where a clean rejection
-- belonged. A gate asserting only "an error came back" would pass on
-- the broken version, because SQLSTATE 22004 is also an error. This
-- block catches ANY exception and fails naming its sqlstate.
-- Pre-fix behaviour (Jose runbook, Sept 9):
--   ERROR 22004 vehicle_removals.plate cannot be empty after
--   normalization, raised from vehicle_removal_plate_normalize()
--
-- 📌 p_tow_operator_id := 1 IS DELIBERATE — DO NOT "FIX" IT.
-- Operator id 1 may not exist. This gate reaches plate_required anyway
-- because the RPC validates the plate BEFORE it resolves the tow
-- operator, so E1 doubles as an assertion that cheap validation runs
-- first. If someone reorders the validation block, this fails with
--   expected {"error":"plate_required"}; got {"error":"tow_operator_not_found"}
-- which names both the expectation and the reality — a legible failure,
-- not a false green. Passing a valid operator id here would silently
-- delete the ordering assertion.
-- ══════════════════════════════════════════════════════════════════════
DO $e1$
DECLARE
  v_result JSONB;
BEGIN
  -- Role-switch shape per 20260626_space_requests_v1_verification.sql:246
  -- — direct SET LOCAL ROLE, and BOTH claim keys (plural is what
  -- auth.jwt() reads; singular is the legacy key some helpers still
  -- consult).
  PERFORM set_config('request.jwt.claims',
    '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',
    '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  BEGIN
    v_result := public.record_vehicle_removal(
      p_property            := 'Test PM Property',
      p_plate               := '---',
      p_reason_code         := 'unauthorized_vehicle',
      p_towed_at            := now(),
      p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
      p_tow_operator_id     := 1
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'E1 FAIL: punctuation-only plate RAISED instead of returning a clean rejection. sqlstate=% message=%. This is the pre-fix behaviour — validation is still tracking the whitespace-only normalizer while the table trigger uses the aggressive strip.',
      SQLSTATE, SQLERRM;
  END;

  IF v_result ->> 'error' IS DISTINCT FROM 'plate_required' THEN
    RAISE EXCEPTION
      'E1 FAIL: expected {"error":"plate_required"}; got %.',
      v_result;
  END IF;

  RESET ROLE;
END $e1$;


-- ══════════════════════════════════════════════════════════════════════
-- E2 + E3 — soft link resolves across punctuation; audit matches row
--
-- E2 is the first gate that proves the soft link works AT ALL. Fixture:
-- an active vehicles row whose stored plate is already alphanumeric
-- ('EVPROBEX9'), then the RPC called with the DASHED form of the same
-- plate ('EV-PROBE-X9'). Pre-fix, the input side normalized to
-- 'EV-PROBE-X9', never matched, and linked_vehicle_id came back NULL
-- with no error — the silent half of the bug.
--
-- E3 then asserts audit plate == row plate == 'EVPROBEX9'. The
-- expected value is asserted explicitly, not just the equality:
-- equality alone would pass if BOTH carried the raw dashed form.
-- ══════════════════════════════════════════════════════════════════════
DO $e2_e3$
DECLARE
  v_op_result     JSONB;
  v_op_id         BIGINT;
  v_vehicle_id    BIGINT;
  v_result        JSONB;
  v_removal_id    BIGINT;
  v_linked        BIGINT;
  v_row_plate     TEXT;
  v_audit_plate   TEXT;
BEGIN
  -- ── Fixture: probe vehicle, written as postgres (RLS bypass) ─────
  RESET ROLE;
  INSERT INTO public.vehicles (plate, property, company, status, is_active, resident_read)
  VALUES ('EVPROBEX9', 'Test PM Property', 'Test-PM', 'active', TRUE, FALSE)
  RETURNING id INTO v_vehicle_id;

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'E2 FIXTURE FAIL: probe vehicles row did not return an id.';
  END IF;

  -- ── Fixture: an active tow operator inside Test-PM ───────────────
  -- Name uses hyphens/spaces only — tow_operators_name_no_sql_metachar
  -- refuses %, _ and \.
  -- Role-switch shape per 20260626_space_requests_v1_verification.sql:246
  -- — direct SET LOCAL ROLE, and BOTH claim keys (plural is what
  -- auth.jwt() reads; singular is the legacy key some helpers still
  -- consult).
  PERFORM set_config('request.jwt.claims',
    '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',
    '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  v_op_result := public.create_tow_operator('EV-PROBE PLATE-FIX TOWING',
                                            '713-555-0110',
                                            'TDLR-90910',
                                            'plate normalize fix verification probe');
  v_op_id := (v_op_result ->> 'id')::BIGINT;
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'E2 FIXTURE FAIL: create_tow_operator returned %', v_op_result;
  END IF;

  -- ── THE CALL: dashed form of the stored plate ────────────────────
  v_result := public.record_vehicle_removal(
    p_property            := 'Test PM Property',
    p_plate               := 'EV-PROBE-X9',
    p_reason_code         := 'unauthorized_vehicle',
    p_towed_at            := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id     := v_op_id
  );

  IF (v_result ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'E2 FAIL: expected {ok:true, id}; got %.', v_result;
  END IF;
  v_removal_id := (v_result ->> 'id')::BIGINT;

  -- ── Read back as postgres (bypass RLS) ───────────────────────────
  RESET ROLE;
  SELECT r.linked_vehicle_id, r.plate
    INTO v_linked, v_row_plate
    FROM public.vehicle_removals r
   WHERE r.id = v_removal_id;

  -- E2: soft link resolved to the probe vehicle
  IF v_linked IS NULL THEN
    RAISE EXCEPTION
      'E2 FAIL: linked_vehicle_id is NULL. The dashed input did not match the stored alphanumeric plate — the input side is still being normalized with the whitespace-only normalizer. Expected vehicle id %.',
      v_vehicle_id;
  END IF;
  IF v_linked <> v_vehicle_id THEN
    RAISE EXCEPTION
      'E2 FAIL: linked_vehicle_id = % but the probe vehicle is id %. The soft link resolved to a DIFFERENT row — check the probe-plate collision guard.',
      v_linked, v_vehicle_id;
  END IF;

  -- E3a: the stored plate is the aggressively-normalized form
  IF v_row_plate IS DISTINCT FROM 'EVPROBEX9' THEN
    RAISE EXCEPTION
      'E3 FAIL: vehicle_removals.plate = % (expected EVPROBEX9).',
      COALESCE(v_row_plate, 'NULL');
  END IF;

  -- E3b: the audit entry carries the SAME plate as the row it describes
  SELECT a.new_values ->> 'plate'
    INTO v_audit_plate
    FROM public.audit_logs a
   WHERE a.action     = 'VEHICLE_REMOVAL_RECORDED'
     AND a.table_name = 'vehicle_removals'
     AND a.record_id  = v_removal_id::TEXT
   ORDER BY a.created_at DESC
   LIMIT 1;

  IF v_audit_plate IS NULL THEN
    RAISE EXCEPTION
      'E3 FAIL: no VEHICLE_REMOVAL_RECORDED audit row found for removal id % — cannot distinguish "audit plate matches" from "audit row absent".',
      v_removal_id;
  END IF;
  IF v_audit_plate IS DISTINCT FROM v_row_plate THEN
    RAISE EXCEPTION
      'E3 FAIL: audit plate = % but the row it describes holds %. On a log of record the audit entry and its row must never carry different plates.',
      v_audit_plate, v_row_plate;
  END IF;
  IF v_audit_plate IS DISTINCT FROM 'EVPROBEX9' THEN
    RAISE EXCEPTION
      'E3 FAIL: audit plate and row plate agree at % but both are wrong (expected EVPROBEX9).',
      v_audit_plate;
  END IF;
END $e2_e3$;


ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- FINAL: PASS row — LAST statement in the paste, AFTER the ROLLBACK,
-- so the SQL Editor returns it. Nothing from the execution block
-- persists.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'record_vehicle_removal plate normalization (structural VS1-VS7 + execution E1-E3)'::TEXT AS target,
  ARRAY[
    'VS1  15-arg record_vehicle_removal exists + SECURITY DEFINER',
    'VS2  14-arg signature still GONE (no overload resurrected)',
    'VS3  all nine parameter defaults intact (pronargdefaults=9, p_removal_type DEFAULT ''tow'')',
    'VS4  prosrc: normalize_plate(p_plate) x0, normalize_plate(v.plate) x1, v_plate_norm present',
    'VS5  EXECUTE granted to authenticated only (no anon, no PUBLIC)',
    'VS6  COMMENT ON FUNCTION on both the RPC and the trigger fn (DO NOT DROP note)',
    'VS7  SCHEMA_RECORD_VEHICLE_REMOVAL_PLATE_NORMALIZE_FIX audit row present',
    'E1   punctuation-only plate → {"error":"plate_required"} with NO exception raised',
    'E2   dashed input vs stored alphanumeric plate → linked_vehicle_id resolved (soft link proven working, first time)',
    'E3   audit new_values->>''plate'' == vehicle_removals.plate == ''EVPROBEX9''',
    'DISCIPLINE: E1 asserts absence-of-exception, not merely presence-of-error — 22004 is also an error and would pass a weaker gate'
  ] AS gates_verified,
  now() AS verified_at;

-- ══════════════════════════════════════════════════════════════════
-- POST-ROLLBACK STATE
-- ------------------------------------------------------------------
-- • vehicles         — no EVPROBEX9 row
-- • tow_operators    — no 'EV-PROBE PLATE-FIX TOWING' row
-- • vehicle_removals — no probe removal row
-- • audit_logs       — no VEHICLE_REMOVAL_RECORDED / TOW_OPERATOR_*
--                      rows from this run
-- BIGSERIAL sequences advance (not transactional; harmless — every
-- assertion is relative or against a value this file supplied).
-- Re-runnable indefinitely.
-- ══════════════════════════════════════════════════════════════════
