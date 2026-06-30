-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 1 — get_console_aggregates() VERIFICATION
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════

-- §1 — function exists, single overload, DEFINER, search_path pinned
SELECT
  '§1 — function shape'                                AS check_name,
  proname,
  provolatile,
  prosecdef,
  proconfig,
  CASE WHEN prosecdef = TRUE
        AND proconfig::TEXT LIKE '%search_path=public, pg_temp%'
       THEN 'PASS — DEFINER + search_path pinned'
       ELSE 'FAIL — check security/search_path' END AS verdict
FROM pg_proc
WHERE proname = 'get_console_aggregates'
  AND pronamespace = 'public'::regnamespace;

-- §1b — no overload trap
SELECT
  '§1b — pg_proc count'                                AS check_name,
  COUNT(*)                                             AS count,
  CASE WHEN COUNT(*) = 1 THEN 'PASS'
       ELSE 'FAIL — overload trap; expected 1' END    AS verdict
FROM pg_proc
WHERE proname = 'get_console_aggregates'
  AND pronamespace = 'public'::regnamespace;

-- §2 — grants (authenticated only; PUBLIC + anon REVOKED)
SELECT
  '§2 — proacl'                                        AS check_name,
  proname,
  pg_catalog.array_to_string(proacl, ',')              AS proacl,
  CASE WHEN pg_catalog.array_to_string(proacl, ',') LIKE '%authenticated=X%'
        AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%anon=X%'
        AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%=X/postgres,%' -- no PUBLIC=X
       THEN 'PASS'
       ELSE 'FAIL — expected authenticated=X only' END AS verdict
FROM pg_proc
WHERE proname = 'get_console_aggregates'
  AND pronamespace = 'public'::regnamespace;

-- §3 — body returns rows when called by admin (smoke; not exhaustive)
-- This is RUN IN APP, not here — the role-gate requires auth.jwt() which
-- is null in raw SQL. Instead we sanity-check the join shape:
SELECT
  '§3 — pre-call sanity (DB has companies)'           AS check_name,
  COUNT(*)                                            AS companies_count,
  CASE WHEN COUNT(*) > 0
       THEN 'PASS — function will return at least one row when called from app'
       ELSE 'INFO — empty companies table; function returns empty' END AS verdict
FROM public.companies;

-- §4 — audit row landed
SELECT
  '§4 — audit row'                                    AS check_name,
  count(*)                                            AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END  AS verdict
FROM public.audit_logs
WHERE action     = 'SCHEMA_B228_PHASE1'
  AND new_values->>'migration' = '20260630_b228_console_aggregates';

-- §5 — APP-LEVEL behavioral smoke (do these in console after deploy):
--   §5a — admin login → /admin_console → CRM loads with one row per company
--   §5b — non-admin user tries the RPC directly (curl/SQL editor) →
--         expect 42501 / forbidden_not_admin
--   §5c — counts match an eyeballed spot-check: pick one company, manually
--         SELECT COUNT(*) FROM properties WHERE company ~~* '...' AND
--         verify the console reports the same number.
