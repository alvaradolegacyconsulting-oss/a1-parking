-- ══════════════════════════════════════════════════════════════════════
-- 20260912_record_vehicle_removal_link_pending_vehicles_verification.sql
--
-- EXECUTION gates, one per vehicle state, plus the precedence case.
--
-- ── 🔴 L5 NEEDS BOTH ROWS PRESENT ───────────────────────────────────
-- The precedence gate (active wins over pending for one plate) proves
-- NOTHING if the fixture seeds only one of them. It would pass by
-- default. L5 therefore seeds BOTH and asserts the link resolved to the
-- ACTIVE row's id specifically — not merely that something linked.
--
-- ── 🔴 L3 AND L4 ARE THE ONES THE OBVIOUS PREDICATE FAILS ───────────
-- `v.status IN ('active','pending')` passes L1, L2 and L5 and FAILS L4,
-- because deactivation leaves status='active' and only flips is_active
-- (app/lib/manager-crm-writes.ts:300). A gate set without L4 would have
-- greenlit the wrong predicate.
--
-- Every gate asserts the SPECIFIC id where one is expected, and NULL
-- where none is. "Something linked" is not the claim.
--
-- Seeds inside BEGIN/ROLLBACK; PASS row after the rollback. Fixture
-- columns for vehicles are (property, company) beyond the identity
-- pair — from PostgREST's `required` set, not memory.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $fixture$
DECLARE v_op_id BIGINT;
BEGIN
  INSERT INTO public.tow_operators (company, name, phone, created_by_email)
  VALUES ('Test-PM', 'LINK-PROBE TOWING', '713-555-0177', 'linkprobe@linkprobe.invalid')
  RETURNING id INTO v_op_id;
  PERFORM set_config('linkprobe.operator_id', v_op_id::text, true);

  -- One row per state. Distinct plates so each gate is unambiguous.
  INSERT INTO public.vehicles (plate, property, unit, company, state, make, model, color, status, is_active, resident_read)
  VALUES
    -- L1 active
    ('LINKACTIVE1',  'Test PM Property', '1A', 'Test-PM', 'TX', 'Toyota', 'Camry',   'Blue',  'active',   true,  false),
    -- L2 pending — the approval window, is_active FALSE by definition
    ('LINKPENDING1', 'Test PM Property', '2A', 'Test-PM', 'TX', 'Honda',  'Accord',  'Red',   'pending',  false, false),
    -- L3 declined
    ('LINKDECLINE1', 'Test PM Property', '3A', 'Test-PM', 'TX', 'Ford',   'Focus',   'Green', 'declined', false, false),
    -- L4 DEACTIVATED — status stays 'active', only is_active flips.
    --    This is the row v.status IN ('active','pending') would wrongly link.
    ('LINKDEACT1',   'Test PM Property', '4A', 'Test-PM', 'TX', 'Mazda',  'CX-5',    'Grey',  'active',   false, false);

  -- L5 precedence — BOTH rows for ONE plate. Seeding only one would make
  -- the gate pass by default and prove nothing about precedence.
  -- The pending row is inserted FIRST and is NEWER-by-nothing, so a
  -- predicate without ORDER BY could legitimately return either.
  INSERT INTO public.vehicles (plate, property, unit, company, state, make, model, color, status, is_active, resident_read)
  VALUES ('LINKBOTH1', 'Test PM Property', '5A', 'Test-PM', 'TX', 'Nissan', 'Altima', 'Black', 'pending', false, false);
  INSERT INTO public.vehicles (plate, property, unit, company, state, make, model, color, status, is_active, resident_read)
  VALUES ('LINKBOTH1', 'Test PM Property', '5B', 'Test-PM', 'TX', 'Subaru', 'Outback','White', 'active',  true,  false);
END $fixture$;


DO $gates$
DECLARE
  v_op      BIGINT := current_setting('linkprobe.operator_id')::BIGINT;
  v_res     JSONB;
  v_linked  BIGINT;
  v_make    TEXT;
  v_expect  BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"pm-manager@test.shieldmylot.com","role":"authenticated"}', true);

  -- ── L1 — ACTIVE links ───────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  v_res := public.record_vehicle_removal('Test PM Property', 'LINKACTIVE1', 'fire_lane', now(),
             'pm-manager@test.shieldmylot.com', v_op);
  RESET ROLE;
  SELECT linked_vehicle_id, make INTO v_linked, v_make
    FROM public.vehicle_removals WHERE id = (v_res ->> 'id')::BIGINT;
  SELECT id INTO v_expect FROM public.vehicles WHERE plate = 'LINKACTIVE1';
  IF v_linked IS DISTINCT FROM v_expect THEN
    RAISE EXCEPTION 'L1 FAIL: an ACTIVE vehicle did not link. linked_vehicle_id=% expected %.', COALESCE(v_linked::text,'NULL'), v_expect;
  END IF;
  IF v_make IS DISTINCT FROM 'Toyota' THEN
    RAISE EXCEPTION 'L1 FAIL: linked but the description did not copy (make=%).', COALESCE(v_make,'NULL');
  END IF;

  -- ── L2 — PENDING links. THE BUG THIS MIGRATION FIXES ────────────
  SET LOCAL ROLE authenticated;
  v_res := public.record_vehicle_removal('Test PM Property', 'LINKPENDING1', 'handicap_zone', now(),
             'pm-manager@test.shieldmylot.com', v_op);
  RESET ROLE;
  SELECT linked_vehicle_id, make INTO v_linked, v_make
    FROM public.vehicle_removals WHERE id = (v_res ->> 'id')::BIGINT;
  SELECT id INTO v_expect FROM public.vehicles WHERE plate = 'LINKPENDING1';
  IF v_linked IS DISTINCT FROM v_expect THEN
    RAISE EXCEPTION
      'L2 FAIL: a PENDING vehicle did not link (linked_vehicle_id=%, expected %). This is the reported bug: during the approval window a registered vehicle is invisible to the tow log, which is precisely when a Saturday-night tow happens.',
      COALESCE(v_linked::text,'NULL'), v_expect;
  END IF;
  IF v_make IS DISTINCT FROM 'Honda' THEN
    RAISE EXCEPTION 'L2 FAIL: pending row linked but its description did not copy (make=%).', COALESCE(v_make,'NULL');
  END IF;

  -- ── L3 — DECLINED must NOT link ─────────────────────────────────
  SET LOCAL ROLE authenticated;
  v_res := public.record_vehicle_removal('Test PM Property', 'LINKDECLINE1', 'tow_away_zone', now(),
             'pm-manager@test.shieldmylot.com', v_op);
  RESET ROLE;
  SELECT linked_vehicle_id, make INTO v_linked, v_make
    FROM public.vehicle_removals WHERE id = (v_res ->> 'id')::BIGINT;
  IF v_linked IS NOT NULL THEN
    RAISE EXCEPTION
      'L3 FAIL: a DECLINED vehicle linked (id=%, make copied=%). Linking to a vehicle a manager REJECTED is wrong in a more damaging direction than linking to nothing.',
      v_linked, COALESCE(v_make,'NULL');
  END IF;

  -- ── L4 — 🔴 DEACTIVATED must NOT link ───────────────────────────
  -- The gate the obvious predicate fails. This fixture row is the
  -- B166 OWNER-TRIM shape — status='active', is_active=false — because
  -- that path (manager-crm-writes.ts:299) flips only is_active.
  -- The OTHER shape, from the deactivate_vehicle RPC, is
  -- status='deactivated' and is excluded by the predicate trivially.
  -- This gate deliberately seeds the harder of the two: the one that
  -- still looks active by status alone.
  SET LOCAL ROLE authenticated;
  v_res := public.record_vehicle_removal('Test PM Property', 'LINKDEACT1', 'abandoned_vehicle', now(),
             'pm-manager@test.shieldmylot.com', v_op);
  RESET ROLE;
  SELECT linked_vehicle_id, make INTO v_linked, v_make
    FROM public.vehicle_removals WHERE id = (v_res ->> 'id')::BIGINT;
  IF v_linked IS NOT NULL THEN
    RAISE EXCEPTION
      'L4 FAIL: a DEACTIVATED vehicle linked (id=%, make copied=%). Its status is still ''active'' — deactivation only flips is_active (manager-crm-writes.ts:300). If the predicate was simplified to v.status IN (''active'',''pending''), this is the case it breaks, and L1/L2/L5 would all still be green.',
      v_linked, COALESCE(v_make,'NULL');
  END IF;

  -- ── L5 — PRECEDENCE. Both rows exist; ACTIVE must win ───────────
  SET LOCAL ROLE authenticated;
  v_res := public.record_vehicle_removal('Test PM Property', 'LINKBOTH1', 'reserved_parking', now(),
             'pm-manager@test.shieldmylot.com', v_op);
  RESET ROLE;
  SELECT linked_vehicle_id, make INTO v_linked, v_make
    FROM public.vehicle_removals WHERE id = (v_res ->> 'id')::BIGINT;

  -- Control: both rows must actually be present, or "active won" is
  -- vacuous — it would be the only candidate.
  IF (SELECT COUNT(*) FROM public.vehicles WHERE plate = 'LINKBOTH1') <> 2 THEN
    RAISE EXCEPTION 'L5 CONTROL FAILED: expected TWO LINKBOTH1 rows (one active, one pending); found %. Precedence cannot be tested with one candidate.',
      (SELECT COUNT(*) FROM public.vehicles WHERE plate = 'LINKBOTH1');
  END IF;

  SELECT id INTO v_expect FROM public.vehicles WHERE plate = 'LINKBOTH1' AND status = 'active';
  IF v_linked IS DISTINCT FROM v_expect THEN
    RAISE EXCEPTION
      'L5 FAIL: with both an active and a pending row for one plate, the link resolved to % (expected the ACTIVE row, id %). Without ORDER BY, LIMIT 1 picks arbitrarily — and arbitrarily can differ between runs on identical data. make copied = %.',
      COALESCE(v_linked::text,'NULL'), v_expect, COALESCE(v_make,'NULL');
  END IF;
  IF v_make IS DISTINCT FROM 'Subaru' THEN
    RAISE EXCEPTION 'L5 FAIL: linked to the active row but copied the wrong description (make=%, expected Subaru).', COALESCE(v_make,'NULL');
  END IF;
END $gates$;

ROLLBACK;


SELECT
  'PASS'::TEXT AS status,
  'record_vehicle_removal — soft link across vehicle states'::TEXT AS target,
  ARRAY[
    'L1  ACTIVE links, and the description copies',
    'L2  PENDING links — the reported bug: the approval window had no vehicle description at all',
    'L3  DECLINED does NOT link — rejecting is a decision, and linking to it is worse than linking to nothing',
    'L4  🔴 DEACTIVATED does NOT link. status stays ''active'' there, so this is the gate that v.status IN (''active'',''pending'') FAILS while L1/L2/L5 stay green',
    'L5  PRECEDENCE: both rows seeded for one plate, ACTIVE wins, with a control asserting BOTH are present — seeding one would pass by default',
    'DISCIPLINE: every gate asserts the SPECIFIC expected id, or NULL. "Something linked" is not the claim.'
  ] AS gates_verified,
  now() AS verified_at;
