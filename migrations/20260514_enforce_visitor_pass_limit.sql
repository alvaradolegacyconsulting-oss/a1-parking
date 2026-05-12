-- ════════════════════════════════════════════════════════════════════
-- B19 — Enforce visitor pass per-plate limit at the DB layer
-- Locked: May 14, 2026
--
-- Run via Supabase SQL Editor as a single transaction.
--
-- What this does:
--   1. Trigger: BEFORE INSERT on visitor_passes raises if the plate
--      already has >= visitor_pass_limit active passes at the same
--      property. Plates in properties.exempt_plates bypass.
--      properties.visitor_pass_limit IS NULL → unlimited.
--   2. RPC: get_plate_pass_status(property, plate) returns
--      { state, used?, limit? } so the visitor pass UI (including
--      the anonymous /visitor page that can't SELECT visitor_passes
--      directly under RLS) can show the remaining-passes counter
--      before the user hits submit.
--
-- Decision (locked, May 14):
--   - Enforce from-now-forward only. Existing over-limit rows
--     (e.g., the 3 T9380L passes on Bayou Heights) are NOT touched.
--     They'll naturally expire.
--   - NULL limit = unlimited (managers opt in).
--   - exempt_plates wholly bypasses the count.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Trigger function ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_visitor_pass_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT;
  v_exempt TEXT[];
  v_current_count INT;
  v_normalized_plate TEXT;
BEGIN
  SELECT visitor_pass_limit, exempt_plates
  INTO v_limit, v_exempt
  FROM properties
  WHERE name = NEW.property;

  -- NULL limit = unlimited; managers opt in by setting a value.
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  v_normalized_plate := UPPER(regexp_replace(NEW.plate, '[^A-Z0-9]', '', 'gi'));

  -- Exempt plates wholly bypass the cap.
  IF v_exempt IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_exempt) AS ep
    WHERE UPPER(regexp_replace(ep, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
  ) THEN
    RETURN NEW;
  END IF;

  -- Count current active concurrent passes for this plate at this property.
  -- Normalize stored plates the same way as the incoming one so existing
  -- rows that landed before plate normalization (B10) still match.
  SELECT COUNT(*) INTO v_current_count
  FROM visitor_passes
  WHERE property = NEW.property
    AND UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
    AND is_active = TRUE
    AND expires_at > now();

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION
      'Visitor pass limit exceeded for plate % at %: % of % active passes',
      NEW.plate, NEW.property, v_current_count, v_limit
      USING ERRCODE = '23514',
            HINT = 'Wait for existing passes to expire, contact your property manager to increase the limit, or ask the manager to add this plate to exempt_plates.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_visitor_pass_limit_trigger ON visitor_passes;
CREATE TRIGGER enforce_visitor_pass_limit_trigger
BEFORE INSERT ON visitor_passes
FOR EACH ROW
EXECUTE FUNCTION enforce_visitor_pass_limit();

-- ── 2. Read-only RPC for the UI counter ─────────────────────────────
-- Anonymous (visitor pass page) needs to know how many passes the
-- entered plate already has, but anon can't SELECT visitor_passes under
-- current RLS. SECURITY DEFINER bypasses RLS in a controlled way —
-- the function returns only counts + state, never raw row data.
--
-- Returns a JSONB matching the TS PlateLimitStatus union:
--   { "state": "unlimited" }
--   { "state": "exempt" }
--   { "state": "within",  "used": 1, "limit": 2 }
--   { "state": "at_limit", "used": 2, "limit": 2 }

CREATE OR REPLACE FUNCTION get_plate_pass_status(
  p_property TEXT,
  p_plate TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INT;
  v_exempt TEXT[];
  v_current_count INT;
  v_normalized_plate TEXT;
BEGIN
  IF p_property IS NULL OR p_property = '' OR p_plate IS NULL OR p_plate = '' THEN
    RETURN jsonb_build_object('state', 'unlimited');
  END IF;

  SELECT visitor_pass_limit, exempt_plates
  INTO v_limit, v_exempt
  FROM properties
  WHERE name ILIKE p_property
  LIMIT 1;

  IF v_limit IS NULL THEN
    RETURN jsonb_build_object('state', 'unlimited');
  END IF;

  v_normalized_plate := UPPER(regexp_replace(p_plate, '[^A-Z0-9]', '', 'gi'));

  IF v_exempt IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_exempt) AS ep
    WHERE UPPER(regexp_replace(ep, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
  ) THEN
    RETURN jsonb_build_object('state', 'exempt');
  END IF;

  SELECT COUNT(*) INTO v_current_count
  FROM visitor_passes
  WHERE property ILIKE p_property
    AND UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')) = v_normalized_plate
    AND is_active = TRUE
    AND expires_at > now();

  IF v_current_count >= v_limit THEN
    RETURN jsonb_build_object('state', 'at_limit', 'used', v_current_count, 'limit', v_limit);
  END IF;

  RETURN jsonb_build_object('state', 'within', 'used', v_current_count, 'limit', v_limit);
END;
$$;

GRANT EXECUTE ON FUNCTION get_plate_pass_status(TEXT, TEXT) TO anon, authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) Trigger attached:
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'visitor_passes'::regclass
--     AND tgname = 'enforce_visitor_pass_limit_trigger';
--
-- 2) Functions present:
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('enforce_visitor_pass_limit', 'get_plate_pass_status');
--
-- 3) Set Bayou limit to 2 for testing:
--   UPDATE properties SET visitor_pass_limit = 2
--     WHERE name = 'Bayou Heights Apartments';
--
-- 4) Smoke test via SQL Editor as service-role:
--   SELECT get_plate_pass_status('Bayou Heights Apartments', 'TEST123');
--   -- Expected: { "state": "within", "used": 0, "limit": 2 }
--
-- 5) Reset after testing:
--   UPDATE properties SET visitor_pass_limit = NULL
--     WHERE name = 'Bayou Heights Apartments';
-- ════════════════════════════════════════════════════════════════════
