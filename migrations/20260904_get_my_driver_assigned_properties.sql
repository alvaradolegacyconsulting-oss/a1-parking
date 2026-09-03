-- ══════════════════════════════════════════════════════════════════════
-- 20260904_get_my_driver_assigned_properties.sql
--
-- 🟢 Track gating Commit 3 helper (Commit A of B).
--
-- Adds public.get_my_driver_assigned_properties() → TEXT[]. Mirrors
-- the shape of the existing public.get_my_properties() (which reads
-- user_roles.property for managers) but reads
-- drivers.assigned_properties for drivers.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────
--
-- Track gating Commit 3 (upcoming — the RPC rewrite of
-- driver_create_violation_with_snapshot) needs to check that the
-- caller-supplied `p_violation.property` is one the calling driver
-- is assigned to. Prior art for this scope check is inlined
-- everywhere (RLS F5 policy at migrations/20260610_b155_2_policy_tightens.sql:173-177
-- uses `SELECT 1 FROM unnest(assigned_properties) ap WHERE ...`) —
-- extracting into a reusable helper avoids re-inlining that JOIN
-- across every new call site, and matches the get_my_properties()
-- pattern that manager-side scope checks use.
--
-- ── SHAPE ───────────────────────────────────────────────────────────
--
-- LANGUAGE sql (not plpgsql) — one SELECT, no branching, cheaper
-- volatility classification. Matches get_my_company() +
-- get_my_properties() (both LANGUAGE sql STABLE).
--
-- STABLE — reads catalog + drivers row; result is stable within a
-- single query invocation. Required for use inside RLS predicates
-- + inlinable by the planner.
--
-- SECURITY DEFINER — reads drivers table which has RLS. DEFINER
-- context lets the helper resolve the caller's assignments without
-- coupling to the caller's own RLS visibility (which for a driver
-- would filter drivers to just their own row anyway, but for a
-- manager or CA calling this on behalf of investigating a driver's
-- scope it would matter).
--
-- SET search_path = public — same pattern as get_my_company() +
-- get_my_properties(). Prevents search_path hijack (defense-in-depth
-- even though this fn does no writes).
--
-- ── RETURN SHAPE ────────────────────────────────────────────────────
--
--   Caller state                      Return
--   ────────────────────────────────  ─────────────
--   Authenticated driver with row     TEXT[] (may be '{}' if no
--                                     properties assigned yet)
--   No matching drivers row (email    NULL
--   not in drivers, or no session)
--
-- Callers distinguish NULL (no drivers row) from '{}' (row exists,
-- empty assignments) with:
--   IF v_assigned IS NULL OR array_length(v_assigned, 1) IS NULL
--
-- Both cases map to "this caller can't reach any property" from a
-- scope-check perspective — the caller Commit B will surface both as
-- 'driver_no_properties_assigned' (single user-facing error class;
-- the NULL-vs-empty distinction is not user-actionable).
--
-- ── PRIOR ART TEMPLATE ──────────────────────────────────────────────
--
-- get_my_company() (migration 20260610_b155_2_f9_helper_lower_match.sql):
--   SELECT company FROM user_roles
--    WHERE lower(email) = lower(auth.jwt() ->> 'email')
--    LIMIT 1
--
-- get_my_properties() (migration 20260518_b40_violations_rls_capture.sql):
--   SELECT property FROM user_roles
--    WHERE email ILIKE auth.jwt() ->> 'email'
--    LIMIT 1
--
-- This helper matches the get_my_company() shape (lower() equality,
-- not ILIKE — metachar-vector-close discipline per feedback_query_before_inferring).
--
-- ── GRANTS ──────────────────────────────────────────────────────────
--
-- REVOKE FROM PUBLIC + anon (per feedback_function_public_grant_supabase_default +
-- feedback_revoke_from_anon_explicitly).
-- GRANT TO authenticated + service_role — same as the sibling helpers.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- Additive migration. No existing consumers (Commit B's RPC rewrite
-- is the first). Orphan-safe if Commit B never lands or is reverted.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Create the helper ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_driver_assigned_properties()
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT assigned_properties
    FROM public.drivers
   WHERE lower(email) = lower(auth.jwt() ->> 'email')
   LIMIT 1
$func$;

COMMENT ON FUNCTION public.get_my_driver_assigned_properties() IS
  '2026-09-04 Track gating Commit 3 helper. Returns caller''s driver assignment TEXT[] from drivers.assigned_properties keyed by JWT email. Returns NULL if no drivers row exists for the caller (or no session). Mirrors get_my_properties() shape but reads drivers table (not user_roles). Callers should treat NULL and empty array the same for scope-check purposes.';

-- ── PART 2 — Grants ────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_my_driver_assigned_properties() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_driver_assigned_properties() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_my_driver_assigned_properties() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_my_driver_assigned_properties() TO service_role;

-- ── PART 3 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_GET_MY_DRIVER_ASSIGNED_PROPERTIES',
  'public.get_my_driver_assigned_properties',
  'commit_3_helper_a',
  jsonb_build_object(
    'migration',      '20260904_get_my_driver_assigned_properties',
    'arc',            'Track gating Commit 3 (Commit A of B — additive helper for the driver-scope guard on driver_create_violation_with_snapshot)',
    'return_type',    'TEXT[] (may be NULL if no drivers row exists for caller)',
    'volatility',     'STABLE',
    'security',       'DEFINER + search_path pinned',
    'read_source',    'drivers.assigned_properties WHERE lower(email) = lower(auth.jwt()->>email)',
    'template',       'get_my_company() shape (lower() equality, not ILIKE)',
    'grants',         'authenticated + service_role; PUBLIC + anon REVOKEd',
    'consumers',      'Commit B (upcoming) — RPC rewrite of driver_create_violation_with_snapshot adds property scope guard using this helper. No other consumers today.',
    'orphan_safe',    'Additive migration. No callers today; safe if Commit B never lands.'
  ),
  now()
);

-- ── PART 4 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
