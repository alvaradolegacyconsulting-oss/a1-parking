-- ════════════════════════════════════════════════════════════════════
-- Phase 2a — hasFeature() wire-up: server-side enforcement for
-- max_drivers, visitor_pass monthly limit, visitor_pass duration cap
-- Locked: May 17, 2026
--
-- Phase 1 (May 7-8) shipped:
--   • Full TIER_CONFIG matrix in app/lib/tier-config.ts
--   • hasFeature() / getLimit() / isUnderLimit() / getUpgradePrompt()
--     in app/lib/tier.ts
--   • get_company_property_limit() SQL helper + enforce_property_limit()
--     trigger + property_limit_check trigger on properties
--   • Custom proposal_code feature_overrides JSONB support
--
-- This migration extends server-side enforcement to the three tier
-- limits that have client-side gates but no DB trigger today:
--   1. max_drivers (drivers table)
--   2. max_visitor_passes_per_property_month (visitor_passes table)
--   3. max_visitor_pass_duration_hours (visitor_passes table)
--
-- Pattern follows Phase 1's enforce_property_limit:
--   • SECURITY DEFINER helper function with hard-coded CASE per tier
--   • SECURITY DEFINER trigger function reading proposal_codes overrides
--   • BEFORE INSERT trigger on the target table
--
-- ── ADMIN BYPASS — INTENTIONAL DIVERGENCE FROM PHASE 1 ─────────────
-- Phase 1's enforce_property_limit() does NOT bypass admin (per its
-- inline comment, "Always enforces — including for super admin via
-- SQL Editor — to satisfy verification scenario C").
--
-- Phase 2a's three triggers DO bypass admin (per Jose's Q3 directive,
-- 2026-05-17). Rationale: drivers and visitor passes are operational
-- support targets — admin needs to fix things without first issuing a
-- proposal_code override. Properties are a tier-defining limit
-- (customers buy seats by property count), so Phase 1's no-bypass
-- semantics stand. The asymmetry is deliberate, documented here, and
-- captured in the audit_logs via user_email regardless.
--
-- Bypass condition: get_my_role() = 'admin'.
-- Service-role / direct SQL bypass is NOT applied here because Phase 1
-- explicitly rejected it for property enforcement and we don't want
-- two different bypass semantics across triggers. If A1's operations
-- need service_role bypass for batch ops, that's a separate decision.
--
-- ── DRIFT RISK — DOCUMENTED ────────────────────────────────────────
-- Each helper function below contains a CASE statement that mirrors
-- the numeric limits in app/lib/tier-config.ts. If you change a limit,
-- change both. See memory/project_b34_tier_config_drift.md for the
-- Phase 2 plan to unify both sources via a tier_limits table.
--
-- ── KNOWN SEMANTIC DIVERGENCE FROM TIER_CONFIG ─────────────────────
-- Visitor pass monthly limit + duration cap are 0 in tier-config.ts
-- on enforcement tiers (interpreted as "feature does not apply on
-- this track"). The SQL helpers below return -1 for ENF tiers
-- ("unlimited / no cap"). This means: ENF tiers can issue visitor
-- passes freely (no monthly cap, no duration cap) at the DB layer,
-- which matches the spec's intent that monthly + duration caps are
-- PM-only constructs. Documented in B34.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. get_company_driver_limit() ───────────────────────────────────
CREATE OR REPLACE FUNCTION get_company_driver_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier TEXT;
  v_tier_type TEXT;
BEGIN
  SELECT tier, tier_type
  INTO v_tier, v_tier_type
  FROM companies
  WHERE name ILIKE p_company_name
  LIMIT 1;

  IF v_tier IS NULL OR v_tier_type IS NULL THEN
    RETURN -1; -- unknown company → don't block (consistent w/ property helper)
  END IF;

  RETURN CASE
    WHEN v_tier_type = 'enforcement' AND v_tier = 'starter' THEN 3
    WHEN v_tier_type = 'enforcement' AND v_tier = 'growth' THEN 10
    WHEN v_tier_type = 'enforcement' AND v_tier = 'legacy' THEN -1
    -- PM tiers don't have a drivers workflow; 0 = block all driver INSERTs
    -- (admin bypass still applies for support-case provisioning if ever needed)
    WHEN v_tier_type = 'property_management' THEN 0
    ELSE -1
  END;
END;
$$;

-- ── 2. enforce_driver_limit() trigger ───────────────────────────────
CREATE OR REPLACE FUNCTION enforce_driver_limit()
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
  -- Admin bypass (Q3 directive)
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
    RAISE EXCEPTION 'Driver limit exceeded: tier allows % active drivers for %', v_limit, NEW.company
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override.',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS driver_limit_check ON drivers;
CREATE TRIGGER driver_limit_check
BEFORE INSERT ON drivers
FOR EACH ROW
EXECUTE FUNCTION enforce_driver_limit();

-- ── 3. get_company_visitor_pass_monthly_limit() ─────────────────────
-- Property → company → tier → monthly cap per property.
-- Returns -1 (unlimited) for enforcement tiers since the monthly cap
-- is a PM-only construct. PM essential=50, professional=200, enterprise=-1.
CREATE OR REPLACE FUNCTION get_company_visitor_pass_monthly_limit(p_property TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name TEXT;
  v_tier TEXT;
  v_tier_type TEXT;
BEGIN
  SELECT company INTO v_company_name
  FROM properties
  WHERE name ILIKE p_property
  LIMIT 1;

  IF v_company_name IS NULL THEN
    RETURN -1;
  END IF;

  SELECT tier, tier_type
  INTO v_tier, v_tier_type
  FROM companies
  WHERE name ILIKE v_company_name
  LIMIT 1;

  IF v_tier IS NULL OR v_tier_type IS NULL THEN
    RETURN -1;
  END IF;

  RETURN CASE
    WHEN v_tier_type = 'enforcement' THEN -1 -- ENF: no monthly cap, feature doesn't apply
    WHEN v_tier_type = 'property_management' AND v_tier = 'essential' THEN 50
    WHEN v_tier_type = 'property_management' AND v_tier = 'professional' THEN 200
    WHEN v_tier_type = 'property_management' AND v_tier = 'enterprise' THEN -1
    ELSE -1
  END;
END;
$$;

-- ── 4. enforce_visitor_pass_monthly_limit() trigger ─────────────────
-- Counts visitor_passes for NEW.property created since start of current
-- calendar month. Blocks when active count >= limit. Admin bypass.
-- Coexists with B19's enforce_visitor_pass_limit (per-plate concurrent
-- check) — that's a separate trigger; both fire BEFORE INSERT.
CREATE OR REPLACE FUNCTION enforce_visitor_pass_monthly_limit()
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

  -- Resolve property → company for proposal_code lookup
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
    RAISE EXCEPTION 'Monthly visitor-pass limit exceeded: tier allows % passes per property per calendar month for %', v_limit, NEW.property
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override.',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visitor_pass_monthly_limit_check ON visitor_passes;
CREATE TRIGGER visitor_pass_monthly_limit_check
BEFORE INSERT ON visitor_passes
FOR EACH ROW
EXECUTE FUNCTION enforce_visitor_pass_monthly_limit();

-- ── 5. get_company_visitor_pass_duration_max() ──────────────────────
-- Returns max pass duration in hours. -1 = unlimited / N/A.
CREATE OR REPLACE FUNCTION get_company_visitor_pass_duration_max(p_property TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name TEXT;
  v_tier TEXT;
  v_tier_type TEXT;
BEGIN
  SELECT company INTO v_company_name
  FROM properties
  WHERE name ILIKE p_property
  LIMIT 1;

  IF v_company_name IS NULL THEN
    RETURN -1;
  END IF;

  SELECT tier, tier_type
  INTO v_tier, v_tier_type
  FROM companies
  WHERE name ILIKE v_company_name
  LIMIT 1;

  IF v_tier IS NULL OR v_tier_type IS NULL THEN
    RETURN -1;
  END IF;

  RETURN CASE
    WHEN v_tier_type = 'enforcement' THEN -1 -- ENF: no duration cap
    WHEN v_tier_type = 'property_management' AND v_tier = 'essential' THEN 12
    WHEN v_tier_type = 'property_management' AND v_tier = 'professional' THEN 24
    WHEN v_tier_type = 'property_management' AND v_tier = 'enterprise' THEN 48
    ELSE -1
  END;
END;
$$;

-- ── 6. enforce_visitor_pass_duration() trigger ──────────────────────
-- Compares NEW.expires_at - NEW.created_at against the tier's hour cap.
-- Admin bypass.
CREATE OR REPLACE FUNCTION enforce_visitor_pass_duration()
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
    RAISE EXCEPTION 'Visitor-pass duration exceeded: tier allows % hours max for %; requested ~%h',
      v_max_hours, NEW.property, ROUND(v_duration_hours, 1)
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override.',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visitor_pass_duration_check ON visitor_passes;
CREATE TRIGGER visitor_pass_duration_check
BEFORE INSERT ON visitor_passes
FOR EACH ROW
EXECUTE FUNCTION enforce_visitor_pass_duration();

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES — run after migration applies
--
-- ── A. Function + trigger inventory ─────────────────────────────────
--   SELECT proname FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN (
--       'get_company_driver_limit',
--       'enforce_driver_limit',
--       'get_company_visitor_pass_monthly_limit',
--       'enforce_visitor_pass_monthly_limit',
--       'get_company_visitor_pass_duration_max',
--       'enforce_visitor_pass_duration'
--     )
--   ORDER BY proname;
--   -- Expected: 6 rows.
--
--   SELECT tgname, tgrelid::regclass AS table_name
--   FROM pg_trigger
--   WHERE tgname IN (
--     'driver_limit_check',
--     'visitor_pass_monthly_limit_check',
--     'visitor_pass_duration_check'
--   )
--   ORDER BY tgname;
--   -- Expected: 3 rows (drivers / visitor_passes / visitor_passes).
--
-- ── B. Demo seed compliance ─────────────────────────────────────────
--   -- B.1: properties per company vs tier limit
--   SELECT c.name, c.tier_type, c.tier,
--          get_company_property_limit(c.name) AS limit_,
--          (SELECT COUNT(*) FROM properties p WHERE p.company ILIKE c.name AND p.is_active) AS active_count
--   FROM companies c
--   ORDER BY c.name;
--   -- Expected:
--   --   Demo Towing LLC      enforcement   legacy        -1   <count>
--   --   Demo PM Group        property_management professional  10  <count ≤ 10>
--   --   Demo Edge Case       enforcement   starter        5   <count ≤ 5>
--
--   -- B.2: drivers per company vs tier limit
--   SELECT c.name, c.tier_type, c.tier,
--          get_company_driver_limit(c.name) AS limit_,
--          (SELECT COUNT(*) FROM drivers d WHERE d.company ILIKE c.name AND d.is_active) AS active_count
--   FROM companies c
--   ORDER BY c.name;
--   -- Expected:
--   --   Demo Edge Case       starter        3   <count ≤ 3>
--   --   Demo Towing LLC      legacy        -1   <count>
--   --   Demo PM Group        professional   0   <should be 0 — PM has no drivers>
--
--   -- B.3: visitor passes this calendar month per property
--   -- (PM properties only — ENF returns -1 from the helper)
--   SELECT p.name, p.company, c.tier,
--          get_company_visitor_pass_monthly_limit(p.name) AS limit_,
--          (SELECT COUNT(*) FROM visitor_passes vp
--           WHERE vp.property ILIKE p.name
--             AND vp.created_at >= date_trunc('month', now())) AS this_month
--   FROM properties p
--   JOIN companies c ON c.name ILIKE p.company
--   WHERE c.tier_type = 'property_management'
--   ORDER BY p.name;
--
-- ── C. Admin bypass smoke (DON'T actually exceed prod limits) ───────
--   -- As an admin via the SQL Editor, INSERT a driver for Demo Edge Case
--   -- when it already has 3 active drivers. Expected: succeeds (admin bypass).
--   -- As a CA via the app for the same company at 3 drivers, INSERT attempt
--   -- raises 'Driver limit exceeded'.
--
-- ── D. Proposal-code override smoke ─────────────────────────────────
--   -- Issue a proposal_code with feature_overrides = '{"max_drivers": 5}',
--   -- redeem for Demo Edge Case. Re-run the count vs limit query —
--   -- override should now read 5, allowing 2 more drivers.
-- ════════════════════════════════════════════════════════════════════
