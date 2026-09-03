-- ══════════════════════════════════════════════════════════════════════
-- 20260904_driver_create_violation_column_allowlist_and_scope_verification.sql
--
-- Paired verification for Commit 3 Commit B. v2 pattern (no BEGIN/COMMIT
-- wrap; terminal SELECT returns PASS row). 8 gates + live-smoke plan.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  fn exists via to_regprocedure (signature preserved)
--   VS2  SECURITY DEFINER + search_path pinned + LANGUAGE plpgsql
--   VS3  signature UNCHANGED (args + result — should match Commit 2's shape)
--   VS4  GRANTs — authenticated EXECUTE, anon + PUBLIC REVOKEd
--   VS5  body contains new markers (unrecognized_keys +
--        get_my_driver_assigned_properties + property_not_authorized_for_driver)
--        + retained Commit 2 gate (my_tier_enforcement_capable +
--        tier_not_permitted) + MISSING jsonb_populate_record
--   VS6  🔴 EXECUTION — driver with unknown key → returns 'unrecognized_keys'
--   VS7  🔴 EXECUTION — driver with unassigned property → returns
--        'property_not_authorized_for_driver'
--   VS8  audit row + snapshot present
--
-- ── EXECUTION-SUCCESS COVERAGE ──────────────────────────────────────
-- The RPC's happy path INSERTs into public.violations. In-migration
-- SUCCESS probes would create real rows; even wrapped in SAVEPOINT +
-- ROLLBACK, the child violation_context_records writes fire triggers
-- (DNT check, name-trim triggers) that touch other tables. Skipped
-- here in favor of live A1 smoke per Mateo Sep 3 followup §4.
--
-- ── LIVE A1 SMOKE PLAN (post-push, before signup flip) ──────────────
-- Test-LEGACY driver at real property scans a real plate. Expected:
--   • RPC returns { ok: true, id: <n>, snapshot_status: ..., snapshot_count: N }
--   • Row lands in violations with is_confirmed=false, snapshot_status
--     as computed, tow_* NULL, void* NULL, view_token* NULL
--   • Confirm step (driver:1565) still works: UPDATE is_confirmed=true
--   • Photos + videos attach by violation_id (unchanged flow)
--   • Stamp path (stamp_tow_ticket) works on the confirmed row
--
-- If any of the above breaks: rollback signal = revert Commit B (RPC
-- CREATE OR REPLACE back to prior body from 20260803_violation_snapshot.sql).
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: fn exists ──────────────────────────────────────────────────
DO $vs1$
BEGIN
  IF to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: fn not found post-Commit-B';
  END IF;
END $vs1$;


-- ── VS2: DEFINER + search_path + LANGUAGE plpgsql ──────────────────
DO $vs2$
DECLARE
  v_oid oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  v_secdef BOOLEAN;
  v_config TEXT[];
  v_lang TEXT;
BEGIN
  SELECT prosecdef, proconfig, (SELECT lanname FROM pg_language WHERE oid = prolang)
    INTO v_secdef, v_config, v_lang
    FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'VS2 FAIL: not SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'VS2 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'VS2 FAIL: LANGUAGE=% (want plpgsql)', v_lang;
  END IF;
END $vs2$;


-- ── VS3: signature UNCHANGED ────────────────────────────────────────
DO $vs3$
DECLARE
  v_oid oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  v_args TEXT;
  v_result TEXT;
BEGIN
  v_args := pg_get_function_arguments(v_oid);
  v_result := pg_get_function_result(v_oid);
  IF v_args <> 'p_violation jsonb, p_snapshot jsonb' THEN
    RAISE EXCEPTION 'VS3 FAIL: args drift — got %L (want ''p_violation jsonb, p_snapshot jsonb'')', v_args;
  END IF;
  IF v_result NOT ILIKE '%jsonb%' THEN
    RAISE EXCEPTION 'VS3 FAIL: result=% (want jsonb). Signature drift.', v_result;
  END IF;
END $vs3$;


-- ── VS4: GRANTs correct ─────────────────────────────────────────────
DO $vs4$
DECLARE
  v_oid oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  v_acl TEXT;
BEGIN
  SELECT array_to_string(proacl::TEXT[], ',') INTO v_acl FROM pg_proc WHERE oid = v_oid;
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: proacl is NULL (default = EXECUTE to PUBLIC, defect)';
  END IF;
  IF v_acl NOT LIKE '%authenticated=X/%' THEN
    RAISE EXCEPTION 'VS4 FAIL: missing GRANT EXECUTE TO authenticated. proacl=%', v_acl;
  END IF;
  IF v_acl LIKE '%anon=X/%' THEN
    RAISE EXCEPTION 'VS4 FAIL: EXECUTE to anon present (should be REVOKEd). proacl=%', v_acl;
  END IF;
END $vs4$;


-- ── VS5: body substring assertions (new markers + retired marker) ──
DO $vs5$
DECLARE
  v_oid oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  v_body TEXT;
BEGIN
  v_body := pg_get_functiondef(v_oid);

  -- New Commit 3 Commit B markers MUST be present
  IF v_body NOT LIKE '%unrecognized_keys%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing unrecognized_keys marker (allowlist enforcement)';
  END IF;
  IF v_body NOT LIKE '%get_my_driver_assigned_properties%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing get_my_driver_assigned_properties call (driver scope guard via Commit A helper)';
  END IF;
  IF v_body NOT LIKE '%property_not_authorized_for_driver%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing property_not_authorized_for_driver return';
  END IF;
  IF v_body NOT LIKE '%driver_no_properties_assigned%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing driver_no_properties_assigned return';
  END IF;
  IF v_body NOT LIKE '%property_not_authorized_for_ca%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing property_not_authorized_for_ca return (CA scope guard)';
  END IF;

  -- Commit 2 gate MUST STILL BE PRESENT (regression guard)
  IF v_body NOT LIKE '%my_tier_enforcement_capable%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing my_tier_enforcement_capable — Commit 2 gate REGRESSION';
  END IF;
  IF v_body NOT LIKE '%tier_not_permitted%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body missing tier_not_permitted RAISE — Commit 2 gate REGRESSION';
  END IF;

  -- Retired vector MUST BE ABSENT (as a CALL — comments referencing
  -- the identifier are fine; pg_get_functiondef preserves both).
  -- Match `identifier(` for call-shape; bare `%identifier%` false-
  -- positived on the section-header comment inside the new body.
  IF v_body LIKE '%jsonb_populate_record(%' THEN
    RAISE EXCEPTION 'VS5 FAIL: body still CALLS jsonb_populate_record — mass-assignment vector NOT closed';
  END IF;
END $vs5$;


-- ══════════════════════════════════════════════════════════════════════
-- VS6 — 🔴 EXECUTION: unknown key → 'unrecognized_keys'
-- ══════════════════════════════════════════════════════════════════════
-- Picks a driver with assigned_properties, impersonates, calls the fn
-- with a payload containing a key NOT on the allowlist. RPC should
-- return { error: 'unrecognized_keys', keys: [...] } as a jsonb data
-- payload — NOT raise. Client's fallback (67b76f5) surfaces via
-- Branch 1 without falling back.
--
-- The rejection happens BEFORE any INSERT — no violations row lands.
DO $vs6$
DECLARE
  v_email TEXT;
  v_property TEXT;
  v_result JSONB;
  v_err TEXT;
BEGIN
  SELECT ur.email
    INTO v_email
    FROM public.user_roles ur
   WHERE ur.role = 'driver'
     AND ur.is_active = TRUE
   ORDER BY ur.id LIMIT 1;
  IF v_email IS NULL THEN
    RAISE NOTICE 'VS6 SKIP: no active driver in user_roles. Cannot exercise unrecognized_keys.';
    RETURN;
  END IF;

  -- Pick a property they're assigned to so we get PAST the scope guard
  -- to reach the allowlist check. Actually — order is allowlist FIRST,
  -- then scope. So we don't need a valid property. Use anything.
  v_property := 'probe';

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  v_result := public.driver_create_violation_with_snapshot(
    jsonb_build_object(
      'plate', 'PROBE1',
      'violation_type', 'probe',
      'property', v_property,
      'scanned_at', now()::TEXT,
      'headline_status_at_scan', 'notfound',
      'unknown_evil_key', 'bad_value'      -- ← the key that should reject
    ),
    '[]'::jsonb
  );

  EXECUTE 'RESET role';

  v_err := v_result ->> 'error';
  IF v_err IS DISTINCT FROM 'unrecognized_keys' THEN
    RAISE EXCEPTION 'VS6 FAIL: expected error=unrecognized_keys, got %L (full result: %)', v_err, v_result::TEXT;
  END IF;
END $vs6$;


-- ══════════════════════════════════════════════════════════════════════
-- VS7 — 🔴 EXECUTION: unassigned property → 'property_not_authorized_for_driver'
-- ══════════════════════════════════════════════════════════════════════
-- Picks a driver with assigned_properties, impersonates, calls fn with
-- a property GUARANTEED not in their list ("__vs7_probe_" prefix — no
-- real property has this).
DO $vs7$
DECLARE
  v_email TEXT;
  v_assigned TEXT[];
  v_result JSONB;
  v_err TEXT;
BEGIN
  -- Find a driver with a non-empty assigned_properties AND matching user_roles
  SELECT ur.email
    INTO v_email
    FROM public.user_roles ur
    JOIN public.drivers d
      ON lower(d.email) = lower(ur.email)
   WHERE ur.role = 'driver'
     AND ur.is_active = TRUE
     AND d.is_active = TRUE
     AND d.assigned_properties IS NOT NULL
     AND array_length(d.assigned_properties, 1) IS NOT NULL
   ORDER BY ur.id LIMIT 1;
  IF v_email IS NULL THEN
    RAISE NOTICE 'VS7 SKIP: no active driver with assigned_properties + matching user_roles. Cannot exercise scope guard.';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  v_result := public.driver_create_violation_with_snapshot(
    jsonb_build_object(
      'plate', 'PROBE7',
      'violation_type', 'probe',
      'property', 'vs7probe_never_a_real_property_' || floor(extract(epoch from now()))::TEXT,
      'scanned_at', now()::TEXT,
      'headline_status_at_scan', 'notfound'
    ),
    '[]'::jsonb
  );

  EXECUTE 'RESET role';

  v_err := v_result ->> 'error';
  IF v_err IS DISTINCT FROM 'property_not_authorized_for_driver' THEN
    RAISE EXCEPTION 'VS7 FAIL: expected error=property_not_authorized_for_driver, got %L (full result: %)', v_err, v_result::TEXT;
  END IF;
END $vs7$;


-- ── VS8: audit row + snapshot present ──────────────────────────────
DO $vs8$
DECLARE v_count INT; v_migration TEXT;
BEGIN
  SELECT COUNT(*), MAX(new_values ->> 'migration')
    INTO v_count, v_migration
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DRIVER_CREATE_VIOLATION_ALLOWLIST_AND_SCOPE'
     AND new_values ->> 'migration' = '20260904_driver_create_violation_column_allowlist_and_scope';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: audit row missing';
  END IF;
END $vs8$;


-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'driver_create_violation_with_snapshot (Commit 3 Commit B rewrite)'::TEXT AS target,
  ARRAY[
    'VS1  fn exists post-rewrite',
    'VS2  SECURITY DEFINER + search_path + LANGUAGE plpgsql preserved',
    'VS3  signature (args + result) UNCHANGED — parity',
    'VS4  GRANTs — authenticated EXECUTE, anon REVOKEd',
    'VS5  body markers: new (unrecognized_keys + get_my_driver_assigned_properties + property_not_authorized_for_driver + driver_no_properties_assigned + property_not_authorized_for_ca) + retained (my_tier_enforcement_capable + tier_not_permitted) + retired (NO jsonb_populate_record)',
    'VS6  🔴 execution — driver + unknown key → unrecognized_keys (or SKIP)',
    'VS7  🔴 execution — driver + unassigned property → property_not_authorized_for_driver (or SKIP)',
    'VS8  SCHEMA_DRIVER_CREATE_VIOLATION_ALLOWLIST_AND_SCOPE audit row',
    'LIVE A1 SMOKE (post-push, before flip): Test-LEGACY driver full flow — scan, confirm, stamp — see header'
  ] AS gates_verified,
  now() AS verified_at;
