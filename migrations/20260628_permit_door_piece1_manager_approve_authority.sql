-- ════════════════════════════════════════════════════════════════════
-- Permit-Door Fixes Piece 1 / Migration A — manager approve authority
-- Date:   2026-06-28
-- Branch: permit-door/piece1-manager-approve-authority
--
-- WHAT THIS MIGRATION DOES (Migration A — schema + RPC + body change)
-- ──────────────────────────────────────────────────────────────────
-- First of two migrations for Piece 1. This migration is DEPLOYMENT-
-- SAFE TO APPLY BEFORE THE APP IS UPDATED — see the "Deploy ordering"
-- block below for rationale. Three additive changes:
--
--   1. ADD COLUMN user_roles.can_approve_vehicles BOOLEAN NOT NULL
--      DEFAULT FALSE — mirrors the can_regenerate_tow_ticket toggle
--      shape exactly. DEFAULT FALSE matches Jose's "OFF on tier-
--      transition + required deliberate choice at creation" semantic.
--
--   2. NEW RPC set_manager_approve_permission(p_manager_email TEXT,
--      p_allowed BOOLEAN) RETURNS jsonb — SECURITY DEFINER, role-gated
--      (admin + company_admin), company-scope predicate, noop-skips-
--      audit, full error-code map. ONE-TO-ONE mirror of
--      set_driver_regenerate_permission (Tow-Regenerate Layer 3).
--
--   3. approve_vehicle() body change — CREATE OR REPLACE with the
--      NEW authority-gate clause for the manager role; CA bypasses
--      (bill-payer; always allowed). Signature UNCHANGED → no
--      overload-trap fire. The C4a scope-check + idempotency +
--      grants all PRESERVED — Section E of verification re-runs
--      the C4a scope-check NEGATIVE to confirm no regression.
--
-- ⚠ MIGRATION B (vehicles.status DEFAULT 'pending') is a SEPARATE
-- follow-up migration that ships AFTER the app-side helper is
-- deployed at every vehicle-insert site. Splitting closes the
-- deploy-ordering window where the DEFAULT flip alone (without the
-- helper) would force ALL inserts (incl non-PM-Only) to land pending.
--
-- DEPLOY ORDERING (the load-bearing constraint)
-- ─────────────────────────────────────────────
-- Safe sequence:
--   1. Apply Migration A (this file).
--   2. Deploy app (helper + 5+ insert sites + button gating + billing
--      prompt + manager mgmt UI + property-wide approve-all + Door 5b
--      sync). Smoke on PM-Only + non-PM companies.
--   3. Apply Migration B (default flip — backstop for future inserts
--      that forget the helper). Filed at
--      20260628_permit_door_piece1_default_flip_backstop.sql once
--      the app deploy verifies.
--
-- Why this matters: between Migration A apply and app deploy,
-- the new approve_vehicle authority clause is in effect. Every
-- existing manager has can_approve_vehicles=FALSE (DEFAULT), so
-- managers CANNOT APPROVE VEHICLES until CA grants permission via
-- the new mgmt UI. The existing approve button (pre-app-deploy)
-- still renders but the underlying RPC rejects with
-- 'manager_approval_not_authorized'. CA caller bypasses → CAs can
-- still approve via portal. PM-Only managers see a friendly error
-- toast; non-PM managers see the same toast (they don't need the
-- meter but the gate is universal — this is acceptable because
-- the app-deploy follows immediately and the toast is dismissible).
-- For test mode the brief window is acceptable; for production
-- consider staging the app deploy + Migration A within minutes.
--
-- 🔒 INVARIANTS HONORED:
--   - C4a approve_vehicle scope-check INTACT (manager:
--     property ~~* ANY(get_my_properties()); CA: properties join
--     via get_my_company()). Section E re-runs the NEGATIVE proof.
--   - C4a approve_vehicle idempotency INTACT
--     (noop_already_active branch preserved).
--   - approve_vehicle signature UNCHANGED → no overload trap.
--     CREATE OR REPLACE in-place safe.
--   - existing can_regenerate_tow_ticket pattern preserved
--     (separate column; no interference).
--   - No new tables → grant-footgun N/A.
--   - set_manager_approve_permission is a NEW function — DROP
--     IF EXISTS + CREATE OR REPLACE + REVOKE/GRANT discipline.
--
-- APPLY DISCIPLINE
-- ────────────────
--   1. Eyeball this file (especially the authority-clause addition
--      in approve_vehicle Part 3 — verify scope-check survives)
--   2. Section A pre-check (column absent, RPC absent, approve_vehicle
--      body doesn't yet contain authority clause)
--   3. Apply single BEGIN/COMMIT paste
--   4. Sections B–H post-apply (esp. ★★ E scope-check NEGATIVE
--      regression-guard + ★ F new authority gate fires)
--   5. On clean → app deploy (helper + UI changes)
--   6. Then Migration B (default flip)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — ADD COLUMN user_roles.can_approve_vehicles
-- ════════════════════════════════════════════════════════════════════
-- Mirrors can_regenerate_tow_ticket exactly (B66.x Tow-Regenerate L1):
-- BOOLEAN, NOT NULL, DEFAULT FALSE. Default FALSE = explicit grant
-- required, never implicit. Tier-transition into PM-Only leaves
-- existing managers at FALSE; CA must deliberately grant.

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS can_approve_vehicles BOOLEAN NOT NULL DEFAULT FALSE;


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — set_manager_approve_permission RPC (NEW)
-- ════════════════════════════════════════════════════════════════════
-- One-to-one mirror of set_driver_regenerate_permission (Tow-Regen
-- Layer 3). NEW function → overload-trap discipline applies: DROP IF
-- EXISTS first (idempotent for re-runs); CREATE OR REPLACE installs
-- the single (TEXT, BOOLEAN) signature; Section C re-verifies
-- pg_proc count = 1.

DROP FUNCTION IF EXISTS public.set_manager_approve_permission(TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.set_manager_approve_permission(
  p_manager_email TEXT,
  p_allowed       BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_target_role    TEXT;
  v_target_company TEXT;
  v_current        BOOLEAN;
BEGIN
  -- ── Auth gate ───────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'Only admin or company_admin can change manager approval authority.'
    );
  END IF;

  -- ── Param validation ────────────────────────────────────────────
  IF p_manager_email IS NULL OR length(trim(p_manager_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'manager_email_required');
  END IF;
  IF p_allowed IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'invalid_allowed',
      'hint',  'p_allowed must be TRUE or FALSE, not NULL.'
    );
  END IF;

  -- ── Load target user_roles row ──────────────────────────────────
  SELECT role, company, can_approve_vehicles
    INTO v_target_role, v_target_company, v_current
    FROM public.user_roles
   WHERE lower(email) = lower(p_manager_email)
   LIMIT 1;

  IF v_target_role IS NULL THEN
    RETURN jsonb_build_object('error', 'manager_not_found');
  END IF;
  IF v_target_role <> 'manager' THEN
    RETURN jsonb_build_object(
      'error', 'not_a_manager',
      'hint',  'approve_vehicles authority applies only to manager role; got ' || v_target_role
    );
  END IF;

  -- ── Company-scope (CA only; admin bypasses) ─────────────────────
  IF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF NOT (v_target_company ~~* v_caller_company) THEN
      RETURN jsonb_build_object(
        'error', 'manager_out_of_scope',
        'hint',  'That manager belongs to a different company.'
      );
    END IF;
  END IF;

  -- ── Noop check (skip audit on no-change) ────────────────────────
  IF v_current = p_allowed THEN
    RETURN jsonb_build_object('ok', TRUE, 'noop', TRUE, 'new_value', p_allowed);
  END IF;

  -- ── Apply ────────────────────────────────────────────────────────
  UPDATE public.user_roles
     SET can_approve_vehicles = p_allowed
   WHERE lower(email) = lower(p_manager_email);

  -- ── Audit (asymmetric action names per grant vs revoke) ─────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    CASE WHEN p_allowed THEN 'GRANT_MANAGER_APPROVE' ELSE 'REVOKE_MANAGER_APPROVE' END,
    'user_roles',
    NULL,
    jsonb_build_object(
      'manager_email', lower(p_manager_email),
      'old_value',     v_current,
      'new_value',     p_allowed,
      'caller_role',   v_caller_role,
      'caller_email',  lower(v_caller_email)
    ),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'noop', FALSE, 'new_value', p_allowed);
END
$func$;

-- Grants (function-grant footgun discipline)
REVOKE EXECUTE ON FUNCTION public.set_manager_approve_permission(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_manager_approve_permission(TEXT, BOOLEAN) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_manager_approve_permission(TEXT, BOOLEAN) TO authenticated;


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — approve_vehicle() body change — ADD authority clause
-- ════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE with the new authority gate INSERTED between the
-- role gate (existing) and the load-vehicle step (existing). All
-- other code paths PRESERVED exactly as commit 4a shipped:
--   - role gate (unchanged)
--   - ★ NEW authority gate (manager only; CA bypasses)
--   - load vehicle (unchanged)
--   - ★ scope-check (unchanged — load-bearing; Section E re-verifies)
--   - idempotency (unchanged)
--   - approval UPDATE (unchanged)
--
-- Signature UNCHANGED ((BIGINT, TEXT) → jsonb) → CREATE OR REPLACE
-- in-place safe → no overload trap. Section C verifies pg_proc=1
-- (defensive even though no signature changed).

CREATE OR REPLACE FUNCTION public.approve_vehicle(
  p_vehicle_id   BIGINT,
  p_manager_note TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email           TEXT;
  v_caller_role            TEXT;
  v_caller_company         TEXT;
  v_caller_properties      TEXT[];
  v_caller_can_approve     BOOLEAN;
  v_vehicle                public.vehicles%ROWTYPE;
  v_in_scope               BOOLEAN := FALSE;
  v_updated                public.vehicles%ROWTYPE;
BEGIN
  -- ── 1. Role gate (UNCHANGED from C4a) ──────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  v_caller_role  := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'approve_vehicle requires manager or company_admin role; got ' || v_caller_role
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ★ 2. NEW Authority gate (Piece 1, Migration A)          ║
  -- ║                                                          ║
  -- ║ Manager caller MUST have can_approve_vehicles=TRUE to    ║
  -- ║ approve. company_admin BYPASSES (bill-payer; always      ║
  -- ║ allowed). admin role is NOT in the allowed set above so  ║
  -- ║ unreachable here.                                        ║
  -- ║                                                          ║
  -- ║ The toggle is granted by CA via                          ║
  -- ║ set_manager_approve_permission (Part 2 of this           ║
  -- ║ migration). DEFAULT FALSE on the column means every      ║
  -- ║ existing manager is initially BLOCKED until CA           ║
  -- ║ deliberately grants — matches Jose's "tier-transition    ║
  -- ║ defaults OFF" semantic exactly.                          ║
  -- ║                                                          ║
  -- ║ Note: this clause applies UNIVERSALLY regardless of      ║
  -- ║ company tier. Per Piece 1 §0.7 decision, ONLY PM-Only    ║
  -- ║ companies route vehicles to pending (the helper handles  ║
  -- ║ that app-side), but the authority gate itself is         ║
  -- ║ universal — non-PM managers in a PM-Only company       ║
  -- ║ context still get rejected without the toggle. App-side  ║
  -- ║ tier-gates the UI (button hidden for non-PM-Only         ║
  -- ║ companies entirely; the gate here is the server-side     ║
  -- ║ enforcement that closes any direct-API-call escape).     ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role = 'manager' THEN
    SELECT can_approve_vehicles INTO v_caller_can_approve
      FROM public.user_roles
     WHERE lower(email) = lower(v_caller_email)
     LIMIT 1;
    IF v_caller_can_approve IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'error', 'manager_approval_not_authorized',
        'hint',  'Your manager account does not have approval authority. Contact your company admin to grant it.'
      );
    END IF;
  END IF;

  -- ── 3. Load target vehicle (UNCHANGED from C4a) ────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ★ 4. SCOPE-CHECK (UNCHANGED from C4a — load-bearing)    ║
  -- ║                                                          ║
  -- ║ DEFINER bypasses RLS. The scope-check re-enforces via    ║
  -- ║ CANONICAL helpers:                                       ║
  -- ║   manager:        property ~~* ANY (get_my_properties()) ║
  -- ║   company_admin:  EXISTS properties JOIN via             ║
  -- ║                   get_my_company() ILIKE                 ║
  -- ║                                                          ║
  -- ║ Section E of verification re-runs the C4a scope-check    ║
  -- ║ NEGATIVE — must STILL fire (in-scope manager scoped to   ║
  -- ║ property A attempts vehicle at property B → rejected     ║
  -- ║ with error='vehicle_out_of_scope'; row unmutated).       ║
  -- ║ If E fails post-this-migration, scope-check regressed    ║
  -- ║ during the CREATE OR REPLACE — ABORT.                    ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE p.name ~~* v_vehicle.property
         AND p.company ~~* v_caller_company
    ) INTO v_in_scope;
  END IF;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Idempotency (UNCHANGED from C4a) ─────────────────────────
  IF v_vehicle.status = 'active' AND v_vehicle.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_active',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 6. THE APPROVAL UPDATE (UNCHANGED from C4a) ─────────────────
  UPDATE public.vehicles
     SET is_active     = TRUE,
         status        = 'active',
         resident_read = TRUE,
         manager_note  = p_manager_note
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      TRUE,
    'action',  'approved',
    'vehicle', to_jsonb(v_updated)
  );
END
$func$;

-- Grants UNCHANGED (CREATE OR REPLACE on unchanged signature preserves
-- the existing GRANT EXECUTE TO authenticated from C4a). Defensive
-- re-affirm omitted; Section D verifies grants post-apply.


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Migration audit row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PERMIT_DOOR_FIX',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260628_permit_door_piece1_manager_approve_authority',
    'piece',     'permit-door fixes piece 1 migration A',
    'parts',     jsonb_build_array(
      'user_roles.can_approve_vehicles BOOLEAN NOT NULL DEFAULT FALSE',
      'set_manager_approve_permission(TEXT, BOOLEAN) RPC NEW — mirrors set_driver_regenerate_permission',
      'approve_vehicle() body change — NEW authority gate inserted between role gate and scope-check (manager-only; CA bypasses); C4a scope-check + idempotency PRESERVED'
    ),
    'deploy_ordering', 'Migration A safe to apply BEFORE app deploy. Migration B (vehicles.status default flip) ships AFTER app smoke confirms helper deployed at every vehicle-insert site.',
    'mirror_pattern', 'set_driver_regenerate_permission (Tow-Regen Layer 3) — column + RPC + UI confirm + RPC enforcement',
    'invariants', jsonb_build_object(
      'approve_vehicle_signature', 'UNCHANGED ((bigint, text) → jsonb) — no overload trap',
      'approve_vehicle_scope_check', 'PRESERVED — Section E re-runs C4a NEGATIVE',
      'approve_vehicle_idempotency', 'PRESERVED — noop_already_active branch intact',
      'ca_bypass', 'company_admin always passes authority gate (bill-payer)',
      'admin_bypass', 'admin role rejected at role gate (unchanged); not relevant here'
    ),
    'overload_trap', 'set_manager_approve_permission DROPped IF EXISTS before CREATE; approve_vehicle CREATE OR REPLACE on unchanged signature',
    'grant_footgun', 'set_manager_approve_permission REVOKE PUBLIC+anon + GRANT authenticated; approve_vehicle grants PRESERVED'
  ),
  now()
);

COMMIT;
