-- ════════════════════════════════════════════════════════════════════
-- companies.billing_email — VERIFICATION
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
-- Run AFTER applying 20260630_companies_billing_email.sql.

-- §1 — column exists with TEXT type
SELECT
  '§1 — column shape'                                     AS check_name,
  column_name, data_type, is_nullable, column_default,
  CASE WHEN column_name = 'billing_email' AND data_type = 'text' AND is_nullable = 'YES'
       THEN 'PASS' ELSE 'FAIL' END                       AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'companies'
  AND column_name  = 'billing_email';

-- §2 — existing rows have NULL (no backfill in the migration)
SELECT
  '§2 — NULL on existing rows'                            AS check_name,
  count(*) FILTER (WHERE billing_email IS NULL)           AS null_count,
  count(*)                                                AS total_count,
  CASE WHEN count(*) = count(*) FILTER (WHERE billing_email IS NULL)
       THEN 'PASS — all NULL (expected; manual backfill)'
       ELSE 'INFO — ' || count(*) FILTER (WHERE billing_email IS NOT NULL)::text || ' already populated' END AS verdict
FROM public.companies;

-- §3 — behavioral UPDATE round-trip (uses test data; cleans up)
DO $b$
DECLARE
  v_test_company_id BIGINT;
  v_read_back TEXT;
BEGIN
  -- Find any existing company (read-only test target)
  SELECT id INTO v_test_company_id FROM public.companies LIMIT 1;
  IF v_test_company_id IS NULL THEN
    RAISE NOTICE 'INFO §3 — no companies in DB, behavioral test skipped';
    RETURN;
  END IF;

  -- Capture original
  DECLARE
    v_original TEXT;
  BEGIN
    SELECT billing_email INTO v_original FROM public.companies WHERE id = v_test_company_id;

    -- Write test value
    UPDATE public.companies SET billing_email = '__test_b228@example.com' WHERE id = v_test_company_id;
    SELECT billing_email INTO v_read_back FROM public.companies WHERE id = v_test_company_id;

    -- Restore original
    UPDATE public.companies SET billing_email = v_original WHERE id = v_test_company_id;

    IF v_read_back <> '__test_b228@example.com' THEN
      RAISE EXCEPTION 'FAIL §3 — write/read round-trip mismatch: % vs __test_b228@example.com', v_read_back;
    END IF;
    RAISE NOTICE 'PASS §3 — write/read round-trip works (id=%, original restored)', v_test_company_id;
  END;
END $b$;

-- §4 — audit row landed
SELECT
  '§4 — audit row'                                                   AS check_name,
  count(*)                                                           AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END                AS verdict
FROM public.audit_logs
WHERE action     = 'SCHEMA_B228_PREREQ'
  AND new_values->>'migration' = '20260630_companies_billing_email';
