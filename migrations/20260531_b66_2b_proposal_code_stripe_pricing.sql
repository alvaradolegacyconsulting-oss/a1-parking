-- ════════════════════════════════════════════════════════════════════
-- B66.2b commit 1 (REVISED) — proposal-code Stripe pricing schema
-- Drafted: 2026-05-22 (revised same day after pre-apply audit miss).
-- NOT YET APPLIED.
--
-- Second sub-arc of the B66 Stripe billing arc. B66.2a established
-- the standard catalog (30 Prices in stripe_prices); B66.2b extends
-- the same table to also hold proposal-code-override Prices and
-- threads the FK + UNIQUE adjustments through to keep both row types
-- coexisting cleanly.
--
-- ── REVISION FROM UNREVISED VERSION (commit e0cd037) ─────────────────
-- The first push of this migration included two additional PARTS that
-- turned out to be no-ops against production:
--   • Original PART 2 (companies.acquisition_channel column + CHECK +
--     backfill) — column already existed in production with identical
--     CHECK constraint per Jose's pg_constraint diagnostic pull. B65-
--     era work added it without a corresponding repo migration file,
--     so the repo-only audit missed it.
--   • Original PART 5 (CREATE OR REPLACE redeem_proposal_code body
--     update) — production function body was byte-identical to the
--     reconstruction (including the INSERT INTO companies setting
--     acquisition_channel = 'proposal_code'), so CREATE OR REPLACE
--     would have been a no-op.
-- Apply attempt on e0cd037 failed with `relation "v_caller_email" does
-- not exist` — likely SQL Editor smart-splitting on `;` inside the
-- dollar-quoted CREATE OR REPLACE FUNCTION body (a stricter variant of
-- the feedback_sql_editor_partial_apply pattern). Moot here since PART
-- 5 is removed entirely; for any future function migration, use a
-- tagged dollar-quote delimiter ($func$ ... $func$) to prevent
-- editor-side ambiguity.
-- Process lesson filed for memory after ship: "audit pass must query
-- production schema, not just inventory repo migration files."
--
-- ── PARTS (revised — net-new schema only) ───────────────────────────
--   1. proposal_codes.lock_in_duration — NEW nullable INTEGER column
--      (months, 1-36). Captures contractual lock-in. Commit 2 adds
--      the admin input field + draft-mode editor + read-only display.
--      Net-new (grep for lock_in/lockIn/locked_in returned zero hits).
--
--   2. stripe_prices.proposal_code_id — NEW nullable BIGINT FK to
--      proposal_codes(id) ON DELETE RESTRICT. Standard catalog rows
--      have NULL; proposal-code override rows have the FK populated.
--      RESTRICT prevents accidental DELETE of an issued proposal code
--      that has Stripe Prices attached. Partial index on
--      proposal_code_id WHERE IS NOT NULL supports JOIN/SELECT-by-
--      proposal-code at redemption time (B66.7).
--
--   3. Composite UNIQUE adjustment on stripe_prices. The B66.2a
--      stripe_prices_unique_combo 5-column UNIQUE collides the moment
--      a proposal row shares (tier_track, tier_name, line_item, cycle,
--      mode) with a standard row — which it WILL (proposal codes
--      anchor to a real tier via base_tier). Path 1 fix from pre-
--      flight ask 14: drop the single 5-column UNIQUE, replace with
--      two partial UNIQUE indexes:
--        • stripe_prices_unique_combo_standard
--            (tier_track, tier_name, line_item, cycle, mode)
--            WHERE proposal_code_id IS NULL
--          → covers all 30 existing standard rows transparently.
--        • stripe_prices_unique_combo_proposal
--            (proposal_code_id, line_item, cycle, mode)
--            WHERE proposal_code_id IS NOT NULL
--          → prevents duplicate proposal Prices on issue-button re-
--            runs in commit 2. mode included so test+live catalogs
--            stay isolated within one proposal code.
--      Path 2 (NULLS NOT DISTINCT 6-col UNIQUE) rejected for reader-
--      readability. All B66.2a CHECK constraints (tier_name 6-value
--      enum, driver_enforcement_only cross-CHECK, etc.) unchanged and
--      apply to both row types. Existing UNIQUE on stripe_price_id
--      stays intact.
--
-- ── DEPENDENCIES (verified) ──────────────────────────────────────────
-- • B66.2a stripe_prices table (commit 3135cab) applied 2026-05-22.
-- • B66.2a stripe_prices_unique_combo 5-column UNIQUE constraint
--   present in production per Jose's diagnostic pull (PART 3 below
--   DROPs it with IF EXISTS safety regardless).
-- • companies.acquisition_channel column + CHECK already in
--   production (B65-era; verified via pg_constraint). Not touched here.
-- • redeem_proposal_code() function in production already inserts
--   acquisition_channel = 'proposal_code' (B65-era; verified via
--   pg_get_functiondef). Not touched here.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • Stripe Price object creation — commit 2 (issue-route extension
--   + new app/lib/proposal-code-stripe.ts helper).
-- • Backfill of existing redeemed proposal codes — permanently de-
--   scoped per Jose's 2026-05-22 confirmation that no production
--   customer data exists (A1 not yet onboarded; existing proposal_codes
--   rows are demo/test fixtures cleaned up in pre-launch scrub).
--   Future Stripe-billing customers flow through B66.2b → B66.7 cleanly
--   from day one.
-- • Annual cycle support for proposal codes (pre-flight ask 7 YAGNI'd).
--   All proposal-row stripe_prices entries will have cycle='monthly'.
-- • B100 — revoke flow Stripe Price deactivation. Separate backlog
--   entry; Stripe Prices are immutable and our state model handles
--   revoke semantically.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Open the Supabase SQL Editor, paste this
-- entire file as ONE block, click Run ONCE. BEGIN/COMMIT atomic — any
-- statement failing rolls back the entire migration. All DDL idempotent
-- (IF NOT EXISTS / DO $$ guards / IF NOT EXISTS on indexes /
-- DROP CONSTRAINT IF EXISTS). Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — proposal_codes.lock_in_duration
-- ════════════════════════════════════════════════════════════════════
-- Months of contractual lock-in. Nullable (most codes don't have one).
-- 1-36 month range covers practical lock-in lengths; the upper bound
-- is a sanity ceiling rather than a hard product constraint. Commit 2
-- adds the admin form input + draft-mode field + read-only display in
-- the issued/redeemed summary.

ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS lock_in_duration INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_lock_in_duration_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_lock_in_duration_valid
      CHECK (lock_in_duration IS NULL OR (lock_in_duration BETWEEN 1 AND 36));
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — stripe_prices.proposal_code_id
-- ════════════════════════════════════════════════════════════════════
-- BIGINT nullable FK to proposal_codes(id). NULL = standard catalog
-- row (current 30 from B66.2a). NOT NULL = proposal-code override row.
--
-- ON DELETE RESTRICT: prevents deleting a proposal code that has
-- Stripe Prices attached. Today /admin/proposal-codes/[code] only
-- allows DELETE on drafts, and drafts have no Stripe Prices (Stripe
-- creation happens at Issue, not Save Draft) — so RESTRICT will
-- never block a legitimate operation. If an admin ever attempts a
-- direct-DB delete of an issued code, RESTRICT prevents silently
-- nuking the Price-tracking row.
--
-- Index supports JOIN/SELECT-by-proposal-code performance at
-- redemption time (B66.7). Partial WHERE IS NOT NULL keeps the index
-- lean (standard-catalog rows excluded).

ALTER TABLE stripe_prices
  ADD COLUMN IF NOT EXISTS proposal_code_id BIGINT
    REFERENCES proposal_codes(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_stripe_prices_proposal_code_id
  ON stripe_prices(proposal_code_id)
  WHERE proposal_code_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Composite UNIQUE adjustment
-- ════════════════════════════════════════════════════════════════════
-- B66.2a's stripe_prices_unique_combo single 5-column UNIQUE breaks
-- the moment a proposal-row shares (tier_track, tier_name, line_item,
-- cycle, mode) with a standard-row — which it WILL (e.g., a code
-- anchored to enforcement.legacy.base.monthly.test has the same tuple
-- as the standard catalog row at that address). Path 1 fix from pre-
-- flight ask 14: drop + replace with two partial UNIQUE indexes.
--
-- The two indexes together cover:
--   • Standard rows: unique by (track, tier, line_item, cycle, mode)
--     when proposal_code_id IS NULL (semantically: "one standard
--     catalog Price per logical address per mode"). All 30 existing
--     rows satisfy this and migrate transparently.
--   • Proposal rows: unique by (proposal_code_id, line_item, cycle,
--     mode) when proposal_code_id IS NOT NULL (semantically: "one
--     Price per (line_item, cycle, mode) per proposal code"). The
--     issue-button re-runs in commit 2 rely on this for idempotency
--     alongside the lookup_key probe.
--
-- The existing UNIQUE on stripe_prices.stripe_price_id (B66.2a) stays
-- intact and continues to prevent the same Stripe Price from backing
-- two rows regardless of standard/proposal distinction. All B66.2a
-- CHECK constraints stay intact and apply to both row types.

ALTER TABLE stripe_prices
  DROP CONSTRAINT IF EXISTS stripe_prices_unique_combo;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_prices_unique_combo_standard
  ON stripe_prices (tier_track, tier_name, line_item, cycle, mode)
  WHERE proposal_code_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_prices_unique_combo_proposal
  ON stripe_prices (proposal_code_id, line_item, cycle, mode)
  WHERE proposal_code_id IS NOT NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. proposal_codes.lock_in_duration column + CHECK ──────────────
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'proposal_codes'
--     AND column_name = 'lock_in_duration';
--   -- Expected: 1 row — lock_in_duration | integer | YES
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'proposal_codes_lock_in_duration_valid';
--   -- Expected: 1 row — CHECK ((lock_in_duration IS NULL) OR ((lock_in_duration >= 1) AND (lock_in_duration <= 36)))
--
-- ── B. stripe_prices.proposal_code_id column + FK ──────────────────
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'stripe_prices'
--     AND column_name = 'proposal_code_id';
--   -- Expected: 1 row — proposal_code_id | bigint | YES
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'stripe_prices'::regclass
--     AND contype = 'f'
--     AND conname LIKE '%proposal_code_id%';
--   -- Expected: 1 row — FOREIGN KEY (proposal_code_id) REFERENCES proposal_codes(id) ON DELETE RESTRICT
--
-- ── C. Old composite UNIQUE constraint dropped ─────────────────────
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'stripe_prices'::regclass
--     AND conname = 'stripe_prices_unique_combo';
--   -- Expected: 0 rows. Constraint dropped by PART 3.
--
-- ── D. Three new indexes exist ─────────────────────────────────────
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND tablename = 'stripe_prices'
--     AND indexname IN (
--       'stripe_prices_unique_combo_standard',
--       'stripe_prices_unique_combo_proposal',
--       'idx_stripe_prices_proposal_code_id'
--     )
--   ORDER BY indexname;
--   -- Expected: 3 rows.
--   --   idx_stripe_prices_proposal_code_id        — non-unique partial WHERE IS NOT NULL
--   --   stripe_prices_unique_combo_proposal       — UNIQUE partial WHERE IS NOT NULL on (proposal_code_id, line_item, cycle, mode)
--   --   stripe_prices_unique_combo_standard       — UNIQUE partial WHERE IS NULL on (tier_track, tier_name, line_item, cycle, mode)
--
-- ── E. Existing 30 stripe_prices rows intact ───────────────────────
--   SELECT mode, COUNT(*) FROM stripe_prices
--   WHERE proposal_code_id IS NULL
--   GROUP BY mode
--   ORDER BY mode;
--   -- Expected: test | 30  (the B66.2a catalog, unchanged).
--   -- If STRIPE_MODE=live has been populated since, expect a live row too.
--
--   -- Verify the new partial UNIQUE doesn't reject any existing row:
--   SELECT tier_track, tier_name, line_item, cycle, mode, COUNT(*)
--   FROM stripe_prices
--   WHERE proposal_code_id IS NULL
--   GROUP BY tier_track, tier_name, line_item, cycle, mode
--   HAVING COUNT(*) > 1;
--   -- Expected: 0 rows. All existing standard rows are unique by the
--   -- 5-tuple, so the new partial UNIQUE migrates them transparently.
--
-- ── OPTIONAL NEGATIVE TESTS (destructive — dev/staging only) ────────
-- These confirm constraints actually enforce. Run with service_role
-- (admin RLS would gate them otherwise). Roll back if non-dev.
--
-- N1. lock_in_duration out of range rejected:
--   INSERT INTO proposal_codes (code, status, lock_in_duration)
--   VALUES ('TEST-LOCKIN-OOR', 'draft', 0);
--   -- Expected: CHECK violation on proposal_codes_lock_in_duration_valid.
--
-- N2. Proposal-row duplicate rejected:
--   -- (Requires a proposal_code row to exist; substitute a real id.)
--   INSERT INTO stripe_prices (
--     stripe_price_id, stripe_product_id, tier_track, tier_name,
--     line_item, cycle, unit_amount_cents, mode, lookup_key, proposal_code_id
--   ) VALUES
--     ('price_test_dup_a', 'prod_test', 'enforcement', 'legacy', 'base', 'monthly', 12900, 'test', 'sml.proposal.TEST-X.base.monthly', 999),
--     ('price_test_dup_b', 'prod_test', 'enforcement', 'legacy', 'base', 'monthly', 12900, 'test', 'sml.proposal.TEST-X.base.monthly', 999);
--   -- Expected: UNIQUE violation on stripe_prices_unique_combo_proposal.
--
-- N3. Standard + proposal at same 5-tuple coexist:
--   -- This is the WHOLE POINT of the partial UNIQUE split — the
--   -- standard row at (enforcement, legacy, base, monthly, test)
--   -- already exists in the catalog. Adding a proposal-row at the
--   -- same 5-tuple (different proposal_code_id) must NOT raise.
--   INSERT INTO stripe_prices (
--     stripe_price_id, stripe_product_id, tier_track, tier_name,
--     line_item, cycle, unit_amount_cents, mode, lookup_key, proposal_code_id
--   ) VALUES (
--     'price_test_coexist', 'prod_test', 'enforcement', 'legacy',
--     'base', 'monthly', 9900, 'test', 'sml.proposal.TEST-COEXIST.base.monthly', 999
--   );
--   -- Expected: succeeds (no violation). Clean up afterward.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL is idempotent:
--   • ADD COLUMN IF NOT EXISTS
--   • DO $$ BEGIN IF NOT EXISTS ... ADD CONSTRAINT
--   • DROP CONSTRAINT IF EXISTS
--   • CREATE [UNIQUE] INDEX IF NOT EXISTS
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
