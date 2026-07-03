-- ════════════════════════════════════════════════════════════════════
-- Slice 4 close-out — submit_plate_change collision guard
-- Locked: July 3, 2026
--
-- Enforcement-integrity gap Jose flagged: nothing validates the
-- incoming new_plate against existing authorized plates. A resident
-- could request a plate already active on another vehicle at the same
-- property → two vehicles authorized under one plate → ambiguous
-- driver plate-lookup ("which car is authorized under BBB5678?"). That
-- breaks the whole enforcement product's binary decision.
--
-- Fix: reject at RPC entry with error='plate_already_authorized'. The
-- client (resident/page.tsx::requestPlateChange) surfaces Jose's clean
-- message: "That plate is already authorized on another vehicle at
-- this property. Contact your manager."
--
-- Scope of the check (deliberate):
--   · Same property. Cross-property would be over-strict — a driver-
--     transferring-across-properties scenario is real. Matches the
--     property-scoped RLS pattern the rest of the enforcement product
--     already uses.
--   · Case-insensitive via upper(). Matches the case-sensitivity parity
--     idiom baked in during the RLS 57014 sweep.
--   · is_active=true AND status IN ('active','under_review') so that:
--       - Approved permits block (obvious)
--       - Under-review vehicles also block (a pending plate can't
--         double-book while the manager decides)
--       - Deactivated vehicles' plates remain reusable (aligns with
--         Slice 5 deactivate semantics — deactivated ≠ authorized)
--       - Declined vehicles' plates remain reusable
--   · Excludes the caller's OWN vehicle (id != p_vehicle_id) so the
--     current vehicle's own current plate doesn't trip the guard.
--
-- Also flagged (not in this migration — future hardening):
--   · Legacy vehicle-add paths (manager/page.tsx addVehicle at 1607 +
--     addResident cascade at 1724) have the same gap. Handled by the
--     shared helper in app/lib/plate.ts::assertPlateUniqueAtProperty
--     with client-side pre-check + the RPC guard here for the plate-
--     change path.
--   · A partial unique index on (upper(plate), property) WHERE is_active
--     + status-in would enforce the class DB-wide across every INSERT
--     path (including future ones), but existing data has one duplicate
--     (TEST1 at Bayou Heights — test data). Data-cleanup + index add
--     logged as slice-5-adjacent hardening.
--
-- No schema changes. Only submit_plate_change body updated.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_plate_change(
  p_vehicle_id BIGINT,
  p_new_plate  TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_vehicle      vehicles%ROWTYPE;
  v_new_plate    TEXT;
  v_change_id    BIGINT;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role <> 'resident' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  IF lower(coalesce(v_vehicle.resident_email, '')) <> v_caller_email THEN
    RETURN jsonb_build_object('error', 'not_vehicle_owner');
  END IF;

  -- One-pending check runs FIRST so a duplicate submit surfaces
  -- 'already_pending' (client special-case message).
  IF EXISTS (SELECT 1 FROM vehicle_plate_changes
             WHERE vehicle_id = p_vehicle_id AND status = 'pending') THEN
    RETURN jsonb_build_object('error', 'already_pending');
  END IF;

  IF v_vehicle.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'vehicle_not_active', 'hint', 'current_status:'||v_vehicle.status);
  END IF;

  v_new_plate := upper(regexp_replace(coalesce(p_new_plate, ''), '\s|-|\.', '', 'g'));
  IF length(v_new_plate) = 0 THEN
    RETURN jsonb_build_object('error', 'new_plate_required');
  END IF;
  IF length(v_new_plate) > 12 THEN
    RETURN jsonb_build_object('error', 'new_plate_too_long');
  END IF;
  IF v_new_plate = upper(coalesce(v_vehicle.plate, '')) THEN
    RETURN jsonb_build_object('error', 'new_plate_same_as_current');
  END IF;

  -- COLLISION GUARD (slice-4 close-out, Jose 2026-07-03).
  -- Enforcement-integrity: two vehicles authorized under one plate at
  -- one property = ambiguous lookup. Reject before any write.
  IF EXISTS (
    SELECT 1 FROM vehicles
    WHERE upper(plate) = v_new_plate
      AND is_active = true
      AND status IN ('active', 'under_review')
      AND property = v_vehicle.property
      AND id <> p_vehicle_id
  ) THEN
    RETURN jsonb_build_object('error', 'plate_already_authorized');
  END IF;

  INSERT INTO vehicle_plate_changes
    (vehicle_id, property, old_plate, new_plate, submitted_by, status)
  VALUES
    (p_vehicle_id, v_vehicle.property, v_vehicle.plate, v_new_plate, v_caller_email, 'pending')
  RETURNING id INTO v_change_id;

  UPDATE vehicles SET status = 'under_review' WHERE id = p_vehicle_id;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (v_caller_email, 'SUBMIT_PLATE_CHANGE', 'vehicle_plate_changes', v_change_id,
    jsonb_build_object(
      'vehicle_id', p_vehicle_id,
      'old_plate', v_vehicle.plate,
      'new_plate', v_new_plate,
      'property', v_vehicle.property
    ),
    now());

  RETURN jsonb_build_object('ok', true, 'change_id', v_change_id, 'old_plate', v_vehicle.plate, 'new_plate', v_new_plate);
END;
$func$;

COMMIT;
