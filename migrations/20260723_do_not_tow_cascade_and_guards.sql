-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_do_not_tow_cascade_and_guards.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT Commit 3 — cascade branch 0 + creation trigger + tow-advancing
-- RPC guards + driver-callable check_dnt_plate RPC. Wires the DNT
-- capability shipped in e17a24f (schema-only) so protected plates
-- are actually protected.
--
-- ── Design (per Mateo 2026-07-23 locked answers + corrections) ─────────
-- • pm_plate_lookup — TOP-precedence branch 0. WRAPPED pattern (not
--   nested): existing cascade preserved byte-for-byte inside
--   `IF v_result_type IS NULL THEN ... END IF;`. Return shape same as
--   other branches (result_type = 'do_not_tow', unit_number = NULL,
--   guest_name = NULL, valid_through = NULL) + new `reason` field
--   added to terminal RETURN (additive, existing consumers unaffected).
--   Falls through to audit write — single RETURN path.
--
-- • BEFORE INSERT trigger on violations — SECURITY DEFINER, rejects
--   INSERT when incoming plate matches active DNT for the property.
--   Authoritative gate: no write path bypasses (client, RPC, service_role).
--   DELIBERATE V1 SIMPLIFICATION: a DNT vehicle can't be documented AT
--   ALL, even for a non-tow reason (fire lane, etc). Accept for now —
--   "protected from enforcement" is the design. Future "note without
--   violation" is a separate feature, not a loosening of this guard.
--
-- • set_violation_status — DNT guard ONLY for p_new_status='tow_ticket'.
--   Other transitions (resolved/disputed/new) allowed — cleanup paths
--   for violations created before DNT was set. Void has its own RPC
--   (void_violation, unchanged) and is orthogonal to status enum.
--   Error convention: JSONB {error, hint} matching function's existing
--   style.
--
-- • stamp_tow_ticket — DNT guard UNCONDITIONAL. This RPC exists solely
--   to generate a tow ticket; any invocation on DNT plate refused.
--   Error convention: JSONB {error, hint} matching function's existing
--   style (verified 2026-07-23: function returns JSONB errors, not RAISE).
--
-- • check_dnt_plate — NEW SECURITY DEFINER RPC for driver client-side
--   branch 0. Returns {is_dnt, reason}. CALLER-SCOPED — verifies
--   p_property is accessible to the caller by role (admin all; manager/
--   leasing_agent via get_my_properties(); driver via
--   drivers.assigned_properties by email; company_admin via
--   properties.company ~~* get_my_company(); resident denied). If
--   p_property is out of scope, returns {is_dnt:false, reason:null} —
--   does NOT leak whether any DNT plates exist there.
--
-- ── Backwards-compat ───────────────────────────────────────────────────
-- DNT table is empty. Every new gate/guard/branch has zero behavioral
-- effect until DNT Commit 5 (manager UI) ships and a plate is added.
--
-- ── A1 impact ──────────────────────────────────────────────────────────
-- This is A1's live enforcement path (third change this week). All
-- guards inert while table empty. Existing pm_plate_lookup cascade
-- preserved BYTE-IDENTICAL inside the wrap — the diff shows only the
-- wrapper + branch 0 + terminal-RETURN 'reason' field as new.
--
-- ── OPERATIONAL NOTES (Mateo 2026-07-23 review) ────────────────────────
-- 1. Creation trigger blocks service_role too (by design — no write
--    path bypasses). Grep 2026-07-23 confirms scripted violation
--    INSERTs live in:
--      - scripts/probe-slice0-ca-storage-edit-deactivate.ts:115
--      - scripts/probe-b182-2-media-authz.ts:143
--      - scripts/probe-b182-pm-ticket-summary.ts:124
--      - seed_demo_data RPC (30 violations for Demo Company)
--    None of these currently create DNT plates + violations for the
--    same plate. If a future seeder ever does, it'll fail at seed
--    time with the trigger's RAISE — surfaced immediately, not a
--    silent runtime confusion later.
--
-- 2. Creation-trigger performance: lower(trim(p.name)) in the join
--    can't use an index → seq scan on `properties` per violation
--    insert. Irrelevant at A1's ~3 properties. If a PM customer with
--    ~hundreds of properties arrives, revisit — possible fix is a
--    functional index on lower(trim(name)) or storing property_name
--    normalized. Not urgent.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Creation trigger on violations (authoritative gate)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.dnt_reject_violation_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized TEXT;
  v_dnt_reason TEXT;
BEGIN
  v_normalized := UPPER(regexp_replace(COALESCE(NEW.plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF v_normalized = '' THEN
    -- Let existing validation (CHECK / RLS) handle malformed plate.
    RETURN NEW;
  END IF;

  SELECT dnt.reason INTO v_dnt_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties p ON lower(trim(p.name)) = lower(trim(NEW.property))
   WHERE dnt.plate = v_normalized
     AND dnt.property_id = p.id
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  IF v_dnt_reason IS NOT NULL THEN
    RAISE EXCEPTION 'plate % is on the Do Not Tow list at property % (reason: %)',
      NEW.plate, NEW.property, v_dnt_reason
      USING ERRCODE = 'check_violation',
            HINT    = 'Contact property manager if this vehicle should not be protected. Remove from DNT first if it needs a violation record.';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS dnt_reject_violation_insert_trigger ON public.violations;
CREATE TRIGGER dnt_reject_violation_insert_trigger
  BEFORE INSERT ON public.violations
  FOR EACH ROW
  EXECUTE FUNCTION public.dnt_reject_violation_insert();

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — check_dnt_plate: driver-callable DNT check with caller scoping
-- ══════════════════════════════════════════════════════════════════════
-- Role-branched scope check: only checks DNT for a property the caller
-- has legitimate access to. Otherwise returns {is_dnt:false, reason:null}
-- — no leak of whether a DNT plate exists at an out-of-scope property.
DROP FUNCTION IF EXISTS public.check_dnt_plate(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.check_dnt_plate(
  p_plate    TEXT,
  p_property TEXT
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized TEXT;
  v_reason     TEXT;
  v_role       TEXT;
  v_email      TEXT;
  v_authorized BOOLEAN := FALSE;
BEGIN
  IF p_plate IS NULL OR p_property IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_role := get_my_role();
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_normalized := UPPER(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF v_normalized = '' THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  -- ── CALLER-SCOPE CHECK (per Mateo 2026-07-23 security fix) ────────
  -- Verify p_property is accessible to the caller in their role.
  -- Otherwise return {is_dnt:false, reason:null} — do NOT leak whether
  -- an out-of-scope property has DNT plates OR the reason text.
  IF v_role = 'admin' THEN
    v_authorized := TRUE;

  ELSIF v_role IN ('manager', 'leasing_agent') THEN
    -- get_my_properties() returns TEXT[] of names manager is assigned to
    v_authorized := EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) prop
       WHERE lower(trim(prop)) = lower(trim(p_property))
    );

  ELSIF v_role = 'driver' THEN
    -- Drivers scope via drivers.assigned_properties TEXT[] by email match
    v_authorized := EXISTS (
      SELECT 1
        FROM public.drivers d,
             unnest(d.assigned_properties) prop
       WHERE lower(d.email) = lower(v_email)
         AND lower(trim(prop)) = lower(trim(p_property))
    );

  ELSIF v_role = 'company_admin' THEN
    -- CAs scope via companies+properties join. lower(trim()) both sides
    -- for BOTH company + property name per Mateo 2026-07-23 fix — the
    -- initial draft used p.company ~~* get_my_company() (ILIKE) which
    -- has both whitespace-sensitivity AND wildcard-interpretation
    -- failure modes. On an AUTHORIZATION decision the wildcard risk is
    -- severe (a % in a company name over-matches → CA reads other
    -- companies' DNT reasons). Same convention as pm_plate_lookup
    -- (743e519) + footprint counts (d1303c7).
    v_authorized := EXISTS (
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name))    = lower(trim(p_property))
    );

  ELSE
    -- residents, unknown roles: no enforcement power → denied
    v_authorized := FALSE;
  END IF;

  IF NOT v_authorized THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  -- ── Actual DNT lookup (only reached if authorized) ────────────────
  SELECT dnt.reason INTO v_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties p ON p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(p.name)) = lower(trim(p_property))
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  RETURN jsonb_build_object(
    'is_dnt', v_reason IS NOT NULL,
    'reason', v_reason
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.check_dnt_plate(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_dnt_plate(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_dnt_plate(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — pm_plate_lookup: WRAP existing cascade + prepend branch 0
-- ══════════════════════════════════════════════════════════════════════
-- Body IDENTICAL to 20260720_pm_plate_lookup_hardening.sql EXCEPT:
--   (a) DECLARE gains v_dnt_reason TEXT
--   (b) After v_normalized computed (before branch 1): DNT lookup + set
--       v_result_type='do_not_tow' if hit
--   (c) Existing cascade branches 1-6 (byte-identical) wrapped in
--       `IF v_result_type IS NULL THEN <existing block> END IF;`
--       Existing block's internal indentation PRESERVED byte-for-byte.
--   (d) Terminal RETURN gains 'reason' key (NULL for non-DNT results)
DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT);

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email          TEXT;
  v_role                  TEXT;
  v_properties            TEXT[];
  v_properties_normalized TEXT[];
  v_normalized            TEXT;
  v_vehicle_unit          TEXT;
  v_visitor_unit          TEXT;
  v_guest_name            TEXT;
  v_guest_unit            TEXT;
  v_guest_end             DATE;
  v_result_type           TEXT;
  v_unit_number           TEXT;
  v_dnt_reason            TEXT;   -- NEW (DNT Commit 3)
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  v_properties_normalized := ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p);

  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 0. Do Not Tow match ─────────────────────────────────────────
  -- TOP PRECEDENCE — "never tow" trumps every other cascade branch,
  -- including branch 2 (pending) which renders with an Issue Violation
  -- button. Safety-first: a protected plate cannot reach a towable
  -- driver-facing result even if it also has a pending registration.
  -- Indexed equality on pre-normalized dnt.plate; lower(trim()) both
  -- sides on property name (743e519 convention).
  SELECT dnt.reason INTO v_dnt_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties p ON p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(p.name)) = ANY (v_properties_normalized)
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  IF v_dnt_reason IS NOT NULL THEN
    v_result_type := 'do_not_tow';
    v_unit_number := NULL;
  END IF;

  -- ── Branches 1-6 (existing cascade — byte-identical to
  --    20260720_pm_plate_lookup_hardening.sql:143-254) ────────────────
  -- Wrapped in IF-guard so branch 0 result short-circuits cleanly.
  IF v_result_type IS NULL THEN
  -- ── 1. Resident match (active permit) ────────────────────────────
  -- Fix 2: property predicate normalized both sides. Plate predicate
  -- pre-existing alphanumeric-normalized (safe).
  -- Determinism note: no ORDER BY (one-active-vehicle-per-plate-per-
  -- property assumption filed as docs/backlog/pm_plate_lookup-vehicles-
  -- branches-determinism.md; deliberately not expanded here).
  SELECT v.unit INTO v_vehicle_unit
  FROM vehicles v
  WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
    AND v.is_active = TRUE
    AND lower(trim(v.property)) = ANY (v_properties_normalized)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 2. Pending permit match (B230) ────────────────────────────
    SELECT v.unit INTO v_vehicle_unit
    FROM vehicles v
    WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND v.is_active = FALSE
      AND v.status    = 'pending'
      AND lower(trim(v.property)) = ANY (v_properties_normalized)
    LIMIT 1;

    IF v_vehicle_unit IS NOT NULL THEN
      v_result_type := 'pending';
      v_unit_number := v_vehicle_unit;
    ELSE
      -- ── 3. Plate-change pending match (B230) ────────────────────
      SELECT v.unit INTO v_vehicle_unit
      FROM vehicle_plate_changes vpc
      JOIN vehicles v ON v.id = vpc.vehicle_id
      WHERE upper(regexp_replace(vpc.new_plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vpc.status = 'pending'
        AND lower(trim(vpc.property)) = ANY (v_properties_normalized)
      ORDER BY vpc.submitted_at DESC
      LIMIT 1;

      IF v_vehicle_unit IS NOT NULL THEN
        v_result_type := 'plate_under_review';
        v_unit_number := v_vehicle_unit;
      ELSE
        -- ── 4. Guest authorization match (B220 stage 2.5) ────────
        SELECT
          ga.guest_name,
          ga.visiting_unit,
          ga.end_date
        INTO
          v_guest_name,
          v_guest_unit,
          v_guest_end
        FROM guest_authorizations ga
        WHERE upper(regexp_replace(ga.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
          AND ga.is_active = TRUE
          AND ga.status = 'active'
          AND ga.start_date <= CURRENT_DATE
          AND ga.end_date   >= CURRENT_DATE
          AND lower(trim(ga.property)) = ANY (v_properties_normalized)
        ORDER BY ga.end_date DESC
        LIMIT 1;

        IF v_guest_unit IS NOT NULL THEN
          v_result_type := 'guest_authorized';
          v_unit_number := v_guest_unit;
        ELSE
          -- ── 5. Visitor pass match ─────────────────────────────
          SELECT vp.visiting_unit INTO v_visitor_unit
          FROM visitor_passes vp
          WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
            AND vp.is_active = TRUE
            AND vp.expires_at > now()
            AND lower(trim(vp.property)) = ANY (v_properties_normalized)
          ORDER BY vp.expires_at DESC
          LIMIT 1;

          IF FOUND THEN
            v_result_type := 'visitor';
            v_unit_number := v_visitor_unit;
          ELSE
            -- ── 6. Unauthorized ─────────────────────────────────
            v_result_type := 'unauthorized';
            v_unit_number := NULL;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  END IF;  -- close the v_result_type IS NULL wrap

  -- ── 7. Audit write (requires VOLATILE — unchanged) ───────────────
  -- Single audit path — DNT results audit too (attribution matters for
  -- liability decisions per Mateo 2026-07-23 Q3).
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_searched',  to_jsonb(v_properties)
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',   v_result_type,
    'unit_number',   v_unit_number,
    'guest_name',    v_guest_name,
    'valid_through', v_guest_end,
    'reason',        v_dnt_reason      -- NEW (NULL for non-DNT results)
  );
END;
$func$;

-- pg_proc COUNT=1 assertion
DO $chk_pm$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pm_plate_lookup has % overloads; expected 1', v_count;
  END IF;
END $chk_pm$;

REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 4 — set_violation_status: DNT guard for tow_ticket transitions
-- ══════════════════════════════════════════════════════════════════════
-- Body IDENTICAL to 20260624_b219_violation_status_lifecycle.sql:130-242
-- EXCEPT: DNT guard block inserted between status validation (:178)
-- and row load (:180). Guard ONLY fires when p_new_status='tow_ticket'
-- — cleanup transitions (resolved/disputed/new) still allowed.
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

  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.company ~~* v_caller_company
       AND p.name = v_row.property
  ) THEN
    RETURN jsonb_build_object('error', 'cross_company_denied');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided_row_immutable');
  END IF;

  -- ── DNT guard — only for tow-advancing transition ────────────────
  -- Per Mateo 2026-07-23 Q1: block ONLY when advancing to 'tow_ticket'.
  -- Other transitions (resolved/disputed/new) allowed — cleanup paths
  -- for violations created before the plate was DNT-protected. Void has
  -- its own separate RPC (void_violation) and is orthogonal.
  -- Property-name match uses lower(trim()) both sides per 743e519
  -- convention (NEW code; existing raw-equality checks above preserved
  -- byte-identical to avoid drift with B40 RLS alignment).
  IF p_new_status = 'tow_ticket' THEN
    IF EXISTS (
      SELECT 1
        FROM public.do_not_tow_plates dnt
        JOIN public.properties p ON lower(trim(p.name)) = lower(trim(v_row.property))
       WHERE dnt.plate = UPPER(regexp_replace(v_row.plate, '[^A-Za-z0-9]', '', 'g'))
         AND dnt.property_id = p.id
         AND dnt.removed_at IS NULL
         AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'error', 'do_not_tow_active',
        'hint',  'This plate is on the Do Not Tow list at this property. Remove from DNT first (via property Settings) or void the violation instead.'
      );
    END IF;
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

REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 5 — stamp_tow_ticket: DNT guard (unconditional)
-- ══════════════════════════════════════════════════════════════════════
-- Body IDENTICAL to 20260629_violations_mileage_vin_persistence.sql:136-257
-- EXCEPT: DNT guard block inserted between voided check (:179) and
-- already-stamped guard (:181). Unconditional — this RPC exists solely
-- to generate a tow ticket; any invocation on DNT plate refused.
-- Error convention: JSONB {error, hint} matching function's existing
-- style (verified 2026-07-23).
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

  -- ── DNT guard (unconditional — this RPC generates tow tickets) ───
  -- Per Mateo 2026-07-23. Plate-name join uses lower(trim()) both sides
  -- (743e519 convention). Return matches function's JSONB error style.
  IF EXISTS (
    SELECT 1
      FROM public.do_not_tow_plates dnt
      JOIN public.properties p ON lower(trim(p.name)) = lower(trim(v_row.property))
     WHERE dnt.plate = UPPER(regexp_replace(v_row.plate, '[^A-Za-z0-9]', '', 'g'))
       AND dnt.property_id = p.id
       AND dnt.removed_at IS NULL
       AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
  ) THEN
    RETURN jsonb_build_object(
      'error', 'do_not_tow_active',
      'hint',  'This plate is on the Do Not Tow list at this property. Tow ticket generation refused. Contact property manager to remove from DNT if this vehicle should be towable.'
    );
  END IF;

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
-- STEP 6 — SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_DNT_CASCADE_AND_GUARDS',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260723_do_not_tow_cascade_and_guards',
    'purpose',   'DNT Commit 3 — wires the DNT capability shipped in e17a24f (schema-only): cascade branch 0 in pm_plate_lookup + BEFORE INSERT trigger on violations (authoritative gate) + DNT guards in set_violation_status (tow_ticket only) + stamp_tow_ticket (unconditional) + new check_dnt_plate DEFINER RPC for driver client-side branch 0.',
    'wrap_pattern', 'pm_plate_lookup existing cascade (20260720:143-254) preserved BYTE-IDENTICAL inside `IF v_result_type IS NULL THEN...END IF;` wrap. Diff shows only wrapper + branch 0 + terminal-RETURN reason field as new.',
    'creation_trigger_v1_simplification', 'BEFORE INSERT trigger rejects violation creation for DNT plates entirely — even for non-tow reasons (fire lane, etc). Accepted for v1; future "note without violation" would be a separate feature, not a loosening of this guard.',
    'check_dnt_plate_scope', 'CALLER-SCOPED per Mateo 2026-07-23 security fix. Role-branched: admin all; manager/leasing_agent via get_my_properties(); driver via drivers.assigned_properties by email; CA via properties.company ~~* get_my_company(); resident denied. Out-of-scope property returns {is_dnt:false, reason:null} — no leak.',
    'guards_backwards_compat', 'DNT table empty at migration land. All guards + branch 0 inert. First activation when DNT Commit 5 (manager UI) lands + a plate is added.'
  ),
  now()
);

COMMIT;
