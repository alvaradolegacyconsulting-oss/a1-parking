-- ══════════════════════════════════════════════════════════════════════
-- 20260912_record_vehicle_removal_link_vehicle_description_verification.sql
--
-- EXECUTION gates for the linked-vehicle description fill.
-- Written AFTER the migration applied (2026-09-12) — retroactive, and
-- the migration header says so rather than leaving it to be inferred.
--
-- ── 🔴 P1 IS WHY THIS FILE EXISTS ───────────────────────────────────
-- "Caller wins" is TRIVIALLY INVERTIBLE. Swap the two COALESCE
-- arguments and every column still gets filled — so a gate asserting
-- "make is not null" goes GREEN on the broken version, while a
-- possibly-stale registration silently overwrites what a manager typed
-- standing in front of the car. That is the feature damaging records
-- rather than completing them.
--
-- Nothing else in this file would catch that. P3 (link fills blanks)
-- passes either way. P4 and P5 never involve a link. Only P1 pins the
-- direction, and its failure message names the inversion explicitly
-- because someone will read a COALESCE argument swap as a tidy-up.
--
-- ── 🔴 P2 IS THE FIXTURE CONTROL, AND IT IS NOT OPTIONAL ────────────
-- "make came back NULL" reads as a clean no-link pass when the real
-- cause is a fixture whose plate never matched. Fourth instance of that
-- pattern this week — the % probe's skip, §2's silent DO block, E3's
-- empty WHERE, and the Group C test the role gate would have refused.
-- P2 asserts linked_vehicle_id ACTUALLY RESOLVED before any other gate
-- interprets a value.
--
-- ── FIXTURE ─────────────────────────────────────────────────────────
-- vehicles NOT NULL beyond the identity columns is (property, company)
-- — checked against PostgREST's OpenAPI `required` set, not remembered.
-- Twice this week a fixture broke on a table it only writes to
-- (properties.updated_at, spaces.label + created_by_email).
--
-- Seeds inside BEGIN/ROLLBACK; PASS row after the rollback.
-- Fixtures use the seeded Test-PM tenant, which is pm_only and so
-- passes my_tier_pm_capable().
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $fixture$
DECLARE v_op_id BIGINT;
BEGIN
  -- The vehicle the soft link should find. Known description values, all
  -- four distinct from anything a caller passes below.
  INSERT INTO public.vehicles (plate, property, unit, company, state, make, model, color, status, is_active, resident_read)
  VALUES ('DESCPROBE1', 'Test PM Property', '9Z', 'Test-PM', 'TX', 'Kia', 'Sorento', 'Silver', 'active', true, false);

  -- Operator inserted directly rather than via create_tow_operator, so
  -- this file does not depend on that RPC's tier/role gates to seed.
  INSERT INTO public.tow_operators (company, name, phone, created_by_email)
  VALUES ('Test-PM', 'DESC-PROBE TOWING', '713-555-0199', 'descprobe@descprobe.invalid')
  RETURNING id INTO v_op_id;
  PERFORM set_config('descprobe.operator_id', v_op_id::text, true);
END $fixture$;


-- ══════════════════════════════════════════════════════════════════════
-- P1 + P2 — CALLER WINS, and the link actually resolved.
--   Link says Kia / Sorento / Silver / TX. Caller passes Toyota.
--   Stored make must be TOYOTA, and the other three must come from the
--   link — proving the fallback works WITHOUT it overriding a typed
--   value.
-- ══════════════════════════════════════════════════════════════════════
DO $p1_p2$
DECLARE
  v_result JSONB;
  v_row    public.vehicle_removals%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_result := public.record_vehicle_removal(
    p_property            := 'Test PM Property',
    p_plate               := 'DESCPROBE1',
    p_reason_code         := 'fire_lane',
    p_towed_at            := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id     := current_setting('descprobe.operator_id')::BIGINT,
    p_make                := 'Toyota'
  );
  RESET ROLE;

  IF (v_result ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'P1 FAIL: the RPC refused the call: %', v_result;
  END IF;
  SELECT * INTO v_row FROM public.vehicle_removals WHERE id = (v_result ->> 'id')::BIGINT;

  -- P2 — the control. Everything below is meaningless without it.
  IF v_row.linked_vehicle_id IS NULL THEN
    RAISE EXCEPTION
      'P2 CONTROL FAILED: linked_vehicle_id is NULL, so the soft link never resolved and the fixture plate did not match. Every description assertion below would then be testing the NO-LINK path while claiming to test the link — "make came back NULL" would read as a pass.';
  END IF;

  -- P1 — the load-bearing assertion.
  IF v_row.make IS DISTINCT FROM 'Toyota' THEN
    RAISE EXCEPTION
      'P1 FAIL: caller passed make=''Toyota'' and the stored value is ''%''. If it is ''Kia'' the COALESCE arguments are INVERTED — the linked vehicle is overwriting what the manager typed. That is not a cosmetic regression: the person standing in front of the car is better evidence than a registration that may be stale, and a gate asserting only "make is not null" would have passed on this. Do not "tidy" the COALESCE argument order.',
      COALESCE(v_row.make, 'NULL');
  END IF;

  -- The three the caller omitted must come FROM the link — proving the
  -- fallback is live in the same call that proves it does not override.
  IF v_row.model IS DISTINCT FROM 'Sorento'
     OR v_row.color IS DISTINCT FROM 'Silver'
     OR v_row.plate_state IS DISTINCT FROM 'TX' THEN
    RAISE EXCEPTION
      'P1 FAIL: omitted fields did not come from the linked vehicle — model=%, color=%, state=% (expected Sorento / Silver / TX). Caller-wins must not have disabled the fallback entirely.',
      COALESCE(v_row.model, 'NULL'), COALESCE(v_row.color, 'NULL'), COALESCE(v_row.plate_state, 'NULL');
  END IF;
END $p1_p2$;


-- ══════════════════════════════════════════════════════════════════════
-- P3 — link resolves, caller omits ALL four → all four filled.
-- ══════════════════════════════════════════════════════════════════════
DO $p3$
DECLARE
  v_result JSONB;
  v_row    public.vehicle_removals%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_result := public.record_vehicle_removal(
    p_property            := 'Test PM Property',
    p_plate               := 'DESC-PROBE-1',   -- punctuated: also re-proves the 09-10 normalization
    p_reason_code         := 'handicap_zone',
    p_towed_at            := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id     := current_setting('descprobe.operator_id')::BIGINT
  );
  RESET ROLE;

  IF (v_result ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'P3 FAIL: the RPC refused the call: %', v_result;
  END IF;
  SELECT * INTO v_row FROM public.vehicle_removals WHERE id = (v_result ->> 'id')::BIGINT;

  IF v_row.linked_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'P3 CONTROL FAILED: the punctuated plate DESC-PROBE-1 did not link to DESCPROBE1. Either the fixture is wrong or the 2026-09-10 plate normalization regressed.';
  END IF;
  IF v_row.make IS DISTINCT FROM 'Kia' OR v_row.model IS DISTINCT FROM 'Sorento'
     OR v_row.color IS DISTINCT FROM 'Silver' OR v_row.plate_state IS DISTINCT FROM 'TX' THEN
    RAISE EXCEPTION
      'P3 FAIL: caller omitted all four and the row holds make=%, model=%, color=%, state=% (expected Kia / Sorento / Silver / TX). The whole point of the change is that these stop being empty.',
      COALESCE(v_row.make,'NULL'), COALESCE(v_row.model,'NULL'), COALESCE(v_row.color,'NULL'), COALESCE(v_row.plate_state,'NULL');
  END IF;
END $p3$;


-- ══════════════════════════════════════════════════════════════════════
-- P4 + P5 — THE WALK-IN CASE. No link.
--   P4: caller supplies all four → stored as given, linked NULL.
--   P5: caller omits all four → all NULL and NO ERROR. A walk-in is the
--       scenario the feature exists for; it is normal, not a failure.
-- ══════════════════════════════════════════════════════════════════════
DO $p4_p5$
DECLARE
  v_r4 JSONB; v_r5 JSONB;
  v_row4 public.vehicle_removals%ROWTYPE;
  v_row5 public.vehicle_removals%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_r4 := public.record_vehicle_removal(
    p_property := 'Test PM Property', p_plate := 'NOLINKPROBE9',
    p_reason_code := 'no_parking_zone', p_towed_at := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id := current_setting('descprobe.operator_id')::BIGINT,
    p_plate_state := 'OK', p_make := 'Honda', p_model := 'Civic', p_color := 'Blue');
  v_r5 := public.record_vehicle_removal(
    p_property := 'Test PM Property', p_plate := 'NOLINKPROBE8',
    p_reason_code := 'no_parking_zone', p_towed_at := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id := current_setting('descprobe.operator_id')::BIGINT);
  RESET ROLE;

  IF (v_r4 ->> 'ok')::BOOLEAN IS NOT TRUE THEN RAISE EXCEPTION 'P4 FAIL: RPC refused: %', v_r4; END IF;
  IF (v_r5 ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'P5 FAIL: a walk-in with NO description was REFUSED (%). That is the scenario the feature exists for — it must be accepted, not treated as incomplete.', v_r5;
  END IF;

  SELECT * INTO v_row4 FROM public.vehicle_removals WHERE id = (v_r4 ->> 'id')::BIGINT;
  SELECT * INTO v_row5 FROM public.vehicle_removals WHERE id = (v_r5 ->> 'id')::BIGINT;

  IF v_row4.linked_vehicle_id IS NOT NULL THEN
    RAISE EXCEPTION 'P4 CONTROL FAILED: NOLINKPROBE9 linked to vehicle id %. It was supposed to match nothing, so this gate is not testing the no-link path at all.', v_row4.linked_vehicle_id;
  END IF;
  IF v_row4.make IS DISTINCT FROM 'Honda' OR v_row4.model IS DISTINCT FROM 'Civic'
     OR v_row4.color IS DISTINCT FROM 'Blue' OR v_row4.plate_state IS DISTINCT FROM 'OK' THEN
    RAISE EXCEPTION 'P4 FAIL: with no link the typed values must be stored verbatim; got make=%, model=%, color=%, state=%.',
      COALESCE(v_row4.make,'NULL'), COALESCE(v_row4.model,'NULL'), COALESCE(v_row4.color,'NULL'), COALESCE(v_row4.plate_state,'NULL');
  END IF;
  IF v_row5.make IS NOT NULL OR v_row5.model IS NOT NULL
     OR v_row5.color IS NOT NULL OR v_row5.plate_state IS NOT NULL THEN
    RAISE EXCEPTION 'P5 FAIL: nothing was supplied and nothing should have been invented; got make=%, model=%, color=%, state=%.',
      COALESCE(v_row5.make,'NULL'), COALESCE(v_row5.model,'NULL'), COALESCE(v_row5.color,'NULL'), COALESCE(v_row5.plate_state,'NULL');
  END IF;
END $p4_p5$;


-- ══════════════════════════════════════════════════════════════════════
-- P6 — WHITESPACE FALLS THROUGH TO THE LINK.
--   '   ' is not a value. NULLIF(trim(...)) is what makes that true; a
--   bare COALESCE would store three spaces and call the column filled.
--   Exactly the kind of thing a later "simplification" removes.
-- ══════════════════════════════════════════════════════════════════════
DO $p6$
DECLARE
  v_result JSONB;
  v_row    public.vehicle_removals%ROWTYPE;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_result := public.record_vehicle_removal(
    p_property := 'Test PM Property', p_plate := 'DESCPROBE1',
    p_reason_code := 'reserved_parking', p_towed_at := now(),
    p_authorized_by_email := 'pm-manager@test.shieldmylot.com',
    p_tow_operator_id := current_setting('descprobe.operator_id')::BIGINT,
    p_make := '   ');
  RESET ROLE;

  SELECT * INTO v_row FROM public.vehicle_removals WHERE id = (v_result ->> 'id')::BIGINT;
  IF v_row.make IS DISTINCT FROM 'Kia' THEN
    RAISE EXCEPTION
      'P6 FAIL: caller passed three spaces for make and the row holds ''%'' (expected Kia from the link). NULLIF(trim(...)) is doing the work here — a bare COALESCE stores whitespace and reports the column as filled.',
      COALESCE(v_row.make, 'NULL');
  END IF;
END $p6$;


-- ══════════════════════════════════════════════════════════════════════
-- P7 — vehicle_desc_source is written, both ways.
--   An audit field nobody asserts is one that quietly stops being
--   written. This is what makes a blank column attributable in six
--   months rather than guessed at.
-- ══════════════════════════════════════════════════════════════════════
DO $p7$
DECLARE
  v_linked   INT;
  v_unlinked INT;
BEGIN
  SELECT COUNT(*) INTO v_linked
    FROM public.audit_logs
   WHERE action = 'VEHICLE_REMOVAL_RECORDED'
     AND new_values ->> 'vehicle_desc_source' = 'caller_then_linked_vehicle';
  SELECT COUNT(*) INTO v_unlinked
    FROM public.audit_logs
   WHERE action = 'VEHICLE_REMOVAL_RECORDED'
     AND new_values ->> 'vehicle_desc_source' = 'caller_only';

  IF v_linked < 1 THEN
    RAISE EXCEPTION 'P7 FAIL: no audit row carries vehicle_desc_source=caller_then_linked_vehicle, though P1/P3/P6 all linked.';
  END IF;
  IF v_unlinked < 1 THEN
    RAISE EXCEPTION 'P7 FAIL: no audit row carries vehicle_desc_source=caller_only, though P4/P5 both had no link.';
  END IF;
END $p7$;

ROLLBACK;


SELECT
  'PASS'::TEXT AS status,
  'record_vehicle_removal — linked-vehicle description fill'::TEXT AS target,
  ARRAY[
    'P1  CALLER WINS: caller make=Toyota beats link make=Kia, and the three omitted fields still come from the link',
    'P2  CONTROL: linked_vehicle_id actually resolved — without it every description assertion tests the no-link path while claiming otherwise',
    'P3  link resolves + caller omits all four -> all four filled (via a PUNCTUATED plate, re-proving the 09-10 normalization)',
    'P4  no link + caller supplies -> stored verbatim, linked_vehicle_id NULL (with its own control that the plate really did not match)',
    'P5  no link + caller omits -> all four NULL and NO ERROR. A walk-in is the scenario the feature exists for',
    'P6  whitespace falls through to the link — NULLIF(trim(...)) not a bare COALESCE',
    'P7  vehicle_desc_source written both ways (caller_then_linked_vehicle / caller_only)',
    'DISCIPLINE: P1 exists because caller-wins is trivially invertible — swap the COALESCE arguments and every "is not null" gate still passes while a stale registration overwrites what the manager typed.'
  ] AS gates_verified,
  now() AS verified_at;
