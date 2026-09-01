-- ══════════════════════════════════════════════════════════════════════
-- 20260901_platform_settings_pm_starter_pricing.sql
--
-- 🟢 Bar-2 launch prep — PM Starter Stripe-price seed columns
--
-- Per Mateo Sep 1 §2. Adds TWO NEW columns on platform_settings for
-- PM Starter pricing. Zero touches to existing tier columns.
--
-- ── 🔴 NEW COLUMNS, NOT REPURPOSED ──────────────────────────────────
-- price_pm_only_base + price_pm_only_per_property STAY. PM-Only is
-- still a live negotiated tier (proposal-code onboarded); making its
-- columns silently mean Starter is exactly the class of defect we
-- keep finding. Two audiences for the two number sets:
--   pm_only        → negotiated proposals (existing)
--   pm_starter     → self-serve $149/month (NEW)
--
-- ── 🔴 SEPARATE PERMIT SCHEDULE ─────────────────────────────────────
-- permit_tiers holds PM-Only's four-band $2.00 → $1.25 graduated
-- schedule. Starter's is TWO bands with a $0 first band:
--   0-500    @ $0.00 / permit  (included in $149)
--   501+     @ $1.25 / permit  (overage)
-- Different meter, different economic model — its own JSONB column.
--
-- ── UNIT CONVENTION (identical to permit_tiers) ────────────────────
--   - price_pm_starter_base       NUMERIC dollars (multiplied ×100 →
--                                 cents by create-stripe-prices.ts)
--   - starter_permit_tiers        JSONB with rate_cents inner fields
--                                 (integer cents; $0.00 = 0, $1.25 = 125)
--
-- ── NO PER-PROPERTY COLUMN ─────────────────────────────────────────
-- Starter is FLAT $149 for one property (hard limit enforced by cap
-- sequence Commits A → B → C → A₀). No per_property column because
-- the tier doesn't have per-property pricing.
--
-- ── APPLY ORDER ────────────────────────────────────────────────────
-- This migration first. Then Jose runs the create-stripe-prices
-- script (amended in a follow-up commit) that reads these columns.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — ADD 2 columns ─────────────────────────────────────────
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS price_pm_starter_base  NUMERIC,
  ADD COLUMN IF NOT EXISTS starter_permit_tiers   JSONB;

-- ── PART 2 — Seed ──────────────────────────────────────────────────
-- Mateo Sep 1 §2.2 locked values:
--   base = 149 (flat monthly)
--   permit schedule: 500 included @ $0.00, then $1.25 overage
--     [{"up_to": 500, "rate_cents": 0}, {"up_to": null, "rate_cents": 125}]
--
-- Ascending up_to, exactly one trailing null (= ∞), rate_cents ≥ 0
-- (relaxed from > 0 for the $0 first band). The catalog script's
-- graduatedTiers() validator needs to accept 0 for this band —
-- separate validator or a starter-specific path in the script. That
-- change ships with the script amendment (§2.4).
UPDATE public.platform_settings
   SET price_pm_starter_base = 149,
       starter_permit_tiers  = '[
         {"up_to": 500,  "rate_cents": 0},
         {"up_to": null, "rate_cents": 125}
       ]'::jsonb
 WHERE id = 1;

-- ── PART 3 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_PLATFORM_SETTINGS_PM_STARTER_PRICING',
  'public.platform_settings',
  'pm_starter_pricing',
  jsonb_build_object(
    'migration',      '20260901_platform_settings_pm_starter_pricing',
    'arc',            'Bar-2 launch prep — PM Starter Stripe-price seed columns',
    'schema_changes', jsonb_build_array(
      'ADDED price_pm_starter_base NUMERIC (flat dollars, no per-property)',
      'ADDED starter_permit_tiers JSONB (two bands: 0-500 @ $0.00 included, 501+ @ $1.25 overage)'
    ),
    'seeded_values',  jsonb_build_object(
      'price_pm_starter_base', 149,
      'starter_permit_tiers',  jsonb_build_array(
        jsonb_build_object('up_to', 500,  'rate_cents', 0),
        jsonb_build_object('up_to', NULL, 'rate_cents', 125)
      )
    ),
    'unit_convention', 'base = dollars (script ×100 → cents to Stripe); permit_tiers rate_cents = cents integer',
    'not_repurposed', 'price_pm_only_base + _per_property STAY — PM-Only is still a live negotiated tier via proposal codes',
    'next',           'create-stripe-prices.ts amendment: add pm_starter TierName, buildAddresses branch (base + per_permit only, NO per_property), flatPriceColumn mapping to price_pm_starter_base, graduatedTiers validator accepts rate_cents=0 for Starter first band, EXPECTED_TOTAL 10 → 14 (adds 4: base×2cycles + per_permit×2cycles)'
  ),
  now()
);

-- ── PART 4 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
