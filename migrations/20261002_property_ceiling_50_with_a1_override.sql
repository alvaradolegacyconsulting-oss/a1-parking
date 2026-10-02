-- ════════════════════════════════════════════════════════════════════
-- Property ceiling: 50 for self-serve, explicit unlimited for A1
-- ════════════════════════════════════════════════════════════════════
--
-- Per DECISION_pricing_selfserve_pro_tiers_oct2_2026 and Jose's
-- Ruling 2 (2026-10-02). Self-serve pays per property to 20, 21–50 are
-- included, and a 51st property is refused and directed to Elite.
--
-- 🔴 ORDER IS LOAD-BEARING. PART 1 gives A1 an explicit unlimited
-- override; PART 2 moves the tier default off unlimited. Reversed, or
-- with PART 1 omitted, A1 IS CAPPED AT 50 THE MOMENT THIS APPLIES.
--
-- That is not hypothetical. A1's proposal code was read before this was
-- written:
--
--     proposal_codes id=54  code='A1WRECKER-6NSW'  company_id=91
--     status='redeemed'     feature_overrides = {}        ← EMPTY
--
-- The Commit B comment already warned about it — "legacy branch
-- load-bearing for A1 (no override exists)" — and that is exactly the
-- branch PART 2 changes.
--
-- ── WHY AN OVERRIDE AND NOT A NEW TIER ──────────────────────────────
--
-- Elite needs no tier key. enforce_property_limit ALREADY consults
-- proposal_codes.feature_overrides->>'max_properties' BEFORE falling
-- back to the per-tier default, so "Elite" is expressible today as a
-- redeemed code carrying that key. A1 becomes the first one.
--
-- 🔴 WHOEVER ISSUES AN ELITE CODE MUST SET max_properties. A code
-- without it inherits the 50 default and the customer hits a ceiling
-- they were sold out of. The proposal-code UI should say so; that is a
-- separate commit, noted here so the dependency is on the record.
--
-- ── THE UNLIMITED SENTINEL IS -1 ────────────────────────────────────
--
-- Confirmed by reading the trigger, not assumed. Both the override and
-- the tier default flow into the same variable, and the test is:
--
--     IF v_limit < 0 THEN RETURN NEW; END IF;   -- -1 = unlimited
--
-- Any negative value works; -1 is the documented one and is what the
-- per-tier function already returns.
--
-- ── BEFORE APPLYING ─────────────────────────────────────────────────
--
-- 🔴 PART 2 is a CREATE OR REPLACE reproduced from
-- 20260902_cap_sequence_commit_b_else_raises.sql. Diff it against
-- `pg_get_functiondef` on the LIVE function first. If the live body
-- carries anything beyond the four RETURNs, this replace would revert
-- it silently — the same failure, in the same direction, as the
-- delete_orphaned_pending_resident v2/v3 episode.
--
-- 🔴 VOLATILITY: no STABLE. The first draft of this file added it and
-- it was caught before shipping. The live function is plain VOLATILE
-- (the default) and CREATE OR REPLACE would have changed that silently
-- — a planner-visible change nobody asked for, in a migration whose
-- whole subject is two integers. Reproduce the header exactly; the only
-- intended edits in PART 2 are two RETURN values.
--
-- Single transaction: PART 3 verifies and the whole thing ROLLS BACK if
-- A1 does not resolve to unlimited.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — A1's explicit unlimited override
-- ════════════════════════════════════════════════════════════════════
-- jsonb_set with create_if_missing so an override added later by hand
-- is merged rather than clobbered. Scoped by company_id AND the code,
-- so a second redeemed code for A1 could not be hit by accident.
UPDATE public.proposal_codes
   SET feature_overrides = jsonb_set(
         COALESCE(feature_overrides, '{}'::jsonb),
         '{max_properties}',
         '-1'::jsonb,
         true
       ),
       updated_at = now()
 WHERE id = 54
   AND code = 'A1WRECKER-6NSW'
   AND company_id = 91;

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.proposal_codes
   WHERE id = 54 AND (feature_overrides ->> 'max_properties') = '-1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PART 1 FAIL: A1 code 54 does not carry max_properties=-1 after the update (matched % rows). Refusing to change the tier default.', v_n;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — the tier defaults: enforcement_only and legacy → 50
-- ════════════════════════════════════════════════════════════════════
-- Body reproduced from Commit B with two RETURN values changed. Shape,
-- signature, DEFINER, search_path and the drift-loud ELSE are
-- unchanged.
--
-- pm_only stays -1: retired, and only Test-PM is on it. Capping a
-- retired tier would be a behaviour change with no buyer.
-- pm_starter stays 1: one property by definition.
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
  SELECT tier, tier_type
    INTO v_tier, v_tier_type
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(p_company_name))
   LIMIT 1;

  IF v_tier IS NULL THEN
    -- Unknown company — unlimited, unchanged. A missing company row is
    -- a data issue, not a tier-unrecognized case.
    RETURN -1;
  END IF;

  IF v_tier = 'pm_only' THEN
    RETURN -1;      -- retired tier; only Test-PM. Unchanged on purpose.
  ELSIF v_tier = 'enforcement_only' THEN
    RETURN 50;      -- 🔴 was -1. Operator Starter ceiling (Oct 2 decision).
  ELSIF v_tier = 'legacy' THEN
    RETURN 50;      -- 🔴 was -1. Operator Pro / PM Pro ceiling.
                    -- A1 is exempt via its proposal-code override, set
                    -- in PART 1 and verified in PART 3. Any other
                    -- legacy account wanting more than 50 is Elite and
                    -- gets an override too.
  ELSIF v_tier = 'pm_starter' THEN
    RETURN 1;       -- one property by definition.
  ELSE
    RAISE EXCEPTION 'tier_unrecognized: public.get_company_property_limit received tier=% for company=%. Every value in companies_tier_valid must have an explicit branch in this fn. Add ELSIF v_tier = ''%'' THEN RETURN <limit>. (Ceiling 50, 20261002.)',
      v_tier, p_company_name, v_tier;
  END IF;
END;
$func$;

COMMENT ON FUNCTION public.get_company_property_limit(TEXT) IS
  '2026-10-02 property ceiling. enforcement_only and legacy return 50 (was -1); pm_only stays -1 (retired tier, only Test-PM); pm_starter stays 1. Callers unchanged: enforce_property_limit consults proposal_codes.feature_overrides->>''max_properties'' FIRST and treats any negative as unlimited, which is how Elite — and A1 — are exempted without a new tier key. 🔴 An Elite proposal code MUST set max_properties or the account inherits 50.';

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — verify, or roll the whole thing back
-- ════════════════════════════════════════════════════════════════════
-- 🔴 The point of the single transaction. If A1 does not resolve to
-- unlimited, nothing applies — not the override, not the ceiling.
DO $$
DECLARE
  v_a1_override INT;
  v_a1_default  INT;
  v_enf         INT;
  v_starter     INT;
  v_pm_only     INT;
BEGIN
  -- A1's EFFECTIVE limit is the override, because the trigger prefers
  -- it. Asserting the override itself, the way the trigger reads it.
  SELECT (feature_overrides ->> 'max_properties')::INT
    INTO v_a1_override
    FROM public.proposal_codes
   WHERE company_id = 91
     AND status = 'redeemed'
     AND feature_overrides ? 'max_properties'
   ORDER BY redeemed_at DESC NULLS LAST
   LIMIT 1;

  IF v_a1_override IS NULL OR v_a1_override >= 0 THEN
    RAISE EXCEPTION 'PART 3 FAIL: A1 does not resolve to unlimited (override=%). ROLLING BACK — the ceiling must not apply while A1 is exposed to it.', coalesce(v_a1_override::text, 'NULL');
  END IF;

  -- And the tier default A1 would fall back to IS now 50, which is
  -- precisely why the override had to exist first. Asserted so the
  -- reason for PART 1 is visible in the verification, not just the
  -- header.
  v_a1_default := public.get_company_property_limit('A1 Wrecker llc');
  IF v_a1_default <> 50 THEN
    RAISE EXCEPTION 'PART 3 FAIL: expected A1''s tier DEFAULT to be 50 after PART 2, got %. The function did not change as intended.', v_a1_default;
  END IF;

  v_enf     := public.get_company_property_limit('Test-ENF');
  v_starter := public.get_company_property_limit('Test PM Starter 2');
  v_pm_only := public.get_company_property_limit('Test-PM');

  IF v_enf <> 50 THEN
    RAISE EXCEPTION 'PART 3 FAIL: enforcement_only resolves to %, expected 50', v_enf;
  END IF;
  IF v_starter <> 1 THEN
    RAISE EXCEPTION 'PART 3 FAIL: pm_starter resolves to %, expected 1', v_starter;
  END IF;
  IF v_pm_only <> -1 THEN
    RAISE EXCEPTION 'PART 3 FAIL: pm_only resolves to %, expected -1 (unchanged)', v_pm_only;
  END IF;
END $$;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  NULL,
  'SCHEMA_PROPERTY_CEILING_50',
  'public.get_company_property_limit',
  NULL,
  jsonb_build_object(
    'migration', '20261002_property_ceiling_50_with_a1_override',
    'change',    'enforcement_only and legacy default -1 -> 50; pm_only and pm_starter unchanged',
    'a1',        'proposal_codes id=54 feature_overrides.max_properties set to -1 (explicit unlimited) BEFORE the default moved',
    'elite',     'An Elite account is a redeemed proposal code carrying feature_overrides.max_properties. No new tier key.',
    'rollback',  'PART 3 raises and rolls the whole transaction back if A1 does not resolve to unlimited'
  ),
  now()
);

COMMIT;
