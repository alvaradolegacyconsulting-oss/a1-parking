-- ══════════════════════════════════════════════════════════════════════
-- 20260821_console_rpcs_enum_cast_fix.sql
--
-- 🔴 POST-APPLY FIX — both Aug 21 console RPCs threw 42804 on invocation
-- ("structure of query does not match function result type") because
-- their SELECT returned c.company_env unchanged (type company_env_enum)
-- while RETURNS TABLE declared the column as TEXT.
--
-- Fix: cast c.company_env::TEXT in both SELECTs. Idempotent CREATE OR
-- REPLACE — safe whether Jose already applied the broken originals or
-- not.
--
-- Root cause: I wrote both RPCs from the get_console_aggregates
-- precedent (which computes company_env client-side via a companion
-- query and never returns it from the RPC), missing that pushing
-- company_env into the return needed an explicit ::TEXT cast against
-- the enum type. All seven structural gates in each verification file
-- passed because the type-check is a RUNTIME error — CREATE FUNCTION
-- accepts the definition, and only invocation trips 42804.
--
-- New pattern rule: verification MUST include an execution gate. See
-- the updated verification files (…_verification.sql) — each now runs
-- SELECT COUNT(*) FROM the function.
--
-- Two RPCs fixed in this one file:
--   1. public.get_console_per_property_activity()      → return col cast
--   2. public.get_console_red_warnings(TEXT)           → return col cast
--
-- APPLY: single database. No separate verification for this file —
-- rerun the two updated *_verification.sql files (each now includes
-- execution gate); each returns one PASS row.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── FIX 1 / 2 — get_console_per_property_activity ───────────────────
-- Preserving every other line verbatim from 20260821_get_console_per_
-- property_activity.sql; only the c.company_env return column changes
-- (adds ::TEXT). Comments trimmed for brevity; the original file
-- carries the full rationale + non-goals.
CREATE OR REPLACE FUNCTION public.get_console_per_property_activity()
RETURNS TABLE (
  property_id           BIGINT,
  property_name         TEXT,
  company_id            BIGINT,
  company_name          TEXT,
  company_env           TEXT,
  property_created_at   TIMESTAMPTZ,
  residents_active      BIGINT,
  vehicles_active       BIGINT,
  spaces_active         BIGINT,
  violations_30d        BIGINT,
  passes_30d            BIGINT,
  last_activity_at      TIMESTAMPTZ
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
      HINT = 'get_console_per_property_activity is super-admin-only.';
  END IF;

  RETURN QUERY
  SELECT
    p.id                                      AS property_id,
    p.name                                    AS property_name,
    c.id                                      AS company_id,
    c.name                                    AS company_name,
    c.company_env::TEXT                       AS company_env,   -- 🔴 FIX: was `c.company_env` (enum) → 42804
    p.created_at                              AS property_created_at,
    COALESCE(r_agg.residents_active, 0)       AS residents_active,
    COALESCE(v_agg.vehicles_active, 0)        AS vehicles_active,
    COALESCE(s_agg.spaces_active, 0)          AS spaces_active,
    COALESCE(vio_agg.violations_30d, 0)       AS violations_30d,
    COALESCE(pass_agg.passes_30d, 0)          AS passes_30d,
    GREATEST(
      p.created_at,
      COALESCE(r_agg.last_r,     '-infinity'::timestamptz),
      COALESCE(v_agg.last_v,     '-infinity'::timestamptz),
      COALESCE(vio_agg.last_vio, '-infinity'::timestamptz),
      COALESCE(pass_agg.last_pass, '-infinity'::timestamptz)
    )                                         AS last_activity_at
  FROM public.properties p
  LEFT JOIN public.companies c
         ON lower(trim(c.name)) = lower(trim(p.company))
  LEFT JOIN (
    SELECT r.property,
           COUNT(*) FILTER (WHERE r.is_active = TRUE) AS residents_active,
           MAX(r.created_at)                          AS last_r
    FROM public.residents r
    GROUP BY r.property
  ) r_agg ON r_agg.property ~~* p.name
  LEFT JOIN (
    SELECT v.property,
           COUNT(*) FILTER (WHERE v.is_active = TRUE) AS vehicles_active,
           MAX(v.created_at)                          AS last_v
    FROM public.vehicles v
    GROUP BY v.property
  ) v_agg ON v_agg.property ~~* p.name
  LEFT JOIN (
    SELECT s.property,
           COUNT(*) FILTER (WHERE s.is_active = TRUE) AS spaces_active
    FROM public.spaces s
    GROUP BY s.property
  ) s_agg ON s_agg.property ~~* p.name
  LEFT JOIN (
    SELECT vi.property,
           COUNT(*)          AS violations_30d,
           MAX(vi.created_at) AS last_vio
    FROM public.violations vi
    WHERE vi.created_at >= now() - interval '30 days'
      AND vi.voided_at IS NULL
    GROUP BY vi.property
  ) vio_agg ON vio_agg.property ~~* p.name
  LEFT JOIN (
    SELECT vp.property,
           COUNT(*)          AS passes_30d,
           MAX(vp.created_at) AS last_pass
    FROM public.visitor_passes vp
    WHERE vp.created_at >= now() - interval '30 days'
    GROUP BY vp.property
  ) pass_agg ON pass_agg.property ~~* p.name
  WHERE p.is_active = TRUE
  ORDER BY p.name;
END;
$func$;

-- ── FIX 2 / 2 — get_console_red_warnings(TEXT) ──────────────────────
-- Same enum-cast fix. Preserves DEFAULT 'production' verbatim (per
-- feedback_create_or_replace_drops_defaults.md — dropping the default
-- would change the function signature and break Jose's callers).
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
    c.company_env::TEXT                                 AS company_env,   -- 🔴 FIX: was `c.company_env` (enum) → 42804
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
         ON p.name ~~* v.property
  LEFT JOIN public.companies c
         ON lower(trim(c.name)) = lower(trim(p.company))
  WHERE
    (
      (v.status = 'active'  AND v.is_active = FALSE)
      OR
      (v.status = 'pending' AND v.is_active = TRUE)
    )
    AND (p_company_env IS NULL OR c.company_env::TEXT = p_company_env)
  ORDER BY c.name NULLS LAST, v.property, v.unit, v.plate;
END;
$func$;

-- Schema audit row — fix is a distinct event from the original CREATE.
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_CONSOLE_RPCS_ENUM_CAST_FIX',
  'public.get_console_per_property_activity() + public.get_console_red_warnings(TEXT)',
  '20260821_console_rpcs_enum_cast_fix',
  jsonb_build_object(
    'migration',   '20260821_console_rpcs_enum_cast_fix',
    'root_cause',  'c.company_env (company_env_enum) returned as TEXT-declared column → 42804 runtime; not caught by CREATE FUNCTION or by structural verification gates',
    'fix',         'c.company_env::TEXT explicit cast in both SELECTs',
    'pattern',     'RPC verification must include execution gate — reading pg_proc alone is not deployment gate',
    'idempotent',  TRUE
  )
);

COMMIT;
