-- B214 — Guest Authorizations: manager-vetted multi-week vehicle authorizations
--
-- ORIGIN
--   A1 (signed, Option C all-inclusive) flagged this as a near-blocker from real
--   experience: a resident has an extended guest (parent staying 2 weeks for
--   eldercare, family over holidays). Visitor passes are capped at 24h with a
--   per-plate frequency restriction (B19 anti-abuse) — they don't fit a
--   multi-week stay. A1 wants a manager-created authorization for a vehicle to
--   be on a property between two dates, auto-expiring like a visitor pass.
--
-- DESIGN LOCKED (Jose, 2026-06-20)
--   • NEW RECORD TYPE — not a longer visitor pass. Visitor passes are anonymous
--     / self-service / short-lived / frequency-capped by design; stretching them
--     to manager-vetted multi-week stays would break the guardrails that keep
--     them safe.
--   • Manager + Company Admin create. Residents CANNOT. (Opposite of visitor
--     passes which are public/anon.)
--   • Manager authority overrides the visitor frequency restriction — but by
--     CONSTRUCTION: this is a separate table, so the enforce_visitor_pass_limit
--     trigger never fires for these records. NO bypass logic needed. (This is
--     the clean Step-1.4 finding from the preflight.)
--   • 60-day max per grant. Renewal = NEW LINKED RECORD (renewed_from_id),
--     NOT in-place extend — preserves per-renewal audit history.
--   • Auto-expires the same way visitor passes do: query-time double-gate
--     (is_active = TRUE AND start_date <= today AND end_date >= today). No cron.
--   • Q5 resident-deactivation: guest auths SURVIVE resident deactivation.
--     The guest's authorization is deliberately decoupled from the resident's
--     account state — if a resident is deactivated mid-stay, the vetted guest's
--     car must NOT become tow-eligible (wrongful-tow scenario the product
--     exists to prevent). The auth's own end_date + revoke path are the
--     controls, not resident status.
--
-- SCOPING CONVENTION (matches existing tables: vehicles, visitor_passes, violations)
--   • company is identified by NAME (text), not uuid — matches user_roles.company,
--     properties.company, every existing RPC's resolution path.
--   • property is identified by NAME (text), matching properties.name.
--   • Driver/manager/CA RLS uses get_my_role() + get_my_company()/get_my_properties()
--     helpers (production-confirmed via B40 capture, [migrations/20260518_b40_violations_rls_capture.sql:83-89]).
--
-- WRITE PATH
--   All writes go through 3 SECURITY DEFINER RPCs (create/renew/revoke) with
--   role-pinned guards. NO direct INSERT/UPDATE policies — direct writes from
--   client are denied by RLS. This mirrors the B74 pattern (visitor_passes
--   public_insert_passes dropped → create_visitor_pass RPC) AND the B167 / B209
--   pattern (scope derived server-side from caller's user_roles, never trusted
--   from body).
--
-- ENFORCEMENT READ PATH
--   Driver portal's searchPlate() cascade ([app/driver/page.tsx:345-381]) gets a
--   new stage between vehicles-authorized and visitor_passes. Cascade query
--   uses the same is_active+date-range predicate as the table's primary index.
--   Returns new status enum value 'guest_authorized' — TWO consumers (driver
--   page + company_admin page) need ternary + render-block updates BEFORE this
--   stage ships, to avoid the wrongful-tow path (consumer-prep-before-cascade
--   sequencing per Jose's safety lock).
--
-- ════════════════════════════════════════════════════════════════════
-- PRE-APPLY DIAGNOSTICS (run before BEGIN — informational only)
-- ════════════════════════════════════════════════════════════════════
-- SELECT '─────── PRE-APPLY: helpers must exist ───────' AS marker;
-- SELECT proname, prosecdef AS is_definer
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('get_my_role','get_my_company','get_my_properties');
-- -- Expected: 3 rows, all is_definer = TRUE
--
-- SELECT '─────── PRE-APPLY: guest_authorizations must NOT exist yet ───────' AS marker;
-- SELECT to_regclass('public.guest_authorizations');
-- -- Expected: NULL

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — TABLE
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE public.guest_authorizations (
  id                    BIGSERIAL PRIMARY KEY,

  -- Scoping (matches visitor_passes/vehicles/violations convention: text not uuid)
  company               TEXT        NOT NULL,
  property              TEXT        NOT NULL,

  -- Vehicle
  plate                 TEXT        NOT NULL,                  -- pre-normalized: upper, alphanumeric only
  state                 TEXT        NOT NULL DEFAULT 'TX',
  vehicle_make          TEXT,
  vehicle_model         TEXT,
  vehicle_color         TEXT,

  -- Guest + visiting context
  guest_name            TEXT        NOT NULL,                  -- required; this is a vetted record
  visiting_unit         TEXT,                                  -- nullable when non_resident_reason set
  resident_email        TEXT,                                  -- denormalized like vehicles.resident_email (B166); lowercase
  non_resident_reason   TEXT,                                  -- required when visiting_unit IS NULL

  -- Date window (the new pattern — date range, not 24h timestamp)
  start_date            DATE        NOT NULL,
  end_date              DATE        NOT NULL,

  -- Lifecycle
  status                TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'revoked'; 'expired' is virtual (computed: end_date < today)
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Audit attribution
  created_by_email      TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Revocation columns (NULL until revoked)
  revoked_at            TIMESTAMPTZ,
  revoked_by_email      TEXT,
  revoked_reason        TEXT,

  -- Renewal chain (NULL = original grant; non-NULL = points to predecessor)
  renewed_from_id       BIGINT REFERENCES public.guest_authorizations(id) ON DELETE SET NULL,

  -- CHECK constraints
  CONSTRAINT guest_auth_dates_ordered      CHECK (end_date >= start_date),
  CONSTRAINT guest_auth_60day_cap          CHECK ((end_date - start_date) <= 60),
  CONSTRAINT guest_auth_unit_or_reason     CHECK ((visiting_unit IS NOT NULL) OR (non_resident_reason IS NOT NULL)),
  CONSTRAINT guest_auth_status_valid       CHECK (status IN ('active','revoked')),
  CONSTRAINT guest_auth_revoke_consistency CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_email IS NOT NULL)
    OR
    (status = 'active'  AND revoked_at IS NULL     AND revoked_by_email IS NULL)
  )
);

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — INDEXES
-- ════════════════════════════════════════════════════════════════════

-- Primary enforcement-lookup index: matches the driver-cascade WHERE clause
--   WHERE is_active = TRUE AND status = 'active'
--     AND company = X AND property ILIKE Y
--     AND plate = Z
--     AND start_date <= today AND end_date >= today
CREATE INDEX guest_auth_enforcement_lookup
  ON public.guest_authorizations (company, property, plate, is_active, start_date, end_date)
  WHERE is_active = TRUE AND status = 'active';

-- Per-plate query for the renewal chain view (commit 4)
CREATE INDEX guest_auth_chain_lookup
  ON public.guest_authorizations (company, property, plate);

-- Renewal-chain walk index (partial — only non-roots)
CREATE INDEX guest_auth_renewed_from
  ON public.guest_authorizations (renewed_from_id)
  WHERE renewed_from_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — RLS POLICIES
--
-- Mirror visitor_passes/violations conventions:
--   • admin: full access
--   • company_admin: same-company access (via properties.company join)
--   • manager: own-properties access (via get_my_properties())
--   • driver: same-company SELECT only (needed for enforcement cascade)
--   • resident: NO access (residents do not see guest auths — manager-vetted records)
--
-- NO direct INSERT/UPDATE policies — all writes flow through the 3 DEFINER RPCs
-- below. WITH CHECK omitted (defaults to USING) per B40 byte convention.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.guest_authorizations ENABLE ROW LEVEL SECURITY;

-- ── 1. admin_all_guest_auths (FOR ALL) ──────────────────────────────
CREATE POLICY "admin_all_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

-- ── 2. company_admin_own_guest_auths (FOR ALL) ──────────────────────
CREATE POLICY "company_admin_own_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

-- ── 3. manager_own_guest_auths (FOR ALL) ────────────────────────────
-- Includes leasing_agent for parity with manager_own_passes (B80 lesson).
-- Manager scoping is by-property (multi-property managers); company filter is
-- implicit because get_my_properties() only returns the manager's company's
-- properties.
CREATE POLICY "manager_own_guest_auths" ON public.guest_authorizations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── 4. driver_read_guest_auths (FOR SELECT) ─────────────────────────
-- Driver enforcement cascade in app/driver/page.tsx reads this table to decide
-- guest_authorized vs not. Scope by company (same as driver_own_violations,
-- per B25 locked decision — driver scopes by company, NOT by uploader).
-- SELECT-only; drivers cannot modify guest auths.
CREATE POLICY "driver_read_guest_auths" ON public.guest_authorizations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM public.properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

-- ── REVOKE anon defaults (B66.1 / B82 lesson: Supabase ALTER DEFAULT
-- PRIVILEGES grants anon ALL; explicit REVOKE removes drift) ─────────
REVOKE ALL ON public.guest_authorizations FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_authorizations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.guest_authorizations_id_seq TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — DEFINER RPCs (3)
--
-- All three:
--   • SECURITY DEFINER + SET search_path = public, pg_temp (B82 hardening)
--   • Role-pinned to ('manager','company_admin') per Jose Q4 confirmation
--     (the B155.4 CA-via-peer-RLS concern does NOT apply here — body-guard
--     role check is the source of truth, not RLS escalation through INSERT)
--   • Scope (company) resolved server-side from caller's user_roles row —
--     never trusted from request body (B167 / B209 discipline)
--   • REVOKE PUBLIC + REVOKE anon + GRANT authenticated (B68 / B82 retrofit)
--   • Write audit_logs row with AUTH_GUEST_{CREATE,RENEW,REVOKE} action
-- ════════════════════════════════════════════════════════════════════

-- ── RPC 1 — create_guest_authorization ──────────────────────────────
CREATE OR REPLACE FUNCTION public.create_guest_authorization(
  p_plate               TEXT,
  p_state               TEXT,
  p_vehicle_make        TEXT,
  p_vehicle_model       TEXT,
  p_vehicle_color       TEXT,
  p_guest_name          TEXT,
  p_visiting_unit       TEXT,
  p_resident_email      TEXT,
  p_non_resident_reason TEXT,
  p_property            TEXT,
  p_start_date          DATE,
  p_end_date            DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email      TEXT;
  v_role       TEXT;
  v_company    TEXT;
  v_property_ok BOOLEAN;
  v_normalized TEXT;
  v_id         BIGINT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- ── 1. Caller-role guard ──
  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can create guest authorizations.';
  END IF;

  -- ── 2. Resolve company from caller (NOT from body) ──
  SELECT company INTO v_company
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
    RAISE EXCEPTION 'no_company_for_caller'
      USING HINT = 'Caller has no company assignment.';
  END IF;

  -- ── 3. Validate property belongs to caller's company ──
  -- Defense against a manager submitting another company's property name.
  -- (Manager scoping via get_my_properties() is for RLS; this is the create-
  -- path equivalent so a managers can't write to a property they don't own.)
  SELECT EXISTS (
    SELECT 1 FROM public.properties
     WHERE name = p_property
       AND company ~~* v_company
  ) INTO v_property_ok;
  IF NOT v_property_ok THEN
    RAISE EXCEPTION 'property_not_in_company'
      USING HINT = 'The property does not belong to your company.';
  END IF;

  -- ── 4. Required-field validation ──
  IF p_guest_name IS NULL OR length(trim(p_guest_name)) = 0 THEN
    RAISE EXCEPTION 'guest_name_required' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_visiting_unit IS NULL OR length(trim(p_visiting_unit)) = 0)
     AND (p_non_resident_reason IS NULL OR length(trim(p_non_resident_reason)) = 0)
  THEN
    RAISE EXCEPTION 'unit_or_non_resident_reason_required'
      USING HINT = 'Provide either visiting_unit (for a resident guest) or non_resident_reason (for a vendor/contractor/etc).';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'dates_required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'end_before_start' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_end_date - p_start_date) > 60 THEN
    RAISE EXCEPTION 'dates_exceed_60day_cap'
      USING HINT = 'Guest authorizations are capped at 60 days per grant. Use renew_guest_authorization for longer stays.';
  END IF;

  -- ── 5. Normalize plate (same rule as create_visitor_pass + request_my_vehicle) ──
  v_normalized := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate_required' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 6. INSERT ──
  INSERT INTO public.guest_authorizations (
    company, property,
    plate, state, vehicle_make, vehicle_model, vehicle_color,
    guest_name, visiting_unit, resident_email, non_resident_reason,
    start_date, end_date,
    status, is_active,
    created_by_email, created_at
  ) VALUES (
    v_company, p_property,
    v_normalized,
    COALESCE(NULLIF(trim(p_state), ''), 'TX'),
    NULLIF(trim(COALESCE(p_vehicle_make, '')),  ''),
    NULLIF(trim(COALESCE(p_vehicle_model, '')), ''),
    NULLIF(trim(COALESCE(p_vehicle_color, '')), ''),
    trim(p_guest_name),
    NULLIF(trim(COALESCE(p_visiting_unit, '')),       ''),
    NULLIF(lower(trim(COALESCE(p_resident_email, ''))), ''),
    NULLIF(trim(COALESCE(p_non_resident_reason, '')), ''),
    p_start_date, p_end_date,
    'active', TRUE,
    lower(v_email), now()
  )
  RETURNING id INTO v_id;

  -- ── 7. Audit ──
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_GUEST_CREATE',
    'guest_authorizations',
    v_id,
    jsonb_build_object(
      'plate',          v_normalized,
      'company',        v_company,
      'property',       p_property,
      'guest_name',     trim(p_guest_name),
      'visiting_unit',  NULLIF(trim(COALESCE(p_visiting_unit, '')), ''),
      'start_date',     p_start_date,
      'end_date',       p_end_date
    ),
    now()
  );

  RETURN v_id;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.create_guest_authorization(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_guest_authorization(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) FROM anon;
GRANT  EXECUTE ON FUNCTION public.create_guest_authorization(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,DATE) TO authenticated;

-- ── RPC 2 — renew_guest_authorization ───────────────────────────────
-- Creates a NEW linked record (renewed_from_id = source). Does NOT modify the
-- source row — preserves audit history of each renewal as a discrete event.
-- The source's status/is_active are untouched; it expires naturally on its
-- own end_date (or is explicitly revoked if the manager wants).
CREATE OR REPLACE FUNCTION public.renew_guest_authorization(
  p_source_id     BIGINT,
  p_new_start_date DATE,
  p_new_end_date   DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email       TEXT;
  v_role        TEXT;
  v_company     TEXT;
  v_src         public.guest_authorizations%ROWTYPE;
  v_new_id      BIGINT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role guard
  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can renew guest authorizations.';
  END IF;

  -- Caller's company
  SELECT company INTO v_company
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;

  -- Load source row + verify same company
  SELECT * INTO v_src
    FROM public.guest_authorizations
    WHERE id = p_source_id;
  IF v_src.id IS NULL THEN
    RAISE EXCEPTION 'source_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_src.company !~~* v_company THEN
    RAISE EXCEPTION 'source_not_in_company'
      USING HINT = 'The source authorization does not belong to your company.';
  END IF;

  -- Validate new dates
  IF p_new_start_date IS NULL OR p_new_end_date IS NULL THEN
    RAISE EXCEPTION 'dates_required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_new_end_date < p_new_start_date THEN
    RAISE EXCEPTION 'end_before_start' USING ERRCODE = 'check_violation';
  END IF;
  IF (p_new_end_date - p_new_start_date) > 60 THEN
    RAISE EXCEPTION 'dates_exceed_60day_cap'
      USING HINT = 'Each grant (including renewals) is capped at 60 days.';
  END IF;

  -- INSERT new linked record (copies plate/vehicle/guest/unit/property from source)
  INSERT INTO public.guest_authorizations (
    company, property,
    plate, state, vehicle_make, vehicle_model, vehicle_color,
    guest_name, visiting_unit, resident_email, non_resident_reason,
    start_date, end_date,
    status, is_active,
    created_by_email, created_at,
    renewed_from_id
  ) VALUES (
    v_src.company, v_src.property,
    v_src.plate, v_src.state, v_src.vehicle_make, v_src.vehicle_model, v_src.vehicle_color,
    v_src.guest_name, v_src.visiting_unit, v_src.resident_email, v_src.non_resident_reason,
    p_new_start_date, p_new_end_date,
    'active', TRUE,
    lower(v_email), now(),
    p_source_id
  )
  RETURNING id INTO v_new_id;

  -- Audit (refs both source + new)
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_GUEST_RENEW',
    'guest_authorizations',
    v_new_id,
    jsonb_build_object(
      'source_id',      p_source_id,
      'plate',          v_src.plate,
      'company',        v_src.company,
      'property',       v_src.property,
      'guest_name',     v_src.guest_name,
      'new_start_date', p_new_start_date,
      'new_end_date',   p_new_end_date
    ),
    now()
  );

  RETURN v_new_id;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.renew_guest_authorization(BIGINT,DATE,DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.renew_guest_authorization(BIGINT,DATE,DATE) FROM anon;
GRANT  EXECUTE ON FUNCTION public.renew_guest_authorization(BIGINT,DATE,DATE) TO authenticated;

-- ── RPC 3 — revoke_guest_authorization ──────────────────────────────
-- Idempotent: revoking an already-revoked record is a no-op success (the
-- manager UI shouldn't show a revoked record's revoke button, but if the
-- request races, we don't error). The CHECK constraint guarantees
-- (status='revoked' ↔ revoked_at/revoked_by_email NOT NULL).
CREATE OR REPLACE FUNCTION public.revoke_guest_authorization(
  p_id     BIGINT,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email       TEXT;
  v_role        TEXT;
  v_company     TEXT;
  v_src_company TEXT;
  v_src_status  TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role guard
  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can revoke guest authorizations.';
  END IF;

  -- Caller's company
  SELECT company INTO v_company
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;

  -- Load source company + status
  SELECT company, status INTO v_src_company, v_src_status
    FROM public.guest_authorizations
    WHERE id = p_id;
  IF v_src_company IS NULL THEN
    RAISE EXCEPTION 'source_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_src_company !~~* v_company THEN
    RAISE EXCEPTION 'source_not_in_company'
      USING HINT = 'The authorization does not belong to your company.';
  END IF;

  -- Idempotent — already revoked = success no-op
  IF v_src_status = 'revoked' THEN
    RETURN TRUE;
  END IF;

  -- UPDATE
  UPDATE public.guest_authorizations
     SET status           = 'revoked',
         is_active        = FALSE,
         revoked_at       = now(),
         revoked_by_email = lower(v_email),
         revoked_reason   = NULLIF(trim(COALESCE(p_reason, '')), '')
   WHERE id = p_id;

  -- Audit
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_GUEST_REVOKE',
    'guest_authorizations',
    p_id,
    jsonb_build_object(
      'reason', NULLIF(trim(COALESCE(p_reason, '')), '')
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.revoke_guest_authorization(BIGINT,TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_guest_authorization(BIGINT,TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.revoke_guest_authorization(BIGINT,TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Table exists with expected columns ───────────────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='guest_authorizations'
--    ORDER BY ordinal_position;
--   -- Expected 22 rows: id, company, property, plate, state, vehicle_make,
--   -- vehicle_model, vehicle_color, guest_name, visiting_unit, resident_email,
--   -- non_resident_reason, start_date, end_date, status, is_active,
--   -- created_by_email, created_at, revoked_at, revoked_by_email,
--   -- revoked_reason, renewed_from_id.
--
-- ── B. CHECK constraints present ────────────────────────────────────
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.guest_authorizations'::regclass
--      AND contype = 'c'
--    ORDER BY conname;
--   -- Expected 5 rows:
--   --   guest_auth_60day_cap
--   --   guest_auth_dates_ordered
--   --   guest_auth_revoke_consistency
--   --   guest_auth_status_valid
--   --   guest_auth_unit_or_reason
--
-- ── C. Indexes present ──────────────────────────────────────────────
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='guest_authorizations'
--    ORDER BY indexname;
--   -- Expected 4 rows:
--   --   guest_authorizations_pkey
--   --   guest_auth_chain_lookup
--   --   guest_auth_enforcement_lookup
--   --   guest_auth_renewed_from
--
-- ── D. RLS policy inventory ─────────────────────────────────────────
--   SELECT polname, polcmd FROM pg_policy
--    WHERE polrelid = 'public.guest_authorizations'::regclass
--    ORDER BY polname;
--   -- Expected 4 rows (polcmd: r=SELECT, *=ALL):
--   --   admin_all_guest_auths           *
--   --   company_admin_own_guest_auths   *
--   --   driver_read_guest_auths         r
--   --   manager_own_guest_auths         *
--   -- NO resident policy (residents do not see guest auths).
--
-- ── E. RLS enabled ──────────────────────────────────────────────────
--   SELECT relrowsecurity FROM pg_class WHERE relname='guest_authorizations';
--   -- Expected: TRUE
--
-- ── F. RPCs exist + SECURITY DEFINER + correct GRANTs ───────────────
--   SELECT proname, prosecdef, provolatile
--     FROM pg_proc
--    WHERE pronamespace='public'::regnamespace
--      AND proname IN ('create_guest_authorization','renew_guest_authorization','revoke_guest_authorization')
--    ORDER BY proname;
--   -- Expected: 3 rows, prosecdef=TRUE for all.
--
-- ── G. RPC GRANTs (must NOT include anon or PUBLIC) ─────────────────
--   SELECT routine_name, grantee, privilege_type
--     FROM information_schema.routine_privileges
--    WHERE routine_schema='public'
--      AND routine_name LIKE '%guest_authorization%'
--    ORDER BY routine_name, grantee;
--   -- Expected: each routine granted to 'authenticated' only (and maybe
--   -- postgres/supabase_admin as owner). 'anon' and 'PUBLIC' MUST NOT appear.
--
-- ── H. Smoke: caller with no role cannot create ─────────────────────
--   -- Run as a session with no user_roles entry; SELECT auth.jwt() ->> 'email'
--   -- should return a non-NULL email.
--   -- SELECT public.create_guest_authorization('TEST1','TX',NULL,NULL,NULL,
--   --   'Test Guest','101',NULL,NULL,'Bayou Heights Apartments',
--   --   CURRENT_DATE, CURRENT_DATE + 1);
--   -- Expected: ERROR 'role_not_allowed'.
--
-- ── I. Smoke: 61-day cap enforced ───────────────────────────────────
--   -- As a manager:
--   -- SELECT public.create_guest_authorization('TEST2','TX',NULL,NULL,NULL,
--   --   'Test Guest','101',NULL,NULL,'<your_property>',
--   --   CURRENT_DATE, CURRENT_DATE + 61);
--   -- Expected: ERROR 'dates_exceed_60day_cap'.
-- ════════════════════════════════════════════════════════════════════
