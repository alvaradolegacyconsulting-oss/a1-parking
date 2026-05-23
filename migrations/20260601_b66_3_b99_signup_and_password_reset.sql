-- ════════════════════════════════════════════════════════════════════
-- B66.3 + B99 commit 1 — self-serve signup + password reset schema
-- Drafted: 2026-05-23 — NOT YET APPLIED.
--
-- Third sub-arc of the B66 Stripe billing arc. B66.1 scaffolded
-- dormancy + webhook persistence; B66.2a populated the standard Price
-- catalog (30 rows); B66.2b added proposal-code override Prices. B66.3
-- is the CONSUMPTION arc — wires the catalog into the self-serve
-- signup path with Stripe Checkout + a webhook-driven company-creation
-- flow. B99 (self-serve password reset UI) folds in as the same commit
-- because both are anonymous-route Auth flows sharing middleware
-- allowlist updates in commit 2.
--
-- ── AUDIT-PASS RESULTS CONSUMED (Jose-run 2026-05-23) ────────────────
-- Queries A-F established that PARTS originally anticipated in pre-
-- flight DO NOT need to ship in this migration:
--   • companies.acquisition_channel — exists with CHECK
--     ('self_serve','proposal_code'). 5 existing rows = 'proposal_code',
--     0 NULL. No change.
--   • companies.account_state — exists with CHECK
--     ('configuring','active','suspended','cancelled'). 'past_due'
--     deferred to B66.5 (dunning) when first writer appears. No change.
--   • tos_acceptances columns confirmed; row count = 1 (B65 smoke
--     fixture). PART 2 backfill targets exactly that row.
--   • stripe_prices catalog complete: 30 standard rows in test mode.
--     B66.3 Checkout line-item builder consumes via SELECT.
--   • stripe_customer_id / stripe_subscription_id missing → PART 1.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. companies.stripe_customer_id + stripe_subscription_id — NEW
--      nullable TEXT columns. Webhook handler writes both at
--      checkout.session.completed transaction. Partial UNIQUE index on
--      stripe_customer_id (WHERE NOT NULL) — one Stripe Customer per
--      company; prevents duplicate-link bugs from a corrupted webhook
--      replay or out-of-order events. stripe_subscription_id NOT
--      unique today (one Subscription per Customer is the norm but
--      future plan-change flows may temporarily hold two; defer the
--      constraint decision to B66.5).
--
--   2. tos_acceptances multi-document-type support (Schema A.2 from
--      pre-flight). Adds:
--        • document_type TEXT NOT NULL — discriminator
--            ('tos_and_privacy' | 'texas_attestation')
--        • attestation_version TEXT NULL — populated only for
--            'texas_attestation' rows
--      Relaxes:
--        • tos_version + privacy_version from NOT NULL → NULL allowed
--          (attestation rows leave these NULL)
--      Backfill:
--        • Existing single B65 smoke row gets document_type =
--          'tos_and_privacy' (preserves "this row covers ToS + Privacy"
--          semantics). Backfill runs BEFORE SET NOT NULL on
--          document_type so the row satisfies the new constraint at
--          the moment it locks in.
--      Two CHECK constraints:
--        • tos_acceptances_document_type_valid — enum of 2 values
--        • tos_acceptances_version_match — bidirectional:
--            tos_and_privacy → tos+privacy populated, attestation NULL
--            texas_attestation → attestation populated, tos+privacy NULL
--          Negative test VQ.G confirms enforcement.
--
-- ── DEPENDENCIES (verified via audit pass) ───────────────────────────
-- • companies table with account_state column from B65 (commit
--   20260520).
-- • tos_acceptances table from B65 (commit 20260520) — 1 existing row.
-- • stripe_events table from B66.1 — webhook idempotency layer (used
--   in commit 2's webhook handler, not touched here).
-- • B66.2a stripe_prices catalog with 30 standard rows in test mode —
--   line-item builder reads this in commit 2.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • account_state CHECK extension for 'past_due' — defer to B66.5
--   (dunning is the first writer of that value).
-- • is_active boolean / account_state consolidation — filed as B105
--   (P3). After B66.5 ships and the state machine is settled.
-- • Texas attestation wording bump from v0 → v1.0 — separate small
--   commit when attorney returns; existing users get a re-attest
--   prompt at next login (also future work).
-- • Welcome email send + dunning banners + Customer Portal embed —
--   B66.4 / B66.5 / B66.8 territory.
-- • Stripe Subscription creation for proposal-code redemption —
--   B66.7 (separate path; B66.2b created the Price IDs, B66.7
--   creates the Subscription when redeem_proposal_code is called).
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. Do NOT run statement-by-
-- statement — that breaks BEGIN/COMMIT atomicity (per
-- feedback_sql_editor_partial_apply). Any DO blocks below use
-- $func$ ... $func$ tagged dollar-quote delimiters per
-- feedback_sql_editor_dollar_quote_parsing to avoid editor smart-split
-- ambiguity. All DDL idempotent (IF NOT EXISTS / DO $func$ IF NOT
-- EXISTS guards / no-op on re-apply); UPDATE backfill is WHERE-NULL-
-- guarded so re-apply touches zero rows. Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — companies.stripe_customer_id + stripe_subscription_id
-- ════════════════════════════════════════════════════════════════════
-- Both nullable TEXT (Stripe IDs are opaque strings, typed 'cus_*' and
-- 'sub_*'). Pre-existing companies (5 proposal_code rows + any older)
-- have NULL for both — Stripe IDs don't exist for proposal-code
-- customers until B66.7 wires Subscription creation at redemption.
-- Self-serve companies (post-B66.3 webhook) get both populated at
-- creation.
--
-- Partial UNIQUE on stripe_customer_id WHERE IS NOT NULL: one Stripe
-- Customer should never back two ShieldMyLot companies. Partial
-- predicate skips NULLs so the 5 existing rows don't collide.
-- stripe_subscription_id NOT made UNIQUE — see header rationale.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS companies_stripe_customer_id_unique
  ON companies (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — tos_acceptances multi-document support (Schema A.2)
-- ════════════════════════════════════════════════════════════════════
-- Adds discriminator + attestation_version column, backfills the
-- single existing row, relaxes legacy NOT NULL constraints, and
-- registers two CHECK constraints (document_type enum + bidirectional
-- version-match).
--
-- Order matters and is non-negotiable:
--   1. ADD COLUMN (both new columns nullable)
--   2. UPDATE backfill (existing row → 'tos_and_privacy')
--   3. SET NOT NULL on document_type (passes — backfill populated it)
--   4. DROP NOT NULL on tos_version + privacy_version (allows future
--      texas_attestation rows to leave these NULL)
--   5. ADD CHECK document_type_valid (passes — backfilled value valid)
--   6. ADD CHECK version_match (passes — backfilled row matches
--      'tos_and_privacy' branch with both versions populated +
--      attestation_version NULL)
--
-- The version_match CHECK is bidirectional — covers BOTH document
-- types in a single constraint so the schema can never hold a mixed
-- state (e.g., a 'texas_attestation' row with a stray tos_version).

ALTER TABLE tos_acceptances
  ADD COLUMN IF NOT EXISTS document_type      TEXT,
  ADD COLUMN IF NOT EXISTS attestation_version TEXT;

UPDATE tos_acceptances
  SET document_type = 'tos_and_privacy'
  WHERE document_type IS NULL;

ALTER TABLE tos_acceptances
  ALTER COLUMN document_type SET NOT NULL;

ALTER TABLE tos_acceptances
  ALTER COLUMN tos_version     DROP NOT NULL,
  ALTER COLUMN privacy_version DROP NOT NULL;

-- CHECK constraints wrapped in IF NOT EXISTS guards so re-apply is a
-- no-op. Bare ADD CONSTRAINT errors on duplicate name; the DO block
-- pattern matches what B66.2b commit 1 used for the same idempotency
-- need. $func$ tagged dollar-quote per feedback_sql_editor_dollar_quote_parsing.
DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_document_type_valid'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_document_type_valid
      CHECK (document_type IN ('tos_and_privacy', 'texas_attestation'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_version_match'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_version_match
      CHECK (
        (document_type = 'tos_and_privacy'
           AND tos_version IS NOT NULL
           AND privacy_version IS NOT NULL
           AND attestation_version IS NULL)
        OR
        (document_type = 'texas_attestation'
           AND attestation_version IS NOT NULL
           AND tos_version IS NULL
           AND privacy_version IS NULL)
      );
  END IF;
END
$func$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── VQ.A — stripe_customer_id + stripe_subscription_id columns exist
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name IN ('stripe_customer_id','stripe_subscription_id')
--   ORDER BY column_name;
--   -- Expected: 2 rows
--   --   stripe_customer_id     | text | YES
--   --   stripe_subscription_id | text | YES
--
-- ── VQ.B — UNIQUE index on stripe_customer_id
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'companies'
--     AND indexname = 'companies_stripe_customer_id_unique';
--   -- Expected: 1 row, indexdef contains
--   --   "UNIQUE INDEX ... ON public.companies USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)"
--
-- ── VQ.C — tos_acceptances new columns exist
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'tos_acceptances'
--     AND column_name IN ('document_type','attestation_version')
--   ORDER BY column_name;
--   -- Expected: 2 rows
--   --   attestation_version | text | YES
--   --   document_type       | text | NO
--
-- ── VQ.D — tos_version + privacy_version relaxed to nullable
--   SELECT column_name, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'tos_acceptances'
--     AND column_name IN ('tos_version','privacy_version')
--   ORDER BY column_name;
--   -- Expected: 2 rows, both is_nullable = YES
--
-- ── VQ.E — existing row backfilled correctly
--   SELECT id,
--          document_type,
--          tos_version IS NOT NULL         AS has_tos,
--          privacy_version IS NOT NULL     AS has_priv,
--          attestation_version IS NULL     AS no_attest
--   FROM tos_acceptances;
--   -- Expected: 1 row
--   --   document_type='tos_and_privacy', has_tos=true, has_priv=true, no_attest=true
--
-- ── VQ.F — both new CHECK constraints registered
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.tos_acceptances'::regclass
--     AND contype = 'c'
--     AND conname IN ('tos_acceptances_document_type_valid', 'tos_acceptances_version_match')
--   ORDER BY conname;
--   -- Expected: 2 rows
--
-- ── VQ.G — negative test: bidirectional CHECK actually enforces
-- Attempts to insert a 'tos_and_privacy' row with NULL versions; must
-- fail. Wrapped in DO block + tagged dollar-quote per
-- feedback_sql_editor_dollar_quote_parsing so the SQL Editor doesn't
-- smart-split on the embedded BEGIN/EXCEPTION semicolons.
--
-- Run as service_role (admin RLS blocks tos_acceptances writes for
-- non-admin authenticated; service_role bypasses).
--
--   DO $func$
--   BEGIN
--     BEGIN
--       INSERT INTO tos_acceptances (user_id, document_type, accepted_at)
--       VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'tos_and_privacy', now());
--       RAISE EXCEPTION 'CHECK should have blocked this insert';
--     EXCEPTION WHEN check_violation THEN
--       RAISE NOTICE 'OK: version-match CHECK rejected invalid tos_and_privacy row';
--     END;
--   END
--   $func$;
--   -- Expected: NOTICE "OK: version-match CHECK rejected invalid tos_and_privacy row"
--   --           (no rows inserted; the inner BEGIN/EXCEPTION traps the
--   --            check_violation and the outer DO completes cleanly)
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent:
--   • ADD COLUMN IF NOT EXISTS
--   • UPDATE ... WHERE column IS NULL (no-op on re-apply)
--   • ALTER COLUMN SET NOT NULL / DROP NOT NULL (no-op when already in target state)
--   • DO $func$ IF NOT EXISTS ... ADD CONSTRAINT (no-op on re-apply)
--   • CREATE UNIQUE INDEX IF NOT EXISTS
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
