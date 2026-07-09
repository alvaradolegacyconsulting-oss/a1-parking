-- ════════════════════════════════════════════════════════════════════
-- B230 Part A — pm_plate_lookup adds pending + plate_under_review states
-- 2026-07-08
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Extends pm_plate_lookup()'s return-model result_type from 4 values
--   (resident, guest_authorized, visitor, unauthorized) to 6 by adding
--   two "don't-tow / under-review" states that the driver surface has
--   distinguished since B84 + Slice 4 but the manager (PM) surface
--   has been collapsing into 'unauthorized':
--
--     • 'pending'            — vehicles row with is_active=FALSE +
--                              status='pending' matches at an assigned
--                              property (permit-approval pending).
--     • 'plate_under_review' — vehicle_plate_changes row with
--                              status='pending' matches the queried
--                              plate (as its NEW plate) at an assigned
--                              property (resident-submitted plate change
--                              awaiting PM decision).
--
--   Both classify as do-not-tow oversight states — same load-bearing
--   invariant the driver surface already enforces.
--
-- WHY
--   B230 — UAT (2026-07-08) showed a pending plate reading
--   "under review — don't tow" on the driver surface but "unauthorized"
--   on the PM plate search. Root cause: the RPC's cascade jumped from
--   resident (Step 1, is_active=TRUE only) to guest_authorized (Step 2)
--   with no Step to catch pending-permit + pending-plate-change states.
--   Fixing that on the client alone is impossible because the RPC
--   never returned the states — the derivation lives here.
--
-- ORDERING (mirrors driver cascade — driver/page.tsx:360-479)
--   1. Active resident         (existing — unchanged)
--   2. Pending permit          (NEW — is_active=FALSE + status='pending')
--   3. Plate-change pending    (NEW — vehicle_plate_changes.status='pending')
--   4. Guest authorization     (existing — unchanged; B220 stage 2.5)
--   5. Visitor pass            (existing — unchanged)
--   6. Unauthorized            (existing — fallthrough)
--
--   Steps 2+3 come BEFORE guest/visitor because a pending permit or
--   plate change at THIS property is a stronger match than a
--   coincidental guest_auth / visitor_pass — it identifies a resident
--   with existing standing whose registration is mid-flight.
--
--   Declined + expired vehicles remain grouped under 'unauthorized'
--   (Q3 answered 2026-07-08 — enforcement-equivalent for now; a
--   'declined' distinction on the RPC is a trivial follow-up).
--
-- SCOPING (Guardrail 1)
--   All new branches carry `property ILIKE ANY (v_properties)` —
--   identical to the existing branches. Pending vehicles or plate
--   changes at OTHER properties never leak into a manager's lookup.
--   vehicle_plate_changes join to vehicles via vehicle_id is scoped by
--   the vpc.property column (denormalized-for-RLS per its own schema
--   at 20260703_slice4_vehicle_plate_changes.sql:46).
--
-- SIGNATURE PRESERVED
--   pm_plate_lookup(TEXT) → jsonb — unchanged. Return-shape jsonb keys
--   also unchanged (result_type, unit_number, guest_name, valid_through);
--   only new string values for result_type. CREATE OR REPLACE preserves
--   ACL when signature matches; belt-and-suspenders DROP first to
--   guarantee overload_count = 1 (Commit 2 zombie-11-arg lesson).
--
-- INVARIANTS PRESERVED (from 20260628_pm_plate_lookup_volatile_fix)
--   • SECURITY DEFINER + search_path SET
--   • VOLATILE (writes audit_logs)
--   • Role gate: {manager, leasing_agent}
--   • Property scope: get_my_properties() ILIKE ANY
--   • Audit row written every lookup
--   • Grants: REVOKE PUBLIC + REVOKE anon + GRANT authenticated
--
-- ROLLBACK
--   \i 20260628_pm_plate_lookup_volatile_fix.sql restores the 4-value
--   cascade. Any client consuming the new result_types silently
--   degrades to unauthorized rendering (matches pre-B230 behavior).
--   No data migration needed.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Defensive DROP so post-apply overload_count = 1 for sure
-- ([[feedback_sql_editor_partial_apply]] lesson from Commit 2's zombie
-- 11-arg overload). Signature is unchanged so CREATE OR REPLACE alone
-- would also work, but the DROP + explicit re-GRANT is the discipline.
DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT);

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
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

  -- ── 1. Resident match (active permit) ────────────────────────────
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
    -- ── 2. Pending permit match (B230 NEW — do-not-tow) ────────────
    -- Vehicle row exists at an assigned property but permit approval
    -- is still pending. Driver surface renders as "REGISTRATION
    -- PENDING — DO NOT TOW"; PM surface renders as "under review /
    -- being reviewed." Same underlying state, surface-appropriate copy.
    SELECT v.unit INTO v_vehicle_unit
    FROM vehicles v
    WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND v.is_active = FALSE
      AND v.status    = 'pending'
      AND v.property ILIKE ANY (v_properties)
    LIMIT 1;

    IF v_vehicle_unit IS NOT NULL THEN
      v_result_type := 'pending';
      v_unit_number := v_vehicle_unit;
    ELSE
      -- ── 3. Plate-change pending match (B230 NEW — do-not-tow) ────
      -- vehicle_plate_changes row where the queried plate matches the
      -- SUBMITTED NEW plate + status='pending'. Existing resident is
      -- mid-request for a plate change; driver surface renders the
      -- old→new context banner; PM surface renders as "under review."
      -- Overlap tie-broken by most-recent submitted_at (matches
      -- driver's ORDER BY at driver/page.tsx:474).
      SELECT v.unit INTO v_vehicle_unit
      FROM vehicle_plate_changes vpc
      JOIN vehicles v ON v.id = vpc.vehicle_id
      WHERE upper(regexp_replace(vpc.new_plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vpc.status = 'pending'
        AND vpc.property ILIKE ANY (v_properties)
      ORDER BY vpc.submitted_at DESC
      LIMIT 1;

      IF v_vehicle_unit IS NOT NULL THEN
        v_result_type := 'plate_under_review';
        v_unit_number := v_vehicle_unit;
      ELSE
        -- ── 4. Guest authorization match (B220 stage 2.5 — unchanged) ─
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
          -- ── 5. Visitor pass match (unchanged) ──────────────────────
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
            -- ── 6. Unauthorized (unchanged — declined + expired ─────
            -- vehicles fall through here; enforcement-equivalent for
            -- now per Q3 lock 2026-07-08).
            v_result_type := 'unauthorized';
            v_unit_number := NULL;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── 7. Audit write (requires VOLATILE — unchanged) ───────────────
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

-- DROP wiped the ACL — re-emit REVOKE + GRANT per standing discipline
-- ([[feedback_function_public_grant_supabase_default]] +
-- [[feedback_revoke_from_anon_explicitly]]).
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'pm_plate_lookup',
  NULL,
  jsonb_build_object(
    'rpc',       'pm_plate_lookup',
    'migration', '20260708_b230_pm_plate_lookup_pending_states',
    'change',    'result_type extended from 4 to 6 values — adds pending (vehicles is_active=FALSE + status=pending) + plate_under_review (vehicle_plate_changes.status=pending); scoping preserved (property ILIKE ANY get_my_properties)',
    'rationale', 'B230 — PM plate search collapsed pending states into unauthorized; driver surface had distinguished pending/plate_under_review since B84+Slice 4. Part A: RPC grows the states. Part B: shared plate-status helper + surface wires.'
  ),
  now()
);

COMMIT;
