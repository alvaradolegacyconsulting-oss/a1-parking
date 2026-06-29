-- ════════════════════════════════════════════════════════════════════
-- Permit-Door Piece 3 Item 1 — pm_plate_lookup STABLE → VOLATILE
-- 2026-06-28
-- ════════════════════════════════════════════════════════════════════
--
-- BUG
--   B220's pm_plate_lookup() RPC was declared STABLE
--   (20260626_b220_pm_plate_lookup_guest_auth_stage.sql:90) but the
--   body has an INSERT INTO audit_logs at every successful lookup.
--   Postgres forbids writes in non-VOLATILE functions:
--     "INSERT is not allowed in a non-volatile function"
--   Net effect: every manager-portal Plate Lookup ERRORs in the UI;
--   the audit row never lands. Driver path uses direct queries (not
--   this RPC) so it's unaffected — masking the bug.
--
-- FIX
--   CREATE OR REPLACE with the SAME signature, SAME body, only the
--   volatility keyword changed: STABLE → VOLATILE. Function is a
--   writer (audit-on-lookup) so VOLATILE is the honest declaration;
--   STABLE was a mis-declaration at B220 ship.
--
-- INVARIANTS PRESERVED
--   1. Signature unchanged (TEXT) → jsonb — no overload trap, no
--      pg_proc duplicate; existing GRANT EXECUTE survives intact
--      (CREATE OR REPLACE preserves grants when signature matches).
--   2. SECURITY DEFINER + search_path SET preserved.
--   3. Role gate {manager, leasing_agent} preserved.
--   4. Property scope get_my_properties() ILIKE ANY preserved.
--   5. Stage cascade (resident → guest_auth → visitor → unauthorized)
--      preserved verbatim from B220.
--   6. Audit row written every lookup — that's the line that REQUIRES
--      VOLATILE to actually execute.
--
-- VERIFICATION
--   Sibling file 20260628_pm_plate_lookup_volatile_fix_verification.sql
--   - §1 provolatile = 'v' (was 's')
--   - §2 pg_proc count for pm_plate_lookup = 1 (no overload)
--   - §3 grants intact (authenticated has EXECUTE; anon does NOT)
--   - §4 behavioral smoke: function runs without P0050
--   - §5 audit row landed
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE                  -- B220 mis-declared as STABLE; body writes audit_logs
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_role           TEXT;
  v_properties     TEXT[];
  v_normalized     TEXT;
  v_vehicle_unit   TEXT;
  v_visitor_unit   TEXT;
  v_guest_name     TEXT;
  v_guest_unit     TEXT;
  v_guest_end      DATE;
  v_result_type    TEXT;
  v_unit_number    TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Resident match ─────────────────────────────────────────────
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
    -- ── 2. Guest authorization match (B220 stage 2.5) ───────────────
    SELECT
      ga.guest_name,
      ga.visiting_unit,
      ga.end_date
    INTO
      v_guest_name,
      v_guest_unit,
      v_guest_end
    FROM guest_authorizations ga
    WHERE upper(regexp_replace(ga.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND ga.is_active = TRUE
      AND ga.status = 'active'
      AND ga.start_date <= CURRENT_DATE
      AND ga.end_date   >= CURRENT_DATE
      AND ga.property ILIKE ANY (v_properties)
    ORDER BY ga.end_date DESC
    LIMIT 1;

    IF v_guest_unit IS NOT NULL THEN
      v_result_type := 'guest_authorized';
      v_unit_number := v_guest_unit;
    ELSE
      -- ── 3. Visitor pass match ────────────────────────────────────
      SELECT vp.visiting_unit INTO v_visitor_unit
      FROM visitor_passes vp
      WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vp.is_active = TRUE
        AND vp.expires_at > now()
        AND vp.property ILIKE ANY (v_properties)
      LIMIT 1;

      IF FOUND THEN
        v_result_type := 'visitor';
        v_unit_number := v_visitor_unit;
      ELSE
        v_result_type := 'unauthorized';
        v_unit_number := NULL;
      END IF;
    END IF;
  END IF;

  -- ── 4. Audit write (requires VOLATILE — this was the bug) ────────
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_searched',  to_jsonb(v_properties)
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',   v_result_type,
    'unit_number',   v_unit_number,
    'guest_name',    v_guest_name,
    'valid_through', v_guest_end
  );
END;
$func$;

-- Migration audit row
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'pm_plate_lookup',
  NULL,
  jsonb_build_object(
    'rpc',        'pm_plate_lookup',
    'migration',  '20260628_pm_plate_lookup_volatile_fix',
    'change',     'STABLE → VOLATILE; body unchanged from B220 ship',
    'bug',        'B220-ship-defect — STABLE forbids INSERT (audit row); every lookup raised P0050 and audit row was lost',
    'invariant',  'signature unchanged (TEXT → jsonb); role gate, property scope, stage cascade, audit shape all preserved'
  ),
  now()
);

COMMIT;
