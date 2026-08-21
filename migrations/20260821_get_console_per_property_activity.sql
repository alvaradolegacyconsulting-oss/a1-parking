-- ══════════════════════════════════════════════════════════════════════
-- 20260821_get_console_per_property_activity.sql
--
-- Super-admin console Commit 2 — per-property activity RPC.
-- Mateo Aug 21: A1 alone will be 15+ properties; per-company view
-- would render A1 as one healthy row and hide every property-level
-- problem inside it. Per-property is the axis that matters.
--
-- Returns one row per active property with the metrics needed for
-- mode inference (full-service / visitor-only / enforcement-only /
-- not-started) + last-activity floor (property.created_at) for the
-- "top of list = call sheet" ascending sort.
--
-- SHAPE mirrors get_console_aggregates (2026-06-30 b228) discipline:
--   - SECURITY DEFINER + role gate on admin only
--   - #variable_conflict use_column
--   - Single query with LEFT JOIN'd aggregate subqueries, all with
--     is_active or created_at predicates qualified
--   - REVOKE FROM anon + service_role, GRANT TO authenticated only
--     (RPC's own role gate is the load-bearing check)
--
-- 🔴 NON-GOALS (Mateo Aug 21)
--   ❌ No anomaly flags in the return shape. Mode inference is
--      client-side + must be visible + trusted for a week before
--      per-mode flags can be built without false-positive risk
--      (Sugarberry visitor-only would trip a "passes with no roster"
--      flag every day and be wrong).
--   ❌ No track-fit metrics (deferred to Bar-2 horizon — A1 as sole
--      production has nothing to compare against).
--   ❌ No plate-scan count. Adding it means picking which audit_logs
--      actions count (PLATE_SCAN vs DNT-check vs tow-lookup) —
--      separate design pass. v1 last_activity_at proxies via the
--      four existing activity sources.
--
-- APPLY: single database. Apply once, verification returns one PASS
-- row on 6 gates.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

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
-- Prefer column references over OUT-param variables on name collision.
-- Same guard as get_console_aggregates.
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
      HINT = 'get_console_per_property_activity is super-admin-only.';
  END IF;

  -- ── One row per active property ─────────────────────────────────
  -- LEFT JOINs on aggregated subqueries so a brand-new property with
  -- zero activity still returns a row (last_activity_at falls back to
  -- property.created_at via GREATEST).
  --
  -- Property↔company join uses lower(trim(...)) equality (residents.
  -- property + companies.name are TEXT with case/whitespace drift
  -- possible; matches assign_space / decommission_space discipline
  -- pattern).
  --
  -- Activity aggregates join on `~~*` (ILIKE) to match the
  -- get_console_aggregates precedent + tolerate property-name case
  -- variance across the four child tables (residents, vehicles,
  -- spaces, violations, visitor_passes).
  RETURN QUERY
  SELECT
    p.id                                      AS property_id,
    p.name                                    AS property_name,
    c.id                                      AS company_id,
    c.name                                    AS company_name,
    c.company_env                             AS company_env,
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
  ORDER BY p.name;   -- stable server-side order; client sorts by column
END;
$func$;

COMMENT ON FUNCTION public.get_console_per_property_activity() IS
  'Super-admin console per-property activity view. Returns one row per active property with residents_active + vehicles_active + spaces_active + violations_30d + passes_30d + property_created_at + last_activity_at (GREATEST across the four activity sources). company_env in the return so the client can filter to production default (Commit 1 discipline). Mode inference (full-service / visitor-only / enforcement-only / not-started) is client-side — server does not classify. Non-goals: no anomaly flags, no plate-scans metric, no track-fit. Read-only. 2026-08-21.';

-- Grants: authenticated EXECUTE only; anon + service_role REVOKED
-- (RPC's own role gate is the load-bearing check).
REVOKE ALL     ON FUNCTION public.get_console_per_property_activity() FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_console_per_property_activity() FROM anon;
REVOKE ALL     ON FUNCTION public.get_console_per_property_activity() FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_per_property_activity() TO   authenticated;

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_GET_CONSOLE_PER_PROPERTY_ACTIVITY',
  'public.get_console_per_property_activity()',
  'get_console_per_property_activity',
  jsonb_build_object(
    'migration',   '20260821_get_console_per_property_activity',
    'purpose',     'Super-admin console Commit 2 — per-property activity view',
    'shape',       'one row per active property; residents/vehicles/spaces/violations_30d/passes_30d + last_activity_at',
    'non_goals',   jsonb_build_array(
      'no anomaly flags',
      'no plate-scans metric',
      'no track-fit',
      'no server-side mode classification (client-side)'
    ),
    'grants',      'authenticated EXECUTE; anon + service_role REVOKED; role gate = admin'
  )
);

COMMIT;
