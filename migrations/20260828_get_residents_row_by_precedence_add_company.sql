-- ══════════════════════════════════════════════════════════════════════
-- 20260828_get_residents_row_by_precedence_add_company.sql
--
-- 🟢 vehicles.company arc — COMMIT 2 (DB migration 1 of 2)
--
-- Extends public.get_residents_row_by_precedence(TEXT) to include the
-- new `company` column on its RETURNS TABLE, so the /register companion-
-- vehicle route can stamp v.company from the SAME residents-row
-- precedence resolution the rest of the helper already applies.
--
-- ── SHAPE (i) — WRAPPED DROP + CREATE — Mateo Aug 28 §1 ─────────────
--
-- CREATE OR REPLACE FUNCTION cannot change the return type. Adding a
-- column to RETURNS TABLE is a return-type change. So this is a DROP
-- followed by a CREATE, wrapped in BEGIN/COMMIT so they either succeed
-- together or roll back together. The wrap IS the safety property here
-- (precedent: 20260821_console_rpcs_enum_cast_fix.sql). The standing
-- "no BEGIN/COMMIT wrap" rule targets VERIFICATION files, where a
-- trailing COMMIT can mask an earlier failed SELECT — the verification
-- file for this migration remains unwrapped and returns a PASS row.
--
-- Shape (i) chosen over shape (ii) (create alongside, migrate, drop
-- later) because §A.2 showed ZERO SQL-side dependents and ONE
-- production caller. Additionally: the caller destructures
-- { email, unit, property } at companion-vehicle/route.ts:226 — adding
-- a fourth field is additive for a JS consumer (destructure ignores
-- what it doesn't name). Old client works against new function; the
-- only exposure is milliseconds inside the transaction.
--
-- ── EVERYTHING FROM §A.3 INVENTORY IS RE-DECLARED VERBATIM ──────────
--
--   LANGUAGE sql · STABLE · SECURITY DEFINER · SET search_path
--   4 grant/revoke statements (REVOKE PUBLIC + anon + authenticated;
--   GRANT service_role) · COMMENT ON FUNCTION.
--
-- No parameter DEFAULTs to preserve (p_email is a required TEXT).
--
-- ── PostgREST CACHE ─────────────────────────────────────────────────
--
-- PostgREST caches function signatures too. NOTIFY pgrst at the end
-- (Supabase auto-issues on DDL, explicit belt-and-braces). REST-side
-- verification runs via scripts/gate-get-residents-row-postgrest.ts,
-- BEFORE any Commit 2 consumer references the new shape. Same
-- discipline as G6 for the column, different object.
--
-- APPLY: single database, wrapped. Verification file returns PASS row
-- on 8 gates + JWT-not-needed execution gate (function is service_role
-- only + has no auth.jwt() body reads; SQL Editor context works).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── DROP the 3-column shape ─────────────────────────────────────────
DROP FUNCTION public.get_residents_row_by_precedence(TEXT);

-- ── CREATE the 4-column shape ───────────────────────────────────────
-- Body preserves the ORDER BY + LIMIT 1 precedence discipline verbatim.
-- The only change is adding `company` to the SELECT list + the
-- RETURNS TABLE column list.
CREATE FUNCTION public.get_residents_row_by_precedence(p_email TEXT)
RETURNS TABLE (
  email    TEXT,
  unit     TEXT,
  property TEXT,
  company  TEXT             -- 🟢 vehicles.company arc Commit 2 addition
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT email, unit, property, company
    FROM public.residents
    WHERE lower(email) = lower(p_email)
    ORDER BY public.resident_row_precedence(status, is_active), created_at DESC
    LIMIT 1;
$$;

-- ── Grants: verbatim from pre-drop state (§A.3) ─────────────────────
-- Function is INTERNAL SERVICE-ROLE ONLY — the (unit, property, company)
-- return values are the scope keys for the pending-vehicle insert, and
-- an email-parameter DEFINER is an information-leak footgun unless
-- restricted this way. Preserved verbatim from 20260808_get_residents_
-- row_by_precedence.sql.
REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_residents_row_by_precedence(TEXT) TO service_role;

-- ── COMMENT: re-issued (DROP wiped the previous one) ────────────────
COMMENT ON FUNCTION public.get_residents_row_by_precedence IS
  'Internal RPC for the server-side companion-vehicle proxy (app/api/register/companion-vehicle/route.ts). Returns a resident''s canonical (email, unit, property, company) row for a given lowered email using resident_row_precedence(status, is_active), created_at DESC. SERVICE_ROLE ONLY — the (unit, property, company) return values are the scope keys for the pending-vehicle insert, so leaking them enables misattribution; execute is REVOKED from PUBLIC, anon, and authenticated. If a second service-side caller emerges, GRANT here — do NOT re-implement the precedence in the caller (Mateo Aug 8 lock: one place, both call sites). 2026-08-28: added `company` to return shape for vehicles.company arc Commit 2 — see migration 20260828_get_residents_row_by_precedence_add_company.sql.';

-- ── PostgREST schema-cache reload ───────────────────────────────────
-- Supabase auto-issues NOTIFY pgrst on DDL; explicit here so the
-- reload NOTIFY fires from a known point rather than at the
-- transaction's commit fence. REST-side verification still runs
-- separately via scripts/gate-get-residents-row-postgrest.ts.
NOTIFY pgrst, 'reload schema';

-- ── Schema audit row ────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE_ADD_COMPANY',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260828_get_residents_row_by_precedence_add_company',
    'arc',       'vehicles.company Commit 2 (DB migration 1 of 2)',
    'change',    'RETURNS TABLE(email, unit, property) → RETURNS TABLE(email, unit, property, company)',
    'shape',     'wrapped DROP + CREATE (return-type change; CREATE OR REPLACE cannot alter return type)',
    'preserved', jsonb_build_array(
      'LANGUAGE sql',
      'STABLE',
      'SECURITY DEFINER',
      'SET search_path TO public, pg_temp',
      'REVOKE PUBLIC + anon + authenticated; GRANT service_role',
      'COMMENT (re-issued)'
    ),
    'dependents_before', jsonb_build_object(
      'sql_side',      'none (verified via grep at Aug 28)',
      'production_callers', jsonb_build_array('app/api/register/companion-vehicle/route.ts:224')
    ),
    'next_step', 'Run scripts/gate-get-residents-row-postgrest.ts to confirm PostgREST cache picked up the new signature before any Commit 2 consumer push'
  ),
  now()
);

COMMIT;
