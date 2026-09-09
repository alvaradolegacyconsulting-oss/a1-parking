-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_commit_4_rpcs.sql
--
-- 🟢 Tow Log arc — COMMIT 4 of N. Three DEFINER RPCs:
--     • record_vehicle_removal   — create a tow record
--     • attach_removal_media     — attach evidence to a tow record
--     • void_vehicle_removal     — void a tow record (never DELETE)
--
-- Writes to the Commit 3 tables. Storage remains gated by the Commit 1
-- bucket + storage.objects RLS.
--
-- ── GATE ORDER (uniform across all 3 RPCs) ─────────────────────────
--   auth → role → tier → validation → scope → write + audit
-- Uniform rejection shape per 20260904_driver_create_violation_column_
-- allowlist_and_scope + 20260909_tow_log_tow_operators:
--   • Role rejection      → RETURN jsonb_build_object('error','role_not_authorized')
--   • Tier rejection      → RAISE ERRCODE='insufficient_privilege', msg='tier_not_permitted'
--   • Scope rejection     → RETURN jsonb_build_object('error','out_of_scope')
--   • Validation failures → RETURN jsonb_build_object('error','<name>')
--   • Success             → RETURN jsonb_build_object('ok', true, …)
--
-- ── SERVER-DERIVED vs CLIENT-SUPPLIED (record_vehicle_removal) ─────
-- Client supplies the OBSERVABLES of the tow:
--   p_property, p_plate, p_plate_state, p_make, p_model, p_color,
--   p_reason_code, p_reason_notes, p_space_id, p_towed_at,
--   p_authorized_by_email, p_authorized_by_name, p_tow_operator_id,
--   p_removal_type (default 'tow')
--
-- Server derives — NEVER accept from client:
--   company             ← get_my_company() (admin: property's company)
--   recorded_by_email   ← auth.jwt() ->> 'email' (forge-proof)
--   property_id         ← lookup public.properties by name (scoped)
--   operator_name       ← SNAPSHOT from tow_operators row at write time
--   operator_phone      ← SNAPSHOT from tow_operators row at write time
--   linked_vehicle_id   ← soft link resolved via normalize_plate() +
--                         property match at WRITE TIME only (nullable)
--
-- 🔴 p_tow_operator_id is REQUIRED at the RPC surface even though the
-- column is nullable at the table (admin/service_role backfill path).
-- The client-facing flow is: create_tow_operator (find-or-create) →
-- record_vehicle_removal. Composing them would trade the benign
-- failure mode (unused operator row) for a harder-to-reason-about
-- partial state.
--
-- ── SOFT-LINK RESOLUTION (linked_vehicle_id) ───────────────────────
-- Uses normalize_plate() (whitespace-only, matches vehicles_plate_
-- norm_uniq) on BOTH SIDES. Same-property scope, is_active=true. The
-- client sends plate via client-side normalizePlate (aggressive
-- alphanumeric-only strip) so both stored vehicles.plate and the
-- incoming p_plate are already alphanumeric; normalize_plate() is a
-- no-op canonicalization on both. NULL result is fine (walk-in vehicle
-- with no resident authorization).
--
-- ── PATH PREFIX VALIDATION (attach_removal_media) ──────────────────
-- 🔴 The storage RLS policies (Commit 1) gate the UPLOAD — who can
-- push bytes into the bucket, and under which prefix. This RPC gates
-- the REFERENCE — which media rows can point at which paths.
--
-- Without this check, a caller with permission to attach media to
-- their own removal could attach a media row pointing at ANY object
-- in the bucket, including another company's. The row would appear
-- under their removal but reference a foreign object; a signed-URL
-- helper reading the row would then hand out access.
--
-- Convention: `{property_id}/{removal_id}/...`. RPC asserts that
-- p_storage_path starts with the removal's own property_id/removal_id
-- prefix. Reject with 'path_mismatch' + return the expected prefix
-- for the client to correct.
--
-- ── VOID, NOT DELETE (void_vehicle_removal) ────────────────────────
-- Mirrors void_violation (20260611). Reason required. Already-voided
-- returns 'already_voided'. Sets voided_at + voided_by_email +
-- void_reason atomically — the vehicle_removals_void_coherence CHECK
-- enforces the all-three-set invariant at the schema level, but this
-- RPC sets them explicitly rather than relying on the constraint to
-- catch a partial write.
--
-- ── SUPER-ADMIN BYPASS FIRST ───────────────────────────────────────
-- All three RPCs put the super-admin check BEFORE calling
-- my_tier_pm_capable() — that helper RAISEs no_company_context on a
-- NULL user_roles.company, which admin has by design. Skipping the
-- helper for admin also lets admin operate cross-company for probes /
-- backfills / support cases.
--
-- ── GRANTS (per feedback_revoke_from_anon_explicitly) ──────────────
-- All 3 functions: REVOKE FROM PUBLIC + REVOKE FROM anon + GRANT
-- EXECUTE TO authenticated. Explicit REVOKE FROM anon required —
-- Supabase's default grants EXECUTE to PUBLIC on SECURITY DEFINER
-- functions.
--
-- ── AUDIT ACTIONS ───────────────────────────────────────────────────
-- Canonical shape from void_violation (20260611):
--   VEHICLE_REMOVAL_RECORDED         — one per successful create
--   VEHICLE_REMOVAL_MEDIA_ATTACHED   — one per successful media attach
--   VEHICLE_REMOVAL_VOIDED           — one per successful void
-- Rejections do NOT write audit rows — RPC returns before the audit
-- INSERT.
--
-- ── NOT IN THIS COMMIT ─────────────────────────────────────────────
-- Media soft-delete RPC (removed_at + removed_by_email + removed_by_
-- role + removal_reason on vehicle_removal_media). Columns exist
-- (Commit 3); nothing writes them yet. Defer to the commit that
-- ships the UI needing it.
--
-- Signed-URL helper for media retrieval — separate commit. Bucket-
-- scoped, returns short-lived URLs for viewing evidence. Not required
-- for the write path.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Report-first → eyeball → apply (Jose) → verify → push.
-- BEGIN/COMMIT wrap. Verification is a companion _verification file —
-- STRUCTURAL gates only. Execution gates for Commits 3 + 4 land in
-- one empirical pass after Jose runs the runbook (Commit 4 exec is
-- richer; the 22-gate structural is a floor).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;


-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — record_vehicle_removal
-- ══════════════════════════════════════════════════════════════════════
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
  p_removal_type         TEXT        DEFAULT 'tow'
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
  -- Post-dating illegitimate (a tow that hasn't happened can't be
  -- recorded). Backdating fine (Monday write-up of Saturday tow).
  -- 5-minute clock-skew tolerance.
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
    -- Admin uses the property's company. If ambiguous (same name
    -- across companies), SELECT INTO picks arbitrarily — fine for
    -- admin probes; disambiguate manually if needed.
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

    -- Manager scope: property must be in caller's assigned set
    IF v_caller_role = 'manager' AND NOT EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) x
       WHERE lower(trim(x)) = lower(trim(p_property))
    ) THEN
      RETURN jsonb_build_object('error', 'property_not_authorized_for_manager');
    END IF;

    -- Resolve property_id within the caller's company
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
  -- normalize_plate() (whitespace-only) matches vehicles_plate_norm_
  -- uniq. Same-property, is_active=true. NULL is fine (walk-in).
  SELECT v.id INTO v_linked_vehicle_id
    FROM public.vehicles v
   WHERE normalize_plate(v.plate) = normalize_plate(p_plate)
     AND lower(trim(v.property))  = lower(trim(p_property))
     AND v.is_active              = true
   LIMIT 1;

  -- ── Write ──────────────────────────────────────────────────────
  -- Plate goes in raw; trigger normalizes via aggressive alphanumeric
  -- strip. Operator name + phone are SNAPSHOTS from the tow_operators
  -- row (see header §SNAPSHOT PRINCIPLE — snapshots stay forever).
  INSERT INTO public.vehicle_removals (
    company, property, property_id, removal_type,
    plate, plate_state, make, model, color, linked_vehicle_id,
    reason_code, reason_notes, space_id,
    towed_at,
    authorized_by_email, authorized_by_name,
    tow_operator_id, operator_name, operator_phone,
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
    lower(v_caller_email)
  )
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────────
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
      'recorded_by_role',     v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — attach_removal_media
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.attach_removal_media(
  p_removal_id   BIGINT,
  p_storage_path TEXT,
  p_kind         TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email     TEXT;
  v_caller_role      TEXT;
  v_company          TEXT;
  v_removal          vehicle_removals%ROWTYPE;
  v_expected_prefix  TEXT;
  v_new_id           BIGINT;
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

  -- ── Tier ────────────────────────────────────────────────────────
  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Vehicle-removal media attachment is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Validation ─────────────────────────────────────────────────
  IF p_removal_id IS NULL THEN
    RETURN jsonb_build_object('error', 'removal_id_required');
  END IF;
  IF p_storage_path IS NULL OR length(trim(p_storage_path)) = 0 THEN
    RETURN jsonb_build_object('error', 'storage_path_required');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('photo', 'ticket', 'receipt') THEN
    RETURN jsonb_build_object('error', 'invalid_kind');
  END IF;

  -- ── Load parent + scope check ──────────────────────────────────
  SELECT * INTO v_removal
    FROM public.vehicle_removals
   WHERE id = p_removal_id;
  IF v_removal.id IS NULL THEN
    RETURN jsonb_build_object('error', 'removal_not_found');
  END IF;

  IF v_caller_role = 'manager' THEN
    IF NOT EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) x
       WHERE lower(trim(x)) = lower(trim(v_removal.property))
    ) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  ELSIF v_caller_role = 'company_admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR lower(trim(v_removal.company)) <> lower(trim(v_company)) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;
  -- admin bypasses scope

  -- ── 🔴 PATH PREFIX VALIDATION ──────────────────────────────────
  -- See header §PATH PREFIX VALIDATION. Storage RLS gates upload;
  -- this RPC gates the reference.
  IF v_removal.property_id IS NULL THEN
    -- Defense against a removal row written outside this RPC with
    -- property_id missing. Shouldn't happen in v1.
    RETURN jsonb_build_object('error', 'removal_property_id_missing');
  END IF;
  v_expected_prefix := v_removal.property_id::text || '/'
                    || v_removal.id::text          || '/';
  IF NOT starts_with(p_storage_path, v_expected_prefix) THEN
    RETURN jsonb_build_object(
      'error',           'path_mismatch',
      'expected_prefix', v_expected_prefix
    );
  END IF;

  -- ── Write ──────────────────────────────────────────────────────
  INSERT INTO public.vehicle_removal_media (
    removal_id, storage_path, kind, created_by_email
  ) VALUES (
    p_removal_id,
    trim(p_storage_path),
    p_kind,
    lower(v_caller_email)
  )
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VEHICLE_REMOVAL_MEDIA_ATTACHED',
    'vehicle_removal_media',
    v_new_id::text,
    jsonb_build_object(
      'removal_id',       p_removal_id,
      'storage_path',     trim(p_storage_path),
      'kind',             p_kind,
      'attached_by_role', v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.attach_removal_media(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.attach_removal_media(BIGINT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.attach_removal_media(BIGINT, TEXT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — void_vehicle_removal
-- ══════════════════════════════════════════════════════════════════════
-- Mirrors void_violation (20260611). Reason required. Already-voided
-- terminal. Sets voided_at + voided_by_email + void_reason atomically.
-- Never DELETEs.
CREATE OR REPLACE FUNCTION public.void_vehicle_removal(
  p_removal_id  BIGINT,
  p_void_reason TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_removal      vehicle_removals%ROWTYPE;
  v_updated_row  jsonb;
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
      USING HINT = 'Vehicle-removal voiding is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Validation ─────────────────────────────────────────────────
  IF p_removal_id IS NULL THEN
    RETURN jsonb_build_object('error', 'removal_id_required');
  END IF;
  IF p_void_reason IS NULL OR length(trim(p_void_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  -- ── Load + state check ─────────────────────────────────────────
  SELECT * INTO v_removal
    FROM public.vehicle_removals
   WHERE id = p_removal_id;
  IF v_removal.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_removal.voided_at IS NOT NULL THEN
    -- Terminal: no un-void in v1. An erroneously-voided real removal
    -- is corrected by recording a NEW removal, not by reversing the
    -- void. Mirrors void_violation discipline.
    RETURN jsonb_build_object('error', 'already_voided');
  END IF;

  -- ── Scope ──────────────────────────────────────────────────────
  IF v_caller_role = 'manager' THEN
    IF NOT EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) x
       WHERE lower(trim(x)) = lower(trim(v_removal.property))
    ) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  ELSIF v_caller_role = 'company_admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR lower(trim(v_removal.company)) <> lower(trim(v_company)) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;

  -- ── Atomic void: all three columns together ────────────────────
  UPDATE public.vehicle_removals
     SET voided_at       = now(),
         voided_by_email = lower(v_caller_email),
         void_reason     = p_void_reason
   WHERE id = p_removal_id
  RETURNING to_jsonb(vehicle_removals.*) INTO v_updated_row;

  -- ── Audit ──────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VEHICLE_REMOVAL_VOIDED',
    'vehicle_removals',
    p_removal_id::text,
    jsonb_build_object(
      'removal_id',     p_removal_id,
      'company',        v_removal.company,
      'property',       v_removal.property,
      'plate',          v_removal.plate,
      'towed_at',       v_removal.towed_at,
      'void_reason',    p_void_reason,
      'voided_by_role', v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'removal', v_updated_row);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.void_vehicle_removal(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_vehicle_removal(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_vehicle_removal(BIGINT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TOW_LOG_COMMIT_4_RPCS',
  'public.vehicle_removals',
  'commit_4_of_N',
  jsonb_build_object(
    'migration', '20260909_tow_log_commit_4_rpcs',
    'arc',       'Tow Log Commit 4 — 3 DEFINER RPCs: record_vehicle_removal, attach_removal_media, void_vehicle_removal',
    'depends_on', jsonb_build_array(
      'Commit 1 (d1a2d48) — vehicle-removal-photos bucket + storage.objects RLS',
      'Commit 2 (e7d5ccb) — tow_operators table + 3 DEFINER RPCs',
      'Commit 3 (pending) — vehicle_removals + vehicle_removal_media tables'
    ),
    'rpcs', jsonb_build_array(
      'record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT)',
      'attach_removal_media(BIGINT, TEXT, TEXT)',
      'void_vehicle_removal(BIGINT, TEXT)'
    ),
    'gate_order',      'auth → role → tier → validation → scope → write + audit',
    'rejection_shape', 'role/scope/validation via RETURN jsonb; tier via RAISE ERRCODE=insufficient_privilege msg=tier_not_permitted (Commit 2 uniform)',
    'server_derived',  jsonb_build_object(
      'company',           'get_my_company() (admin: property''s company)',
      'recorded_by_email', 'auth.jwt() forge-proof',
      'property_id',       'looked up in public.properties with scope',
      'operator_name',     'SNAPSHOT from tow_operators row at write',
      'operator_phone',    'SNAPSHOT from tow_operators row at write',
      'linked_vehicle_id', 'soft link via normalize_plate() + property + is_active — resolved at write, NEVER re-computed on read'
    ),
    'path_prefix_validation', 'attach_removal_media asserts p_storage_path starts with {property_id}/{removal_id}/. Storage RLS gates UPLOAD; this RPC gates the REFERENCE. Reject with path_mismatch + return expected_prefix for client-side correction.',
    'void_discipline', 'Mirrors void_violation. All three void columns set atomically; vehicle_removals_void_coherence CHECK is backstop, RPC sets explicitly. Terminal — no un-void in v1.',
    'audit_actions',   jsonb_build_array(
      'VEHICLE_REMOVAL_RECORDED',
      'VEHICLE_REMOVAL_MEDIA_ATTACHED',
      'VEHICLE_REMOVAL_VOIDED'
    ),
    'grants',          'REVOKE FROM PUBLIC + anon; GRANT EXECUTE TO authenticated on all 3 (feedback_revoke_from_anon_explicitly)',
    'not_in_commit',   jsonb_build_array(
      'Media soft-delete RPC — defer to the commit that ships the UI needing it',
      'Signed-URL helper for media retrieval — separate commit; not required for write path'
    ),
    'execution_gates', 'Land with Commit 3 empirical pass — richer than Commit 2 (more error branches, path-prefix validation, soft-link resolution, tow_operator scope, towed_at future check)'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — PostgREST schema cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;
