-- ══════════════════════════════════════════════════════════════════════
-- 20260901_cap_sequence_commit_a_un_neuter_helper.sql
--
-- 🟢 Cap sequence Commit A of 4 (A → B → C → A₀)
--
-- Per Mateo Sep 1 §1. Un-neuters public.get_company_property_limit()
-- with explicit CASE for all four tier values that currently exist
-- OR are about to exist. ELSE stays 'RETURN -1' in this commit —
-- zero behavior change against current data. Commit B flips ELSE to
-- RAISE.
--
-- ── HISTORY ─────────────────────────────────────────────────────────
--
-- 2026-05-08 (20260508_phase1_tier_enforcement.sql):
--   Original CASE: enforcement/starter=5, growth=15, legacy=-1;
--   pm/essential=3, professional=10, enterprise=-1; ELSE -1.
--   Live at that point.
--
-- 2026-06-26 (20260626_billing_slice1_commit5_tier_remap.sql):
--   NEUTERED to `RETURN -1;` unconditionally. Header comment said:
--     "DO NOT add tier-based logic back unless commit 5+ pricing
--      model explicitly introduces a self-serve capped tier."
--   That was a forward-reference to today.
--
-- 2026-09-01 (THIS FILE):
--   PM Starter IS that tier. Un-neutering with the current 3-tier
--   catalog + pm_starter (about to be added to companies_tier_valid
--   in Commit A₀). Every currently-live tier value returns -1 (no
--   behavior change against current data); pm_starter returns 1.
--
-- ── COMMIT A SEQUENCE POSITION ─────────────────────────────────────
--
--   → A (THIS)  un-neuter helper, explicit CASE, ELSE unchanged (-1)
--     B         flip ELSE to RAISE (still zero behavior change today)
--     C         BEFORE UPDATE OF is_active branch on
--               enforce_property_limit trigger (reactivation bypass)
--     A₀        widen companies_tier_valid CHECK for 'pm_starter'
--
-- Build the enforcement, then open the door. A₀ last — widening the
-- CHECK is what makes a pm_starter company POSSIBLE while the helper
-- is what makes it CAPPED.
--
-- ── LEGACY (A1) BRANCH — LOAD-BEARING ───────────────────────────────
--
-- 🔴 T5 (Aug 28) confirmed no proposal_code carries a max_properties
-- override. A1 is tier=legacy, tier_type=enforcement (T2). Their
-- property limit is ENTIRELY tier-derived: `WHEN legacy THEN -1` is
-- the only thing between them and a Q4 property cap on a 10-15 property
-- rollout. There is NO backstop underneath it.
--
-- Verification explicitly execution-checks A1's row returns -1 —
-- see VE1 in the paired verification.
--
-- ── ELSE BEHAVIOR IN COMMIT A ──────────────────────────────────────
--
-- ELSE returns -1 (matches the neutered fn today). This means the
-- caller sees no change for any current tier value. Verification
-- asserts computed limits for all 5 existing companies are identical
-- before and after — a stronger gate than a structural check per
-- Mateo Sep 1 §1.
--
-- Commit B flips ELSE to RAISE 'tier_unrecognized' with a message
-- naming the tier + the helper. Both live tiers (pm_only,
-- enforcement_only, legacy) are named in the CASE; pm_starter is
-- named in the CASE; so Commit B raises only on genuinely-new
-- unrecognized tier values — the drift-loud mechanism.
--
-- ── LOOKUP SHAPE ────────────────────────────────────────────────────
--
-- Prior body used `WHERE name ILIKE p_company_name` — metacharacter
-- vector: a company named `%` would match every row via ILIKE
-- wildcard interpretation, and DEFINER context bypasses RLS. This
-- rewrite uses `lower(trim(name)) = lower(trim(p_company_name))`
-- (equality, case-insensitive, whitespace-normalized). Same class
-- as the Commit 2 RLS + record_space_payment scope-check divergence
-- from ~~*. Wildcard metachars in a name become literal characters.
--
-- Function signature UNCHANGED — (p_company_name TEXT) RETURNS
-- INTEGER, LANGUAGE plpgsql, SECURITY DEFINER, SET search_path=public.
-- CREATE OR REPLACE preserves callers.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- 1. Capture pg_get_functiondef BEFORE — save for diff
-- 2. Apply this migration
-- 3. Capture pg_get_functiondef AFTER — diff should show ONLY:
--    - Removed: `RETURN -1;`
--    - Added: DECLARE block + SELECT INTO + CASE with 4 branches +
--      ELSE -1 (matching neuter)
--    - Body reference to companies + lower(trim()) predicate
--    - No signature changes, no grant changes
--    (Standing rule per feedback_create_or_replace_drops_defaults:
--     helper has no parameter defaults, so no drop concern here.)
-- 4. Run verification — expect PASS on 6 gates + A1-specific execution
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_company_property_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_tier      TEXT;
  v_tier_type TEXT;
BEGIN
  -- 🟢 2026-09-01 Cap sequence Commit A — un-neuter. Body rewrite;
  -- signature + DEFINER + search_path unchanged from the 2026-06-26
  -- neuter. Old body: RETURN -1 unconditionally. New body: explicit
  -- CASE for all four known tier values; ELSE unchanged (-1) in this
  -- commit. Commit B flips ELSE to RAISE.
  --
  -- Lookup: lower(trim()) equality (NOT ILIKE per prior 2026-05-08
  -- body). Metacharacter vector closed; wildcard chars in name
  -- become literal.
  SELECT tier, tier_type
    INTO v_tier, v_tier_type
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(p_company_name))
   LIMIT 1;

  IF v_tier IS NULL THEN
    -- Unknown company. Behave as unlimited (unchanged from neuter).
    -- Trigger caller (enforce_property_limit) short-circuits on -1
    -- so this is effectively "no enforcement" — matches pre-neuter
    -- fallback and current behavior. Commit B does NOT flip this
    -- branch to RAISE — a missing company row is a data issue, not
    -- a tier-unrecognized case.
    RETURN -1;
  END IF;

  -- 🔴 EXPLICIT CASE FOR ALL FOUR VALUES — every currently-live tier
  -- named + pm_starter as dead branch until Commit A₀ widens
  -- companies_tier_valid. The pm_starter branch is unreachable today
  -- (CHECK constraint rejects it) and returns 1 (hard one-property
  -- cap — the tier's defining constraint) the moment A₀ lands.
  --
  -- Every live tier returns -1: pm_only + enforcement_only + legacy
  -- are all uncapped-by-tier today (their pricing is per-property or
  -- negotiated). So computed limits for ALL 5 existing companies are
  -- identical before and after this commit (T1 tier distribution:
  -- 3× enforcement/legacy, 1× enforcement/enforcement_only, 1×
  -- property_management/pm_only).
  --
  -- 🔴 The legacy branch is load-bearing for A1 — T5 confirmed no
  -- proposal_code max_properties override exists. If this branch
  -- ever returns anything other than -1, A1 gets capped on their Q4
  -- 10-15 property rollout with no override backstop. Do not change.
  -- 🔴 2026-09-04 RECIPROCAL: these tier→limit values are MIRRORED
  -- in TypeScript at app/lib/tier-config.ts (TIER_CONFIG.property_management.pm_starter.MAX_PROPERTIES,
  -- TIER_CONFIG.property_management.pm_only.MAX_PROPERTIES, etc.).
  -- SQL is enforcement (this function runs in enforce_property_limit
  -- trigger + read paths); TS is display (decides whether the "+ Add
  -- Property" button renders). They MUST agree. If you edit a limit
  -- here, edit the TS side too (or the CA portal's cap-hit modal
  -- fires against a DB that already refused the write, or the button
  -- stays hidden past a limit the DB would allow).
  --
  -- Cap Commit B's enforce_property_limit RAISE is the load-bearing
  -- gate that makes this drift LOUD (would fire on a mismatch attempt).
  RETURN CASE
    WHEN v_tier = 'pm_only'          THEN -1
    WHEN v_tier = 'enforcement_only' THEN -1
    WHEN v_tier = 'legacy'           THEN -1
    WHEN v_tier = 'pm_starter'       THEN 1   -- dead until Commit A₀; correct the moment it lands
    ELSE -1                                     -- Commit B flips to RAISE
  END;
END;
$func$;

COMMENT ON FUNCTION public.get_company_property_limit(TEXT) IS
  '2026-09-01 Cap sequence Commit A. Un-neutered from the 2026-06-26 neuter (RETURN -1 unconditional). Explicit CASE for all 4 known tier values: pm_only/-1, enforcement_only/-1, legacy/-1, pm_starter/1. ELSE -1 (Commit B will flip to RAISE). Lookup by lower(trim()) equality — NOT ILIKE (metacharacter vector closed). Callers: enforce_property_limit trigger; still consults proposal_codes.feature_overrides.max_properties FIRST before falling back to this helper. Legacy branch is load-bearing for A1 (no override exists per T5 Aug 28). pm_starter branch is dead code until Commit A₀ widens companies_tier_valid.';

-- Grants unchanged — CREATE OR REPLACE preserves them. No re-issue needed.

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_CAP_SEQUENCE_COMMIT_A',
  'public.get_company_property_limit',
  'commit_a_un_neuter',
  jsonb_build_object(
    'migration',      '20260901_cap_sequence_commit_a_un_neuter_helper',
    'arc',            'Cap sequence — Commit A of 4 (A → B → C → A₀)',
    'change_shape',   'Body-only rewrite; signature + DEFINER + search_path unchanged',
    'behavior_delta', 'ZERO against current 5 companies (all 3 live tiers already returned -1 from the neuter). pm_starter branch dead code until Commit A₀.',
    'metachar_fix',   'lower(trim(name)) equality replaces ILIKE — same discipline as Commit 2 RLS + record_space_payment scope check',
    'a1_gate',        'legacy branch returns -1; A1 (tier=legacy) uncapped as today. No override backstop exists (T5 Aug 28).',
    'next',           'Commit B: ELSE → RAISE. Commit C: reactivation branch on enforce_property_limit BEFORE UPDATE OF is_active. Commit A₀: widen companies_tier_valid for pm_starter.'
  ),
  now()
);

COMMIT;
