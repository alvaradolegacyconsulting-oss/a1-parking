-- ══════════════════════════════════════════════════════════════════════
-- 20260803_retired_tier_gates_visitor_passes.sql
-- Retire tier-gate triggers on visitor_passes + reword support-address
-- leaks on adjacent tier-gate triggers (drivers, properties).
-- ══════════════════════════════════════════════════════════════════════
--
-- ── SHAPE B — Mateo lock 2026-08-03 ──────────────────────────────────
--
-- 1. DROP TRIGGER visitor_pass_monthly_limit_check (calls a mis-keyed
--    function; returns -1 for every current company)
-- 2. DROP TRIGGER visitor_pass_duration_check (same shape, same defect)
-- 3. CREATE OR REPLACE enforce_driver_limit — reword RAISE. Splits
--    v_limit=0 (PM tier has no drivers workflow — permanent boundary)
--    from v_limit>0 (cap-exceeded — retained as backstop). Removes
--    support address + "tier" + "proposal_code" from user-facing copy.
-- 4. CREATE OR REPLACE enforce_property_limit — reword RAISE. Removes
--    support address. Function currently unreachable (get_company_
--    property_limit was neutered to -1 by 20260626 remap), so the new
--    RAISE is a backstop for any future re-enablement.
-- 5. COMMENT ON FUNCTION x3 — document the retired-key CASE bodies
--    without editing them.
--
-- ── KEPT DELIBERATELY (per Mateo lock) ────────────────────────────────
--
-- - get_company_visitor_pass_monthly_limit — body preserved (record of
--   the retired 50/200 caps); COMMENT flags retirement + do-not-re-key.
-- - get_company_visitor_pass_duration_max — same, 12/24/48 hour caps.
-- - get_company_driver_limit — body preserved. PM branch (returns 0)
--   is INTENTIONAL product policy, retained. Enforcement branches
--   (starter=3 / growth=10) are mis-keyed and now dead; COMMENT flags
--   retirement + do-not-re-key.
-- - enforce_visitor_pass_limit (rolling-30, 20260729) — SEPARATE
--   trigger + function, untouched. VQ.ROLLING_30_STILL_BITES proves.
--
-- ── DO NOT ────────────────────────────────────────────────────────────
--
-- - DO NOT re-key the tier strings ('essential'/'professional'/etc)
--   to the current catalog ('pm_only'/'enforcement_only'). Those
--   branches look mis-keyed because they ARE — retired, not broken.
--   Aligning them arms caps no current plan sells: 50-pass monthly
--   cap, 12h duration cap, 3/10 driver seat cap.
-- - DO NOT edit get_company_property_limit — neutered to -1 by
--   20260626_billing_slice1_commit5_tier_remap by design.
--
-- ── PRE-APPLY GATE ────────────────────────────────────────────────────
--
-- Before applying, Q3 must confirm no row in public.companies carries
-- tier IN ('starter','growth','essential','professional','enterprise').
-- If any row matches, the mis-keyed gates are LIVE and this becomes an
-- incident triage, not maintenance. Do not apply.
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- 20260508_phase1_tier_enforcement.sql — creates enforce_property_limit
-- 20260517_phase2a_tier_enforcement_wireup.sql — creates the other 3
-- 20260626_billing_slice1_commit5_tier_remap.sql — neuters property fn
-- 20260729_visitor_pass_rolling_30_semantics.sql — rolling-30 rewrite
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. DROP the two retired-cap triggers ─────────────────────────────
DROP TRIGGER IF EXISTS visitor_pass_monthly_limit_check ON public.visitor_passes;
DROP TRIGGER IF EXISTS visitor_pass_duration_check      ON public.visitor_passes;

-- ── 2. REWORD enforce_driver_limit ───────────────────────────────────
-- Signature unchanged (RETURNS TRIGGER, no args); CREATE OR REPLACE
-- preserves grants. Body verbatim from 20260517_phase2a EXCEPT the
-- final RAISE, which splits by v_limit value.
CREATE OR REPLACE FUNCTION public.enforce_driver_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id BIGINT;
  v_limit INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_active_count INTEGER;
BEGIN
  IF get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  IF NEW.company IS NULL OR NEW.company = '' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_company_id
  FROM companies
  WHERE name ILIKE NEW.company
  LIMIT 1;

  v_override := NULL;
  IF v_company_id IS NOT NULL THEN
    SELECT (feature_overrides ->> 'max_drivers')
    INTO v_override_text
    FROM proposal_codes
    WHERE company_id = v_company_id
      AND status = 'redeemed'
      AND feature_overrides ? 'max_drivers'
    ORDER BY redeemed_at DESC NULLS LAST
    LIMIT 1;

    IF v_override_text IS NOT NULL THEN
      BEGIN
        v_override := v_override_text::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_override := NULL;
      END;
    END IF;
  END IF;

  IF v_override IS NOT NULL THEN
    v_limit := v_override;
  ELSE
    v_limit := get_company_driver_limit(NEW.company);
  END IF;

  IF v_limit < 0 THEN
    RETURN NEW; -- unlimited
  END IF;

  SELECT COUNT(*)
  INTO v_active_count
  FROM drivers
  WHERE company ILIKE NEW.company
    AND is_active = TRUE;

  IF v_active_count >= v_limit THEN
    -- v_limit=0 is a permanent product boundary (PM tier has no
    -- drivers workflow), not a cap. Boundary copy states a fact,
    -- not a permission. v_limit>0 is a backstop for any future
    -- re-key of the enforcement branches in get_company_driver_limit
    -- — no enforcement tier returns a positive cap today. Both
    -- messages avoid tier / proposal_code / support-address per
    -- Mateo lock 2026-08-03.
    IF v_limit = 0 THEN
      RAISE EXCEPTION 'Driver accounts are not part of the Property Management plan.'
        USING ERRCODE = 'check_violation';
    ELSE
      RAISE EXCEPTION 'This account has reached its limit of % driver accounts.', v_limit
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. REWORD enforce_property_limit ─────────────────────────────────
-- Signature unchanged; CREATE OR REPLACE preserves grants. Body
-- verbatim from 20260508_phase1 EXCEPT the final RAISE. No v_limit=0
-- boundary case — there is no product policy saying "no properties on
-- this plan"; the RAISE branch is a pure backstop for any future
-- re-enablement of the tier-cap logic in get_company_property_limit
-- (neutered to -1 by 20260626 remap).
CREATE OR REPLACE FUNCTION public.enforce_property_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id BIGINT;
  v_limit INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_active_count INTEGER;
BEGIN
  IF NEW.company IS NULL OR NEW.company = '' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_company_id
  FROM companies
  WHERE name ILIKE NEW.company
  LIMIT 1;

  v_override := NULL;
  IF v_company_id IS NOT NULL THEN
    SELECT (feature_overrides ->> 'max_properties')
    INTO v_override_text
    FROM proposal_codes
    WHERE company_id = v_company_id
      AND status = 'redeemed'
      AND feature_overrides ? 'max_properties'
    ORDER BY redeemed_at DESC NULLS LAST
    LIMIT 1;

    IF v_override_text IS NOT NULL THEN
      BEGIN
        v_override := v_override_text::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_override := NULL;
      END;
    END IF;
  END IF;

  IF v_override IS NOT NULL THEN
    v_limit := v_override;
  ELSE
    v_limit := get_company_property_limit(NEW.company);
  END IF;

  IF v_limit < 0 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)
  INTO v_active_count
  FROM properties
  WHERE company ILIKE NEW.company
    AND is_active = TRUE;

  IF v_active_count >= v_limit THEN
    RAISE EXCEPTION 'This account has reached its limit of % active properties.', v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 4. COMMENT ON the retired-key CASE bodies ────────────────────────
-- Documents retirement without editing executable code. Reader who
-- opens the function in Supabase sees the retirement note; body
-- remains as the record of what the old caps were.
COMMENT ON FUNCTION public.get_company_visitor_pass_monthly_limit(text) IS
  'RETIRED 2026-08-03. Tier strings in the CASE body (essential/professional/enterprise) predate the 2026-06-26 catalog remap and no longer match companies.tier — every current company falls through to ELSE -1 (no cap). Trigger visitor_pass_monthly_limit_check dropped 2026-08-03. Body kept as the record of what the retired caps were. DO NOT re-key the tier strings — that would arm a 50-pass monthly cap no current plan sells.';

COMMENT ON FUNCTION public.get_company_visitor_pass_duration_max(text) IS
  'RETIRED 2026-08-03. Tier strings in the CASE body (essential/professional/enterprise) predate the 2026-06-26 catalog remap and no longer match companies.tier — every current PM company falls through to ELSE -1 (no cap); enforcement branch was correctly keyed. Trigger visitor_pass_duration_check dropped 2026-08-03. Body kept as the record of what the retired caps were. DO NOT re-key the tier strings — that would arm a 12/24/48-hour duration cap no current plan sells. Duration ceiling as property-policy is filed in backlog (2026-08-03).';

COMMENT ON FUNCTION public.get_company_driver_limit(text) IS
  'PARTIAL RETIREMENT 2026-08-03. Enforcement branch tier strings (starter/growth) predate the 2026-06-26 remap and no longer match; those branches return ELSE -1 (unlimited) today. The property_management branch (returns 0) is INTENTIONAL and PERMANENT — PM tiers have no drivers workflow. Trigger driver_limit_check remains attached; enforce_driver_limit reworded 2026-08-03 to split v_limit=0 (boundary copy) from v_limit>0 (cap copy). PM Add Driver affordance-removal filed in backlog. DO NOT re-key starter/growth — that would arm a 3/10 driver seat cap no current plan sells.';

COMMIT;
