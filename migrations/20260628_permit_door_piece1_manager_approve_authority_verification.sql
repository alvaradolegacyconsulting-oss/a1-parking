-- Verification queries for Piece 1 Migration A (manager approve authority).
--
-- RUN ORDER:
--   1. Section A BEFORE applying (pre-state)
--   2. Apply 20260628_permit_door_piece1_manager_approve_authority.sql
--   3. Sections B–H post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: can_approve_vehicles column present + correct type/default
--   - C: set_manager_approve_permission pg_proc=1 + signature + DEFINER
--   - D: grants — set_manager_approve_permission authenticated EXECUTE
--        only; approve_vehicle grants UNCHANGED (PRESERVED from C4a)
--   - ★★ E: approve_vehicle scope-check NEGATIVE — RE-RUN of C4a's
--         security test. Must STILL fire. If E fails, scope-check
--         regressed during CREATE OR REPLACE; ABORT.
--   - ★ F: NEW authority gate fires — manager without authority blocked;
--         manager WITH authority allowed; CA always allowed.
--   - G: set_manager_approve_permission positive/noop/error paths
--
-- All behavioral tests are auto-asserting DO blocks (mirror commit 4a
-- pattern) — fail LOUD via RAISE EXCEPTION rather than needing manual
-- NOTICE inspection.

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE
-- ════════════════════════════════════════════════════════════════════

SELECT
  -- Column absent
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='user_roles'
                 AND column_name='can_approve_vehicles')
    AS pre_no_can_approve_column,
  -- set_manager_approve_permission absent
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='set_manager_approve_permission'
      AND pronamespace='public'::regnamespace) = 0
    AS pre_no_set_manager_approve_rpc,
  -- approve_vehicle exists (C4a is shipped) BUT body doesn't yet contain
  -- the authority clause
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='approve_vehicle'
             AND pronamespace='public'::regnamespace)                          AS pre_approve_vehicle_exists,
  pg_get_functiondef('public.approve_vehicle(bigint, text)'::regprocedure)
    NOT LIKE '%manager_approval_not_authorized%'                               AS pre_no_authority_clause;
-- Expected PRE-APPLY: all 4 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — can_approve_vehicles column shape
-- ════════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='user_roles'
   AND column_name='can_approve_vehicles';
-- Expected 1 row:
--   can_approve_vehicles | boolean | NO | false


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — set_manager_approve_permission signature/identity
-- ════════════════════════════════════════════════════════════════════

SELECT
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='set_manager_approve_permission'
      AND pronamespace='public'::regnamespace) = 1                              AS exactly_one_signature,
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='set_manager_approve_permission'
             AND pronamespace='public'::regnamespace
             AND pronargs = 2
             AND proargtypes::oid[] = ARRAY['text'::regtype::oid, 'boolean'::regtype::oid])
    AS signature_text_boolean,
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='set_manager_approve_permission'
             AND pronamespace='public'::regnamespace
             AND prosecdef = TRUE)                                              AS is_security_definer,
  -- Sanity: approve_vehicle still single signature
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='approve_vehicle'
      AND pronamespace='public'::regnamespace) = 1                              AS approve_vehicle_still_single_sig;
-- Expected: all 4 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — grants
-- ════════════════════════════════════════════════════════════════════

-- D.1 — set_manager_approve_permission grants (NEW function; footgun)
SELECT
  EXISTS (SELECT 1 FROM information_schema.routine_privileges
           WHERE routine_schema='public'
             AND routine_name='set_manager_approve_permission'
             AND grantee='authenticated' AND privilege_type='EXECUTE')         AS smap_authenticated_execute,
  NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
               WHERE routine_schema='public'
                 AND routine_name='set_manager_approve_permission'
                 AND grantee IN ('anon', 'PUBLIC'))                            AS smap_no_anon_or_public;
-- Expected: both TRUE.

-- D.2 — approve_vehicle grants UNCHANGED (PRESERVED from C4a)
SELECT
  EXISTS (SELECT 1 FROM information_schema.routine_privileges
           WHERE routine_schema='public'
             AND routine_name='approve_vehicle'
             AND grantee='authenticated' AND privilege_type='EXECUTE')         AS av_authenticated_execute,
  NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
               WHERE routine_schema='public'
                 AND routine_name='approve_vehicle'
                 AND grantee IN ('anon', 'PUBLIC'))                            AS av_no_anon_or_public;
-- Expected: both TRUE.


-- ════════════════════════════════════════════════════════════════════
-- E. ★★ LOAD-BEARING — approve_vehicle SCOPE-CHECK NEGATIVE (regression-guard)
-- ════════════════════════════════════════════════════════════════════
-- RE-RUN of commit 4a Section E. If this fails post-this-migration,
-- the CREATE OR REPLACE regressed the scope-check during the body
-- change. ABORT and investigate before any app wiring.
--
-- Manager scoped only to property A, vehicle at property B,
-- manager has can_approve_vehicles=TRUE (so the new authority gate
-- doesn't shadow the scope-check failure we're testing for) →
-- RPC must reject with error='vehicle_out_of_scope' AND vehicle
-- row UNMUTATED.

DO $av_scope_negative$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_test_manager_email CONSTANT TEXT := '__piece1_e_manager__@example.invalid';
  v_test_property_a  CONSTANT TEXT := '__piece1_e_property_a__';
  v_test_property_b  CONSTANT TEXT := '__piece1_e_property_b__';
  v_test_plate       CONSTANT TEXT := 'OUTOFSCOPE1';
  v_resolved_company TEXT;
  v_test_vehicle_id  BIGINT;
  v_rpc_result       JSONB;
  v_after_status     TEXT;
  v_after_is_active  BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();
  IF v_resolved_company IS NULL THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — CA JWT mock did not resolve a company.';
  END IF;

  -- Fixtures: 2 properties + manager scoped only to A + with authority
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES
    (v_test_property_a, v_resolved_company, '111 Test', TRUE),
    (v_test_property_b, v_resolved_company, '222 Test', TRUE);

  -- Critical: GRANT can_approve_vehicles=TRUE so we're isolating the
  -- scope-check failure (not the new authority gate failure).
  INSERT INTO public.user_roles (email, role, company, name, property, can_approve_vehicles)
  VALUES (v_test_manager_email, 'manager', v_resolved_company, '__piece1_e_manager_name__',
          ARRAY[v_test_property_a], TRUE);

  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_test_plate, v_test_property_b, 'pending', FALSE, FALSE)
  RETURNING id INTO v_test_vehicle_id;

  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_test_manager_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_test_manager_email), true);

  v_rpc_result := public.approve_vehicle(p_vehicle_id := v_test_vehicle_id);

  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  SELECT status, is_active INTO v_after_status, v_after_is_active
    FROM public.vehicles WHERE id = v_test_vehicle_id;

  RAISE NOTICE '── Section E scope-check NEGATIVE (regression-guard) ──';
  RAISE NOTICE '  rpc_result      = % (expected error=vehicle_out_of_scope)', v_rpc_result;
  RAISE NOTICE '  after.status    = % (expected ''pending'' UNMUTATED)', v_after_status;
  RAISE NOTICE '  after.is_active = % (expected false UNMUTATED)', v_after_is_active;

  DELETE FROM public.vehicles   WHERE id = v_test_vehicle_id;
  DELETE FROM public.user_roles WHERE email = v_test_manager_email;
  DELETE FROM public.properties WHERE name IN (v_test_property_a, v_test_property_b);

  IF (v_rpc_result->>'error') IS NULL THEN
    RAISE EXCEPTION 'Section E FAIL — RPC RETURNED OK FOR OUT-OF-SCOPE VEHICLE. SCOPE-CHECK REGRESSED. Got: %', v_rpc_result;
  END IF;
  IF (v_rpc_result->>'error') <> 'vehicle_out_of_scope' THEN
    RAISE EXCEPTION 'Section E FAIL — wrong error string. Expected vehicle_out_of_scope, got: %', v_rpc_result->>'error';
  END IF;
  IF v_after_status <> 'pending' OR v_after_is_active IS TRUE THEN
    RAISE EXCEPTION 'Section E FAIL — vehicle MUTATED despite scope rejection. status=%, is_active=%', v_after_status, v_after_is_active;
  END IF;
END;
$av_scope_negative$;


-- ════════════════════════════════════════════════════════════════════
-- F. ★ LOAD-BEARING — NEW authority gate fires
-- ════════════════════════════════════════════════════════════════════
-- 3 sub-tests in one DO block:
--   F.1: Manager WITHOUT authority → REJECTED with 'manager_approval_not_authorized'
--   F.2: Manager WITH authority → APPROVED (action='approved')
--   F.3: CA caller (no authority needed) → APPROVED regardless of column value
--
-- All fixtures cleaned unconditionally.

DO $av_authority_gate$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_mgr_no_auth      CONSTANT TEXT := '__piece1_f_mgr_no_auth__@example.invalid';
  v_mgr_with_auth    CONSTANT TEXT := '__piece1_f_mgr_with_auth__@example.invalid';
  v_test_property    CONSTANT TEXT := '__piece1_f_property__';
  v_resolved_company TEXT;
  v_plate_f1         CONSTANT TEXT := 'F1NOAUTH';
  v_plate_f2         CONSTANT TEXT := 'F2WITHAUTH';
  v_plate_f3         CONSTANT TEXT := 'F3CAALWAYS';
  v_veh_f1           BIGINT;
  v_veh_f2           BIGINT;
  v_veh_f3           BIGINT;
  v_result_f1        JSONB;
  v_result_f2        JSONB;
  v_result_f3        JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();

  -- Fixtures: shared property + 2 managers + 3 pending vehicles
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES (v_test_property, v_resolved_company, '333 Test', TRUE);

  INSERT INTO public.user_roles (email, role, company, name, property, can_approve_vehicles)
  VALUES
    (v_mgr_no_auth,   'manager', v_resolved_company, '__piece1_f_mgr_no_auth__', ARRAY[v_test_property], FALSE),
    (v_mgr_with_auth, 'manager', v_resolved_company, '__piece1_f_mgr_with_auth__', ARRAY[v_test_property], TRUE);

  -- 3 separate INSERTs (each its own RETURNING) — multi-row INSERT
  -- with RETURNING INTO scalar raises P0003 in PG17; each insert
  -- captures one id deterministically. Patched 2026-06-28 after the
  -- prior multi-row form crashed Section F's setup before any
  -- approval test could fire (gate was unverified, not broken).
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_plate_f1, v_test_property, 'pending', FALSE, FALSE) RETURNING id INTO v_veh_f1;
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_plate_f2, v_test_property, 'pending', FALSE, FALSE) RETURNING id INTO v_veh_f2;
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_plate_f3, v_test_property, 'pending', FALSE, FALSE) RETURNING id INTO v_veh_f3;

  -- F.1 — Manager NO authority → REJECTED
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_mgr_no_auth), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_mgr_no_auth), true);
  v_result_f1 := public.approve_vehicle(p_vehicle_id := v_veh_f1);

  -- F.2 — Manager WITH authority → APPROVED
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_mgr_with_auth), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_mgr_with_auth), true);
  v_result_f2 := public.approve_vehicle(p_vehicle_id := v_veh_f2);

  -- F.3 — CA (no toggle needed) → APPROVED
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_result_f3 := public.approve_vehicle(p_vehicle_id := v_veh_f3);

  RAISE NOTICE '── Section F NEW authority gate ──';
  RAISE NOTICE '  F.1 (mgr no auth)   = % (expected error=manager_approval_not_authorized)', v_result_f1;
  RAISE NOTICE '  F.2 (mgr with auth) = % (expected action=approved)', v_result_f2;
  RAISE NOTICE '  F.3 (CA bypass)     = % (expected action=approved)', v_result_f3;

  -- Cleanup unconditional
  DELETE FROM public.vehicles   WHERE id IN (v_veh_f1, v_veh_f2, v_veh_f3);
  DELETE FROM public.user_roles WHERE email IN (v_mgr_no_auth, v_mgr_with_auth);
  DELETE FROM public.properties WHERE name = v_test_property;

  IF (v_result_f1->>'error') <> 'manager_approval_not_authorized' THEN
    RAISE EXCEPTION 'Section F.1 FAIL — manager without authority should be rejected. Got: %', v_result_f1;
  END IF;
  IF (v_result_f2->>'action') <> 'approved' THEN
    RAISE EXCEPTION 'Section F.2 FAIL — manager WITH authority should approve. Got: %', v_result_f2;
  END IF;
  IF (v_result_f3->>'action') <> 'approved' THEN
    RAISE EXCEPTION 'Section F.3 FAIL — CA caller (no toggle needed) should approve. Got: %', v_result_f3;
  END IF;
END;
$av_authority_gate$;


-- ════════════════════════════════════════════════════════════════════
-- G. set_manager_approve_permission — positive/noop/error paths
-- ════════════════════════════════════════════════════════════════════

DO $smap_test$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_test_manager     CONSTANT TEXT := '__piece1_g_manager__@example.invalid';
  v_resolved_company TEXT;
  v_result_grant     JSONB;
  v_result_noop      JSONB;
  v_result_revoke    JSONB;
  v_result_not_mgr   JSONB;
  v_after_value      BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();

  -- Fixture: throwaway manager, starts with can_approve_vehicles=FALSE (DEFAULT)
  INSERT INTO public.user_roles (email, role, company, name, property)
  VALUES (v_test_manager, 'manager', v_resolved_company, '__piece1_g_mgr__', ARRAY[]::TEXT[]);

  -- G.1 — Grant (was FALSE, becomes TRUE → not noop)
  v_result_grant := public.set_manager_approve_permission(
    p_manager_email := v_test_manager, p_allowed := TRUE);

  -- G.2 — Re-grant (already TRUE → noop)
  v_result_noop := public.set_manager_approve_permission(
    p_manager_email := v_test_manager, p_allowed := TRUE);

  -- G.3 — Revoke (was TRUE, becomes FALSE → not noop)
  v_result_revoke := public.set_manager_approve_permission(
    p_manager_email := v_test_manager, p_allowed := FALSE);

  -- G.4 — Call on CA self (not_a_manager error)
  v_result_not_mgr := public.set_manager_approve_permission(
    p_manager_email := v_admin_email, p_allowed := TRUE);

  SELECT can_approve_vehicles INTO v_after_value
    FROM public.user_roles WHERE lower(email) = lower(v_test_manager);

  RAISE NOTICE '── Section G set_manager_approve_permission ──';
  RAISE NOTICE '  G.1 grant    = % (expected ok=true, noop=false, new_value=true)', v_result_grant;
  RAISE NOTICE '  G.2 re-grant = % (expected ok=true, noop=TRUE, new_value=true)',  v_result_noop;
  RAISE NOTICE '  G.3 revoke   = % (expected ok=true, noop=false, new_value=false)', v_result_revoke;
  RAISE NOTICE '  G.4 not-mgr  = % (expected error=not_a_manager)', v_result_not_mgr;
  RAISE NOTICE '  after value  = % (expected false after revoke)', v_after_value;

  DELETE FROM public.user_roles WHERE email = v_test_manager;

  IF (v_result_grant->>'noop')::BOOLEAN IS NOT FALSE OR (v_result_grant->>'new_value')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'Section G.1 FAIL — grant should not be noop + new_value=true. Got: %', v_result_grant;
  END IF;
  IF (v_result_noop->>'noop')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'Section G.2 FAIL — re-grant should be noop. Got: %', v_result_noop;
  END IF;
  IF (v_result_revoke->>'noop')::BOOLEAN IS NOT FALSE OR (v_result_revoke->>'new_value')::BOOLEAN IS NOT FALSE THEN
    RAISE EXCEPTION 'Section G.3 FAIL — revoke should not be noop + new_value=false. Got: %', v_result_revoke;
  END IF;
  IF (v_result_not_mgr->>'error') <> 'not_a_manager' THEN
    RAISE EXCEPTION 'Section G.4 FAIL — calling on non-manager should error not_a_manager. Got: %', v_result_not_mgr;
  END IF;
  IF v_after_value IS NOT FALSE THEN
    RAISE EXCEPTION 'Section G FAIL — final value should be FALSE after revoke. Got: %', v_after_value;
  END IF;
END;
$smap_test$;


-- ════════════════════════════════════════════════════════════════════
-- H. Migration audit row landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE action = 'SCHEMA_PERMIT_DOOR_FIX'
   AND new_values->>'migration' = '20260628_permit_door_piece1_manager_approve_authority'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.
