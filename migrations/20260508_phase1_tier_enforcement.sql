-- ════════════════════════════════════════════════════════════════════
-- Phase 1 — hasFeature() tier enforcement foundation
-- Locked: May 8, 2026
--
-- Run via Supabase SQL Editor as a single transaction.
--
-- What this does:
--   1. Normalize companies.tier_type values: 'pm' → 'property_management',
--      then add CHECK constraint.
--   2. Create proposal_codes table + indexes + RLS.
--   3. Create proposal_codes_summary view (excludes pricing columns) for
--      company_admin / manager / driver / resident reads.
--   4. Create get_company_property_limit(company_text) SECURITY DEFINER
--      function returning the active-property limit for a company's tier.
--      ⚠ MIRROR OF app/lib/tier-config.ts — update both if matrix changes.
--      Phase 2 will replace with a tier_limits DB table.
--   5. Create enforce_property_limit() trigger on properties INSERT.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. tier_type normalization + CHECK ───────────────────────────────
UPDATE companies
SET tier_type = 'property_management'
WHERE tier_type = 'pm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_tier_type_valid'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_tier_type_valid
      CHECK (tier_type IN ('enforcement', 'property_management'));
  END IF;
END $$;

-- ── 2. proposal_codes table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposal_codes (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,

  custom_base_fee NUMERIC,
  custom_per_property_fee NUMERIC,
  custom_per_driver_fee NUMERIC,

  feature_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'redeemed', 'expired', 'revoked')),
  generated_at TIMESTAMPTZ DEFAULT now(),
  generated_by TEXT,
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,

  client_name TEXT,
  client_email TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposal_codes_company_id ON proposal_codes(company_id);
CREATE INDEX IF NOT EXISTS idx_proposal_codes_code ON proposal_codes(code);
CREATE INDEX IF NOT EXISTS idx_proposal_codes_status ON proposal_codes(status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION proposal_codes_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proposal_codes_updated_at ON proposal_codes;
CREATE TRIGGER proposal_codes_updated_at
BEFORE UPDATE ON proposal_codes
FOR EACH ROW
EXECUTE FUNCTION proposal_codes_set_updated_at();

-- ── 3. RLS on proposal_codes (admin only on the underlying table) ────
ALTER TABLE proposal_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_all_proposal_codes" ON proposal_codes;
CREATE POLICY "admin_all_proposal_codes" ON proposal_codes
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- ── 4. proposal_codes_summary view (excludes pricing) ────────────────
-- View is owned by the migration runner (postgres / service_role) and so
-- bypasses the underlying table's RLS. Inside the view we filter to the
-- caller's company via get_my_company(). Authenticated users see only
-- redeemed codes for their own company; pricing columns are excluded.

DROP VIEW IF EXISTS proposal_codes_summary;
CREATE VIEW proposal_codes_summary
WITH (security_barrier = true, security_invoker = false) AS
SELECT pc.id,
       pc.code,
       pc.status,
       pc.feature_overrides,
       pc.redeemed_at,
       pc.expires_at,
       pc.client_name,
       pc.client_email,
       pc.notes,
       pc.company_id
FROM proposal_codes pc
WHERE pc.status = 'redeemed'
  AND pc.company_id IN (
    SELECT c.id FROM companies c
    WHERE c.name ILIKE get_my_company()
  );

GRANT SELECT ON proposal_codes_summary TO authenticated;

-- Super admin reads pricing via the underlying table (RLS allows admin).

-- ── 5. get_company_property_limit() ──────────────────────────────────
-- Returns the active-property limit for a company. -1 = unlimited.
-- ⚠ MIRROR OF app/lib/tier-config.ts max_properties values.
--   Phase 2 will replace this hardcoded CASE with a tier_limits table.

CREATE OR REPLACE FUNCTION get_company_property_limit(p_company_name TEXT)
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
    RETURN -1;
  END IF;

  RETURN CASE
    WHEN v_tier_type = 'enforcement' AND v_tier = 'starter' THEN 5
    WHEN v_tier_type = 'enforcement' AND v_tier = 'growth' THEN 15
    WHEN v_tier_type = 'enforcement' AND v_tier = 'legacy' THEN -1
    WHEN v_tier_type = 'property_management' AND v_tier = 'essential' THEN 3
    WHEN v_tier_type = 'property_management' AND v_tier = 'professional' THEN 10
    WHEN v_tier_type = 'property_management' AND v_tier = 'enterprise' THEN -1
    ELSE -1
  END;
END;
$$;

-- ── 6. enforce_property_limit() trigger ──────────────────────────────
-- Runs as SECURITY DEFINER so it can read proposal_codes (which has RLS
-- restricting non-admins). Always enforces — including for super admin
-- via SQL Editor — to satisfy verification scenario C. To bypass for
-- legitimate ops, raise the company's tier first or issue a proposal_code
-- override.

CREATE OR REPLACE FUNCTION enforce_property_limit()
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

  -- -1 = unlimited
  IF v_limit < 0 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)
  INTO v_active_count
  FROM properties
  WHERE company ILIKE NEW.company
    AND is_active = TRUE;

  IF v_active_count >= v_limit THEN
    RAISE EXCEPTION 'Property limit exceeded: tier allows % active properties for %', v_limit, NEW.company
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override.',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS property_limit_check ON properties;
CREATE TRIGGER property_limit_check
BEFORE INSERT ON properties
FOR EACH ROW
EXECUTE FUNCTION enforce_property_limit();

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Phase 1 verification queries (run after the migration applies):
-- ════════════════════════════════════════════════════════════════════
--
-- A) Confirm tier_type normalized:
--   SELECT tier_type, COUNT(*) FROM companies GROUP BY tier_type;
--
-- B) Confirm CHECK constraint:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'companies_tier_type_valid';
--
-- C) Test get_company_property_limit():
--   SELECT name, tier_type, tier, get_company_property_limit(name) AS limit
--   FROM companies ORDER BY name;
--
-- D) Server-side bypass test (scenario C from the spec):
--   -- Temporarily lower Demo Towing to starter:
--   UPDATE companies SET tier = 'starter' WHERE name = 'Demo Towing LLC';
--   -- Confirm count of active properties first:
--   SELECT COUNT(*) FROM properties WHERE company ILIKE 'Demo Towing LLC' AND is_active;
--   -- Add up to 5 active properties via SQL or UI, then attempt #6:
--   INSERT INTO properties (name, company, is_active)
--   VALUES ('Test 6', 'Demo Towing LLC', TRUE);
--   -- Should fail: "Property limit exceeded: tier allows 5 active properties..."
--   -- Reset:
--   UPDATE companies SET tier = 'legacy' WHERE name = 'Demo Towing LLC';
--   -- Clean up any test rows you inserted.
--
-- E) Proposal code override (scenario D):
--   -- Find Demo Edge Case id:
--   SELECT id FROM companies WHERE name = 'Demo Edge Case LLC';
--   -- Insert override (replace <id> below):
--   INSERT INTO proposal_codes (code, company_id, feature_overrides, status, redeemed_at)
--   VALUES ('TEST-OVERRIDE', <id>, '{"max_properties": 100}'::jsonb, 'redeemed', now());
--   -- The next login by a Demo Edge Case user should pull the override into
--   -- localStorage.company_proposal_code, and hasFeature(MAX_PROPERTIES, ctx)
--   -- should return 100 instead of 5.
--   -- After verification:
--   DELETE FROM proposal_codes WHERE code = 'TEST-OVERRIDE';
