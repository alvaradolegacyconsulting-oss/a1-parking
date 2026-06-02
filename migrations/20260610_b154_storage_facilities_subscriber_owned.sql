-- ════════════════════════════════════════════════════════════════════
-- B154 — Storage facilities subscriber-ownership
-- Drafted: 2026-06-02 — NOT YET APPLIED.
--
-- Moves storage_facilities from platform-wide-shared (old model: global
-- read for any authenticated user, write restricted to super-admin) to
-- subscriber-owned (each company manages its own facilities; cross-
-- company isolation enforced at RLS layer).
--
-- ── DECISION CONTEXT (from pre-flight, Jose-locked) ─────────────────
-- • Scope by company TEXT column, not company_id FK. Matches the house
--   pattern across 13+ existing scoped tables (properties, drivers,
--   residents, vehicles, etc.) — all use `company ~~* get_my_company()`.
--   Mixing patterns is the drift we've been avoiding.
-- • Backfill α: DELETE the 2 unattributable May test fixtures (ids 8
--   and 9 — "Demo Towing Yard" and "Edge Case Tow Yard"). They have
--   no audit trail attributing them to any company. A1 hasn't
--   onboarded yet; new facilities get company set on insert.
-- • Read surfaces: belt-and-suspenders (RLS does the scoping AND
--   explicit .eq('company', myCompany) filters on 3 read sites per
--   the Class-B-defensive-legibility principle that produced B150).
-- • Retires the old shared-pool model entirely. B96 favorites
--   scaffolding never landed in code — nothing to clean up there.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. Add company TEXT column (nullable initially — house pattern).
--   2. Backfill α: DELETE the 2 test fixtures.
--   3. Drop authenticated_read_facilities (the global-read leak —
--      confirmed in the policy dump as `auth.role() = 'authenticated'`
--      → any logged-in user sees all rows, the leak).
--      Keep admin_all_facilities (super-admin escape, already correct).
--   4. Add 4 company-scoped policies modeled on drivers/properties:
--      • company_admin_own_facilities — ALL (CRUD) on own company
--      • driver_read_own_facilities — SELECT on own company
--      • manager_read_own_facilities — SELECT on own company
--      • leasing_agent_read_own_facilities — SELECT on own company
--      Resident role NOT granted access — residents have no business
--      seeing tow-storage facilities.
--
-- ── RLS PATTERN MIRRORS company_admin_own_drivers VERBATIM ──────────
-- Per Jose's pattern-confirmation: get_my_role() + get_my_company()
-- helpers, one ALL policy per role, company match via `~~*` (case-
-- insensitive LIKE), admin_all_* as super-admin hatch. No new helpers
-- invented; helper bodies unchanged.
--
-- ── COMPANY COLUMN — NULLABLE OR NOT NULL? ──────────────────────────
-- Left NULLABLE for v1, per Jose's "(4) optionally NOT NULL once
-- backfilled" deferral. Sharp edge: admin-created facilities don't
-- currently set company (admin form has no company field), so admin
-- creates would land with company=NULL. Those rows are invisible to
-- CAs (NULL ~~* anything → NULL, treated as false), visible only to
-- super-admin via admin_all_facilities. CA INSERT path explicitly
-- sets company=role.company (code change in this commit) so it can
-- never create orphans. NOT NULL hardening + admin-form company-
-- select are a clean follow-up if/when admin creates real platform-
-- pool facilities.
--
-- ── B155 — DASHBOARD-ONLY RLS DRIFT (audit follow-up, not this commit) ─
-- This migration captures storage_facilities' RLS as proper migration
-- source for the first time. But the audit pass found drift: the
-- original storage_facilities policies live only in the Supabase
-- Dashboard, not in any repo migration. B155 = audit ALL public tables
-- for the same pattern; surface undocumented security posture as a
-- proper migration-source backlog.
--
-- ── DEPENDENCIES ─────────────────────────────────────────────────────
-- • get_my_role() function exists in production (per Jose's dump).
-- • get_my_company() function exists (per dump).
-- • admin_all_facilities policy exists (per dump; KEEP unchanged).
-- • authenticated_read_facilities policy exists (per dump; DROP).
-- • No other storage_facilities policies were in the dump.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Open Supabase SQL Editor, paste this entire
-- file as ONE block, click Run ONCE. BEGIN/COMMIT atomic — any
-- statement failing rolls back the entire migration. All DDL idempotent
-- (DROP POLICY IF EXISTS / CREATE POLICY guarded by name). DO blocks
-- use $func$ tagged dollar-quote per the SQL Editor partial-apply
-- discipline (feedback-sql-editor-dollar-quote-parsing).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Add company TEXT column (nullable)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE storage_facilities
  ADD COLUMN IF NOT EXISTS company TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — Backfill α: delete the 2 unattributable test fixtures
-- ════════════════════════════════════════════════════════════════════
-- Per pre-flight: rows 8 and 9 are May-era test data with no audit
-- attribution and no company column. A1 hasn't onboarded. Clean start.
-- If either row has been deleted already (e.g., during the pre-launch
-- wipe), the DELETE is a no-op.

DELETE FROM storage_facilities WHERE id IN (8, 9);

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Drop the global-read leak
-- ════════════════════════════════════════════════════════════════════
-- authenticated_read_facilities was the old shared-pool policy:
-- `auth.role() = 'authenticated'` → any logged-in user, any company,
-- sees all rows. Retired. admin_all_facilities stays — super-admin
-- escape hatch.

DROP POLICY IF EXISTS authenticated_read_facilities ON storage_facilities;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Company-scoped policies (4 new, mirroring drivers pattern)
-- ════════════════════════════════════════════════════════════════════
-- All policies use get_my_role() + get_my_company() (existing helpers
-- per the pattern dump). Match expression `company ~~* get_my_company()`
-- = case-insensitive LIKE, identical to company_admin_own_drivers.

-- 4a — company_admin full CRUD on own company's facilities.
-- USING gates reads (filter); WITH CHECK gates writes (cannot insert
-- or update INTO a different company's scope).
DO $func$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'storage_facilities'
      AND policyname = 'company_admin_own_facilities'
  ) THEN
    DROP POLICY company_admin_own_facilities ON storage_facilities;
  END IF;
END $func$;

CREATE POLICY company_admin_own_facilities ON storage_facilities
  FOR ALL TO authenticated
  USING       (get_my_role() = 'company_admin' AND company ~~* get_my_company())
  WITH CHECK  (get_my_role() = 'company_admin' AND company ~~* get_my_company());

-- 4b — driver SELECT on own company's facilities (for the tow-ticket
-- facility selector at driver/page.tsx:175).
DO $func$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'storage_facilities'
      AND policyname = 'driver_read_own_facilities'
  ) THEN
    DROP POLICY driver_read_own_facilities ON storage_facilities;
  END IF;
END $func$;

CREATE POLICY driver_read_own_facilities ON storage_facilities
  FOR SELECT TO authenticated
  USING (get_my_role() = 'driver' AND company ~~* get_my_company());

-- 4c — manager SELECT on own company's facilities.
DO $func$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'storage_facilities'
      AND policyname = 'manager_read_own_facilities'
  ) THEN
    DROP POLICY manager_read_own_facilities ON storage_facilities;
  END IF;
END $func$;

CREATE POLICY manager_read_own_facilities ON storage_facilities
  FOR SELECT TO authenticated
  USING (get_my_role() = 'manager' AND company ~~* get_my_company());

-- 4d — leasing_agent SELECT on own company's facilities.
DO $func$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'storage_facilities'
      AND policyname = 'leasing_agent_read_own_facilities'
  ) THEN
    DROP POLICY leasing_agent_read_own_facilities ON storage_facilities;
  END IF;
END $func$;

CREATE POLICY leasing_agent_read_own_facilities ON storage_facilities
  FOR SELECT TO authenticated
  USING (get_my_role() = 'leasing_agent' AND company ~~* get_my_company());

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Column exists + correct shape ───────────────────────────────
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'storage_facilities'
--     AND column_name = 'company';
--   -- Expected 1 row: company | text | YES
--
-- ── B. 0 rows post-backfill (verify the DELETE landed) ─────────────
--   SELECT COUNT(*) FROM storage_facilities WHERE id IN (8, 9);
--   -- Expected: 0
--
--   SELECT COUNT(*) FROM storage_facilities WHERE company IS NULL;
--   -- Expected: 0 (post-DELETE, no rows remain so trivially 0)
--
-- ── C. Policies dump for storage_facilities ─────────────────────────
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'storage_facilities'
--   ORDER BY policyname;
--   -- Expected 5 rows:
--   --   admin_all_facilities                    | ALL     | ... (super-admin escape, unchanged)
--   --   company_admin_own_facilities            | ALL     | authenticated | get_my_role()='company_admin' AND ... | same
--   --   driver_read_own_facilities              | SELECT  | authenticated | get_my_role()='driver' AND ...        | null
--   --   leasing_agent_read_own_facilities       | SELECT  | authenticated | get_my_role()='leasing_agent' AND ... | null
--   --   manager_read_own_facilities             | SELECT  | authenticated | get_my_role()='manager' AND ...       | null
--   -- authenticated_read_facilities should NOT appear (dropped).
--
-- ── D. Smoke probe (script-driven, see scripts/_b154_probe.ts) ─────
-- The load-bearing negative case is cross-company isolation:
--   • CA_A cannot see, INSERT into, UPDATE, or DELETE company B's facilities.
--   • driver_A sees only company A's facilities.
-- Plus the CA-INSERT-gap closure: CA can now create facilities scoped
-- to their own company.
-- ════════════════════════════════════════════════════════════════════
