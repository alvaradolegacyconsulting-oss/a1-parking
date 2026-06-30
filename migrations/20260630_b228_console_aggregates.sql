-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 1 — get_console_aggregates() SQL function
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   One SECURITY DEFINER function returning the per-company usage rollup
--   the Super-Admin Console needs: properties / vehicles (active +
--   pending) / violations 30d / passes 30d. ONE round-trip per console
--   load. Replaces the N+1 risk of iterating SELECTs per company.
--
-- WHY DEFINER
--   The caller (admin role) already has elevated access, but the function
--   joins across companies/properties/vehicles/violations/visitor_passes
--   — RLS policies on those tables would otherwise require careful per-
--   table policy alignment for the join to return clean data. Body
--   re-enforces super-admin scope (auth.jwt() ->> 'email' resolves to
--   user_roles.role='admin'). RAISES on non-admin callers.
--
-- METERING (Phase 2)
--   plate_reads_24h column is included now as a placeholder (always 0)
--   so the console JSX wires against the final shape. Phase 2 fills it
--   in via the audit_logs API_USAGE_METER aggregation. No console change
--   needed when Phase 2 lands — just the function body.
--
-- PERF
--   30d window on violations/passes uses created_at; both tables already
--   have created_at indexes. companies + properties + vehicles use ID
--   joins. EXPLAIN before ship — flag any seq-scan.
--
-- VERIFICATION
--   See sibling _verification.sql:
--     §1 — function exists, single overload
--     §2 — role gate (non-admin caller RAISES)
--     §3 — admin caller returns one row per company with sane counts
--     §4 — grants (authenticated EXECUTE; anon REVOKED)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_console_aggregates()
RETURNS TABLE (
  company_id        BIGINT,
  company_name      TEXT,
  company_tier      TEXT,
  company_tier_type TEXT,
  account_state     TEXT,
  is_active         BOOLEAN,
  properties_count  BIGINT,
  vehicles_active   BIGINT,
  vehicles_pending  BIGINT,
  violations_30d    BIGINT,
  passes_30d        BIGINT,
  plate_reads_24h   BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
BEGIN
  -- ── Role gate: only admin (super-admin) may call ───────────────
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
      HINT = 'get_console_aggregates is super-admin-only.';
  END IF;

  -- ── Single aggregate query, one row per company ───────────────
  -- All JOINs are LEFT so a brand-new company with no properties/etc
  -- still appears as a row with zeroes.
  RETURN QUERY
  SELECT
    c.id                                              AS company_id,
    c.name                                            AS company_name,
    c.tier                                            AS company_tier,
    c.tier_type                                       AS company_tier_type,
    c.account_state                                   AS account_state,
    c.is_active                                       AS is_active,
    COALESCE(p_agg.properties_count, 0)               AS properties_count,
    COALESCE(v_agg.vehicles_active,  0)               AS vehicles_active,
    COALESCE(v_agg.vehicles_pending, 0)               AS vehicles_pending,
    COALESCE(vio_agg.violations_30d, 0)               AS violations_30d,
    COALESCE(pass_agg.passes_30d,    0)               AS passes_30d,
    0::BIGINT                                         AS plate_reads_24h
  FROM public.companies c
  LEFT JOIN (
    SELECT company, COUNT(*) AS properties_count
    FROM public.properties
    WHERE is_active = TRUE
    GROUP BY company
  ) p_agg ON p_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company,
           COUNT(*) FILTER (WHERE v.is_active = TRUE  AND v.status = 'active')  AS vehicles_active,
           COUNT(*) FILTER (WHERE v.status = 'pending')                          AS vehicles_pending
    FROM public.vehicles v
    JOIN public.properties p ON p.name ~~* v.property
    GROUP BY p.company
  ) v_agg ON v_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company, COUNT(*) AS violations_30d
    FROM public.violations vi
    JOIN public.properties p ON p.name ~~* vi.property
    WHERE vi.created_at >= now() - interval '30 days'
      AND vi.voided_at IS NULL
    GROUP BY p.company
  ) vio_agg ON vio_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company, COUNT(*) AS passes_30d
    FROM public.visitor_passes vp
    JOIN public.properties p ON p.name ~~* vp.property
    WHERE vp.created_at >= now() - interval '30 days'
    GROUP BY p.company
  ) pass_agg ON pass_agg.company ~~* c.name
  ORDER BY c.name;
END;
$func$;

-- ── Grants ──────────────────────────────────────────────────────
-- DEFINER + role check in body, but still explicit grants per
-- [[feedback-function-public-grant-supabase-default]] +
-- [[feedback-revoke-from-anon-explicitly]].
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_console_aggregates() TO authenticated;

-- Audit row
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE1',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260630_b228_console_aggregates',
    'change',    'CREATE OR REPLACE FUNCTION get_console_aggregates() SECURITY DEFINER',
    'phase',     'B228 Phase 1 — console shell + CRM + rollups',
    'rationale', 'Single-round-trip per-company usage aggregates for the super-admin console. Replaces N+1 risk.'
  ),
  now()
);

COMMIT;
