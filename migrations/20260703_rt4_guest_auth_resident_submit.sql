-- ════════════════════════════════════════════════════════════════════
-- RT-4 — Guest Authorization Resident-Submit + PM-Approve
-- Locked: July 3, 2026
--
-- ORIGIN
--   Closes the CRM arc's last round-trip: resident REQUESTS an authorized
--   guest → pending → PM approves in the CRM → active shielded plate. Wires
--   the resident front-door onto B214's existing guest_authorizations table
--   (which already carries the 60-day cap, auto-expiry, and revoke path).
--
-- DESIGN LOCKED (Jose 2026-07-03 via architect chat)
--   • Cap on pending guest requests per resident: 3. Approved/declined do
--     not count against the cap. (N+1)th → 'pending_cap_reached'.
--   • Reuse B214's existing 60-day window logic — resident proposes
--     start_date/end_date, existing CHECKs enforce (end_date >= start_date,
--     span <= 60 days). No new expiry mechanics. Auto-expiry = existing
--     query-time double-gate. Revoke = existing RPC.
--   • PM may adjust dates at approve within the 60-day cap. Reason: avoids
--     decline/resubmit for policy trims; DB CHECK makes it safe.
--   • Permission gate on approve/decline = role IN ('manager','company_admin')
--     matching the existing create_guest_authorization gate; NOT
--     can_approve_vehicles — a guest is not a billed permit and fires zero
--     meter. Client isReadOnly is enforced client-side.
--
-- SAFETY SPINE (holds by construction)
--   • Pending guest → NOT authorized. The enforcement cascade already
--     filters WHERE status='active' — 'pending' rows are excluded by the
--     existing driver query + guest_auth_enforcement_lookup index predicate
--     (which itself is `WHERE is_active = TRUE AND status = 'active'`).
--     ZERO cascade code changes required to close the bypass.
--   • Meter-zero on approve. countActiveRecords() at
--     [app/lib/stripe-mutations.ts:198-217] queries `vehicles` only.
--     guest_authorizations is nowhere in stripe-mutations.ts. Guest
--     approvals fire zero meter regardless of tier.
--
-- SCHEMA DELTA (this migration)
--   • Extend guest_auth_status_valid CHECK: adds 'pending','declined'.
--   • Rewrite guest_auth_revoke_consistency CHECK: revoked_* triad must be
--     NULL for any non-revoked status (pending, active, declined).
--   • Add approved_by_email TEXT (nullable). Filled by
--     approve_guest_authorization_request. NULL for PM-direct-creates
--     (they never transitioned through 'pending').
--   • Add declined_reason TEXT (nullable). Filled by
--     decline_guest_authorization_request. Distinct from revoked_reason
--     to keep the two lifecycle branches semantically clean.
--   • New RLS policy: resident_read_own_guest_auths (SELECT own rows).
--     No resident INSERT/UPDATE — writes flow through DEFINER RPCs below.
--
-- WRITE PATH (3 new DEFINER RPCs)
--   submit_guest_authorization_request  — resident role gate; derives
--     company/property/unit from caller's residents + user_roles rows;
--     status='pending'; D1 cap enforced (>=3 pending → refuse).
--   approve_guest_authorization_request — manager|company_admin gate;
--     property-scoped; pending → active; stamps approved_by_email;
--     optional date-adjust within DB CHECK bounds.
--   decline_guest_authorization_request — same gate; pending → declined;
--     stamps declined_reason.
--
-- EXISTING RPCs (unchanged)
--   create_guest_authorization / renew_guest_authorization /
--   revoke_guest_authorization — PM-direct-create + renew + revoke paths.
--   PM-direct-create is NOT subject to the resident cap (intended).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Status CHECK — allow pending + declined ──────────────────────
ALTER TABLE public.guest_authorizations
  DROP CONSTRAINT IF EXISTS guest_auth_status_valid;

ALTER TABLE public.guest_authorizations
  ADD CONSTRAINT guest_auth_status_valid
  CHECK (status IN ('active', 'revoked', 'pending', 'declined'));

-- ── 2. Revoke-consistency CHECK — accommodate new statuses ──────────
-- Old: `(revoked AND revoked_* not-null) OR (active AND revoked_* null)`.
-- New: revoke triad is populated iff status='revoked'; for any other
-- status (active / pending / declined) all three must be NULL.
ALTER TABLE public.guest_authorizations
  DROP CONSTRAINT IF EXISTS guest_auth_revoke_consistency;

ALTER TABLE public.guest_authorizations
  ADD CONSTRAINT guest_auth_revoke_consistency
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_email IS NOT NULL)
    OR
    (status <> 'revoked' AND revoked_at IS NULL AND revoked_by_email IS NULL)
  );

-- ── 3. New columns ──────────────────────────────────────────────────
ALTER TABLE public.guest_authorizations
  ADD COLUMN IF NOT EXISTS approved_by_email TEXT,
  ADD COLUMN IF NOT EXISTS declined_reason   TEXT;

-- ── 4. RLS policy — resident_read_own_guest_auths ───────────────────
-- Residents see only their own rows (any status). Enforced by
-- lower-cased email match against auth.jwt(). No INSERT/UPDATE policy —
-- writes flow through the submit RPC.
DROP POLICY IF EXISTS "resident_read_own_guest_auths" ON public.guest_authorizations;
CREATE POLICY "resident_read_own_guest_auths" ON public.guest_authorizations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND (lower(coalesce(resident_email, '')) = lower(coalesce(auth.jwt() ->> 'email', '')))
  );

-- ════════════════════════════════════════════════════════════════════
-- RPC 1 — submit_guest_authorization_request (resident)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.submit_guest_authorization_request(
  p_plate         TEXT,
  p_state         TEXT,
  p_vehicle_make  TEXT,
  p_vehicle_model TEXT,
  p_vehicle_color TEXT,
  p_guest_name    TEXT,
  p_start_date    DATE,
  p_end_date      DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_property     TEXT;
  v_unit         TEXT;
  v_normalized   TEXT;
  v_pending_ct   INT;
  v_id           BIGINT;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role guard ─────────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role <> 'resident' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Resolve resident's own scope (company/property/unit) ───────
  -- Trust the residents table, not the RPC body — same principle as
  -- submit_plate_change (Slice 4). Multi-property residents would be
  -- multi-row; v1 uses the first active row, deterministic on id ASC.
  SELECT company, property, unit
    INTO v_company, v_property, v_unit
    FROM public.residents
    WHERE lower(email) = v_caller_email AND is_active = TRUE
    ORDER BY id ASC
    LIMIT 1;

  IF v_property IS NULL THEN
    RETURN jsonb_build_object('error', 'resident_not_found');
  END IF;

  -- ── D1 cap — 3 pending per resident ────────────────────────────
  SELECT COUNT(*)::int
    INTO v_pending_ct
    FROM public.guest_authorizations
    WHERE lower(coalesce(resident_email, '')) = v_caller_email
      AND status = 'pending';

  IF v_pending_ct >= 3 THEN
    RETURN jsonb_build_object(
      'error', 'pending_cap_reached',
      'hint', '3 pending guest requests already awaiting approval'
    );
  END IF;

  -- ── Plate normalize + basic input validation ───────────────────
  v_normalized := normalize_plate(p_plate);
  IF v_normalized IS NULL OR length(v_normalized) = 0 THEN
    RETURN jsonb_build_object('error', 'plate_required');
  END IF;
  IF length(v_normalized) > 12 THEN
    RETURN jsonb_build_object('error', 'plate_too_long');
  END IF;
  IF p_guest_name IS NULL OR length(trim(p_guest_name)) = 0 THEN
    RETURN jsonb_build_object('error', 'guest_name_required');
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RETURN jsonb_build_object('error', 'dates_required');
  END IF;
  -- 60-day cap + date-order enforced by the existing table CHECKs
  -- (guest_auth_dates_ordered, guest_auth_60day_cap). No duplication.

  -- ── Insert row ─────────────────────────────────────────────────
  INSERT INTO public.guest_authorizations (
    company, property,
    plate, state, vehicle_make, vehicle_model, vehicle_color,
    guest_name, visiting_unit, resident_email,
    start_date, end_date,
    status, is_active, created_by_email
  ) VALUES (
    v_company, v_property,
    v_normalized, coalesce(nullif(trim(p_state), ''), 'TX'),
    nullif(trim(p_vehicle_make), ''), nullif(trim(p_vehicle_model), ''), nullif(trim(p_vehicle_color), ''),
    trim(p_guest_name), v_unit, v_caller_email,
    p_start_date, p_end_date,
    'pending', TRUE, v_caller_email
  )
  RETURNING id INTO v_id;

  -- ── Audit ──────────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email, 'SUBMIT_GUEST_AUTH_REQUEST',
    'guest_authorizations', v_id,
    jsonb_build_object(
      'plate', v_normalized, 'guest_name', trim(p_guest_name),
      'property', v_property, 'unit', v_unit,
      'start_date', p_start_date, 'end_date', p_end_date
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_id,
    'status', 'pending',
    'property', v_property,
    'unit', v_unit
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.submit_guest_authorization_request(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_guest_authorization_request(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_guest_authorization_request(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- RPC 2 — approve_guest_authorization_request (PM)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.approve_guest_authorization_request(
  p_id         BIGINT,
  p_start_date DATE DEFAULT NULL,
  p_end_date   DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_caller_company TEXT;
  v_row          public.guest_authorizations%ROWTYPE;
  v_new_start    DATE;
  v_new_end      DATE;
  v_property_ok  BOOLEAN;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT company INTO v_caller_company
    FROM public.user_roles
    WHERE lower(email) = v_caller_email
    LIMIT 1;
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_for_caller');
  END IF;

  SELECT * INTO v_row FROM public.guest_authorizations WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'guest_auth_not_found');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending', 'hint', 'current_status:'||v_row.status);
  END IF;

  -- Property scope: managers restricted to their own properties;
  -- company_admin restricted to same-company.
  IF v_caller_role = 'manager' THEN
    v_property_ok := v_row.property ~~* ANY (SELECT unnest(get_my_properties()));
  ELSE
    -- company_admin: same-company via properties table
    v_property_ok := EXISTS (
      SELECT 1 FROM public.properties
        WHERE name = v_row.property AND company ~~* v_caller_company
    );
  END IF;
  IF NOT v_property_ok THEN
    RETURN jsonb_build_object('error', 'property_not_in_scope');
  END IF;

  -- Optional date adjust — v_new_* fall back to submitted values.
  v_new_start := coalesce(p_start_date, v_row.start_date);
  v_new_end   := coalesce(p_end_date,   v_row.end_date);
  -- 60-day cap + date-order enforced by the existing table CHECKs.

  UPDATE public.guest_authorizations
     SET status            = 'active',
         approved_by_email = v_caller_email,
         start_date        = v_new_start,
         end_date          = v_new_end
   WHERE id = p_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, created_at)
  VALUES (
    v_caller_email, 'APPROVE_GUEST_AUTH_REQUEST',
    'guest_authorizations', p_id,
    jsonb_build_object('status', 'pending', 'start_date', v_row.start_date, 'end_date', v_row.end_date),
    jsonb_build_object('status', 'active',  'start_date', v_new_start,      'end_date', v_new_end,
                       'approved_by_email', v_caller_email),
    now()
  );

  RETURN jsonb_build_object(
    'ok', TRUE, 'id', p_id, 'status', 'active',
    'start_date', v_new_start, 'end_date', v_new_end
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.approve_guest_authorization_request(BIGINT,DATE,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_guest_authorization_request(BIGINT,DATE,DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_guest_authorization_request(BIGINT,DATE,DATE) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- RPC 3 — decline_guest_authorization_request (PM)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.decline_guest_authorization_request(
  p_id     BIGINT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_caller_company TEXT;
  v_row          public.guest_authorizations%ROWTYPE;
  v_property_ok  BOOLEAN;
  v_reason       TEXT;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT company INTO v_caller_company
    FROM public.user_roles
    WHERE lower(email) = v_caller_email
    LIMIT 1;
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_for_caller');
  END IF;

  SELECT * INTO v_row FROM public.guest_authorizations WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'guest_auth_not_found');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'not_pending', 'hint', 'current_status:'||v_row.status);
  END IF;

  IF v_caller_role = 'manager' THEN
    v_property_ok := v_row.property ~~* ANY (SELECT unnest(get_my_properties()));
  ELSE
    v_property_ok := EXISTS (
      SELECT 1 FROM public.properties
        WHERE name = v_row.property AND company ~~* v_caller_company
    );
  END IF;
  IF NOT v_property_ok THEN
    RETURN jsonb_build_object('error', 'property_not_in_scope');
  END IF;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');

  UPDATE public.guest_authorizations
     SET status          = 'declined',
         declined_reason = v_reason
   WHERE id = p_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, created_at)
  VALUES (
    v_caller_email, 'DECLINE_GUEST_AUTH_REQUEST',
    'guest_authorizations', p_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'declined', 'declined_reason', v_reason),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', p_id, 'status', 'declined');
END;
$func$;

REVOKE ALL ON FUNCTION public.decline_guest_authorization_request(BIGINT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decline_guest_authorization_request(BIGINT,TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.decline_guest_authorization_request(BIGINT,TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFY (paste into SQL Editor after commit)
-- ════════════════════════════════════════════════════════════════════
-- ── A. Status CHECK includes new values
--   SELECT pg_get_constraintdef(c.oid)
--     FROM pg_constraint c
--    WHERE c.conname = 'guest_auth_status_valid';
--   Expected: CHECK (status = ANY (ARRAY['active','revoked','pending','declined']))
--
-- ── B. New columns present
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'guest_authorizations'
--      AND column_name IN ('approved_by_email','declined_reason');
--   Expected: 2 rows, both nullable=YES.
--
-- ── C. RLS policy present
--   SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'guest_authorizations'
--      AND policyname = 'resident_read_own_guest_auths';
--   Expected: 1 row, cmd='SELECT'.
--
-- ── D. RPCs exist + IMMUTABLE-not-required + SECURITY DEFINER
--   SELECT proname, prosecdef AS is_definer, provolatile
--     FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN (
--        'submit_guest_authorization_request',
--        'approve_guest_authorization_request',
--        'decline_guest_authorization_request'
--      );
--   Expected: 3 rows, is_definer=TRUE.
--
-- ── E. anon EXECUTE revoked (per feedback_revoke_from_anon_explicitly)
--   SELECT r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_exec
--     FROM pg_proc p, pg_roles r
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('submit_guest_authorization_request',
--                        'approve_guest_authorization_request',
--                        'decline_guest_authorization_request')
--      AND r.rolname IN ('anon','authenticated');
--   Expected: anon=FALSE, authenticated=TRUE for all 3.
--
-- ── F. Enforcement cascade unchanged (safety spine)
--   SELECT indexdef FROM pg_indexes
--    WHERE tablename = 'guest_authorizations'
--      AND indexname = 'guest_auth_enforcement_lookup';
--   Expected: still `WHERE is_active = TRUE AND status = 'active'` — pending
--   rows excluded by construction; no cascade code touched.
-- ════════════════════════════════════════════════════════════════════
