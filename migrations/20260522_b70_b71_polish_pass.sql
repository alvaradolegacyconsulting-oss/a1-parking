-- ════════════════════════════════════════════════════════════════════
-- B70 + B71 polish pass — pm_plate_lookup RPC + violations decline-reason cols
-- Drafted: May 22, 2026 — NOT YET APPLIED.
--
-- Two unrelated features bundled into one migration (combined commit
-- per Jose's sequencing call):
--   PART 1 (B70) — SECURITY DEFINER RPC pm_plate_lookup() for manager
--     + leasing_agent plate search. Server-enforced property scoping +
--     atomic audit write inside the function. Returns deliberately
--     narrow shape (result_type + unit_number) — no full vehicle or
--     visitor_pass rows. Path C from pre-flight (RPC over RLS-on-hot-
--     tables, which is filed as B74).
--   PART 2 (B71) — three new columns on violations to capture the
--     decline-and-proceed case where a driver overrides an authorized
--     plate to log a location/manner violation. Backfills existing
--     rows to was_authorized_at_time=false; new columns nullable
--     otherwise.
--
-- Idempotent re-apply: CREATE OR REPLACE FUNCTION + ADD COLUMN IF NOT
-- EXISTS + DO-block CHECK-constraint guard.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — B70: pm_plate_lookup() SECURITY DEFINER RPC
-- ════════════════════════════════════════════════════════════════════
-- Called by /manager → Plate Lookup tab. Anonymous-callable NOT GRANTED
-- (auth required). Caller's role is checked inside the function —
-- non-managers/non-leasing-agents raise rather than silently return
-- empty (clearer error than confused "everything unauthorized" output).
--
-- Scoping: get_my_properties() returns the caller's user_roles.property
-- array. Both lookups (vehicles + visitor_passes) filter by this array.
-- The function is SECURITY DEFINER so it bypasses any RLS that may
-- exist on those tables today (currently none on vehicles or
-- visitor_passes — see B74 follow-up). Scoping is enforced exclusively
-- via the WHERE clause here.
--
-- Audit write: one row per lookup regardless of result. user_email
-- resolved from auth.jwt() (same pattern as get_my_properties()).
-- Action string is lowercase 'plate_lookup' to match the CA-track
-- audit convention (separately tracked for harmonization in B60).
-- new_values JSONB carries normalized_plate + result_type + property
-- list — the property list is what was searched, not what matched
-- (matched property is implicit in result_type='resident' or 'visitor').

CREATE OR REPLACE FUNCTION pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_email   TEXT;
  v_role           TEXT;
  v_properties     TEXT[];
  v_normalized     TEXT;
  v_vehicle_unit   TEXT;
  v_visitor_unit   TEXT;
  v_result_type    TEXT;
  v_unit_number    TEXT;
BEGIN
  -- ── Auth + role gate ────────────────────────────────────────────
  v_caller_email := auth.jwt()->>'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    -- company_admin + admin have their own surfaces (CA portal plate
    -- scan, admin sees everything). Enforcement-track drivers have AI
    -- scan. Anyone else is intentionally excluded — RAISE rather than
    -- silently return so callers get a clean error.
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Input sanity + normalization ────────────────────────────────
  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  -- Match the normalization the rest of the codebase uses
  -- (app/lib/plate.ts normalizePlate): strip non-alphanumeric +
  -- uppercase. abc-123 / ABC 123 / abc123 all collapse to ABC123.
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Resident match (active vehicle, caller's property scope) ──
  -- vehicles.plate is stored normalized post-B30 era but legacy rows
  -- may exist with dashes/spaces. Normalize both sides for the match.
  SELECT v.unit INTO v_vehicle_unit
  FROM vehicles v
  WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
    AND v.is_active = TRUE
    AND v.property ILIKE ANY (v_properties)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 2. Visitor pass match (active pass, caller's property) ─────
    SELECT vp.visiting_unit INTO v_visitor_unit
    FROM visitor_passes vp
    WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND vp.is_active = TRUE
      AND vp.expires_at > now()
      AND vp.property ILIKE ANY (v_properties)
    LIMIT 1;

    IF FOUND THEN
      v_result_type := 'visitor';
      v_unit_number := v_visitor_unit;  -- may be NULL — graceful omission per spec
    ELSE
      v_result_type := 'unauthorized';
      v_unit_number := NULL;
    END IF;
  END IF;

  -- ── 3. Audit write (every lookup, regardless of result) ──────────
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',     -- nominal target; actual scope spans vehicles + visitor_passes
    jsonb_build_object(
      'normalized_plate', v_normalized,
      'result_type', v_result_type,
      'properties_searched', to_jsonb(v_properties)
    ),
    now()
  );

  -- ── 4. Return minimum-leak result ────────────────────────────────
  -- Deliberately narrow shape. NO full row data — the API contract
  -- itself enforces "no PII leakage" rather than relying on the
  -- frontend to filter.
  RETURN jsonb_build_object(
    'result_type', v_result_type,
    'unit_number', v_unit_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION pm_plate_lookup(TEXT) TO authenticated;
-- Deliberately NOT granted to anon.

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — B71: violations decline-reason columns
-- ════════════════════════════════════════════════════════════════════
-- Three new columns to capture the decline-and-proceed case where a
-- driver overrides an authorized plate to log a location/manner
-- violation. Existing rows backfill to was_authorized_at_time=false
-- (we have no way to know retroactively whether a vehicle was
-- authorized at the moment of submission, so the conservative answer
-- is "no"). decline_reason and decline_reason_note are nullable —
-- they're populated only when was_authorized_at_time=true.
--
-- Enum convention matches existing schema: TEXT + CHECK constraint
-- (see proposal_codes.status, companies.account_state). No CREATE
-- TYPE ... AS ENUM; that pattern isn't used elsewhere in this codebase
-- and would create a separate migration path for value additions.

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS was_authorized_at_time BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS decline_reason TEXT;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS decline_reason_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'violations_decline_reason_valid'
  ) THEN
    ALTER TABLE violations
      ADD CONSTRAINT violations_decline_reason_valid
      CHECK (decline_reason IS NULL OR decline_reason IN (
        'fire_lane',
        'handicap_violation',
        'blocked_access',
        'reserved_space',
        'double_parked',
        'other'
      ));
  END IF;
END $$;

-- Sanity invariant: decline_reason should only be populated when
-- was_authorized_at_time=true. We don't enforce this with a CHECK
-- because the column-level constraint is awkward to write and the
-- application layer enforces it cleanly via the modal flow. If a
-- future audit shows drift, add a CHECK then.

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
--
-- ── A. pm_plate_lookup() function exists + signature is correct ────
--   SELECT proname, pg_get_function_arguments(oid), prosecdef, provolatile
--   FROM pg_proc
--   WHERE proname = 'pm_plate_lookup';
--   -- Expected: 1 row · args = 'p_plate text' · prosecdef=t · provolatile=v
--
-- ── B. EXECUTE grant present ────────────────────────────────────────
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_name = 'pm_plate_lookup';
--   -- Expected: 1 row · grantee='authenticated' · privilege_type='EXECUTE'
--
-- ── C. violations new columns present + CHECK ──────────────────────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'violations'
--     AND column_name IN ('was_authorized_at_time','decline_reason','decline_reason_note')
--   ORDER BY column_name;
--   -- Expected 3 rows:
--   --   decline_reason          text     (null)        YES
--   --   decline_reason_note     text     (null)        YES
--   --   was_authorized_at_time  boolean  false         NO
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'violations_decline_reason_valid';
--   -- Expected: CHECK with the 6-value IN list.
--
-- ── D. Backfill sanity ──────────────────────────────────────────────
--   SELECT was_authorized_at_time, COUNT(*) FROM violations
--   GROUP BY was_authorized_at_time;
--   -- Expected: all existing rows = false. No nulls (NOT NULL DEFAULT FALSE).
--
-- ── E. pm_plate_lookup smoke (run as a real manager session) ───────
--   -- As an authenticated manager/leasing_agent with at least one
--   -- assigned property:
--   SELECT pm_plate_lookup('TEST-PLATE');
--   -- Expected: returns jsonb { result_type, unit_number }. Audit_logs
--   -- has one new row with action='plate_lookup', new_values.normalized_plate,
--   -- new_values.result_type, new_values.properties_searched.
--
--   -- Calling as admin or company_admin should raise:
--   --   'role admin not permitted for pm_plate_lookup'
--   -- Calling as a manager with no assigned properties should raise:
--   --   'caller has no assigned properties'
--   -- Empty/whitespace plate should raise:
--   --   'plate required' or 'plate empty after normalization'
-- ════════════════════════════════════════════════════════════════════
