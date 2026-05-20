-- ════════════════════════════════════════════════════════════════════
-- B89 Part 1 — Add 'premium' to proposal_codes_base_tier_valid CHECK
-- Drafted: May 20, 2026 — NOT YET APPLIED.
--
-- ── CONTEXT ─────────────────────────────────────────────────────────
-- B89 introduces Enforcement Premium as a 4th tier on the Enforcement
-- track, replacing the B55 "Enterprise-scale operations?" callout. PM
-- Enterprise stays untouched. Premium is contact-sales (no published
-- price); the admin proposal-code system is the operational path for
-- creating Premium customer accounts.
--
-- For the DB layer this means: proposal_codes.base_tier needs to
-- accept 'premium' as a valid value when base_tier_type='enforcement'.
-- The existing CHECK constraint (from migrations/20260510_proposal_codes_phase1.sql:46-47)
-- lists 'starter','growth','legacy','essential','professional','enterprise' —
-- 'premium' must be added.
--
-- ── PRE-APPLY VERIFICATION (Jose ran 2026-05-20) ────────────────────
-- 1. Customer count check — confirmed ZERO companies with
--    tier='enterprise' AND tier_type='enforcement'. E-clean path
--    confirmed empirically; no display-layer translation needed.
-- 2. Existing CHECK shape: companies.tier is unconstrained TEXT (no
--    CHECK to alter). Only proposal_codes_base_tier_valid needs the
--    extension.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Single-paste BEGIN/COMMIT (lesson from 4c733d5 partial-apply held).
-- Paste the entire block as ONE block, click Run ONCE. Postgres
-- doesn't allow direct ALTER on CHECK constraints — DROP + CREATE.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE proposal_codes
  DROP CONSTRAINT IF EXISTS proposal_codes_base_tier_valid;

ALTER TABLE proposal_codes
  ADD CONSTRAINT proposal_codes_base_tier_valid
  CHECK (base_tier IS NULL OR base_tier IN (
    'starter', 'growth', 'legacy', 'premium',
    'essential', 'professional', 'enterprise'
  ));

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- ── A. CHECK constraint allows the seven values ────────────────────
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'proposal_codes_base_tier_valid';
--   -- Expected: CHECK ((base_tier IS NULL) OR (base_tier = ANY
--   --   (ARRAY['starter'::text, 'growth'::text, 'legacy'::text,
--   --          'premium'::text, 'essential'::text, 'professional'::text,
--   --          'enterprise'::text])))
--
-- ── B. No existing rows violate the new constraint ─────────────────
-- (Confirmed pre-apply: no enforcement_enterprise rows exist; new
--  constraint is strictly additive so no existing row could be invalid.)
--   SELECT base_tier, COUNT(*)
--   FROM proposal_codes
--   GROUP BY base_tier
--   ORDER BY base_tier;
--   -- Expected: only the original 6 values + NULL, no 'premium' yet.
--
-- ── C. Smoke (dev only — creates a test code) ──────────────────────
-- DESTRUCTIVE in shared environments. Skip in production.
--   INSERT INTO proposal_codes (code, base_tier, base_tier_type, status)
--   VALUES ('TEST-PREMIUM-XYZ', 'premium', 'enforcement', 'draft');
--   -- Should succeed (CHECK accepts 'premium').
--   DELETE FROM proposal_codes WHERE code = 'TEST-PREMIUM-XYZ';
--
-- ── ROLLBACK ────────────────────────────────────────────────────────
-- If needed, restore the original CHECK without 'premium'. Apply as
-- single-paste BEGIN/COMMIT. NOTE: rollback fails (CHECK violation)
-- if any proposal_codes row with base_tier='premium' has been created
-- between B89 apply and rollback. Verify zero such rows before rolling
-- back, OR update those rows first.
--
--   BEGIN;
--   ALTER TABLE proposal_codes
--     DROP CONSTRAINT IF EXISTS proposal_codes_base_tier_valid;
--   ALTER TABLE proposal_codes
--     ADD CONSTRAINT proposal_codes_base_tier_valid
--     CHECK (base_tier IS NULL OR base_tier IN (
--       'starter', 'growth', 'legacy',
--       'essential', 'professional', 'enterprise'
--     ));
--   COMMIT;
-- ════════════════════════════════════════════════════════════════════
