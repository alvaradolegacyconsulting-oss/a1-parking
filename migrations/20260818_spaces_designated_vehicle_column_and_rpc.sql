-- ══════════════════════════════════════════════════════════════════════
-- 20260818_spaces_designated_vehicle_column_and_rpc.sql
--
-- Green Acres origin (Yesica Cuero via A1, 2026-08-18): PMs need to
-- designate ONE of a resident's approved vehicles to a specific
-- reserved space. Green Acres built the workaround themselves in
-- space R-1's free-text description ("C90247V Ford F150 ( ONLY )")
-- — first unprompted customer feature request. Mateo greenlit
-- display-only + manager-side tracking; scope locked below.
--
-- 🔴 NON-GOALS — LOAD-BEARING (Chapter 2308 + June 21 spaces lock)
-- These are as important as the goals; do not relax without explicit
-- Mateo sign-off. Any change to these turns this into a very different
-- build.
--
--   ❌ No change to derive_space_allowed_plates
--   ❌ No change to pm_plate_lookup result shape or the driver scan path
--   ❌ No designation data on any driver surface (holds June 21 privacy
--      decision + the B225 data-minimization line)
--   ❌ No resident-portal visibility in v1
--   ❌ No new space type
--
-- Enforcement stays exactly as it is: an authorized plate is authorized
-- at the property, full stop. A vehicle parked in a space it isn't
-- designated for is a management matter handled by the PM under their
-- own policy — never a system-generated tow signal. "Operator" in the
-- customer ask meant tow operator, and that is explicitly not the
-- direction (Jose Aug 18 clarification).
--
-- ENUM PATH REJECTED (mirrors reassign_space DROPPED note pattern at
-- 20260622_spaces_v1_1_multi_resident_schema.sql:159-166 so no future
-- maintainer re-litigates)
--
-- Jose's initial framing was a new space `type` enum value
-- ('restricted' alongside regular/carport/garage/covered/handicap/
-- employee). Rejected because:
--   1. `type` is a physical descriptor of the space (what it IS);
--      designation is a policy about who may use it. Different
--      concerns; one column cannot express both.
--   2. `type` has no DB CHECK (20260621_spaces_v1_schema.sql:103);
--      whitelist lives in the generate_spaces_from_pool RPC at :691-704
--      AND in the TS SPACE_TYPES const at app/lib/spaces.ts:29 which
--      keys 20+ render sites via Record<SpaceType, …> exhaustive-match
--      maps. Enum-add ripples into dashboards, filters, pool-gen,
--      edit selects — ~20 sites need "does this new value belong?".
--   3. Nullable column adds zero exhaustive-match sites; no existing
--      spaces.type reader breaks. Smaller diff, cleaner separation of
--      concerns.
--
-- KEYED ON vehicles.id, NOT plate text
-- approve_plate_change UPDATEs vehicles.plate on the same row
-- (20260703_slice4_vehicle_plate_changes.sql:321), so an id-keyed
-- designation follows plate rotation automatically. A plate-text-keyed
-- designation would silently go stale. Same class as the free-text
-- description workaround this migration retires.
--
-- NULL = today's behavior
-- No default; existing rows carry NULL; enforcement + display continue
-- to behave as they do today. Zero rows migrate, zero readers change.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Column ────────────────────────────────────────────────
ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS designated_vehicle_id BIGINT
    REFERENCES public.vehicles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.spaces.designated_vehicle_id IS
  'Optional pointer to ONE of the tied resident''s approved vehicles that the PM has designated for this space. Display-only manager-side tracking. NULL means "any approved vehicle" (today''s enforcement behavior — unchanged). Keyed on vehicles.id so plate changes follow automatically. NEVER consumed by derive_space_allowed_plates / pm_plate_lookup / driver surfaces (Mateo Aug 18 scope lock). Set/cleared via set_space_designated_vehicle RPC; auto-cleared by 20260818 lifecycle triggers on vehicle deactivate/decline, resident deactivate, and space free.';

-- ── PART 2 — RPC: set_space_designated_vehicle ─────────────────────
-- DEFINER (spaces RLS is scoped per-property; RPC re-enforces scope
-- + adds resident-membership + vehicle-active checks). NULL vehicle_id
-- clears. Audit shape mirrors AUTH_SPACE_ASSIGN / AUTH_SPACE_FREE at
-- 20260622_spaces_v1_1_multi_resident_schema.sql:384-392 / 472-482.
--
-- Membership check reads via space_residents (NEVER
-- assigned_to_resident_email — deprecated by v1.1 lock at
-- 20260622_spaces_v1_1_multi_resident_schema.sql:57-66).
--
-- Scope-gate pattern matches assign_space (allow-list restricts to
-- manager/company_admin; admin excluded by allow-list before
-- comparison — same discipline as the D-9 audit's ✅ SAFE column
-- for the spaces family, see docs/backlog/definer-scope-gate-null-
-- sweep-2026-08-09-D9.md rows 4-8). New RPCs in this class get
-- COALESCE(v_in_scope, false) on the reject as defense-in-depth
-- against the D-9 class regardless.

CREATE OR REPLACE FUNCTION public.set_space_designated_vehicle(
  p_space_id   BIGINT,
  p_vehicle_id BIGINT DEFAULT NULL   -- NULL clears; see header
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_email      TEXT;
  v_caller_role       TEXT;
  v_caller_company    TEXT;
  v_caller_properties TEXT[];
  v_space             public.spaces%ROWTYPE;
  v_in_scope          BOOLEAN;
  v_vehicle           public.vehicles%ROWTYPE;
  v_membership_count  INT;
  v_updated           public.spaces%ROWTYPE;
  v_action_label      TEXT;
BEGIN
  -- ── 1. Auth ────────────────────────────────────────────────────
  v_caller_email := lower(trim(auth.jwt() ->> 'email'));
  IF v_caller_email IS NULL OR length(v_caller_email) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── 2. Role gate (allow-list restricts admin) ─────────────────
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(trim(email)) = v_caller_email
   ORDER BY id DESC LIMIT 1;
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_permitted',
      'hint',  'Only managers or company_admins may designate a vehicle to a space.'
    );
  END IF;

  -- ── 3. Load target space ──────────────────────────────────────
  SELECT * INTO v_space FROM public.spaces WHERE id = p_space_id;
  IF v_space.id IS NULL THEN
    RETURN jsonb_build_object('error', 'space_not_found');
  END IF;
  IF v_space.property IS NULL OR length(trim(v_space.property)) = 0 THEN
    -- D-8/D-9 class defense: no property → cannot verify scope.
    -- Distinct error class; data defect.
    RETURN jsonb_build_object(
      'error', 'space_property_missing',
      'hint',  'Space has no property — cannot verify scope. Data-fix required.'
    );
  END IF;

  -- ── 4. Scope gate ─────────────────────────────────────────────
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := lower(trim(v_space.property)) = ANY(
      SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p
    );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.name))    = lower(trim(v_space.property))
         AND lower(trim(p.company)) = lower(trim(v_caller_company))
    ) INTO v_in_scope;
  END IF;

  IF NOT COALESCE(v_in_scope, false) THEN
    RETURN jsonb_build_object(
      'error', 'space_out_of_scope',
      'hint',  'The space belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Vehicle validation (only when setting; NULL clears) ────
  IF p_vehicle_id IS NULL THEN
    v_action_label := 'cleared';
  ELSE
    SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
    IF v_vehicle.id IS NULL THEN
      RETURN jsonb_build_object('error', 'vehicle_not_found');
    END IF;
    -- Vehicle must be active. A designation on a deactivated /
    -- declined / pending vehicle would misrepresent state; the
    -- lifecycle triggers auto-clear on transition, so the only way
    -- to reach this branch with a non-active vehicle is a manager
    -- explicitly designating one — which is a mistake, reject loudly.
    IF NOT (v_vehicle.is_active = TRUE AND v_vehicle.status = 'active') THEN
      RETURN jsonb_build_object(
        'error', 'vehicle_not_active',
        'hint',  format('Vehicle must be active to be designated; current status=%L, is_active=%s', v_vehicle.status, v_vehicle.is_active)
      );
    END IF;
    -- Vehicle owner must be a tied resident on this space (read via
    -- space_residents, NOT assigned_to_resident_email — deprecated).
    SELECT COUNT(*) INTO v_membership_count
      FROM public.space_residents sr
     WHERE sr.space_id = p_space_id
       AND lower(trim(sr.resident_email)) = lower(trim(COALESCE(v_vehicle.resident_email, '')));
    IF v_membership_count = 0 THEN
      RETURN jsonb_build_object(
        'error', 'vehicle_owner_not_on_space',
        'hint',  'The designated vehicle must belong to one of the residents tied to this space.'
      );
    END IF;
    v_action_label := 'set';
  END IF;

  -- ── 6. THE UPDATE ─────────────────────────────────────────────
  UPDATE public.spaces
     SET designated_vehicle_id = p_vehicle_id
   WHERE id = p_space_id
  RETURNING * INTO v_updated;

  -- ── 7. Audit row ──────────────────────────────────────────────
  INSERT INTO public.audit_logs (
    user_email, action, table_name, record_id, new_values, created_at
  ) VALUES (
    v_caller_email,
    'AUTH_SPACE_DESIGNATE',
    'spaces',
    p_space_id::TEXT,
    jsonb_build_object(
      'action',                v_action_label,       -- 'set' | 'cleared'
      'space_id',              p_space_id,
      'space_label',           v_updated.label,
      'property',              v_updated.property,
      'designated_vehicle_id', p_vehicle_id,
      'designated_plate',      CASE WHEN v_vehicle.id IS NOT NULL THEN v_vehicle.plate ELSE NULL END,
      'caller_role',           v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',     TRUE,
    'action', v_action_label,
    'space',  to_jsonb(v_updated)
  );
END;
$function$;

COMMENT ON FUNCTION public.set_space_designated_vehicle(BIGINT, BIGINT) IS
  'DEFINER RPC for manager/CA-initiated space designation. Sets or clears spaces.designated_vehicle_id. NULL vehicle_id clears. Manager: scope via get_my_properties(); company_admin: scope via get_my_company() JOIN properties. Vehicle must be is_active=TRUE + status=active AND its resident_email must appear in space_residents for this space (v1.1 model — not assigned_to_resident_email which is deprecated). Audit action AUTH_SPACE_DESIGNATE with action=set|cleared in new_values. Display-only feature — nothing about this RPC changes derive_space_allowed_plates, pm_plate_lookup, or any driver surface (Mateo Aug 18 scope lock). Grants: authenticated EXECUTE; anon REVOKED. 2026-08-18.';

-- Grants: authenticated-only. Same discipline as approve_vehicle /
-- deactivate_vehicle.
REVOKE ALL     ON FUNCTION public.set_space_designated_vehicle(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.set_space_designated_vehicle(BIGINT, BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_space_designated_vehicle(BIGINT, BIGINT) TO   authenticated;

-- ── PART 3 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_SPACES_DESIGNATED_VEHICLE_COLUMN_AND_RPC',
  'public.spaces + public.set_space_designated_vehicle',
  'designated_vehicle',
  jsonb_build_object(
    'migration',    '20260818_spaces_designated_vehicle_column_and_rpc',
    'commit',       '1 of 5 (column + RPC only; lifecycle triggers in commit 2)',
    'column_shape', 'designated_vehicle_id BIGINT NULL REFERENCES vehicles(id) ON DELETE SET NULL',
    'rpc_action',   'AUTH_SPACE_DESIGNATE',
    'scope_lock',   'display-only; no change to derive_space_allowed_plates / pm_plate_lookup / driver surfaces',
    'origin',       'Green Acres AM Yesica Cuero via A1 — first unprompted customer feature request',
    'workaround_being_retired', 'R-1 description free-text "PLATE Ford F150 ( ONLY )" pattern'
  )
);

COMMIT;
