-- ══════════════════════════════════════════════════════════════════════
-- 20260804_check_plate_on_record_inactive_at_property.sql
-- Finding 3 — /visitor precheck warns pending/declined/expired residents
-- ══════════════════════════════════════════════════════════════════════
--
-- Depends on: 68fe21c + 85ed2e8 (composite arc closed).
-- Motivation: /visitor's existing precheck (check_resident_plate)
-- filters is_active=TRUE only. Pending, declined, and expired vehicles
-- are silently ignored — a resident whose registration hasn't come
-- through gets no feedback that a visitor pass doesn't fix their
-- actual problem. Green Acres unit 186 issued daily passes for three
-- days against their own pending vehicle. This RPC feeds the second
-- half of a parallel precheck: the client warns (never blocks) when
-- a plate matches an on-record inactive vehicle.
--
-- ── LOCKED DECISIONS (Mateo, 2026-08-04) ──────────────────────────────
--
-- 1. NEW RPC, not a widen. check_resident_plate + its client consumer
--    stay untouched — the existing active-resident block preserved by
--    construction rather than by careful editing. Client calls both
--    RPCs in parallel.
--
-- 2. Status set: `('pending', 'declined', 'expired')`. Deactivated
--    EXCLUDED — a deactivated vehicle means the resident moved out,
--    and that person may now genuinely be a visitor. Warning them
--    would be wrong.
--
-- 3. Return shape: BOOLEAN only. Anonymous surface — no strings, no
--    dates, no distinguishing field. A network trace of /visitor
--    must not reveal a plate's status beyond "known here" vs
--    "not known here."
--
-- 4. Anti-enumeration: /visitor already gates behind Cloudflare
--    Turnstile (confirmed via app/visitor/page.tsx:8; /api/visitor/
--    create-pass wraps /siteverify). Bulk probing is CAPTCHA-
--    controlled. The residual disclosure (three-state distinction:
--    active-block vs on-record-warn vs unknown) is mild and pre-
--    existing on the active side.
--
-- ── JOSE PRE-APPLY ────────────────────────────────────────────────────
--
-- Purely additive — new function only. No table changes. No data
-- mutation. Single-paste; single BEGIN/COMMIT wrap.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Function shape mirrors check_resident_plate (2026-05-24 B74) ──
-- Same normalization (upper + strip non-alnum), same input guards
-- (null / empty / all-punctuation), same anon+authenticated grant.
-- Only the WHERE clause differs: is_active=FALSE + status filter
-- vs check_resident_plate's is_active=TRUE.
CREATE OR REPLACE FUNCTION public.check_plate_on_record_inactive_at_property(
  p_plate     TEXT,
  p_property  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized TEXT;
BEGIN
  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RETURN FALSE;
  END IF;
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN FALSE;
  END IF;

  -- Same normalization as check_resident_plate + pm_plate_lookup:
  -- uppercase + strip everything that isn't [A-Za-z0-9]. Both sides
  -- of the compare normalized identically.
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized) = 0 THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM vehicles
    WHERE upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND property ILIKE p_property
      AND is_active = FALSE
      AND status IN ('pending', 'declined', 'expired')
    -- deactivated excluded: means resident moved out; that person
    -- may now legitimately be a visitor.
  );
END;
$$;

COMMENT ON FUNCTION public.check_plate_on_record_inactive_at_property(TEXT, TEXT) IS
  'Finding 3 — /visitor precheck. Returns TRUE if a plate matches any is_active=false vehicle with status in (pending, declined, expired) at the named property. Feeds the two-step client warning ("this plate is already on record"). Deactivated vehicles excluded — moved-out residents can be visitors. Anonymous-safe: boolean only, no leaked status/dates. Parallel to check_resident_plate; NOT a replacement.';

-- ── Grants: anon + authenticated (parallels check_resident_plate) ──
GRANT EXECUTE ON FUNCTION public.check_plate_on_record_inactive_at_property(TEXT, TEXT)
  TO anon, authenticated;

COMMIT;
