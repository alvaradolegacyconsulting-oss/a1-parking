-- B182 #2 — Manage Media authz close (manager UPDATE on violation_photos +
-- violation_videos)
--
-- BACKGROUND
--   The A2 pre-launch security audit (Block 3 — write-path matrix) flagged
--   that the manager_update policies on violation_photos and violation_videos
--   gate by `get_my_role() = 'manager'` only — no ownership / property scope.
--   Combined with the manager-portal "Manage Media" UI (PostConfirmationEditModal
--   → MediaRemovalDialog → direct .update({removed_at}) on the table), a
--   manager could soft-delete dispute evidence at will. UAT smoke after B182
--   #1 confirmed the server-side write succeeds via supabase-js — not just
--   the UI affordance. PMs must VIEW evidence (drives ticket / dispute
--   context) but must not DELETE it (integrity of contested tow records).
--
--   This migration closes the server-side half. The UI half (remove the
--   button + modal render from manager portal) ships in the same commit.
--
-- AUTH MODEL AFTER THIS MIGRATION
--   • Manager / leasing_agent: cannot UPDATE violation_photos or
--     violation_videos (no role-specific policy → falls through to RLS deny).
--     SELECT preserved via violation_photos_select_inherits_violation +
--     violation_videos_select_inherits_violation (manager evidence VIEW
--     intact — required for routine ticket/dispute review).
--   • company_admin: UPDATE preserved via violation_photos_company_admin_update
--     + violation_videos_company_admin_update — CA legitimately resolves
--     disputes including evidence removal.
--   • admin: UPDATE preserved via violation_photos_admin_all (FOR ALL) +
--     violation_videos_admin_all (FOR ALL).
--   • driver: UPDATE preserved on PRECONFIRM violations only via the
--     violation_photos_driver_update_preconfirm + videos counterpart —
--     B18 review-screen path (driver removes evidence before submit).
--     Probe explicitly regression-gates BOTH the pre-confirm allow AND
--     the post-confirm block.
--   • resident / anon: no UPDATE policy → blocked.
--
-- APPLY DISCIPLINE
--   SINGLE-PASTE SINGLE-RUN. The DROPs and re-enumerations belong in one
--   transaction; partial apply could leave the policies dropped without
--   the VQs running, or vice versa. See [[feedback_sql_editor_partial_apply]].
--
-- ============================================================================
-- BEFORE STATE — captured 2026-06-15 from repo migration
-- 20260516_violation_media_softdelete_commit_c1.sql:113-128 (and the videos
-- counterpart at lines 171-186). Live names + USING/WITH CHECK to be
-- VERIFIED via the PRE-APPLY SELECT below (A2 lesson: never drop blind by
-- remembered name).
--
-- Policy: violation_photos_manager_update (will be DROPped)
--   CREATE POLICY "violation_photos_manager_update" ON violation_photos
--     FOR UPDATE TO authenticated
--     USING (
--       get_my_role() = 'manager' AND
--       EXISTS (
--         SELECT 1 FROM violations v
--         WHERE v.id = violation_photos.violation_id
--       )
--     )
--     WITH CHECK ( ... same as USING ... );
--
-- Policy: violation_videos_manager_update (will be DROPped) — identical
-- shape, table swapped.
--
-- Both grant: any authenticated user with get_my_role() = 'manager' can
-- UPDATE ANY row on these tables as long as a violations row with
-- matching id exists. No property scope. No is_confirmed gate. No
-- ownership check. This is the over-permission.
--
-- ============================================================================

-- ── PRE-APPLY VERIFICATION — re-emit live policy text ───────────────────────
-- A2 discipline: confirm live names match before dropping. If either
-- policy is missing from this output OR has a different USING expression
-- than the BEFORE STATE quoted above, STOP and re-audit before continuing.

SELECT '─────── PRE-APPLY: manager UPDATE policies (the targets) ───────' AS marker;

SELECT
  tablename, policyname, cmd, roles,
  qual          AS using_expr,
  with_check    AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND policyname IN ('violation_photos_manager_update', 'violation_videos_manager_update')
ORDER BY tablename, policyname;
-- Expected: two rows, both gating on get_my_role() = 'manager' with the
-- EXISTS-violations subquery and no other scope. If either policy is
-- already absent, the DROP IF EXISTS below makes the migration idempotent.

SELECT '─────── PRE-APPLY: all UPDATE-affecting policies on both tables ───────' AS marker;

SELECT
  tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND cmd IN ('UPDATE', 'ALL')
ORDER BY tablename, policyname;
-- Expected on violation_photos (4 rows):
--   violation_photos_admin_all               | ALL
--   violation_photos_company_admin_update    | UPDATE
--   violation_photos_driver_update_preconfirm| UPDATE
--   violation_photos_manager_update          | UPDATE   ← about to be DROPped
-- Expected on violation_videos (4 rows): same shape with videos prefix.
-- If admin_all / company_admin_update / driver_update_preconfirm are NOT
-- there, STOP — the DROP would leave the manager bypass closed but
-- legitimate writers also blocked. Re-audit.

SELECT '─────── PRE-APPLY: SELECT policies (must stay untouched — manager VIEW gate) ───────' AS marker;

SELECT
  tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;
-- Expected: violation_photos_select_inherits_violation +
-- violation_videos_select_inherits_violation. This migration MUST NOT
-- touch SELECT. Re-emit for the verification trail.

-- ── PART 1 — DROP both manager_update policies ──────────────────────────────
-- IF EXISTS so a re-paste after partial apply is idempotent.

DROP POLICY IF EXISTS violation_photos_manager_update ON public.violation_photos;
DROP POLICY IF EXISTS violation_videos_manager_update ON public.violation_videos;

-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────────────

SELECT '─────── POST-APPLY: VQ.A — UPDATE policies on both tables ───────' AS marker;

-- VQ.A — both tables now show EXACTLY 3 UPDATE-affecting policies, none
-- of which is *_manager_update.
SELECT
  tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND cmd IN ('UPDATE', 'ALL')
ORDER BY tablename, policyname;
-- Expected — 6 rows total, 3 per table:
--   violation_photos_admin_all                | ALL
--   violation_photos_company_admin_update     | UPDATE
--   violation_photos_driver_update_preconfirm | UPDATE
--   violation_videos_admin_all                | ALL
--   violation_videos_company_admin_update     | UPDATE
--   violation_videos_driver_update_preconfirm | UPDATE
-- NO violation_photos_manager_update. NO violation_videos_manager_update.

-- VQ.A.bis — count-based eye-check.
SELECT
  tablename,
  count(*)                                                           AS write_affecting_policy_count_expect_3,
  count(*) FILTER (WHERE policyname LIKE '%manager_update%')         AS manager_update_count_expect_0
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND cmd IN ('UPDATE', 'ALL')
GROUP BY tablename
ORDER BY tablename;
-- Expected: both rows show 3 / 0.

SELECT '─────── POST-APPLY: VQ.B — SELECT policies unchanged (manager VIEW intact) ───────' AS marker;

-- VQ.B — SELECT policies are exactly the inherits_violation pair, untouched.
SELECT
  tablename, policyname, cmd,
  qual AS using_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('violation_photos', 'violation_videos')
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;
-- Expected — 2 rows:
--   violation_photos_select_inherits_violation | SELECT
--   violation_videos_select_inherits_violation | SELECT
-- Both with their original inherits-violation USING expression. This
-- migration MUST NOT have touched them; this VQ is the regression gate
-- on the "manager VIEW intact" guarantee.
