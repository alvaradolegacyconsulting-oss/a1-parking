-- ════════════════════════════════════════════════════════════════════
-- B40 + B43 — Capture-pass: RLS on violations table + 3 SECURITY
-- DEFINER helpers it references
-- Drafted: May 18, 2026 — NOT YET APPLIED.
--
-- Documents production-state RLS on the violations table plus the
-- three SECURITY DEFINER helper functions (get_my_role,
-- get_my_company, get_my_properties) that the policies reference.
-- All five policies + all three helpers were created via the Supabase
-- Dashboard during early platform setup and have lived only in the
-- DB until now. This migration captures the production shape verbatim
-- so a restore-from-migrations scenario reproduces violations RLS
-- correctly.
--
-- Idempotent re-apply: helpers use CREATE OR REPLACE FUNCTION (no
-- DROP — preserves dependent policies during re-apply when signatures
-- match). Policies use DROP IF EXISTS + CREATE POLICY (safe re-create
-- on existing policy names). The COMMIT is atomic — any parse or
-- type-mismatch failure rolls back the entire transaction and
-- production state remains intact.
--
-- ── ORDERING ────────────────────────────────────────────────────────
-- Helper functions are defined BEFORE the policies that reference
-- them. Postgres defers function-existence checks to query
-- evaluation, not policy creation — but ordering by dependency keeps
-- the migration self-documenting and matches what a fresh restore
-- would need.
--
-- ── VERBATIM NOTES ──────────────────────────────────────────────────
--   - `~~*` is Postgres's case-insensitive LIKE (equivalent to ILIKE).
--     pg_get_expr() output emits `~~*` so we preserve it.
--   - `::text` casts on string literals are pg_get_expr normalization
--     artifacts. Preserved for verbatim fidelity.
--   - Manager policy uses `get_my_properties()` (plural, returns
--     text[]). Resident policy reads `auth.jwt() ->> 'email'`
--     directly — no `get_my_email()` helper exists in production.
--   - Helper bodies are byte-for-byte from pg_get_functiondef()
--     captured 2026-05-18, except the deliberate STABLE divergence
--     noted on get_my_role below.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART B43 — SECURITY DEFINER helpers (defined first; referenced below)
-- ════════════════════════════════════════════════════════════════════

-- ── get_my_company() ────────────────────────────────────────────────
-- Returns the company name string for the calling user, resolved via
-- user_roles + JWT email. Referenced by violations company_admin /
-- driver policies + photo/video INSERT/UPDATE policies + Phase 2a
-- triggers.
CREATE OR REPLACE FUNCTION public.get_my_company()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT company FROM user_roles
  WHERE email ILIKE auth.jwt()->>'email'
  LIMIT 1;
$function$;

-- ── get_my_properties() ─────────────────────────────────────────────
-- Returns the text[] of property names the calling manager is
-- assigned to. Referenced by manager violations policy. The
-- user_roles.property column is text[]; the function returns the row
-- as-is.
CREATE OR REPLACE FUNCTION public.get_my_properties()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT property FROM user_roles
  WHERE email ILIKE auth.jwt()->>'email'
  LIMIT 1;
$function$;

-- B43 NOTE: Production state had SECURITY DEFINER without STABLE.
-- This migration adds STABLE for consistency with the other two helpers
-- and to enable query planner caching during RLS policy evaluation.
-- Behavior is identical for correctness; only performance characteristic changes.
-- If a future capture-pass diff complains, this divergence is intentional.
CREATE OR REPLACE FUNCTION public.get_my_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT role FROM user_roles WHERE email ILIKE auth.jwt() ->> 'email' LIMIT 1
$function$;

-- ════════════════════════════════════════════════════════════════════
-- PART B40 — violations table RLS policies
-- Captured verbatim from production via pg_get_expr() on May 18, 2026.
-- Five policies: four FOR ALL and one FOR SELECT (resident).
-- All policies omit WITH CHECK explicitly — Postgres defaults
-- WITH CHECK to match USING for FOR ALL, matching production's
-- NULL with_check_expr.
-- ════════════════════════════════════════════════════════════════════

-- Idempotent: ensure RLS enabled (Dashboard already enabled it).
ALTER TABLE violations ENABLE ROW LEVEL SECURITY;

-- ── 1. admin_all_violations (FOR ALL) ───────────────────────────────
DROP POLICY IF EXISTS "admin_all_violations" ON violations;
CREATE POLICY "admin_all_violations" ON violations
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

-- ── 2. company_admin_own_violations (FOR ALL) ───────────────────────
DROP POLICY IF EXISTS "company_admin_own_violations" ON violations;
CREATE POLICY "company_admin_own_violations" ON violations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE (properties.company ~~* get_my_company())
    ))
  );

-- ── 3. driver_own_violations (FOR ALL) ──────────────────────────────
-- Driver scopes by company (NOT uploader). Per B25 locked decision
-- 2026-05-14: see memory/feedback_driver_photo_softdelete_scope.md.
DROP POLICY IF EXISTS "driver_own_violations" ON violations;
CREATE POLICY "driver_own_violations" ON violations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE (properties.company ~~* get_my_company())
    ))
  );

-- ── 4. manager_own_violations (FOR ALL) ─────────────────────────────
-- Uses get_my_properties() plural — manager may be assigned to
-- multiple properties; the helper returns text[]. The `~~* ANY (...)`
-- pattern allows case-insensitive matching against each element.
DROP POLICY IF EXISTS "manager_own_violations" ON violations;
CREATE POLICY "manager_own_violations" ON violations
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── 5. resident_own_violations (FOR SELECT only) ────────────────────
-- Resident sees violations on plates registered to their own vehicles,
-- joined through residents.email = JWT email. Three-hop chain:
-- violations.plate → vehicles.plate → vehicles.property → residents.
-- SELECT-only; residents cannot modify violations.
-- Reads JWT directly (no get_my_email helper).
DROP POLICY IF EXISTS "resident_own_violations" ON violations;
CREATE POLICY "resident_own_violations" ON violations
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'resident'::text)
    AND (plate IN (
      SELECT vehicles.plate FROM vehicles
      WHERE (vehicles.property IN (
        SELECT residents.property FROM residents
        WHERE (residents.email ~~* (auth.jwt() ->> 'email'::text))
      ))
    ))
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Policy inventory unchanged ───────────────────────────────────
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--   ORDER BY polname;
--   -- Expected 5 rows (polcmd: r=SELECT, *=ALL):
--   --   admin_all_violations            *
--   --   company_admin_own_violations    *
--   --   driver_own_violations           *
--   --   manager_own_violations          *
--   --   resident_own_violations         r
--
-- ── B. Policy expressions unchanged ─────────────────────────────────
--   SELECT polname,
--          pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy
--   WHERE polrelid = 'violations'::regclass
--   ORDER BY polname;
--   -- Each using_expr should byte-for-byte match the pre-apply
--   -- diagnostic output captured 2026-05-18.
--
-- ── C. Helper functions exist and are STABLE SECURITY DEFINER ───────
--   SELECT proname, prosecdef AS is_security_definer, provolatile
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('get_my_role','get_my_company','get_my_properties')
--   ORDER BY proname;
--   -- Expected:
--   --   get_my_company       t   s  (s = STABLE)
--   --   get_my_properties    t   s
--   --   get_my_role          t   s  ← STABLE was added by this migration
--   --                              (production was 'v' = VOLATILE before)
--
-- ── D. Inheritance smoke (from Commit A footer, step 6) ─────────────
-- As manager.bayou@demotowing.com:
--   SELECT COUNT(*) FROM violation_photos;
--   -- Expected: same count as the manager's visible violations would imply.
-- As resident1@demotowing.com:
--   SELECT COUNT(*) FROM violations;
--   -- Expected: rows only where plate matches a vehicle on a property
--   -- where resident is registered.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- Migration is documentation-only — no behavior change expected.
-- Only deliberate divergence: STABLE added to get_my_role (see B43
-- NOTE above the function). If verification B shows any divergence
-- between pre-apply diagnostic and post-apply pg_get_expr output,
-- rollback (Supabase point-in-time restore) and re-investigate the
-- divergence before re-applying.
-- ════════════════════════════════════════════════════════════════════
