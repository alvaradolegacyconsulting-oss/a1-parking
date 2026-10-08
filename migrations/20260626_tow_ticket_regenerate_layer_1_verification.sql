-- Tow Ticket Regenerate — Layer 1 verification.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (column + RPC absent gate)
--   2. Apply 20260626_tow_ticket_regenerate_layer_1.sql
--   3. Sections B–H post-apply
--
-- LOAD-BEARING SECTIONS:
--   B (grants), C (atomicity pre/post snapshot), D (permission gate),
--   E (company-scope parity), F (D2 advance-from-new-only),
--   G (audit rows), H (void_violation UNTOUCHED).
--
-- HONESTY NOTE FOR SECTION C:
--   Section C confirms PRE and POST state (one live before, one live
--   after, original voided, exactly one live in each snapshot).
--   It CANNOT observe a mid-transaction snapshot from SQL Editor —
--   there is no way to peek inside another session's open
--   transaction from this client.
--
--   The "NEVER two live, NEVER zero live" guarantee rests on
--   CODE STRUCTURE, not a runtime test:
--     (1) plpgsql single-transaction semantics — every statement in
--         a LANGUAGE plpgsql function body runs in one transaction;
--         any exception triggers a full rollback.
--     (2) Void-first ordering — Step 1 (void original) executes
--         BEFORE Step 4 (stamp new). So at any in-transaction
--         instant, at most ONE row is live-and-stamped.
--
--   Together these are the atomicity guarantee. Section C below
--   confirms the OUTCOME matches the expected end-state. Real-driver
--   end-to-end UAT under production isolation is the field proof.
--
-- DEFERRED TO UAT (cannot be tested from SQL Editor — no JWT):
--   - Real driver session WITHOUT permission → regenerate_not_permitted
--   - Real driver session WITH permission → success path
--   - Real CA call → success path
--   - Cross-company denial under a real driver session
--   - Browser-level visible state during regenerate (mid-transaction)

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — columns + RPC absent
-- ════════════════════════════════════════════════════════════════════

SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='user_roles'
             AND column_name='can_regenerate_tow_ticket')                         AS user_roles_column_exists,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='violations'
             AND column_name='regenerate_reason')                                 AS violations_reason_exists,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='violations'
             AND column_name='regenerated_from')                                  AS violations_origin_link_exists,
  EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
            AND proname='regenerate_tow_ticket')                                  AS regenerate_rpc_exists;
-- Expected PRE-APPLY:  all FALSE
-- Expected POST-APPLY: all TRUE


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — grants + schema invariants post-apply
-- ════════════════════════════════════════════════════════════════════

-- B.1 Grants on regenerate_tow_ticket — authenticated only
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'regenerate_tow_ticket'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.

-- B.2 Grants on stamp_tow_ticket — re-affirmed, unchanged
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'stamp_tow_ticket'
 ORDER BY grantee;
-- Expected: 'authenticated' present; 'anon' + 'PUBLIC' absent.

-- B.3 CHECK constraint pinning the 5-value reason enum
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.violations'::regclass
   AND conname  = 'violations_regenerate_reason_valid';
-- Expected: 1 row; definition includes ANY (ARRAY[...]) with the 5 values
-- (facility_closed, wrong_facility, facility_changed, vehicle_not_accepted, other).

-- B.4 regenerated_from FK shape (ON DELETE SET NULL)
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.violations'::regclass
   AND contype = 'f'
   AND conname LIKE '%regenerated_from%';
-- Expected: 1 row; definition includes FOREIGN KEY (regenerated_from)
-- REFERENCES violations(id) ON DELETE SET NULL.

-- B.5 user_roles.can_regenerate_tow_ticket DEFAULT FALSE + NOT NULL
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name='user_roles'
   AND column_name='can_regenerate_tow_ticket';
-- Expected: 1 row; data_type=boolean, is_nullable='NO', column_default='false'.

-- B.6 Backfill confirmed: zero NULL values
SELECT COUNT(*) FROM public.user_roles WHERE can_regenerate_tow_ticket IS NULL;
-- Expected: 0


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — atomicity PRE/POST snapshot
-- ════════════════════════════════════════════════════════════════════
-- ⚠ READ THE HONESTY NOTE AT THE TOP OF THIS FILE ⚠
-- This proves OUTCOME (pre-state + post-state both show exactly one
-- live ticket), NOT mid-transaction state. The "never two live" /
-- "never zero live" guarantee is a CODE-STRUCTURE argument (void-first
-- ordering + plpgsql single-txn semantics), eyeballed in the migration
-- diff. End-to-end UAT under real concurrency is the production proof.

-- Throwaway fixture pair: 1 property + 1 storage facility + 1 violation.
-- Uses sentinel-tagged names (`__regen_test_*__`) for clean wipe.
-- The DO block creates the fixture, invokes regenerate, snapshots
-- state, and cleans up — all in one paste.

DO $regen_C$
DECLARE
  v_admin_email    CONSTANT TEXT := 'ADMIN_EMAIL_HERE';  -- ← EDIT to real admin / company_admin email
  v_company        CONSTANT TEXT := '__regen_test_company__';
  v_property       CONSTANT TEXT := '__regen_test_property__';
  v_storage1_id    BIGINT;
  v_storage2_id    BIGINT;
  v_orig_id        BIGINT;
  v_result         jsonb;
  v_pre_live_count INTEGER;
  v_post_live_count INTEGER;
  v_post_orig_voided BOOLEAN;
  v_post_new_id      BIGINT;
  v_post_new_status  TEXT;
  v_post_new_stamped BOOLEAN;
  v_resolved_role  TEXT;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ IDENTITY-RESOLVE PRE-CHECK (Jose lesson 2026-06-26)     ║
  -- ║                                                          ║
  -- ║ Mirror of the B219 Layer 1 Section E lesson: bail LOUD  ║
  -- ║ and EARLY if the JWT mock doesn't resolve a role.       ║
  -- ║ Without this gate, an unresolved mock cascades into the ║
  -- ║ "original not voided" assertion failure — masking the   ║
  -- ║ real problem (mock not wired) as a feature failure.     ║
  -- ║                                                          ║
  -- ║ Bails BEFORE any fixture insert so no leak risk if the  ║
  -- ║ pre-check fails.                                         ║
  -- ╚══════════════════════════════════════════════════════════╝
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role := get_my_role();
  IF v_resolved_role IS NULL THEN
    RAISE EXCEPTION 'Section C SETUP FAIL — JWT mock did not resolve a role for "%". Check: (1) ADMIN_EMAIL_HERE placeholder was replaced with a real email; (2) that email exists in user_roles with a non-null role.', v_admin_email;
  END IF;
  -- ⚠ ADMIN-ONLY (Jose 2026-06-26): Section C tests the void+regenerate
  -- BODY (Steps 1-5 atomicity ordering). admin bypasses the company-
  -- scope gate (it has no scope check), so the test exercises pure
  -- void+regenerate without the fixture-vs-caller company-match
  -- complication. CA testing → use a real CA UAT session against a
  -- real company's violation, OR realign v_company below to the CA's
  -- company. Scope behavior is covered:
  --   * Section E (body-content regex) — declarative parity check
  --   * UAT — end-to-end real session
  -- If you see "violation_out_of_scope" in the v_result NOTICE below,
  -- this gate caught the wrong role — switch to a true admin email.
  IF v_resolved_role <> 'admin' THEN
    RAISE EXCEPTION 'Section C SETUP FAIL — resolved role is "%" (need "admin"). Use an admin email to skip the scope gate; see the comment above for why. CA scope is covered by Section E + UAT, not here.', v_resolved_role;
  END IF;

  -- Fixture: property + 2 storage facilities + 1 stamped violation
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES (v_property, v_company, '__regen_test_address__', TRUE);

  INSERT INTO public.storage_facilities (name, company, address, phone, is_active)
  VALUES ('__regen_test_storage_1__', v_company, '111 First St', '555-0001', TRUE)
  RETURNING id INTO v_storage1_id;

  INSERT INTO public.storage_facilities (name, company, address, phone, is_active)
  VALUES ('__regen_test_storage_2__', v_company, '222 Second St', '555-0002', TRUE)
  RETURNING id INTO v_storage2_id;

  -- Stamped original (manual insert + manual stamp shape; bypasses RPC
  -- gates by virtue of running as postgres in SQL Editor)
  INSERT INTO public.violations (
    plate, violation_type, property, is_confirmed,
    tow_ticket_generated, tow_ticket_generated_at, tow_storage_name,
    tow_storage_address, tow_storage_phone, tow_fee, status
  ) VALUES (
    'REGENC1', 'overnight', v_property, TRUE,
    TRUE, now(), '__regen_test_storage_1__',
    '111 First St', '555-0001', 250.00, 'tow_ticket'
  ) RETURNING id INTO v_orig_id;

  -- PRE-STATE snapshot — should be exactly ONE live-and-stamped row
  -- for this fixture (the original).
  SELECT COUNT(*) INTO v_pre_live_count
    FROM public.violations
   WHERE property = v_property
     AND voided_at IS NULL
     AND tow_ticket_generated = TRUE;

  -- Invoke regenerate via direct call (bypasses auth gate since SQL
  -- Editor has no JWT — but we want to test the BODY's atomicity
  -- ordering, not the auth gate, which Section D covers separately).
  -- Simulate the auth bypass by SET-ing the JWT claim to a sentinel
  -- admin email (admin bypasses the role-specific company scope) —
  -- ASSUMES an admin user_roles row exists OR we use a SECURITY
  -- DEFINER context-friendly approach.
  --
  -- SIMPLEST: call the function and accept that the auth gate may
  -- return 'no_role_assigned' from SQL Editor — in that case the
  -- function returns early WITHOUT touching the fixtures, and we
  -- can still confirm the rows survived (proving auth gate at
  -- minimum). For real atomicity proof, use JWT-mock pattern.
  --
  -- For this section, use JWT-mock with an admin email known to exist
  -- in user_roles. UAT operator: replace ADMIN_EMAIL_HERE.
  PERFORM set_config('request.jwt.claims',
    '{"email":"ADMIN_EMAIL_HERE","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',
    '{"email":"ADMIN_EMAIL_HERE","role":"authenticated"}', true);

  v_result := public.regenerate_tow_ticket(
    p_original_violation_id   := v_orig_id,
    p_new_storage_facility_id := v_storage2_id,
    p_new_tow_fee             := 275.00,
    p_reason                  := 'wrong_facility',
    p_reason_note             := NULL
  );

  -- ⚠ SURFACE THE RPC RETURN BEFORE ANY ASSERTION (Jose 2026-06-26)
  -- ────────────────────────────────────────────────────────────────
  -- If a later assertion RAISES, the EXCEPTION can swallow earlier
  -- NOTICE output. Print v_result HERE so it's visible regardless of
  -- what fails downstream. Diagnostic precedence:
  --   {"ok":true, "new_violation_id": N, ...} → Steps 1-5 all ran;
  --     assertion failures below are real feature signals.
  --   {"error":"violation_out_of_scope"} → caller's company doesn't
  --     match fixture's __regen_test_company__; use admin email (the
  --     SETUP gate above already enforces this).
  --   {"error":"already_voided"|"not_stamped"|"not_confirmed"} → row-
  --     state guard caught something; fixture INSERT shape is wrong.
  --   {"error":"storage_facility_out_of_scope"} → storage facility's
  --     company doesn't match caller's (admin should bypass this too).
  --   Any other error → real RPC bug; inspect.
  RAISE NOTICE '── Section C RPC return (printed BEFORE assertions) ──';
  RAISE NOTICE '  v_result = %', v_result;

  -- POST-STATE snapshot — should be exactly ONE live-and-stamped row
  -- for this fixture (the NEW one; the original is voided).
  SELECT COUNT(*) INTO v_post_live_count
    FROM public.violations
   WHERE property = v_property
     AND voided_at IS NULL
     AND tow_ticket_generated = TRUE;

  SELECT voided_at IS NOT NULL INTO v_post_orig_voided
    FROM public.violations WHERE id = v_orig_id;

  v_post_new_id := (v_result ->> 'new_violation_id')::BIGINT;
  IF v_post_new_id IS NOT NULL THEN
    SELECT status, tow_ticket_generated INTO v_post_new_status, v_post_new_stamped
      FROM public.violations WHERE id = v_post_new_id;
  END IF;

  -- Report
  RAISE NOTICE '── Section C atomicity snapshot ──';
  RAISE NOTICE '  pre_live_count      = % (expected 1)', v_pre_live_count;
  RAISE NOTICE '  rpc_result          = %', v_result;
  RAISE NOTICE '  post_live_count     = % (expected 1)', v_post_live_count;
  RAISE NOTICE '  post_orig_voided    = % (expected TRUE)', v_post_orig_voided;
  RAISE NOTICE '  post_new_id         = %', v_post_new_id;
  RAISE NOTICE '  post_new_status     = % (expected tow_ticket)', v_post_new_status;
  RAISE NOTICE '  post_new_stamped    = % (expected TRUE)', v_post_new_stamped;

  -- Cleanup unconditionally — sentinel-tagged
  DELETE FROM public.violations WHERE property = v_property;
  DELETE FROM public.storage_facilities WHERE name LIKE '__regen_test_storage_%';
  DELETE FROM public.properties WHERE name = v_property;

  -- Hard assertions (raise if either invariant violated)
  IF v_pre_live_count <> 1 THEN
    RAISE EXCEPTION 'Section C FAIL — pre_live_count=% (expected 1)', v_pre_live_count;
  END IF;
  IF v_post_live_count <> 1 THEN
    RAISE EXCEPTION 'Section C FAIL — post_live_count=% (expected 1; NEVER two-live)', v_post_live_count;
  END IF;
  IF NOT v_post_orig_voided THEN
    RAISE EXCEPTION 'Section C FAIL — original not voided';
  END IF;
  IF v_post_new_status IS NULL OR v_post_new_status <> 'tow_ticket' THEN
    RAISE EXCEPTION 'Section C FAIL — new row status=% (expected tow_ticket)', v_post_new_status;
  END IF;
END;
$regen_C$;


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — permission gate (driver path)
-- ════════════════════════════════════════════════════════════════════
-- Two probes:
--   D.1 driver without permission → 'regenerate_not_permitted'
--   D.2 driver with permission → success path (or appropriate error if
--       fixture doesn't exist, but NOT 'regenerate_not_permitted')
--
-- ⚠ UAT OPERATOR: replace DRIVER_EMAIL_HERE with a real driver email
-- in your test company.

DO $regen_D$
DECLARE
  v_driver_email   CONSTANT TEXT := 'DRIVER_EMAIL_HERE';  -- ← EDIT to real driver email
  v_result_denied  jsonb;
  v_result_allowed jsonb;
  v_resolved_role  TEXT;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ IDENTITY-RESOLVE PRE-CHECK (Jose lesson 2026-06-26)     ║
  -- ║ Set JWT first + verify get_my_role() returns 'driver'   ║
  -- ║ BEFORE any UPDATE / RPC call. Without this, an unresolved║
  -- ║ mock cascades into "got no_role_assigned instead of      ║
  -- ║ regenerate_not_permitted" — masking mock-not-wired as a  ║
  -- ║ permission-gate failure.                                 ║
  -- ╚══════════════════════════════════════════════════════════╝
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_driver_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_driver_email), true);
  v_resolved_role := get_my_role();
  IF v_resolved_role IS NULL THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — JWT mock did not resolve a role for "%". Check: (1) DRIVER_EMAIL_HERE placeholder was replaced with a real email; (2) that email exists in user_roles with role=''driver''.', v_driver_email;
  END IF;
  IF v_resolved_role <> 'driver' THEN
    RAISE EXCEPTION 'Section D SETUP FAIL — resolved role is "%". For Section D, use a driver email (the test asserts the per-driver permission gate, which only applies to role=driver).', v_resolved_role;
  END IF;

  -- D.1 ensure permission OFF
  UPDATE public.user_roles
     SET can_regenerate_tow_ticket = FALSE
   WHERE lower(email) = lower(v_driver_email);

  v_result_denied := public.regenerate_tow_ticket(
    p_original_violation_id   := -1,
    p_new_storage_facility_id := -1,
    p_new_tow_fee             := 0.00,
    p_reason                  := 'wrong_facility',
    p_reason_note             := NULL
  );

  -- D.2 grant permission, re-probe
  UPDATE public.user_roles
     SET can_regenerate_tow_ticket = TRUE
   WHERE lower(email) = lower(v_driver_email);

  v_result_allowed := public.regenerate_tow_ticket(
    p_original_violation_id   := -1,
    p_new_storage_facility_id := -1,
    p_new_tow_fee             := 0.00,
    p_reason                  := 'wrong_facility',
    p_reason_note             := NULL
  );

  -- Reset permission to default FALSE (don't leave test driver granted)
  UPDATE public.user_roles
     SET can_regenerate_tow_ticket = FALSE
   WHERE lower(email) = lower(v_driver_email);

  RAISE NOTICE '── Section D permission gate ──';
  RAISE NOTICE '  denied (perm=FALSE):  %', v_result_denied;
  RAISE NOTICE '  allowed (perm=TRUE):  %', v_result_allowed;

  IF v_result_denied ->> 'error' <> 'regenerate_not_permitted' THEN
    RAISE EXCEPTION 'Section D FAIL — perm=FALSE did not return regenerate_not_permitted (got: %)', v_result_denied;
  END IF;
  IF v_result_allowed ->> 'error' = 'regenerate_not_permitted' THEN
    RAISE EXCEPTION 'Section D FAIL — perm=TRUE still returned regenerate_not_permitted';
  END IF;
  -- Other errors (violation_not_found etc.) are EXPECTED here because
  -- we passed -1 as the violation id; the point is the permission
  -- gate is correctly past-or-blocking.
END;
$regen_D$;


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — company-scope parity
-- ════════════════════════════════════════════════════════════════════
-- Body-content invariant: the company-scope predicate uses ~~* on
-- properties.company AND exact match on properties.name — mirrors
-- B219 Layer 1 / pm_plate_lookup / set_violation_status / b40 RLS.

SELECT
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text)'::regprocedure)
    ~* 'p\.company\s+~~\*\s+v_caller_company'                                        AS company_predicate_ilike,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text)'::regprocedure)
    ~* 'p\.name\s*=\s*v_original\.property'                                          AS property_name_exact_match,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text)'::regprocedure)
    ~* 'v_storage\.company\s+~~\*\s+v_caller_company'                                AS storage_scope_ilike;
-- Expected: all 3 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- F. ★ LOAD-BEARING — D2 advance-from-new-only
-- ════════════════════════════════════════════════════════════════════
-- Three sub-probes on throwaway rows:
--   F.1 stamp a 'new' row → status='tow_ticket'
--   F.2 stamp a 'resolved' row → status stays 'resolved'
--   F.3 stamp a 'disputed' row → status stays 'disputed'
--
-- All three call stamp_tow_ticket via direct UPDATE simulation (the
-- RPC requires auth/role; we test the SQL semantic via the same SET
-- clause shape). For full RPC test, see Section C's flow which also
-- exercises stamp_tow_ticket downstream of regenerate.

DO $regen_F$
DECLARE
  v_company       CONSTANT TEXT := '__regen_test_d2_company__';
  v_property      CONSTANT TEXT := '__regen_test_d2_property__';
  v_id_new        BIGINT;
  v_id_resolved   BIGINT;
  v_id_disputed   BIGINT;
  v_status_after_new      TEXT;
  v_status_after_resolved TEXT;
  v_status_after_disputed TEXT;
BEGIN
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES (v_property, v_company, '__regen_test_d2_address__', TRUE);

  INSERT INTO public.violations (plate, violation_type, property, is_confirmed, status)
    VALUES ('REGD2NEW', 'overnight', v_property, TRUE, 'new') RETURNING id INTO v_id_new;
  INSERT INTO public.violations (plate, violation_type, property, is_confirmed, status)
    VALUES ('REGD2RES', 'overnight', v_property, TRUE, 'resolved') RETURNING id INTO v_id_resolved;
  INSERT INTO public.violations (plate, violation_type, property, is_confirmed, status)
    VALUES ('REGD2DIS', 'overnight', v_property, TRUE, 'disputed') RETURNING id INTO v_id_disputed;

  -- Apply the SAME SET clause stamp_tow_ticket uses (and that the
  -- regenerate RPC's Step 4 uses without the CASE since new rows
  -- are always 'new'). Tests the CASE guard explicitly.
  UPDATE public.violations
     SET tow_ticket_generated = TRUE,
         tow_ticket_generated_at = now(),
         status = CASE WHEN status = 'new' THEN 'tow_ticket' ELSE status END
   WHERE id IN (v_id_new, v_id_resolved, v_id_disputed);

  SELECT status INTO v_status_after_new      FROM public.violations WHERE id = v_id_new;
  SELECT status INTO v_status_after_resolved FROM public.violations WHERE id = v_id_resolved;
  SELECT status INTO v_status_after_disputed FROM public.violations WHERE id = v_id_disputed;

  -- Cleanup unconditional
  DELETE FROM public.violations WHERE property = v_property;
  DELETE FROM public.properties WHERE name = v_property;

  RAISE NOTICE '── Section F D2 advance-from-new-only ──';
  RAISE NOTICE '  status_after_new      = % (expected tow_ticket)', v_status_after_new;
  RAISE NOTICE '  status_after_resolved = % (expected resolved)',  v_status_after_resolved;
  RAISE NOTICE '  status_after_disputed = % (expected disputed)',  v_status_after_disputed;

  IF v_status_after_new      <> 'tow_ticket' THEN RAISE EXCEPTION 'Section F FAIL — new not advanced'; END IF;
  IF v_status_after_resolved <> 'resolved'   THEN RAISE EXCEPTION 'Section F FAIL — resolved clobbered'; END IF;
  IF v_status_after_disputed <> 'disputed'   THEN RAISE EXCEPTION 'Section F FAIL — disputed clobbered'; END IF;
END;
$regen_F$;


-- ════════════════════════════════════════════════════════════════════
-- G. Audit rows present
-- ════════════════════════════════════════════════════════════════════

-- G.1 Migration audit rows
SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE new_values->>'migration' = '20260626_tow_ticket_regenerate_layer_1'
 ORDER BY created_at;
-- Expected 3 rows:
--   SCHEMA_RPC_ADDED      regenerate_tow_ticket
--   SCHEMA_RPC_UPDATED    stamp_tow_ticket
--   SCHEMA_COLUMNS_ADDED  violations + user_roles

-- G.2 After Section C runs (if Section C reached the RPC successfully),
-- VIOLATION_VOIDED + VIOLATION_REGENERATED rows are present.
-- This is a soft-check; Section C's cleanup deletes the fixture rows
-- but audit_logs entries persist (intentional — immutable audit).
SELECT created_at, action, record_id, new_values
  FROM public.audit_logs
 WHERE action IN ('VIOLATION_VOIDED', 'VIOLATION_REGENERATED')
   AND new_values->>'via_regenerate' = 'true'
    OR new_values->>'original_violation_id' IS NOT NULL
 ORDER BY created_at DESC
 LIMIT 10;
-- Expected (post-Section C): at least one VIOLATION_VOIDED with
-- via_regenerate=true + replaced_by, AND one VIOLATION_REGENERATED
-- with original_violation_id + reason='wrong_facility'.


-- ════════════════════════════════════════════════════════════════════
-- H. ★ LOAD-BEARING — void_violation UNTOUCHED
-- ════════════════════════════════════════════════════════════════════
-- The standalone-void path (B175 / D4 lock) must remain admin+CA-only
-- and must not have been modified by this migration. The body should
-- still match B175 — no driver path added, no regenerate-aware logic.

SELECT
  -- Invariant 1: role gate still admin+CA only
  pg_get_functiondef('public.void_violation(bigint, text)'::regprocedure)
    ~* 'v_caller_role\s+NOT\s+IN\s*\(\s*''admin''\s*,\s*''company_admin''\s*\)'      AS void_role_gate_intact,

  -- Invariant 2: body does NOT reference regenerate columns or the new RPC
  pg_get_functiondef('public.void_violation(bigint, text)'::regprocedure)
    NOT ILIKE '%regenerate%'                                                         AS void_no_regenerate_reference,

  -- Invariant 3: B175's already-voided refusal still present
  pg_get_functiondef('public.void_violation(bigint, text)'::regprocedure)
    ~* 'voided_at\s+IS\s+NOT\s+NULL'                                                 AS void_already_voided_guard_intact;
-- Expected: all 3 TRUE.

-- H.2 Confirm pm_plate_lookup (touched by B220 yesterday) is also untouched
-- by this migration (defensive sanity).
SELECT
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    ~* 'FROM\s+guest_authorizations'                                                  AS pm_lookup_still_has_b220_stage;
-- Expected: TRUE.
