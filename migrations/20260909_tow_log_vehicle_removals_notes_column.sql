-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_vehicle_removals_notes_column.sql
--
-- 🟢 Tow Log arc — extension: `notes` column on vehicle_removals +
--    record_vehicle_removal signature expanded 14 → 15 args.
--
-- ── WHY ─────────────────────────────────────────────────────────────
-- Per DECISION_tow_log_is_a_log_sept9_2026 (feedback_tow_log_is_a_log_
-- not_enforcement), the tow log needs an INTERNAL narrative field
-- distinct from `reason_notes`. They answer different questions and
-- cramming both into one field means the Monday reader can't tell
-- which they're looking at.
--
--   reason_notes  — clarifies WHY the tow happened. Carries the
--                   required explanation when reason_code = 'other'.
--                   Ties directly to the enumerated reason.
--
--   notes         — WHAT happened. Manager-only narrative:
--                     "Called the resident, no answer. Vehicle left
--                      unattended in the handicap space. Steve at
--                      ABC said he's taking it to their usual lot
--                      but call Monday to confirm."
--                   NEVER surfaced to residents or vehicle owners.
--                   Records what someone said, not published fact.
--
-- ── SIGNATURE CHANGE — 14 → 15 args ─────────────────────────────────
-- 🔴 CREATE OR REPLACE on a signature with an ADDITIONAL default-
-- having parameter creates an OVERLOAD, not a replacement. If both
-- signatures remain, PostgREST sees ambiguous candidates when the
-- client omits p_notes and calls silently fail (or route to the
-- wrong overload). DROP FUNCTION on the 14-arg form is REQUIRED
-- before creating the 15-arg.
--
-- Verification asserts the 14-arg is GONE (to_regprocedure returns
-- NULL) as well as the 15-arg present. If both existed after apply,
-- verification fails and the ambiguity was caught before it silently
-- broke client calls.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Report-first → eyeball → apply (Jose) → verify.
-- Wraps in BEGIN/COMMIT. The DROP + CREATE + column-add live in one
-- atomic transaction so a partial-apply can't leave the RPC missing
-- while the client is on the new 15-arg call shape.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — Add `notes` column
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.vehicle_removals
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;

COMMENT ON COLUMN public.vehicle_removals.notes IS
  'Internal manager-only narrative. Distinct from reason_notes (which clarifies reason_code and is required when reason_code = ''other''). Never surfaced to residents or vehicle owners — see DECISION_tow_log_is_a_log_sept9_2026. Where a PM records what they were told, recorded as something someone said rather than published as fact.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — 🔴 DROP the 14-arg record_vehicle_removal (overload trap)
-- ══════════════════════════════════════════════════════════════════════
-- Full type list must match the shipped signature verbatim. If any
-- type is off, DROP FUNCTION IF EXISTS silently no-ops and the 14-arg
-- persists alongside the 15-arg — verification's VS2 catches this,
-- but drop-must-hit is the primary defense.
DROP FUNCTION IF EXISTS public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — CREATE the 15-arg record_vehicle_removal
-- ══════════════════════════════════════════════════════════════════════
-- p_notes appended at the end with DEFAULT NULL. Body is byte-for-byte
-- Commit 4's function body with two additions:
--   • INSERT column list gains `notes`
--   • audit payload includes `notes` for the recorded value
-- Everything else — auth/role/tier/validation/scope/write shape —
-- unchanged.
CREATE OR REPLACE FUNCTION public.record_vehicle_removal(
  p_property             TEXT,
  p_plate                TEXT,
  p_reason_code          TEXT,
  p_towed_at             TIMESTAMPTZ,
  p_authorized_by_email  TEXT,
  p_tow_operator_id      BIGINT,
  p_plate_state          TEXT        DEFAULT NULL,
  p_make                 TEXT        DEFAULT NULL,
  p_model                TEXT        DEFAULT NULL,
  p_color                TEXT        DEFAULT NULL,
  p_reason_notes         TEXT        DEFAULT NULL,
  p_space_id             BIGINT      DEFAULT NULL,
  p_authorized_by_name   TEXT        DEFAULT NULL,
  p_removal_type         TEXT        DEFAULT 'tow',
  p_notes                TEXT        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_company            TEXT;
  v_property_id        BIGINT;
  v_operator           tow_operators%ROWTYPE;
  v_linked_vehicle_id  BIGINT;
  v_new_id             BIGINT;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role ────────────────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Tier (super-admin bypass FIRST) ─────────────────────────────
  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Vehicle-removal recording is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Validation ─────────────────────────────────────────────────
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;
  IF p_plate IS NULL OR length(trim(p_plate)) = 0
     OR length(normalize_plate(p_plate)) = 0 THEN
    RETURN jsonb_build_object('error', 'plate_required');
  END IF;
  IF p_reason_code IS NULL OR length(trim(p_reason_code)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_code_required');
  END IF;
  IF p_towed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'towed_at_required');
  END IF;
  IF p_towed_at > now() + interval '5 minutes' THEN
    RETURN jsonb_build_object('error', 'towed_at_future');
  END IF;
  IF p_authorized_by_email IS NULL OR length(trim(p_authorized_by_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'authorized_by_email_required');
  END IF;
  IF p_tow_operator_id IS NULL THEN
    RETURN jsonb_build_object('error', 'tow_operator_id_required');
  END IF;
  IF p_removal_type NOT IN ('tow', 'boot', 'relocation') THEN
    RETURN jsonb_build_object('error', 'invalid_removal_type');
  END IF;

  -- ── Company + property scope + property_id resolution ──────────
  IF v_caller_role = 'admin' THEN
    SELECT p.id, p.company
      INTO v_property_id, v_company
      FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(p_property));
    IF v_property_id IS NULL THEN
      RETURN jsonb_build_object('error', 'property_not_found');
    END IF;
  ELSE
    v_company := get_my_company();
    IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
      RETURN jsonb_build_object('error', 'no_company_context');
    END IF;

    IF v_caller_role = 'manager' AND NOT EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) x
       WHERE lower(trim(x)) = lower(trim(p_property))
    ) THEN
      RETURN jsonb_build_object('error', 'property_not_authorized_for_manager');
    END IF;

    SELECT p.id INTO v_property_id
      FROM public.properties p
     WHERE lower(trim(p.name))    = lower(trim(p_property))
       AND lower(trim(p.company)) = lower(trim(v_company));
    IF v_property_id IS NULL THEN
      RETURN jsonb_build_object('error', 'property_not_found');
    END IF;
  END IF;

  -- ── Load tow_operator + verify active + within company ─────────
  SELECT * INTO v_operator
    FROM public.tow_operators
   WHERE id = p_tow_operator_id;
  IF v_operator.id IS NULL THEN
    RETURN jsonb_build_object('error', 'tow_operator_not_found');
  END IF;
  IF v_operator.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('error', 'tow_operator_inactive');
  END IF;
  IF v_caller_role <> 'admin'
     AND lower(trim(v_operator.company)) <> lower(trim(v_company)) THEN
    RETURN jsonb_build_object('error', 'tow_operator_out_of_scope');
  END IF;

  -- ── Soft-link resolution ───────────────────────────────────────
  SELECT v.id INTO v_linked_vehicle_id
    FROM public.vehicles v
   WHERE normalize_plate(v.plate) = normalize_plate(p_plate)
     AND lower(trim(v.property))  = lower(trim(p_property))
     AND v.is_active              = true
   LIMIT 1;

  -- ── Write ──────────────────────────────────────────────────────
  -- Column list now includes `notes` (15-arg version).
  INSERT INTO public.vehicle_removals (
    company, property, property_id, removal_type,
    plate, plate_state, make, model, color, linked_vehicle_id,
    reason_code, reason_notes, space_id,
    towed_at,
    authorized_by_email, authorized_by_name,
    tow_operator_id, operator_name, operator_phone,
    notes,
    recorded_by_email
  ) VALUES (
    trim(v_company),
    trim(p_property),
    v_property_id,
    p_removal_type,
    p_plate,
    NULLIF(trim(p_plate_state), ''),
    NULLIF(trim(p_make),        ''),
    NULLIF(trim(p_model),       ''),
    NULLIF(trim(p_color),       ''),
    v_linked_vehicle_id,
    trim(p_reason_code),
    NULLIF(trim(p_reason_notes), ''),
    p_space_id,
    p_towed_at,
    lower(trim(p_authorized_by_email)),
    NULLIF(trim(p_authorized_by_name), ''),
    p_tow_operator_id,
    v_operator.name,
    v_operator.phone,
    NULLIF(trim(p_notes), ''),
    lower(v_caller_email)
  )
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────────
  -- Payload now includes `notes` for the recorded value (nullable —
  -- absent means the internal notes field was not populated).
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VEHICLE_REMOVAL_RECORDED',
    'vehicle_removals',
    v_new_id::text,
    jsonb_build_object(
      'company',              v_company,
      'property',             p_property,
      'property_id',          v_property_id,
      'plate',                normalize_plate(p_plate),
      'removal_type',         p_removal_type,
      'reason_code',          p_reason_code,
      'towed_at',             p_towed_at,
      'tow_operator_id',      p_tow_operator_id,
      'tow_operator_name',    v_operator.name,
      'authorized_by_email',  lower(trim(p_authorized_by_email)),
      'authorized_by_name',   NULLIF(trim(p_authorized_by_name), ''),
      'linked_vehicle_id',    v_linked_vehicle_id,
      'notes',                NULLIF(trim(p_notes), ''),
      'recorded_by_role',     v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TOW_LOG_VEHICLE_REMOVALS_NOTES_COLUMN',
  'public.vehicle_removals',
  'notes_column_and_15_arg_rpc',
  jsonb_build_object(
    'migration', '20260909_tow_log_vehicle_removals_notes_column',
    'arc',       'Tow Log — extension: notes column + record_vehicle_removal 14 → 15 args',
    'depends_on', jsonb_build_array(
      'Commit 3 (8617c22) — vehicle_removals + vehicle_removal_media',
      'Commit 4 (e991c7a) — 3 DEFINER RPCs'
    ),
    'schema_changes', jsonb_build_array(
      'ADDED COLUMN public.vehicle_removals.notes TEXT NULL',
      'DROPPED FUNCTION public.record_vehicle_removal(14 args)',
      'CREATED FUNCTION public.record_vehicle_removal(15 args) — p_notes appended',
      'GRANT EXECUTE TO authenticated only (REVOKED from PUBLIC + anon)'
    ),
    'why_two_note_fields', 'reason_notes clarifies WHY (required when reason_code=other). notes = WHAT happened, internal narrative. Cramming both into one field means the Monday reader can''t tell which they''re looking at. See DECISION_tow_log_is_a_log_sept9_2026 + feedback_tow_log_is_a_log_not_enforcement.',
    'overload_trap', 'CREATE OR REPLACE on a signature with an additional default-having param creates an OVERLOAD, not a replacement. Explicit DROP FUNCTION on the 14-arg form REQUIRED before CREATE — otherwise PostgREST sees ambiguous candidates when the client omits p_notes. VS2 of verification asserts the 14-arg is GONE.',
    'body_delta',    'Function body byte-for-byte identical to Commit 4 except: INSERT column list gains notes; audit payload gains notes. Auth/role/tier/validation/scope/write shape unchanged.',
    'not_in_commit', 'Commit 5 (mobile screen + tow-log-writes.ts) is a separate arc; execution gates E12-E22 + E30-E50 land after this migration applies so the signature is final.',
    'boundary_reminder', 'Per DECISION_tow_log_is_a_log_sept9_2026: notes is INTERNAL manager-only. Never surface to residents or vehicle owners. Field asserts what someone said, not published fact.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — PostgREST schema cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;
