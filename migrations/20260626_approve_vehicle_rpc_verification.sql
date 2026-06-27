-- Verification queries for approve_vehicle() RPC migration.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (pre-state: no approve_vehicle function)
--   2. Apply 20260626_approve_vehicle_rpc.sql (single paste)
--   3. Sections B–F post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: exactly one signature exists (overload-trap closed)
--   - C: grants — authenticated only / no anon / no PUBLIC
--   - D: positive behavioral — in-scope CA approves a pending vehicle;
--        row flips correctly; manager_note assignment direct (not COALESCE)
--   - ★ E: scope-check NEGATIVE — out-of-scope manager attempts approve;
--        gets {error: 'vehicle_out_of_scope'}; vehicle row UNCHANGED.
--        This is the security property the whole RPC exists to enforce.
--   - F: idempotency — re-approving an already-approved vehicle returns
--        action='noop_already_active' with no DB write
--
-- Sections D, E, F are auto-asserting DO blocks (mirror commit 1's
-- Section E pattern) — they fail LOUD with RAISE EXCEPTION rather than
-- needing manual eyeball of NOTICE output.
--
-- DEFERRED to commit 4b smoke (cannot test from migration verification):
--   - The 3 client-side replacement sites in app/manager/page.tsx
--   - The permit syncOnAdd hook after a real approve
--   - Driver-sync gate behavior

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — no approve_vehicle exists
-- ════════════════════════════════════════════════════════════════════

SELECT proname, pg_get_function_identity_arguments(oid)
  FROM pg_proc
 WHERE proname IN ('approve_vehicle', 'sync_permit_count')
   AND pronamespace = 'public'::regnamespace;
-- Expected PRE-APPLY:  0 rows
-- Expected POST-APPLY: 1 row → approve_vehicle | bigint, text


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — exactly one approve_vehicle signature (overload-trap)
-- ════════════════════════════════════════════════════════════════════

SELECT
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='approve_vehicle' AND pronamespace='public'::regnamespace) = 1
    AS exactly_one_signature,
  -- Arg count + types check via pg_proc.proargtypes (oid[]). PG-version-stable
  -- alternative to pg_get_function_identity_arguments() which formats the args
  -- string differently across versions (PG 17 includes parameter names; older
  -- versions return types-only). proargtypes is the canonical types-only OID array.
  --   bigint = 20, text = 25 (these OIDs are stable Postgres-wide)
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='approve_vehicle' AND pronamespace='public'::regnamespace
             AND pronargs = 2
             AND proargtypes::oid[] = ARRAY['bigint'::regtype::oid, 'text'::regtype::oid])
    AS signature_matches_bigint_text,
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='approve_vehicle' AND pronamespace='public'::regnamespace
             AND prosecdef = TRUE)
    AS is_security_definer;
-- Expected: all 3 TRUE.
-- The signature_matches assertion uses regtype→oid conversion so it doesn't
-- depend on text formatting — works across PG versions. Section D's actual
-- RPC call with named args is the behavioral proof either way.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants: authenticated only; no anon; no PUBLIC
-- ════════════════════════════════════════════════════════════════════

SELECT grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema='public' AND routine_name='approve_vehicle'
 ORDER BY grantee, privilege_type;
-- Expected:
--   authenticated | EXECUTE
--   postgres      | EXECUTE (owner)
--   service_role  | EXECUTE (Supabase backend default; harmless — BYPASSRLS)
-- MUST NOT appear: anon, PUBLIC

-- Hard assertion (catches the function-grant footgun in CI):
SELECT
  EXISTS (SELECT 1 FROM information_schema.routine_privileges
           WHERE routine_schema='public' AND routine_name='approve_vehicle'
             AND grantee='authenticated' AND privilege_type='EXECUTE')        AS authenticated_has_execute,
  NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
               WHERE routine_schema='public' AND routine_name='approve_vehicle'
                 AND grantee IN ('anon', 'PUBLIC'))                            AS no_anon_or_public_grant;
-- Expected: both TRUE.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — positive behavioral test (auto-asserting)
-- ════════════════════════════════════════════════════════════════════
-- In-scope CA creates a pending vehicle in their company, calls
-- approve_vehicle(), asserts the row flips to active + flags set +
-- manager_note assignment is DIRECT (not COALESCE). Cleanup unconditional.

DO $approve_d$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- A1 Test Run 2 CA
  v_test_plate       CONSTANT TEXT := 'APPROVED1';
  v_test_property    TEXT;
  v_resolved_role    TEXT;
  v_resolved_company TEXT;
  v_test_vehicle_id  BIGINT;
  v_rpc_result       JSONB;
  v_after_status     TEXT;
  v_after_is_active  BOOLEAN;
  v_after_resread    BOOLEAN;
  v_after_note       TEXT;
BEGIN
  -- JWT-mock the CA
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role    := get_my_role();
  v_resolved_company := get_my_company();
  IF v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — got role "%". Use a real CA.', v_resolved_role;
  END IF;

  -- Pick any property in CA scope
  SELECT name INTO v_test_property
    FROM public.properties WHERE company ~~* v_resolved_company LIMIT 1;
  IF v_test_property IS NULL THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — no property in CA scope.';
  END IF;

  -- Fixture: throwaway pending vehicle
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read, manager_note)
  VALUES (v_test_plate, v_test_property, 'pending', FALSE, FALSE, 'prior decline note')
  RETURNING id INTO v_test_vehicle_id;

  -- THE TEST: call approve_vehicle as the CA
  v_rpc_result := public.approve_vehicle(
    p_vehicle_id   := v_test_vehicle_id,
    p_manager_note := 'approved with new note'
  );

  -- Read back
  SELECT status, is_active, resident_read, manager_note
    INTO v_after_status, v_after_is_active, v_after_resread, v_after_note
    FROM public.vehicles WHERE id = v_test_vehicle_id;

  RAISE NOTICE '── Section D positive test ──';
  RAISE NOTICE '  rpc_result      = %', v_rpc_result;
  RAISE NOTICE '  after.status    = % (expected ''active'')',  v_after_status;
  RAISE NOTICE '  after.is_active = % (expected true)',         v_after_is_active;
  RAISE NOTICE '  after.resread   = % (expected true)',         v_after_resread;
  RAISE NOTICE '  after.note      = % (expected ''approved with new note'' — direct assignment, not COALESCE)', v_after_note;

  -- Cleanup unconditional
  DELETE FROM public.vehicles WHERE id = v_test_vehicle_id;

  -- Hard assertions
  IF (v_rpc_result->>'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'Section D FAIL — rpc.ok != true; got %', v_rpc_result;
  END IF;
  IF (v_rpc_result->>'action') <> 'approved' THEN
    RAISE EXCEPTION 'Section D FAIL — action="%" (expected ''approved'')', v_rpc_result->>'action';
  END IF;
  IF v_after_status <> 'active' THEN
    RAISE EXCEPTION 'Section D FAIL — status="%" (expected ''active'')', v_after_status;
  END IF;
  IF v_after_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Section D FAIL — is_active=% (expected true)', v_after_is_active;
  END IF;
  IF v_after_resread IS NOT TRUE THEN
    RAISE EXCEPTION 'Section D FAIL — resident_read=% (expected true)', v_after_resread;
  END IF;
  IF v_after_note <> 'approved with new note' THEN
    RAISE EXCEPTION 'Section D FAIL — manager_note="%" (expected DIRECT assignment of new note, not COALESCE of prior)', v_after_note;
  END IF;
END;
$approve_d$;


-- ════════════════════════════════════════════════════════════════════
-- E. ★★ LOAD-BEARING — scope-check NEGATIVE (the security property)
-- ════════════════════════════════════════════════════════════════════
-- The whole RPC exists to enforce manager scope BECAUSE DEFINER bypasses
-- RLS. This test proves the manual scope-check fires:
--   1. Create 2 properties in the test company
--   2. Create a manager user_role scoped ONLY to property A
--   3. Create a pending vehicle at property B (NOT in the manager's scope)
--   4. JWT-mock the manager, call approve_vehicle on the property-B vehicle
--   5. Assert response is {error: 'vehicle_out_of_scope'}
--   6. Assert vehicle row is UNCHANGED (status='pending', is_active=false)
-- If the manager could approve the property-B vehicle → DEFINER inherited
-- god-mode → scope-check broken → ABORT.

DO $approve_e$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_test_manager_email CONSTANT TEXT := '__approve_e_manager__@example.invalid';
  v_test_property_a  CONSTANT TEXT := '__approve_e_property_a__';
  v_test_property_b  CONSTANT TEXT := '__approve_e_property_b__';
  v_test_plate       CONSTANT TEXT := 'OUTOFSCOPE1';
  v_resolved_company TEXT;
  v_test_vehicle_id  BIGINT;
  v_rpc_result       JSONB;
  v_after_status     TEXT;
  v_after_is_active  BOOLEAN;
BEGIN
  -- Resolve company via CA JWT (the setup happens under postgres role; CA
  -- only used to pick a real company name)
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();
  IF v_resolved_company IS NULL THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — CA JWT mock did not resolve a company.';
  END IF;

  -- Fixtures: 2 properties in the company (so both are theoretically
  -- visible to a CA, but the manager is scoped only to A)
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES
    (v_test_property_a, v_resolved_company, '111 Test', TRUE),
    (v_test_property_b, v_resolved_company, '222 Test', TRUE);

  -- Manager user_role scoped ONLY to property A (NOT B).
  -- get_my_properties() returns property as text[] — set as ARRAY.
  INSERT INTO public.user_roles (email, role, company, name, property)
  VALUES (v_test_manager_email, 'manager', v_resolved_company, '__approve_e_manager_name__',
          ARRAY[v_test_property_a]);

  -- Pending vehicle at property B (OUT OF the manager's scope)
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_test_plate, v_test_property_b, 'pending', FALSE, FALSE)
  RETURNING id INTO v_test_vehicle_id;

  -- THE TEST: switch JWT to the manager, attempt approve
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_test_manager_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_test_manager_email), true);

  v_rpc_result := public.approve_vehicle(p_vehicle_id := v_test_vehicle_id);

  -- Read back the vehicle (UNDER POSTGRES — bypass RLS so we see the row
  -- regardless of whether the manager could see it)
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  SELECT status, is_active INTO v_after_status, v_after_is_active
    FROM public.vehicles WHERE id = v_test_vehicle_id;

  RAISE NOTICE '── Section E scope-check NEGATIVE ──';
  RAISE NOTICE '  manager_email          = %', v_test_manager_email;
  RAISE NOTICE '  manager_scoped_to      = [%]', v_test_property_a;
  RAISE NOTICE '  target_vehicle_property = %', v_test_property_b;
  RAISE NOTICE '  rpc_result             = % (expected error=vehicle_out_of_scope)', v_rpc_result;
  RAISE NOTICE '  after.status           = % (expected ''pending'' — UNCHANGED)', v_after_status;
  RAISE NOTICE '  after.is_active        = % (expected false — UNCHANGED)', v_after_is_active;

  -- Cleanup unconditional
  DELETE FROM public.vehicles   WHERE id = v_test_vehicle_id;
  DELETE FROM public.user_roles WHERE email = v_test_manager_email;
  DELETE FROM public.properties WHERE name IN (v_test_property_a, v_test_property_b);

  -- Hard assertions — the security property
  IF (v_rpc_result->>'error') IS NULL THEN
    RAISE EXCEPTION 'Section E FAIL — RPC RETURNED OK FOR OUT-OF-SCOPE VEHICLE. SCOPE-CHECK BROKEN. Got: %', v_rpc_result;
  END IF;
  IF (v_rpc_result->>'error') <> 'vehicle_out_of_scope' THEN
    RAISE EXCEPTION 'Section E FAIL — wrong error string. Expected vehicle_out_of_scope, got: %', v_rpc_result->>'error';
  END IF;
  IF v_after_status <> 'pending' THEN
    RAISE EXCEPTION 'Section E FAIL — vehicle.status changed to "%" despite RPC rejection. ROW MUTATED.', v_after_status;
  END IF;
  IF v_after_is_active IS TRUE THEN
    RAISE EXCEPTION 'Section E FAIL — vehicle.is_active flipped to TRUE despite RPC rejection. ROW MUTATED.';
  END IF;
END;
$approve_e$;

-- Leak check (E fixture)
SELECT
  (SELECT COUNT(*) FROM public.vehicles   WHERE plate = 'OUTOFSCOPE1')                                  AS leaked_vehicles,
  (SELECT COUNT(*) FROM public.user_roles WHERE email = '__approve_e_manager__@example.invalid')        AS leaked_user_roles,
  (SELECT COUNT(*) FROM public.properties WHERE name IN ('__approve_e_property_a__','__approve_e_property_b__')) AS leaked_properties;
-- Expected: all 3 = 0.


-- ════════════════════════════════════════════════════════════════════
-- F. ★ LOAD-BEARING — idempotency: re-approve is a no-op
-- ════════════════════════════════════════════════════════════════════

DO $approve_f$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_test_plate       CONSTANT TEXT := 'IDEMPOTENT1';
  v_test_property    TEXT;
  v_resolved_company TEXT;
  v_test_vehicle_id  BIGINT;
  v_first_result     JSONB;
  v_second_result    JSONB;
  v_after_note       TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();

  SELECT name INTO v_test_property
    FROM public.properties WHERE company ~~* v_resolved_company LIMIT 1;

  -- Fixture: pending vehicle
  INSERT INTO public.vehicles (plate, property, status, is_active, resident_read)
  VALUES (v_test_plate, v_test_property, 'pending', FALSE, FALSE)
  RETURNING id INTO v_test_vehicle_id;

  -- First approve — should action='approved'
  v_first_result := public.approve_vehicle(
    p_vehicle_id := v_test_vehicle_id,
    p_manager_note := 'first call sets this'
  );

  -- Second approve (idempotent) — should action='noop_already_active'
  -- AND not overwrite the manager_note (since the no-op exits before UPDATE)
  v_second_result := public.approve_vehicle(
    p_vehicle_id := v_test_vehicle_id,
    p_manager_note := 'second call SHOULD NOT overwrite'
  );

  SELECT manager_note INTO v_after_note
    FROM public.vehicles WHERE id = v_test_vehicle_id;

  RAISE NOTICE '── Section F idempotency ──';
  RAISE NOTICE '  first.action  = % (expected ''approved'')', v_first_result->>'action';
  RAISE NOTICE '  second.action = % (expected ''noop_already_active'')', v_second_result->>'action';
  RAISE NOTICE '  after.note    = % (expected ''first call sets this'' — no-op skipped UPDATE)', v_after_note;

  -- Cleanup unconditional
  DELETE FROM public.vehicles WHERE id = v_test_vehicle_id;

  IF (v_first_result->>'action') <> 'approved' THEN
    RAISE EXCEPTION 'Section F FAIL — first call action="%" (expected ''approved'')', v_first_result->>'action';
  END IF;
  IF (v_second_result->>'action') <> 'noop_already_active' THEN
    RAISE EXCEPTION 'Section F FAIL — second call action="%" (expected ''noop_already_active''). Re-approve should not re-fire.', v_second_result->>'action';
  END IF;
  IF v_after_note <> 'first call sets this' THEN
    RAISE EXCEPTION 'Section F FAIL — manager_note overwritten to "%" by no-op. No-op should skip UPDATE entirely.', v_after_note;
  END IF;
END;
$approve_f$;


-- ════════════════════════════════════════════════════════════════════
-- G. Migration audit row landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE action = 'SCHEMA_RPC_CREATED'
   AND new_values->>'migration' = '20260626_approve_vehicle_rpc'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.
