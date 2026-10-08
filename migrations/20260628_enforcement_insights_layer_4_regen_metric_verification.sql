-- Layer 4 — verification for get_enforcement_insights amendment.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (proves pre-amendment state)
--   2. Apply 20260628_enforcement_insights_layer_4_regen_metric.sql
--   3. Sections B–G post-apply
--
-- LOAD-BEARING SECTIONS:
--   - C: regression-guard #1 (structure) — all 8 existing flag CTE
--     names + 6 widget output keys still present in function body.
--   - E: regression-guard #2 (behavior) — re-run get_enforcement_
--     insights as the B219 2b test CA, assert all 8 existing flag
--     headlines are byte-identical to what L2b produced. This is
--     the strongest regression proof — CTE name presence alone
--     could hide a body change that breaks the output.
--   - G: time-window respect — synthetic VIOLATION_REGENERATED row
--     dated > 30d ago must NOT count in the default-30d window.
--
-- DEFERRED TO UAT (cannot test from SQL Editor — no JWT):
--   - real driver performs a regenerate, regens count increments
--   - regen_spike_driver fires when 5+ regenerates land in 7d

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — function body does NOT yet contain Layer 4 markers
-- ════════════════════════════════════════════════════════════════════

SELECT
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    NOT LIKE '%regen_by_driver_window%' AS pre_no_regen_window_cte,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    NOT LIKE '%flag_regen_spike_driver%' AS pre_no_regen_spike_cte,
  -- Post-refactor (2026-06-26): we no longer reference the
  -- VIOLATION_REGENERATED audit action. Marker swapped to
  -- `regenerated_from IS NOT NULL` — the FK-based source.
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    NOT LIKE '%regenerated_from IS NOT NULL%' AS pre_no_regen_fk_filter;
-- Expected PRE-APPLY: all 3 booleans TRUE.
-- Expected POST-APPLY: all 3 booleans FALSE (Layer 4 added these markers).


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — new identifiers present
-- ════════════════════════════════════════════════════════════════════

SELECT
  -- 4 new CTEs landed
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'regen_by_driver_window\s+AS\s*\('                                    AS regen_window_cte_present,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'regen_by_driver_14d\s+AS\s*\('                                       AS regen_14d_cte_present,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_regen_spike_driver\s+AS\s*\('                                   AS regen_spike_cte_present,
  -- by_driver gained the regens field
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''regens'',%'                                                      AS by_driver_has_regens_field,
  -- trend CASE extended with rising_regens
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''rising_regens''%'                                                AS trend_has_rising_regens,
  -- flag UNION includes the new flag
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''regen_spike_driver''%'                                           AS flags_has_regen_spike,
  -- FK-based source filter present (3 sites: window + 14d + spike CTEs)
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%regenerated_from IS NOT NULL%'                                     AS fk_filter_present,
  -- and the function still does NOT join audit_logs anywhere
  -- (refactor confirmation — voids/disputes/regens all per-row now).
  -- Tests the actual JOIN pattern, not the literal word — the body
  -- has 2 inline comments saying "no audit_logs join", which is fine.
  -- What matters is that no `FROM audit_logs` or `JOIN audit_logs`
  -- appears in the compiled SQL.
  regexp_count(
    pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure),
    '(?i)(FROM|JOIN)\s+(public\.)?audit_logs', 'g'
  ) = 0                                                                       AS no_audit_logs_join;
-- Expected: all 8 booleans return TRUE.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — regression-guard #1: existing structure intact
-- ════════════════════════════════════════════════════════════════════
-- All 8 existing flag CTE names + 6 widget output keys must still be
-- present in the function body. This catches accidental rename or
-- removal during the CREATE OR REPLACE rewrite.

SELECT
  -- 6 widget output keys (in the final SELECT jsonb_build_object)
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''status_pipeline''%'                                              AS k_status_pipeline,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''ticket_aging''%'                                                 AS k_ticket_aging,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''by_property''%'                                                  AS k_by_property,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''by_driver''%'                                                    AS k_by_driver,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''heatmap''%'                                                      AS k_heatmap,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%''repeat_vehicles''%'                                              AS k_repeat_vehicles,
  -- 8 existing flag CTEs
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_accuracy\s+AS\s*\('                                              AS cte_flag_accuracy,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_aging\s+AS\s*\('                                                 AS cte_flag_aging,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_dispute_spike_prop\s+AS\s*\('                                    AS cte_flag_dispute_prop,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_dispute_spike_driver\s+AS\s*\('                                  AS cte_flag_dispute_driver,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_void_spike_prop\s+AS\s*\('                                       AS cte_flag_void_prop,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_void_spike_driver\s+AS\s*\('                                     AS cte_flag_void_driver,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_coverage\s+AS\s*\('                                              AS cte_flag_coverage,
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    ~* 'flag_stuck\s+AS\s*\('                                                 AS cte_flag_stuck;
-- Expected: all 14 booleans return TRUE.
-- If any FALSE → the rewrite dropped or renamed an existing structure;
-- ABORT and investigate before any UI commit ships.


-- ════════════════════════════════════════════════════════════════════
-- D. Grants — authenticated only / no anon / no PUBLIC
-- ════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves grants; the REVOKE/GRANT re-affirmation
-- in the migration is defensive. Verify still clean.

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'get_enforcement_insights'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — regression-guard #2: BEHAVIORAL re-run of the
--    B219 2b 8-flag seed against the live dashboard.
-- ════════════════════════════════════════════════════════════════════
-- The B219 2b UAT seed (20260625_b219_layer_2b_uat_flag_seed.sql)
-- inserts 65 violations across 3 sentinel properties under the test
-- CA's company. Pre-Layer-4, calling get_enforcement_insights(NULL,
-- NULL, NULL) under that CA's session produces exactly 8 flag rows
-- with specific headlines (documented in the seed file's header).
--
-- Post-Layer-4, the SAME call against the SAME seeded data MUST
-- produce the SAME 8 flag headlines BYTE-IDENTICAL. regen_spike_driver
-- should NOT fire (the 2b seed inserts ZERO rows with regenerated_from
-- populated — verified via the pre-paste seed audit query below).
-- flag_count should still be 8.
--
-- PRE-REQUISITE: the B219 2b seed must currently be applied in prod
-- (it has not yet been wiped; the post-UAT wipe is a separate task).
-- If wiped, re-apply before running this section.
--
-- Edit the CA email below before running.

DO $regen_E$
DECLARE
  v_admin_email  CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- A1 Test Run 2 CA (owns __b219_uat_seed_a/b__)
  v_resolved_role TEXT;
  v_result       jsonb;
  v_flag_count   INTEGER;
  v_headlines    JSONB;
  v_regen_spike_count INTEGER;
BEGIN
  -- IDENTITY-RESOLVE PRE-CHECK (mirror Layer 1 / Layer 3 pattern)
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role := get_my_role();
  IF v_resolved_role IS NULL THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — JWT mock did not resolve a role for "%". Edit ADMIN_EMAIL_HERE to a real user_roles email.', v_admin_email;
  END IF;
  IF v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section E SETUP FAIL — resolved role is "%". get_enforcement_insights is company_admin-only; use a CA email.', v_resolved_role;
  END IF;

  -- Call the dashboard RPC (defaults: full company, last 30d)
  v_result := public.get_enforcement_insights(NULL, NULL, NULL);

  -- Surface result EARLY (before assertion, in case assertion raises
  -- and swallows later NOTICE output)
  v_flag_count := jsonb_array_length(v_result->'flags');
  SELECT jsonb_agg(elem->>'headline' ORDER BY elem->>'severity', elem->>'code')
    INTO v_headlines
    FROM jsonb_array_elements(v_result->'flags') elem;
  SELECT COUNT(*) INTO v_regen_spike_count
    FROM jsonb_array_elements(v_result->'flags') elem
   WHERE elem->>'code' = 'regen_spike_driver';

  RAISE NOTICE '── Section E behavioral regression-guard ──';
  RAISE NOTICE '  flag_count          = % (expected 8 — same as B219 2b)', v_flag_count;
  RAISE NOTICE '  regen_spike_count   = % (expected 0 — 2b seed has no rows with regenerated_from populated)', v_regen_spike_count;
  RAISE NOTICE '  headlines (sorted):';
  RAISE NOTICE '    %', v_headlines;
  RAISE NOTICE '  (compare against the 8 headlines in the B219 2b seed file header)';

  -- Hard assertions
  IF v_flag_count <> 8 THEN
    RAISE EXCEPTION 'Section E FAIL — flag_count = % (expected 8). Layer 4 amendment changed behavior of the existing 2b dashboard.', v_flag_count;
  END IF;
  IF v_regen_spike_count <> 0 THEN
    RAISE EXCEPTION 'Section E FAIL — regen_spike_driver fired (count=%) but 2b seed has zero rows with regenerated_from populated.', v_regen_spike_count;
  END IF;
END;
$regen_E$;
-- If Section E RAISES, the regression-guard caught a behavioral
-- change in the existing dashboard. ABORT the UI commit until
-- diagnosed. If the issue is the seed has been wiped (NO flags fire),
-- re-apply the seed and re-run.


-- ════════════════════════════════════════════════════════════════════
-- E.2 ★ LOAD-BEARING — positive proof: the metric FIRES on a real
--     regenerate via the L1 RPC (not just reads 0 from an inert seed)
-- ════════════════════════════════════════════════════════════════════
-- Section E proves the existing 8 flags still produce byte-identical
-- output. But "0 regens" against an empty regen population doesn't
-- prove the metric actually fires when it should.
--
-- E.2: synthesize a fresh regenerate via the L1 regenerate_tow_ticket
-- RPC (which sets regenerated_from atomically with the INSERT) on a
-- throwaway stamped fixture. Confirm the dashboard's by_driver row
-- for that synthetic driver reports regens >= 1. Cleanup unconditional.
--
-- This tests the LIVE PATH — RPC → regenerated_from FK → dashboard
-- aggregation — end-to-end, independent of the seed.

DO $regen_E2$
DECLARE
  v_admin_email   CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- A1 Test Run 2 CA (same as Section E; fixtures land in CA's company)
  v_test_email    CONSTANT TEXT := '__regen_e2_driver__@example.invalid';
  v_test_driver_name CONSTANT TEXT := '__regen_e2_driver_name__';
  v_test_storage_id  BIGINT;
  v_test_property TEXT;
  v_test_orig_id  BIGINT;
  v_new_id        BIGINT;
  v_resolved_role TEXT;
  v_resolved_company TEXT;
  v_regen_rpc_result jsonb;
  v_dash_result   jsonb;
  v_test_driver_regens INTEGER;
BEGIN
  -- IDENTITY-RESOLVE PRE-CHECK
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role    := get_my_role();
  v_resolved_company := get_my_company();
  IF v_resolved_role IS NULL OR v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section E.2 SETUP FAIL — JWT mock resolved role "%". Use a real CA email.', v_resolved_role;
  END IF;

  -- Pick any property in caller's scope for the fixture
  SELECT name INTO v_test_property
    FROM public.properties
   WHERE company ~~* v_resolved_company
   LIMIT 1;
  IF v_test_property IS NULL THEN
    RAISE EXCEPTION 'Section E.2 SETUP FAIL — caller has no properties for fixture.';
  END IF;

  -- Fixture: throwaway storage facility (need a valid id for the regen RPC)
  INSERT INTO public.storage_facilities (name, company, address, phone, is_active)
  VALUES ('__regen_e2_storage__', v_resolved_company, '999 Test Blvd', '555-9999', TRUE)
  RETURNING id INTO v_test_storage_id;

  -- Fixture: throwaway driver user_role (needed for regen permission gate)
  INSERT INTO public.user_roles (email, role, company, name, can_regenerate_tow_ticket)
  VALUES (v_test_email, 'driver', v_resolved_company, v_test_driver_name, TRUE);

  -- Fixture: throwaway STAMPED violation row (regen RPC requires
  -- tow_ticket_generated = TRUE on the original)
  INSERT INTO public.violations (
    plate, violation_type, property, driver_name, is_confirmed,
    tow_ticket_generated, tow_ticket_generated_at, tow_storage_name, tow_fee
  ) VALUES (
    'REGENE2', 'overnight', v_test_property, v_test_driver_name, TRUE,
    TRUE, now(), '__regen_e2_storage__', 250.00
  ) RETURNING id INTO v_test_orig_id;

  -- THE TEST: switch JWT to the test driver, fire regenerate_tow_ticket
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_test_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_test_email), true);

  v_regen_rpc_result := public.regenerate_tow_ticket(
    p_original_violation_id   := v_test_orig_id,
    p_new_storage_facility_id := v_test_storage_id,
    p_new_tow_fee             := 275.00,
    p_reason                  := 'wrong_facility',
    p_reason_note             := NULL,
    p_new_mileage_fee         := NULL,
    p_new_vin                 := NULL
  );

  -- ── DIAG #1: full RPC return jsonb (catches silent error returns
  --    that fail the IF check but lose detail before assertion) ────
  RAISE NOTICE '── Section E.2 DIAG #1 — regenerate_tow_ticket RPC return ──';
  RAISE NOTICE '  rpc_result = %', v_regen_rpc_result;

  IF (v_regen_rpc_result->>'ok')::BOOLEAN IS NOT TRUE THEN
    -- Cleanup before raise
    DELETE FROM public.violations WHERE id = v_test_orig_id OR regenerated_from = v_test_orig_id;
    DELETE FROM public.user_roles WHERE email = v_test_email;
    DELETE FROM public.storage_facilities WHERE id = v_test_storage_id;
    RAISE EXCEPTION 'Section E.2 SETUP FAIL — regenerate_tow_ticket RPC returned %', v_regen_rpc_result;
  END IF;
  v_new_id := (v_regen_rpc_result->>'new_violation_id')::BIGINT;

  -- ── DIAG #2: read back the new row to confirm regenerated_from set,
  --    is_confirmed, driver_name attribution, property scope, created_at
  --    window. If this NOTICE shows the row exists with FK populated +
  --    in-scope property + is_confirmed=TRUE + recent created_at, then
  --    the regenerate worked end-to-end and any dashboard miss is a
  --    CTE/aggregation bug, not a fixture bug. ─────────────────────────
  DECLARE
    v_new_row_diag RECORD;
  BEGIN
    SELECT id, driver_name, regenerated_from, property, is_confirmed,
           created_at, voided_at, tow_ticket_generated, tow_storage_name
      INTO v_new_row_diag
      FROM public.violations
     WHERE regenerated_from = v_test_orig_id;
    RAISE NOTICE '── Section E.2 DIAG #2 — new row from SELECT WHERE regenerated_from=% ──', v_test_orig_id;
    RAISE NOTICE '  id                   = %', v_new_row_diag.id;
    RAISE NOTICE '  driver_name          = "%"', v_new_row_diag.driver_name;
    RAISE NOTICE '  regenerated_from     = %', v_new_row_diag.regenerated_from;
    RAISE NOTICE '  property             = "%"', v_new_row_diag.property;
    RAISE NOTICE '  is_confirmed         = %', v_new_row_diag.is_confirmed;
    RAISE NOTICE '  created_at           = % (must be >= now()-30d for default window)', v_new_row_diag.created_at;
    RAISE NOTICE '  voided_at            = % (NULL = active; non-NULL = voided — should be NULL on new row)', v_new_row_diag.voided_at;
    RAISE NOTICE '  tow_ticket_generated = %', v_new_row_diag.tow_ticket_generated;
    RAISE NOTICE '  tow_storage_name     = "%"', v_new_row_diag.tow_storage_name;
  END;

  -- Switch JWT back to the CA to call the dashboard
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);

  -- ── DIAG #3: CA's resolved property list — mirrors the dashboard's
  --    own v_property_list build. If the fixture property is missing
  --    from this list, scoped_violations excludes the new row →
  --    metric reads NULL/0. This pinpoints scope mismatch (typically
  --    is_active filter difference, or ILIKE/exact-match drift). ─────
  DECLARE
    v_ca_property_list TEXT[];
    v_fixture_in_list  BOOLEAN;
  BEGIN
    SELECT array_agg(name) INTO v_ca_property_list
      FROM public.properties
     WHERE company ~~* v_resolved_company;
    v_fixture_in_list := v_test_property = ANY(v_ca_property_list);
    RAISE NOTICE '── Section E.2 DIAG #3 — CA scope vs fixture ──';
    RAISE NOTICE '  CA resolved_company         = "%"', v_resolved_company;
    RAISE NOTICE '  fixture v_test_property     = "%"', v_test_property;
    RAISE NOTICE '  v_property_list count       = %', COALESCE(array_length(v_ca_property_list, 1), 0);
    RAISE NOTICE '  fixture in v_property_list  = % (FALSE → scope bug — fixture property not in CA''s list)', v_fixture_in_list;
    RAISE NOTICE '  v_property_list (full)      = %', v_ca_property_list;
  END;

  -- Call dashboard. p_date_to = now() + 1s instead of default NULL —
  -- inside this DO block, fixture INSERTs get created_at = now() =
  -- transaction start, and the dashboard's `created_at < v_to`
  -- (= transaction start by default) would exclude them. The +1s
  -- buffer makes same-transaction rows visible. NOT a production
  -- semantics change; only matters when INSERTs and dashboard call
  -- share a transaction (test harness only).
  v_dash_result := public.get_enforcement_insights(NULL, NULL, now() + INTERVAL '1 second');

  -- ── DIAG #4: dump the by_driver slice — shows every bucket the
  --    dashboard surfaced, so we can tell whether the test driver
  --    appears under a different bucket name (e.g. '(unattributed)'
  --    if driver_name didn't carry forward correctly). ──────────────
  RAISE NOTICE '── Section E.2 DIAG #4 — full by_driver from dashboard ──';
  RAISE NOTICE '  by_driver = %', v_dash_result->'by_driver';

  SELECT (elem->>'regens')::INTEGER INTO v_test_driver_regens
    FROM jsonb_array_elements(v_dash_result->'by_driver') elem
   WHERE elem->>'driver' = v_test_driver_name;

  RAISE NOTICE '── Section E.2 ASSERTION ──';
  RAISE NOTICE '  regen RPC ok       = %', v_regen_rpc_result->>'ok';
  RAISE NOTICE '  new_violation_id   = %', v_new_id;
  RAISE NOTICE '  by_driver regens for test driver = % (expected >= 1; NULL = driver bucket absent from by_driver)', COALESCE(v_test_driver_regens, 0);

  -- Cleanup unconditional (run BEFORE assertion so failure doesn't leak)
  DELETE FROM public.violations         WHERE id IN (v_test_orig_id, v_new_id);
  DELETE FROM public.user_roles         WHERE email = v_test_email;
  DELETE FROM public.storage_facilities WHERE id = v_test_storage_id;
  -- L1 audit rows are tied to the new violation id; clean those too
  DELETE FROM public.audit_logs WHERE record_id::TEXT IN (v_test_orig_id::TEXT, v_new_id::TEXT)
    AND action IN ('VIOLATION_VOIDED', 'VIOLATION_REGENERATED');

  IF COALESCE(v_test_driver_regens, 0) < 1 THEN
    RAISE EXCEPTION 'Section E.2 FAIL — by_driver regens count = % for synthetic regenerate (expected >= 1). FK-based metric did not fire on the live path.', v_test_driver_regens;
  END IF;
END;
$regen_E2$;

-- Sanity: no E.2 fixture leaked
SELECT
  (SELECT COUNT(*) FROM public.violations         WHERE plate = 'REGENE2')                             AS leaked_violations,
  (SELECT COUNT(*) FROM public.user_roles         WHERE email = '__regen_e2_driver__@example.invalid') AS leaked_user_roles,
  (SELECT COUNT(*) FROM public.storage_facilities WHERE name = '__regen_e2_storage__')                 AS leaked_storage;
-- Expected: all 3 = 0.


-- ════════════════════════════════════════════════════════════════════
-- F. Migration audit row present
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, new_values
  FROM public.audit_logs
 WHERE action = 'SCHEMA_RPC_UPDATED'
   AND new_values->>'rpc' = 'get_enforcement_insights'
   AND new_values->>'migration' = '20260628_enforcement_insights_layer_4_regen_metric'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.


-- ════════════════════════════════════════════════════════════════════
-- G. ★ LOAD-BEARING — time-window respect
-- ════════════════════════════════════════════════════════════════════
-- Insert a synthetic regenerated violation row (regenerated_from set,
-- created_at = 35d ago). The default 30-day display window should
-- EXCLUDE it from the by_driver regens count.
--
-- Refactor note (2026-06-26): Section G originally inserted a
-- VIOLATION_REGENERATED audit row dated 35d ago. Post-refactor the
-- metric reads regenerated_from on the violations row directly, so
-- the time-window discriminator is now created_at on the regenerated
-- violation row (which equals the regenerate moment per L1).

DO $regen_G$
DECLARE
  v_admin_email   CONSTANT TEXT := 'alvaradolegacyconsulting+testrun2@gmail.com';  -- A1 Test Run 2 CA (same as Section E; fixtures land in CA's company)
  v_test_email    CONSTANT TEXT := '__regen_g_driver__@example.invalid';
  v_test_driver_name CONSTANT TEXT := '__regen_g_driver_name__';
  v_test_property TEXT;
  v_test_orig_id  BIGINT;
  v_test_new_id   BIGINT;
  v_resolved_role TEXT;
  v_resolved_company TEXT;
  v_result        jsonb;
  v_regen_count_for_test_driver INTEGER;
BEGIN
  -- IDENTITY-RESOLVE PRE-CHECK
  PERFORM set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  PERFORM set_config('request.jwt.claim',
    format('{"email":"%s","role":"authenticated"}', v_admin_email), true);
  v_resolved_role := get_my_role();
  v_resolved_company := get_my_company();
  IF v_resolved_role IS NULL OR v_resolved_role <> 'company_admin' THEN
    RAISE EXCEPTION 'Section G SETUP FAIL — JWT mock resolved role "%". Use a real CA email.', v_resolved_role;
  END IF;

  -- Pick any property in caller's scope (must be in v_property_list
  -- for the FK-based filter to pick up the synthetic row).
  SELECT name INTO v_test_property
    FROM public.properties
   WHERE company ~~* v_resolved_company
   LIMIT 1;
  IF v_test_property IS NULL THEN
    RAISE EXCEPTION 'Section G SETUP FAIL — caller has no properties to use for fixture.';
  END IF;

  -- Fixture: throwaway user_roles row + 2 violations rows (original
  -- + regenerated). Both backdated 35d so they fall outside the 30d
  -- window. The regenerated row references the original via
  -- regenerated_from FK.
  INSERT INTO public.user_roles (email, role, company, name, can_regenerate_tow_ticket)
  VALUES (v_test_email, 'driver', v_resolved_company, v_test_driver_name, TRUE);

  -- Original (voided) row, 35d ago
  INSERT INTO public.violations (
    plate, violation_type, property, driver_name, is_confirmed,
    voided_at, created_at
  ) VALUES (
    'REGENG1', 'overnight', v_test_property, v_test_driver_name, TRUE,
    now() - INTERVAL '35 days', now() - INTERVAL '35 days'
  ) RETURNING id INTO v_test_orig_id;

  -- THE TEST: regenerated row, 35d ago, FK-linked
  INSERT INTO public.violations (
    plate, violation_type, property, driver_name, is_confirmed,
    tow_ticket_generated, tow_storage_name,
    regenerated_from, created_at
  ) VALUES (
    'REGENG1', 'overnight', v_test_property, v_test_driver_name, TRUE,
    TRUE, '__test_storage__',
    v_test_orig_id, now() - INTERVAL '35 days'   -- 35 days ago — outside default 30d window
  ) RETURNING id INTO v_test_new_id;

  -- Call dashboard with default 30d window — should EXCLUDE the 35d-old row
  v_result := public.get_enforcement_insights(NULL, NULL, NULL);

  -- Look for test driver in by_driver. Absent → regens=0 by definition.
  -- Present → regens should still be 0 (synthetic row outside v_from).
  SELECT (elem->>'regens')::INTEGER INTO v_regen_count_for_test_driver
    FROM jsonb_array_elements(v_result->'by_driver') elem
   WHERE elem->>'driver' = v_test_driver_name;

  RAISE NOTICE '── Section G time-window respect ──';
  RAISE NOTICE '  regens for test driver (default 30d window) = %', COALESCE(v_regen_count_for_test_driver, 0);
  RAISE NOTICE '  (expected 0 — synthetic regenerated row is 35 days old)';

  -- Cleanup unconditional (run BEFORE assertion so failure doesn't leak)
  DELETE FROM public.violations WHERE id IN (v_test_orig_id, v_test_new_id);
  DELETE FROM public.user_roles WHERE email = v_test_email;

  IF COALESCE(v_regen_count_for_test_driver, 0) <> 0 THEN
    RAISE EXCEPTION 'Section G FAIL — regens count = % for synthetic-35d-old regenerated row (expected 0). Time window not respected.', v_regen_count_for_test_driver;
  END IF;
END;
$regen_G$;

-- Sanity: no G fixture leaked
SELECT
  (SELECT COUNT(*) FROM public.user_roles WHERE email = '__regen_g_driver__@example.invalid')  AS leaked_user_roles,
  (SELECT COUNT(*) FROM public.violations WHERE plate = 'REGENG1')                              AS leaked_violations;
-- Expected: both = 0.
