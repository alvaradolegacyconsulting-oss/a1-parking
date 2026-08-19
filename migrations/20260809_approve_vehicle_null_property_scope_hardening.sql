-- ══════════════════════════════════════════════════════════════════════
-- 20260809_approve_vehicle_null_property_scope_hardening.sql
--
-- Mateo Aug 9 Item 2 sibling fix — approve_vehicle P1 authority-scope
-- bypass, direct copy-paste of the deactivate_vehicle class.
--
-- ROOT CAUSE
-- Manager-branch scope check at
-- 20260628_permit_door_piece1_manager_approve_authority.sql:341:
--   v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);
-- Postgres 3-valued logic (same as `IN (...)`):
--   NULL ~~* ANY(text[])            →  NULL
--   NOT NULL                         →  NULL
--   IF NULL THEN reject END IF;      →  branch SKIPPED
-- So when v_vehicle.property IS NULL, v_in_scope becomes NULL, the
-- error branch is skipped, and the UPDATE runs — activating an
-- unauthorized vehicle. Same failure mode as deactivate_vehicle
-- discovered by D-8, opposite direction (activate vs deactivate).
--
-- Company_admin branch at :347-351 uses SELECT EXISTS(...) which is
-- boolean-not-null; the JOIN on `p.name ~~* NULL` returns NULL for
-- every row → 0 matches → EXISTS returns FALSE → correctly rejects.
-- Layer 1 (property presence gate) runs BEFORE the branching, so it
-- protects both branches uniformly. Layer 2 (COALESCE on the shared
-- v_in_scope decision) is belt-and-braces for both branches.
--
-- FIX (same two-layer hardening as deactivate_vehicle)
--
--   Layer 1 — reject NULL/blank property up front, before scope check:
--     IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0
--       THEN return distinct error 'vehicle_property_missing'
--     END IF;
--   `property_missing` and `out_of_scope` are DIFFERENT failure
--   classes (per Mateo Aug 9) — one is a data defect that needs a
--   fix in the row, the other is legitimate scope refusal. They must
--   surface distinctly so ops takes the right action.
--
--   Layer 2 — COALESCE the scope flag on the IF check:
--     IF NOT COALESCE(v_in_scope, false) THEN reject END IF;
--   Defense-in-depth against future columns added to the scope check
--   that could return NULL. Fails CLOSED rather than open.
--
-- 🔴 SIGNATURE PRESERVATION (Mateo Aug 9)
-- Production carries `p_manager_note TEXT DEFAULT NULL::text`
-- (verified 2026-08-09 via pg_get_function_arguments). CREATE OR
-- REPLACE FUNCTION replaces the ENTIRE definition including parameter
-- DEFAULTs — omitting the default here would silently break
-- one-arg callers with 42883 "function does not exist" at call time,
-- no earlier signal. Preserved below.
--
-- See [[feedback_create_or_replace_drops_defaults]] for the rule.
-- ALL other pre-existing behavior in this function (role gate,
-- authority gate for managers, idempotency, UPDATE shape, RETURNING)
-- is preserved EXACTLY as the 20260628 install landed it.
--
-- CASCADE / DOWNSTREAM
-- No behavior change for well-formed rows (property populated + in
-- scope). For NULL-property rows: was `success` (bad — unauthorized
-- activation), now `error: vehicle_property_missing`. TypeScript
-- writer's existing error-passthrough surfaces "Vehicle has no
-- property — cannot verify scope. Data-fix required." to the manager.
--
-- APPLY: Apply once (single database — Test Legacy is a tenant inside
-- the production database, not a separate environment). CREATE OR
-- REPLACE is live for A1 the moment it runs. Tenant-scoped step is
-- the EXERCISE afterward: verify with the paired v2 returns-rows
-- migration, then probe from a Test Legacy manager session before
-- relying on the surface. "Test Legacy first, then production"
-- wording treats this as an environment gate; it isn't (Mateo Aug 19
-- correction).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.approve_vehicle(
  p_vehicle_id   BIGINT,
  p_manager_note TEXT DEFAULT NULL   -- 🔴 preserved verbatim from 20260628 install
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
  -- ── 1. Role gate (UNCHANGED from 20260628 install) ──────────────
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

  -- ── 2. Authority gate (UNCHANGED from 20260628 install) ─────────
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

  -- ── 3. Load target vehicle (UNCHANGED from 20260628 install) ────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ── 3b. Property presence gate (Mateo Aug 9 Item 2, Layer 1) ────
  -- Distinct error class BEFORE the scope check — runs before the
  -- role branching, so it protects both manager and company_admin
  -- branches uniformly. A NULL-property vehicle cannot have its scope
  -- verified; treat as a data defect that needs manual attention,
  -- NOT as an out-of-scope refusal. `property_missing` and
  -- `out_of_scope` are different failure classes with different fixes.
  IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_property_missing',
      'hint',  'Vehicle has no property — cannot verify scope. Data-fix required.'
    );
  END IF;

  -- ── 4. Scope-check (UNCHANGED from 20260628 install) ────────────
  -- DEFINER bypasses RLS. Scope-check re-enforces via canonical
  -- helpers (get_my_properties / get_my_company). Section E of the
  -- 20260628 verification re-runs this — must still fire.
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

  -- ── 4b. Scope decision (Mateo Aug 9 Item 2, Layer 2) ─────────────
  -- COALESCE the flag so any future column added to the scope check
  -- that could return NULL will fail CLOSED rather than open. Belt-
  -- and-suspenders alongside the Layer-1 property presence gate.
  -- Applies uniformly to both manager and company_admin branches.
  IF NOT COALESCE(v_in_scope, false) THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Idempotency (UNCHANGED from 20260628 install) ─────────────
  IF v_vehicle.status = 'active' AND v_vehicle.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_active',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 6. THE APPROVAL UPDATE (UNCHANGED from 20260628 install) ────
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

COMMENT ON FUNCTION public.approve_vehicle(BIGINT, TEXT) IS
  'DEFINER RPC for manager/CA-initiated vehicle approval. Manager caller MUST have can_approve_vehicles=TRUE (authority gate, Piece 1); CA bypasses. Scope-check via get_my_properties (manager, ~~* ANY) and get_my_company (CA, EXISTS). Idempotency: already-active vehicles return noop. 2026-08-09 Item 2 hardening (sibling of deactivate_vehicle): (a) explicit vehicle_property_missing error class before scope check (Layer 1), (b) COALESCE(v_in_scope, false) on the scope decision (Layer 2). Signature preserved with p_manager_note DEFAULT NULL. Grants: authenticated EXECUTE; anon REVOKED. Installed 20260628; hardened 2026-08-09.';

-- Grants preserved by CREATE OR REPLACE. Defensive re-affirm below.
REVOKE ALL     ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) TO   authenticated;

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_APPROVE_VEHICLE_NULL_PROPERTY_HARDENING',
  'public.approve_vehicle(BIGINT,TEXT)',
  'approve_vehicle',
  jsonb_build_object(
    'migration', '20260809_approve_vehicle_null_property_scope_hardening',
    'layer_1',   'vehicle_property_missing error before scope check',
    'layer_2',   'COALESCE(v_in_scope, false) on scope decision',
    'root_cause','NULL ~~* ANY(text[]) → NULL → IF NOT NULL THEN skips branch',
    'sibling_of','deactivate_vehicle hardening (20260809_deactivate_vehicle_null_property_scope_hardening)',
    'defaults_preserved', 'p_manager_note TEXT DEFAULT NULL'
  )
);

COMMIT;
