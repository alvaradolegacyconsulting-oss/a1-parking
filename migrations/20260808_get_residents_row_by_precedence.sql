-- ══════════════════════════════════════════════════════════════════════
-- 20260808_get_residents_row_by_precedence.sql
-- Companion migration to 20260808_get_my_effective_active_row_precedence.
-- Internal service-role-only DEFINER RPC that returns a resident's
-- canonical row (email, unit, property) using the SHARED precedence
-- helper. Called by /api/register/companion-vehicle in place of a
-- .maybeSingle() that used to error 500 on residents with 2+ rows.
--
-- ── WHY A NEW FUNCTION ───────────────────────────────────────────────
--
-- The proxy runs with a service-role admin client (RLS bypass), so it
-- CANNOT reuse get_my_effective_active — that function reads
-- auth.jwt() ->> 'email', which is empty under a service-role client.
-- It also can't ORDER BY a function expression via PostgREST's
-- .order() (columns only, not expressions), so an inline JS mirror of
-- resident_row_precedence would be the alternative. Rejected — Mateo
-- Aug 8 lock: "define the precedence once, in one place, and have both
-- call sites use it." Two implementations of resident-best-row is the
-- same class of bug as countVehicles vs enforcement.
--
-- ── SERVICE-ROLE ONLY ────────────────────────────────────────────────
--
-- SECURITY DEFINER + email-parameter looks like an information-leak
-- footgun (any authenticated user could pass anyone's email and get
-- back their unit + property). Closed by GRANTing execute ONLY to
-- service_role and REVOKing from PUBLIC, anon, AND authenticated.
-- Even authenticated users cannot call this RPC — only server routes
-- with the service-role key can.
--
-- If a second service-side caller emerges, GRANT here — do NOT
-- re-express the precedence CASE inline.
--
-- ── DO NOT ───────────────────────────────────────────────────────────
--
-- - DO NOT GRANT this to authenticated. It leaks another resident's
--   (unit, property) — the very fields this RPC returns are the
--   scope keys used by the vehicle-insert path, so leaking them
--   enables misattribution.
-- - DO NOT inline the CASE into the caller. Route through
--   resident_row_precedence().
--
-- ── DEPENDENCIES ─────────────────────────────────────────────────────
--
-- 20260808_get_my_effective_active_row_precedence.sql — installs
--   resident_row_precedence(TEXT, BOOLEAN). Apply that first.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_residents_row_by_precedence(p_email TEXT)
RETURNS TABLE (
  email    TEXT,
  unit     TEXT,
  property TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT email, unit, property
    FROM public.residents
    WHERE lower(email) = lower(p_email)
    ORDER BY public.resident_row_precedence(status, is_active), created_at DESC
    LIMIT 1;
$$;

REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_residents_row_by_precedence(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_residents_row_by_precedence(TEXT) TO service_role;

COMMENT ON FUNCTION public.get_residents_row_by_precedence IS
  'Internal RPC for the server-side companion-vehicle proxy (app/api/register/companion-vehicle/route.ts). Returns a resident''s canonical (email, unit, property) row for a given lowered email using resident_row_precedence(status, is_active), created_at DESC. SERVICE_ROLE ONLY — the (unit, property) return values are the scope keys for the pending-vehicle insert, so leaking them enables misattribution; execute is REVOKED from PUBLIC, anon, and authenticated. If a second service-side caller emerges, GRANT here — do NOT re-implement the precedence in the caller (Mateo Aug 8 lock: one place, both call sites).';

-- ── SCHEMA_ audit ──────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260808_get_residents_row_by_precedence',
    'purpose',   'Companion-vehicle proxy .maybeSingle() errored 500 on residents with 2+ rows for one lowered email → every /register attempt with a vehicle from a multi-row resident dropped the vehicle AND spuriously fired the tow-risk banner. Replace with SECURITY DEFINER RPC that returns the canonical row via resident_row_precedence(status, is_active), created_at DESC.',
    'callers_affected', jsonb_build_object(
      'app/api/register/companion-vehicle/route.ts', 'residents-row lookup at ~line 209'
    ),
    'grants', 'service_role ONLY — REVOKED from PUBLIC, anon, authenticated (email-param DEFINER is a leak unless internal-only)',
    'related', '20260808_get_my_effective_active_row_precedence — installs resident_row_precedence helper'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE'
     AND new_values->>'migration' = '20260808_get_residents_row_by_precedence'
);

COMMIT;
