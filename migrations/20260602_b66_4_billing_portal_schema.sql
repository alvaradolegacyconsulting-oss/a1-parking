-- ════════════════════════════════════════════════════════════════════
-- B66.4 commit 1 — Stripe Customer Portal schema additions
-- Drafted: 2026-05-25 — NOT YET APPLIED.
--
-- Fourth sub-arc of the B66 Stripe billing arc. B66.1 scaffolded
-- dormancy + webhook persistence; B66.2a populated the standard Price
-- catalog; B66.2b added proposal-code Prices; B66.3 wired self-serve
-- signup with checkout.session.completed handler. B66.4 adds Customer
-- Portal embed in /company_admin/billing + 3 new webhook handlers
-- (customer.subscription.updated, customer.subscription.deleted,
-- customer.updated) for syncing Portal-driven changes back to Supabase.
--
-- This migration ships the SCHEMA layer (7 net-new columns on companies
-- + 1 new CHECK constraint). The new webhook handlers + Portal session
-- creator + Billing tab UI land in commit 2.
--
-- ── AUDIT-PASS RESULTS CONSUMED (Jose-run 2026-05-25) ────────────────
-- AP.1 confirmed the following existing-column state on `companies`:
--   • `address` TEXT NULL — already exists (B65.4-era; populated by
--     redeem_proposal_code for proposal-code customers). Reused here
--     for the street line of the billing address. Webhook handler
--     writes Stripe's `customer.address.line1` to this column. **NOT
--     TOUCHED BY THIS MIGRATION** — included in dependency check only.
--   • All other 7 fields below are net-new (zero matches).
-- AP.2 confirmed no existing CHECK constraint on companies mentioning
-- "subscription"; the new subscription_status CHECK lands clean.
-- account_state CHECK (configuring/active/suspended/cancelled) stays
-- as-is per the B66.3 audit; 'past_due' extension deferred to B66.5
-- (dunning is the first writer of that value).
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. companies — 7 nullable columns + CHECK on subscription_status:
--        • subscription_status TEXT NULL CHECK enum (Stripe's 8 values)
--        • current_period_end TIMESTAMPTZ NULL
--        • cancel_at_period_end BOOLEAN NULL (NULL = no subscription;
--            true/false = Stripe-side flag)
--        • billing_city TEXT NULL
--        • billing_state TEXT NULL
--        • billing_postal_code TEXT NULL
--        • billing_country TEXT NULL
--
--      All 7 nullable because:
--        (a) Existing 5 proposal_code companies have NULL Stripe
--            subscription state today (B66.7 hasn't shipped); these
--            columns stay NULL until B66.7 wires Subscription creation
--            at redeem_proposal_code time.
--        (b) Self-serve companies (post-B66.3) populate via the
--            checkout.session.completed handler at signup, but the
--            subscription_status / current_period_end / cancel_at_period_end
--            fields populate via the NEW customer.subscription.updated
--            handler (commit 2) on first subscription event AFTER
--            checkout. Brief window where stripe_customer_id +
--            stripe_subscription_id exist but subscription_status is
--            NULL — webhook delivery latency.
--        (c) Billing address fields populate only when the customer
--            updates billing info via Stripe Portal. Pre-Portal, all
--            NULL except `address` (which B65.4 redeem already wrote).
--
--      The `subscription_status` CHECK enum mirrors Stripe's
--      Subscription.status field values exactly per
--      https://stripe.com/docs/api/subscriptions/object#subscription_object-status
--      (8 values as of API 2026-04-22.dahlia). Keeping the enum
--      tight prevents Stripe API version drift from silently
--      introducing new statuses — if Stripe adds a status in a future
--      API version, the webhook handler will fail-closed on the CHECK
--      violation rather than silently accepting an unknown value, and
--      we'll surface the new status as a deliberate schema bump.
--
-- ── DEPENDENCIES (verified via AP.1 + AP.2) ──────────────────────────
-- • companies table exists with `address` (B65.4), `stripe_customer_id`
--   + `stripe_subscription_id` (B66.3 commit 1 / `3c6bd8c`),
--   `account_state` CHECK (B65), `acquisition_channel` CHECK (B65-era).
-- • B66.1 webhook endpoint already subscribed to all 3 event types
--   B66.4 needs (Jose-verified in Stripe Dashboard delivery history):
--   customer.subscription.updated, customer.subscription.deleted,
--   customer.updated. Confirmed delivery + dormancy gate working
--   (events ack {"received": true, "processed": false,
--   "reason": "billing_disabled"} pre-flip).
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • Webhook handlers for the 3 new event types — commit 2
--   (extends app/lib/stripe-event-handlers.ts with handleSubscriptionUpdated,
--   handleSubscriptionDeleted, handleCustomerUpdated).
-- • Stripe Customer Portal config + session creation route — commit 2
--   (scripts/configure-stripe-portal.ts + app/api/billing/portal-session/route.ts).
-- • /company_admin Billing tab UI — commit 2 (edit to app/company_admin/page.tsx).
-- • account_state CHECK extension for 'past_due' — defer to B66.5
--   (dunning is the first writer). B66.4 webhook handlers will write
--   subscription_status='past_due' BEFORE account_state knows about
--   the value; the two columns mean different things and that's fine.
-- • Index on subscription_status — defer to B66.5 (when dunning cron
--   needs "give me all past_due companies" queries; today no such reader).
-- • Index on current_period_end — defer to B66.5 (same reasoning).
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. BEGIN/COMMIT atomic — any
-- statement failing rolls back the entire migration. All DDL idempotent
-- (ADD COLUMN IF NOT EXISTS / DO $func$ IF NOT EXISTS guard for CHECK).
-- The single DO block uses $func$ tagged dollar-quote per
-- feedback_sql_editor_dollar_quote_parsing. Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — companies subscription-state + billing-address columns
-- ════════════════════════════════════════════════════════════════════
-- All 7 columns nullable. See header for rationale. The webhook
-- handlers (commit 2) write to these:
--   customer.subscription.updated → subscription_status,
--                                   current_period_end,
--                                   cancel_at_period_end
--   customer.subscription.deleted → (delegates to account_state UPDATE)
--   customer.updated              → address (existing column) + the
--                                   4 billing_* sub-fields

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS subscription_status   TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end  BOOLEAN,
  ADD COLUMN IF NOT EXISTS billing_city          TEXT,
  ADD COLUMN IF NOT EXISTS billing_state         TEXT,
  ADD COLUMN IF NOT EXISTS billing_postal_code   TEXT,
  ADD COLUMN IF NOT EXISTS billing_country       TEXT;

-- ── CHECK on subscription_status (enum mirror of Stripe API 2026-04-22.dahlia)
-- The 8 values come from Stripe's Subscription.status field per
-- https://stripe.com/docs/api/subscriptions/object#subscription_object-status.
-- Wrapped in DO $func$ IF NOT EXISTS guard so re-apply is a no-op.
-- $func$ tagged dollar-quote per feedback_sql_editor_dollar_quote_parsing
-- (bare $$ can be smart-split by Supabase SQL Editor's tokenizer).
DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_subscription_status_valid'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_subscription_status_valid
      CHECK (
        subscription_status IS NULL
        OR subscription_status IN (
          'active', 'past_due', 'canceled', 'unpaid',
          'trialing', 'incomplete', 'incomplete_expired', 'paused'
        )
      );
  END IF;
END
$func$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── VQ.A — all 7 new columns present with correct types
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name IN (
--       'subscription_status','current_period_end','cancel_at_period_end',
--       'billing_city','billing_state','billing_postal_code','billing_country'
--     )
--   ORDER BY column_name;
--   -- Expected: 7 rows, all is_nullable=YES, no defaults
--   --   billing_city          | text                        | YES
--   --   billing_country       | text                        | YES
--   --   billing_postal_code   | text                        | YES
--   --   billing_state         | text                        | YES
--   --   cancel_at_period_end  | boolean                     | YES
--   --   current_period_end    | timestamp with time zone    | YES
--   --   subscription_status   | text                        | YES
--
-- ── VQ.B — subscription_status CHECK constraint present + correct
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'companies_subscription_status_valid';
--   -- Expected: 1 row, CHECK ((subscription_status IS NULL) OR
--   --   (subscription_status = ANY (ARRAY['active', 'past_due',
--   --   'canceled', 'unpaid', 'trialing', 'incomplete',
--   --   'incomplete_expired', 'paused'])))
--
-- ── VQ.C — address column still present (sanity: no accidental DROP)
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name = 'address';
--   -- Expected: 1 row, address | text | YES (B65.4-era; this migration
--   --   does not touch it but verifies it survives)
--
-- ── VQ.D — pre-existing companies CHECK constraints intact
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.companies'::regclass
--     AND contype = 'c'
--     AND conname IN (
--       'companies_account_state_valid',
--       'companies_acquisition_channel_valid'
--     )
--   ORDER BY conname;
--   -- Expected: 2 rows. Both should remain — this migration only ADDs
--   --   a new CHECK; existing CHECKs untouched.
--
-- ── VQ.E — existing rows have NULL for all 7 new columns
--   SELECT
--     COUNT(*) FILTER (WHERE subscription_status IS NULL)   AS null_status,
--     COUNT(*) FILTER (WHERE current_period_end IS NULL)    AS null_period_end,
--     COUNT(*) FILTER (WHERE cancel_at_period_end IS NULL)  AS null_cancel,
--     COUNT(*) FILTER (WHERE billing_city IS NULL)          AS null_city,
--     COUNT(*) FILTER (WHERE billing_state IS NULL)         AS null_state,
--     COUNT(*) FILTER (WHERE billing_postal_code IS NULL)   AS null_zip,
--     COUNT(*) FILTER (WHERE billing_country IS NULL)       AS null_country,
--     COUNT(*) AS total_rows
--   FROM companies;
--   -- Expected: all 7 null_* counts equal total_rows. New columns
--   --   ship empty; no backfill needed (proposal_code customers have
--   --   no Stripe subscription state yet, self-serve customers get
--   --   populated by commit 2's webhook handlers).
--
-- ── VQ.F — sanity: row count unchanged from pre-migration
--   SELECT COUNT(*) FROM companies;
--   -- Expected: same count as pre-migration (5+ proposal_code rows
--   --   per B66.3 AP.4 + any test fixtures since cleaned up).
--   --   Migration adds columns, not rows.
--
-- ── VQ.G — negative test: CHECK rejects an invalid subscription_status
-- Direct UPDATE on a real existing company row so the CHECK constraint
-- is forced to evaluate. Per feedback_sql_editor_dollar_quote_parsing
-- extension: prefer direct INSERT/UPDATE over DO+EXCEPTION wrappers
-- for transparent error display in the SQL Editor.
--
-- Run as service_role (companies RLS gates non-admin UPDATEs).
--
--   UPDATE companies
--     SET subscription_status = 'invalid_status_xyz'
--     WHERE id = (SELECT id FROM companies LIMIT 1);
--   -- Expected: red error in SQL Editor —
--   --   "ERROR: new row for relation 'companies' violates check
--   --    constraint 'companies_subscription_status_valid'"
--   -- No row updated. The transient attempt is harmless since the
--   -- CHECK rejects before the write commits.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent:
--   • ADD COLUMN IF NOT EXISTS (× 7 columns; no-op if already present)
--   • DO $func$ IF NOT EXISTS ... ADD CONSTRAINT (CHECK; no-op on re-apply)
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
