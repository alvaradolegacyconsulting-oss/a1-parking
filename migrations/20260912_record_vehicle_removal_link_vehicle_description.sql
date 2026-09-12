-- ══════════════════════════════════════════════════════════════════════
-- 20260912_record_vehicle_removal_link_vehicle_description.sql
--
-- Fills plate_state / make / model / color from the linked vehicle.
-- UAT finding 2026-09-12: those four columns exist on vehicle_removals,
-- are accepted by the RPC, and appear in the CSV export — but the create
-- screen had no inputs for them, so they were ALWAYS EMPTY. Four blank
-- columns in a file a property manager sends a tow operator.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────
-- The soft-link SELECT already found the vehicles row to populate
-- linked_vehicle_id. It now captures the whole row and copies the four
-- description fields into the removal's own columns when the caller did
-- not supply them.
--
-- 🔴 CALLER WINS. COALESCE(NULLIF(trim(p_x), ''), v_linked.x) — a typed
-- value is never overwritten. The person standing in front of the car is
-- better evidence than a registration that may be stale.
--
-- 🔴 SNAPSHOT, NOT JOIN. Same discipline as operator_name/phone: the
-- record says how the vehicle was described AT THE TIME. Rendering these
-- through linked_vehicle_id at display time would let a resident editing
-- their vehicle silently rewrite what the log says was towed — and
-- linked_vehicle_id is nullable regardless.
--
-- ── WHAT THIS DOES NOT FIX ──────────────────────────────────────────
-- The walk-in case, which is the scenario the feature exists for: an
-- unregistered visitor in a handicap space has no vehicles row, the link
-- does not resolve, and these four stay empty. That needs inputs on the
-- create screen — shipped in the same commit as a collapsed "Add vehicle
-- details" section. There is NO edit path, so anything not captured at
-- creation is lost permanently; that is the argument for the create
-- screen rather than a desktop edit that does not exist.
--
-- ── SIGNATURE: UNCHANGED ────────────────────────────────────────────
-- CREATE OR REPLACE on the SAME 15-arg signature. All nine parameter
-- defaults re-typed verbatim (CREATE OR REPLACE drops any omitted —
-- feedback_create_or_replace_drops_defaults). No DROP, no overload risk,
-- and 20260909_tow_log_commit_4_rpcs_verification.sql's VS1/VS1b still
-- hold.
--
-- ⚠ The four p_* parameters are ASSIGNED TO inside the body. plpgsql
-- allows that — parameters are local variables — and it keeps the INSERT
-- column list untouched. Noted because it reads oddly at a glance.
--
-- 🔴 prosrc DISCIPLINE PRESERVED: the body still contains
-- normalize_plate(v.plate) exactly once and the p_plate form zero times.
-- Asserted mechanically before commit; VS4 of
-- 20260910_record_vehicle_removal_plate_normalize_fix_verification.sql
-- enforces it.
--
-- ── STATUS: APPLIED 2026-09-12 ──────────────────────────────────────
-- ⚠ APPLIED WITHOUT A PAIRED VERIFICATION — the first migration in this
-- project to do so. Not a problem in itself: it is a function body, no
-- schema change, and it is verifiable retroactively. Recorded here
-- rather than left for the next reader to infer from audit_logs.
--
-- The paired file landed after the fact:
--   20260912_record_vehicle_removal_link_vehicle_description_verification.sql
-- Its load-bearing gate is P1, the caller-wins precedence — swapping the
-- COALESCE arguments below would still fill every column, so a gate that
-- only asserts non-null goes green on the inverted version while a stale
-- registration silently overwrites what a manager typed.
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

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
  v_plate_norm         TEXT;
  v_linked             vehicles%ROWTYPE;
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

  -- ── Plate normalization — ONCE, here, for every downstream use ──
  -- Same character set the vehicle_removals BEFORE-write trigger uses.
  -- Validation MUST track that trigger, not the whitespace-only server
  -- normalizer: a punctuation-only plate is non-empty under the latter
  -- and empty under the former, which is exactly the gap that let a
  -- raw SQLSTATE reach a manager on Sept 9. See COMMENT ON FUNCTION
  -- below for the full contract.
  v_plate_norm := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));

  -- ── Validation ─────────────────────────────────────────────────
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;
  IF length(v_plate_norm) = 0 THEN
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
  -- 🔴 ASYMMETRIC ON PURPOSE. The v.plate side keeps the whitespace-
  -- only server normalizer so this expression stays identical to
  -- vehicles_plate_norm_uniq and the index remains usable. The input
  -- side is already aggressively normalized above, so a caller-
  -- supplied 'AB-123' now meets a stored 'AB123'. Do NOT "harmonize"
  -- the two sides — see the migration header, and the fenced
  -- consolidation note at 20260909_tow_log_vehicle_removals.sql:127.
  --
  -- RESIDUAL (upstream, not fixable here): if a vehicles row itself
  -- holds punctuation — written by some path that skipped the client
  -- normalizer — the stored side normalizes to 'AB-123' and this still
  -- misses. vehicles is the one plate table with no normalizer
  -- trigger; a BEFORE-write trigger there is the durable fix and is
  -- filed alongside the company-derivation trigger. A NULL
  -- linked_vehicle_id is a soft outcome by design, never an error.
  SELECT * INTO v_linked
    FROM public.vehicles v
   WHERE normalize_plate(v.plate) = v_plate_norm
     AND lower(trim(v.property))  = lower(trim(p_property))
     AND v.is_active              = true
   LIMIT 1;
  v_linked_vehicle_id := v_linked.id;

  -- ── Vehicle description — SNAPSHOT, caller wins ─────────────────
  -- When the soft link resolves, fill plate_state/make/model/colour
  -- from the vehicles row. Four columns that were in the table, in the
  -- RPC and in the CSV export but had no input on the create screen, so
  -- they were always empty — four blank columns in a file a PM hands an
  -- operator (UAT 2026-09-12).
  --
  -- 🔴 THE CALLER WINS. COALESCE puts the typed value first: the person
  -- standing in front of the car is better evidence than a registration
  -- that may be stale. Only an OMITTED field falls back to the link.
  --
  -- 🔴 SNAPSHOT, NOT JOIN — same discipline as operator_name and
  -- operator_phone. The record says how the vehicle was described AT
  -- THE TIME. A resident editing their vehicle later, or the row being
  -- deactivated, must not rewrite what the log says was towed. Reading
  -- these through linked_vehicle_id at display time would do exactly
  -- that, and linked_vehicle_id is nullable anyway.
  IF v_linked.id IS NOT NULL THEN
    p_plate_state := COALESCE(NULLIF(trim(p_plate_state), ''), v_linked.state);
    p_make        := COALESCE(NULLIF(trim(p_make),        ''), v_linked.make);
    p_model       := COALESCE(NULLIF(trim(p_model),       ''), v_linked.model);
    p_color       := COALESCE(NULLIF(trim(p_color),       ''), v_linked.color);
  END IF;

  -- ── Write ──────────────────────────────────────────────────────
  -- v_plate_norm, not the raw parameter. The table's BEFORE-write
  -- trigger now no-ops on every RPC write — that is intended. It stays
  -- as the FLOOR for any future non-RPC write path, not the mechanism.
  -- See COMMENT ON FUNCTION vehicle_removal_plate_normalize.
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
    v_plate_norm,
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
  -- v_plate_norm — the SAME value written to the row above. The audit
  -- entry and the row it describes must never carry different plates
  -- on a table whose purpose is being a log of record.
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
      'plate',                v_plate_norm,
      'removal_type',         p_removal_type,
      'reason_code',          p_reason_code,
      'towed_at',             p_towed_at,
      'tow_operator_id',      p_tow_operator_id,
      'tow_operator_name',    v_operator.name,
      'authorized_by_email',  lower(trim(p_authorized_by_email)),
      'authorized_by_name',   NULLIF(trim(p_authorized_by_name), ''),
      'linked_vehicle_id',    v_linked_vehicle_id,
      'vehicle_desc_source',  CASE WHEN v_linked.id IS NULL THEN 'caller_only'
                                   ELSE 'caller_then_linked_vehicle' END,
      'notes',                NULLIF(trim(p_notes), ''),
      'recorded_by_role',     v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END
$func$;

INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_RECORD_VEHICLE_REMOVAL_LINK_VEHICLE_DESCRIPTION',
  'public.vehicle_removals',
  'link_vehicle_description',
  jsonb_build_object(
    'migration', '20260912_record_vehicle_removal_link_vehicle_description',
    'arc',       'Tow Log UAT — populate plate_state/make/model/color from the linked vehicle',
    'why', 'Those four columns were in the table, the RPC and the CSV export but had no input on the create screen, so every export carried four empty columns.',
    'precedence', 'Caller wins. COALESCE(NULLIF(trim(p_x), ''''), v_linked.x) — a typed value is never overwritten by the registration.',
    'snapshot_not_join', 'Copied into the removal row, same as operator_name/phone. Reading them through linked_vehicle_id at display time would let a later vehicle edit rewrite what the log says was towed.',
    'signature_change', 'NONE — CREATE OR REPLACE on the same 15-arg signature, all nine defaults re-typed.',
    'not_fixed_here', 'The walk-in case: an unregistered vehicle has no row to link, so these stay empty unless typed. Collapsed "Add vehicle details" inputs ship in the same commit. There is no edit path, so anything not captured at creation is lost.',
    'audit_payload_addition', 'vehicle_desc_source records caller_only vs caller_then_linked_vehicle, so a blank column later can be attributed rather than guessed at.'
  ),
  now()
);

NOTIFY pgrst, 'reload schema';

COMMIT;
