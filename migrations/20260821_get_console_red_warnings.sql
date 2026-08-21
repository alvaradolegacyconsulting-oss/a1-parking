-- ══════════════════════════════════════════════════════════════════════
-- 20260821_get_console_red_warnings.sql
--
-- Super-admin console: red-only cross-tenant warnings rollup.
-- Small standalone piece Jose asked for (Mateo Aug 21). Two red
-- predicates only — the amber four are the PM's job by design.
--
-- 🔴 PROVISIONAL — DELIBERATE SECOND IMPLEMENTATION 🔴
--
-- The two red predicates below are ALSO implemented in TypeScript at
-- app/lib/property-warnings.ts (kinds #1 and #5, lines 105-147). This
-- SQL RPC is a DELIBERATE mirror, accepted because two column
-- comparisons is a small enough surface that the drift risk is
-- outweighed by giving Jose the cross-tenant view now instead of
-- waiting on the full 6-predicate extraction.
--
-- When the full warning extraction lands (Mateo Item 2, blocked on
-- Item 1 Aug 8 diagnostic), THIS RPC EITHER CALLS INTO IT OR IS
-- DELETED. Do not tune the predicates here — if a red predicate needs
-- changing, change it in TypeScript first and mirror the change here
-- in the same commit. Two implementations agreeing is the mitigation.
--
-- ── PARITY WITH TYPESCRIPT ──────────────────────────────────────────
--
-- TS predicate #1 (property-warnings.ts:107):
--   v.status === 'active' && v.is_active === false
-- TS predicate #5 (property-warnings.ts:134):
--   v.is_active === true && v.status === 'pending'
--
-- Spec draft used `status IN ('active','approved')` for #1 — 'approved'
-- is NOT a vehicles.status value in this codebase (it appears on
-- space_requests.status and vehicle_plate_changes.status only).
-- Functionally equivalent to `status='active'`; mirror mirrors TS
-- exactly to keep the parity check honest.
--
-- ── FIELD SHAPE ─────────────────────────────────────────────────────
--
--   company_id / company_name / company_env — resolved via
--     lower(trim()) join on companies.name = vehicles.property's
--     properties.company. Rows that fail to resolve return NULL for
--     these (surfaced, not hidden — the caller can filter).
--   property     — vehicles.property VERBATIM (join-miss surfaces here)
--   unit         — vehicles.unit VERBATIM. Manager panel uses the
--                  resident's unit (r.unit) because it has crmResidents
--                  in hand; for a super-admin rollup we use the value
--                  stored on the offending row itself — this is what
--                  actually got recorded and is what an audit would
--                  quote. In practice they match; when they don't,
--                  THAT is a separate warning class worth catching.
--   plate        — vehicles.plate
--   kind         — 'portal_approved_enforcement_denied'
--                  | 'enforcement_authorized_portal_pending'
--   vehicle_status + vehicle_is_active — raw as-stored, so Jose can
--     assess without a second query (Mateo spec)
--   vehicle_id + vehicle_created_at — stable React key + age
--
-- ── FILTER ──────────────────────────────────────────────────────────
--
--   p_company_env TEXT DEFAULT 'production'
--     NULL          → return all rows (including company_env=NULL)
--     'production'  → exact match
--     'test'/'demo' → exact match
--   Server-side default is 'production' matching Commit 1 discipline.
--   Client calls with NULL at mount, filters client-side on the shared
--   page-level envFilter so toggling is instant (no RPC re-call).
--
-- APPLY: single database. Verification returns one PASS row on 7 gates.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_console_red_warnings(
  p_company_env TEXT DEFAULT 'production'
)
RETURNS TABLE (
  company_id          BIGINT,
  company_name        TEXT,
  company_env         TEXT,
  property            TEXT,
  unit                TEXT,
  plate               TEXT,
  kind                TEXT,
  vehicle_status      TEXT,
  vehicle_is_active   BOOLEAN,
  vehicle_id          BIGINT,
  vehicle_created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
BEGIN
  -- ── Role gate: admin only ──────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(v_caller_email) = 0 THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501',
      HINT = 'get_console_red_warnings is super-admin-only.';
  END IF;

  RETURN QUERY
  SELECT
    c.id                                                AS company_id,
    c.name                                              AS company_name,
    c.company_env                                       AS company_env,
    v.property                                          AS property,
    v.unit                                              AS unit,
    v.plate                                             AS plate,
    CASE
      -- MIRROR TypeScript property-warnings.ts:107 EXACTLY.
      WHEN v.status = 'active'  AND v.is_active = FALSE THEN 'portal_approved_enforcement_denied'
      -- MIRROR TypeScript property-warnings.ts:134 EXACTLY.
      WHEN v.status = 'pending' AND v.is_active = TRUE  THEN 'enforcement_authorized_portal_pending'
    END                                                 AS kind,
    v.status                                            AS vehicle_status,
    v.is_active                                         AS vehicle_is_active,
    v.id                                                AS vehicle_id,
    v.created_at                                        AS vehicle_created_at
  FROM public.vehicles v
  LEFT JOIN public.properties p
         ON p.name ~~* v.property             -- ILIKE (matches aggregates RPC precedent)
  LEFT JOIN public.companies c
         ON lower(trim(c.name)) = lower(trim(p.company))
  WHERE
    -- Predicate: match either red condition
    (
      (v.status = 'active'  AND v.is_active = FALSE)
      OR
      (v.status = 'pending' AND v.is_active = TRUE)
    )
    -- Env filter: NULL param → all rows (including unresolved); value → exact match
    AND (p_company_env IS NULL OR c.company_env::TEXT = p_company_env)
  ORDER BY c.name NULLS LAST, v.property, v.unit, v.plate;
END;
$func$;

COMMENT ON FUNCTION public.get_console_red_warnings(TEXT) IS
  'Super-admin console red-warnings rollup. Returns one row per vehicle matching either red predicate: portal_approved_enforcement_denied (status=active AND is_active=false) OR enforcement_authorized_portal_pending (status=pending AND is_active=true). DELIBERATE mirror of app/lib/property-warnings.ts kinds #1 and #5; do not tune predicates here (change TypeScript first, mirror in same commit). Provisional — call into full extraction or delete when property-warnings extraction lands. Filter: p_company_env TEXT DEFAULT ''production''; NULL returns all envs incl. unresolved. Read-only. Admin-gated. 2026-08-21.';

-- Grants: authenticated EXECUTE only; anon + service_role REVOKED
-- (RPC's own role gate is the load-bearing check).
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_red_warnings(TEXT) TO   authenticated;

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_GET_CONSOLE_RED_WARNINGS',
  'public.get_console_red_warnings(TEXT)',
  'get_console_red_warnings',
  jsonb_build_object(
    'migration', '20260821_get_console_red_warnings',
    'purpose',   'Super-admin console red-warnings cross-tenant rollup — small standalone piece Jose asked for; deliberate mirror of TS kinds #1 and #5',
    'provisional', TRUE,
    'mirrors',   'app/lib/property-warnings.ts kinds #1 (portal_approved_enforcement_denied) and #5 (enforcement_authorized_portal_pending)',
    'default_filter', 'p_company_env=''production''',
    'grants',    'authenticated EXECUTE; anon + service_role REVOKED; role gate = admin'
  )
);

COMMIT;
