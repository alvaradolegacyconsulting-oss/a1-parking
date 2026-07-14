-- ════════════════════════════════════════════════════════════════════
-- tos_acceptances.company_id — backfill of 28 orphaned rows
-- 2026-07-13
--
-- ORIGIN
--   Companion to 20260713_tos_acceptances_company_id_derivation.sql
--   (Commit A). Commit A closes the leak going forward; this
--   migration back-attributes every existing orphan row that has a
--   resolvable owner.
--
-- SCOPE
--   • Every tos_acceptances row with company_id IS NULL.
--   • Resolve via lower(trim(user_roles.company)) → lower(trim(
--     companies.name)) — the SAME normalization used by Commit A's
--     derivation join AND the 2026-07-13 companies_name_lower_unique
--     index. One normalization rule across the whole schema.
--
-- SHAPE
--   auth.users.id ─ ta.user_id (existing key on tos_acceptances)
--                     └─ user_roles.email = auth.users.email (case-ins)
--                          └─ user_roles.company = companies.name (case-ins + trim)
--
-- PRE-APPLY BASELINE (Jose paste before running)
--   SELECT COUNT(*)                                        AS total_rows,
--          COUNT(*) FILTER (WHERE company_id IS NULL)      AS null_rows,
--          COUNT(*) FILTER (WHERE company_id IS NOT NULL)  AS linked_rows
--     FROM public.tos_acceptances;
--   -- Expected: 32 / 28 / 4 (per Jose 2026-07-13). If numbers have
--   -- shifted, note the delta but proceed — the migration is idempotent
--   -- by construction (WHERE company_id IS NULL).
--
-- POST-APPLY POSTURE
--   Residual NULLs are permitted ONLY in one shape:
--     • accept_signup_consents at self-serve pre-checkout (user_roles
--       doesn't exist yet → derivation genuinely can't resolve).
--   No such rows exist in prod today (no self-serve signup has ever
--   completed pre-A1). Post-migration null_rows should be ZERO.
--   Non-zero residuals must be triaged case-by-case — do not rationalize.
--
-- IDEMPOTENCY
--   WHERE company_id IS NULL means a re-run finds fewer candidates
--   after the first success. Safe to re-run.
--
-- RLS
--   tos_acceptances RLS: admin_all_tos_acceptances (admin role) +
--   tos_acceptances_self_select (user_id = auth.uid()). Migrations run
--   as the migration user (postgres/service_role) which bypasses RLS.
--
-- AUDIT
--   SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL row lands after the
--   UPDATE, carrying `rows_updated` and `residual_null_rows` counts in
--   its new_values payload.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── The backfill ─────────────────────────────────────────────────
WITH updated AS (
  UPDATE public.tos_acceptances ta
     SET company_id = c.id
    FROM auth.users u
    JOIN public.user_roles ur
      ON lower(ur.email) = lower(u.email)
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ta.user_id = u.id
     AND ta.company_id IS NULL
  RETURNING ta.id
)
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL',
  'tos_acceptances',
  NULL,
  jsonb_build_object(
    'migration',            '20260713_tos_acceptances_company_id_backfill',
    'change',               'Backfill company_id on all resolvable tos_acceptances rows via lower(trim(user_roles.company)) → lower(trim(companies.name)). Same normalization as Commit A derivation + companies_name_lower_unique. Idempotent (WHERE company_id IS NULL). Companion to 20260713_tos_acceptances_company_id_derivation.',
    'rationale',            'Jose 2026-07-13 audit found 88% orphan rate (28/32 rows NULL). Commit A closes the leak going forward; this migration back-attributes existing orphans. Residual NULLs permitted only on the self-serve pre-checkout shape (accept_signup_consents before user_roles exists); zero such rows exist in prod today.',
    'rows_updated',         (SELECT COUNT(*) FROM updated),
    'residual_null_rows',   (SELECT COUNT(*) FROM public.tos_acceptances WHERE company_id IS NULL)
  ),
  now();

COMMIT;
