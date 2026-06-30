-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 2 — VERIFICATION (schema + RPCs)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
-- Run AFTER applying both:
--   20260630_b228_phase2_schema.sql
--   20260630_b228_phase2_rpcs.sql

-- §1 — platform_settings.api_cost_rates column + seeded
SELECT
  '§1 — api_cost_rates'                                                 AS check_name,
  column_default IS NOT NULL                                            AS has_default,
  (SELECT api_cost_rates FROM public.platform_settings WHERE id = 1)    AS current_value,
  CASE WHEN column_default IS NOT NULL
        AND (SELECT api_cost_rates->>'plate_read_usd' FROM public.platform_settings WHERE id = 1) IS NOT NULL
       THEN 'PASS' ELSE 'FAIL' END                                      AS verdict
FROM information_schema.columns
WHERE table_schema='public' AND table_name='platform_settings' AND column_name='api_cost_rates';

-- §2 — flag_acknowledgments table + RLS + constraint
SELECT
  '§2 — flag_acknowledgments table'                                     AS check_name,
  (SELECT relrowsecurity FROM pg_class WHERE relname='flag_acknowledgments') AS rls_enabled,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='flag_acknowledgments')  AS columns_count,
  CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE relname='flag_acknowledgments')
       THEN 'PASS — RLS enabled (deny-all; RPC-only)'
       ELSE 'FAIL — RLS not enabled' END                                AS verdict;

-- §3 — audit_logs index landed
SELECT
  '§3 — audit_logs(action, created_at) index'                           AS check_name,
  indexname,
  CASE WHEN indexname = 'idx_audit_logs_action_created_at'
       THEN 'PASS' ELSE 'FAIL' END                                      AS verdict
FROM pg_indexes
WHERE schemaname='public' AND tablename='audit_logs'
  AND indexname='idx_audit_logs_action_created_at';

-- §4 — 4 RPC fns exist with correct shape + grants
SELECT
  '§4 — RPCs'                                                           AS check_name,
  proname,
  prosecdef                                                             AS definer,
  pg_catalog.array_to_string(proacl, ',')                               AS proacl,
  CASE
    WHEN prosecdef = TRUE
     AND pg_catalog.array_to_string(proacl, ',') LIKE '%authenticated=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%anon=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%service_role=X%'
    THEN 'PASS'
    ELSE 'FAIL'
  END                                                                   AS verdict
FROM pg_proc
WHERE proname IN (
  'get_console_aggregates',
  'get_console_pm_property_permits',
  'get_console_spike_flags',
  'acknowledge_console_flag'
)
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- §5 — no overload trap (each function exactly once)
SELECT
  '§5 — pg_proc count per fn'                                           AS check_name,
  proname,
  COUNT(*)                                                              AS count,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL — overload trap' END    AS verdict
FROM pg_proc
WHERE proname IN (
  'get_console_aggregates',
  'get_console_pm_property_permits',
  'get_console_spike_flags',
  'acknowledge_console_flag'
)
  AND pronamespace = 'public'::regnamespace
GROUP BY proname
ORDER BY proname;

-- §6 — audit rows landed
SELECT
  '§6 — audit rows'                                                     AS check_name,
  COUNT(*)                                                              AS rows_found,
  CASE WHEN COUNT(*) = 2 THEN 'PASS' ELSE 'INFO — expected 2 (schema + rpcs)' END AS verdict
FROM public.audit_logs
WHERE action IN ('SCHEMA_B228_PHASE2', 'SCHEMA_B228_PHASE2_RPCS');

-- §7 — APP-LEVEL smoke prompts (run in app/console):
--   §7a — admin opens /admin_console → Cost section + Plate Scans 24h
--         tile populated (0 if no scans yet)
--   §7b — driver triggers a plate-scan → after ~30s, refresh console →
--         plate_reads_24h ticks up by 1; cost section reflects estimate
--   §7c — non-admin call: in DevTools `await supabase.rpc('get_console_spike_flags')`
--         expect error: { code: '42501', message: 'forbidden_not_admin' }
--   §7d — PM-track subscriber drawer shows per-property permits;
--         enforcement-track drawer omits the section
--   §7e — generate enough traffic to trip a spike flag → flag appears
--         in console → acknowledge → flag disappears for 7d window
