-- ════════════════════════════════════════════════════════════════════
-- B237 — Post-apply verification
-- Companion to 20260708_b237_proposal_codes_tier_check_widen.sql
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — base_tier CHECK now admits the canonical 3 + escape + history
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.proposal_codes'::regclass
  AND contype = 'c'
  AND conname LIKE '%base_tier%'
ORDER BY conname;
-- Expected 2 rows — both CHECKs are NULL-tolerant (IS NULL OR ...) so
-- the historical NULL|NULL row (1 row on 2026-07-08) still passes:
--   proposal_codes_base_tier_type_valid |
--     CHECK ((base_tier_type IS NULL) OR (base_tier_type = ANY
--       (ARRAY['enforcement'::text, 'property_management'::text])))
--   proposal_codes_base_tier_valid |
--     CHECK ((base_tier IS NULL) OR (base_tier = ANY
--       (ARRAY['pm_only'::text, 'enforcement_only'::text, 'legacy'::text,
--              'premium'::text, 'starter'::text, 'growth'::text,
--              'essential'::text, 'professional'::text, 'enterprise'::text])))


-- ── VQ.B — audit row landed
SELECT action, new_values->>'migration' AS migration, created_at
FROM public.audit_logs
WHERE action = 'SCHEMA_PROPOSAL_CODES_TIER_CHECK_WIDEN'
ORDER BY created_at DESC LIMIT 1;
-- Expected: 1 row, migration = '20260708_b237_proposal_codes_tier_check_widen'.


-- ── VQ.C — no existing rows violate either new CHECK
SELECT base_tier, base_tier_type, count(*)
FROM proposal_codes
GROUP BY base_tier, base_tier_type
ORDER BY base_tier, base_tier_type;
-- Expected: same distribution as pre-migration snapshot (30 rows on
-- 2026-07-08); all values admitted by the new CHECKs. No violations
-- (otherwise the DDL ADD would have thrown).


-- ── VQ.D — end-to-end smoke prompts (manual):
--
-- VQ.D.1 — Create-draft + issue a fresh PM-Only code.
--   Fill form: Base Tier Type = Property Management, Base Tier = PM-Only,
--   custom base ≥ $1, custom per-property ≥ $1 (DO NOT set custom per-permit;
--   per Bar-2 deferral it's captured but not Stripe-wired yet).
--   Click Create Draft → expect no CHECK violation.
--   Click Confirm Issue → expect the confirm dialog to show the correct
--   line count + "backed by the standard catalog Products for
--   property_management / pm_only" (Pattern B — non-Legacy).
--
-- VQ.D.2 — Create-draft + issue an Enforcement-Only code.
--   Fill form: Base Tier Type = Enforcement, Base Tier = Enforcement-Only,
--   custom base + per-property.
--   Same expectations: no CHECK violation, Pattern B issue.
--
-- VQ.D.3 — Legacy path regression check.
--   Fill a Legacy code (Enforcement track) — should still Pattern C
--   (per-code Product, "backed by 1 per-code Product created at issue time")
--   per B232.
--
-- VQ.D.4 — Redeem a PM-Only code (throwaway; cancel after).
--   Confirm the redeemed company lands with tier='pm_only', tier_type=
--   'property_management', account_state='active', and full PM entitlements
--   (Spaces tab visible, Visitors tab visible, per hasFeature).
