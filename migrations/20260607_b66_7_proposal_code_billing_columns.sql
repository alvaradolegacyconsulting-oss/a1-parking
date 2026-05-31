-- ════════════════════════════════════════════════════════════════════
-- B66.7 — proposal-code billing column scaffold
-- Drafted: 2026-05-30 — NOT YET APPLIED.
--
-- The CONSUMPTION arc for proposal codes: wires B66.2a standard-catalog
-- Prices + B66.2b proposal-code Prices + B66.4 Portal schema + B66.5
-- dunning hooks into a real subscription created at redeem time. A1's
-- first redemption (and every proposal-code customer thereafter) flows
-- through this code path; admin issues code → customer redeems →
-- Stripe Subscription created (charge_automatically OR send_invoice).
--
-- This migration ships ONLY the SCHEMA layer (3 net-new columns on
-- proposal_codes). Code changes — start-billing route, webhook handler
-- extension, /signup/success metadata branch, redeem-flow wiring, and
-- tax_behavior fix on proposal-code Price creation (CP-1) — land in
-- the same commit but as separate file edits.
--
-- ── AUDIT-PASS RESULTS CONSUMED (Jose-run 2026-05-30, AP.A-E) ────────
-- AP.A: zero rows — collection_method does not exist on proposal_codes.
-- AP.B: existing CHECKs do not reference collection_method or included_*.
-- AP.C: confirms current column shape (lock_in_duration from B66.2b
--   present; no quantity columns).
-- AP.D: zero proposal-code Prices in production (Q4 lock holds —
--   tax_behavior fix in proposal-code-stripe.ts is forward-only,
--   no recreation needed).
-- AP.E: 3 redeemed/issued proposal_codes are confirmed test data
--   (SMOKEMAY17LEGACY / TESTPROP / SMOKEB654MAY17 — no real customer,
--   no Stripe linkage). Headed for pre-launch DB wipe.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. proposal_codes.collection_method TEXT NOT NULL
--        DEFAULT 'charge_automatically'
--        CHECK (collection_method IN ('charge_automatically','send_invoice'))
--
--      Per-code billing method, admin-set at issue time. NOT-NULL with
--      DEFAULT 'charge_automatically' means A1's code (issued via
--      existing /admin/proposal-codes/new with no UI change) defaults
--      to charge_automatically — A1's intent exactly. Admin UI
--      (dropdown to set send_invoice) deferred per greenlight; bridge
--      is a one-line SQL set on the code row.
--
--      send_invoice branch in start-billing route creates the
--      Subscription with collection_method='send_invoice' +
--      days_until_due=30 + default_tax_rates (TX); no payment method
--      required at redeem time. Per-policy: send_invoice unpaid-invoice
--      handling stays out of dunning code path (CP-2 backlog).
--
--   2. proposal_codes.included_properties INTEGER NULL
--        CHECK (included_properties IS NULL OR included_properties >= 0)
--      proposal_codes.included_drivers    INTEGER NULL
--        CHECK (included_drivers    IS NULL OR included_drivers    >= 0)
--
--      Quantity-model option γ per pre-flight: admin captures negotiated
--      property + driver counts at code creation. Read at redeem time;
--      passed as `quantity` on the corresponding Stripe Subscription
--      line item (per_property → included_properties; per_driver →
--      included_drivers; base always quantity=1).
--
--      Nullable because:
--        (a) PM-track codes legitimately have no per_driver line item
--            (Cluster 2.1); included_drivers stays NULL on PM codes.
--        (b) Existing pre-B66.7 codes (the 3 test rows in AP.E) have
--            no quantity context — NULL is the correct historical
--            value. Application reads at start-billing default-coalesce
--            to 1 if column is NULL.
--
--      >= 0 (not >= 1) because future flexibility — a code may
--      legitimately be issued with included_drivers=0 if the customer
--      genuinely starts with zero drivers and adds them post-redeem.
--      Application-level enforcement (start-billing route + admin form)
--      handles the "must have at least 1 property for enforcement
--      tracks" intent if needed.
--
--      Cross-track CHECK (PM cannot have included_drivers > 0)
--      intentionally NOT added at schema layer — application enforces
--      via proposal-code-stripe.ts existing pattern (line 156-161
--      throws ProposalStripeError on PM + custom_per_driver_fee).
--      Schema CHECK would duplicate that logic without adding safety
--      not already covered by the per_driver_fee guard.
--
-- ── DEPENDENCIES (verified via AP) ──────────────────────────────────
-- • proposal_codes table exists with base_tier_type / base_tier /
--   custom_*_fee / status (B65 + B66.2b).
-- • redeem_proposal_code RPC (B65.4 signature) returns BIGINT
--   company_id; called from /signup/redeem/verify after PKCE exchange.
--   B66.7 does NOT modify the RPC signature; the start-billing route
--   reads collection_method + included_* off proposal_codes directly
--   AFTER the RPC returns.
-- • stripe_prices table has proposal-code-attached rows (B66.2b).
--   start-billing route looks them up by proposal_code_id.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • Admin UI dropdown to set collection_method — deferred per
--   greenlight; A1's code defaults to 'charge_automatically'.
-- • B147 — billing-quantity sync on post-redeem add-property /
--   add-driver. Filed as separate revenue-leak backlog item; affects
--   ALL customers (self-serve + proposal-code), not B66.7 scope.
-- • Premium handling — Premium codes route around start-billing
--   entirely (manual invoice path per B89; collection_method DEFAULT
--   doesn't matter for them; included_* columns ignored).
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. BEGIN/COMMIT atomic — any
-- statement failing rolls back the entire migration. All DDL idempotent
-- (ADD COLUMN IF NOT EXISTS / DO $func$ IF NOT EXISTS guard for CHECK).
-- DO blocks use $func$ tagged dollar-quote per [[feedback-sql-editor-
-- dollar-quote-parsing]] to prevent the SQL Editor's tokenizer from
-- smart-splitting on inner `;`.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — proposal_codes.collection_method
-- ════════════════════════════════════════════════════════════════════
-- Per-code billing method, admin-set at issue. NOT-NULL DEFAULT
-- 'charge_automatically' means existing 3 test rows backfill cleanly
-- and A1's code defaults correctly without admin UI changes.

ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS collection_method TEXT NOT NULL
    DEFAULT 'charge_automatically';

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposal_codes_collection_method_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_collection_method_valid
      CHECK (collection_method IN ('charge_automatically','send_invoice'));
  END IF;
END $func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — proposal_codes.included_properties + included_drivers
-- ════════════════════════════════════════════════════════════════════
-- Quantity-model option γ. Admin captures at code creation; passed as
-- Stripe Subscription line-item quantity at redeem. Nullable to
-- accommodate PM-track (no per_driver line) and historical pre-B66.7
-- rows.

ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS included_properties INTEGER;

ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS included_drivers INTEGER;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposal_codes_included_properties_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_included_properties_valid
      CHECK (included_properties IS NULL OR included_properties >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposal_codes_included_drivers_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_included_drivers_valid
      CHECK (included_drivers IS NULL OR included_drivers >= 0);
  END IF;
END $func$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. All 3 columns present + types correct ────────────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'proposal_codes'
--     AND column_name IN ('collection_method', 'included_properties', 'included_drivers')
--   ORDER BY column_name;
--   -- Expected 3 rows:
--   --   collection_method     | text    | NO  | 'charge_automatically'::text
--   --   included_drivers      | integer | YES | (null)
--   --   included_properties   | integer | YES | (null)
--
-- ── B. All 3 CHECK constraints landed ───────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'proposal_codes'::regclass
--     AND conname IN (
--       'proposal_codes_collection_method_valid',
--       'proposal_codes_included_properties_valid',
--       'proposal_codes_included_drivers_valid'
--     )
--   ORDER BY conname;
--   -- Expected 3 rows with the corresponding CHECK definitions.
--
-- ── C. Existing 3 test rows backfilled cleanly ──────────────────────
--   SELECT code, status, collection_method, included_properties, included_drivers
--   FROM proposal_codes
--   ORDER BY id;
--   -- Expected: collection_method='charge_automatically' on all 3 rows
--   --           (DEFAULT applied at ALTER); included_* both NULL.
--
-- ── OPTIONAL NEGATIVE TESTS (destructive — dev/staging only) ────────
-- N1. collection_method invalid value rejected:
--   INSERT INTO proposal_codes (code, status, collection_method)
--   VALUES ('TEST-CM-INVALID', 'draft', 'invoice_via_carrier_pigeon');
--   -- Expected: CHECK violation on proposal_codes_collection_method_valid.
--
-- N2. included_properties negative rejected:
--   INSERT INTO proposal_codes (code, status, included_properties)
--   VALUES ('TEST-INC-NEG', 'draft', -1);
--   -- Expected: CHECK violation on proposal_codes_included_properties_valid.
--
-- N3. included_drivers negative rejected:
--   INSERT INTO proposal_codes (code, status, included_drivers)
--   VALUES ('TEST-DRV-NEG', 'draft', -5);
--   -- Expected: CHECK violation on proposal_codes_included_drivers_valid.
--
-- N4. Zero values accepted (CHECK is >= 0, not >= 1):
--   INSERT INTO proposal_codes (code, status, included_properties, included_drivers)
--   VALUES ('TEST-ZERO', 'draft', 0, 0);
--   -- Expected: succeeds. Clean up.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent: ADD COLUMN IF NOT EXISTS + DO $func$ IF NOT
-- EXISTS guards. BEGIN/COMMIT atomic; any statement failing rolls
-- back the entire migration. Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════
