-- ══════════════════════════════════════════════════════════════════════
-- 20260806_deactivate_vehicle_rpc.sql
-- Task 3 Commit 3 (2026-08-06). DEFINER RPC symmetric to
-- approve_vehicle. Closes the render-side-only authority gap left by
-- Task 1 (1c1ce5a) — a manager without can_approve_vehicles was
-- blocked in the UI but permitted by the direct client update.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS RPC EXISTS ──────────────────────────────────────────────
--
-- deactivateVehicleCrm at manager/page.tsx:1803 wrote via direct
-- client UPDATE. RLS on vehicles does not check can_approve_vehicles,
-- so a manager whose flag is FALSE could still craft a request and
-- succeed. Task 1's gate flip made deactivation permit-granting on
-- the CLIENT; this RPC closes the SERVER side. Deactivation now
-- routes through a DEFINER function that enforces role + authority +
-- scope on the write boundary.
--
-- Also carries the reason validation: reason present, note required
-- when reason='other', reject the three system codes (per Mateo Aug 6
-- — a closed vocabulary that must never arrive from a client).
--
-- ── DELIBERATE DIVERGENCE FROM approve_vehicle (20260626) ────────────
--
-- 1. AUTHORITY: approve_vehicle gates on role only. This RPC ALSO
--    checks user_roles.can_approve_vehicles for managers (per
--    1c1ce5a: subtractive action gets harm-asymmetry read — needs
--    permit authority to revoke). CA still bypasses the flag —
--    matches approve_vehicle CA path.
--
-- 2. SCOPE: approve_vehicle uses ILIKE (`~~*`). This RPC uses
--    lower(trim(...)) — the strictest of the three property-matching
--    conventions in tree, and the one shipped by
--    get_unit_occupancy_summaries and check_authorized_plate
--    manager-branch. A property name containing % or _ over-matches
--    under ILIKE (same class as get_plate_pass_status wildcard
--    injection backlog + trimDepartedResidentVehicles
--    escapeIlikeValue work). Do NOT "align" to approve_vehicle's
--    looser convention in the name of consistency — the older sibling
--    is the one that should tighten.
--
-- ── REASON VALIDATION (SERVER-SIDE, MINIMAL) ─────────────────────────
--
-- - reason present (non-null, non-empty)
-- - if reason='other', note required (non-null, non-empty after trim)
-- - reason NOT IN ('cascade_resident_deactivated','owner_trim','admin_cascade')
--   (system codes — the closed set that must never arrive from a
--   client)
--
-- The full vocabulary (RESIDENT_ / VEHICLE_DEACTIVATION_REASONS) is
-- NOT encoded here. That's the tier-config drift lesson — SQL CHECK
-- constraints or code-list validation duplicate the TS module and
-- silently diverge. TS remains authoritative for the vocabulary;
-- SQL enforces only the closed-set exclusion + presence + note-
-- required, which are semantically fixed and cheap to keep in sync.
--
-- ── CASCADES ─────────────────────────────────────────────────────────
--
-- None (confirmed 2026-08-06 §1c report). No triggers on vehicles,
-- no space ties or guest_authorizations depend on vehicle rows.
-- Body is: role gate → authority gate → scope gate → reason gate →
-- update → return.
--
-- ── GRANTS ────────────────────────────────────────────────────────────
--
-- REVOKE ALL FROM PUBLIC + REVOKE FROM anon (revoke-anon discipline).
-- GRANT EXECUTE TO authenticated — internal role check enforces
-- manager | company_admin only.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.deactivate_vehicle(
  p_vehicle_id BIGINT,
  p_reason     TEXT,
  p_note       TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_caller_company     TEXT;
  v_caller_properties  TEXT[];
  v_can_approve        BOOLEAN;
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN := FALSE;
  v_note_clean         TEXT;
  v_updated            public.vehicles%ROWTYPE;
BEGIN
  -- ── 1. Role gate ────────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'deactivate_vehicle requires manager or company_admin role; got ' || v_caller_role
    );
  END IF;

  -- ── 2. Authority gate (managers only) ──────────────────────────
  -- CA bypasses the can_approve_vehicles flag — matches
  -- approve_vehicle CA path. Managers must carry the flag per Task 1
  -- (1c1ce5a): subtractive action gets the harm-asymmetry read.
  IF v_caller_role = 'manager' THEN
    v_caller_email := auth.jwt() ->> 'email';
    SELECT COALESCE(bool_or(ur.can_approve_vehicles), FALSE)
      INTO v_can_approve
      FROM public.user_roles ur
     WHERE lower(ur.email) = lower(v_caller_email)
       AND ur.role = 'manager';
    IF NOT v_can_approve THEN
      RETURN jsonb_build_object(
        'error', 'authority_not_granted',
        'hint',  'deactivate_vehicle requires can_approve_vehicles=TRUE on your user_roles row (Task 1 lock 2026-08-04: subtractive action requires permit authority — a manager who cannot grant a permit cannot revoke one).'
      );
    END IF;
  END IF;

  -- ── 3. Load target vehicle ─────────────────────────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ── 4. Scope gate — lower(trim(...)) (STRICTER than approve_vehicle) ─
  -- Deliberate divergence from approve_vehicle. See header §2.
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := lower(trim(v_vehicle.property)) IN (
      SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p
    );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.name))    = lower(trim(v_vehicle.property))
         AND lower(trim(p.company)) = lower(trim(v_caller_company))
    ) INTO v_in_scope;
  END IF;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Reason gate (presence + note-required + system-code reject) ──
  -- See header §"REASON VALIDATION". TS module owns the vocabulary;
  -- SQL enforces only the closed-set exclusion + presence + note-
  -- required.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_reason IN ('cascade_resident_deactivated', 'owner_trim', 'admin_cascade') THEN
    RETURN jsonb_build_object(
      'error', 'reason_is_system_code',
      'hint',  'System reason codes (cascade_resident_deactivated / owner_trim / admin_cascade) must never arrive from a client. Manager-selectable codes only.'
    );
  END IF;
  IF p_reason = 'other' THEN
    IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
      RETURN jsonb_build_object('error', 'note_required_when_reason_other');
    END IF;
  END IF;
  -- Note cleanup — cap at 256 chars, trim, coerce empty to NULL.
  v_note_clean := NULLIF(trim(substring(COALESCE(p_note, ''), 1, 256)), '');

  -- ── 6. Idempotency — already-deactivated is a no-op ─────────────
  -- Returns {ok:true, action:'noop_already_deactivated'} so the client
  -- can distinguish a fresh deactivation from a re-submit of one that
  -- already landed.
  IF v_vehicle.status = 'deactivated' AND v_vehicle.is_active = FALSE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_deactivated',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 7. THE DEACTIVATION UPDATE ──────────────────────────────────
  UPDATE public.vehicles
     SET is_active           = FALSE,
         status              = 'deactivated',
         deactivation_reason = p_reason,
         deactivation_note   = v_note_clean,
         deactivated_by      = COALESCE(v_caller_email, auth.jwt() ->> 'email'),
         deactivated_at      = now()
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      TRUE,
    'action',  'deactivated',
    'vehicle', to_jsonb(v_updated)
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) IS
  'DEFINER RPC for manager-initiated vehicle deactivation. Symmetric to approve_vehicle with two deliberate divergences: (1) authority gate on can_approve_vehicles for managers (subtractive action requires permit authority per Task 1 lock 2026-08-04); (2) scope uses lower(trim(...)) not ILIKE (strictest of the three property-matching conventions in tree). Reason validation: presence + note-required-when-other + system-code rejection. TS module (app/lib/deactivation-reasons.ts) owns the vocabulary. Closes the render-side-only gap from 1c1ce5a. CASCADES NONE. Grants: authenticated EXECUTE; anon REVOKED. Installed 2026-08-06.';

-- ── SCHEMA_ audit ────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_DEACTIVATE_VEHICLE_RPC',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260806_deactivate_vehicle_rpc',
    'purpose',   'Task 3 Commit 3 — server-side deactivate_vehicle DEFINER RPC. Closes Task 1 (1c1ce5a) render-side-only authority gap. Authority gate on can_approve_vehicles for managers; CA bypasses. Scope uses lower(trim(...)) (deliberate divergence from approve_vehicle ILIKE). Reason validation: presence + note-required-when-other + system-code reject.',
    'divergences_from_approve_vehicle', jsonb_build_object(
      'authority', 'checks user_roles.can_approve_vehicles for manager (approve_vehicle does not)',
      'scope',     'lower(trim(...)) both sides (approve_vehicle uses ILIKE ~~*)'
    ),
    'reason_validation', jsonb_build_object(
      'presence',       'reason non-null, non-empty',
      'note_required',  'when reason=other',
      'system_reject',  jsonb_build_array('cascade_resident_deactivated','owner_trim','admin_cascade'),
      'vocabulary_sot', 'app/lib/deactivation-reasons.ts (TS owns; SQL does NOT duplicate)'
    ),
    'cascades', 'none',
    'grants',   'REVOKE ALL FROM PUBLIC + REVOKE FROM anon + GRANT EXECUTE TO authenticated'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_DEACTIVATE_VEHICLE_RPC'
     AND new_values->>'migration' = '20260806_deactivate_vehicle_rpc'
);

COMMIT;
