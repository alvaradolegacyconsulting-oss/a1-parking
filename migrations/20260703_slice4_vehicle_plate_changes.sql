-- ════════════════════════════════════════════════════════════════════
-- PM CRM Slice 4 — vehicle_plate_changes companion table + 3 RPCs
-- Locked: July 3, 2026
--
-- Feature: plate re-approval lifecycle. Residents can submit a plate
-- change on their approved vehicle; the change goes into review; the
-- current plate stays enforce-valid until the PM decides. PM approves
-- → new plate becomes the vehicle's plate. PM declines → change row
-- kept for audit; vehicle plate unchanged.
--
-- Data-model call (Jose 2026-07-03): companion table + partial unique
-- index for the one-in-flight rule + history retention on every change.
--
-- Safety invariants baked into the RPCs:
--   1. During review, vehicles.plate is NEVER touched. Old plate stays
--      enforce-valid so driver plate lookups of the old plate keep
--      returning authorized. Do-Not-Tow gap is the driver looking up
--      the NEW plate — handled by driver_read_plate_changes SELECT
--      policy + a supplementary query in driver/page.tsx searchPlate.
--   2. One pending change per vehicle at a time. Partial UNIQUE index
--      is the DB enforcement; submit_plate_change also pre-checks so a
--      clean error message can be returned.
--   3. Meter is NEVER touched on approve. A plate change is a
--      substitution, not a new permit — the permit count is unchanged,
--      so callSyncOnAdd('permit') would double-bill an existing permit.
--      approve_plate_change writes only vehicles.plate + vehicles.status,
--      NO meter call. The client handler in manager/page.tsx also does
--      not fire callSyncOnAdd for this action.
--   4. Gate flip: approve requires can_approve_vehicles (permit-granting
--      action per the standing rule); decline requires manager/CA role
--      only (declining grants nothing).
--   5. RLS hoisted per Commit 1/2 InitPlan idiom — no per-row cost, no
--      42883 trap on array helpers.
--
-- Post-apply verify:
--   scripts/probe-crm-slice4-plate-roundtrip.ts — runs all 7 assertions
--   from Jose's expanded E2E list.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicle_plate_changes (
  id                BIGSERIAL PRIMARY KEY,
  vehicle_id        BIGINT      NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  property          TEXT        NOT NULL,                   -- denormalized for RLS scoping (same idiom as violations/passes)
  old_plate         TEXT        NOT NULL,                   -- snapshot of vehicles.plate at submission
  new_plate         TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'declined', 'superseded')),
  submitted_by      TEXT        NOT NULL,                   -- resident email at submission
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by        TEXT,                                    -- manager email (nullable until decided)
  decided_at        TIMESTAMPTZ,                             -- nullable until decided
  decline_reason    TEXT,                                    -- nullable; populated on decline (optional even then)
  CONSTRAINT vpc_decline_reason_length_chk
    CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500),
  CONSTRAINT vpc_plates_length_chk
    CHECK (char_length(old_plate) BETWEEN 1 AND 12 AND char_length(new_plate) BETWEEN 1 AND 12),
  CONSTRAINT vpc_decided_consistency_chk
    CHECK (
      (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
      OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- One pending change per vehicle — partial UNIQUE index enforces the
-- one-in-flight rule at the DB. A second submit while one is pending
-- raises 23505; submit_plate_change surfaces it as 'already_pending'.
CREATE UNIQUE INDEX IF NOT EXISTS vpc_one_pending_per_vehicle_uidx
  ON public.vehicle_plate_changes (vehicle_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS vpc_property_status_idx ON public.vehicle_plate_changes (property, status);
CREATE INDEX IF NOT EXISTS vpc_vehicle_status_idx  ON public.vehicle_plate_changes (vehicle_id, status);

-- ── 2. Grants + REVOKEs (Supabase default-grant discipline) ──────────
-- Explicit REVOKE anon before RLS goes on. authenticated stays.
ALTER TABLE public.vehicle_plate_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vehicle_plate_changes FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.vehicle_plate_changes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.vehicle_plate_changes_id_seq TO authenticated;

-- ── 3. RLS policies (Commit 1/2 InitPlan idiom) ──────────────────────

-- admin: full read/write
DROP POLICY IF EXISTS "admin_all_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "admin_all_plate_changes" ON public.vehicle_plate_changes
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text)
  WITH CHECK ((SELECT get_my_role()) = 'admin'::text);

-- company_admin: read/update at own-company properties
DROP POLICY IF EXISTS "company_admin_own_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "company_admin_own_plate_changes" ON public.vehicle_plate_changes
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

-- manager/leasing_agent: read/update at own properties
DROP POLICY IF EXISTS "manager_own_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "manager_own_plate_changes" ON public.vehicle_plate_changes
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
    AND property ~~* ANY (SELECT unnest(get_my_properties()))
  );

-- resident: read own submissions only
DROP POLICY IF EXISTS "resident_read_own_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "resident_read_own_plate_changes" ON public.vehicle_plate_changes
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND submitted_by ILIKE ((SELECT auth.jwt()) ->> 'email'::text)
  );

-- resident: insert own submissions only. Defense-in-depth alongside the
-- submit_plate_change DEFINER RPC (which also validates vehicle
-- ownership at insert time).
DROP POLICY IF EXISTS "resident_insert_own_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "resident_insert_own_plate_changes" ON public.vehicle_plate_changes
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND submitted_by ILIKE ((SELECT auth.jwt()) ->> 'email'::text)
  );

-- driver: read at own-company properties (Do-Not-Tow visibility for
-- plate lookups at the lot). Read-only for drivers — no INSERT/UPDATE.
DROP POLICY IF EXISTS "driver_read_plate_changes" ON public.vehicle_plate_changes;
CREATE POLICY "driver_read_plate_changes" ON public.vehicle_plate_changes
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* (SELECT get_my_company())
    )
  );

-- ── 4. RPCs (SECURITY DEFINER — role/permission checks internal) ─────

-- submit_plate_change(vehicle_id, new_plate)  (resident only)
-- Preconditions:
--   · Caller role = 'resident'
--   · Caller owns the vehicle (residents.email matches vehicles.
--     resident_email at (unit, property))
--   · Vehicle status = 'active' (re-approval is on a currently-approved
--     permit; pending/declined/under_review reject)
--   · No pending change for this vehicle yet (partial UNIQUE handles
--     the race; this pre-check gives a clean error message)
-- Effect:
--   · INSERT row with old_plate = current vehicles.plate, new_plate =
--     p_new_plate, submitted_by = jwt.email, status = 'pending'
--   · UPDATE vehicles.status = 'under_review' (drives the CRM badge +
--     driver lookup do-not-tow signal — but vehicles.plate NOT changed)
--   · Audit: SUBMIT_PLATE_CHANGE
-- Returns: jsonb { ok, change_id, old_plate, new_plate }  or { error }
CREATE OR REPLACE FUNCTION public.submit_plate_change(
  p_vehicle_id BIGINT,
  p_new_plate  TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_vehicle      vehicles%ROWTYPE;
  v_new_plate    TEXT;
  v_change_id    BIGINT;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role <> 'resident' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- Vehicle ownership: resident_email match, case-insensitive.
  IF lower(coalesce(v_vehicle.resident_email, '')) <> v_caller_email THEN
    RETURN jsonb_build_object('error', 'not_vehicle_owner');
  END IF;

  -- Only active vehicles can request re-approval.
  IF v_vehicle.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'vehicle_not_active', 'hint', 'current_status:'||v_vehicle.status);
  END IF;

  v_new_plate := upper(regexp_replace(coalesce(p_new_plate, ''), '\s|-|\.', '', 'g'));
  IF length(v_new_plate) = 0 THEN
    RETURN jsonb_build_object('error', 'new_plate_required');
  END IF;
  IF length(v_new_plate) > 12 THEN
    RETURN jsonb_build_object('error', 'new_plate_too_long');
  END IF;
  IF v_new_plate = upper(coalesce(v_vehicle.plate, '')) THEN
    RETURN jsonb_build_object('error', 'new_plate_same_as_current');
  END IF;

  -- One-pending pre-check (partial UNIQUE also enforces at DB level).
  IF EXISTS (SELECT 1 FROM vehicle_plate_changes
             WHERE vehicle_id = p_vehicle_id AND status = 'pending') THEN
    RETURN jsonb_build_object('error', 'already_pending');
  END IF;

  INSERT INTO vehicle_plate_changes
    (vehicle_id, property, old_plate, new_plate, submitted_by, status)
  VALUES
    (p_vehicle_id, v_vehicle.property, v_vehicle.plate, v_new_plate, v_caller_email, 'pending')
  RETURNING id INTO v_change_id;

  -- Vehicle enters under_review state (drives CRM badge + driver-lookup
  -- do-not-tow signal). vehicles.plate is DELIBERATELY not touched —
  -- the old plate stays enforce-valid until PM approves.
  UPDATE vehicles SET status = 'under_review' WHERE id = p_vehicle_id;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (v_caller_email, 'SUBMIT_PLATE_CHANGE', 'vehicle_plate_changes', v_change_id,
    jsonb_build_object(
      'vehicle_id', p_vehicle_id,
      'old_plate', v_vehicle.plate,
      'new_plate', v_new_plate,
      'property', v_vehicle.property
    ),
    now());

  RETURN jsonb_build_object('ok', true, 'change_id', v_change_id, 'old_plate', v_vehicle.plate, 'new_plate', v_new_plate);
END;
$func$;

REVOKE ALL ON FUNCTION public.submit_plate_change(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_plate_change(BIGINT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.submit_plate_change(BIGINT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.submit_plate_change(BIGINT, TEXT) TO authenticated;

-- approve_plate_change(change_id)  (manager/CA/admin, gate on can_approve_vehicles)
-- Preconditions:
--   · Caller role IN (manager, company_admin, admin)
--   · Caller.user_roles.can_approve_vehicles = true (permit-granting action)
--   · Change row status = 'pending'
--   · Vehicle exists
-- Effect:
--   · UPDATE vehicles.plate = new_plate, vehicles.status = 'active'
--   · UPDATE change row: status='approved', decided_by, decided_at
--   · Audit: APPROVE_PLATE_CHANGE with old→new in new_values
--   · NO meter fire — substitution, not new permit
-- Returns: jsonb { ok, change_id, vehicle_id, old_plate, new_plate }  or { error }
CREATE OR REPLACE FUNCTION public.approve_plate_change(
  p_change_id BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_can_approve  BOOLEAN;
  v_change       vehicle_plate_changes%ROWTYPE;
  v_vehicle      vehicles%ROWTYPE;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- Permit-granting gate: can_approve_vehicles required (same rule as
  -- vehicle/resident approval). Admins bypass (assumed universally
  -- authorized).
  IF v_caller_role <> 'admin' THEN
    SELECT coalesce(can_approve_vehicles, false) INTO v_can_approve
      FROM user_roles WHERE lower(email) = v_caller_email LIMIT 1;
    IF NOT v_can_approve THEN
      RETURN jsonb_build_object('error', 'forbidden_manager_approval_not_authorized');
    END IF;
  END IF;

  SELECT * INTO v_change FROM vehicle_plate_changes WHERE id = p_change_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'change_not_found');
  END IF;
  IF v_change.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'change_not_pending', 'hint', 'current_status:'||v_change.status);
  END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_change.vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- Property scope check (defense-in-depth; RLS UPDATE policy also
  -- guards this).
  IF v_caller_role = 'manager' AND NOT (v_change.property ~~* ANY(get_my_properties())) THEN
    RETURN jsonb_build_object('error', 'change_out_of_scope');
  END IF;

  -- Substitute the plate. Meter untouched — this is not a new permit.
  UPDATE vehicles SET plate = v_change.new_plate, status = 'active' WHERE id = v_change.vehicle_id;

  UPDATE vehicle_plate_changes SET
    status = 'approved',
    decided_by = v_caller_email,
    decided_at = now()
  WHERE id = p_change_id;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (v_caller_email, 'APPROVE_PLATE_CHANGE', 'vehicle_plate_changes', p_change_id,
    jsonb_build_object(
      'vehicle_id', v_change.vehicle_id,
      'old_plate', v_change.old_plate,
      'new_plate', v_change.new_plate,
      'property', v_change.property,
      'meter_fired', false     -- explicit assertion: substitution, no permit delta, no callSyncOnAdd
    ),
    now());

  RETURN jsonb_build_object('ok', true, 'change_id', p_change_id, 'vehicle_id', v_change.vehicle_id, 'old_plate', v_change.old_plate, 'new_plate', v_change.new_plate);
END;
$func$;

REVOKE ALL ON FUNCTION public.approve_plate_change(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_plate_change(BIGINT) FROM anon;
REVOKE ALL ON FUNCTION public.approve_plate_change(BIGINT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.approve_plate_change(BIGINT) TO authenticated;

-- decline_plate_change(change_id, decline_reason?)  (manager/CA/admin, role-only, NO can_approve_vehicles)
-- Declining a plate change grants nothing — old plate stays in place —
-- so the permit-granting gate does NOT apply. Role check only.
-- Preconditions:
--   · Caller role IN (manager, company_admin, admin)
--   · Change row status = 'pending'
--   · Property scope (managers)
-- Effect:
--   · UPDATE change row: status='declined', decided_by, decided_at, decline_reason
--   · UPDATE vehicles.status = 'active' (return from under_review)
--   · Audit: DECLINE_PLATE_CHANGE
-- Returns: jsonb { ok, change_id }  or { error }
CREATE OR REPLACE FUNCTION public.decline_plate_change(
  p_change_id     BIGINT,
  p_decline_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_change       vehicle_plate_changes%ROWTYPE;
  v_reason       TEXT;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_change FROM vehicle_plate_changes WHERE id = p_change_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'change_not_found');
  END IF;
  IF v_change.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'change_not_pending', 'hint', 'current_status:'||v_change.status);
  END IF;

  IF v_caller_role = 'manager' AND NOT (v_change.property ~~* ANY(get_my_properties())) THEN
    RETURN jsonb_build_object('error', 'change_out_of_scope');
  END IF;

  v_reason := NULLIF(trim(coalesce(p_decline_reason, '')), '');
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RETURN jsonb_build_object('error', 'decline_reason_too_long');
  END IF;

  UPDATE vehicle_plate_changes SET
    status = 'declined',
    decided_by = v_caller_email,
    decided_at = now(),
    decline_reason = v_reason
  WHERE id = p_change_id;

  -- Vehicle returns from under_review to active; old plate stays valid.
  UPDATE vehicles SET status = 'active' WHERE id = v_change.vehicle_id;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (v_caller_email, 'DECLINE_PLATE_CHANGE', 'vehicle_plate_changes', p_change_id,
    jsonb_build_object(
      'vehicle_id', v_change.vehicle_id,
      'old_plate', v_change.old_plate,
      'new_plate', v_change.new_plate,
      'property', v_change.property,
      'decline_reason', v_reason
    ),
    now());

  RETURN jsonb_build_object('ok', true, 'change_id', p_change_id);
END;
$func$;

REVOKE ALL ON FUNCTION public.decline_plate_change(BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decline_plate_change(BIGINT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.decline_plate_change(BIGINT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.decline_plate_change(BIGINT, TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFY (after apply)
--
-- ── A. Table + partial unique + policies present
--   SELECT policyname, cmd, qual, with_check
--   FROM pg_policies WHERE tablename = 'vehicle_plate_changes'
--   ORDER BY policyname;
--   Expected 6 rows:
--     admin_all_plate_changes         · ALL
--     ca_own_plate_changes            · ALL   ← via company_admin_own_plate_changes
--     driver_read_plate_changes       · SELECT
--     manager_own_plate_changes       · ALL
--     resident_insert_own_plate_changes · INSERT
--     resident_read_own_plate_changes   · SELECT
--   Each contains "(SELECT get_my_role())" or "unnest(get_my_properties())"
--   or "(SELECT auth.jwt())" as appropriate.
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'vehicle_plate_changes' ORDER BY indexname;
--   Expected includes vpc_one_pending_per_vehicle_uidx with
--   WHERE (status = 'pending').
--
-- ── B. E2E round-trip probe
--   npx tsx --env-file=.env.local scripts/probe-crm-slice4-plate-roundtrip.ts
--   Expected: all 7 assertions PASS, including:
--     · vehicles.plate unchanged during review
--     · driver lookup of OLD plate returns authorized (invariant)
--     · driver lookup of NEW plate returns plate_under_review (safety)
--     · approve fires ZERO meter events (audit_logs shows no permit sync
--       row landed in the approve window)
--     · one-in-flight enforced (second submit → error 'already_pending')
--     · cross-role RLS isolation (other resident/other manager blocked)
-- ════════════════════════════════════════════════════════════════════
