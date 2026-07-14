-- ════════════════════════════════════════════════════════════════════
-- VERIFY — 20260713_tos_acceptances_company_id_backfill.sql
-- Paste in Supabase SQL Editor AFTER the backfill migration applies.
-- Every 'ok' column must be TRUE.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — Row counts moved as expected ─────────────────────────
-- Pre-baseline (Jose 2026-07-13): 32 total / 28 NULL / 4 linked.
-- Post-backfill target: 32 total / 0 NULL / 32 linked (residual
-- NULLs only for legitimate self-serve pre-checkout, and none exist
-- in prod today).
SELECT COUNT(*)                                       AS total_rows,
       COUNT(*) FILTER (WHERE company_id IS NULL)     AS null_rows,
       COUNT(*) FILTER (WHERE company_id IS NOT NULL) AS linked_rows,
       (COUNT(*) FILTER (WHERE company_id IS NULL) = 0) AS ok
  FROM public.tos_acceptances;
-- Expected: total_rows=32 (unchanged), null_rows=0, linked_rows=32.

-- ── VQ.B — A1's 6 driver rows flipped to company_id = 91 ─────────
-- 🔴 Load-bearing check. If A1 has 6 driver tos_acceptances rows and
-- any are still NULL after backfill, the join predicate missed for
-- that specific driver — investigate (whitespace, case, trailing
-- whitespace variant on user_roles.company vs companies.name).
--
-- Substitute A1's actual companies.id if it isn't 91 in prod.
SELECT ur.email,
       ur.role,
       ta.document_type,
       ta.company_id,
       ta.tos_version,
       ta.privacy_version,
       (ta.company_id = 91) AS ok  -- ← A1's id
  FROM public.tos_acceptances ta
  JOIN auth.users u        ON u.id = ta.user_id
  JOIN public.user_roles ur ON lower(ur.email) = lower(u.email)
 WHERE ur.role = 'driver'
   AND lower(trim(ur.company)) = lower(trim('A1 Wrecker LLC'))
 ORDER BY ur.email, ta.document_type;
-- Expected: every row shows company_id = 91, ok=true.
-- If any ok=false, stop and report.

-- ── VQ.C — Every linked row's company_id points at a real row ─────
-- Belt-and-suspenders — no dangling company_id foreign values.
-- (There's no FK on tos_acceptances.company_id → companies.id today;
-- this VQ catches any manual/legacy write that would trip once the FK
-- migration lands.)
SELECT ta.id,
       ta.company_id,
       ta.document_type,
       ta.accepted_at
  FROM public.tos_acceptances ta
 WHERE ta.company_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.companies c WHERE c.id = ta.company_id
   )
 LIMIT 20;
-- Expected: 0 rows. If non-zero, the backfill wrote a stale company_id
-- (should never happen — join is against public.companies).

-- ── VQ.D — Per-role attributability confirmed ────────────────────
-- Groups by role → linked vs null. Post-backfill every non-admin role
-- should be 100% linked. admin is exempt (super-admin has company=NULL
-- by design; their rows will stay NULL).
SELECT ur.role,
       COUNT(*)                                       AS row_count,
       COUNT(*) FILTER (WHERE ta.company_id IS NOT NULL) AS linked,
       COUNT(*) FILTER (WHERE ta.company_id IS NULL)     AS null_rows,
       (
         -- admin can have NULLs (correct); everyone else can't.
         CASE WHEN ur.role = 'admin' THEN TRUE
              ELSE COUNT(*) FILTER (WHERE ta.company_id IS NULL) = 0
         END
       )                                              AS ok
  FROM public.tos_acceptances ta
  JOIN auth.users u        ON u.id = ta.user_id
  JOIN public.user_roles ur ON lower(ur.email) = lower(u.email)
 GROUP BY ur.role
 ORDER BY ur.role;
-- Expected: 6-ish rows (admin, company_admin, manager, leasing_agent,
-- driver, resident). admin may show null_rows > 0 (fine, ok=true).
-- Every other role should show null_rows=0, ok=true.

-- ── VQ.E — SCHEMA_ audit ledger row landed ────────────────────────
SELECT action,
       new_values ->> 'migration'            AS migration,
       (new_values -> 'rows_updated')::TEXT   AS rows_updated,
       (new_values -> 'residual_null_rows')::TEXT AS residual_null_rows,
       created_at,
       (action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL')      AS ok
  FROM public.audit_logs
 WHERE action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row. rows_updated should be 28 (matches Jose's baseline).
-- residual_null_rows should be 0 (or the super-admin count if any).
