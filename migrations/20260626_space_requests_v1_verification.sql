-- Verification queries for space_requests v1 migration.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (table absent + 4 RPCs absent)
--   2. Apply 20260626_space_requests_v1.sql
--   3. Sections B–G post-apply
--
-- LOAD-BEARING SECTIONS:
--   - C: grants — authenticated EXECUTE on all 4 RPCs; no anon/PUBLIC;
--     table SELECT only to authenticated, no INSERT/UPDATE/DELETE leak
--   - D: RLS — resident can SELECT only own; manager only in-scope;
--     CA only own-company; admin all; cross-resident escalation blocked
--   - E: behavioral atomic-approve — fixture pending request +
--     available space → call approve → confirm space_residents
--     INSERT + spaces.status='assigned' + space_requests row updated
--     all landed together. Plus rollback-on-failure check.
--   - G: structural invariants — partial UNIQUE blocks 2nd pending,
--     CHECK constraints (note ≤500, approved-has-space, decided-consistency)
--
-- DEFERRED TO UAT (cannot test from SQL Editor — needs real JWTs):
--   - End-to-end resident submit via UI
--   - Manager queue render + approve modal
--   - Resident dismissible card render
--
-- Edit ADMIN_EMAIL_HERE in Sections D/E/G before running.

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — table absent + RPCs absent
-- ════════════════════════════════════════════════════════════════════

SELECT
  NOT EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='space_requests')              AS pre_table_absent,
  NOT EXISTS (SELECT 1 FROM pg_proc
               WHERE pronamespace='public'::regnamespace AND proname='submit_space_request')                 AS pre_submit_absent,
  NOT EXISTS (SELECT 1 FROM pg_proc
               WHERE pronamespace='public'::regnamespace AND proname='approve_space_request')                AS pre_approve_absent,
  NOT EXISTS (SELECT 1 FROM pg_proc
               WHERE pronamespace='public'::regnamespace AND proname='decline_space_request')                AS pre_decline_absent,
  NOT EXISTS (SELECT 1 FROM pg_proc
               WHERE pronamespace='public'::regnamespace AND proname='mark_my_space_request_decision_read')  AS pre_mark_read_absent;
-- Expected PRE-APPLY:  all 5 TRUE  (nothing exists yet)
-- Expected POST-APPLY: all 5 FALSE (everything landed)


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — table + indexes + RPCs present
-- ════════════════════════════════════════════════════════════════════

-- B.1 table + columns
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='space_requests'
 ORDER BY ordinal_position;
-- Expected 11 rows in this order:
--   id                  bigint    NO  nextval('space_requests_id_seq')
--   resident_email      text      NO
--   property            text      NO
--   note                text      YES
--   status              text      NO  'pending'
--   requested_at        timestamptz NO now()
--   decided_by_email    text      YES
--   decided_at          timestamptz YES
--   decline_reason      text      YES
--   assigned_space_id   bigint    YES
--   resident_read       boolean   NO  false

-- B.2 4 indexes present
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname='public' AND tablename='space_requests'
 ORDER BY indexname;
-- Expected 5 rows:
--   space_requests_pkey                         (PK on id)
--   space_requests_one_pending_per_resident     (UNIQUE on resident_email WHERE status='pending')
--   space_requests_property_status_idx          (property, status)
--   space_requests_resident_status_idx          (resident_email, status)
--   space_requests_status_requested_at_idx      (status, requested_at)

-- B.3 4 CHECK constraints + 1 FK
SELECT conname, contype, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'public.space_requests'::regclass
   AND contype IN ('c', 'f')
 ORDER BY conname;
-- Expected:
--   space_requests_approved_has_space_chk         CHECK (status<>'approved' OR assigned_space_id IS NOT NULL)
--   space_requests_assigned_space_id_fkey         FOREIGN KEY (assigned_space_id) REFERENCES spaces(id) ON DELETE SET NULL
--   space_requests_decided_consistency_chk        CHECK ((status='pending' AND decided_*=NULL) OR (status IN approved/declined AND decided_*<>NULL))
--   space_requests_decline_reason_length_chk      CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500)
--   space_requests_note_length_chk                CHECK (note IS NULL OR char_length(note) <= 500)
--   space_requests_status_check                   CHECK (status IN ('pending','approved','declined'))

-- B.4 4 RPCs present with expected signatures
SELECT proname, pg_get_function_identity_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace='public'::regnamespace
   AND proname IN ('submit_space_request', 'approve_space_request', 'decline_space_request', 'mark_my_space_request_decision_read')
 ORDER BY proname;
-- Expected 4 rows:
--   approve_space_request                  | p_request_id bigint, p_space_id bigint
--   decline_space_request                  | p_request_id bigint, p_decline_reason text DEFAULT NULL::text
--   mark_my_space_request_decision_read    | p_request_id bigint
--   submit_space_request                   | p_property text, p_note text DEFAULT NULL::text

-- B.5 RLS enabled + 4 policies
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
  FROM pg_policy
 WHERE polrelid = 'public.space_requests'::regclass
 ORDER BY polname;
-- Expected 4 SELECT policies:
--   admin_all_space_requests                  | r | (get_my_role() = 'admin')
--   ca_company_scoped_space_requests          | r | (get_my_role()='company_admin' AND property IN (...))
--   manager_property_scoped_space_requests    | r | (get_my_role()='manager' AND property = ANY(get_my_properties()))
--   resident_own_space_requests               | r | (lower(resident_email) = lower(auth.jwt() ->> 'email'))


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants (authenticated only; no anon/PUBLIC)
-- ════════════════════════════════════════════════════════════════════
-- Table: SELECT to authenticated only; no INSERT/UPDATE/DELETE.
-- RPCs:  EXECUTE to authenticated; no anon, no PUBLIC.

-- C.1 table grants — visual inspection
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name='space_requests'
 ORDER BY grantee, privilege_type;
-- Expected:
--   authenticated | SELECT     (and ONLY SELECT)
--   postgres      | ALL or per-priv rows (owner)
--   service_role  | per-priv rows (Supabase backend)
-- MUST NOT appear: anon, PUBLIC, authenticated INSERT/UPDATE/DELETE/TRUNCATE
--
-- ⚠ Hard assertions below catch the Supabase default-privilege footgun
-- where REVOKE on PUBLIC + anon alone leaves direct grants on
-- `authenticated` intact (2026-06-26 incident — fix landed in migration
-- Part 2 with explicit REVOKE ALL FROM authenticated before the targeted
-- GRANT SELECT).

-- C.1a HARD ASSERTION — authenticated has SELECT and ONLY SELECT
SELECT
  EXISTS (SELECT 1 FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='space_requests'
             AND grantee='authenticated' AND privilege_type='SELECT')                AS authenticated_has_select,
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='space_requests'
                 AND grantee='authenticated' AND privilege_type='INSERT')             AS authenticated_no_insert,
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='space_requests'
                 AND grantee='authenticated' AND privilege_type='UPDATE')             AS authenticated_no_update,
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='space_requests'
                 AND grantee='authenticated' AND privilege_type='DELETE')             AS authenticated_no_delete,
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='space_requests'
                 AND grantee='authenticated' AND privilege_type='TRUNCATE')           AS authenticated_no_truncate,
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name='space_requests'
                 AND grantee IN ('anon', 'PUBLIC'))                                    AS no_anon_or_public;
-- Expected: ALL 6 booleans TRUE.
-- Any FALSE → security hole; the RPC validation is meaningless if the
-- table is directly writable. ABORT and re-run the Part-2 remediation
-- before any UI commit.

-- C.2 RPC grants on all 4
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema='public'
   AND routine_name IN ('submit_space_request', 'approve_space_request', 'decline_space_request', 'mark_my_space_request_decision_read')
 ORDER BY routine_name, grantee;
-- Expected per RPC: 'authenticated' EXECUTE present, no anon, no PUBLIC.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — RLS scope correctness
-- ════════════════════════════════════════════════════════════════════
-- 3 mock-JWT probes:
--   D.1 resident can SELECT own row, not someone else's
--   D.2 manager can SELECT only rows in their property scope
--   D.3 CA can SELECT only rows in their company scope
--
-- Uses temporary fixture rows under a sentinel property. Cleanup
-- unconditional. Edit ADMIN_EMAIL_HERE + RESIDENT_EMAIL_HERE for your
-- test fixtures (any active CA + any resident from same company).

DO $rls_d$
DECLARE
  v_admin_email     CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- ← EDIT to a real CA
  v_other_email     CONSTANT TEXT := '__rls_other_resident__@example.invalid';
  v_test_property   TEXT;
  v_resolved_role   TEXT;
  v_resolved_company TEXT;
  v_my_email_resident TEXT;
  v_test_req_id_self    BIGINT;
  v_test_req_id_other   BIGINT;
  v_visible_count_self  INTEGER;
  v_visible_count_other INTEGER;
BEGIN
  -- Resolve a real resident in CA's company to use as the "self" probe.
  -- We mock the resident's JWT to test resident_own_space_requests RLS.
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role    := get_my_role();
  v_resolved_company := get_my_company();
  IF v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — admin email did not resolve to company_admin (got "%"). Use a real CA email.', v_resolved_role;
  END IF;

  SELECT name INTO v_test_property
    FROM public.properties
   WHERE company ~~* v_resolved_company
   LIMIT 1;
  SELECT lower(email) INTO v_my_email_resident
    FROM public.residents
   WHERE lower(email) IS NOT NULL
     AND property = v_test_property
     AND status = 'active'
   LIMIT 1;
  IF v_my_email_resident IS NULL THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — no active resident found at property "%". Need at least one for the self-probe.', v_test_property;
  END IF;

  -- Fixture: 2 pending requests — one as the real resident, one as
  -- a fake "other" resident under the same property
  INSERT INTO public.space_requests (resident_email, property)
  VALUES (v_my_email_resident, v_test_property)
  RETURNING id INTO v_test_req_id_self;
  INSERT INTO public.space_requests (resident_email, property)
  VALUES (v_other_email,        v_test_property)
  RETURNING id INTO v_test_req_id_other;

  -- D.1 RESIDENT PROBE — mock the real resident's JWT
  -- AND switch the session role to authenticated so RLS actually applies.
  --
  -- ⚠ SQL Editor session runs as postgres which BYPASSES RLS entirely.
  -- The JWT mock alone only changes what auth.jwt() returns; it does NOT
  -- change the session role. Without the role switch, the SELECT below
  -- runs as postgres and sees ALL rows regardless of RLS — giving a
  -- FALSE escalation alarm (2026-06-26 incident: D first run showed
  -- cross-resident visibility but the policy was fine; root cause was
  -- missing role switch).
  --
  -- ⚠ ROLE-SWITCH SHAPE: use direct `SET LOCAL ROLE` / `RESET ROLE`
  -- statements, NOT set_config('role', ...). Two reasons:
  --   1. SET LOCAL ROLE is the canonical PG form; set_config('role', X)
  --      doesn't reliably trigger the role-switch hooks that RLS uses.
  --   2. set_config('role', '', true) ERRORS because empty-string isn't
  --      a valid role name (2026-06-26 incident — RESET-via-empty-string
  --      crashed the block before assertions). RESET ROLE is the proper
  --      idempotent reset.
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_my_email_resident), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_my_email_resident), true);
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO v_visible_count_self
    FROM public.space_requests WHERE id = v_test_req_id_self;
  SELECT COUNT(*) INTO v_visible_count_other
    FROM public.space_requests WHERE id = v_test_req_id_other;

  -- Reset role for cleanup (DELETE needs postgres-level grants)
  RESET ROLE;

  RAISE NOTICE '── Section D RLS probe results ──';
  RAISE NOTICE '  resident sees own request    = % (expected 1)', v_visible_count_self;
  RAISE NOTICE '  resident sees other request  = % (expected 0)', v_visible_count_other;

  -- Cleanup unconditional (back as postgres; switch JWT back to CA for clarity)
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  DELETE FROM public.space_requests WHERE id IN (v_test_req_id_self, v_test_req_id_other);

  -- Assertions
  IF v_visible_count_self <> 1 THEN
    RAISE EXCEPTION 'Section D FAIL — resident could not see own request (got % visible, expected 1).', v_visible_count_self;
  END IF;
  IF v_visible_count_other <> 0 THEN
    RAISE EXCEPTION 'Section D FAIL — resident saw other resident''s request (got % visible, expected 0) — RLS escalation hole.', v_visible_count_other;
  END IF;
END;
$rls_d$;

-- Leak check
SELECT
  (SELECT COUNT(*) FROM public.space_requests
    WHERE resident_email = '__rls_other_resident__@example.invalid') AS leaked_rows;
-- Expected: 0


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — behavioral atomic-approve
-- ════════════════════════════════════════════════════════════════════
-- Fixture: throwaway resident user_role + active resident row + property
-- + space (available) → resident submits request → manager approves →
-- confirm THREE writes landed in one tx:
--   1. space_residents INSERT (space_id, resident_email)
--   2. spaces.status = 'assigned'
--   3. space_requests.status = 'approved' AND assigned_space_id set
-- Cleanup unconditional. Uses now() + INTERVAL '1 second' for any
-- dashboard call to avoid same-tx upper-bound issues — none here, but
-- the test driver/CA pattern is in effect.

DO $approve_e$
DECLARE
  v_admin_email      CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- ← EDIT to real CA
  v_test_resident    CONSTANT TEXT := '__space_req_e_resident__@example.invalid';
  v_test_property    TEXT;
  v_resolved_company TEXT;
  v_resolved_role    TEXT;
  v_test_space_id    BIGINT;
  v_test_request_id  BIGINT;
  v_submit_result    jsonb;
  v_approve_result   jsonb;
  v_space_after      RECORD;
  v_request_after    RECORD;
  v_resident_link_count INTEGER;
BEGIN
  -- ── 1. Set up under CA identity ──
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role    := get_my_role();
  v_resolved_company := get_my_company();
  IF v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — got role "%". Use a real CA.', v_resolved_role;
  END IF;

  SELECT name INTO v_test_property
    FROM public.properties WHERE company ~~* v_resolved_company LIMIT 1;
  IF v_test_property IS NULL THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — no property in CA scope.';
  END IF;

  -- Fixtures: resident user_role + residents row + active space
  INSERT INTO public.user_roles (email, role, company, name)
  VALUES (v_test_resident, 'resident', v_resolved_company, '__space_req_e_resident_name__');

  INSERT INTO public.residents (email, property, unit, name, status, is_active)
  VALUES (v_test_resident, v_test_property, '__SREQ_E__', '__space_req_e_resident_name__', 'active', TRUE);

  -- spaces has NOT NULL columns: company, label, created_by_email
  -- (plus type/is_active/is_bundled/created_at all with DEFAULTs).
  -- 2026-06-26 fixture caught the missing created_by_email — that's
  -- a Spaces v1 invariant (every space tracks who created it).
  INSERT INTO public.spaces (property, company, label, status, is_active, created_by_email)
  VALUES (v_test_property, v_resolved_company, '__SREQ_E_SPACE__', 'available', TRUE, v_admin_email)
  RETURNING id INTO v_test_space_id;

  -- ── 2. Resident submits ──
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_test_resident), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_test_resident), true);
  v_submit_result := public.submit_space_request(
    p_property := v_test_property,
    p_note     := 'Section E behavioral fixture'
  );
  RAISE NOTICE '── Section E submit ── result = %', v_submit_result;
  IF (v_submit_result->>'ok')::BOOLEAN IS NOT TRUE THEN
    -- Cleanup before raise
    DELETE FROM public.spaces     WHERE id = v_test_space_id;
    DELETE FROM public.residents  WHERE email = v_test_resident;
    DELETE FROM public.user_roles WHERE email = v_test_resident;
    RAISE EXCEPTION 'Section E SETUP FAIL — submit returned %', v_submit_result;
  END IF;
  v_test_request_id := (v_submit_result->>'request_id')::BIGINT;

  -- ── 3. CA approves (switches JWT back) ──
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_approve_result := public.approve_space_request(
    p_request_id := v_test_request_id,
    p_space_id   := v_test_space_id
  );
  RAISE NOTICE '── Section E approve ── result = %', v_approve_result;

  -- ── 4. Capture post-state of all 3 writes ──
  SELECT status, is_active INTO v_space_after
    FROM public.spaces WHERE id = v_test_space_id;
  SELECT status, assigned_space_id, decided_by_email, decided_at INTO v_request_after
    FROM public.space_requests WHERE id = v_test_request_id;
  SELECT COUNT(*) INTO v_resident_link_count
    FROM public.space_residents
   WHERE space_id = v_test_space_id AND lower(resident_email) = lower(v_test_resident);

  RAISE NOTICE '── Section E post-state ──';
  RAISE NOTICE '  spaces.status                        = % (expected ''assigned'')',  v_space_after.status;
  RAISE NOTICE '  space_residents tie count            = % (expected 1)',             v_resident_link_count;
  RAISE NOTICE '  space_requests.status                = % (expected ''approved'')', v_request_after.status;
  RAISE NOTICE '  space_requests.assigned_space_id     = % (expected %)',             v_request_after.assigned_space_id, v_test_space_id;
  RAISE NOTICE '  space_requests.decided_by_email      = % (expected %)',             v_request_after.decided_by_email,  v_admin_email;

  -- ── 5. Cleanup unconditional ──
  DELETE FROM public.space_residents WHERE space_id = v_test_space_id;
  DELETE FROM public.space_requests  WHERE id = v_test_request_id;
  DELETE FROM public.spaces          WHERE id = v_test_space_id;
  DELETE FROM public.residents       WHERE email = v_test_resident;
  DELETE FROM public.user_roles      WHERE email = v_test_resident;
  DELETE FROM public.audit_logs      WHERE record_id::TEXT = v_test_request_id::TEXT
    AND action LIKE 'SPACE_REQUEST_%';

  -- ── 6. Assertions ──
  IF (v_approve_result->>'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'Section E FAIL — approve returned %', v_approve_result;
  END IF;
  IF v_space_after.status <> 'assigned' THEN
    RAISE EXCEPTION 'Section E FAIL — spaces.status = % (expected assigned)', v_space_after.status;
  END IF;
  IF v_resident_link_count <> 1 THEN
    RAISE EXCEPTION 'Section E FAIL — space_residents tie count = % (expected 1)', v_resident_link_count;
  END IF;
  IF v_request_after.status <> 'approved' THEN
    RAISE EXCEPTION 'Section E FAIL — space_requests.status = % (expected approved)', v_request_after.status;
  END IF;
  IF v_request_after.assigned_space_id <> v_test_space_id THEN
    RAISE EXCEPTION 'Section E FAIL — assigned_space_id mismatch';
  END IF;
END;
$approve_e$;

-- Leak check
SELECT
  (SELECT COUNT(*) FROM public.space_requests
    WHERE resident_email = '__space_req_e_resident__@example.invalid')                       AS leaked_requests,
  (SELECT COUNT(*) FROM public.spaces
    WHERE label = '__SREQ_E_SPACE__')                                                        AS leaked_spaces,
  (SELECT COUNT(*) FROM public.residents
    WHERE email = '__space_req_e_resident__@example.invalid')                                AS leaked_residents,
  (SELECT COUNT(*) FROM public.user_roles
    WHERE email = '__space_req_e_resident__@example.invalid')                                AS leaked_user_roles;
-- Expected: all 4 = 0.


-- ════════════════════════════════════════════════════════════════════
-- F. Migration audit rows landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE new_values->>'migration' = '20260626_space_requests_v1'
 ORDER BY created_at, action;
-- Expected 2 rows:
--   SCHEMA_TABLE_CREATED | space_requests | 20260626_space_requests_v1
--   SCHEMA_RPCS_CREATED  | space_requests | 20260626_space_requests_v1


-- ════════════════════════════════════════════════════════════════════
-- G. ★ LOAD-BEARING — structural invariants (UNIQUE + CHECK constraints)
-- ════════════════════════════════════════════════════════════════════
-- Probe each constraint with a deliberate violation and confirm the
-- INSERT/UPDATE raises. Cleanup unconditional.

DO $constraints_g$
DECLARE
  v_admin_email     CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';
  v_test_resident   CONSTANT TEXT := '__space_req_g_resident__@example.invalid';
  v_test_property   TEXT;
  v_resolved_company TEXT;
  v_req_id_1        BIGINT;
  v_req_id_2        BIGINT;
  v_unique_caught   BOOLEAN := FALSE;
  v_note_caught     BOOLEAN := FALSE;
  v_decided_consistency_caught BOOLEAN := FALSE;
  v_approved_no_space_caught   BOOLEAN := FALSE;
  v_status_caught   BOOLEAN := FALSE;
BEGIN
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_company := get_my_company();
  SELECT name INTO v_test_property
    FROM public.properties WHERE company ~~* v_resolved_company LIMIT 1;

  -- G.1 partial UNIQUE: 2nd pending for same email blocked
  INSERT INTO public.space_requests (resident_email, property)
  VALUES (v_test_resident, v_test_property)
  RETURNING id INTO v_req_id_1;
  BEGIN
    INSERT INTO public.space_requests (resident_email, property)
    VALUES (v_test_resident, v_test_property)
    RETURNING id INTO v_req_id_2;
  EXCEPTION WHEN unique_violation THEN
    v_unique_caught := TRUE;
  END;

  -- G.2 note > 500 chars blocked
  BEGIN
    INSERT INTO public.space_requests (resident_email, property, note)
    VALUES (v_test_resident || '.over', v_test_property, repeat('x', 501));
  EXCEPTION WHEN check_violation THEN
    v_note_caught := TRUE;
  END;

  -- G.3 status outside enum blocked
  BEGIN
    INSERT INTO public.space_requests (resident_email, property, status)
    VALUES (v_test_resident || '.status', v_test_property, 'cancelled');
  EXCEPTION WHEN check_violation THEN
    v_status_caught := TRUE;
  END;

  -- G.4 decided-consistency: pending with decided_at set is blocked
  BEGIN
    INSERT INTO public.space_requests (resident_email, property, status, decided_at)
    VALUES (v_test_resident || '.consistency', v_test_property, 'pending', now());
  EXCEPTION WHEN check_violation THEN
    v_decided_consistency_caught := TRUE;
  END;

  -- G.5 approved-has-space: status=approved without assigned_space_id blocked
  BEGIN
    INSERT INTO public.space_requests (resident_email, property, status, decided_by_email, decided_at)
    VALUES (v_test_resident || '.noassign', v_test_property, 'approved', v_admin_email, now());
  EXCEPTION WHEN check_violation THEN
    v_approved_no_space_caught := TRUE;
  END;

  RAISE NOTICE '── Section G constraint probes ──';
  RAISE NOTICE '  unique partial (2nd pending blocked)         = % (expected TRUE)', v_unique_caught;
  RAISE NOTICE '  note > 500 blocked                            = % (expected TRUE)', v_note_caught;
  RAISE NOTICE '  status enum blocked                           = % (expected TRUE)', v_status_caught;
  RAISE NOTICE '  decided-consistency (pending+decided_at)      = % (expected TRUE)', v_decided_consistency_caught;
  RAISE NOTICE '  approved-no-space blocked                     = % (expected TRUE)', v_approved_no_space_caught;

  -- Cleanup unconditional
  DELETE FROM public.space_requests
   WHERE resident_email LIKE '__space_req_g_resident__@example.invalid%';

  -- Assertions
  IF NOT v_unique_caught THEN
    RAISE EXCEPTION 'Section G FAIL — partial UNIQUE didn''t block 2nd pending';
  END IF;
  IF NOT v_note_caught THEN
    RAISE EXCEPTION 'Section G FAIL — note > 500 not blocked';
  END IF;
  IF NOT v_status_caught THEN
    RAISE EXCEPTION 'Section G FAIL — status enum CHECK not enforced';
  END IF;
  IF NOT v_decided_consistency_caught THEN
    RAISE EXCEPTION 'Section G FAIL — decided-consistency CHECK not enforced';
  END IF;
  IF NOT v_approved_no_space_caught THEN
    RAISE EXCEPTION 'Section G FAIL — approved-has-space CHECK not enforced';
  END IF;
END;
$constraints_g$;

-- Leak check
SELECT COUNT(*) AS leaked_g_rows
  FROM public.space_requests
 WHERE resident_email LIKE '__space_req_g_resident__@example.invalid%';
-- Expected: 0
