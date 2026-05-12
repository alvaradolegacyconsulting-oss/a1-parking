-- ════════════════════════════════════════════════════════════════════
-- B13 + B18 — Commit C1: post-confirmation soft-delete + video parity
-- Locked: May 16, 2026
--
-- First half of the C arc (split from the original 950-LOC Commit C
-- spec). C1 ships migration + MediaRemovalDialog + driver/CA review
-- screen X buttons (Option B — pre-confirmation removal per media).
-- C2 ships the post-confirmation edit modals on manager / CA / admin
-- portals as pure UI wiring — NO DB changes — because every UPDATE
-- policy C2 needs is already landed by this migration.
--
-- This migration creates violation_videos (mirroring violation_photos
-- exactly) and adds UPDATE policies on BOTH tables to enable
-- soft-delete by:
--   - admin (FOR ALL, already covered by *_admin_all from prior commits)
--   - manager (own property — RLS delegation inherits from violations)
--   - company_admin (own company — same)
--   - driver (preconfirmation-bound — v.is_confirmed = FALSE)
--
-- Legacy violations.video_url column stays as safety net during the
-- transition window; dropped in a follow-up after ~1 week clean prod.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. violation_videos table (mirrors violation_photos exactly) ────
CREATE TABLE IF NOT EXISTS violation_videos (
  id BIGSERIAL PRIMARY KEY,
  violation_id BIGINT NOT NULL REFERENCES violations(id) ON DELETE CASCADE,
  video_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by_email TEXT,
  removed_by_role TEXT,
  removal_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_violation_videos_violation_id
  ON violation_videos(violation_id);
CREATE INDEX IF NOT EXISTS idx_violation_videos_removed_at
  ON violation_videos(removed_at);

-- ── 2. Backfill from violations.video_url ───────────────────────────
-- Plain copy of parent timestamp, same as Commit A's photo backfill.
-- After this lands, every violation with a non-null video_url has a
-- matching violation_videos row. Reader sites still work via the
-- legacy column until they're switched to the embed in this commit.
INSERT INTO violation_videos (violation_id, video_url, created_at)
SELECT id, video_url, created_at
FROM violations
WHERE video_url IS NOT NULL;

-- ── 3. RLS on violation_videos (mirrors violation_photos exactly) ───
-- Delegation pattern: every policy except admin_all uses
-- EXISTS (SELECT 1 FROM violations v WHERE v.id = violation_videos.violation_id)
-- so the inner SELECT runs under the caller's RLS context and inherits
-- whatever scoping rules violations has. Single source of truth.

ALTER TABLE violation_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "violation_videos_admin_all" ON violation_videos;
CREATE POLICY "violation_videos_admin_all" ON violation_videos
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "violation_videos_select_inherits_violation" ON violation_videos;
CREATE POLICY "violation_videos_select_inherits_violation" ON violation_videos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_videos_driver_insert" ON violation_videos;
CREATE POLICY "violation_videos_driver_insert" ON violation_videos
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_videos_company_admin_insert" ON violation_videos;
CREATE POLICY "violation_videos_company_admin_insert" ON violation_videos
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  );

-- ── 4. UPDATE policies on violation_photos (soft-delete write) ──────
-- These enable setting removed_at / removed_by_email / removed_by_role
-- / removal_reason. Hard DELETE remains denied for non-admin (admin
-- already covered by violation_photos_admin_all FOR ALL).
--
-- Driver UPDATE is bounded by v.is_confirmed = FALSE on the parent so
-- drivers can only soft-delete on unconfirmed drafts (review screen
-- Option B). Once a violation is confirmed, driver loses removal
-- rights; manager / CA / admin take over per the permission matrix.
--
-- Manager / CA UPDATE inherit visibility from violations, so manager
-- scopes by property and CA by company automatically.

DROP POLICY IF EXISTS "violation_photos_manager_update" ON violation_photos;
CREATE POLICY "violation_photos_manager_update" ON violation_photos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  )
  WITH CHECK (
    get_my_role() = 'manager' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_photos_company_admin_update" ON violation_photos;
CREATE POLICY "violation_photos_company_admin_update" ON violation_photos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_photos_driver_update_preconfirm" ON violation_photos;
CREATE POLICY "violation_photos_driver_update_preconfirm" ON violation_photos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
        AND v.is_confirmed = FALSE
    )
  )
  WITH CHECK (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
        AND v.is_confirmed = FALSE
    )
  );

-- ── 5. UPDATE policies on violation_videos (identical pattern) ──────

DROP POLICY IF EXISTS "violation_videos_manager_update" ON violation_videos;
CREATE POLICY "violation_videos_manager_update" ON violation_videos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  )
  WITH CHECK (
    get_my_role() = 'manager' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_videos_company_admin_update" ON violation_videos;
CREATE POLICY "violation_videos_company_admin_update" ON violation_videos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_videos_driver_update_preconfirm" ON violation_videos;
CREATE POLICY "violation_videos_driver_update_preconfirm" ON violation_videos
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
        AND v.is_confirmed = FALSE
    )
  )
  WITH CHECK (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_videos.violation_id
        AND v.is_confirmed = FALSE
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) violation_videos all policies (4 non-UPDATE):
--    SELECT polname, polcmd FROM pg_policy
--    WHERE polrelid = 'violation_videos'::regclass
--      AND polcmd <> 'w' ORDER BY polname;
--    -- Expected (polcmd: r=SELECT, a=INSERT, *=ALL):
--    --   violation_videos_admin_all                     *
--    --   violation_videos_company_admin_insert          a
--    --   violation_videos_driver_insert                 a
--    --   violation_videos_select_inherits_violation     r
--
-- 2) violation_videos UPDATE policies (3 new):
--    SELECT polname FROM pg_policy
--    WHERE polrelid = 'violation_videos'::regclass
--      AND polcmd = 'w' ORDER BY polname;
--    -- Expected:
--    --   violation_videos_company_admin_update
--    --   violation_videos_driver_update_preconfirm
--    --   violation_videos_manager_update
--
-- 3) violation_photos UPDATE policies (3 new):
--    SELECT polname FROM pg_policy
--    WHERE polrelid = 'violation_photos'::regclass
--      AND polcmd = 'w' ORDER BY polname;
--    -- Expected:
--    --   violation_photos_company_admin_update
--    --   violation_photos_driver_update_preconfirm
--    --   violation_photos_manager_update
--
-- 4) Backfill correctness (must match count of legacy non-null video_urls):
--    SELECT
--      (SELECT COUNT(*) FROM violation_videos) AS new_count,
--      (SELECT COUNT(*) FROM violations WHERE video_url IS NOT NULL) AS legacy_count;
--    -- Expected: both equal.
--
-- 5) CASCADE still works (DANGER — rollback after test):
--    BEGIN;
--    -- Pick any test violation_id from violation_videos:
--    -- SELECT id, violation_id FROM violation_videos LIMIT 1;
--    DELETE FROM violations WHERE id = <test_id>;
--    SELECT COUNT(*) FROM violation_videos WHERE violation_id = <test_id>;
--    -- Expected: 0 (CASCADE worked).
--    ROLLBACK;
--
-- 6) is_confirmed boundary smoke test (manual via app, post-deploy):
--    a. driver1 submits new violation w/ 1 photo + 1 video → review screen.
--    b. Click X on photo → MediaRemovalDialog → "Wrong vehicle" → Remove.
--       Confirm in DB:
--         SELECT removed_at, removed_by_email, removed_by_role, removal_reason
--         FROM violation_photos WHERE violation_id = <v.id>;
--         -- Expected: removed_at != NULL, role='driver', reason='Wrong vehicle'.
--    c. Confirm & Submit → is_confirmed = TRUE.
--    d. driver1 attempts SQL to soft-delete another photo on same row:
--         UPDATE violation_photos SET removed_at = now() WHERE violation_id = <v.id>;
--         -- Expected: 0 rows affected (preconfirm policy blocks post-confirm).
-- ════════════════════════════════════════════════════════════════════
