-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_a0_widen_companies_tier_valid.sql
--
-- 🟢 Cap sequence Commit A₀ of 4 (A → B → C → A₀) — LAST
--
-- Per Mateo Sep 1 §1. Widens companies_tier_valid CHECK to include
-- 'pm_starter'. This is what makes a pm_starter company POSSIBLE.
-- Everything else in the sequence (A/B/C) was standing in wait: A
-- named pm_starter as dead code, B made ELSE loud so drift can't
-- silently pass, C added the reactivation cap check that becomes
-- load-bearing the moment pm_starter tenants exist.
--
-- Build the enforcement, THEN open the door. This is the door.
--
-- ── COMMIT A₀ SEQUENCE POSITION ────────────────────────────────────
--
--     A (7b67ff8)   un-neuter helper, pm_starter dead branch
--     B (56cce2d)   ELSE → RAISE 'tier_unrecognized'
--     C (d278d47)   reactivation branch on enforce_property_limit
--   → A₀ (THIS)     widen companies_tier_valid to include pm_starter
--
-- ── HISTORY ─────────────────────────────────────────────────────────
--
-- 2026-06-26 (20260626_billing_slice1_commit5_tier_remap.sql:95-97):
--   ADD CONSTRAINT companies_tier_valid
--   CHECK (tier IN ('pm_only', 'enforcement_only', 'legacy'))
--
-- 2026-09-02 (THIS FILE):
--   Widens to 4 values: pm_only, enforcement_only, legacy, pm_starter.
--   Mirrors 20260902_stripe_prices_tier_name_widen_pm_starter.sql
--   (b151312 pending Jose apply) which widened the same tier list on
--   the stripe_prices table. Two parallel CHECKs; A₀ closes the
--   companies-table side.
--
-- ── VALUES ─────────────────────────────────────────────────────────
--
-- Post-apply: ('pm_only', 'enforcement_only', 'legacy', 'pm_starter').
-- No values dropped. Existing company rows unaffected (they all fall
-- into the 3 existing values); VS5 asserts counts preserved.
--
-- ── APPLY ORDER (final Cap sequence prerequisite for /signup) ──────
--
-- After this lands + is verified:
--   1. get_company_property_limit(pm_starter_company_name) returns 1
--      (the branch added in Commit A is now reachable)
--   2. Trigger enforce_property_limit on INSERT properties enforces
--      cap=1 for pm_starter tenants
--   3. Trigger property_limit_check_on_reactivation (Commit C)
--      enforces cap on reactivate too
--   4. Signup can offer PM Starter as a valid tier at self-serve
--
-- Blocks unblocked:
--   * /signup tier-picker rewrite (Bar-2 launch prep §5)
--   * public_signup_open flag flip
--
-- ── VERIFICATION LOAD-BEARING ──────────────────────────────────────
--
-- VS3 in paired verification INSERTS a pm_starter company + calls
-- the helper + asserts limit=1 — end-to-end verification of the
-- entire cap chain (A opens branch, B enforces named, C protects
-- reactivate, A₀ makes tier possible). If this passes, the four
-- commits together prove: pm_starter tenant creation is possible,
-- capped at 1 property, and the cap holds through create + reactivate.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — DROP + re-ADD CHECK ────────────────────────────────────
ALTER TABLE public.companies DROP CONSTRAINT companies_tier_valid;

ALTER TABLE public.companies ADD CONSTRAINT companies_tier_valid
  CHECK (tier IN ('pm_only', 'enforcement_only', 'legacy', 'pm_starter'));

-- ── PART 2 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_CAP_SEQUENCE_COMMIT_A0',
  'public.companies',
  'commit_a0_widen_companies_tier_valid',
  jsonb_build_object(
    'migration',       '20260902_cap_sequence_commit_a0_widen_companies_tier_valid',
    'arc',             'Cap sequence — Commit A₀ of 4 (A → B → C → A₀ — LAST)',
    'before',          jsonb_build_array('pm_only', 'enforcement_only', 'legacy'),
    'after',           jsonb_build_array('pm_only', 'enforcement_only', 'legacy', 'pm_starter'),
    'delta',           'ADDED pm_starter — self-serve $149/mo flat, one property (cap enforced by get_company_property_limit branch + property_limit_check + property_limit_check_on_reactivation triggers).',
    'unblocks',        jsonb_build_array(
      '/signup tier-picker rewrite (Bar-2 launch prep §5) — Starter is now a valid tier value the picker can send',
      'public_signup_open flag flip when everything else is ready'
    ),
    'parallel_check',  'stripe_prices_tier_name_valid widened in 20260902_stripe_prices_tier_name_widen_pm_starter (b151312). Both CHECKs required for pm_starter to exist end-to-end.',
    'sequence_close',  'Cap A un-neutered helper + added pm_starter dead branch. Cap B flipped ELSE→RAISE (drift-loud). Cap C added reactivation branch. A₀ opens the door. The four together: tenant can be created as pm_starter, capped at 1 property, cap survives deactivate/reactivate loop.'
  ),
  now()
);

-- ── PART 3 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
