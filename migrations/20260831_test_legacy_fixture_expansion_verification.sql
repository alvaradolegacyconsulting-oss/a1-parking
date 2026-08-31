-- ══════════════════════════════════════════════════════════════════════
-- 20260831_test_legacy_fixture_expansion_verification.sql
--
-- Paired verification for 20260831_test_legacy_fixture_expansion.
-- v2 pattern: no BEGIN/COMMIT wrap; terminal SELECT returns PASS row.
--
-- ── 6 GATES ─────────────────────────────────────────────────────────
--   VF1  4th Test-LEGACY property "Test VE4 Cross-Prop" exists
--   VF2  Cross-prop property NOT assigned to legacy-manager
--        (the whole point of the fixture — verify it stayed unassigned)
--   VF3  Cross-prop has ≥1 active space (VE4 target exists)
--   VF4  Alias Probe Two + Test Property for Driver each have ≥1 space
--   VF5  Bundled space "B-1" at Test Legacy Property has exactly 2
--        active tied residents (multi-resident snapshot gate target)
--   VF6  Schema audit row present
-- ══════════════════════════════════════════════════════════════════════

-- ── VF1: cross-prop property exists ─────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.properties
   WHERE name = 'Test VE4 Cross-Prop'
     AND company = 'Test-LEGACY';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VF1 FAIL: property "Test VE4 Cross-Prop" at Test-LEGACY not present (count=%). Fixture migration did not run.', v_count;
  END IF;
END $$;

-- ── VF2: 🔴 cross-prop NOT in any legacy-manager assignment ─────────
-- The whole point of the fixture is a Test-LEGACY property no
-- Test-LEGACY manager has in their scope. If ANY manager is assigned,
-- VE4's cross-property test would find a manager who CAN see the space,
-- and cross-property scoping goes untested again.
DO $$
DECLARE v_offenders TEXT;
BEGIN
  SELECT string_agg(email, ', ') INTO v_offenders
    FROM public.user_roles
   WHERE company ~~* 'Test-LEGACY'
     AND role = 'manager'
     AND 'Test VE4 Cross-Prop' = ANY (property);
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'VF2 FAIL: Test-LEGACY manager(s) [%] are assigned to Test VE4 Cross-Prop. This defeats VE4''s cross-property fixture. Remove the assignment from those managers or pick a different property.', v_offenders;
  END IF;
END $$;

-- ── VF3: cross-prop has ≥1 active space ────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.spaces
   WHERE company = 'Test-LEGACY'
     AND property = 'Test VE4 Cross-Prop'
     AND is_active = TRUE;
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VF3 FAIL: no active space at Test VE4 Cross-Prop (count=%). VE4 has no target.', v_count;
  END IF;
END $$;

-- ── VF4: currently-empty properties each have ≥1 space ─────────────
DO $$
DECLARE v_ap2 INT; v_tpd INT;
BEGIN
  SELECT COUNT(*) INTO v_ap2 FROM public.spaces
   WHERE company = 'Test-LEGACY' AND property = 'Alias Probe Two' AND is_active = TRUE;
  SELECT COUNT(*) INTO v_tpd FROM public.spaces
   WHERE company = 'Test-LEGACY' AND property = 'Test Property for Driver' AND is_active = TRUE;
  IF v_ap2 < 1 THEN
    RAISE EXCEPTION 'VF4 FAIL: no active space at Alias Probe Two (count=%)', v_ap2;
  END IF;
  IF v_tpd < 1 THEN
    RAISE EXCEPTION 'VF4 FAIL: no active space at Test Property for Driver (count=%)', v_tpd;
  END IF;
END $$;

-- ── VF5: bundled space B-1 has exactly 2 active tied residents ─────
DO $$
DECLARE v_space_id BIGINT; v_ties INT;
BEGIN
  SELECT id INTO v_space_id
    FROM public.spaces
   WHERE company = 'Test-LEGACY'
     AND property = 'Test Legacy Property'
     AND label = 'B-1';
  IF v_space_id IS NULL THEN
    RAISE EXCEPTION 'VF5 FAIL: bundled space B-1 at Test Legacy Property not found';
  END IF;
  SELECT COUNT(*) INTO v_ties
    FROM public.space_residents sr
    JOIN public.residents r ON lower(r.email) = lower(sr.resident_email)
   WHERE sr.space_id = v_space_id
     AND r.is_active;
  IF v_ties <> 2 THEN
    RAISE EXCEPTION 'VF5 FAIL: bundled space B-1 has % active tied residents (want exactly 2). Multi-resident snapshot gate needs 2 to test the NULL-on-ambiguity behavior.', v_ties;
  END IF;
END $$;

-- ── VF6: schema audit row present ──────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TEST_LEGACY_FIXTURE_EXPANSION'
     AND new_values->>'migration' = '20260831_test_legacy_fixture_expansion';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VF6 FAIL: SCHEMA_TEST_LEGACY_FIXTURE_EXPANSION audit row missing';
  END IF;
END $$;

-- ── FINAL: one PASS row ─────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'Test-LEGACY fixture expansion'::TEXT AS target,
  ARRAY[
    'VF1  Test VE4 Cross-Prop property exists',
    'VF2  Cross-prop NOT assigned to any Test-LEGACY manager',
    'VF3  Cross-prop has active space (VE4 target)',
    'VF4  Alias Probe Two + Test Property for Driver each have active space',
    'VF5  Bundled B-1 space at Test Legacy Property has exactly 2 active tied residents',
    'VF6  SCHEMA_TEST_LEGACY_FIXTURE_EXPANSION audit row present'
  ] AS gates_verified,
  'After PASS, re-run 20260830_record_and_void_space_payment_rpcs_verification.sql — VE4 and the new VE9 will execute for real.'::TEXT AS next_step,
  now() AS verified_at;
