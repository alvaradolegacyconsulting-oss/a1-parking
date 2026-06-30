-- ════════════════════════════════════════════════════════════════════
-- companies.billing_email — standalone column add (B228 prerequisite)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   ALTER TABLE public.companies ADD COLUMN billing_email TEXT;
--
-- WHY
--   Super-Admin Console Phase 1 (B228) renders a subscribers CRM card per
--   company. CRM contact info today lives across (name, primary_contact_name,
--   phone, address) on companies, but the canonical billing-email — the one
--   Stripe sends receipts/dunning notices to — is not locally queryable; it
--   exists only on the Stripe customer object. Resolving via Stripe API at
--   console load would tie console rendering to a third-party round-trip.
--
--   Adding a local column lets the console:
--     • render without Stripe dependency,
--     • survive Stripe outages without falling over,
--     • be backfilled by Jose at his convenience (or eventually synced from
--       Stripe via the webhook layer).
--
--   Ships AHEAD of Phase 1's console route so the column exists when Phase 1
--   first reads it. Decoupled commit per Jose's spec.
--
-- BACKFILL
--   Not handled here. Column lands NULL on existing rows; Jose populates
--   manually (or future webhook handler stamps from Stripe). Console treats
--   NULL gracefully (renders "— (not set)" so the missing-data state is
--   visible, not silent).
--
-- VERIFICATION
--   See sibling _verification.sql:
--     §1 column exists with correct type
--     §2 NULL-default on existing rows
--     §3 a behavioral INSERT/UPDATE round-trip
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS billing_email TEXT;

COMMENT ON COLUMN public.companies.billing_email IS
  'Billing email Stripe sends receipts/dunning to. Locally queryable so the super-admin console renders without a Stripe API round-trip. Backfilled manually or eventually synced from Stripe via webhook. B228 prerequisite.';

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PREREQ',
  'companies',
  NULL,
  jsonb_build_object(
    'migration',     '20260630_companies_billing_email',
    'change',        'ADD COLUMN companies.billing_email TEXT',
    'rationale',     'Super-Admin Console Phase 1 (B228) CRM card — local-queryable billing email decoupled from Stripe API.',
    'backfill_plan', 'Manual by Jose, or future Stripe-webhook sync. Console renders NULL gracefully as "— (not set)".'
  ),
  now()
);

COMMIT;
