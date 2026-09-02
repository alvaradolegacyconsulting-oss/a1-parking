-- ══════════════════════════════════════════════════════════════════════
-- verify-stripe-catalog-post-run.sql
--
-- Post-run verification for create-stripe-prices.ts (v3 amended for
-- pm_starter — 14 Prices / 7 Products expected).
--
-- Not a migration; not paired. Copy-paste into Supabase SQL Editor
-- after Jose's live (or test) run. Each block returns rows for the
-- human to eyeball; no RAISE/PASS gating.
--
-- Run each SECTION separately; results tell you if the catalog is
-- shaped correctly.
-- ══════════════════════════════════════════════════════════════════════

-- ── §1 — 14-row breakdown by tier + line_item ──────────────────────
-- EXPECT: 14 rows total:
--   6 pm_only         (base + per_property + per_permit, monthly + annual)
--   4 enforcement_only (base + per_property, monthly + annual)
--   4 pm_starter      (base + per_permit, monthly + annual — NO per_property)
--
-- Change `mode='live'` to `mode='test'` when eyeballing a test run.
SELECT
  tier_track,
  tier_name,
  line_item,
  cycle,
  price_model,
  unit_amount_cents,
  (tiers IS NOT NULL) AS has_tiers,
  lookup_key,
  stripe_price_id
FROM public.stripe_prices
WHERE proposal_code_id IS NULL
  AND mode = 'live'   -- CHANGE TO 'test' FOR TEST-MODE VERIFICATION
ORDER BY tier_name, line_item, cycle;

-- ── §2 — Count sanity: totals per tier ─────────────────────────────
-- EXPECT: pm_only=6, enforcement_only=4, pm_starter=4, total=14
SELECT tier_name, COUNT(*) AS row_count
FROM public.stripe_prices
WHERE proposal_code_id IS NULL AND mode = 'live'
GROUP BY tier_name
ORDER BY tier_name;

-- ── §3 — pm_starter has NO per_property axis ───────────────────────
-- EXPECT: 0 rows. Starter is one property by definition (cap sequence
-- A→A₀); a per_property Price would be dead config.
SELECT COUNT(*) AS unexpected_starter_per_property
FROM public.stripe_prices
WHERE tier_name = 'pm_starter'
  AND line_item = 'per_property'
  AND mode = 'live';

-- ── §4 — pm_starter per_permit is graduated with $0 first band ─────
-- EXPECT: 2 rows (monthly + annual), each price_model='graduated',
-- unit_amount_cents=NULL, tiers[0].unit_amount=0, tiers[0].up_to=500,
-- tiers[1].unit_amount=125 (monthly) OR 1250 (annual, ×10 multiplier),
-- tiers[1].up_to=NULL.
SELECT
  cycle,
  price_model,
  unit_amount_cents,
  tiers->0 AS first_band,
  tiers->1 AS second_band,
  stripe_price_id
FROM public.stripe_prices
WHERE tier_name = 'pm_starter'
  AND line_item = 'per_permit'
  AND mode = 'live'
ORDER BY cycle;

-- ── §5 — Enforcement Track has no per_permit rows ──────────────────
-- EXPECT: 0. Slice 1 Commit 1's permit_pm_only CHECK enforces this;
-- sanity check the script honored it.
SELECT COUNT(*) AS unexpected_enforcement_per_permit
FROM public.stripe_prices
WHERE tier_track = 'enforcement'
  AND line_item = 'per_permit'
  AND mode = 'live';

-- ── §6 — Product count: 7 distinct Stripe Products ─────────────────
-- EXPECT: 7. Pattern B — monthly + annual share a Product per group.
--   3 for pm_only (base, per_property, per_permit)
--   2 for enforcement_only (base, per_property)
--   2 for pm_starter (base, per_permit)
SELECT COUNT(DISTINCT stripe_product_id) AS product_count
FROM public.stripe_prices
WHERE proposal_code_id IS NULL AND mode = 'live';

-- ── §7 — All rows are is_active=true (no accidental archives) ──────
-- EXPECT: 14 active, 0 inactive.
SELECT is_active, COUNT(*) AS row_count
FROM public.stripe_prices
WHERE proposal_code_id IS NULL AND mode = 'live'
GROUP BY is_active;

-- ── §8 — All rows carry v3 lookup_key ──────────────────────────────
-- EXPECT: 14 rows ending in .v3. Any .v1 or .v2 → migration artifact
-- the script should have UPDATEd; investigate.
SELECT
  CASE
    WHEN lookup_key LIKE '%.v3' THEN 'v3'
    WHEN lookup_key LIKE '%.v2' THEN 'v2 (STALE — investigate)'
    WHEN lookup_key LIKE '%.v1' THEN 'v1 (STALE — investigate)'
    ELSE 'unknown'
  END AS lookup_version,
  COUNT(*) AS row_count
FROM public.stripe_prices
WHERE proposal_code_id IS NULL AND mode = 'live'
GROUP BY lookup_version;

-- ══════════════════════════════════════════════════════════════════════
-- STRIPE DASHBOARD SANITY CHECKS (not in SQL — do these in Stripe UI):
--
-- 1. "ShieldMyLot PM Starter — Base" Product exists
-- 2. "ShieldMyLot PM Starter — Per-Permit (Graduated)" Product exists
-- 3. Open the pm_starter per-permit MONTHLY Price. Its pricing display
--    should show TWO tiers:
--      • 0–500 permits @ $0.00 per permit  ← the included allowance
--      • 501+ permits  @ $1.25 per permit  ← the overage
-- 4. Open the pm_starter per-permit ANNUAL Price. Same TWO tiers but
--    band 2 rate is $12.50 (monthly × 10 ANNUAL_MULTIPLIER).
-- 5. tax_code = "txcd_10103001" (SaaS) on every new Product — Stripe
--    Tax handles Texas Rule 3.330 80% basis automatically.
-- ══════════════════════════════════════════════════════════════════════
