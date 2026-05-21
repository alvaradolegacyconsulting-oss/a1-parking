-- ════════════════════════════════════════════════════════════════════
-- B66.2a — Stripe standard Price catalog storage
-- Drafted: 2026-05-21 — NOT YET APPLIED.
--
-- Second commit of the B66 Stripe billing arc (table layer only; the
-- catalog-creation CLI script lands in a separate commit). Adds the
-- stripe_prices table that pairs Stripe-side Price object IDs with
-- our internal tier × line_item × cycle × mode addressing. B66.3+
-- self-serve signup will query this table to resolve a customer's
-- subscription line items into Stripe Price IDs.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. stripe_prices — new table with 11 data columns + 6 CHECKs +
--      1 UNIQUE composite + admin-all RLS + REVOKE-anon discipline.
--
-- ── DESIGN DECISIONS BAKED IN ───────────────────────────────────────
-- • Schema scope is standard catalog only. Proposal-code override
--   Price IDs are B66.2b territory — separate table or columns added
--   later, not folded in here (P6).
-- • tier_track CHECK uses 'enforcement' / 'property_management' to
--   match TierType in app/lib/tier-config.ts:14. No translation layer
--   in any consumer.
-- • tier_name CHECK lists 6 self-serveable tier values. 'premium' is
--   intentionally absent — Enforcement Premium is contact-sales per
--   B89, redeemed via proposal_codes path (B66.2b), no standard
--   Price object exists for it.
-- • Cross-CHECK stripe_prices_driver_enforcement_only encodes the
--   Cluster 2.1 invariant ('per_driver' line_item exists on
--   enforcement track only). Schema-layer guard against script bugs.
-- • Composite UNIQUE on (tier_track, tier_name, line_item, cycle, mode)
--   is the idempotency key for the CLI script. Two runs of
--   scripts/create-stripe-prices.ts cannot create duplicate rows for
--   the same logical address.
-- • mode CHECK ('test','live') matches stripe_events.mode (B66.1).
--   Catalog must track both modes because Stripe Price IDs are
--   distinct between test and live accounts (Cluster 1.2).
-- • RLS pattern mirrors stripe_events from B66.1: admin-all FOR ALL,
--   deliberate absence of all other policies. service_role bypasses
--   via BYPASSRLS. Broadening to authenticated SELECT lands when a
--   real reader appears (B66.3 / B66.4) — not preemptively.
-- • is_active BOOLEAN supports soft-deprecation when pricing changes.
--   Stripe Prices are immutable once created; new pricing = new row
--   with is_active=TRUE + old row flipped to FALSE. Lookups by
--   convention add WHERE is_active = TRUE.
-- • REVOKE ALL FROM PUBLIC, anon — standing discipline per
--   feedback_revoke_anon_default_on_new_tables.md. Generalizes B82's
--   function-grant pattern to tables.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Open the Supabase SQL Editor, paste this
-- entire file as ONE block, click Run ONCE. Do NOT run statement-by-
-- statement — that breaks BEGIN/COMMIT atomicity (lesson from 4c733d5).
-- If any statement fails, the entire transaction rolls back; safe to
-- re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — stripe_prices table
-- ════════════════════════════════════════════════════════════════════
-- Each row maps a unique (track, tier, line_item, cycle, mode) tuple
-- to a Stripe Price object ID. The CLI script populates this after
-- the migration applies; B66.2a ships the table empty.
--
-- Column notes:
--   stripe_price_id    — Stripe's price.id. UNIQUE — same Stripe Price
--                        cannot back two rows.
--   stripe_product_id  — Stripe's product.id (Pattern B: one Product
--                        per line-item type per tier; 15 Products
--                        backing 30 Prices). NOT UNIQUE — a Product
--                        backs both monthly + annual Prices.
--   tier_track         — 'enforcement' | 'property_management'.
--   tier_name          — 'starter' | 'growth' | 'legacy' (enforcement);
--                        'essential' | 'professional' | 'enterprise'
--                        (property_management). Premium omitted by design.
--   line_item          — 'base' | 'per_property' | 'per_driver'.
--                        per_driver only valid for enforcement (CHECK below).
--   cycle              — 'monthly' | 'annual'.
--   unit_amount_cents  — integer cents. Stripe's unit_amount field.
--                        Script multiplies platform_settings.price_*
--                        (dollars) by 100 before INSERT.
--   mode               — 'test' | 'live'. Stripe Price IDs are scoped
--                        per Stripe account; catalog tracks both.
--   lookup_key         — sml.<track>.<tier>.<line_item>.<cycle>.
--                        Used by the script for idempotency probing
--                        against Stripe before creating a new Price.
--                        Nullable for forward-compat (could be unset
--                        for a Price imported from elsewhere later).
--   is_active          — TRUE = current catalog member. FALSE =
--                        soft-deprecated (pricing changed; replaced by
--                        a newer row). Lookup queries filter on TRUE.

CREATE TABLE IF NOT EXISTS stripe_prices (
  id                BIGSERIAL PRIMARY KEY,
  stripe_price_id   TEXT NOT NULL UNIQUE,
  stripe_product_id TEXT NOT NULL,
  tier_track        TEXT NOT NULL,
  tier_name         TEXT NOT NULL,
  line_item         TEXT NOT NULL,
  cycle             TEXT NOT NULL,
  unit_amount_cents INTEGER NOT NULL,
  mode              TEXT NOT NULL,
  lookup_key        TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- CHECK constraints — value enums.
  CONSTRAINT stripe_prices_tier_track_valid
    CHECK (tier_track IN ('enforcement','property_management')),

  CONSTRAINT stripe_prices_tier_name_valid
    CHECK (tier_name IN ('starter','growth','legacy','essential','professional','enterprise')),

  CONSTRAINT stripe_prices_line_item_valid
    CHECK (line_item IN ('base','per_property','per_driver')),

  CONSTRAINT stripe_prices_cycle_valid
    CHECK (cycle IN ('monthly','annual')),

  CONSTRAINT stripe_prices_mode_valid
    CHECK (mode IN ('test','live')),

  -- Cross-CHECK: per_driver is enforcement-only (Cluster 2.1).
  -- Bulletproofs the invariant at the schema layer; trust-but-verify
  -- defense against script bugs that would otherwise create a PM
  -- per_driver Price.
  CONSTRAINT stripe_prices_driver_enforcement_only
    CHECK (line_item != 'per_driver' OR tier_track = 'enforcement'),

  -- Idempotency key for the CLI script. A single mode catalog has at
  -- most one row per logical address.
  CONSTRAINT stripe_prices_unique_combo
    UNIQUE (tier_track, tier_name, line_item, cycle, mode)
);

-- Index supporting the script's "what's already in the catalog?" probe
-- (filtered by mode at script-run time). Covers the common B66.3+
-- consumer pattern too: "give me the Price ID for (track, tier,
-- line_item, cycle, mode)" — covered by the UNIQUE composite index
-- Postgres builds for the constraint, no separate index needed.

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — RLS on stripe_prices
-- ════════════════════════════════════════════════════════════════════
-- Mirrors stripe_events (B66.1): admin-all FOR ALL, deliberate absence
-- of all other policies. service_role bypasses RLS via BYPASSRLS.
--
-- When B66.3 / B66.4 need authenticated reads for billing UI, expand
-- with a narrower SELECT policy at that time. Pre-emptive broadening
-- = scope creep.

ALTER TABLE stripe_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stripe_prices_admin_all" ON stripe_prices;
CREATE POLICY "stripe_prices_admin_all" ON stripe_prices
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- ── B82 discipline generalized to tables (standing pattern) ──────────
-- Per feedback_revoke_anon_default_on_new_tables.md, every new
-- public-schema table revokes anon explicitly. RLS gates effective
-- access today; the REVOKE removes the implicit GRANT drift surface
-- so the answer to "does anon have access?" is in-source rather than
-- "depends on the policy."
REVOKE ALL ON TABLE stripe_prices FROM PUBLIC;
REVOKE ALL ON TABLE stripe_prices FROM anon;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. stripe_prices columns ───────────────────────────────────────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'stripe_prices'
--   ORDER BY ordinal_position;
--   -- Expected: 12 columns in order — id, stripe_price_id,
--   --   stripe_product_id, tier_track, tier_name, line_item, cycle,
--   --   unit_amount_cents, mode, lookup_key, is_active, created_at.
--   -- is_active default = true; created_at default = now();
--   -- lookup_key is_nullable = YES; all others NO.
--
-- ── B. CHECK constraints exist ─────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'stripe_prices'::regclass
--   ORDER BY conname;
--   -- Expected 9 rows total:
--   --   stripe_prices_cycle_valid                CHECK (...)
--   --   stripe_prices_driver_enforcement_only    CHECK (...)
--   --   stripe_prices_line_item_valid            CHECK (...)
--   --   stripe_prices_mode_valid                 CHECK (...)
--   --   stripe_prices_pkey                       PRIMARY KEY (id)
--   --   stripe_prices_stripe_price_id_key        UNIQUE (stripe_price_id)
--   --   stripe_prices_tier_name_valid            CHECK (...)
--   --   stripe_prices_tier_track_valid           CHECK (...)
--   --   stripe_prices_unique_combo               UNIQUE (...)
--
-- ── C. Cross-CHECK actually enforces (negative test, optional) ─────
-- Attempts to insert an invalid PM per_driver row; should fail.
-- Run as service_role only.
--   INSERT INTO stripe_prices (
--     stripe_price_id, stripe_product_id, tier_track, tier_name,
--     line_item, cycle, unit_amount_cents, mode, lookup_key
--   ) VALUES (
--     'price_test_bad', 'prod_test_bad', 'property_management',
--     'essential', 'per_driver', 'monthly', 100, 'test', 'sml.bad'
--   );
--   -- Expected: ERROR — new row for relation "stripe_prices" violates
--   --   check constraint "stripe_prices_driver_enforcement_only"
--
-- ── D. RLS enabled ─────────────────────────────────────────────────
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'stripe_prices';
--   -- Expected: t
--
-- ── E. Single admin policy ─────────────────────────────────────────
--   SELECT polname, polcmd,
--          pg_get_expr(polqual, polrelid)     AS using_expr,
--          pg_get_expr(polwithcheck, polrelid) AS with_check_expr
--   FROM pg_policy WHERE polrelid = 'stripe_prices'::regclass
--   ORDER BY polname;
--   -- Expected exactly 1 row:
--   --   stripe_prices_admin_all  *  (get_my_role() = 'admin'::text)
--   --                               (get_my_role() = 'admin'::text)
--
-- ── F. anon has no table privileges; defaults retained for others ──
--   SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name = 'stripe_prices'
--   ORDER BY grantee, privilege_type;
--   -- Expected: NO rows with grantee='anon'.
--   -- Expected: authenticated + service_role each retain the full
--   --   default set (SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--   --   REFERENCES, TRIGGER).
--
-- ── G. Table is empty pre-script ───────────────────────────────────
--   SELECT COUNT(*) FROM stripe_prices;
--   -- Expected: 0. Script populates after migration applies.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL is idempotent (CREATE TABLE IF NOT EXISTS / DROP POLICY IF
-- EXISTS + CREATE POLICY / REVOKE is no-op when already revoked).
-- BEGIN/COMMIT atomic. Any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
