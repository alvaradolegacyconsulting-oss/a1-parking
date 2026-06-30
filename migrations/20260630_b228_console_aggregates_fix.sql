-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 1 — get_console_aggregates() FIX (ambiguity + grant)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- Two defects in 20260630_b228_console_aggregates.sql, both fixed here
-- in one CREATE OR REPLACE + grant cleanup:
--
-- FIX 1 — bare `is_active` collides with the OUT parameter.
--   RETURNS TABLE (..., is_active BOOLEAN, ...) declares `is_active`
--   as a plpgsql variable in scope inside the function body. A bare
--   `WHERE is_active = TRUE` in the p_agg subquery was ambiguous
--   between (a) properties.is_active and (b) the OUT param —
--   Postgres correctly refused to resolve and errored "column
--   reference 'is_active' is ambiguous", which surfaced in the
--   browser as "Could not load console data."
--
--   Two-layer fix:
--   (a) Add `#variable_conflict use_column` directive at the top of
--       the function — tells plpgsql to prefer column references over
--       OUT-param variables when names collide. Guards against any
--       future bare reference being reintroduced.
--   (b) Add the explicit `p` alias to the p_agg FROM clause and
--       qualify `p.is_active` belt-and-suspenders. (All other
--       references in the function body were already qualified —
--       c.is_active, v.is_active, etc. — only this one was bare.)
--
-- FIX 2 — service_role retained EXECUTE.
--   §2 verification showed proacl as `postgres=X, authenticated=X,
--   service_role=X` rather than `authenticated=X` only. The original
--   migration revoked PUBLIC + anon but left service_role implicit.
--   Per the standing REVOKE-all-then-GRANT-authenticated discipline
--   (memory: [[feedback-function-public-grant-supabase-default]] +
--   [[feedback-revoke-from-anon-explicitly]]), service_role gets an
--   explicit REVOKE too. Verified post-apply via §2.
--
-- POST-APPLY
--   Re-run the original verification (20260630_b228_console_aggregates_verification.sql):
--     §1 PASS · §1b = 1 · §2 PASS now (authenticated=X only) ·
--     §3 PASS · §4 (this audit row lands separately so §4 still passes)
--   App: /admin_console loads without the red banner; CRM renders.
--   Role-bypass: non-admin call → 42501 forbidden_not_admin.
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
-- FIX 1(a) — prefer column references over OUT-param variables on
-- name collision. Guards against future bare references.
#variable_conflict use_column
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
  -- still appears as a row with zeroes. Every is_active reference
  -- is explicitly qualified — FIX 1(b).
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
    SELECT p.company, COUNT(*) AS properties_count
    FROM public.properties p                          -- FIX 1(b): alias
    WHERE p.is_active = TRUE                          -- FIX 1(b): qualified
    GROUP BY p.company
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

-- ── FIX 2 — explicit REVOKE FROM service_role ───────────────────
-- Plus re-confirm PUBLIC + anon already revoked (idempotent re-run).
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_aggregates() TO authenticated;

-- Audit row (the fix; separate from the original Phase 1 audit row
-- which stays in place for traceability).
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE1_FIX',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration',  '20260630_b228_console_aggregates_fix',
    'fixes',      jsonb_build_array(
      'is_active bare-reference ambiguity vs RETURNS TABLE OUT param (added #variable_conflict use_column + qualified the p_agg WHERE clause)',
      'service_role retained EXECUTE — added explicit REVOKE'
    ),
    'verified',   'Re-run 20260630_b228_console_aggregates_verification.sql; §2 PASS expected.'
  ),
  now()
);

COMMIT;
