-- ══════════════════════════════════════════════════════════════════════
-- 20260803_get_pm_ticket_summary_vin.sql
-- Add vehicle_vin to the get_pm_ticket_summary jsonb projection.
-- ══════════════════════════════════════════════════════════════════════
--
-- Depends on:
--   20260614_b182_pm_ticket_summary.sql — created get_pm_ticket_summary
--   20260629_violations_mileage_vin_persistence.sql — added
--     violations.vehicle_vin column (TEXT nullable)
--
-- Motivation (Mateo diagnostic 2026-08-03):
--   VIN prints on the driver's ticket (driver/page.tsx:1872, sourced
--   from ticketTarget.vehicle_vin) but is absent from the PM
--   ticket view (/ticket/pm/[id]). The column exists on the
--   violations row; the RPC that feeds the PM surface was defined
--   2026-06-14 — before the VIN column existed (added 2026-06-29)
--   — and was never updated to include it in the jsonb projection.
--
--   VIN is how a tow is tied to a vehicle when a plate is wrong,
--   missing, or transferred. A manager defending a tow with the
--   ticket that omits it is arguing from the weaker of two records
--   the system already holds. Adding it closes that gap.
--
-- ── SHAPE ─────────────────────────────────────────────────────────────
--
-- Signature UNCHANGED — (p_violation_id BIGINT) → jsonb. CREATE OR
-- REPLACE preserves grants when the signature is stable (Postgres
-- semantics). Per Mateo lock 2026-08-03: "Prefer CREATE OR REPLACE
-- if the signature is unchanged — it preserves grants and makes the
-- REVOKE + GRANT paragraph moot." Belt-and-suspenders re-issue
-- included below anyway.
--
-- Body is the 20260614_b182 body verbatim EXCEPT for ONE added key
-- in the returned jsonb_build_object at the end:
--
--   'vehicle_vin', v_row.vehicle_vin,
--
-- Everything else — role gate, property scope, state checks, photos
-- aggregation, decline-reason projection, storage projection —
-- IDENTICAL to the shipped 2026-06-14 body.
--
-- ── JOSE PRE-APPLY ────────────────────────────────────────────────────
--
-- Purely additive at the projection layer; no schema mutation; no
-- data mutation. Single-paste; single BEGIN/COMMIT wrap. No
-- diagnostic needed.
--
-- Because CREATE OR REPLACE preserves grants, the REVOKE+GRANT
-- statements below are informational (they re-establish the same
-- state that already exists). Leaving them in for defense-in-depth
-- + to make the intended grant state explicit in the file itself.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_pm_ticket_summary(p_violation_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_role TEXT;
  v_properties  TEXT[];
  v_row         violations%ROWTYPE;
  v_photos      jsonb;
BEGIN
  -- ── 1. ROLE GATE — manager / leasing_agent only ────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'leasing_agent') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'This view is for property managers and leasing agents only. Drivers + CA use the public capability URL; admin uses portal tools.'
    );
  END IF;

  -- ── 2. PROPERTY-SCOPE GATE ─────────────────────────────────────
  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) = 0 THEN
    RETURN jsonb_build_object('error', 'no_property_scope');
  END IF;

  -- ── 3. LOAD VIOLATION + STATE CHECKS ───────────────────────────
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_properties) p
     WHERE v_row.property ~~* p
  ) THEN
    RETURN jsonb_build_object('error', 'out_of_scope');
  END IF;

  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  IF v_row.tow_ticket_generated = false THEN
    RETURN jsonb_build_object('error', 'not_ticketed');
  END IF;

  -- ── 4. PHOTOS — active only (soft-deletes excluded) ────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', vp.id, 'photo_url', vp.photo_url)
      ORDER BY vp.id
    ),
    '[]'::jsonb
  )
    INTO v_photos
    FROM violation_photos vp
   WHERE vp.violation_id = v_row.id
     AND vp.removed_at IS NULL;

  -- ── 5. RETURN PRICE-STRIPPED PAYLOAD ───────────────────────────
  -- EXPLICITLY enumerate every field — NEVER use to_jsonb(violations.*).
  -- Adding a column to violations does NOT automatically expose it
  -- here — that's by design (2026-06-14 lock; PRICE fields must not
  -- leak into the PM view via a refactor).
  --
  -- 2026-08-03 addition: vehicle_vin. Non-price data (identifier of
  -- the vehicle towed); driver captures it at ticket time and it
  -- persists to the row via stamp_tow_ticket. Its absence here
  -- forced the PM to defend a tow with only the plate — a weaker
  -- record than the system already holds.
  RETURN jsonb_build_object(
    'ok', true,
    'violation', jsonb_build_object(
      'id',                      v_row.id,
      'plate',                   v_row.plate,
      'vehicle_year',            v_row.vehicle_year,
      'vehicle_make',            v_row.vehicle_make,
      'vehicle_model',           v_row.vehicle_model,
      'vehicle_color',           v_row.vehicle_color,
      'vehicle_vin',             v_row.vehicle_vin,
      'violation_type',          v_row.violation_type,
      'location',                v_row.location,
      'notes',                   v_row.notes,
      'property',                v_row.property,
      'driver_name',             v_row.driver_name,
      'driver_license',          v_row.driver_license,
      'created_at',              v_row.created_at,
      'tow_ticket_generated_at', v_row.tow_ticket_generated_at,
      'was_authorized_at_time',  v_row.was_authorized_at_time,
      'decline_reason',          v_row.decline_reason,
      'decline_reason_note',     v_row.decline_reason_note,
      'tow_storage_name',        v_row.tow_storage_name,
      'tow_storage_address',     v_row.tow_storage_address,
      'tow_storage_phone',       v_row.tow_storage_phone,
      'video_url',               v_row.video_url
    ),
    'photos', v_photos
  );
END
$func$;

-- Grants — informational after CREATE OR REPLACE (they persist),
-- but re-issued to make the intended state explicit in this file.
REVOKE EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) TO authenticated;

COMMIT;
