-- A2 PRE-LAUNCH SECURITY AUDIT — ENUMERATION QUERIES
--
-- Run-once read-only SQL block. NO DDL, NO writes. Safe to run in SQL Editor
-- as a single paste against production (or against any environment under
-- audit). Output drives the four-list deliverable Jose triages as
-- block-A1 / pre-flip / post-launch.
--
-- USAGE
--   Single-paste into Supabase SQL Editor → Run → copy/paste each block's
--   output back to Mateo for synthesis. Six query blocks; each block emits
--   its own result set. Markers between blocks aid visual separation.
--
-- DESIGN
--   Each block prefixed with a SELECT '─────── BLOCK N: title ───────' AS marker
--   row so the Editor's "Result" output between blocks is visually demarcated.
--   Production-readiness query: all six blocks are pg_catalog / information_schema
--   reads; no temporary tables, no functions invoked, no SET commands.
--
-- COVERS
--   List 1 (DEFINER inventory)     → Blocks 1 + 2
--   List 2 (write-path matrix)     → Blocks 3 + 4
--   List 3 (B68 capture close-out) → Block 1 + Block 4 (compared off-line vs repo)
--   List 4 (grant hygiene)         → Blocks 2 + 5 + 6

--------------------------------------------------------------------------------
-- BLOCK 1 — SECURITY DEFINER inventory
--   Every DEFINER function in public schema with its language, args,
--   search_path config, and raw ACL. Empty proacl = PUBLIC default.
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 1: SECURITY DEFINER inventory ───────' AS marker;

SELECT
  p.proname                                    AS fn,
  pg_get_function_identity_arguments(p.oid)    AS args,
  l.lanname                                    AS lang,
  p.prosecdef                                  AS is_definer,
  -- proconfig holds GUCs like search_path; NULL = none pinned.
  p.proconfig                                  AS config,
  -- ACL representation. NULL = PUBLIC default (everyone can EXECUTE).
  CASE WHEN p.proacl IS NULL THEN 'NULL (DEFAULT — PUBLIC has EXECUTE)'
       ELSE p.proacl::TEXT END                 AS proacl,
  -- Convenience flag: does the proacl text contain a PUBLIC or anon grant?
  CASE WHEN p.proacl IS NULL THEN 'YES (default)'
       WHEN p.proacl::TEXT LIKE '%=X/%' AND p.proacl::TEXT NOT LIKE '%anon=%'
            AND p.proacl::TEXT NOT LIKE '%authenticated=%'
            THEN 'check raw' ELSE 'NO' END     AS public_exec_default,
  CASE WHEN p.proacl::TEXT LIKE '%anon=X%' THEN 'YES'
       ELSE 'NO' END                           AS anon_exec_explicit,
  CASE WHEN p.proacl::TEXT LIKE '%authenticated=X%' THEN 'YES'
       ELSE 'NO' END                           AS authenticated_exec_explicit
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef = TRUE
ORDER BY p.proname;

--------------------------------------------------------------------------------
-- BLOCK 2 — ALL public-schema function grants (DEFINER + INVOKER combined)
--   Catches non-DEFINER fns that nonetheless have anon/PUBLIC EXECUTE
--   (legitimate for landing/visitor flow; finding for everything else).
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 2: All public-schema function grants ───────' AS marker;

SELECT
  p.proname                                    AS fn,
  pg_get_function_identity_arguments(p.oid)    AS args,
  p.prosecdef                                  AS is_definer,
  CASE WHEN p.proacl IS NULL THEN 'NULL (DEFAULT — PUBLIC)'
       ELSE p.proacl::TEXT END                 AS proacl
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prokind = 'f'  -- functions only (skip aggregates/procs)
ORDER BY p.prosecdef DESC, p.proname;

--------------------------------------------------------------------------------
-- BLOCK 3 — RLS policies on sensitive + write-prone tables
--   Sensitive set (per Jose): user_roles, companies, violations,
--   proposal_codes, platform_settings, billing-column-bearing tables.
--   Extended set: tables that handle PII (drivers, vehicles, residents,
--   visitor_passes, violation_photos/videos, audit_logs, dispute_requests,
--   tos_acceptances).
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 3: RLS policies on sensitive tables ───────' AS marker;

SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual           AS using_expr,
  with_check     AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'user_roles', 'companies', 'violations', 'proposal_codes',
    'platform_settings', 'stripe_events', 'stripe_prices',
    'violation_photos', 'violation_videos', 'vehicles',
    'visitor_passes', 'drivers', 'dispute_requests',
    'tos_acceptances', 'audit_logs', 'storage_facilities',
    'consent_versions'
  )
ORDER BY tablename, cmd, policyname;

--------------------------------------------------------------------------------
-- BLOCK 4 — Triggers on public-schema tables (write-time logic)
--   Reveals trigger fns that may run privileged work outside RLS view.
--   Cross-check trigger fn prosecdef against BLOCK 1 inventory.
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 4: Triggers on public-schema tables ───────' AS marker;

SELECT
  c.relname              AS table,
  t.tgname               AS trigger,
  p.proname              AS fn_called,
  p.prosecdef            AS fn_is_definer,
  CASE
    WHEN t.tgenabled = 'O' THEN 'ENABLED'
    WHEN t.tgenabled = 'D' THEN 'DISABLED'
    WHEN t.tgenabled = 'R' THEN 'REPLICA_ONLY'
    WHEN t.tgenabled = 'A' THEN 'ALWAYS'
    ELSE t.tgenabled::TEXT
  END                    AS state,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc  p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND c.relnamespace = 'public'::regnamespace
ORDER BY c.relname, t.tgname;

--------------------------------------------------------------------------------
-- BLOCK 5 — Table-level anon/PUBLIC privileges
--   Surfaces any public-schema table with explicit anon or PUBLIC grants.
--   Standing rule (per [[feedback-revoke-anon-default-on-new-tables]]):
--   new tables get REVOKE'd; allowlist exceptions documented inline.
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 5: Table-level anon/PUBLIC privileges ───────' AS marker;

SELECT
  grantee,
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges,
  bool_or(is_grantable = 'YES')                            AS any_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;

--------------------------------------------------------------------------------
-- BLOCK 6 — RLS-enabled state per public-schema table
--   Defense-in-depth check. Any public-schema table with rls_enabled=FALSE
--   is a finding unless explicitly catalog (e.g., consent_versions read-all).
--------------------------------------------------------------------------------

SELECT '─────── BLOCK 6: RLS state per public-schema table ───────' AS marker;

SELECT
  c.relname              AS table,
  c.relrowsecurity       AS rls_enabled,
  c.relforcerowsecurity  AS rls_forced,
  (SELECT count(*) FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind = 'r'  -- ordinary tables only
ORDER BY c.relrowsecurity ASC NULLS FIRST, c.relname;

-- ════════════════════════════════════════════════════════════════════════════
-- END OF ENUMERATION BLOCK
-- Six result sets above. Copy each block (or the full output) and paste back.
-- Synthesis report follows.
-- ════════════════════════════════════════════════════════════════════════════
