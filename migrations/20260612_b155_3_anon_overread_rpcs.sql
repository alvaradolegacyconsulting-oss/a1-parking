-- ════════════════════════════════════════════════════════════════════
-- B155.3 — Anon over-read fix: companies + properties + platform_settings
-- Drafted: 2026-06-02 — NOT YET APPLIED.
--
-- Closes 3 {public} SELECT policies that admit anon `SELECT *` against
-- production. Pre-flight (B155.3 Phase 2) confirmed total exposure:
--   • companies          — 39 of 39 columns anon-readable, including
--                          name, address, phone, primary_contact_name,
--                          tier, tier_type, account_state on current
--                          data + will include stripe_customer_id,
--                          billing_*, subscription_status, dunning_*
--                          the moment A1 onboards via B66.7
--   • properties         — 26 of 26 columns, including pm_email,
--                          pm_phone, pm_name, address, city/state/zip,
--                          authorization_pdf_path
--   • platform_settings  — 24 of 24 columns; today benign (pricing,
--                          support, dormancy flags) but future-trap
--
-- ── SEVERITY REFRAME (Jose synthesis) ───────────────────────────────
-- Current production data is TEST data — no live customer breach today.
-- The structural issue: A1's real PM contacts, addresses, and post-
-- B66.7 Stripe/billing/dunning state go anon-readable the moment A1
-- onboards, reachable via the public anon key independent of
-- public_signup_open. This is on A1's onboarding-path critical timeline,
-- not deferred to public launch. SHIP BEFORE A1 ENTERS REAL DATA.
--
-- ── LOAD-BEARING BOOTSTRAP-CHAIN FINDING ────────────────────────────
-- The {public} all-read on companies + platform_settings was the SILENT
-- FALLBACK ADMIT for authenticated driver/manager/leasing_agent/resident
-- bootstrap. Without a replacement, dropping the {public} policies
-- breaks login dispatch for those 4 roles (bootstrap, portal-gate,
-- tier helpers, driver tow-ticket TDLR fetch). This commit's REAL
-- failure mode is breaking login for 4 roles, not just the security
-- fix. authenticated_read_own_company is REQUIRED, not optional.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. DROP all_read_active_companies        ({public}, was the leak)
--   2. DROP public_read_active_properties    ({public}, was the leak)
--   3. DROP all_read_platform_settings       ({public}, was the leak)
--   4a. CREATE authenticated_read_own_company ({authenticated}, the
--       bootstrap-chain replacement — admits any authenticated role
--       reading their own company by name match. Side-bonus: closes
--       authenticated cross-company reads — a driver of Company A
--       can no longer read Company B's row.)
--   4b. CREATE resident_read_own_properties ({authenticated}, mirrors
--       resident_read_own_spaces verbatim — residents read own
--       property by name IN residents.property where residents.email
--       matches JWT). Required because the {public} all-read was the
--       ONLY policy admitting residents on properties. Without this,
--       /resident:102 pm_name/pm_email read breaks for A1's residents.
--       Pre-flight verify-check caught this; existing audit dump
--       confirmed no resident_read_own_properties policy existed.
--   5. CREATE 5 SECURITY DEFINER RPCs for anon/authenticated repoint:
--        • get_company_branding(p_name) — safe-column subset
--        • get_property_for_visitor(p_name) — single-row by name
--        • get_properties_for_visitor_select(p_company) — list shape
--          (the second coverage gap caught in synthesis — visitor-
--           select needs a list of property names by company)
--        • get_platform_defaults() — branding fallback (5 fields
--          bootstrap consumes; covers the company-bootstrap.ts:87
--          select('*') consumer per the bootstrap-completeness check)
--        • get_platform_flags() — dormancy flags (stripe_billing_
--          enabled, public_signup_open)
--   6. REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO anon,authenticated
--      on each RPC (per the SECURITY DEFINER discipline established
--      after the B82 PUBLIC-grant retrofit pass).
--
-- ── SAFE COLUMN PROJECTION RATIONALE (companies) ────────────────────
-- get_company_branding returns: id, name, display_name, logo_url,
-- theme, support_phone, support_email, support_website. These are the
-- columns the anon /visitor + /visitor-select flows currently fetch
-- explicitly (no .select('*') by anon today). Future columns added to
-- companies do NOT auto-leak — must be explicitly added to the RPC.
--
-- ── PROPERTIES RPC PAIR (the first coverage gap caught in synthesis) ─
-- Two anon shapes exist:
--   • /visitor:21 — single property by exact name → needs id, name,
--     company linkage. get_property_for_visitor(p_name) handles it.
--   • /visitor-select:18 — LIST of property names by optional company
--     filter. get_properties_for_visitor_select(p_company) handles it
--     (p_company nullable: all active properties when null).
--
-- ── BOOTSTRAP-COMPLETENESS CHECK (platform_settings) ────────────────
-- company-bootstrap.ts:87 calls .select('*') then consumes 5 fields:
-- default_logo_url, default_theme, default_support_phone,
-- default_support_email, default_support_website. get_platform_defaults
-- returns exactly those 5 — bootstrap doesn't see fewer than it needs
-- AND doesn't get unnecessary fields. (lib/logo.ts only consumes
-- default_logo_url; same RPC works.)
--
-- ── ROLLBACK PLAN (staged, NOT executed) ────────────────────────────
-- If the post-apply probe shows bootstrap-chain positives FAIL (most
-- likely cause: get_my_company() returns something unexpected for
-- non-CA roles → authenticated_read_own_company doesn't admit), the
-- escape is to re-add the 3 {public} policies VERBATIM:
--
--   CREATE POLICY all_read_active_companies ON companies
--     FOR SELECT TO public USING (is_active = true);
--   CREATE POLICY public_read_active_properties ON properties
--     FOR SELECT TO public USING (is_active = true);
--   CREATE POLICY all_read_platform_settings ON platform_settings
--     FOR SELECT TO public USING (true);
--   -- And optionally drop authenticated_read_own_company + the RPCs
--   -- to fully revert.
--
-- Restores the exposure but unblocks the login chain — recoverable on
-- TEST data per the severity reframe; not catastrophic. Have it staged
-- before apply.
--
-- ── DEPENDENCIES (verified) ─────────────────────────────────────────
-- • companies, properties, platform_settings tables exist with the
--   columns referenced above (verified via anon-key REST probe in
--   pre-flight Phase 2).
-- • get_my_company() exists (B40 captured at 20260518_b40_violations_
--   rls_capture). Returns the caller's user_roles.company text.
-- • All 3 {public} policies confirmed present in production policy
--   dump (B155 audit Phase 2).
--
-- ── BAR-2 ADJACENT NOT IN THIS COMMIT ───────────────────────────────
-- This commit only handles companies + properties + platform_settings
-- anon over-read. The broader B155.2 transcription arc (~37 Dashboard-
-- only policies across the other tables, with {public}→{authenticated}
-- normalization) is still queued.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. BEGIN/COMMIT atomic. All DDL idempotent
-- (DROP POLICY IF EXISTS + DROP FUNCTION IF EXISTS + CREATE). Safe
-- to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1-3 — Drop the 3 {public} over-read policies
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS all_read_active_companies ON companies;
DROP POLICY IF EXISTS public_read_active_properties ON properties;
DROP POLICY IF EXISTS all_read_platform_settings ON platform_settings;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — authenticated_read_own_company (bootstrap-chain replacement)
-- ════════════════════════════════════════════════════════════════════
-- Admits ANY authenticated role reading their own company's row by
-- name match via get_my_company(). Side-bonus: blocks cross-company
-- reads by non-admin/non-CA roles (previously admitted by the {public}
-- all-read).
--
-- Why this admits all columns (not just safe ones): a user reading
-- their OWN company's data has legitimate need-to-know for the full
-- row (CA portal, dunning banner state, billing portal embed). The
-- defense is at the RPC layer for ANON; for authenticated reads of
-- one's own row, the row-level filter is the right granularity.

DROP POLICY IF EXISTS authenticated_read_own_company ON companies;
CREATE POLICY authenticated_read_own_company ON companies
  FOR SELECT TO authenticated
  USING (name ~~* get_my_company());

-- ════════════════════════════════════════════════════════════════════
-- PART 4b — resident_read_own_properties (resident portal preservation)
-- ════════════════════════════════════════════════════════════════════
-- Pre-flight verify caught: residents had ZERO policies on properties
-- in the production dump (the policy set is admin_all / company_admin_
-- own / driver_read_own / manager_read_own / public_read_active /
-- manager_update). The {public} all-read was the silent admit for
-- /resident:102's pm_name + pm_email fetch. Dropping it without
-- replacement zeroes the resident portal property-manager-contact
-- display — an A1-path regression (resident self-service is core).
--
-- Mirrors resident_read_own_spaces verbatim (existing pattern on the
-- spaces table). Normalized to {authenticated} per the role-grant
-- discipline established in B155.1.
--
-- Behavior: a resident sees ONLY properties whose name matches the
-- residents.property column for their email. Same row-set the {public}
-- policy would have shown them (residents don't typically need to see
-- properties they aren't registered at). Cross-property reads stay
-- closed.

DROP POLICY IF EXISTS resident_read_own_properties ON properties;
CREATE POLICY resident_read_own_properties ON properties
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'resident'
    AND name IN (
      SELECT residents.property FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email')
    )
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 5a — get_company_branding(p_name TEXT)
-- ════════════════════════════════════════════════════════════════════
-- Safe-column projection for /visitor + /visitor-select anon reads.
-- Returns 0 or 1 row (LIMIT 1; collisions on name are out-of-scope —
-- properties.name + companies.name treated as effectively unique).

DROP FUNCTION IF EXISTS public.get_company_branding(TEXT);
CREATE FUNCTION public.get_company_branding(p_name TEXT)
RETURNS TABLE (
  id            BIGINT,
  name          TEXT,
  display_name  TEXT,
  logo_url      TEXT,
  theme         TEXT,
  support_phone TEXT,
  support_email TEXT,
  support_website TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT c.id, c.name, c.display_name, c.logo_url, c.theme,
         c.support_phone, c.support_email, c.support_website
  FROM companies c
  WHERE c.name ILIKE p_name
    AND c.is_active = TRUE
  LIMIT 1;
$func$;
REVOKE EXECUTE ON FUNCTION public.get_company_branding(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_branding(TEXT) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 5b — get_property_for_visitor(p_name TEXT)
-- ════════════════════════════════════════════════════════════════════
-- Single-property lookup by exact name for /visitor flow. Returns the
-- minimal linkage (id, name, company text). Anon does not see pm_email,
-- pm_phone, address, auth_*, visitor_pass_limit, exempt_plates.

DROP FUNCTION IF EXISTS public.get_property_for_visitor(TEXT);
CREATE FUNCTION public.get_property_for_visitor(p_name TEXT)
RETURNS TABLE (id BIGINT, name TEXT, company TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT p.id, p.name, p.company
  FROM properties p
  WHERE p.name ILIKE p_name
    AND p.is_active = TRUE
  LIMIT 1;
$func$;
REVOKE EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 5c — get_properties_for_visitor_select(p_company TEXT)
-- ════════════════════════════════════════════════════════════════════
-- LIST shape for /visitor-select. p_company nullable — when null,
-- returns all active properties. When set, filters case-insensitively
-- by company (mirrors the existing .ilike('company', company) pattern).
-- Returns minimal linkage; no PII.

DROP FUNCTION IF EXISTS public.get_properties_for_visitor_select(TEXT);
CREATE FUNCTION public.get_properties_for_visitor_select(p_company TEXT DEFAULT NULL)
RETURNS TABLE (id BIGINT, name TEXT, company TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT p.id, p.name, p.company
  FROM properties p
  WHERE p.is_active = TRUE
    AND (p_company IS NULL OR p.company ILIKE p_company)
  ORDER BY p.name;
$func$;
REVOKE EXECUTE ON FUNCTION public.get_properties_for_visitor_select(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_properties_for_visitor_select(TEXT) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 5d — get_platform_defaults()
-- ════════════════════════════════════════════════════════════════════
-- Returns the 5 default-* fields that company-bootstrap.ts:87 + lib/
-- logo.ts + visitor:33 consume. Covers every field bootstrap reads
-- (verified by enumeration in synthesis):
--   default_logo_url   → bootstrap:91 (logo fallback)
--   default_theme      → bootstrap:93 (theme fallback)
--   default_support_phone   → bootstrap:94 (phone fallback) + visitor:33
--   default_support_email   → bootstrap:95 (email fallback) + visitor:33
--   default_support_website → bootstrap:96 (website fallback) + visitor:33
-- Future fields added to platform_settings do NOT auto-leak via this
-- RPC — must be explicitly added to the return signature.

DROP FUNCTION IF EXISTS public.get_platform_defaults();
CREATE FUNCTION public.get_platform_defaults()
RETURNS TABLE (
  default_logo_url        TEXT,
  default_theme           TEXT,
  default_support_phone   TEXT,
  default_support_email   TEXT,
  default_support_website TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT default_logo_url, default_theme,
         default_support_phone, default_support_email, default_support_website
  FROM platform_settings
  WHERE id = 1;
$func$;
REVOKE EXECUTE ON FUNCTION public.get_platform_defaults() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_defaults() TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 5e — get_platform_flags()
-- ════════════════════════════════════════════════════════════════════
-- Dormancy flag accessor. Called by lib/platform-flags.ts (which is
-- called by route-side dormancy checks in /api/signup/create-checkout-
-- session, /api/proposal-codes/start-billing, and the webhook handler).
-- Returns ONLY the 2 flags — future platform_settings columns don't
-- auto-leak through this path.

DROP FUNCTION IF EXISTS public.get_platform_flags();
CREATE FUNCTION public.get_platform_flags()
RETURNS TABLE (
  stripe_billing_enabled BOOLEAN,
  public_signup_open     BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT stripe_billing_enabled, public_signup_open
  FROM platform_settings
  WHERE id = 1;
$func$;
REVOKE EXECUTE ON FUNCTION public.get_platform_flags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_flags() TO anon, authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Confirm the 3 over-read policies are GONE ───────────────────
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND policyname IN (
--       'all_read_active_companies',
--       'public_read_active_properties',
--       'all_read_platform_settings'
--     );
--   -- Expected: 0 rows.
--
-- ── B. Confirm authenticated_read_own_company created ──────────────
--   SELECT policyname, cmd, roles, qual
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'companies'
--     AND policyname = 'authenticated_read_own_company';
--   -- Expected: 1 row — SELECT | {authenticated} | (name ~~* get_my_company())
--
-- ── C. Confirm 5 RPCs exist with correct grants ────────────────────
--   SELECT routine_name, security_type
--   FROM information_schema.routines
--   WHERE routine_schema = 'public'
--     AND routine_name IN (
--       'get_company_branding',
--       'get_property_for_visitor',
--       'get_properties_for_visitor_select',
--       'get_platform_defaults',
--       'get_platform_flags'
--     )
--   ORDER BY routine_name;
--   -- Expected: 5 rows, all security_type='DEFINER'.
--
--   SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name LIKE 'get_company_branding'
--     OR routine_name LIKE 'get_property_for_visitor'
--     OR routine_name LIKE 'get_properties_for_visitor_select'
--     OR routine_name LIKE 'get_platform_defaults'
--     OR routine_name LIKE 'get_platform_flags'
--   ORDER BY routine_name, grantee;
--   -- Expected: anon + authenticated EXECUTE on each (5 × 2 = 10 rows;
--   -- PUBLIC should NOT appear).
--
-- ── D. Probe (script-driven, see scripts/_b155_3_probe.ts) ─────────
-- Load-bearing assertions split between security NEG + bootstrap POS:
--   NEG (anon over-read closed):
--     • anon SELECT * on companies / properties / platform_settings → 0 rows
--     • anon SELECT sensitive specific columns (stripe_customer_id,
--       pm_email) → 0 rows
--   POS (anon RPCs serve the visitor flow):
--     • anon rpc(get_company_branding) → safe-column row only
--     • anon rpc(get_property_for_visitor) + (get_properties_for_
--       visitor_select) → linkage rows
--     • anon rpc(get_platform_defaults + get_platform_flags) → fields
--   POS (authenticated bootstrap-chain still works):
--     • driver-role direct SELECT on own company → row admitted
--     • manager-role direct SELECT on own company → row admitted
--     • driver tdlr_license_number fetch (driver:129 path) → works
--   NEG (authenticated cross-company tightening):
--     • driver-of-A direct SELECT on Company B → 0 rows
--
-- ── ROLLBACK STAGED (run only if probe POS fails on apply) ──────────
--   CREATE POLICY all_read_active_companies ON companies
--     FOR SELECT TO public USING (is_active = true);
--   CREATE POLICY public_read_active_properties ON properties
--     FOR SELECT TO public USING (is_active = true);
--   CREATE POLICY all_read_platform_settings ON platform_settings
--     FOR SELECT TO public USING (true);
--   -- Optional full revert:
--   DROP POLICY IF EXISTS authenticated_read_own_company ON companies;
--   DROP POLICY IF EXISTS resident_read_own_properties ON properties;
--   DROP FUNCTION IF EXISTS public.get_company_branding(TEXT);
--   DROP FUNCTION IF EXISTS public.get_property_for_visitor(TEXT);
--   DROP FUNCTION IF EXISTS public.get_properties_for_visitor_select(TEXT);
--   DROP FUNCTION IF EXISTS public.get_platform_defaults();
--   DROP FUNCTION IF EXISTS public.get_platform_flags();
-- ════════════════════════════════════════════════════════════════════
