-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 3 — VERIFICATION
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
-- Run AFTER applying 20260630_b228_phase3_deactivate_rpcs.sql.

-- §1 — both functions exist, DEFINER, search_path pinned, count=1 each
SELECT
  '§1 — function shape'                                AS check_name,
  proname,
  prosecdef                                            AS definer,
  proconfig::TEXT LIKE '%search_path=public, pg_temp%' AS search_path_pinned,
  CASE WHEN prosecdef = TRUE
        AND proconfig::TEXT LIKE '%search_path=public, pg_temp%'
       THEN 'PASS' ELSE 'FAIL' END                    AS verdict
FROM pg_proc
WHERE proname IN (
  'super_admin_deactivate_company',
  'super_admin_reactivate_company'
)
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- §1b — no overload trap (each exactly one)
SELECT
  '§1b — pg_proc count'                                AS check_name,
  proname,
  COUNT(*)                                             AS count,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL — overload' END AS verdict
FROM pg_proc
WHERE proname IN (
  'super_admin_deactivate_company',
  'super_admin_reactivate_company'
)
  AND pronamespace = 'public'::regnamespace
GROUP BY proname
ORDER BY proname;

-- §2 — grants (authenticated=X only on each)
SELECT
  '§2 — proacl'                                        AS check_name,
  proname,
  pg_catalog.array_to_string(proacl, ',')              AS proacl,
  CASE
    WHEN pg_catalog.array_to_string(proacl, ',') LIKE '%authenticated=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%anon=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%service_role=X%'
    THEN 'PASS'
    ELSE 'FAIL'
  END                                                  AS verdict
FROM pg_proc
WHERE proname IN (
  'super_admin_deactivate_company',
  'super_admin_reactivate_company'
)
  AND pronamespace = 'public'::regnamespace
ORDER BY proname;

-- §3 — audit row landed
SELECT
  '§3 — migration audit row'                           AS check_name,
  count(*)                                             AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END  AS verdict
FROM public.audit_logs
WHERE action     = 'SCHEMA_B228_PHASE3'
  AND new_values->>'migration' = '20260630_b228_phase3_deactivate_rpcs';

-- §4 — APP-LEVEL smoke prompts (run after deploy):
--   §4a — Open /admin_console → pick a TEST subscriber (Demo Towing or
--         similar; NOT a real customer) → Deactivate → type-to-confirm
--         the company name → submit. Returns ok:true + users_affected.
--   §4b — That subscriber's users (managers/drivers/etc.) try to load
--         their portal → blocked. B211 idle-watcher on an already-open
--         session boots them on next focus.
--   §4c — In the SQL editor, verify the cascade landed but account_state
--         is UNCHANGED:
--           SELECT id, name, is_active, account_state FROM companies
--            WHERE id = <test_id>;
--         Expect: is_active=false, account_state UNCHANGED from before.
--         If account_state moved, the RPC is wrong — flag immediately.
--   §4d — Reactivate the test subscriber → mirror flip. is_active=true
--         everywhere. account_state STILL UNCHANGED throughout.
--   §4e — Role-bypass (the security boundary test): as a non-admin user
--         in DevTools:
--           await supabase.rpc('super_admin_deactivate_company',
--             { p_company_id: 1, p_reason: 'attack' })
--           await supabase.rpc('super_admin_reactivate_company',
--             { p_company_id: 1 })
--         Expect on each: error code '42501', message
--         'forbidden_not_admin'. THAT failure is the pass.
--   §4f — Type-to-confirm UX: opening the deactivate dialog with the
--         wrong company name typed leaves the Confirm button disabled.
--         Pasting/typing the exact match enables it.
