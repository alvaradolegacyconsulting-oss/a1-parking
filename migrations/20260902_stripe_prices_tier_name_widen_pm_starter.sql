-- ══════════════════════════════════════════════════════════════════════
-- 20260902_stripe_prices_tier_name_widen_pm_starter.sql
--
-- 🔴 Bar-2 launch prep §2-script PREREQUISITE — surfaced by test-mode
--    rehearsal Sep 2 2026.
--
-- Widens the stripe_prices.tier_name CHECK to include 'pm_starter'.
-- Without this, the amended create-stripe-prices.ts fails on the FIRST
-- pm_starter DB INSERT with 23514, leaving an orphaned Stripe Product/
-- Price. Rehearsal caught it — Jose's live run would have hit the
-- identical failure on the same address.
--
-- ── HISTORY ─────────────────────────────────────────────────────────
--
-- 2026-05-30 (20260530_b66_2a_stripe_prices_table.sql:112-113):
--   Initial CHECK — 6 values matching v1 6-tier flat catalog:
--     ('starter','growth','legacy','essential','professional','enterprise')
--
-- 2026-06-26 (20260626_stripe_prices_3tier_per_permit.sql:109-112):
--   Narrowed to the 3 self-serve tier values that survived the June 24
--   pricing pivot: ('pm_only','enforcement_only','legacy'). PM Starter
--   didn't exist yet.
--
-- 2026-09-02 (THIS FILE):
--   Widens to 4 values by adding 'pm_starter'. Cap sequence A₀ widens
--   companies_tier_valid on the parallel path — same tier, two
--   different tables' CHECKs. Both are needed before any pm_starter
--   Price row lands or any pm_starter Company row lands.
--
-- ── APPLY ORDER ────────────────────────────────────────────────────
--
-- BEFORE re-running create-stripe-prices.ts in either mode.
-- Independent of Cap Commits A/B/C/A₀ — the stripe_prices CHECK is
-- unrelated to the companies CHECK. Can apply this in parallel with
-- Cap Commit A (already shipped 7b67ff8) without ordering concern.
-- Ordering only matters vs the Stripe script itself.
--
-- ── VALUES ─────────────────────────────────────────────────────────
--
-- Post-apply set: ('pm_only','enforcement_only','legacy','pm_starter').
-- No values dropped — existing pm_only/enforcement_only/legacy rows
-- unaffected. VS5 in the paired verification asserts by counting
-- them before and after.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Drop + re-add CHECK ────────────────────────────────────
-- Postgres CHECK constraints are immutable; the shape is DROP + ADD.
-- Same pattern as 20260626 did when narrowing 6→3.
ALTER TABLE public.stripe_prices DROP CONSTRAINT stripe_prices_tier_name_valid;

ALTER TABLE public.stripe_prices ADD CONSTRAINT stripe_prices_tier_name_valid
  CHECK (tier_name IN ('pm_only','enforcement_only','legacy','pm_starter'));

-- ── PART 2 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_STRIPE_PRICES_TIER_NAME_WIDEN',
  'public.stripe_prices',
  'tier_name_widen_pm_starter',
  jsonb_build_object(
    'migration',       '20260902_stripe_prices_tier_name_widen_pm_starter',
    'arc',             'Bar-2 launch prep §2-script PREREQUISITE — enable pm_starter Price rows',
    'surfaced_by',     'Test-mode rehearsal of amended create-stripe-prices.ts Sep 2 2026 — first pm_starter.base.monthly INSERT failed 23514; Stripe Price price_1UBKLG3UC9fdqhGiYhcaBSTO was created live in TEST mode and left orphaned pending recovery on next script run',
    'before',          jsonb_build_array('pm_only','enforcement_only','legacy'),
    'after',           jsonb_build_array('pm_only','enforcement_only','legacy','pm_starter'),
    'delta',           'ADDED pm_starter (self-serve $149 flat, one-property capped)',
    'not_dropped',     'pm_only + enforcement_only + legacy all preserved — existing rows unaffected',
    'blocks_unblock',  'Enables amended create-stripe-prices.ts to write 4 new pm_starter rows (base × 2 cycles + per_permit × 2 cycles); orphaned Stripe TEST Product recovers via lookup_key idempotency on re-run',
    'parallel_arc',    'Cap Commit A₀ (20260901 arc) widens companies_tier_valid for the same tier — different table, different CHECK, both required for pm_starter to exist end-to-end'
  ),
  now()
);

-- ── PART 3 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
