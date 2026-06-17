-- Cascading Deactivation — derived effective-active access model
--
-- ── DESIGN (decisions locked, do not re-litigate in this file) ──────
--   1. DERIVED access, not cascade-write. Each entity keeps its own
--      is_active. Effective access is COMPUTED at gate-time as a chain.
--      Reactivation auto-restores downstream — no clobbering of
--      independently-deactivated entities.
--   2. PM-deactivation ≠ property-deactivation. Deactivating a PM
--      affects only that PM. Deactivating a property cascades.
--   3. PER-PROPERTY scoping (PMs). A PM on properties A+B,
--      deactivate-A → scoped out of A only. The chain is parameterized
--      on scope_property so the same helper handles single-property
--      and multi-property cases.
--   4. Visitor-pass RPC NOT closed by this migration. Confirmed scope
--      reduction: the public /visitor anon path is intentionally open
--      (QR-driven visitor flow); the only authenticated route to
--      create_visitor_pass is through the resident portal, closed by
--      the Layer A login gate. No marginal write capability over the
--      anon path.
--   5. Vehicle-request INSERT IS closed by a DEFINER RPC + DROP of
--      the resident_insert_vehicles RLS policy. Defense-in-depth vs
--      crafted REST POST with a valid-but-deactivated session (the
--      B90 lesson — UI gate is not a security control).
--   6. update_my_vehicle_cosmetic + mark_my_vehicle_declined_read are
--      DEFERRED for the effective-active check (lower-risk: a
--      deactivated resident editing color or marking as read is not a
--      security risk). Filed as a follow-up. The MUST-HAVE is INSERT.
--
-- ── EXTENDS THE PROVEN SUSPENSION GATE ──────────────────────────────
-- companies.account_state (B66.5) already drives a hard lockout via
-- app/lib/portal-account-gate.ts:evaluatePortalGate. This migration
-- adds the missing pieces of the chain (residents/properties/PMs)
-- and bundles them into a single SECURITY DEFINER helper the gate +
-- RPC body guards both consume.
--
-- ── APPLY DISCIPLINE ───────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Five parts; partial apply leaves the chain
-- inconsistent (e.g. helper exists but request_my_vehicle isn't
-- granted yet → resident vehicle requests fail loud).

-- ── PRE-APPLY VERIFICATION ─────────────────────────────────────────

SELECT '─────── PRE-APPLY: user_roles columns (look for is_active) ───────' AS marker;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_roles'
ORDER BY ordinal_position;
-- Expected before: NO is_active column (the schema gap).
-- Expected after: is_active boolean NOT NULL DEFAULT true.

SELECT '─────── PRE-APPLY: resident_insert_vehicles policy ───────' AS marker;

SELECT policyname, cmd, qual AS using_expr, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vehicles'
  AND policyname = 'resident_insert_vehicles';
-- Expected before: one row (FOR INSERT, scoped by (property, unit)
-- against residents email). Expected after: zero rows (DROPped).

SELECT '─────── PRE-APPLY: existing effective-active / request_my_vehicle (idempotent re-paste check) ───────' AS marker;

SELECT proname, pg_get_function_identity_arguments(oid) AS args, prosecdef
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_my_effective_active', 'request_my_vehicle');
-- Expected ZERO rows on first apply.

-- ── PART 1 — user_roles.is_active column ────────────────────────────
-- Closes the schema gap from the diagnostic Lane 1: there was no
-- is_active flag on user_roles, so PM/leasing_agent deactivation had
-- no data representation. NOT NULL DEFAULT true means every existing
-- row gets the active state by default (no behavior change for
-- in-flight users; admin tooling sets to false to deactivate).

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ── PART 2 — get_my_effective_active(scope_property TEXT) ──────────
-- The chain in one reusable SECURITY DEFINER helper. Consumed by the
-- portal gate (Layer A) and the request_my_vehicle RPC (Layer B).
--
-- Chain (top → bottom):
--   1. Caller has a user_roles row → else FALSE (no role, no access).
--   2. Caller's user_roles.is_active is true → else FALSE.
--   3. Admin role → SHORT-CIRCUIT TRUE (platform-wide bypass).
--   4. Company account_state ∈ {active, past_due} → else FALSE.
--      past_due retains access with banner per B66.5 4.3 era-shift.
--   5. Resident role → residents.is_active must be true.
--      Auto-derive scope_property from residents.property if NULL.
--   6. If scope_property is set:
--        a. PM/leasing_agent → scope_property must be in their
--           user_roles.property[] (assignment).
--        b. All roles → properties.is_active must be true for that
--           property (in the caller's company).
--   7. Otherwise → TRUE.
--
-- Lower-equality (NOT ILIKE) per A2 wildcard-spoof lesson: company
-- and property names compared via lower()=lower() to avoid pattern-
-- match injection if a stored value contains % or _.
--
-- Inline lookup against user_roles + residents (the b155_2 pattern,
-- proven by A2 close-out) — no dependency on get_my_role() /
-- get_my_company() helpers which had cross-fn validation surfaces.

CREATE OR REPLACE FUNCTION public.get_my_effective_active(scope_property TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_email           TEXT;
  v_role            TEXT;
  v_company         TEXT;
  v_properties      TEXT[];
  v_user_active     BOOLEAN;
  v_company_state   TEXT;
  v_property_active BOOLEAN;
  v_resident_active BOOLEAN;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- 1. Caller's user_roles row.
  SELECT role, company, property, is_active
    INTO v_role, v_company, v_properties, v_user_active
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 2. Caller's own is_active.
  IF v_user_active IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  -- 3. Admin short-circuit.
  IF v_role = 'admin' THEN
    RETURN TRUE;
  END IF;

  -- 4. Company account_state.
  SELECT account_state INTO v_company_state
    FROM public.companies
    WHERE lower(name) = lower(v_company)
    LIMIT 1;
  IF v_company_state NOT IN ('active', 'past_due') THEN
    RETURN FALSE;
  END IF;

  -- 5. Resident: check residents.is_active + derive scope_property.
  IF v_role = 'resident' THEN
    SELECT is_active INTO v_resident_active
      FROM public.residents
      WHERE lower(email) = lower(v_email)
      LIMIT 1;
    IF v_resident_active IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
    IF scope_property IS NULL THEN
      SELECT property INTO scope_property
        FROM public.residents
        WHERE lower(email) = lower(v_email)
        LIMIT 1;
    END IF;
  END IF;

  -- 6. Per-property scope check.
  IF scope_property IS NOT NULL THEN
    -- 6a. PM/leasing_agent assignment.
    IF v_role IN ('manager', 'leasing_agent') THEN
      IF NOT (scope_property = ANY(v_properties)) THEN
        RETURN FALSE;
      END IF;
    END IF;
    -- 6b. Property is_active.
    SELECT is_active INTO v_property_active
      FROM public.properties
      WHERE lower(name) = lower(scope_property)
        AND lower(company) = lower(v_company)
      LIMIT 1;
    IF v_property_active IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) TO authenticated;

-- ── PART 3 — request_my_vehicle RPC (DEFINER pattern, mirrors B90 v2) ─
-- Replaces the resident_insert_vehicles RLS-gated direct INSERT path
-- with a body-guarded RPC. Signature pins the 6 cosmetic columns
-- (allowlist-by-signature). Body guards:
--   • caller is effectively active (single helper call)
--   • caller is a resident
--   • property + unit derived from residents row (not caller-supplied,
--     so a crafted REST PATCH can't smuggle a different scope)
-- Inserts vehicle in pending+is_active=false state (matches existing
-- workflow — manager approves later via existing approval flow).

CREATE OR REPLACE FUNCTION public.request_my_vehicle(
  p_plate TEXT,
  p_state TEXT,
  p_make  TEXT,
  p_model TEXT,
  p_year  INTEGER,
  p_color TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_email     TEXT;
  v_role      TEXT;
  v_property  TEXT;
  v_unit      TEXT;
  v_normalized_plate TEXT;
  v_vehicle_id BIGINT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Effective-active check (THE deactivation guard — covers chain
  -- through user_roles.is_active, companies.account_state,
  -- residents.is_active, and the resident's property's is_active).
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  -- Caller-is-resident gate.
  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self vehicle requests only.';
  END IF;

  -- Resolve property + unit from residents row (NOT caller-supplied).
  SELECT property, unit INTO v_property, v_unit
    FROM public.residents
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_property IS NULL OR v_unit IS NULL THEN
    RAISE EXCEPTION 'no residents row for caller';
  END IF;

  -- Normalize plate (same shape as create_visitor_pass + manager
  -- portal: uppercase, alphanumeric only).
  v_normalized_plate := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized_plate) = 0 THEN
    RAISE EXCEPTION 'plate required'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.vehicles (
    plate, state, make, model, year, color,
    unit, property, resident_email,
    is_active, status
  ) VALUES (
    v_normalized_plate,
    p_state, p_make, p_model, p_year, p_color,
    v_unit, v_property, lower(v_email),
    FALSE,           -- pending manager approval (matches existing workflow)
    'pending'
  )
  RETURNING id INTO v_vehicle_id;

  RETURN v_vehicle_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ── PART 4 — DROP resident_insert_vehicles policy ──────────────────
-- Single-write-path discipline (same as B90 v2 dropped
-- resident_update_vehicles). After this drop, residents have ZERO
-- direct INSERT path against vehicles — request_my_vehicle RPC is the
-- only authorized resident write surface for new vehicles.
--
-- Adjacent policies untouched:
--   • resident_select_vehicles — SELECT preserved (resident can still
--     view their vehicles regardless of effective-active state;
--     viewing a deactivated row is not a security risk).
--   • update_my_vehicle_cosmetic + mark_my_vehicle_declined_read
--     RPCs (B90 v2) — unchanged. Follow-up filed to add the
--     effective-active check on those too.
--   • manager/CA/admin write paths — untouched.

DROP POLICY IF EXISTS resident_insert_vehicles ON public.vehicles;

-- ── POST-APPLY VERIFICATION ────────────────────────────────────────

SELECT '─────── POST-APPLY: user_roles.is_active column ───────' AS marker;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_roles'
  AND column_name = 'is_active';
-- Expected one row: is_active | boolean | NO | true

SELECT '─────── POST-APPLY: helper + RPC exist with correct shape ───────' AS marker;

SELECT
  proname AS fn,
  pg_get_function_identity_arguments(oid) AS args,
  pg_get_function_result(oid) AS returns,
  prosecdef AS is_definer,
  proconfig AS config
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_my_effective_active', 'request_my_vehicle')
ORDER BY proname;
-- Expected:
--   get_my_effective_active | scope_property text | boolean       | t | {search_path=public, search_path=pg_temp}
--   request_my_vehicle      | p_plate text, ... | bigint          | t | same

SELECT '─────── POST-APPLY: proacl on both new RPCs ───────' AS marker;

SELECT
  proname AS fn,
  proacl::TEXT AS proacl,
  CASE WHEN proacl::TEXT LIKE '%anon=X%' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END AS anon_exec,
  CASE WHEN proacl::TEXT ~ '(^|[,{])=X' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END AS public_exec,
  CASE WHEN proacl::TEXT LIKE '%authenticated=X%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END AS authenticated_exec
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_my_effective_active', 'request_my_vehicle');
-- Expected: both rows show anon_exec=NO, public_exec=NO, authenticated_exec=YES.

SELECT '─────── POST-APPLY: resident_insert_vehicles policy DROPped ───────' AS marker;

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vehicles'
  AND policyname = 'resident_insert_vehicles';
-- Expected: zero rows.

SELECT '─────── POST-APPLY: vehicles INSERT policies remaining ───────' AS marker;

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vehicles'
  AND cmd IN ('INSERT', 'ALL')
ORDER BY policyname;
-- Expected (4 rows, NO resident_insert_vehicles):
--   admin_all_vehicles           | ALL
--   company_admin_insert_vehicles| INSERT
--   driver_insert_vehicles       | INSERT  (if exists per repo state)
--   manager_insert_vehicles      | INSERT
