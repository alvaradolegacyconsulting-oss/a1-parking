-- ════════════════════════════════════════════════════════════════════
-- Seed/Wipe Layer 1 — company_env foundation
-- 2026-07-08
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Adds a `company_env` enum column to `companies` (default 'production',
--   NOT NULL), backing three post-launch capabilities:
--     1. Structural refuse-if-live guard for the pre-launch wipe (the
--        FIRST such guard — grep across scripts/migrations/docs found
--        no prior code-side implementation; the June 19 wipe runbook
--        lives in Jose's planning workspace).
--     2. Include-list scoping for the (post-A1) weekly test-tenant
--        reset — `WHERE company_env = 'test'`.
--     3. Deny-write for the (post-A1) demo tenant via RLS keyed to
--        company_env = 'demo'.
--
-- WHY DEFAULT 'production'
--   Every existing row + every real signup/redeem (incl. A1) lands as
--   'production' automatically → structurally exempt from test wipes,
--   included in refuse-if-live counts. Test/demo rows require an
--   explicit override (backend seed script only, Layer 2 scope).
--
-- BILLING/DUNNING/QUANTITY-SYNC EXEMPTIONS (companion code changes)
--   Most billing paths are already `stripe_subscription_id IS NULL`-
--   safe (test/demo companies have NULL Stripe IDs, so they're
--   structurally skipped by webhook handlers matching on
--   stripe_customer_id / stripe_subscription_id, and by
--   loadCompanyForSync returning NULL). Belt-and-suspenders `company_env
--   = 'production'` filters land in the same code commit as this
--   migration (dunning cron SELECT — load-bearing; webhook handler
--   SELECTs — defensive). See:
--     • app/api/cron/dunning/route.ts:375
--     • app/lib/stripe-event-handlers/customer-updated.ts:28
--     • app/lib/stripe-event-handlers/subscription-deleted.ts:30
--     • app/lib/stripe-event-handlers/subscription-updated.ts:40
--     • app/lib/stripe-event-handlers/invoice-payment-succeeded.ts:47
--     • app/lib/stripe-event-handlers/invoice-payment-failed.ts:42
--     • app/lib/stripe-event-handlers/invoice-payment-action-required.ts:38
--
-- REFUSE-IF-LIVE HELPER
--   `production_company_count()` — SECURITY DEFINER, returns bigint,
--   granted service_role ONLY (not authenticated). Wipe runbook scripts
--   call it as an assertion; if it returns > 0, they refuse to
--   proceed. Grep confirms no pre-existing code-side guard depends on
--   any other mechanism — Layer 1 is the first structural check.
--
-- ROLLBACK
--   ALTER TABLE companies DROP COLUMN company_env; DROP TYPE company_env_enum;
--   DROP FUNCTION production_company_count(). Additive migration; safe
--   rollback modulo the code-side .eq('company_env', 'production')
--   filters — those become no-ops if the column is dropped (SELECTs
--   error `column does not exist`), so rollback the code change too.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Enum type ────────────────────────────────────────────
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_env_enum') THEN
    CREATE TYPE company_env_enum AS ENUM ('production', 'test', 'demo');
  END IF;
END
$body$;

-- ── PART 2 — Column on companies ──────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_env company_env_enum NOT NULL DEFAULT 'production';

-- ── PART 3 — Index for the dunning cron + refuse-if-live predicate
CREATE INDEX IF NOT EXISTS companies_company_env_idx ON companies (company_env);

-- ── PART 4 — Refuse-if-live helper RPC ────────────────────────────
CREATE OR REPLACE FUNCTION public.production_company_count()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $func$
  SELECT count(*)::bigint FROM companies WHERE company_env = 'production'
$func$;

REVOKE ALL ON FUNCTION public.production_company_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.production_company_count() FROM anon;
REVOKE ALL ON FUNCTION public.production_company_count() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.production_company_count() TO service_role;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_SEED_WIPE_LAYER1_COMPANY_ENV',
  'companies',
  NULL,
  jsonb_build_object(
    'migration', '20260708_seed_wipe_layer1_company_env',
    'change',    'ADD COLUMN companies.company_env company_env_enum NOT NULL DEFAULT ''production''; ADD helper production_company_count() SD service_role-only; index on company_env',
    'rationale', 'Seed/Wipe Layer 1 — structural foundation for post-A1 seed/reset arc + FIRST structural refuse-if-live guard for the pre-launch wipe (no prior code-side guard existed per grep). Default production so A1 and real customers are protected on-write.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION (paste into SQL Editor after apply)
--
-- VQ.A — column present with correct default + NOT NULL
--   SELECT column_name, udt_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='companies' AND column_name='company_env';
--   -- Expected: udt_name='company_env_enum'; is_nullable='NO';
--   --           column_default LIKE 'production%'
--
-- VQ.B — helper RPC + grants clean
--   SELECT p.proname, p.prosecdef AS is_security_definer,
--          array(SELECT grantee || '=' || privilege_type
--                FROM information_schema.routine_privileges
--                WHERE routine_name = 'production_company_count'
--                  AND routine_schema = 'public'
--                ORDER BY grantee) AS grants
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'production_company_count';
--   -- Expected: is_security_definer=true; grants =
--   -- { 'postgres=EXECUTE', 'service_role=EXECUTE' }
--   -- (anon, authenticated, PUBLIC all absent — wipe-runbook-only)
--
-- VQ.C — all existing rows defaulted to production
--   SELECT company_env, count(*) FROM companies GROUP BY company_env
--   ORDER BY company_env;
--   -- Expected: production=<all rows>; no other rows (test=0, demo=0).
--
-- VQ.D — helper returns the same count
--   SELECT public.production_company_count();
--   -- Expected: same integer as VQ.C's production row count.
-- ════════════════════════════════════════════════════════════════════
