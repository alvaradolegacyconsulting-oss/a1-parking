-- ════════════════════════════════════════════════════════════════════
-- Billing Slice 1 / Commit 1 — stripe_prices schema rebuild
--                              (6-tier flat → 3-tier + per-permit graduated)
-- Date:   2026-06-26
-- Branch: billing/slice1-commit1-stripe-prices-3tier
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- First commit of the June 24 pricing pivot. The old 6-tier flat model
-- (Starter/Growth/Legacy + Essential/Professional/Enterprise; base +
-- per-property + per-driver) is being replaced with 3 tiers (PM-Only,
-- Enforcement-Only self-serve + Legacy negotiated-only) and a new
-- graduated per-permit meter line item (PM-Only exclusive). This commit
-- ONLY changes the stripe_prices schema + clears the table. Subsequent
-- commits handle: platform_settings + admin Pricing tab (commit 2),
-- the catalog script rewrite + Stripe Dashboard archive (commit 3),
-- quantity-sync 'permit' kind + driver-sync gate (commit 4), and
-- tier-config/B141/companies.tier CHECK + retire changeTier (commit 5).
--
-- 5 changes in one transaction:
--   1. Clear stripe_prices — all rows are test/dev disposable per Jose
--      2026-06-26 confirmation (incl. the lone mode='live' row 35).
--      Clearing FIRST guarantees the tightened CHECKs in steps 2-4
--      can't be blocked by a constraint-violating survivor.
--   2. tier_name CHECK 6→3: DROP existing + ADD with the new 3-value
--      enum {pm_only, enforcement_only, legacy}. Legacy stays in the
--      set even though no standard catalog rows will exist for it —
--      negotiated proposals carry tier_name='legacy'.
--   3. line_item CHECK +1: DROP existing + ADD per_permit. Keep
--      per_driver in the set for back-compat (retired from new
--      creation in commit 4, not from the constraint).
--   4. New constraint stripe_prices_permit_pm_only — mirror of the
--      existing stripe_prices_driver_enforcement_only pattern. Binds
--      per_permit structurally to the PM track (no possibility of an
--      enforcement row carrying a permit line).
--   5. Graduated price storage: ADD price_model TEXT (flat|graduated)
--      + tiers JSONB; ALTER unit_amount_cents to NULLABLE. Flat rows
--      keep unit_amount_cents + tiers=NULL; graduated rows set
--      tiers=<jsonb> + leave unit_amount_cents=NULL.
--
-- ╔══════════════════════════════════════════════════════════╗
-- ║ ⚠⚠⚠ KEEP IN SYNC: stripe_prices_driver_enforcement_only ║
-- ║                  AND stripe_prices_permit_pm_only       ║
-- ║                                                          ║
-- ║ These two constraints mirror the same shape:             ║
-- ║   line_item <> X OR tier_track = Y                       ║
-- ║                                                          ║
-- ║ If a future line_item is added that's track-exclusive,   ║
-- ║ add a parallel constraint. The pattern is:               ║
-- ║   per_driver = enforcement-only  (b66.2a)                ║
-- ║   per_permit = property-management-only (this commit)    ║
-- ║                                                          ║
-- ║ Section B of verification regex-checks both constraints  ║
-- ║ are present + Section E behaviorally proves the          ║
-- ║ permit_pm_only constraint fires on the wrong track.      ║
-- ╚══════════════════════════════════════════════════════════╝
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   - 2 partial UNIQUE indexes (..._standard WHERE proposal_code_id
--     IS NULL, ..._proposal WHERE proposal_code_id IS NOT NULL)
--     SURVIVE untouched — they reference (tier_track, tier_name,
--     line_item, cycle, mode), no changed column-value references.
--   - stripe_prices_tier_track_valid CHECK ('enforcement',
--     'property_management') survives — unaffected.
--   - stripe_prices_driver_enforcement_only survives — unaffected
--     (per_driver still valid; constraint still enforces enf-track-only).
--   - stripe_prices_cycle_valid + stripe_prices_mode_valid survive.
--   - proposal_code_id column + FK survive (ON DELETE RESTRICT only
--     restricts deleting parent proposal_codes that still have child
--     prices; deleting child prices is unblocked).
--   - No new tables → grant-footgun N/A.
--   - No functions touched → pg_proc untouched + overload-trap N/A.
--
-- APPLY DISCIPLINE
-- ────────────────
--   1. Eyeball this file
--   2. Paste as single block in SQL Editor (single-paste discipline
--      per [[feedback-sql-editor-partial-apply]]; BEGIN/COMMIT block
--      ensures all-or-nothing)
--   3. Run companion verification file 20260626_stripe_prices_3tier_
--      per_permit_verification.sql — expect Sections A-F all green
--   4. On clean trailer → push commit → proceed to commit 2
--      (platform_settings + admin Pricing tab)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Clear stripe_prices (all rows disposable per Jose 2026-06-26)
-- ════════════════════════════════════════════════════════════════════
-- proposal_code_id FK is ON DELETE RESTRICT but RESTRICT only blocks
-- deleting parent proposal_codes when child prices exist; deleting
-- child prices is unrestricted. Orphaned test proposal_codes are
-- irrelevant here — they ride the pre-launch wipe.

DELETE FROM public.stripe_prices;


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — tier_name CHECK: 6 values → 3 values
-- ════════════════════════════════════════════════════════════════════
-- DROP+ADD (never ALTER) per project discipline. The old 6-value set
-- ('starter','growth','legacy','essential','professional','enterprise')
-- is replaced with the new 3-value set ('pm_only','enforcement_only',
-- 'legacy'). Legacy stays — negotiated proposals carry tier_name='legacy'
-- even though no standard catalog rows are created for it.

ALTER TABLE public.stripe_prices DROP CONSTRAINT stripe_prices_tier_name_valid;

ALTER TABLE public.stripe_prices ADD CONSTRAINT stripe_prices_tier_name_valid
  CHECK (tier_name IN ('pm_only','enforcement_only','legacy'));


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — line_item CHECK: add 'per_permit' (4 values total)
-- ════════════════════════════════════════════════════════════════════
-- DROP+ADD. New set is {base, per_property, per_driver, per_permit}.
-- per_driver stays as a VALID value (back-compat — existing
-- driver-sync call sites will be gated in commit 4, but the constraint
-- shouldn't reject a per_driver row if one ever appears via legacy
-- code paths). per_permit is the new graduated meter line item.

ALTER TABLE public.stripe_prices DROP CONSTRAINT stripe_prices_line_item_valid;

ALTER TABLE public.stripe_prices ADD CONSTRAINT stripe_prices_line_item_valid
  CHECK (line_item IN ('base','per_property','per_driver','per_permit'));


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Track-exclusivity for per_permit (mirrors driver_enforcement_only)
-- ════════════════════════════════════════════════════════════════════
-- Structurally binds per_permit to the PM track. Mirrors the existing
-- stripe_prices_driver_enforcement_only pattern (driver → enf-only,
-- permit → pm-only). Section E of verification behaviorally proves
-- this constraint fires by attempting to INSERT a permit row on an
-- enforcement track + asserting the expected exception.

ALTER TABLE public.stripe_prices ADD CONSTRAINT stripe_prices_permit_pm_only
  CHECK (line_item <> 'per_permit' OR tier_track = 'property_management');


-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Graduated price storage (price_model + tiers + nullable unit_amount_cents)
-- ════════════════════════════════════════════════════════════════════
-- Flat rows: price_model='flat', tiers=NULL, unit_amount_cents=<cents>.
-- Graduated rows: price_model='graduated', tiers=<jsonb array>,
--                 unit_amount_cents=NULL.
--
-- Tiers JSONB shape (ascending up_to, last band has up_to=null = ∞):
--   [
--     {"up_to": 50,   "rate_cents": 200},
--     {"up_to": 200,  "rate_cents": 175},
--     {"up_to": 500,  "rate_cents": 150},
--     {"up_to": null, "rate_cents": 125}
--   ]
-- Validation lives app-side (catalog script + admin Pricing tab) per
-- Jose's lean — no DB CHECK on JSONB shape (over-engineering for one
-- row, and JSONB CHECKs are fiddly to express correctly).
--
-- DEFAULT 'flat' so every existing flat row added after this migration
-- is unambiguous without callers having to remember to set price_model.

ALTER TABLE public.stripe_prices
  ADD COLUMN price_model TEXT NOT NULL DEFAULT 'flat'
    CHECK (price_model IN ('flat','graduated'));

ALTER TABLE public.stripe_prices
  ADD COLUMN tiers JSONB;

ALTER TABLE public.stripe_prices
  ALTER COLUMN unit_amount_cents DROP NOT NULL;


-- ════════════════════════════════════════════════════════════════════
-- PART 6 — Migration audit row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_TABLE_REBUILT',
  'stripe_prices',
  NULL,
  jsonb_build_object(
    'migration',  '20260626_stripe_prices_3tier_per_permit',
    'slice',      'billing slice 1 commit 1',
    'cleared',    'all rows (test/dev disposable per Jose 2026-06-26)',
    'constraints_changed', jsonb_build_array(
      'stripe_prices_tier_name_valid: 6 values → 3 (pm_only, enforcement_only, legacy)',
      'stripe_prices_line_item_valid: 3 values → 4 (added per_permit)',
      'stripe_prices_permit_pm_only: NEW (mirror of driver_enforcement_only for PM track)'
    ),
    'columns_added', jsonb_build_array(
      'price_model TEXT NOT NULL DEFAULT ''flat'' CHECK IN (flat, graduated)',
      'tiers JSONB (nullable; graduated rows only)'
    ),
    'columns_altered', jsonb_build_array(
      'unit_amount_cents NOT NULL → NULLABLE (graduated rows have no single amount)'
    ),
    'preserved', 'tier_track CHECK + cycle CHECK + mode CHECK + driver_enforcement_only CHECK + 2 partial UNIQUEs + proposal_code_id FK',
    'overload_trap', 'N/A (no functions changed)',
    'grant_footgun', 'N/A (no new tables)'
  ),
  now()
);

COMMIT;
