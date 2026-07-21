-- ═══════════════════════════════════════════════════════════════════════
-- 20260721_company_name_available_rpc_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260721_company_name_available_rpc.sql.
-- Run AFTER the migration lands. Every VQ below must return the
-- expected result — mismatched output means the migration did not apply
-- as intended and the change MUST NOT be pushed to a downstream env.
--
-- Read-only queries only. No mutations. Safe to run repeatedly.

-- ── VQ.A — Overload shape ──────────────────────────────────────────────
-- Expect exactly ONE row: (proname='company_name_available',
-- proargtypes containing 'text', prorettype='boolean', prosecdef=true).
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_function_result(p.oid)             AS returns,
  p.prosecdef                               AS security_definer,
  p.provolatile                             AS volatility  -- 's' = STABLE
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'company_name_available';

-- ── VQ.B — ACL / grants ────────────────────────────────────────────────
-- Expect: authenticated=X (EXECUTE); PUBLIC + anon should NOT appear.
SELECT has_function_privilege('anon',          'public.company_name_available(text)', 'EXECUTE') AS anon_can_execute_should_be_false,
       has_function_privilege('authenticated', 'public.company_name_available(text)', 'EXECUTE') AS authenticated_can_execute_should_be_true,
       has_function_privilege('service_role',  'public.company_name_available(text)', 'EXECUTE') AS service_role_can_execute;

-- ── VQ.C — SCHEMA_ audit row present ───────────────────────────────────
-- Expect exactly ONE row from today's migration apply.
SELECT id, user_email, action, created_at
FROM public.audit_logs
WHERE action = 'SCHEMA_COMPANY_NAME_AVAILABLE_RPC'
ORDER BY created_at DESC
LIMIT 1;

-- ── VQ.D — Behavioral smoke ────────────────────────────────────────────
-- Deterministic checks against known state. company_name_available should:
--   1. Return FALSE for NULL input.
--   2. Return FALSE for empty/whitespace-only input.
--   3. Return TRUE  for a UUID-random name that cannot possibly exist.
--   4. Return FALSE for a name that DOES exist in companies.name, exact.
--   5. Return FALSE for a case-different variant of an existing name.
--   6. Return FALSE for a whitespace-different variant of an existing name.
--
-- The last three depend on there being at least one row in companies.
-- We pick an existing row via LIMIT 1 to make the smoke portable across
-- environments (dev/test may have different names).

WITH picked AS (
  SELECT name AS existing_name FROM public.companies LIMIT 1
)
SELECT
  public.company_name_available(NULL)                                                                                    AS test_1_null_should_be_false,
  public.company_name_available('')                                                                                      AS test_2a_empty_should_be_false,
  public.company_name_available('   ')                                                                                   AS test_2b_whitespace_should_be_false,
  public.company_name_available('__probe_' || substr(md5(random()::text), 1, 20) || '_' || substr(md5(random()::text), 1, 20)) AS test_3_random_should_be_true,
  public.company_name_available((SELECT existing_name FROM picked))                                                      AS test_4_exact_should_be_false,
  public.company_name_available(upper((SELECT existing_name FROM picked)))                                               AS test_5_uppercase_should_be_false,
  public.company_name_available('  ' || (SELECT existing_name FROM picked) || '  ')                                      AS test_6_padded_should_be_false;

-- ── VQ.E — Index still matches RPC normalization ───────────────────────
-- Prove RPC and index normalize identically. The index definition
-- MUST include lower(trim(name)) — anything else would drift.
SELECT indexdef
FROM pg_indexes
WHERE tablename = 'companies'
  AND indexname LIKE '%name%';
-- Expect a row containing: USING btree (lower(TRIM(BOTH FROM name)))
-- Jose confirmed 2026-07-21: companies_name_lower_unique matches.
