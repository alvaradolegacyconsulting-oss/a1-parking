-- ═══════════════════════════════════════════════════════════════════
-- B220 — Add guest_authorizations stage 2.5 to pm_plate_lookup
-- Date:   2026-06-26
-- Branch: a1/b220-manager-plate-lookup-guest-auth
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Extends the existing pm_plate_lookup RPC (manager Plate Lookup tab
-- backend, last touched 2026-05-22 by B70/B71 polish pass) to recognize
-- guest-authorized plates from the guest_authorizations table (B214,
-- 2026-06-20).
--
-- Today: a manager looking up a guest-authorized plate gets
-- 'unauthorized' — wrong + scary. After this migration: 'guest_authorized'
-- result with the guest_name + valid_through (end_date) so the manager
-- can verify the authorization without needing to navigate to the
-- Authorized Guests tab.
--
-- DRIVER + CA portals already check guest_authorizations as stage 2.5
-- of their cascades (B214 commit 3bfa7c9). This commit makes the
-- manager Plate Lookup surface match — closing the
-- "render-only-is-silent-permanent-boundary" gap that B220 was logged
-- against (memory note 2026-06-21).
--
-- RETURN SHAPE — NON-BREAKING ADDITION
-- ────────────────────────────────────
-- Existing fields preserved:
--   result_type    'resident' | 'visitor' | 'unauthorized'  (existing)
--                  'guest_authorized'                       (NEW)
--   unit_number    TEXT | null                              (existing)
--
-- New fields (NULL on resident/visitor/unauthorized cases):
--   guest_name     TEXT | null   — only populated on guest_authorized
--   valid_through  DATE | null   — only populated on guest_authorized
--                                   (matches guest_authorizations.end_date)
--
-- Frontend that reads only result_type + unit_number stays correct —
-- the new fields are additive. No callers break.
--
-- 🔒 INVARIANTS PRESERVED
-- ───────────────────────
--   1. Role gate: {manager, leasing_agent} only (unchanged).
--   2. Property scope: get_my_properties() ILIKE ANY (unchanged).
--      Guest-auth query intersects with this same scope.
--   3. Audit write: every lookup logs regardless of result.
--      'guest_authorized' will start appearing as a result_type value
--      in plate_lookup audit rows post-migration — that's the only
--      observable downstream change beyond the new return fields.
--   4. Minimum-leak return shape: the new fields are guest-auth-only
--      data the manager already has access to via the Authorized
--      Guests tab; not new PII surface.
--   5. SECURITY DEFINER + STABLE preserved.
--
-- STAGE ORDERING (matches driver/CA cascade)
-- ──────────────────────────────────────────
--   1. vehicles (resident)        — existing
--   1.5 — none (skip; resident wins if both)
--   2. guest_authorizations       — NEW; inserts BETWEEN resident
--                                    and visitor so a vetted guest's
--                                    plate is recognized BEFORE the
--                                    visitor-pass check (matches
--                                    driver/page.tsx:405-420 stage 2.5)
--   3. visitor_passes (visitor)   — existing
--   4. (none) → 'unauthorized'    — existing
--
-- INDEX ALIGNMENT
-- ───────────────
-- The guest_authorizations query predicate matches the table's primary
-- index (is_active + status + start_date + end_date) for an index-only
-- scan — same predicate the driver cascade uses (B214 spec).
--
-- APPLY DISCIPLINE
-- ────────────────
-- 1. Section A of verification → confirm OLD function body
--    (NOT LIKE '%guest_authorizations%')
-- 2. Apply this file as a single paste in SQL Editor
-- 3. Sections B–D → confirm post-apply (body has stage 2.5;
--    grants unchanged; audit row recording the migration present)
-- 4. UI commit (manager Plate Lookup tab guest_authorized render
--    branch + B221 sort fix + B222 search) ships AFTER the RPC is
--    live in prod.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
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
  -- ── Auth + role gate ────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
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
    -- ── 2. Guest authorization match (B220, 2026-06-26) ────────────
    -- NEW stage 2.5: inserts BETWEEN resident (above) and visitor
    -- (below) so a manager-vetted guest plate is recognized BEFORE
    -- the visitor-pass check would otherwise return 'unauthorized'
    -- (or surface a stale visitor pass). Matches the driver +
    -- company_admin cascade shape exactly (B214 commit 3bfa7c9
    -- · driver/page.tsx:405-420 · company_admin/page.tsx:1860).
    --
    -- Predicate matches the table's primary index
    -- (is_active + status + start_date + end_date) for an
    -- index-only scan. ORDER BY end_date DESC LIMIT 1 keeps the
    -- result deterministic if two overlapping authorizations exist
    -- (a manager soft-warning at create time discourages this, but
    -- the hard-unique constraint doesn't exist by design — overlap
    -- can be legitimate).
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
      -- v_guest_name + v_guest_end populated above; both flow into
      -- the return object below.
    ELSE
      -- ── 3. Visitor pass match (active pass, caller's property) ─
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
  END IF;

  -- ── 4. Audit write (every lookup, regardless of result) ──────────
  -- post-B220: 'guest_authorized' becomes a possible result_type value
  -- in this row's new_values; downstream log readers should expect it.
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',     -- nominal target; actual scope spans vehicles + guest_authorizations + visitor_passes
    jsonb_build_object(
      'normalized_plate', v_normalized,
      'result_type', v_result_type,
      'properties_searched', to_jsonb(v_properties)
    ),
    now()
  );

  -- ── 5. Return minimum-leak result ────────────────────────────────
  -- NON-BREAKING addition: guest_name + valid_through are NULL on
  -- resident/visitor/unauthorized cases. Existing UI that reads only
  -- result_type + unit_number stays correct.
  RETURN jsonb_build_object(
    'result_type',   v_result_type,
    'unit_number',   v_unit_number,
    'guest_name',    v_guest_name,
    'valid_through', v_guest_end
  );
END;
$func$;

-- Grants unchanged from prior state; CREATE OR REPLACE preserves them.
-- Restated explicitly per the established discipline for clarity +
-- defense against any Supabase default-privilege drift on REPLACE.
REVOKE EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;

-- Audit row recording the migration ships.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'pm_plate_lookup',
  NULL,
  jsonb_build_object(
    'rpc',        'pm_plate_lookup',
    'migration',  '20260626_b220_pm_plate_lookup_guest_auth_stage',
    'change',     'Added stage 2.5 guest_authorizations check; non-breaking return-shape additions (guest_name + valid_through)',
    'invariant',  'role gate {manager, leasing_agent} preserved; property scope unchanged; audit write preserved'
  ),
  now()
);

COMMIT;
