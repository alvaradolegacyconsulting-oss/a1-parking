-- ════════════════════════════════════════════════════════════════════
-- RLS 57014 perf fix — Commit 2 straggler close-out
-- 2026-07-09
--
-- The Commit 2 sweep (20260703_rls_57014_perf_commit2_sweep.sql) DROP+
-- CREATE'd the 56 in-file-scope policies but did not reach two dashboard-
-- created policies:
--   • space_residents.resident_read_own_space_residents      — already
--     hoisted at dashboard-create time; no action.
--   • guest_authorizations.resident_read_own_guest_auths     — GENUINE
--     STRAGGLER; per-row get_my_role() + auth.jwt() calls.
--
-- This migration hoists the guest_auth straggler only. Byte-for-byte
-- modulo the two SELECT wraps (SELECT get_my_role) + (SELECT auth.jwt).
-- The lower()=lower() + COALESCE match idiom is preserved verbatim —
-- DO NOT normalize to the sibling's ~~* (ILIKE) idiom (see [[project_
-- rls_57014_perf_arc]]: ILIKE would treat _/% in an email as wildcards;
-- the exact case-insensitive form is intentional + safer).
--
-- Not a launch gate (resident-scoped, small table, not the manager
-- timeout path). Closes the arc rather than carrying it open.
--
-- INVARIANTS PRESERVED
--   • AS PERMISSIVE, FOR SELECT, TO authenticated — unchanged.
--   • Role gate: resident only — unchanged.
--   • Email match: lower(COALESCE(...)) — unchanged (do NOT swap to
--     ILIKE per [[project_rls_57014_perf_arc]] discipline).
--
-- ROLLBACK
--   Restore prior policy body (per-row helper calls). Semantic
--   equivalence preserved → no data risk on rollback; only perf loss.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS resident_read_own_guest_auths ON public.guest_authorizations;

CREATE POLICY resident_read_own_guest_auths
  ON public.guest_authorizations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((SELECT get_my_role()) = 'resident'::text)
    AND (
      lower(COALESCE(resident_email, ''::text))
      = lower(COALESCE(((SELECT auth.jwt()) ->> 'email'::text), ''::text))
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- ── VQ.A — Straggler hoisted
-- SELECT tablename, policyname, cmd,
--        (qual ~* 'SELECT\s+get_my_(role|company|properties)\s*\(') AS qual_role_hoist,
--        (qual ~* 'SELECT\s+auth\.jwt\s*\(')                        AS qual_jwt_hoist
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename = 'guest_authorizations'
--   AND policyname = 'resident_read_own_guest_auths';
-- Expected: qual_role_hoist = true, qual_jwt_hoist = true.
--
-- ── VQ.B — Resident row-set unchanged (semantic equivalence)
-- npx tsx --env-file=.env.local scripts/probe-commit2-timing.ts
-- Probe already hits guest_authorizations under the resident session
-- (chris.tobar94+jes@gmail.com). Resident's row count on
-- guest_authorizations must equal the super-user baseline. Any drift
-- → HALT + investigate.
-- ════════════════════════════════════════════════════════════════════
