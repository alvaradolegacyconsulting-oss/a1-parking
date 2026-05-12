-- ════════════════════════════════════════════════════════════════════
-- B13 + B18 — Commit A: violation_photos table + is_confirmed + reads
-- Locked: May 14, 2026
--
-- Splits B13 (photo soft-delete) + B18 (two-step violation submission)
-- into three commits per Jose's call. This is Commit A: migration +
-- read-site plumbing only. The app looks identical to today, but every
-- photo reader now sources from the new violation_photos table.
-- Commit B wires the new write path + review screen. Commit C wires
-- the photo removal dialog + post-confirmation edit UIs.
--
-- Sub-decisions locked May 14:
--   A. Backfill into violation_photos, stop writing violations.photos
--      in Commit B. Legacy column stays as a safety net; dropped in a
--      follow-up commit after ~1 week clean prod.
--   B. Backfill violation_photos.created_at = violations.created_at
--      (plain copy, no per-photo ordering).
--   C. Single source of truth from Commit B forward (no dual-write).
--
-- is_confirmed default: TRUE in this commit (so any violations created
-- between Commit A's deploy and Commit B's deploy are correctly marked
-- confirmed under the current single-step write path). Commit B's
-- migration flips the default to FALSE alongside the new
-- review-before-confirm flow.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. violation_photos table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS violation_photos (
  id BIGSERIAL PRIMARY KEY,
  violation_id BIGINT NOT NULL REFERENCES violations(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by_email TEXT,
  removed_by_role TEXT,
  removal_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_violation_photos_violation_id ON violation_photos(violation_id);
CREATE INDEX IF NOT EXISTS idx_violation_photos_removed_at ON violation_photos(removed_at);

-- ── 2. Backfill from violations.photos[] preserving violations.created_at ──
-- Per sub-decision B: plain copy of parent timestamp. Imperfect (photos
-- taken seconds apart on one violation all collapse to one timestamp)
-- but matches the parent violation chronology which is what every
-- existing reader displays.
-- Blast radius (May 14 diag): 17 photos across 8 violations.
INSERT INTO violation_photos (violation_id, photo_url, created_at)
SELECT v.id, photo_url, v.created_at
FROM violations v, unnest(v.photos) AS photo_url
WHERE v.photos IS NOT NULL AND array_length(v.photos, 1) > 0;

-- ── 3. Add is_confirmed to violations ───────────────────────────────
-- DEFAULT TRUE in Commit A means historical rows + any new rows from
-- the unchanged single-step write path land correctly marked as
-- confirmed. Commit B's migration flips DEFAULT to FALSE and the new
-- write path explicitly sets FALSE on insert to drive the review screen.
ALTER TABLE violations ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 4. RLS on violation_photos ──────────────────────────────────────
-- Delegation pattern: a SELECT policy that requires the parent violation
-- to be visible to the caller. The inner SELECT runs against violations
-- with the caller's RLS context applied, so all five role-scoping rules
-- (admin all, company_admin via company, manager via property, driver
-- via company same as CA, resident via three-hop vehicles→residents)
-- are inherited transparently. If violations' policies ever change,
-- violation_photos automatically tracks — no chain reimplementation.
--
-- A separate admin FOR ALL policy covers future INSERT/UPDATE/DELETE in
-- Commits B and C; those commits will add role-scoped INSERT/UPDATE
-- policies for driver/CA writes (B) and manager/CA soft-delete (C).

ALTER TABLE violation_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "violation_photos_admin_all" ON violation_photos;
CREATE POLICY "violation_photos_admin_all" ON violation_photos
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "violation_photos_select_inherits_violation" ON violation_photos;
CREATE POLICY "violation_photos_select_inherits_violation" ON violation_photos
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) Table + indexes:
--   \d+ violation_photos
--
-- 2) Backfill correctness (must match sum of legacy array lengths):
--   SELECT
--     (SELECT COUNT(*) FROM violation_photos) AS new_count,
--     (SELECT SUM(COALESCE(array_length(photos, 1), 0))
--      FROM violations) AS legacy_count;
--   -- Expected per diag: both = 17.
--
-- 3) is_confirmed backfill:
--   SELECT is_confirmed, COUNT(*) FROM violations GROUP BY is_confirmed;
--   -- Expected: every row TRUE (column default).
--
-- 4) Spot-check chronology preserved:
--   SELECT v.id, v.created_at, vp.created_at AS photo_created
--   FROM violations v JOIN violation_photos vp ON vp.violation_id = v.id
--   ORDER BY v.created_at DESC LIMIT 5;
--   -- Expected: vp.created_at == v.created_at on every row.
--
-- 5) RLS shape (two policies on violation_photos):
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'violation_photos'::regclass
--   ORDER BY polname;
--   -- Expected:
--   --   violation_photos_admin_all                    *
--   --   violation_photos_select_inherits_violation    r
--
-- 6) Inheritance smoke test (as a non-admin role, e.g.
--    manager.bayou@demotowing.com via the app or a session JWT):
--   SELECT COUNT(*) FROM violation_photos;
--   -- Expected: same count as the manager would see on violations
--   --   for their property.
-- ════════════════════════════════════════════════════════════════════
