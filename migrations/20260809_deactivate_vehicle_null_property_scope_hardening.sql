-- ══════════════════════════════════════════════════════════════════════
-- 20260809_deactivate_vehicle_null_property_scope_hardening.sql
--
-- Mateo Aug 9 Item 2 (P1 authority-scope bypass).
--
-- Fixes: `deactivate_vehicle` RPC scope-gate silently passes NULL-property
-- vehicles.
--
-- ROOT CAUSE
-- The manager-branch scope check at 20260806_deactivate_vehicle_rpc.sql:138
-- assigns v_in_scope from `IN (SELECT ...)`. Postgres 3-valued logic:
--   `NULL IN (list of non-null strings)`  →  NULL   (not false)
--   `NOT NULL`                             →  NULL
--   `IF NULL THEN reject END IF;`          →  branch skipped
-- So when `v_vehicle.property IS NULL`, v_in_scope becomes NULL, the
-- error branch is skipped, and the UPDATE proceeds. Same shape at the
-- company_admin branch (`SELECT EXISTS(...) INTO v_in_scope` — EXISTS
-- returns boolean not-null, but the JOIN on `lower(trim(NULL))` still
-- returns FALSE for the row, which is correct — the vulnerable path
-- is only the manager IN-list). Fixing both branches uniformly for
-- defense-in-depth AND ergonomic parity.
--
-- Discovered by D-8 probe of the deactivation-email arc:
-- `UPDATE vehicles SET property = NULL WHERE plate = 'PD0004'` +
-- Deactivate → RPC UPDATE succeeded when it should have returned
-- `vehicle_out_of_scope`.
--
-- FIX (two-layer hardening)
--
--   Layer 1 — reject NULL/blank property up front, before scope check:
--     IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0
--       THEN return distinct error 'vehicle_property_missing' with hint
--     END IF;
--   Gives an explicit error class (rather than the generic
--   vehicle_out_of_scope) — different failure = different label.
--
--   Layer 2 — COALESCE the scope flag on the IF check:
--     IF NOT COALESCE(v_in_scope, false) THEN reject END IF;
--   Defense-in-depth: any future column added to the scope check that
--   could return NULL will fail closed rather than open. Applied to
--   both manager and company_admin branches uniformly.
--
-- SIBLING RPCS
-- See docs/backlog/vehicles-property-nullability-and-rpc-scope-bypass.md
-- for the DEFINER-RPC scope-gate enumeration. Any RPC found with the
-- same pattern needs the same treatment (this migration is
-- deactivate_vehicle only).
--
-- CASCADE / DOWNSTREAM
-- No behavior change for well-formed rows (property populated + in scope).
-- For NULL-property rows: was `success` (bad), now `error:
-- vehicle_property_missing`. TypeScript writer maps this via existing
-- `if (!result || result.error)` → returns `{ok:false, reason:'rpc_error',
-- message: result.hint ?? result.error}`. Manager sees "Vehicle has no
-- property — cannot verify scope. Data-fix required." rather than a
-- silent successful deactivation.
--
-- APPLY: Apply once (single database — Test Legacy is a tenant inside
-- the production database, not a separate environment). CREATE OR
-- REPLACE is live for A1 the moment it runs. Tenant-scoped step is
-- the EXERCISE afterward: verify with the paired migration + probe
-- from a Test Legacy manager session before relying on the surface.
-- Wording earlier read as "apply first at Test Legacy, then
-- production" which treats it as an environment gate — it isn't
-- (Mateo Aug 19 correction).
--
-- 🔴 SIGNATURE PRESERVATION (Mateo Aug 9)
-- CREATE OR REPLACE FUNCTION replaces the ENTIRE function definition,
-- including parameter DEFAULTS. Production's deactivate_vehicle has
-- `p_note TEXT DEFAULT NULL::text` — the 20260806 install carried
-- that default (visible in pg_get_function_arguments) and any caller
-- passing only two args relies on it. If a re-definition drops the
-- default, two-arg callers break silently at call time with
-- 42883 "function deactivate_vehicle(bigint, text) does not exist".
-- Preserved below with `p_note TEXT DEFAULT NULL`.
--
-- Rule for every future re-definition of any DEFINER RPC in this tree:
--   1. Query `pg_get_function_arguments(<oid>)` on production FIRST
--      to capture the exact args-with-defaults string.
--   2. Copy that shape verbatim into the CREATE OR REPLACE signature.
--   3. Use CREATE OR REPLACE (grants preserved), NOT DROP + CREATE.
--   4. If DROP is ever genuinely unavoidable (return-type change,
--      arg-type change), the migration MUST re-issue REVOKE ALL FROM
--      PUBLIC + REVOKE ALL FROM anon + GRANT EXECUTE TO authenticated
--      in the same transaction. Then re-run the verification file.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.deactivate_vehicle(
  p_vehicle_id BIGINT,
  p_reason     TEXT,
  p_note       TEXT DEFAULT NULL   -- preserved from 20260806 install; see header
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_caller_properties  TEXT[];
  v_caller_company     TEXT;
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN;
  v_updated            public.vehicles%ROWTYPE;
  v_system_codes       TEXT[] := ARRAY['cascade_resident_deactivated','owner_trim','admin_cascade'];
BEGIN
  -- ── 1. Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.email();
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── 2. Role gate ───────────────────────────────────────────────────
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(trim(email)) = lower(trim(v_caller_email))
   ORDER BY id DESC LIMIT 1;
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'no_role',
      'hint',  'No role row for the calling email.'
    );
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_permitted',
      'hint',  'Only managers or company_admins may deactivate vehicles.'
    );
  END IF;
  IF v_caller_role = 'manager' THEN
    IF NOT COALESCE((
      SELECT can_approve_vehicles FROM public.user_roles
        WHERE lower(trim(email)) = lower(trim(v_caller_email))
        ORDER BY id DESC LIMIT 1
    ), false) THEN
      RETURN jsonb_build_object(
        'error', 'authority_not_permitted',
        'hint',  'This manager account lacks vehicle-approval authority.'
      );
    END IF;
  END IF;

  -- ── 3. Load target vehicle ─────────────────────────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ── 3b. Property presence gate (Mateo Aug 9 Item 2, Layer 1) ───
  -- Distinct error class BEFORE the scope check. A NULL-property
  -- vehicle cannot have its scope verified in either branch; treat
  -- it as a data defect that needs manual attention, NOT as an
  -- out-of-scope refusal.
  IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_property_missing',
      'hint',  'Vehicle has no property — cannot verify scope. Data-fix required.'
    );
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

  -- ── 4b. Scope decision (Mateo Aug 9 Item 2, Layer 2) ─────────────
  -- COALESCE the flag so any future column added to the scope check
  -- that could return NULL will fail CLOSED rather than open. Belt-
  -- and-suspenders alongside the Layer-1 property presence gate.
  IF NOT COALESCE(v_in_scope, false) THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Reason gate (presence + note-required + system-code reject) ──
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF trim(p_reason) = ANY(v_system_codes) THEN
    RETURN jsonb_build_object(
      'error', 'system_reason_not_permitted',
      'hint',  format('%L is a system-only cascade code; managers must not select it.', p_reason)
    );
  END IF;
  IF trim(p_reason) = 'other' THEN
    IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
      RETURN jsonb_build_object('error', 'note_required_when_reason_other');
    END IF;
  END IF;

  -- ── 6. Already-deactivated shortcut ───────────────────────────────
  IF v_vehicle.is_active = false THEN
    RETURN jsonb_build_object(
      'ok',     true,
      'action', 'already_deactivated',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 7. THE DEACTIVATION UPDATE ──────────────────────────────────
  UPDATE public.vehicles
     SET is_active           = false,
         status              = 'deactivated',
         deactivation_reason = trim(p_reason),
         deactivation_note   = NULLIF(trim(COALESCE(p_note, '')), ''),
         deactivated_by      = v_caller_email,
         deactivated_at      = now()
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      true,
    'action',  'deactivated',
    'vehicle', to_jsonb(v_updated)
  );
END;
$function$;

COMMENT ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) IS
  'DEFINER RPC for manager-initiated vehicle deactivation. Symmetric to approve_vehicle with two deliberate divergences: (1) authority gate on can_approve_vehicles for managers (subtractive action requires permit authority per Task 1 lock 2026-08-04); (2) scope uses lower(trim(...)) not ILIKE (strictest of the three property-matching conventions in tree). Reason validation: presence + note-required-when-other + system-code rejection. TS module (app/lib/deactivation-reasons.ts) owns the vocabulary. Closes the render-side-only gap from 1c1ce5a. CASCADES NONE. Grants: authenticated EXECUTE; anon REVOKED. 2026-08-09 Item 2 hardening: (a) explicit vehicle_property_missing error class before scope check (Layer 1), (b) COALESCE(v_in_scope, false) on the scope decision (Layer 2). Installed 2026-08-06; hardened 2026-08-09.';

-- Grants preserved from original migration.
REVOKE ALL     ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) TO   authenticated;

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_DEACTIVATE_VEHICLE_NULL_PROPERTY_HARDENING',
  'public.deactivate_vehicle(BIGINT,TEXT,TEXT)',
  'deactivate_vehicle',
  jsonb_build_object(
    'migration', '20260809_deactivate_vehicle_null_property_scope_hardening',
    'layer_1',   'vehicle_property_missing error before scope check',
    'layer_2',   'COALESCE(v_in_scope, false) on scope decision',
    'root_cause','NULL IN (list) → NULL → IF NOT NULL THEN skips branch',
    'discovered_by', 'deactivation-email arc D-8 probe (2026-08-09)'
  )
);

COMMIT;
