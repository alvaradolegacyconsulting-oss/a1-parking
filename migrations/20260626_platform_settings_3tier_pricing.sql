-- ════════════════════════════════════════════════════════════════════
-- Billing Slice 1 / Commit 2 (Part A) — platform_settings 3-tier rebuild
--                          (15 old 6-tier price_* cols → 5 new 3-tier cols)
-- Date:   2026-06-26
-- Branch: billing/slice1-commit2-platform-settings-3tier
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Second commit of the June 24 pricing pivot. Commit 1 rebuilt the
-- stripe_prices table schema; this commit replaces the
-- platform_settings pricing-knobs surface (the admin Pricing tab's
-- read/write surface). Part A is this migration (DB); Part B (rewritten
-- admin/page.tsx Pricing tab) ships in the same commit AFTER this
-- migration is verified clean.
--
-- The 15 old price_* columns aren't in any prior migration — they were
-- dashboard-created via the admin UI's savePricing() upsert. So this
-- migration is the first time their schema is in source. The new 5
-- columns get the proper source-of-truth treatment.
--
-- 3 in-transaction parts:
--   1. DROP 15 old price_* columns (6-tier model, all NUMERIC nullable,
--      all values being replaced — captured below for the record).
--   2. ADD 5 new columns (4 NUMERIC dollars + 1 JSONB cents-inside).
--   3. Seed the 5 new columns with the locked Slice 1 spec values.
--
-- VALUES BEING DROPPED (captured 2026-06-26 from live; not preserved —
-- the column set is being replaced):
--   price_starter_base               = 129  (default was 99)   ← +30 custom
--   price_starter_per_property       = 15
--   price_starter_per_driver         = 10
--   price_growth_base                = 149
--   price_growth_per_property        = 12
--   price_growth_per_driver          = 8
--   price_legacy_base                = 199
--   price_legacy_per_property        = 10
--   price_legacy_per_driver          = 6
--   price_pm_essential_base          = 129  (default was 79)   ← +50 custom
--   price_pm_essential_per_property  = 20
--   price_pm_professional_base       = 199  (default was 129)  ← +70 custom
--   price_pm_professional_per_property = 15
--   price_pm_enterprise_base         = 279  (default was 179)  ← +100 custom
--   price_pm_enterprise_per_property = 10
--
-- 4 hand-tuned bases (starter/pm_essential/pm_professional/pm_enterprise)
-- reflect Jose's pricing experiments over time. Nothing to preserve —
-- the new 3-tier model uses different tier identities (pm_only at $179
-- doesn't map 1:1 to any old PM tier; enforcement_only at $199 happens
-- to equal old legacy_base but is structurally different).
--
-- UNIT CONVENTION (locked 2026-06-26):
--   - The 4 new flat columns store INTEGER DOLLARS in a NUMERIC type
--     (matches existing convention from script reader at
--     create-stripe-prices.ts:218-221 which multiplies by 100 to send
--     cents to Stripe).
--   - permit_tiers JSONB inner-band rates use rate_cents (integer cents)
--     because graduated rates need sub-dollar precision ($1.75 = 175
--     cents can't be expressed as integer dollars).
--   - The boundary: scalar flat columns = dollars; JSONB-array inner
--     fields = cents. Documented at both reader sites
--     (create-stripe-prices.ts in commit 3, app/admin/page.tsx in Part B
--     of this commit).
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   - All other columns on platform_settings survive untouched
--     (stripe_billing_enabled, public_signup_open, default_*).
--   - Single-row table (id=1) shape preserved — UPDATE keeps the row.
--   - No new tables → grant-footgun N/A.
--   - No functions touched → pg_proc untouched + overload-trap N/A.
--   - JSONB validation lives app-side (catalog script + admin Pricing
--     tab) per Jose's lean — no DB CHECK on permit_tiers shape.
--
-- DEPENDENCY ORDER
-- ────────────────
-- Part A (this migration) → eyeball → apply → DB trailer verifies clean
--   → Part B (app/admin/page.tsx Pricing tab rewrite) → tsc + build +
--   manual smoke (open admin Pricing tab, edit a flat + a permit band,
--   round-trip) → push as one commit.
--
-- Independent of commit 1 (stripe_prices). Independent of commit 3
-- (catalog script — only changes which columns it reads). The Pricing
-- tab CANNOT be left wired to the old columns after this migration
-- applies; the rewrite ships in the same commit by necessity.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — DROP 15 old 6-tier price_* columns
-- ════════════════════════════════════════════════════════════════════
-- All 15 confirmed present in production (Jose 2026-06-26 query against
-- information_schema.columns). All NUMERIC, all NULLABLE, all with the
-- values listed in the header docstring.

ALTER TABLE public.platform_settings
  DROP COLUMN price_starter_base,
  DROP COLUMN price_starter_per_property,
  DROP COLUMN price_starter_per_driver,
  DROP COLUMN price_growth_base,
  DROP COLUMN price_growth_per_property,
  DROP COLUMN price_growth_per_driver,
  DROP COLUMN price_legacy_base,
  DROP COLUMN price_legacy_per_property,
  DROP COLUMN price_legacy_per_driver,
  DROP COLUMN price_pm_essential_base,
  DROP COLUMN price_pm_essential_per_property,
  DROP COLUMN price_pm_professional_base,
  DROP COLUMN price_pm_professional_per_property,
  DROP COLUMN price_pm_enterprise_base,
  DROP COLUMN price_pm_enterprise_per_property;


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — ADD 5 new 3-tier columns
-- ════════════════════════════════════════════════════════════════════
-- 4 flat NUMERIC (dollars) + 1 JSONB (rate_cents inside per the
-- documented unit split). All nullable so seeding is a separate step
-- (avoids a DEFAULT that would pin the seed value into the column
-- definition and obscure the data-side intent).

ALTER TABLE public.platform_settings
  ADD COLUMN price_pm_only_base                NUMERIC,
  ADD COLUMN price_pm_only_per_property        NUMERIC,
  ADD COLUMN price_enforcement_only_base       NUMERIC,
  ADD COLUMN price_enforcement_only_per_property NUMERIC,
  ADD COLUMN permit_tiers                      JSONB;


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Seed the 5 new columns
-- ════════════════════════════════════════════════════════════════════
-- Slice 1 locked spec values (test catalog; tunable before live flip
-- via the rebuilt admin Pricing tab in Part B).
--
-- permit_tiers shape:
--   [
--     {"up_to": 50,   "rate_cents": 200},   -- 1-50    @ $2.00 / permit
--     {"up_to": 200,  "rate_cents": 175},   -- 51-200  @ $1.75 / permit
--     {"up_to": 500,  "rate_cents": 150},   -- 201-500 @ $1.50 / permit
--     {"up_to": null, "rate_cents": 125}    -- 501+    @ $1.25 / permit
--   ]
-- Ascending up_to, exactly one trailing null (= ∞), positive rates.
-- Validation enforced app-side (catalog script + admin tier editor).

UPDATE public.platform_settings
   SET price_pm_only_base                  = 179,
       price_pm_only_per_property          = 20,
       price_enforcement_only_base         = 199,
       price_enforcement_only_per_property = 15,
       permit_tiers = '[
         {"up_to": 50,   "rate_cents": 200},
         {"up_to": 200,  "rate_cents": 175},
         {"up_to": 500,  "rate_cents": 150},
         {"up_to": null, "rate_cents": 125}
       ]'::jsonb
 WHERE id = 1;


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Migration audit row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_COLUMNS_REPLACED',
  'platform_settings',
  NULL,
  jsonb_build_object(
    'migration',  '20260626_platform_settings_3tier_pricing',
    'slice',      'billing slice 1 commit 2 part A',
    'columns_dropped', jsonb_build_array(
      'price_starter_base', 'price_starter_per_property', 'price_starter_per_driver',
      'price_growth_base',  'price_growth_per_property',  'price_growth_per_driver',
      'price_legacy_base',  'price_legacy_per_property',  'price_legacy_per_driver',
      'price_pm_essential_base',    'price_pm_essential_per_property',
      'price_pm_professional_base', 'price_pm_professional_per_property',
      'price_pm_enterprise_base',   'price_pm_enterprise_per_property'
    ),
    'columns_added', jsonb_build_array(
      'price_pm_only_base NUMERIC (dollars)',
      'price_pm_only_per_property NUMERIC (dollars)',
      'price_enforcement_only_base NUMERIC (dollars)',
      'price_enforcement_only_per_property NUMERIC (dollars)',
      'permit_tiers JSONB (rate_cents inside; graduated bands)'
    ),
    'old_values_dropped', jsonb_build_object(
      'price_starter_base', 129, 'price_starter_per_property', 15, 'price_starter_per_driver', 10,
      'price_growth_base',  149, 'price_growth_per_property',  12, 'price_growth_per_driver',  8,
      'price_legacy_base',  199, 'price_legacy_per_property',  10, 'price_legacy_per_driver',  6,
      'price_pm_essential_base',    129, 'price_pm_essential_per_property',    20,
      'price_pm_professional_base', 199, 'price_pm_professional_per_property', 15,
      'price_pm_enterprise_base',   279, 'price_pm_enterprise_per_property',   10
    ),
    'seed_values', jsonb_build_object(
      'price_pm_only_base', 179, 'price_pm_only_per_property', 20,
      'price_enforcement_only_base', 199, 'price_enforcement_only_per_property', 15,
      'permit_tiers', '4-band graduated [1-50@$2.00, 51-200@$1.75, 201-500@$1.50, 501+@$1.25]'
    ),
    'unit_convention', 'flat scalar columns = dollars (NUMERIC); permit_tiers inner rate_cents = cents (integer); boundary documented in catalog script + admin Pricing tab',
    'overload_trap',  'N/A (no functions changed)',
    'grant_footgun',  'N/A (no new tables)'
  ),
  now()
);

COMMIT;
