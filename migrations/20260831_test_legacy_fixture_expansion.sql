-- ══════════════════════════════════════════════════════════════════════
-- 20260831_test_legacy_fixture_expansion.sql
--
-- 🟢 Test-LEGACY fixture expansion (Mateo Aug 30 §1-§2 + Aug 31)
--
-- Purpose: unblock two "not tested" gates in the space-payments arc
-- verification. Idempotent SELECT-then-INSERT throughout — safe to
-- re-apply.
--
-- ── WHAT IT ADDS ────────────────────────────────────────────────────
--
-- 1. A fourth Test-LEGACY property "Test VE4 Cross-Prop" NOT assigned
--    to legacy-manager, with one active space. This is VE4's fixture —
--    a same-company space at a property outside the chosen manager's
--    scope. Without it VE4 has no target and fires FIXTURE FAIL.
--
--    🔴 DO NOT assign legacy-manager to this property. That's the
--    whole point — VE4 needs a Test-LEGACY space the manager CAN'T
--    see, so the property-scope enforcement (space_not_in_your_
--    properties) fires. Adding to legacy-manager.property would
--    silently re-break the gate.
--
-- 2. Two spaces on the currently-empty Test-LEGACY properties
--    ("Alias Probe Two", "Test Property for Driver"). Makes the
--    tenant less degenerate — every gate picking "a space at a
--    Test-LEGACY property" now has more than one choice, useful for
--    future gates.
--
-- 3. One bundled space at "Test Legacy Property" with TWO tied
--    residents (space_residents rows). This unblocks the multi-
--    resident snapshot gate (2+ tied → resident_email/name/unit all
--    NULL, no arbitrary pick). Two test residents seeded inline if
--    they don't already exist.
--
-- ── LEGACY-MANAGER SAFETY ──────────────────────────────────────────
-- Verified 2026-08-31 (Mateo F1.CROSSPROP): legacy-manager is
-- currently assigned to all three existing Test-LEGACY properties.
-- This migration does NOT modify user_roles.property. The new
-- property #4 is created WITHOUT being added to any manager's
-- assignment — that's what makes it a valid cross-property target.
--
-- ── APPLY ──────────────────────────────────────────────────────────
-- Single database. Wrapped in BEGIN/COMMIT. Every INSERT is
-- SELECT-then-conditional-INSERT so re-runs are safe (counters
-- return 0 additions).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  c_company               CONSTANT TEXT := 'Test-LEGACY';
  c_new_property_name     CONSTANT TEXT := 'Test VE4 Cross-Prop';
  c_alias_probe_two       CONSTANT TEXT := 'Alias Probe Two';
  c_test_prop_for_driver  CONSTANT TEXT := 'Test Property for Driver';
  c_test_legacy_prop      CONSTANT TEXT := 'Test Legacy Property';
  c_res_a_email           CONSTANT TEXT := 'test-legacy-bundled-a@test.shieldmylot.com';
  c_res_b_email           CONSTANT TEXT := 'test-legacy-bundled-b@test.shieldmylot.com';
  c_bundled_label         CONSTANT TEXT := 'B-1';

  v_new_prop_exists       INT;
  v_new_space_exists      INT;
  v_ap2_space_exists      INT;
  v_tpd_space_exists      INT;
  v_bundled_space_id      BIGINT;
  v_bundled_space_exists  INT;
  v_res_a_exists          INT;
  v_res_b_exists          INT;
  v_tie_a_exists          INT;
  v_tie_b_exists          INT;
BEGIN
  -- ── 1. Fourth Test-LEGACY property (NOT assigned to legacy-manager) ─
  SELECT COUNT(*) INTO v_new_prop_exists
    FROM public.properties
   WHERE name = c_new_property_name
     AND company = c_company;
  IF v_new_prop_exists = 0 THEN
    INSERT INTO public.properties (name, company, address, city, state, zip, visitor_capacity, is_active)
    VALUES (c_new_property_name, c_company, '1 Cross-Property Way', 'Houston', 'TX', '77002', 5, TRUE);
    RAISE NOTICE 'Created property: % at %', c_new_property_name, c_company;
  ELSE
    RAISE NOTICE 'Property % already exists at % — no INSERT', c_new_property_name, c_company;
  END IF;

  -- ── 2. One active space at the new property ────────────────────────
  SELECT COUNT(*) INTO v_new_space_exists
    FROM public.spaces
   WHERE company = c_company AND property = c_new_property_name;
  IF v_new_space_exists = 0 THEN
    INSERT INTO public.spaces (company, property, label, type, is_active, created_by_email)
    VALUES (c_company, c_new_property_name, 'X-1', 'regular', TRUE, 'system_fixture_migration');
    RAISE NOTICE 'Created cross-prop space at % (label X-1)', c_new_property_name;
  ELSE
    RAISE NOTICE 'Space already exists at % — no INSERT', c_new_property_name;
  END IF;

  -- ── 3a. One space at Alias Probe Two ───────────────────────────────
  SELECT COUNT(*) INTO v_ap2_space_exists
    FROM public.spaces
   WHERE company = c_company AND property = c_alias_probe_two;
  IF v_ap2_space_exists = 0 THEN
    INSERT INTO public.spaces (company, property, label, type, is_active, created_by_email)
    VALUES (c_company, c_alias_probe_two, 'AP2-1', 'regular', TRUE, 'system_fixture_migration');
    RAISE NOTICE 'Created space at % (label AP2-1)', c_alias_probe_two;
  ELSE
    RAISE NOTICE 'Space already exists at % — no INSERT', c_alias_probe_two;
  END IF;

  -- ── 3b. One space at Test Property for Driver ──────────────────────
  SELECT COUNT(*) INTO v_tpd_space_exists
    FROM public.spaces
   WHERE company = c_company AND property = c_test_prop_for_driver;
  IF v_tpd_space_exists = 0 THEN
    INSERT INTO public.spaces (company, property, label, type, is_active, created_by_email)
    VALUES (c_company, c_test_prop_for_driver, 'TPD-1', 'regular', TRUE, 'system_fixture_migration');
    RAISE NOTICE 'Created space at % (label TPD-1)', c_test_prop_for_driver;
  ELSE
    RAISE NOTICE 'Space already exists at % — no INSERT', c_test_prop_for_driver;
  END IF;

  -- ── 4. Two test residents for the bundled space ────────────────────
  -- Distinct emails so re-runs are keyed cleanly. Tied to
  -- Test Legacy Property to keep the space's property + residents'
  -- property consistent (residents.property is on the row too).
  SELECT COUNT(*) INTO v_res_a_exists
    FROM public.residents WHERE lower(email) = lower(c_res_a_email);
  IF v_res_a_exists = 0 THEN
    INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
    VALUES (c_res_a_email, 'Bundled Test Resident A', 'B-1', c_test_legacy_prop, c_company, TRUE, 'active');
    RAISE NOTICE 'Created resident A: %', c_res_a_email;
  END IF;

  SELECT COUNT(*) INTO v_res_b_exists
    FROM public.residents WHERE lower(email) = lower(c_res_b_email);
  IF v_res_b_exists = 0 THEN
    INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
    VALUES (c_res_b_email, 'Bundled Test Resident B', 'B-1', c_test_legacy_prop, c_company, TRUE, 'active');
    RAISE NOTICE 'Created resident B: %', c_res_b_email;
  END IF;

  -- ── 5. Bundled space at Test Legacy Property ───────────────────────
  -- is_bundled=TRUE flag documents the multi-resident intent. Space_
  -- residents ties (below) are what actually make it multi-tied for
  -- the record_space_payment RPC's snapshot resolution.
  SELECT id INTO v_bundled_space_id
    FROM public.spaces
   WHERE company = c_company
     AND property = c_test_legacy_prop
     AND label = c_bundled_label
   LIMIT 1;
  IF v_bundled_space_id IS NULL THEN
    INSERT INTO public.spaces (company, property, label, type, is_active, is_bundled, created_by_email)
    VALUES (c_company, c_test_legacy_prop, c_bundled_label, 'regular', TRUE, TRUE, 'system_fixture_migration')
    RETURNING id INTO v_bundled_space_id;
    RAISE NOTICE 'Created bundled space at % (label B-1, id=%)', c_test_legacy_prop, v_bundled_space_id;
  ELSE
    RAISE NOTICE 'Bundled space already exists at % (id=%)', c_test_legacy_prop, v_bundled_space_id;
  END IF;

  -- ── 6. Tie both residents to the bundled space ─────────────────────
  -- space_residents PK is (space_id, resident_email) so re-inserts
  -- would fail — guard with EXISTS check.
  SELECT COUNT(*) INTO v_tie_a_exists
    FROM public.space_residents
   WHERE space_id = v_bundled_space_id
     AND lower(resident_email) = lower(c_res_a_email);
  IF v_tie_a_exists = 0 THEN
    INSERT INTO public.space_residents (space_id, resident_email, added_by_email)
    VALUES (v_bundled_space_id, lower(c_res_a_email), 'system_fixture_migration');
    RAISE NOTICE 'Tied resident A (%) to bundled space', c_res_a_email;
  END IF;
  SELECT COUNT(*) INTO v_tie_b_exists
    FROM public.space_residents
   WHERE space_id = v_bundled_space_id
     AND lower(resident_email) = lower(c_res_b_email);
  IF v_tie_b_exists = 0 THEN
    INSERT INTO public.space_residents (space_id, resident_email, added_by_email)
    VALUES (v_bundled_space_id, lower(c_res_b_email), 'system_fixture_migration');
    RAISE NOTICE 'Tied resident B (%) to bundled space', c_res_b_email;
  END IF;

  RAISE NOTICE 'Fixture expansion complete. Re-run 20260830_record_and_void_space_payment_rpcs_verification.sql to exercise VE4 + the new VE9 (2+ tie NULL snapshots).';
END $$;

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TEST_LEGACY_FIXTURE_EXPANSION',
  'multi',
  '20260831',
  jsonb_build_object(
    'migration',       '20260831_test_legacy_fixture_expansion',
    'purpose',         'Unblock VE4 (cross-property fixture) + multi-resident snapshot gate for space-payments RPC verification',
    'schema_changes',  jsonb_build_array(
      'ADDED public.properties row "Test VE4 Cross-Prop" (Test-LEGACY, NOT assigned to legacy-manager)',
      'ADDED 3 spaces: X-1 at Test VE4 Cross-Prop, AP2-1 at Alias Probe Two, TPD-1 at Test Property for Driver',
      'ADDED 2 test residents (test-legacy-bundled-a@..., test-legacy-bundled-b@...) at Test Legacy Property',
      'ADDED 1 bundled space (label B-1) at Test Legacy Property with 2 space_residents ties'
    ),
    'unblocks',        jsonb_build_array(
      'VE4 cross-property rejection test (previously FIXTURE FAIL)',
      'Multi-resident snapshot gate (2+ tie → NULL — previously deferred as "needs specific seed")'
    ),
    'idempotent',      TRUE,
    'safety_notes',    'Does NOT modify user_roles.property. The new property is unassigned; legacy-manager retains their existing 3-property assignment. Verified against Mateo Aug 30 F1.CROSSPROP data.'
  ),
  now()
);

COMMIT;
