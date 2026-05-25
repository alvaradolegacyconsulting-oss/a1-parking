-- ════════════════════════════════════════════════════════════════════
-- B113 commit 1 — enforce_resident_limit() trigger
-- Drafted: 2026-05-26 — NOT YET APPLIED.
--
-- First commit of the B113 bulk upload arc. Single-purpose migration:
-- ship the per-row resident-limit trigger to maintain 3-layer cap
-- enforcement parity with drivers + properties before B113 commit 3's
-- bulk insert path exercises it.
--
-- ── AUDIT-PASS RESULTS CONSUMED (Jose-run 2026-05-26) ────────────────
-- AP.2 confirmed ZERO triggers on the residents table — not just
-- enforce_resident_limit() missing; no triggers at all. UAT TC-403's
-- reference to "existing tier-cap DB trigger" was aspirational. Without
-- this migration, B113 bulk uploads would have Layer 1 (pre-upload
-- validation in app code) + Layer 2 (isUnderLimit() in app code) but
-- no Layer 3 — meaning a SQL-bypass attempt would silently exceed cap.
--
-- This migration restores parity:
--   • enforce_property_limit() — already in production (20260508 PART 6)
--   • enforce_driver_limit()   — already in production (20260517 PART 2)
--   • enforce_resident_limit() — added here, mirrors driver shape exactly
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. get_company_resident_limit(p_company_name TEXT) — helper that
--      returns the per-tier resident cap (-1 = unlimited). Mirrors
--      get_company_driver_limit() / get_company_property_limit() shape.
--      Per-tier values are STARTERS proposed for Jose review BEFORE
--      apply — see PROPOSED VALUES section below + confirm/adjust in
--      the CASE statement before pasting into SQL Editor.
--
--   2. enforce_resident_limit() trigger function — mirrors
--      enforce_driver_limit() (20260517 lines 95-167) byte-for-byte
--      except for entity name + cap-function reference. Includes the
--      same admin-bypass branch (super_admin can override via SQL
--      Editor for support-case provisioning), same proposal_codes
--      override read from feature_overrides JSONB, same error message
--      + HINT format. is_active=TRUE count predicate matches sibling
--      triggers — pending residents (is_active=FALSE) don't count
--      against cap until manager approval flips them active.
--
--   3. resident_limit_check trigger — BEFORE INSERT on residents,
--      FOR EACH ROW, EXECUTE FUNCTION enforce_resident_limit().
--      Trigger name mirrors driver_limit_check / property_limit_check
--      naming convention.
--
--   4. GRANT discipline (tighter than existing limit functions):
--      REVOKE EXECUTE FROM PUBLIC on the helper — no business reason
--      for users to query their own tier limit via direct RPC
--      (tier-config.ts is the client-side source of truth). Trigger
--      function doesn't need user GRANTs (Postgres invokes via trigger
--      machinery). Sets a slightly tighter precedent than the existing
--      driver/property helpers, which predate the B82/named-5 REVOKE-
--      from-PUBLIC discipline — those pre-existing helpers stay as-is
--      (separate retrofit if ever needed; not in scope here).
--
-- ── PROPOSED VALUES (FLAGGED FOR JOSE REVIEW) ───────────────────────
-- Starter values inferred from property:resident ratios. Adjust before
-- applying if your business model needs different numbers. The SQL
-- function is the ONLY source of truth until B113 commit 2 ships the
-- TypeScript MAX_RESIDENTS flag — when commit 2 lands, the TS values
-- MUST match these SQL values or you'll get drift (see tier-config.ts
-- header lines 5-9 for the standing drift-risk note).
--
--   ENF Starter         (5 props)   →   50 residents  (~10 per property)
--   ENF Growth         (15 props)   →  250 residents  (~17 per property)
--   ENF Legacy/Premium (unlimited)  →   -1
--   PM Essential        (3 props)   →  150 residents  (~50 per property)
--   PM Professional    (10 props)   →  750 residents  (~75 per property)
--   PM Enterprise      (unlimited)  →   -1
--
-- A1 Wrecker migration (B113 primary near-term consumer) sits in ENF
-- Legacy → unlimited; these caps don't constrain them. The caps
-- matter for future self-serve customers on lower tiers.
--
-- ── DEPENDENCIES (verified via AP audit) ─────────────────────────────
-- • residents table exists (long-standing; columns include company TEXT,
--   is_active BOOLEAN, status TEXT)
-- • companies.tier + tier_type populated (read by the helper)
-- • proposal_codes.feature_overrides JSONB (read by trigger for
--   per-company override via 'max_residents' key — same pattern as
--   enforce_driver_limit reads 'max_drivers')
-- • get_my_role() helper function in place (admin-bypass check)
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • MAX_RESIDENTS TypeScript feature flag in feature-flags.ts +
--   tier-config.ts — B113 commit 2.
-- • Bulk upload UI + API route — B113 commit 3.
-- • Backfill of existing residents (no backfill needed — trigger only
--   fires on NEW inserts; existing rows unaffected).
-- • Retrofit of existing get_company_driver_limit / property_limit /
--   enforce_driver_limit / enforce_property_limit with REVOKE-from-
--   PUBLIC discipline — pre-existing functions stay as-is; out of scope.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. BEGIN/COMMIT atomic. Function
-- bodies use $func$ tagged dollar-quote delimiters per
-- feedback_sql_editor_dollar_quote_parsing (bare $$ can be smart-split
-- by the SQL Editor's tokenizer). DO block for trigger existence check
-- also uses $func$. All DDL idempotent (CREATE OR REPLACE FUNCTION /
-- DROP TRIGGER IF EXISTS + CREATE). Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — get_company_resident_limit() helper
-- ════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER so the trigger (also SECURITY DEFINER) can call it
-- without permission concerns. Returns -1 for unknown company (don't
-- block — consistent with property/driver helpers' unknown-company
-- handling).
--
-- Per-tier CASE values are PROPOSED STARTERS (see header). Adjust
-- before applying if Jose's pricing model needs different numbers.

CREATE OR REPLACE FUNCTION get_company_resident_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
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
    RETURN -1; -- unknown company → don't block (consistent w/ sibling helpers)
  END IF;

  RETURN CASE
    WHEN v_tier_type = 'enforcement' AND v_tier = 'starter'      THEN 50
    WHEN v_tier_type = 'enforcement' AND v_tier = 'growth'       THEN 250
    WHEN v_tier_type = 'enforcement' AND v_tier = 'legacy'       THEN -1
    WHEN v_tier_type = 'enforcement' AND v_tier = 'premium'      THEN -1
    WHEN v_tier_type = 'property_management' AND v_tier = 'essential'    THEN 150
    WHEN v_tier_type = 'property_management' AND v_tier = 'professional' THEN 750
    WHEN v_tier_type = 'property_management' AND v_tier = 'enterprise'   THEN -1
    ELSE -1
  END;
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — enforce_resident_limit() trigger function
-- ════════════════════════════════════════════════════════════════════
-- Mirrors enforce_driver_limit() (20260517 PART 2) byte-for-byte
-- except for entity name + cap-function reference. Reads
-- proposal_codes.feature_overrides['max_residents'] as per-company
-- override (same pattern as drivers reading 'max_drivers').
--
-- Admin bypass: get_my_role() = 'admin' returns NEW without enforcement.
-- This matches the driver/property triggers' admin-bypass branch —
-- super_admin needs SQL Editor flexibility for support-case provisioning.
-- company_admin does NOT match get_my_role() = 'admin'; bulk uploads
-- via /api/billing/bulk-invite (B113 commit 3) DO enforce this trigger.

CREATE OR REPLACE FUNCTION enforce_resident_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company_id BIGINT;
  v_limit INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_active_count INTEGER;
BEGIN
  -- Admin bypass (mirrors driver/property triggers).
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
    SELECT (feature_overrides ->> 'max_residents')
    INTO v_override_text
    FROM proposal_codes
    WHERE company_id = v_company_id
      AND status = 'redeemed'
      AND feature_overrides ? 'max_residents'
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
    v_limit := get_company_resident_limit(NEW.company);
  END IF;

  IF v_limit < 0 THEN
    RETURN NEW; -- unlimited
  END IF;

  SELECT COUNT(*)
  INTO v_active_count
  FROM residents
  WHERE company ILIKE NEW.company
    AND is_active = TRUE;

  IF v_active_count >= v_limit THEN
    RAISE EXCEPTION 'Resident limit exceeded: tier allows % active residents for %', v_limit, NEW.company
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override.',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — resident_limit_check BEFORE INSERT trigger
-- ════════════════════════════════════════════════════════════════════
-- DROP-then-CREATE idiom matches sibling trigger registrations
-- (driver_limit_check, property_limit_check). Re-apply-safe because
-- DROP TRIGGER IF EXISTS doesn't error on missing trigger.

DROP TRIGGER IF EXISTS resident_limit_check ON residents;
CREATE TRIGGER resident_limit_check
BEFORE INSERT ON residents
FOR EACH ROW
EXECUTE FUNCTION enforce_resident_limit();

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — GRANT discipline
-- ════════════════════════════════════════════════════════════════════
-- REVOKE EXECUTE FROM PUBLIC on the helper. No explicit GRANT to
-- authenticated/anon — no user-facing code calls this function
-- directly; tier-config.ts is the client-side source of truth for
-- resident limits. postgres (owner) + service_role retain default
-- access for diagnostic queries.
--
-- The trigger function (enforce_resident_limit) is invoked by Postgres
-- via trigger machinery, not by user RPC calls — also tightened to
-- internal-only.
--
-- This is slightly tighter than the existing get_company_driver_limit
-- / property_limit / enforce_*_limit functions, which predate the
-- B82/named-5 REVOKE-from-PUBLIC discipline. Those pre-existing
-- helpers stay as-is here (separate retrofit if ever needed; not in
-- B113 scope). Per feedback_function_public_grant_supabase_default.md:
-- new SECURITY DEFINER helpers post-2026-05-26 follow this pattern.

REVOKE EXECUTE ON FUNCTION public.get_company_resident_limit(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_resident_limit() FROM PUBLIC;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── VQ.A — get_company_resident_limit function exists with correct shape
--   SELECT proname, prosecdef AS is_security_definer,
--          pg_get_function_arguments(oid) AS args,
--          pg_get_function_result(oid) AS returns
--   FROM pg_proc WHERE proname = 'get_company_resident_limit';
--   -- Expected: 1 row
--   --   get_company_resident_limit | t | p_company_name text | integer
--
-- ── VQ.B — helper returns expected values per tier
-- Sanity-check the CASE branches with companies of known tiers.
-- If none exist for a tier, the WHERE filters to LIMIT 1 — adjust the
-- name filter to a real company in your DB. NULL company input returns
-- -1 (unknown).
--   SELECT name, tier, tier_type, get_company_resident_limit(name) AS resident_cap
--   FROM companies
--   ORDER BY tier_type, tier
--   LIMIT 20;
--   -- Expected: cap matches PROPOSED VALUES table in header for each
--   --   tier combination. -1 for legacy/premium/enterprise.
--
-- ── VQ.C — enforce_resident_limit trigger function exists
--   SELECT proname, prosecdef FROM pg_proc
--   WHERE proname = 'enforce_resident_limit';
--   -- Expected: 1 row, is_security_definer = t
--
-- ── VQ.D — resident_limit_check trigger registered on residents
--   SELECT tgname, tgtype, tgenabled
--   FROM pg_trigger
--   WHERE tgrelid = 'public.residents'::regclass
--     AND tgname = 'resident_limit_check';
--   -- Expected: 1 row, tgenabled = O (enabled by default).
--
-- ── VQ.E — existing residents row count unchanged (sanity)
-- Migration adds trigger only; no INSERT/UPDATE/DELETE on rows.
--   SELECT COUNT(*) FROM residents;
--   -- Expected: same count as pre-migration.
--
-- ── VQ.F — GRANT discipline verified
--   SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name IN ('get_company_resident_limit', 'enforce_resident_limit')
--   ORDER BY routine_name, grantee;
--   -- Expected: NO rows with grantee='PUBLIC' for either function.
--   --   postgres + service_role retain default access (may or may not
--   --   appear depending on Supabase's grant pipeline; the load-bearing
--   --   check is that PUBLIC is absent).
--
-- ── VQ.G — negative test: trigger rejects insert over cap
-- Pick a company on a CAPPED tier (Starter / Growth / Essential /
-- Professional — NOT Legacy/Premium/Enterprise). Fill its residents
-- count to N where N = the tier's cap (via the existing super_admin
-- bulk path, or seed manually). Then attempt one more INSERT — should
-- fail with the trigger's error message.
--
-- Run as service_role (residents RLS gates non-admin/non-company-admin
-- INSERTs).
--
--   -- Substitute <COMPANY_NAME> with a real capped-tier company:
--   INSERT INTO residents (email, name, company, property, unit, is_active, status)
--   VALUES (
--     'cap-overflow-test@example.com',
--     'Cap Overflow Test',
--     '<COMPANY_NAME>',
--     'Test Property',
--     '1',
--     true,           -- is_active=true so trigger counts it
--     'active'
--   );
--   -- Expected: red error in SQL Editor —
--   --   "ERROR: Resident limit exceeded: tier allows N active residents for <COMPANY_NAME>"
--   --   HINT: Upgrade tier or contact support@shieldmylot.com to issue
--   --         a proposal_code override.
--   --
--   -- Note: this test only fires once the company is at its cap. If
--   -- the company is below cap, the INSERT succeeds (and you should
--   -- clean it up before proceeding). For a synthetic test without
--   -- filling the table to cap, temporarily REVOKE admin role from
--   -- your session is impractical; the cleaner path is to verify on
--   -- a fixture company that's already near-cap, or accept that VQ.G
--   -- is a "real-world acceptance" check rather than a synthetic one.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent:
--   • CREATE OR REPLACE FUNCTION (× 2; replaces in place)
--   • DROP TRIGGER IF EXISTS + CREATE TRIGGER (re-apply-safe)
--   • REVOKE EXECUTE FROM PUBLIC (no-op if already revoked)
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
