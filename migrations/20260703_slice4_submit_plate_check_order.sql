-- ════════════════════════════════════════════════════════════════════
-- Slice 4 — reorder submit_plate_change status checks
-- Locked: July 3, 2026
--
-- Caught by scripts/probe-crm-slice4-plate-roundtrip.ts [5]:
-- When a second submit fires while the first is still pending, the
-- vehicle's status is 'under_review' (set by the first submit), so the
-- original RPC hit the `IF v_vehicle.status <> 'active'` guard first
-- and returned 'vehicle_not_active' instead of 'already_pending'. The
-- client (resident/page.tsx) has a special case for 'already_pending'
-- that surfaces Jose's specced clean message ("You already have a
-- plate change under review..."); the vehicle_not_active fallthrough
-- shows a raw error string.
--
-- Fix: move the one-pending pre-check BEFORE the vehicle-not-active
-- guard. Same semantics (both would block); different error surfaced.
--
-- No policy / schema changes. RPC body only.
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

  -- CHANGE-ORDER: check one-pending FIRST so a duplicate submit while
  -- one is pending returns 'already_pending' (not 'vehicle_not_active').
  -- The vehicle's status is 'under_review' while a pending change exists,
  -- and the previous ordering surfaced the less-useful error.
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
