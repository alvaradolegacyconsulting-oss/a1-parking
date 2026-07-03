-- ════════════════════════════════════════════════════════════════════
-- PM CRM Slice 3.5 — resident SELECT policy on space_residents
-- Locked: July 3, 2026
--
-- Symptom (probed via scripts/probe-crm-slice3.5-roundtrip.ts before
-- migration): PM approves a resident's space request via
-- approve_space_request → space_residents row is created with the
-- resident_email + space_id → resident's My Info still shows "—" for
-- assigned space. RLS gap: no SELECT policy on space_residents admits
-- role='resident', so the resident-side query
-- `space_residents.select().ilike('resident_email', jwt_email)` returns
-- an empty set. Data written but unreadable to the writer's target.
--
-- Fix: one InitPlan-hoisted SELECT policy on public.space_residents
-- admitting a resident to read ONLY their own tie. Matches the pattern
-- of resident_read_own_spaces (spaces table) + resident_own_space_requests
-- (space_requests table); this is the missing sibling on the join table.
--
-- Idiom (per Commit 1/2 InitPlan discipline):
--   (SELECT get_my_role()) = 'resident'    ← scalar hoist
--   resident_email ILIKE ((SELECT auth.jwt()) ->> 'email')  ← auth.jwt hoist
--
-- Semantic:
--   · resident sees their OWN tie(s) only (email match)
--   · does NOT see other residents' ties (roommate on a shared space →
--     visible on the manager surface, NOT on the resident surface —
--     matches the v1.1 privacy design; the resident sees THEIR
--     assignment, not a co-tenant's)
--   · admin / CA / manager unchanged (their existing policies stand)
--
-- No other policy changes. No RPC changes. No data touched.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS "resident_read_own_space_residents" ON public.space_residents;
CREATE POLICY "resident_read_own_space_residents" ON public.space_residents
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND resident_email ILIKE ((SELECT auth.jwt()) ->> 'email'::text)
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFY (after apply)
--
-- ── A. Policy present + shape
--   SELECT policyname, cmd, qual FROM pg_policies
--   WHERE tablename = 'space_residents'
--     AND policyname = 'resident_read_own_space_residents';
--   Expected: 1 row; qual contains "SELECT get_my_role()" and
--   "SELECT auth.jwt()".
--
-- ── B. Round-trip probe
--   npx tsx --env-file=.env.local scripts/probe-crm-slice3.5-roundtrip.ts
--   Expected: APPROVE path 🟢 PASS (was 🔴 pre-migration).
--
-- ── C. Cross-role isolation spot-check
--   Sign in as resident B (throwaway) and query
--   space_residents.select().eq('space_id', <resident A's space>). Expected
--   0 rows (resident B is not tied to A's space). Then query with B's own
--   space_id and expect ≥1 row. The policy only admits the caller's own
--   ties — no over-permissioning to other residents.
-- ════════════════════════════════════════════════════════════════════
