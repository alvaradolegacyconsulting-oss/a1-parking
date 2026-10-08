-- Verification queries for mileage + VIN persistence migration.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (columns absent + RPC bodies don't
--      reference the new fields)
--   2. Apply 20260629_violations_mileage_vin_persistence.sql
--   3. Sections B–G post-apply
--
-- LOAD-BEARING SECTIONS:
--   - C: grants — authenticated only / no anon / no PUBLIC on BOTH
--     RPCs (CREATE OR REPLACE preserves grants on signature-stable
--     changes, but signature CHANGED here — re-affirm is critical)
--   - D: KEEP-IN-SYNC verifier — BOTH new fields appear in
--     regenerate_tow_ticket's body (catches drift on either side)
--   - E: behavioral persist check — both fields actually persist
--     when stamp_tow_ticket is called with them
--   - G: regression-guard — B182 already_stamped guard, L1 D2 status
--     advance, company-scope predicates all still present in
--     stamp_tow_ticket; L1 Step 1-5 ordering still in regenerate_tow_ticket
--
-- DEFERRED TO UAT (cannot test from SQL Editor — no JWT):
--   - Real driver fresh-stamps with mileage + VIN; values persist
--     + appear on the read-only view + print HTML
--   - Real driver regenerates with new mileage + new VIN; new row
--     carries the new values; void audit captures old/new deltas

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — columns absent + RPC bodies don't yet reference
-- ════════════════════════════════════════════════════════════════════

SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='violations'
             AND column_name='tow_mileage_fee')                                AS pre_mileage_col_absent_NOT,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='violations'
             AND column_name='vehicle_vin')                                     AS pre_vin_col_absent_NOT;
-- Expected PRE-APPLY:  both FALSE (columns absent)
-- Expected POST-APPLY: both TRUE  (columns present)

-- Body-content pre-state — confirms the rewrites haven't been applied yet.
-- pg_get_functiondef returns the function body; LIKE check on raw text.
SELECT
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric)'::regprocedure)
    NOT LIKE '%tow_mileage_fee%'                                                AS pre_stamp_no_mileage_ref,
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric)'::regprocedure)
    NOT LIKE '%vehicle_vin%'                                                    AS pre_stamp_no_vin_ref;
-- Expected PRE-APPLY: both TRUE (3-arg signature still in place, no field refs)
-- POST-APPLY this query will error because the 3-arg signature is gone
-- (signature changed to 5-arg). That's expected — Section B uses the new signature.


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — schema + RPC body markers present
-- ════════════════════════════════════════════════════════════════════

-- B.1 columns
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='violations'
   AND column_name IN ('tow_mileage_fee', 'vehicle_vin')
 ORDER BY column_name;
-- Expected 2 rows:
--   tow_mileage_fee | numeric | YES | (null)
--   vehicle_vin     | text    | YES | (null)

-- B.2 stamp_tow_ticket — new 5-arg signature present, both fields in body
SELECT
  EXISTS (SELECT 1 FROM pg_proc
           WHERE pronamespace='public'::regnamespace
             AND proname='stamp_tow_ticket'
             AND pronargs=5)                                                    AS stamp_new_sig_present,
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    LIKE '%tow_mileage_fee%'                                                    AS stamp_body_has_mileage,
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    LIKE '%vehicle_vin%'                                                        AS stamp_body_has_vin,
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    ~* 'COALESCE\s*\(\s*p_mileage_fee'                                          AS stamp_uses_coalesce_mileage,
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    ~* 'COALESCE\s*\(\s*p_vin'                                                  AS stamp_uses_coalesce_vin;
-- Expected: all 5 booleans TRUE.

-- B.3 regenerate_tow_ticket — new 7-arg signature present, both fields in body
SELECT
  EXISTS (SELECT 1 FROM pg_proc
           WHERE pronamespace='public'::regnamespace
             AND proname='regenerate_tow_ticket'
             AND pronargs=7)                                                    AS regen_new_sig_present,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%p_new_mileage_fee%'                                                  AS regen_has_mileage_arg,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%p_new_vin%'                                                          AS regen_has_vin_arg;
-- Expected: all 3 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants (authenticated only; no anon, no PUBLIC)
-- ════════════════════════════════════════════════════════════════════
-- Signature changed on both RPCs. The migration explicitly REVOKE +
-- GRANT against the NEW signatures (5-arg stamp, 7-arg regenerate)
-- because old-signature grants don't transfer. Verify the new
-- signatures have correct grants AND no anon / PUBLIC drift.

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema='public'
   AND routine_name IN ('stamp_tow_ticket', 'regenerate_tow_ticket')
 ORDER BY routine_name, grantee;
-- Expected: each routine present with 'authenticated' grantee (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — KEEP-IN-SYNC verifier
-- ════════════════════════════════════════════════════════════════════
-- Both new fields MUST appear in regenerate_tow_ticket's body so the
-- Step-4 inline stamp UPDATE persists them (the loud ⚠⚠⚠ KEEP IN SYNC
-- zone from L1). If a future maintainer adds a 3rd field to
-- stamp_tow_ticket but forgets regenerate_tow_ticket's inline UPDATE,
-- this section won't catch THAT (no way to know what's "missing"),
-- BUT it WILL catch the inverse — if a future maintainer accidentally
-- removes the field from regenerate_tow_ticket, this section flips
-- FALSE and the regression is obvious.

SELECT
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    ~* 'tow_mileage_fee\s*=\s*p_new_mileage_fee'                                AS regen_step4_mileage_persist,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    ~* 'vehicle_vin\s*=\s*p_new_vin'                                            AS regen_step4_vin_persist,
  -- And the audit row captures old/new for both (forensic completeness):
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%old_mileage_fee%'                                                    AS regen_audit_has_old_mileage,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%new_mileage_fee%'                                                    AS regen_audit_has_new_mileage,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%old_vin%'                                                            AS regen_audit_has_old_vin,
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%new_vin%'                                                            AS regen_audit_has_new_vin;
-- Expected: all 6 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — behavioral persist check (both fields)
-- ════════════════════════════════════════════════════════════════════
-- Synthetic fixture violation → call stamp_tow_ticket with explicit
-- mileage + VIN values → SELECT confirms both persisted on the row.
-- Cleanup unconditional (DELETE before assertion) so a failed
-- assertion doesn't leak.
--
-- Uses sentinel property/plate strings for safe cleanup. Caller is
-- SQL Editor (postgres role) — bypasses RLS; we're testing the
-- COLUMN-PERSIST behavior, not the auth gate (auth covered by L1's
-- behavioral check pattern).

DO $persist_test$
DECLARE
  v_test_property  CONSTANT TEXT := '__mileage_vin_persist_test__';
  v_test_plate     CONSTANT TEXT := 'MVPERSIST';
  v_test_storage_id BIGINT;
  v_test_id         BIGINT;
  v_persisted_mileage NUMERIC;
  v_persisted_vin     TEXT;
  v_rpc_result        jsonb;
BEGIN
  -- Fixture: throwaway storage facility (admin-bypassable since
  -- we're running as postgres in SQL Editor)
  INSERT INTO public.storage_facilities (name, company, address, phone, is_active)
  VALUES ('__mvp_test_storage__', '__mvp_test_company__', '111 Test St', '555-0001', TRUE)
  RETURNING id INTO v_test_storage_id;

  -- Fixture: throwaway property
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES (v_test_property, '__mvp_test_company__', '222 Test Ave', TRUE);

  -- Fixture: confirmed, unstamped violation
  INSERT INTO public.violations (
    plate, violation_type, property, is_confirmed
  ) VALUES (
    v_test_plate, 'overnight', v_test_property, TRUE
  ) RETURNING id INTO v_test_id;

  -- THE TEST: call stamp_tow_ticket with mileage + VIN
  -- (running as postgres bypasses auth gate; storage/violation
  --  scope checks pass since postgres + admin-equivalent context)
  v_rpc_result := public.stamp_tow_ticket(
    p_violation_id        := v_test_id,
    p_storage_facility_id := v_test_storage_id,
    p_tow_fee             := 250.00,
    p_mileage_fee         := 25.50,
    p_vin                 := '1HGCM82633A123456'
  );

  -- Read back the row
  SELECT tow_mileage_fee, vehicle_vin INTO v_persisted_mileage, v_persisted_vin
    FROM public.violations WHERE id = v_test_id;

  RAISE NOTICE '── Section E persist check ──';
  RAISE NOTICE '  rpc_result        = %', v_rpc_result;
  RAISE NOTICE '  persisted_mileage = % (expected 25.50)', v_persisted_mileage;
  RAISE NOTICE '  persisted_vin     = % (expected 1HGCM82633A123456)', v_persisted_vin;

  -- Cleanup unconditional
  DELETE FROM public.violations         WHERE id = v_test_id;
  DELETE FROM public.properties         WHERE name = v_test_property;
  DELETE FROM public.storage_facilities WHERE id = v_test_storage_id;

  -- Hard assertions
  IF v_persisted_mileage IS DISTINCT FROM 25.50 THEN
    RAISE EXCEPTION 'Section E FAIL — mileage persist: got %, expected 25.50', v_persisted_mileage;
  END IF;
  IF v_persisted_vin IS DISTINCT FROM '1HGCM82633A123456' THEN
    RAISE EXCEPTION 'Section E FAIL — VIN persist: got %, expected 1HGCM82633A123456', v_persisted_vin;
  END IF;
END;
$persist_test$;

-- Leak check
SELECT
  (SELECT COUNT(*) FROM public.violations         WHERE plate = 'MVPERSIST')                       AS leaked_violations,
  (SELECT COUNT(*) FROM public.properties         WHERE name = '__mileage_vin_persist_test__')     AS leaked_properties,
  (SELECT COUNT(*) FROM public.storage_facilities WHERE name = '__mvp_test_storage__')             AS leaked_storage;
-- Expected: all 3 = 0.


-- ════════════════════════════════════════════════════════════════════
-- F. Migration audit rows present
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE new_values->>'migration' = '20260629_violations_mileage_vin_persistence'
 ORDER BY created_at, action;
-- Expected 3 rows:
--   SCHEMA_COLUMNS_ADDED | violations
--   SCHEMA_RPC_UPDATED   | regenerate_tow_ticket
--   SCHEMA_RPC_UPDATED   | stamp_tow_ticket


-- ════════════════════════════════════════════════════════════════════
-- G. ★ LOAD-BEARING — regression-guard
-- ════════════════════════════════════════════════════════════════════
-- The rewrites preserved all prior invariants. If any of these flip
-- FALSE, the rewrite dropped a behavior we need.

SELECT
  -- stamp_tow_ticket: B182 already_stamped guard still present
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    LIKE '%already_stamped%'                                                    AS stamp_b182_guard_intact,
  -- stamp_tow_ticket: L1 D2 status advance still present
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    ~* 'CASE\s+WHEN\s+status\s*=\s*''new'''                                     AS stamp_d2_status_advance_intact,
  -- stamp_tow_ticket: company-scope predicate (ILIKE) still present
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    ~* 'p\.company\s+~~\*\s+v_company'                                          AS stamp_scope_predicate_intact,
  -- stamp_tow_ticket: existing tow_fee SET clause still present
  pg_get_functiondef('public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)'::regprocedure)
    ~* 'tow_fee\s*=\s*p_tow_fee'                                                AS stamp_tow_fee_set_intact,

  -- regenerate_tow_ticket: void-first ordering still present
  -- (UPDATE...SET voided_at must appear BEFORE INSERT INTO public.violations)
  position('voided_at              = now()' IN
           pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure))
    < position('INSERT INTO public.violations' IN
                pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)) AS regen_void_first_ordering_intact,
  -- regenerate_tow_ticket: regenerate_not_permitted role gate still present
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%regenerate_not_permitted%'                                           AS regen_permission_gate_intact,
  -- regenerate_tow_ticket: company-scope predicate still present
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    ~* 'p\.company\s+~~\*\s+v_caller_company'                                   AS regen_scope_predicate_intact,
  -- regenerate_tow_ticket: regenerated_from FK link still set on new row
  pg_get_functiondef('public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)'::regprocedure)
    LIKE '%regenerated_from%'                                                   AS regen_origin_link_intact;
-- Expected: all 8 TRUE.
-- If any FALSE → the rewrite dropped a prior behavior; ABORT and
-- investigate before any UI commit ships.
