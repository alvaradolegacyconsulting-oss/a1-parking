-- ══════════════════════════════════════════════════════════════════════
-- 20260803_retired_tier_gates_copy_followup.sql
-- Follow-up to 20260803_retired_tier_gates_visitor_passes.sql —
-- reword the two orphaned RAISE strings that VQ.SUPPORT_ADDRESS_ZERO
-- flagged.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS FOLLOW-UP EXISTS ────────────────────────────────────────
--
-- Q1 sweep found four functions carrying the support-address /
-- "Upgrade tier" copy. The tier-gate commit reworded two
-- (enforce_property_limit, enforce_driver_limit) but only DROPPED
-- the triggers of the other two (enforce_visitor_pass_monthly_limit,
-- enforce_visitor_pass_duration) — the FUNCTION BODIES kept the
-- old RAISE strings intact.
--
-- VQ.SUPPORT_ADDRESS_ZERO greps pg_proc.prosrc (bodies), not just
-- attached triggers. It correctly failed on the two orphan bodies.
--
-- The re-arm path for those two functions is SHORTER than for
-- enforce_property_limit: one CREATE TRIGGER statement (the
-- documented rollback path for the tier-gate commit) would restore
-- both the trigger and the standing-rule violation in one shot.
--
-- So the fix widens rather than narrows the assertion. Both bodies
-- get the reworded RAISE now; VQ.SUPPORT_ADDRESS_ZERO stays as
-- written; the rollback path for the tier-gate commit no longer
-- restores a leak.
--
-- ── SHAPE — Mateo lock 2026-08-03 (follow-up) ────────────────────────
--
-- 1. CREATE OR REPLACE enforce_visitor_pass_monthly_limit — body
--    VERBATIM from 20260517_phase2a EXCEPT the final RAISE.
-- 2. CREATE OR REPLACE enforce_visitor_pass_duration — same.
-- 3. COMMENT ON FUNCTION x2 documenting the trigger-dropped state
--    + copy-compliance on any re-attachment.
--
-- ── COPY DISCIPLINE ──────────────────────────────────────────────────
--
-- Fact, not permission. No 'tier', no 'proposal_code', no
-- 'feature_overrides', no 'Upgrade tier' instruction, no support
-- address. Audience is a resident or a leasing agent, so the
-- escalation path is the property manager — mirroring the
-- rolling-30 message written 2026-07-29 under the same discipline.
--
-- ── DO NOT ────────────────────────────────────────────────────────────
--
-- - DO NOT re-attach either trigger — the tier-string CASE bodies in
--   the get_company_* helpers are still retired (mis-keyed), so
--   re-attaching arms the caps you meant to retire.
-- - DO NOT re-key the tier strings.
-- - DO NOT touch the CASE bodies or the entitlement lookups. Only
--   the RAISE strings change.
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- 20260517_phase2a_tier_enforcement_wireup.sql — creates the fns
-- 20260803_retired_tier_gates_visitor_passes.sql — drops the triggers
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. REWORD enforce_visitor_pass_monthly_limit ─────────────────────
-- Body VERBATIM from 20260517_phase2a EXCEPT the final RAISE.
-- Signature unchanged (RETURNS TRIGGER, no args); CREATE OR REPLACE
-- preserves grants.
CREATE OR REPLACE FUNCTION public.enforce_visitor_pass_monthly_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id BIGINT;
  v_company_name TEXT;
  v_limit INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_month_start TIMESTAMPTZ;
  v_active_count INTEGER;
BEGIN
  IF get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  IF NEW.property IS NULL OR NEW.property = '' THEN
    RETURN NEW;
  END IF;

  SELECT company INTO v_company_name
  FROM properties
  WHERE name ILIKE NEW.property
  LIMIT 1;

  v_override := NULL;
  IF v_company_name IS NOT NULL THEN
    SELECT id INTO v_company_id
    FROM companies
    WHERE name ILIKE v_company_name
    LIMIT 1;

    IF v_company_id IS NOT NULL THEN
      SELECT (feature_overrides ->> 'max_visitor_passes_per_property_month')
      INTO v_override_text
      FROM proposal_codes
      WHERE company_id = v_company_id
        AND status = 'redeemed'
        AND feature_overrides ? 'max_visitor_passes_per_property_month'
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
  END IF;

  IF v_override IS NOT NULL THEN
    v_limit := v_override;
  ELSE
    v_limit := get_company_visitor_pass_monthly_limit(NEW.property);
  END IF;

  IF v_limit < 0 THEN
    RETURN NEW; -- unlimited / N/A on enforcement track
  END IF;

  v_month_start := date_trunc('month', now());

  SELECT COUNT(*)
  INTO v_active_count
  FROM visitor_passes
  WHERE property ILIKE NEW.property
    AND created_at >= v_month_start;

  IF v_active_count >= v_limit THEN
    RAISE EXCEPTION 'This property has reached its monthly visitor pass limit of %.', v_limit
      USING ERRCODE = 'check_violation',
            HINT = 'Contact the property manager.';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. REWORD enforce_visitor_pass_duration ──────────────────────────
-- Body VERBATIM from 20260517_phase2a EXCEPT the final RAISE.
CREATE OR REPLACE FUNCTION public.enforce_visitor_pass_duration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id BIGINT;
  v_company_name TEXT;
  v_max_hours INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_duration_hours NUMERIC;
  v_start TIMESTAMPTZ;
BEGIN
  IF get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  IF NEW.property IS NULL OR NEW.property = ''
     OR NEW.expires_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT company INTO v_company_name
  FROM properties
  WHERE name ILIKE NEW.property
  LIMIT 1;

  v_override := NULL;
  IF v_company_name IS NOT NULL THEN
    SELECT id INTO v_company_id
    FROM companies
    WHERE name ILIKE v_company_name
    LIMIT 1;

    IF v_company_id IS NOT NULL THEN
      SELECT (feature_overrides ->> 'max_visitor_pass_duration_hours')
      INTO v_override_text
      FROM proposal_codes
      WHERE company_id = v_company_id
        AND status = 'redeemed'
        AND feature_overrides ? 'max_visitor_pass_duration_hours'
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
  END IF;

  IF v_override IS NOT NULL THEN
    v_max_hours := v_override;
  ELSE
    v_max_hours := get_company_visitor_pass_duration_max(NEW.property);
  END IF;

  IF v_max_hours < 0 THEN
    RETURN NEW; -- unlimited / N/A
  END IF;

  v_start := COALESCE(NEW.created_at, now());
  v_duration_hours := EXTRACT(EPOCH FROM (NEW.expires_at - v_start)) / 3600.0;

  IF v_duration_hours > v_max_hours THEN
    RAISE EXCEPTION 'Visitor passes at this property are limited to % hours.', v_max_hours
      USING ERRCODE = 'check_violation',
            HINT = 'Contact the property manager.';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. COMMENT ON documenting trigger-dropped + copy-compliant ───────
COMMENT ON FUNCTION public.enforce_visitor_pass_monthly_limit() IS
  'TRIGGER DROPPED 2026-08-03 (visitor_pass_monthly_limit_check). Body retained as the record of what the retired calendar-month cap was. RAISE copy reworded 2026-08-03 to fact-not-permission discipline (no support address, no tier, no proposal_code) — if this trigger is ever re-attached, the copy is already compliant. But DO NOT re-attach without first re-keying the tier strings in get_company_visitor_pass_monthly_limit — the retired 50/200 caps would arm.';

COMMENT ON FUNCTION public.enforce_visitor_pass_duration() IS
  'TRIGGER DROPPED 2026-08-03 (visitor_pass_duration_check). Body retained as the record of what the retired duration cap was. RAISE copy reworded 2026-08-03 to fact-not-permission discipline — if this trigger is ever re-attached, the copy is already compliant. But DO NOT re-attach without first re-keying the tier strings in get_company_visitor_pass_duration_max — the retired 12/24/48-hour caps would arm. Duration ceiling as property-policy is filed in backlog.';

COMMIT;
