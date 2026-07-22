-- ═══════════════════════════════════════════════════════════════════════
-- audit-public-grants-2026-07-22.sql
-- ═══════════════════════════════════════════════════════════════════════
-- B182/B183 grant-matrix audit — pull off backlog per Mateo 2026-07-22.
--
-- Triggered by the provisioning_failures grant-layer hole
-- (adfc6e1 shipped 2026-07-21 with authenticated retaining INSERT
-- on a PII-carrying table for ~24h). Two-for-two on the same
-- Supabase-default-grant hole (order_forms caught in verification,
-- provisioning_failures live) means the migration template adds RLS
-- without REVOKE'ing baseline grants — every table created that way
-- has this latent.
--
-- ── What this audit produces ───────────────────────────────────────────
-- One row per public schema table with the following columns:
--   table_name
--   rls_enabled
--   select_policy_count      — count of SELECT policies (0 = no read control)
--   all_policy_count         — count of FOR ALL policies
--   select_policy_summary    — brief characterization of the qual (broad? restrictive?)
--   anon_select              — anon has SELECT grant
--   anon_insert              — anon has INSERT grant
--   anon_update              — anon has UPDATE grant
--   anon_delete              — anon has DELETE grant
--   auth_select              — authenticated has SELECT grant
--   auth_insert              — authenticated has INSERT grant
--   auth_update              — authenticated has UPDATE grant
--   auth_delete              — authenticated has DELETE grant
--   risk_class               — computed severity: HIGH / MEDIUM / LOW / OK
--
-- ── Risk classification ────────────────────────────────────────────────
--   HIGH   — RLS disabled AND anon SELECT granted
--            OR SELECT policy qual is 'true' AND anon SELECT granted
--            → real anonymous READ exposure of full table contents.
--
--   MEDIUM — RLS enabled AND SELECT policy is not admin-only
--            AND anon has any write grant
--            → real anonymous WRITE exposure (spoofed rows).
--            OR authenticated has write grants on an admin-SELECT table
--            (same class as adfc6e1: spoofed rows from any signed-in
--            user, gated by RLS admin-check but grant-layer open).
--
--   LOW    — RLS enabled + admin-only SELECT + authenticated has SELECT
--            grant + no write grants beyond service_role
--            → tight state; standard shape for ops-only tables.
--
--   OK     — RLS enabled + policies match expected shape for the table's
--            intended access model + grants closed appropriately.
--            (Requires human triage; the audit reports likely-OK based on
--            structural signals but final call is per-table.)
--
-- ── SAFETY ─────────────────────────────────────────────────────────────
-- Read-only. Queries pg_catalog + information_schema. No data
-- modifications. Safe to run against any environment.
--
-- ── USAGE ──────────────────────────────────────────────────────────────
-- Run in Supabase SQL Editor OR psql. Save the output to
-- docs/audits/2026-07-22-public-grants-audit-RESULT.md as a table
-- for triage. Mateo triages the HIGH/MEDIUM rows.

WITH tables AS (
  SELECT c.oid,
         c.relname AS table_name,
         c.relrowsecurity AS rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'  -- ordinary tables only
     AND c.relname NOT LIKE 'pg_%'
),
policy_stats AS (
  SELECT p.polrelid,
         COUNT(*) FILTER (WHERE p.polcmd = 'r')                                       AS select_policy_count,
         COUNT(*) FILTER (WHERE p.polcmd = '*')                                       AS all_policy_count,
         COUNT(*) FILTER (WHERE p.polcmd IN ('a','w','d'))                            AS write_policy_count,
         -- Summary of SELECT policy quals: 'admin_only' if every SELECT
         -- policy references get_my_role() = 'admin'; 'broad' if any is
         -- literally TRUE; 'scoped' otherwise (get_my_company / company_id /
         -- email match / etc.); 'none' if no SELECT/ALL policies.
         CASE
           WHEN COUNT(*) FILTER (WHERE p.polcmd IN ('r','*')) = 0
             THEN 'none'
           WHEN bool_or(pg_get_expr(p.polqual, p.polrelid) ILIKE '%true%'
                        AND pg_get_expr(p.polqual, p.polrelid) NOT ILIKE '%get_my_role%'
                        AND pg_get_expr(p.polqual, p.polrelid) NOT ILIKE '%company%'
                        AND pg_get_expr(p.polqual, p.polrelid) NOT ILIKE '%auth.uid%')
             FILTER (WHERE p.polcmd IN ('r','*'))
             THEN 'broad'
           WHEN bool_and(pg_get_expr(p.polqual, p.polrelid) ILIKE '%get_my_role%admin%')
             FILTER (WHERE p.polcmd IN ('r','*'))
             THEN 'admin_only'
           ELSE 'scoped'
         END AS select_policy_summary
    FROM pg_policy p
   GROUP BY p.polrelid
)
SELECT
  t.table_name,
  t.rls_enabled,
  COALESCE(ps.select_policy_count, 0) AS select_policy_count,
  COALESCE(ps.all_policy_count, 0)    AS all_policy_count,
  COALESCE(ps.write_policy_count, 0)  AS write_policy_count,
  COALESCE(ps.select_policy_summary, 'none') AS select_policy_summary,

  -- Grants (has_table_privilege is the effective authority)
  has_table_privilege('anon',          format('public.%I', t.table_name), 'SELECT') AS anon_select,
  has_table_privilege('anon',          format('public.%I', t.table_name), 'INSERT') AS anon_insert,
  has_table_privilege('anon',          format('public.%I', t.table_name), 'UPDATE') AS anon_update,
  has_table_privilege('anon',          format('public.%I', t.table_name), 'DELETE') AS anon_delete,
  has_table_privilege('authenticated', format('public.%I', t.table_name), 'SELECT') AS auth_select,
  has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT') AS auth_insert,
  has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE') AS auth_update,
  has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE') AS auth_delete,

  -- Risk classification (see header block)
  CASE
    -- HIGH: RLS off + anon SELECT, or broad-SELECT policy + anon SELECT
    WHEN (t.rls_enabled = false OR COALESCE(ps.select_policy_summary,'none') = 'none' OR COALESCE(ps.select_policy_summary,'none') = 'broad')
         AND has_table_privilege('anon', format('public.%I', t.table_name), 'SELECT')
      THEN 'HIGH — anon read exposure'

    -- HIGH: RLS off entirely on a real table
    WHEN t.rls_enabled = false
      THEN 'HIGH — RLS disabled'

    -- MEDIUM: anon has ANY write grant (spoofed rows from anonymous)
    WHEN has_table_privilege('anon', format('public.%I', t.table_name), 'INSERT')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'UPDATE')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'DELETE')
      THEN 'MEDIUM — anon write exposure'

    -- MEDIUM: admin-SELECT table with authenticated write grants
    -- (same class as adfc6e1 provisioning_failures pre-hardening)
    WHEN COALESCE(ps.select_policy_summary,'none') = 'admin_only'
         AND (has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT')
              OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE')
              OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE'))
      THEN 'MEDIUM — auth write on admin-SELECT table'

    -- LOW: RLS + admin-only SELECT + no auth writes = tight
    WHEN COALESCE(ps.select_policy_summary,'none') = 'admin_only'
         AND NOT has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT')
         AND NOT has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE')
         AND NOT has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE')
      THEN 'LOW — tight admin-only'

    -- OK: scoped SELECT policies (tenancy-gated) with grants that could
    -- be intentional. Requires human triage.
    ELSE 'REVIEW — scoped policy, verify intent'
  END AS risk_class

FROM tables t
LEFT JOIN policy_stats ps ON ps.polrelid = t.oid
ORDER BY
  -- HIGH first, then MEDIUM, then rest
  CASE
    WHEN t.rls_enabled = false OR COALESCE(ps.select_policy_summary,'none') IN ('none','broad')
      THEN 1
    WHEN has_table_privilege('anon', format('public.%I', t.table_name), 'INSERT')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'UPDATE')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'DELETE')
      THEN 2
    ELSE 3
  END,
  t.table_name;
