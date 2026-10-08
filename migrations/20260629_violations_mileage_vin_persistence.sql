-- ═══════════════════════════════════════════════════════════════════
-- Mileage + VIN persistence on violations
-- Date:   2026-06-29
-- Branch: a1/violations-mileage-vin-persist
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Closes the form-field audit raised during the read-only stamped
-- re-print arc (Jose 2026-06-29). Two fields on the driver tow-ticket
-- form had the same broken shape: editable inputs whose values never
-- reached the row OR the print HTML server-side. Both were silent
-- vectors — mileage edits surfaced into the print but vanished on
-- re-open; VIN edits never reached anything at all.
--
-- Per A1's confirm: BOTH are real charges/identifiers on a tow ticket
-- that must be persisted and printed.
--
--   1. ADD COLUMN tow_mileage_fee NUMERIC (nullable, no default)
--      NULL = "not provided / blank". 0.00 = "explicit zero charge".
--      The distinction matters — the read-only re-print view's
--      conditional render uses `!= null` to decide whether to show
--      the mileage line at all.
--
--   2. ADD COLUMN vehicle_vin TEXT (nullable, no default)
--      NULL = "not captured at stamp time" (legitimate: dark lot,
--      VIN unreadable until vehicle reaches the facility — regenerate
--      with VIN once readable is a sanctioned flow).
--      Printed in the Vehicle Information section of the tow ticket
--      conditionally — omit the line when NULL (parallels mileage).
--      NOT shown on the manager (PM) tow-ticket view — minimizes
--      cross-company data; managers identify by plate/photos/video,
--      facility gets VIN via the driver-issued ticket.
--
--   3. CREATE OR REPLACE stamp_tow_ticket
--      Signature gains: p_mileage_fee NUMERIC DEFAULT NULL,
--                       p_vin         TEXT    DEFAULT NULL
--      Both DEFAULT NULL → backwards-compatible (existing call sites
--      work unchanged until the UI commit adds the args).
--      UPDATE SET clause adds:
--        tow_mileage_fee = COALESCE(p_mileage_fee, tow_mileage_fee)
--        vehicle_vin     = COALESCE(p_vin,         vehicle_vin)
--      COALESCE preserves any prior value when NULL is passed
--      (defensive against partial-update callers; cheap insurance).
--
--   4. CREATE OR REPLACE regenerate_tow_ticket
--      Signature gains: p_new_mileage_fee NUMERIC DEFAULT NULL,
--                       p_new_vin         TEXT    DEFAULT NULL
--      The Step-4 inline stamp UPDATE (the loud ⚠⚠⚠ KEEP IN SYNC zone
--      from L1) persists both fields, mirroring stamp_tow_ticket
--      exactly. Same drift-prevention discipline as the rest of
--      Step 4: any new field on stamp_tow_ticket MUST gain a parallel
--      line here, or regenerated tickets carry stale/blank data
--      versus fresh-stamped ones.
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   - Both fields OPTIONAL — NULL when blank, kept when entered.
--     Neither gates approval/confirm at any layer.
--   - Backwards-compatible RPC signatures — existing call sites
--     compile + work unchanged. The driver app's stamp call will
--     work as-is until its UI commit adds the args.
--   - B182 already_stamped guard PRESERVED on stamp_tow_ticket
--     (Section G of verification grep-confirms the guard text).
--   - L1 D2 status auto-advance PRESERVED on stamp_tow_ticket
--     (the `status = CASE WHEN status = 'new' ...` clause stays).
--   - L1 Step 1-5 ordering on regenerate_tow_ticket PRESERVED
--     (void original BEFORE stamp new — atomicity guarantee).
--   - L1 company-scope predicate (properties ILIKE) PRESERVED on
--     both RPCs (Section G grep-confirms).
--   - REVOKE anon/PUBLIC + GRANT authenticated re-affirmed
--     defensively on both RPCs (CREATE OR REPLACE preserves grants
--     but the Supabase default-privilege drift risk is real per
--     [[feedback-function-public-grant-supabase-default]]).
--
-- KEEP-IN-SYNC ZONE — NOW TRACKING TWO FIELDS
-- ────────────────────────────────────────────
-- The ⚠⚠⚠ KEEP IN SYNC WITH stamp_tow_ticket ⚠⚠⚠ comment block in
-- regenerate_tow_ticket's Step 4 explicitly lists BOTH new fields:
--     tow_fee, tow_mileage_fee, vehicle_vin, tow_storage_*
-- A future maintainer adding a NEW field to stamp_tow_ticket sees
-- the parallel list and adds it here too. Section D of verification
-- regex-checks that BOTH new fields appear in regenerate_tow_ticket's
-- body (catches drift on either side).
--
-- APPLY DISCIPLINE (mirrors L1 / L3)
-- ──────────────────────────────────
--   1. Section A → confirm pre-state (columns absent, RPC bodies
--      don't reference the new fields)
--   2. Apply this file as single paste in SQL Editor
--   3. Sections B–G → confirm pass; report C/D/E/G (load-bearing)
--   4. UI commit (driver app stamp wire-through + RegenerateTicketModal
--      mileage+VIN inputs + read-only view auto-surfaces both)
--      ships AFTER this migration is live + verified.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Schema: two new optional columns on violations
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.violations
  ADD COLUMN IF NOT EXISTS tow_mileage_fee NUMERIC,
  ADD COLUMN IF NOT EXISTS vehicle_vin     TEXT;
-- Both nullable, no default. Pre-existing rows stay NULL ("not
-- recorded at stamp time"). Distinguishing NULL from 0.00 / '' is
-- meaningful: the read-only view's conditional render omits the
-- mileage / VIN lines entirely when NULL, surfacing them only when
-- an explicit value is persisted.


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — stamp_tow_ticket: persist mileage + VIN
-- ════════════════════════════════════════════════════════════════════
-- Full rewrite (CREATE OR REPLACE rewrites the entire body).
-- BYTE-IDENTICAL to the L1 form EXCEPT:
--   (a) Signature gains p_mileage_fee + p_vin (both DEFAULT NULL,
--       backwards-compatible at the CALL-SITE level via named args)
--   (b) UPDATE SET gains tow_mileage_fee + vehicle_vin (COALESCE)
-- B182 already_stamped guard, role gate, scope checks, L1 D2 status
-- advance — all UNCHANGED.
--
-- ⚠ OVERLOAD-TRAP FIX (Jose 2026-06-29): CREATE OR REPLACE on a
-- function with a CHANGED signature creates a NEW overload — it does
-- NOT replace the old function. Both versions stay live; Postgres
-- resolves by argument-count + types; PostgREST's named-arg call
-- could resolve to EITHER. Symptom in first apply: doubled grants
-- + driver app's existing 3-arg call resolved to OLD function (which
-- doesn't persist mileage/VIN). Fix: DROP the old signature
-- EXPLICITLY before the CREATE OR REPLACE. Idempotent via IF EXISTS
-- so a re-apply doesn't error after the old signature is already
-- gone. The DROP also cleans up the orphaned old-signature grants.

DROP FUNCTION IF EXISTS public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC);

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

  -- B182 already-stamped guard (UNCHANGED).
  IF v_row.tow_ticket_generated = true THEN
    RETURN jsonb_build_object(
      'error', 'already_stamped',
      'hint',  'Void the existing ticket and create a new violation entry to reissue.'
    );
  END IF;

  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_company)
    THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ UPDATE — gains tow_mileage_fee + vehicle_vin            ║
  -- ║                                                          ║
  -- ║ COALESCE(p_X, X) semantics:                             ║
  -- ║   - p_X non-null → set to p_X                           ║
  -- ║   - p_X NULL     → keep existing value                  ║
  -- ║ Defensive against partial-update callers; current call  ║
  -- ║ sites always pass a value (or explicit NULL) so the     ║
  -- ║ behavior is "set or set-to-NULL" today. The COALESCE    ║
  -- ║ matters if a future caller does a partial update.       ║
  -- ║                                                          ║
  -- ║ L1 D2 status auto-advance (CASE WHEN status='new') is   ║
  -- ║ PRESERVED — never clobbers resolved/disputed.           ║
  -- ╚══════════════════════════════════════════════════════════╝
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


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — regenerate_tow_ticket: persist mileage + VIN
-- ════════════════════════════════════════════════════════════════════
-- Full rewrite (CREATE OR REPLACE). BYTE-IDENTICAL to L1's regenerate_
-- tow_ticket EXCEPT:
--   (a) Signature gains p_new_mileage_fee + p_new_vin
--   (b) Step-4 inline stamp UPDATE persists both fields
-- The Step 1-5 atomicity ordering (void original → insert new → carry
-- evidence → stamp new → audit) is UNCHANGED. The company-scope
-- predicate (properties ILIKE) is UNCHANGED.
--
-- ⚠ Same OVERLOAD-TRAP FIX as PART 2 (Jose 2026-06-29). DROP the L1
-- 5-arg signature explicitly before CREATE OR REPLACE so the new
-- 7-arg signature replaces it cleanly instead of overloading. IF
-- EXISTS makes re-apply safe.

DROP FUNCTION IF EXISTS public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT);

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

  -- ── Company-scope predicate (mirrors b40 RLS shape, UNCHANGED) ─
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.company ~~* v_caller_company
         AND p.name = v_original.property
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  -- ── Storage facility: validate + scope (UNCHANGED) ─────────
  SELECT * INTO v_storage
    FROM public.storage_facilities
   WHERE id = p_new_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  IF v_caller_role <> 'admin' THEN
    IF v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_caller_company) THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 1 — VOID THE ORIGINAL (void-first ordering)        ║
  -- ║   MUST happen before Step 4 (stamp new). Atomicity      ║
  -- ║   guarantee = plpgsql single-transaction + void-first   ║
  -- ║   ordering. UNCHANGED from L1.                          ║
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
  -- ║   is_confirmed=TRUE inherits validation; regenerated_   ║
  -- ║   from FK is the backward audit link. UNCHANGED from L1. ║
  -- ║                                                          ║
  -- ║ NOTE: mileage + VIN do NOT carry forward at the row-    ║
  -- ║ INSERT level. They're set in Step 4's inline stamp      ║
  -- ║ UPDATE from the RPC's p_new_mileage_fee / p_new_vin     ║
  -- ║ args (caller-provided fresh values). If the caller      ║
  -- ║ wants to carry mileage/VIN from the original, they pass ║
  -- ║ v_original.tow_mileage_fee / vehicle_vin in the args —  ║
  -- ║ explicit, not implicit. (App-side: RegenerateTicketModal ║
  -- ║ pre-fills the inputs with the original's values so the  ║
  -- ║ driver can keep or change them.)                         ║
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
  -- ║   UNCHANGED from L1. Soft-deleted (removed_at IS NOT    ║
  -- ║   NULL) photos/videos intentionally NOT carried.        ║
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
  -- ║ (migrations/20260614_b182_pm_ticket_summary.sql AND     ║
  -- ║  20260629_violations_mileage_vin_persistence.sql)        ║
  -- ║                                                          ║
  -- ║ Field parallel list (any new field on stamp_tow_ticket  ║
  -- ║ MUST gain a parallel line here, or regenerated tickets  ║
  -- ║ carry stale/blank data versus fresh-stamped ones):       ║
  -- ║                                                          ║
  -- ║   tow_storage_name      ← v_storage.name                ║
  -- ║   tow_storage_address   ← v_storage.address             ║
  -- ║   tow_storage_phone     ← v_storage.phone               ║
  -- ║   tow_fee               ← p_new_tow_fee                 ║
  -- ║   tow_mileage_fee       ← p_new_mileage_fee  (NEW)      ║
  -- ║   vehicle_vin           ← p_new_vin          (NEW)      ║
  -- ║   tow_ticket_generated  ← true                          ║
  -- ║   tow_ticket_generated_at ← now()                       ║
  -- ║   status                ← 'tow_ticket' (new row default)║
  -- ║                                                          ║
  -- ║ Section D of verification regex-checks BOTH new fields  ║
  -- ║ appear in this body. Drift on either side = caught.     ║
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
  -- ║   Mileage + VIN deltas captured in new_values jsonb for ║
  -- ║   forensic completeness (auditor can see old vs new fee ║
  -- ║   AND old vs new mileage AND old vs new VIN).            ║
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


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Grants re-affirmed defensively
-- ════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves grants but the Supabase default-privilege
-- drift risk is real per [[feedback-function-public-grant-supabase-default]].
-- Re-affirm REVOKE PUBLIC + REVOKE anon + GRANT authenticated on both
-- RPCs to lock in the discipline. Signature changes don't carry grants
-- forward automatically; the old signature's grants are orphaned.

-- stamp_tow_ticket — OLD 3-arg signature grants get cleaned up implicitly
-- when the new 5-arg signature CREATE OR REPLACE runs (since the function
-- IS the same function — only signature changed; Postgres updates in place).
-- REVOKE/GRANT against the new 5-arg signature explicitly:
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC, NUMERIC, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC, NUMERIC, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC, NUMERIC, TEXT) TO authenticated;

-- regenerate_tow_ticket — OLD 5-arg signature grants similar:
REVOKE EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT, NUMERIC, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;


-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Migration audit rows
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_COLUMNS_ADDED',
  'violations',
  NULL,
  jsonb_build_object(
    'migration',  '20260629_violations_mileage_vin_persistence',
    'columns',    jsonb_build_array(
      'violations.tow_mileage_fee NUMERIC (nullable, no default)',
      'violations.vehicle_vin     TEXT    (nullable, no default)'
    ),
    'semantics',  'NULL = not provided / not recorded at stamp time; non-NULL = explicit value'
  ),
  now()
);

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'stamp_tow_ticket',
  NULL,
  jsonb_build_object(
    'rpc',         'stamp_tow_ticket',
    'migration',   '20260629_violations_mileage_vin_persistence',
    'change',      'Signature gains p_mileage_fee + p_vin (both NUMERIC/TEXT, DEFAULT NULL, backwards-compatible). UPDATE SET persists both via COALESCE.',
    'preserved',   'B182 already_stamped guard; L1 D2 status auto-advance; all scope checks'
  ),
  now()
);

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'regenerate_tow_ticket',
  NULL,
  jsonb_build_object(
    'rpc',         'regenerate_tow_ticket',
    'migration',   '20260629_violations_mileage_vin_persistence',
    'change',      'Signature gains p_new_mileage_fee + p_new_vin (DEFAULT NULL). Step-4 inline stamp UPDATE persists both. Audit jsonb now captures old/new for both fields.',
    'preserved',   'L1 Step 1-5 atomicity ordering; company-scope predicate; void-first; reason gate; all scope checks',
    'keep_in_sync', 'Step-4 inline stamp UPDATE mirrors stamp_tow_ticket field list; Section D of verification regex-confirms BOTH new fields'
  ),
  now()
);

COMMIT;
