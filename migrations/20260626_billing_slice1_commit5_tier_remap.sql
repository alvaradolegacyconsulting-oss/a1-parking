-- ════════════════════════════════════════════════════════════════════
-- Billing Slice 1 / Commit 5 — closes slice (3 changes in one tx)
-- Date:   2026-06-26
-- Branch: billing/slice1-commit5-tier-remap
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- 3 in-transaction parts that close the billing slice 1 schema work:
--
--   1. companies.tier — REMAP old 6-tier values to new 3-tier set,
--      THEN add the CHECK constraint that didn't exist before.
--      Data-FIRST ordering (same lesson as commit 1's table-clear-
--      before-CHECK-tighten): an existing row violating the new CHECK
--      fails the migration safely; Section A/B verification surfaces
--      what survived the remap.
--
--   2. get_company_property_limit() — NEUTER via CREATE OR REPLACE
--      (signature unchanged → NO overload trap fires). Always returns
--      -1 (unlimited). The enforce_property_limit() trigger STAYS in
--      place; it still reads proposal_codes.feature_overrides->>
--      'max_properties' for per-deal Legacy caps. Only the tier-
--      derived hardcoded caps go away — correct under new model where
--      billing is per-property, not capped.
--
--   3. proposal_codes.custom_per_permit_fee — ADD COLUMN NUMERIC
--      (dollars, nullable). Mirrors custom_base_fee + custom_per_
--      property_fee pattern. Proposal-code form writes this for
--      PM-Only custom deals (single flat $/permit, NOT graduated —
--      per Jose's locked Legacy permit shape decision). The Stripe-
--      side issue-time creation (proposal-code-stripe.ts wiring this
--      column into a flat per_permit Stripe Price) is DEFERRED to a
--      future commit; PM-Only custom proposals issued before that
--      wire-up will fall through to the standard graduated catalog
--      rate (interim acceptable per Jose 2026-06-26).
--
-- TIER REMAP MAPPING (Jose 2026-06-26 §0.1 confirmed against live data):
--   starter, growth → enforcement_only        (2 companies)
--   essential, professional, enterprise → pm_only  (2 companies)
--   legacy → legacy  (KEPT AS-IS, 10 companies — UAT exercises negotiated
--                     path; pre-launch wipe handles them later)
--   premium → legacy  (B89 contact-sales semantically = negotiated)
--   ELSE → unchanged (defensive; should be 0 rows under live data)
-- Result: all 14 companies in the new 3-value set; ADD CHECK succeeds.
--
-- ⚠ DO NOT TOUCH companies.tier_type. A legacy company with
-- tier_type='enforcement' is correct (tier_type records originating
-- track; new tier records billing model). Migration only touches the
-- `tier` column.
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   - companies.tier_type CHECK (enforcement | property_management)
--     survives unchanged.
--   - enforce_property_limit() trigger survives — function body change
--     only; the trigger keeps calling get_company_property_limit which
--     now returns -1 always; the proposal_codes.feature_overrides path
--     remains the per-deal override mechanism.
--   - proposal_codes table: ADD COLUMN only (existing custom_per_driver_
--     fee column KEPT for back-compat; new deals' form stops writing
--     it; full column drop is future cleanup).
--   - No new tables → grant-footgun N/A.
--   - get_company_property_limit signature UNCHANGED (still
--     (p_company_name TEXT) RETURNS INTEGER) → overload trap N/A
--     for CREATE OR REPLACE; Section D defensively verifies
--     pg_proc count = 1 anyway.
--
-- APPLY DISCIPLINE
-- ────────────────
--   1. Eyeball this file (esp. Part 1's CASE remap)
--   2. Section A pre-check (verify pre-state)
--   3. Apply single BEGIN/COMMIT paste
--   4. Sections B–F post-apply
--   5. On clean → app wiring ships in same commit → push closes slice 1
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — companies.tier remap + CHECK (DATA-FIRST ORDERING)
-- ════════════════════════════════════════════════════════════════════
-- Step 1a: remap data first. The new CHECK can't be added until
-- every existing row satisfies it. Step 1b adds the CHECK; if any
-- row still violates (shouldn't, per the CASE coverage), the ALTER
-- raises a check_violation and the whole transaction rolls back —
-- safe + auditable failure.

UPDATE public.companies SET tier = CASE
  WHEN tier IN ('starter','growth')                      THEN 'enforcement_only'
  WHEN tier IN ('essential','professional','enterprise') THEN 'pm_only'
  WHEN tier = 'legacy'                                    THEN 'legacy'
  WHEN tier = 'premium'                                   THEN 'legacy'
  ELSE tier
END;

ALTER TABLE public.companies
  ADD CONSTRAINT companies_tier_valid
  CHECK (tier IN ('pm_only', 'enforcement_only', 'legacy'));


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — get_company_property_limit() neuter (CREATE OR REPLACE)
-- ════════════════════════════════════════════════════════════════════
-- Signature UNCHANGED: (p_company_name TEXT) RETURNS INTEGER.
-- Body change only: always returns -1 (unlimited). The
-- enforce_property_limit() trigger continues to call this function
-- when no proposal_codes.feature_overrides->>'max_properties' is
-- set; the trigger reads -1 → returns NEW (no enforcement). The
-- override path (per-deal Legacy caps) is unaffected.

CREATE OR REPLACE FUNCTION public.get_company_property_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  -- Slice 1 Commit 5 (2026-06-26) — neutered. Under the new 3-tier
  -- model (PM-Only / Enforcement-Only / Legacy), there are NO hard
  -- property caps. Billing is per-property (commit 3 catalog), so the
  -- model is "pay for what you have" rather than "capped tiers".
  -- The function returns -1 unconditionally; the
  -- enforce_property_limit() trigger continues to read
  -- proposal_codes.feature_overrides->>'max_properties' FIRST for
  -- per-deal Legacy caps — only the tier-derived hard cap goes away.
  -- DO NOT add tier-based logic back unless commit 5+ pricing model
  -- explicitly introduces a self-serve capped tier.
  RETURN -1;
END;
$func$;

-- Grants on the function are unchanged by CREATE OR REPLACE (they
-- persist on the function identity, not the body). No REVOKE/GRANT
-- needed.


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — proposal_codes.custom_per_permit_fee ADD COLUMN
-- ════════════════════════════════════════════════════════════════════
-- NUMERIC dollars (nullable). Mirrors custom_base_fee +
-- custom_per_property_fee shape exactly. PM-Only custom proposals
-- write a single flat $/permit rate here; Legacy + Enforcement-Only
-- proposals leave NULL (no permit billing on those tiers per Jose's
-- locked decision).
--
-- Stripe-side issue-time creation (proposal-code-stripe.ts reading
-- this column to create a flat per_permit Stripe Price tagged with
-- the proposal_code_id) is DEFERRED to a future commit. Until then,
-- PM-Only custom proposals issued after this migration will store
-- the operator's intent in this column but won't have a per_permit
-- override at Stripe — the customer pays the standard graduated
-- catalog rate. Acceptable interim per Jose 2026-06-26.

ALTER TABLE public.proposal_codes
  ADD COLUMN custom_per_permit_fee NUMERIC;


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Migration audit row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_SLICE_CLOSE',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260626_billing_slice1_commit5_tier_remap',
    'slice',     'billing slice 1 commit 5 — closes slice',
    'parts',     jsonb_build_array(
      'companies.tier REMAPped (starter,growth→enforcement_only; essential,professional,enterprise→pm_only; legacy→legacy; premium→legacy) + companies_tier_valid CHECK ADDed',
      'get_company_property_limit() neutered to RETURN -1 (signature unchanged; no overload trap)',
      'proposal_codes.custom_per_permit_fee NUMERIC ADD COLUMN (dollars; nullable; mirrors custom_base_fee pattern; Stripe issue-time wire-up deferred)'
    ),
    'tier_remap_mapping', jsonb_build_object(
      'starter→enforcement_only',     true,
      'growth→enforcement_only',      true,
      'essential→pm_only',            true,
      'professional→pm_only',         true,
      'enterprise→pm_only',           true,
      'legacy→legacy',                'KEPT AS-IS for ongoing UAT',
      'premium→legacy',               true
    ),
    'invariants', jsonb_build_object(
      'companies_tier_type_valid_CHECK', 'UNCHANGED',
      'enforce_property_limit_trigger',  'UNCHANGED — still reads proposal_codes.feature_overrides first',
      'custom_per_driver_fee_column',    'KEPT for back-compat; new deals NULL it; column drop deferred'
    ),
    'overload_trap', 'N/A (CREATE OR REPLACE on unchanged signature)',
    'grant_footgun', 'N/A (no new tables)'
  ),
  now()
);

COMMIT;
