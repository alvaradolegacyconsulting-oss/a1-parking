-- ════════════════════════════════════════════════════════════════════
-- Plate-normalization hardening — server-side authoritative
-- Locked: July 3, 2026
--
-- Trigger: Jose surfaced that resident plate-change prompt accepts
-- whitespace (leading/trailing/internal, e.g. "adfa agd"). Whitespace
-- defeats the upper(plate) collision guard + the just-shipped
-- vehicles_authorized_plate_uidx (space survives upper()), and breaks
-- scan matching in the unsafe direction (authorized car → not-found →
-- towable).
--
-- Fix: single IMMUTABLE server-side normalizer, applied at write
-- chokepoint (submit_plate_change) and re-keyed into the partial unique
-- index so no INSERT/UPDATE path can smuggle whitespace in.
--
-- SCOPE GUARD (Jose 2026-07-03): whitespace only. NOT dashes / dots /
-- other punctuation. Some states use dashes; stripping could merge
-- genuinely-distinct plates. Broader canonicalization is a separate
-- decision with its own risk analysis.
--
-- Live data audit (pre-migration probe): 0 vehicles rows carry
-- whitespace in plate today. Index re-key is safe without dedupe.
--
-- Scan-match path status:
--   · driver/page.tsx client already strips whitespace from scanned
--     input before .ilike('plate', clean). Since stored plates are
--     currently whitespace-free, no scan-match gap TODAY. Future write
--     paths that skip normalization would create one — this migration
--     closes that class at the DB level.
--   · pm_plate_lookup uses [^A-Za-z0-9] normalization on both sides
--     (broader than this scope guard). Not touched here — logged as a
--     coordinated narrowing follow-up (would need driver-scan +
--     pm_plate_lookup + client normalizePlate updated together to keep
--     matching consistent).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Shared normalizer function ────────────────────────────────
-- IMMUTABLE so it can back the partial unique index. \s + g strips
-- ALL whitespace (leading, trailing, internal, tabs, newlines).
-- upper() canonicalizes case. No punctuation stripped — per scope
-- guard.
CREATE OR REPLACE FUNCTION public.normalize_plate(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(regexp_replace(coalesce(p, ''), '\s', '', 'g'))
$$;

-- ── 2. Update submit_plate_change to use normalize_plate ─────────
-- Was: upper(regexp_replace(..., '\s|-|\.', '', 'g'))  — whitespace +
-- dash + dot (too aggressive per scope guard; drops legitimate dashed
-- plates). Now: normalize_plate() — whitespace only. Also updates the
-- collision-guard EXISTS to compare via normalize_plate on both sides
-- so a whitespace-differing stored plate can't smuggle a collision.

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

  IF EXISTS (SELECT 1 FROM vehicle_plate_changes
             WHERE vehicle_id = p_vehicle_id AND status = 'pending') THEN
    RETURN jsonb_build_object('error', 'already_pending');
  END IF;

  IF v_vehicle.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'vehicle_not_active', 'hint', 'current_status:'||v_vehicle.status);
  END IF;

  -- Normalize incoming plate. Single source of truth (whitespace only).
  v_new_plate := normalize_plate(p_new_plate);
  IF length(v_new_plate) = 0 THEN
    RETURN jsonb_build_object('error', 'new_plate_required');
  END IF;
  IF length(v_new_plate) > 12 THEN
    RETURN jsonb_build_object('error', 'new_plate_too_long');
  END IF;
  IF v_new_plate = normalize_plate(v_vehicle.plate) THEN
    RETURN jsonb_build_object('error', 'new_plate_same_as_current');
  END IF;

  -- Collision guard — compare normalized on both sides so a whitespace-
  -- differing stored plate can't create a phantom-authorized second row.
  IF EXISTS (
    SELECT 1 FROM vehicles
    WHERE normalize_plate(plate) = v_new_plate
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

-- ── 3. Re-key the partial unique index to normalize_plate ────────
-- Was: (upper(plate), property) — treats "ABC123" and "ABC 123" as
-- distinct. Now: (normalize_plate(plate), property) — collapses them
-- at the DB level regardless of write path. IMMUTABLE normalize_plate
-- is required for index expressions; that's why the function is
-- declared IMMUTABLE above.
DROP INDEX IF EXISTS public.vehicles_authorized_plate_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_plate_norm_uniq
  ON public.vehicles (normalize_plate(plate), property)
  WHERE is_active = true AND status IN ('active', 'under_review');

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFY (after apply)
--
-- ── A. Function exists + IMMUTABLE
--   SELECT proname, provolatile FROM pg_proc WHERE proname = 'normalize_plate';
--   Expected: provolatile='i' (IMMUTABLE).
--
-- ── B. Index re-keyed
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'vehicles' AND indexname LIKE '%plate%';
--   Expected: vehicles_plate_norm_uniq present; vehicles_authorized_plate_uidx gone.
--
-- ── C. Whitespace bypass closed
--   Insert 'ABC 123' at property X status='active'.
--   Attempt insert 'ABC123' at property X status='active'.
--   Expected: 23505 unique_violation on vehicles_plate_norm_uniq
--   (was silently allowed under upper(plate)).
--
-- ── D. submit_plate_change flow
--   Simulate a resident submit_plate_change with p_new_plate='  ABC  123  '.
--   Expected: new_plate stored as 'ABC123' (whitespace-normalized).
--
-- ── E. Dashes NOT stripped
--   normalize_plate('ABC-123') → 'ABC-123' (not 'ABC123').
--   Scope guard preserved.
-- ════════════════════════════════════════════════════════════════════
