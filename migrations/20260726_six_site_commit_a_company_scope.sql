-- ════════════════════════════════════════════════════════════════════
-- Six-site name-keyed scoping — Commit A: tow-path company scope
-- Locked: July 26, 2026
--
-- WHY THIS EXISTS
--   Pre-`public_signup_open` hardening. Six ~~* (ILIKE) predicates in
--   three functions on A1's live tow path use wildcard-vulnerable
--   comparisons for caller-authorization. `%` and `_` in a caller's
--   company or property name silently authorize actions across tenant
--   boundaries. Latent today (zero cross-tenant name collisions in A1's
--   single-company world); live the moment public signup admits a second
--   customer with a name containing wildcard chars.
--
-- SCOPE — Commit A of the six-site arc
--   Six sites, three functions. Byte-identical to
--   20260723_dnt_b2_function_scope_fix.sql except the six lines below.
--   B2 DNT canonical guard blocks (Commit B2), signatures, role gates,
--   INSERT/UPDATE, audit_logs, and RETURN shapes PRESERVED unchanged.
--
--   Companion commits (not this file):
--     • Commit B — get_plate_pass_status signature widening (adds
--       p_company; anon-callable so cannot use get_my_company()).
--     • Commit C — enforce_visitor_pass_limit trigger. DEFERRED to the
--       FK epic: visitor_passes has no company column (Gate 2 confirmed
--       2026-07-26); resolving via properties by name is circular.
--
-- TWO SHAPES — DO NOT HOMOGENIZE
--
--   Shape 1 — company `~~*` → `lower(trim(...)) = lower(trim(...))` (5 sites)
--     A1  set_violation_status:            p.company        ~~* v_caller_company
--     A2  regenerate_tow_ticket violation: p.company        ~~* v_caller_company
--     A3  regenerate_tow_ticket storage:   v_storage.company ~~* v_caller_company
--     A4  stamp_tow_ticket violation:      p.company        ~~* v_company
--     A5  stamp_tow_ticket storage:        v_storage.company ~~* v_company
--
--   Shape 2 — property `~~*` in caller-in-scope → property equality (1 site)
--     A6  stamp_tow_ticket manager branch: v_row.property   ~~* p
--
--   A6 does NOT get a company predicate. `get_my_properties()` is
--   already company-scoped (RLS-scoped read of user_roles.property for
--   the caller). The wildcard bug at A6 is a caller-property wildcard,
--   not a company wildcard.
--
-- CONSISTENCY WITH EXISTING STYLE
--   regenerate_tow_ticket uses `v_caller_company` (loaded from
--   user_roles at L827-831 of the prior file) for A2/A3, matching that
--   function's existing style. Sidesteps the get_my_company()
--   determinism question for regenerate_tow_ticket entirely — v_caller_company
--   is a LIMIT 1 read of user_roles by lower(email), same source as
--   get_my_company() but already loaded and reused.
--
--   set_violation_status + stamp_tow_ticket use `v_caller_company` /
--   `v_company` variables that are assigned via `get_my_company()`
--   earlier in each function (L541 / L727+L753). Not changed.
--
-- GET_MY_COMPANY DETERMINISM — dependency-on-record
--   `get_my_company()` reads user_roles LIMIT 1 with no ORDER BY. For a
--   single-company caller (all A1 enforcement callers today per Gate 1
--   check 2026-07-26 → ZERO multi-company rows) it resolves
--   deterministically. Multi-company callers would get an arbitrary
--   scope. The six-site fix intersects the deferred helper-determinism
--   epic; both must land before public_signup_open, in either order.
--
-- SAFETY
--   • BEGIN/COMMIT atomic — three CREATE OR REPLACE in one transaction.
--     Either all three functions get the new bodies or none do.
--   • Signatures unchanged → CREATE OR REPLACE is in-place safe, no
--     overload trap, GRANT EXECUTE preserved.
--   • DNT canonical guard blocks preserved byte-identical — the B2
--     invariant that keeps the DNT arc closed.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — set_violation_status: A1 only
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to 20260723_dnt_b2_function_scope_fix.sql:511-635
-- except line 561 (A1: p.company ~~* v_caller_company → equality).
CREATE OR REPLACE FUNCTION public.set_violation_status(
  p_violation_id BIGINT,
  p_new_status   TEXT
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
  v_row            violations%ROWTYPE;
  v_old_status     TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role != 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_caller_company := get_my_company();
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_assigned');
  END IF;

  IF p_new_status IS NULL
     OR p_new_status NOT IN ('new', 'tow_ticket', 'resolved', 'disputed') THEN
    RETURN jsonb_build_object(
      'error', 'invalid_status',
      'hint',  'status must be one of: new, tow_ticket, resolved, disputed'
    );
  END IF;

  SELECT * INTO v_row FROM public.violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- ── A1 (Commit A, 2026-07-26): wildcard-safe company match ─
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE lower(trim(p.company)) = lower(trim(v_caller_company))
       AND p.name = v_row.property
  ) THEN
    RETURN jsonb_build_object('error', 'cross_company_denied');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided_row_immutable');
  END IF;

  -- ── DNT guard — only for tow-advancing transition ────────────────
  -- Cleanup transitions (new/resolved/disputed) always allowed on DNT
  -- plates per tag-not-block model. Void has its own separate RPC
  -- (void_violation) and is orthogonal.
  IF p_new_status = 'tow_ticket' THEN
    -- ── CANONICAL DNT guard block (Commit B2)
    -- Byte-identical across set_violation_status, stamp_tow_ticket,
    -- and regenerate_tow_ticket. Do not hand-edit any single copy.
    IF v_caller_role <> 'admin'
       AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
      RETURN jsonb_build_object('error', 'company_unresolved');
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.do_not_tow_plates dnt
        JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
       WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
         AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
         AND (v_caller_role = 'admin'
              OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
         AND dnt.removed_at IS NULL
         AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'error', 'do_not_tow_active',
        'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
      );
    END IF;
    -- ── END CANONICAL BLOCK
  END IF;

  v_old_status := COALESCE(v_row.status, 'new');

  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object('ok', TRUE, 'noop', TRUE, 'status', p_new_status);
  END IF;

  UPDATE public.violations
     SET status            = p_new_status,
         status_changed_at = now(),
         status_changed_by = lower(v_caller_email)
   WHERE id = p_violation_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_STATUS_CHANGE',
    'violations',
    p_violation_id,
    jsonb_build_object(
      'old_status', v_old_status,
      'new_status', p_new_status,
      'company',    v_caller_company
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'old_status', v_old_status,
    'new_status', p_new_status
  );
END;
$func$;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — stamp_tow_ticket: A4 (violation-scope company) + A6 (manager
--          property, no company) + A5 (storage-scope company)
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to 20260723_dnt_b2_function_scope_fix.sql:648-780
-- except lines 731 (A4), 740 (A6), 756 (A5).
CREATE OR REPLACE FUNCTION public.stamp_tow_ticket(
  p_violation_id        BIGINT,
  p_storage_facility_id BIGINT,
  p_tow_fee             NUMERIC,
  p_mileage_fee         NUMERIC DEFAULT NULL,
  p_vin                 TEXT    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company        TEXT;
  v_properties     TEXT[];
  v_row            violations%ROWTYPE;
  v_storage        storage_facilities%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- ── CANONICAL DNT guard block (Commit B2)
  -- Byte-identical across set_violation_status, stamp_tow_ticket,
  -- and regenerate_tow_ticket. Do not hand-edit any single copy.
  IF v_caller_role <> 'admin'
     AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
    RETURN jsonb_build_object('error', 'company_unresolved');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.do_not_tow_plates dnt
      JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
     WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
       AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
       AND (v_caller_role = 'admin'
            OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
       AND dnt.removed_at IS NULL
       AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
  ) THEN
    RETURN jsonb_build_object(
      'error', 'do_not_tow_active',
      'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
    );
  END IF;
  -- ── END CANONICAL BLOCK

  IF v_row.tow_ticket_generated = true THEN
    RETURN jsonb_build_object(
      'error', 'already_stamped',
      'hint',  'Void the existing ticket and create a new violation entry to reissue.'
    );
  END IF;

  -- ── A4 (Commit A, 2026-07-26): wildcard-safe company match (CA/driver) ─
  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND lower(trim(p.company)) = lower(trim(v_company))
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  -- ── A6 (Commit A, 2026-07-26): wildcard-safe property match (manager) ─
  -- NO company predicate — get_my_properties() is already company-scoped.
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE lower(trim(v_row.property)) = lower(trim(p))
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  -- ── A5 (Commit A, 2026-07-26): wildcard-safe storage company match ─
  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (lower(trim(v_storage.company)) = lower(trim(v_company)))
    THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  UPDATE violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_tow_fee,
         tow_mileage_fee          = COALESCE(p_mileage_fee, tow_mileage_fee),
         vehicle_vin              = COALESCE(p_vin,         vehicle_vin),
         status                   = CASE WHEN status = 'new' THEN 'tow_ticket' ELSE status END
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — regenerate_tow_ticket: A2 (violation-scope) + A3 (storage-scope)
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to 20260723_dnt_b2_function_scope_fix.sql:796-1064
-- except lines 895 (A2) and 943 (A3).
-- Uses v_caller_company (loaded from user_roles at L827-831) for both,
-- matching this function's existing style. Sidesteps the get_my_company()
-- determinism question for this function.
CREATE OR REPLACE FUNCTION public.regenerate_tow_ticket(
  p_original_violation_id   BIGINT,
  p_new_storage_facility_id BIGINT,
  p_new_tow_fee             NUMERIC,
  p_reason                  TEXT,
  p_reason_note             TEXT    DEFAULT NULL,
  p_new_mileage_fee         NUMERIC DEFAULT NULL,
  p_new_vin                 TEXT    DEFAULT NULL
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
  v_can_regen      BOOLEAN;
  v_original       violations%ROWTYPE;
  v_row            violations%ROWTYPE;      -- B2: alias for canonical DNT block
  v_new_id         BIGINT;
  v_new_row        jsonb;
  v_storage        storage_facilities%ROWTYPE;
BEGIN
  -- ── Auth gate ───────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  SELECT role, company, can_regenerate_tow_ticket
    INTO v_caller_role, v_caller_company, v_can_regen
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ── Role gate ───────────────────────────────────────────────
  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  IF v_caller_role = 'driver' THEN
    IF v_can_regen IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'error', 'regenerate_not_permitted',
        'hint',  'Your account does not have regenerate permission. Contact your company admin.'
      );
    END IF;
  END IF;

  -- ── Reason gate ─────────────────────────────────────────────
  IF p_reason IS NULL
     OR p_reason NOT IN ('facility_closed', 'wrong_facility', 'facility_changed', 'vehicle_not_accepted', 'other') THEN
    RETURN jsonb_build_object(
      'error', 'invalid_reason',
      'hint',  'reason must be one of: facility_closed, wrong_facility, facility_changed, vehicle_not_accepted, other'
    );
  END IF;

  IF p_reason = 'other' AND (p_reason_note IS NULL OR length(trim(p_reason_note)) < 5) THEN
    RETURN jsonb_build_object(
      'error', 'reason_note_required',
      'hint',  'When reason is "other", a note of at least 5 characters is required.'
    );
  END IF;

  -- ── Original row: load + state checks ──────────────────────
  SELECT * INTO v_original
    FROM public.violations
   WHERE id = p_original_violation_id;

  IF v_original.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_original.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed',
                              'hint', 'Cannot regenerate a draft violation.');
  END IF;
  IF v_original.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_voided',
                              'hint', 'This violation has already been voided.');
  END IF;
  IF v_original.tow_ticket_generated IS NOT TRUE THEN
    RETURN jsonb_build_object('error', 'not_stamped',
                              'hint', 'Regenerate requires an existing stamped ticket. Use stamp_tow_ticket for initial stamps.');
  END IF;

  -- ── A2 (Commit A, 2026-07-26): wildcard-safe company match ─
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(v_caller_company))
         AND p.name = v_original.property
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  -- ── B2: DNT guard at entry (after row load + caller scope) ─────
  -- v_row alias binds v_original into the canonical variable name so
  -- the guard block is byte-identical across all three tow paths.
  v_row := v_original;

  -- ── CANONICAL DNT guard block (Commit B2)
  -- Byte-identical across set_violation_status, stamp_tow_ticket,
  -- and regenerate_tow_ticket. Do not hand-edit any single copy.
  IF v_caller_role <> 'admin'
     AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
    RETURN jsonb_build_object('error', 'company_unresolved');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.do_not_tow_plates dnt
      JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
     WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
       AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
       AND (v_caller_role = 'admin'
            OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
       AND dnt.removed_at IS NULL
       AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
  ) THEN
    RETURN jsonb_build_object(
      'error', 'do_not_tow_active',
      'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
    );
  END IF;
  -- ── END CANONICAL BLOCK

  -- ── Storage facility: validate + scope ─────────
  SELECT * INTO v_storage
    FROM public.storage_facilities
   WHERE id = p_new_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  -- ── A3 (Commit A, 2026-07-26): wildcard-safe storage company match ─
  IF v_caller_role <> 'admin' THEN
    IF v_storage.company IS NULL
       OR NOT (lower(trim(v_storage.company)) = lower(trim(v_caller_company))) THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 1 — VOID THE ORIGINAL (void-first ordering)        ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.violations
     SET voided_at              = now(),
         voided_by_email        = lower(v_caller_email),
         voided_by_role         = v_caller_role,
         void_reason            = 'regenerate: ' || p_reason,
         regenerate_reason      = p_reason,
         regenerate_reason_note = p_reason_note
   WHERE id = p_original_violation_id;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 2 — INSERT NEW VIOLATION ROW (carry-forward)       ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.violations (
    plate, violation_type, location, notes, property,
    driver_name, driver_license,
    vehicle_year, vehicle_color, vehicle_make, vehicle_model,
    is_confirmed,
    was_authorized_at_time, decline_reason, decline_reason_note,
    regenerated_from
  ) VALUES (
    v_original.plate, v_original.violation_type, v_original.location, v_original.notes, v_original.property,
    v_original.driver_name, v_original.driver_license,
    v_original.vehicle_year, v_original.vehicle_color, v_original.vehicle_make, v_original.vehicle_model,
    TRUE,
    v_original.was_authorized_at_time, v_original.decline_reason, v_original.decline_reason_note,
    p_original_violation_id
  )
  RETURNING id INTO v_new_id;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 3 — CARRY-FORWARD EVIDENCE (active rows only)      ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.violation_photos (violation_id, photo_url, created_at)
  SELECT v_new_id, photo_url, created_at
    FROM public.violation_photos
   WHERE violation_id = p_original_violation_id
     AND removed_at IS NULL;

  INSERT INTO public.violation_videos (violation_id, video_url, created_at)
  SELECT v_new_id, video_url, created_at
    FROM public.violation_videos
   WHERE violation_id = p_original_violation_id
     AND removed_at IS NULL;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 4 — STAMP THE NEW ROW (inline; D2 advance built-in)║
  -- ║                                                          ║
  -- ║ ⚠⚠⚠ KEEP IN SYNC WITH public.stamp_tow_ticket ⚠⚠⚠       ║
  -- ║ (Now also enforced by VQ.PARITY in B2 verification.)     ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_new_tow_fee,
         tow_mileage_fee          = p_new_mileage_fee,
         vehicle_vin              = p_new_vin,
         status                   = 'tow_ticket'
   WHERE id = v_new_id
  RETURNING to_jsonb(violations.*) INTO v_new_row;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 5 — AUDIT (two rows: void + regenerate) UNCHANGED  ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_VOIDED',
    'violations',
    p_original_violation_id,
    jsonb_build_object(
      'void_reason',            'regenerate: ' || p_reason,
      'regenerate_reason',      p_reason,
      'regenerate_reason_note', p_reason_note,
      'replaced_by',            v_new_id,
      'caller_role',            v_caller_role,
      'via_regenerate',         TRUE
    ),
    now()
  );

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_REGENERATED',
    'violations',
    v_new_id,
    jsonb_build_object(
      'original_violation_id',  p_original_violation_id,
      'reason',                 p_reason,
      'reason_note',            p_reason_note,
      'old_storage_name',       v_original.tow_storage_name,
      'old_tow_fee',            v_original.tow_fee,
      'old_mileage_fee',        v_original.tow_mileage_fee,
      'old_vin',                v_original.vehicle_vin,
      'new_storage_id',         p_new_storage_facility_id,
      'new_storage_name',       v_storage.name,
      'new_tow_fee',            p_new_tow_fee,
      'new_mileage_fee',        p_new_mileage_fee,
      'new_vin',                p_new_vin,
      'caller_role',            v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',                TRUE,
    'new_violation_id',  v_new_id,
    'violation',         v_new_row
  );
END;
$func$;

-- ══════════════════════════════════════════════════════════════════════
-- Migration audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_SIX_SITE_COMMIT_A_TOW_COMPANY_SCOPE',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260726_six_site_commit_a_company_scope',
    'purpose',   'Six-site name-keyed scoping — Commit A: 5x company wildcard `~~*` -> lower(trim()) equality + 1x property wildcard equality (manager caller-in-scope). A1 live tow path hardening pre-public-signup.',
    'sites', jsonb_build_object(
      'A1_set_violation_status',       'p.company ~~* v_caller_company -> lower(trim())=lower(trim())',
      'A2_regenerate_violation_scope', 'p.company ~~* v_caller_company -> lower(trim())=lower(trim())',
      'A3_regenerate_storage_scope',   'v_storage.company ~~* v_caller_company -> lower(trim())=lower(trim())',
      'A4_stamp_violation_scope',      'p.company ~~* v_company -> lower(trim())=lower(trim())',
      'A5_stamp_storage_scope',        'v_storage.company ~~* v_company -> lower(trim())=lower(trim())',
      'A6_stamp_manager_property',     'v_row.property ~~* p -> lower(trim())=lower(trim()) (NO company predicate; get_my_properties() already scoped)'
    ),
    'invariants', jsonb_build_object(
      'signatures',      'UNCHANGED for all three functions (in-place CREATE OR REPLACE, grants preserved)',
      'dnt_guard',       'CANONICAL DNT guard blocks byte-identical across all three functions (Commit B2 preserved)',
      'role_gates',      'UNCHANGED',
      'insert_update',   'UNCHANGED (violations UPDATE, INSERT INTO violations/photos/videos, audit_logs)'
    ),
    'gates', jsonb_build_object(
      'gate_1_multi_company',  'CLEAN 2026-07-26 (zero user_roles duplicates for enforcement callers)',
      'gate_2_visitor_passes', 'visitor_passes has NO company column -> Commit C deferred to FK epic',
      'gate_3_live_body',      'live bodies match source (2026-07-26)'
    ),
    'deferred', jsonb_build_object(
      'commit_b', 'get_plate_pass_status signature widening (anon-callable; separate risk)',
      'commit_c', 'enforce_visitor_pass_limit trigger — FK epic (schema change required)'
    ),
    'dependency_on_record', 'get_my_company() is LIMIT-1-no-ORDER-BY nondeterministic for multi-company callers. Fix is safe today (single-company callers, Gate 1 verified). Must land with or before helper-determinism epic before public_signup_open.'
  ),
  now()
);

COMMIT;
