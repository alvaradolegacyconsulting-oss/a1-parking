-- ════════════════════════════════════════════════════════════════════
-- VERIFY — 20260713_companies_name_lower_unique.sql
-- Paste in Supabase SQL Editor AFTER the migration applies.
-- Every 'ok' column must be TRUE.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — Index exists with correct expression ──────────────────
SELECT indexname,
       indexdef,
       (indexname = 'companies_name_lower_unique'
        AND indexdef ILIKE '%UNIQUE INDEX%'
        AND indexdef ILIKE '%lower(%'
        AND indexdef ILIKE '%trim(%')                             AS ok
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename  = 'companies'
   AND indexname  = 'companies_name_lower_unique';
-- Expected: 1 row, ok=true. indexdef ~ "CREATE UNIQUE INDEX
-- companies_name_lower_unique ON public.companies USING btree
-- (lower(TRIM(BOTH FROM name)))".

-- ── VQ.B — Row count matches distinct-lowered-trimmed-name count ─
-- If the index built, these must be equal; belt-and-suspenders confirmation.
SELECT COUNT(*)                                            AS total_rows,
       COUNT(DISTINCT lower(trim(name)))                   AS distinct_lowered_trimmed,
       COUNT(*) = COUNT(DISTINCT lower(trim(name)))        AS ok
  FROM public.companies;
-- Expected: total_rows = distinct_lowered_trimmed = 5 (per Jose 2026-07-13),
-- ok=true.

-- ── VQ.C — Enforcement smoke: case-differing duplicate INSERT is rejected
-- Run manually. Expect 23505 unique_violation on the second INSERT.
-- Rollback the transaction after confirming.
--
--   BEGIN;
--     INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
--     VALUES ('__vq_c_probe__', 'legacy', 'enforcement', 'active', true);
--
--     INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
--     VALUES ('__VQ_C_Probe__', 'legacy', 'enforcement', 'active', true);
--     -- ↑ Expected: ERROR: duplicate key value violates unique constraint
--     --            "companies_name_lower_unique"
--   ROLLBACK;

-- ── VQ.D — Enforcement smoke: whitespace-differing duplicate INSERT is rejected
-- Run manually. Expect 23505 unique_violation on the second INSERT.
--
--   BEGIN;
--     INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
--     VALUES ('__vq_d_probe__', 'legacy', 'enforcement', 'active', true);
--
--     INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
--     VALUES ('  __vq_d_probe__  ', 'legacy', 'enforcement', 'active', true);
--     -- ↑ Expected: ERROR: duplicate key value violates unique constraint
--     --            "companies_name_lower_unique"
--   ROLLBACK;

-- ── VQ.E — SCHEMA_ audit ledger row landed ────────────────────────
SELECT action,
       new_values ->> 'migration' AS migration,
       created_at,
       (action = 'SCHEMA_COMPANIES_NAME_LOWER_UNIQUE')            AS ok
  FROM public.audit_logs
 WHERE action = 'SCHEMA_COMPANIES_NAME_LOWER_UNIQUE'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row, migration='20260713_companies_name_lower_unique', ok=true.
