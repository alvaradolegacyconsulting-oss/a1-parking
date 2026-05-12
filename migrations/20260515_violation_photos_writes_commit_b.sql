-- ════════════════════════════════════════════════════════════════════
-- B13 + B18 — Commit B: write-path migration
-- Locked: May 15, 2026
--
-- Second of three commits. Commit A (May 14, applied) added the
-- violation_photos table + SELECT delegation policy + is_confirmed
-- DEFAULT TRUE + read-site plumbing. Commit B (this) flips the write
-- path: violation INSERTs now land with is_confirmed=FALSE so the
-- review screen has something to confirm, photo rows go into
-- violation_photos (not the legacy violations.photos array), and
-- driver / company_admin get INSERT permission on violation_photos
-- scoped by parent-visibility (mirrors their company-scoped
-- violations SELECT).
--
-- Commit C adds UPDATE policies for soft-delete + the removal dialog
-- + post-confirmation edit UIs.
--
-- The legacy violations.photos column is NOT dropped here — it stays
-- as a safety net for ~1 week per Jose's call. Reader sites already
-- pull from violation_photos (Commit A), so the legacy column will
-- silently stop being read once Commit B's write path lands. A
-- separate follow-up commit drops the column after the soak period.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Flip is_confirmed default ────────────────────────────────────
-- Commit A set DEFAULT TRUE so any violations created between
-- Commit A's deploy and Commit B's deploy under the unchanged
-- single-step write path landed correctly marked confirmed.
-- Commit B's new write path explicitly inserts is_confirmed=false,
-- so we flip the column default to match: any caller that omits
-- is_confirmed (legacy code paths, manual SQL inserts, etc.) now
-- lands an unconfirmed row — which is the safer default once the
-- review screen exists.
ALTER TABLE violations ALTER COLUMN is_confirmed SET DEFAULT FALSE;

-- ── 2. INSERT policies on violation_photos ──────────────────────────
-- Delegation pattern: a driver/CA can INSERT a photo row pointing at
-- a violation iff they can SELECT that violation. The inner SELECT
-- against violations runs with the caller's RLS context, so
-- existing role rules (driver scopes by company, CA scopes by
-- company) are inherited transparently — no chain reimplementation,
-- guaranteed sync if violations' policies change.
--
-- admin INSERT is already covered by violation_photos_admin_all
-- (FOR ALL) from Commit A. No manager INSERT policy added because
-- managers don't submit violations via the existing portals.
-- Resident INSERT remains denied (read-only role).
-- Commit C will add UPDATE policies (manager / CA / admin /
-- driver-pre-confirmation) for the soft-delete flow.

DROP POLICY IF EXISTS "violation_photos_driver_insert" ON violation_photos;
CREATE POLICY "violation_photos_driver_insert" ON violation_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'driver' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  );

DROP POLICY IF EXISTS "violation_photos_company_admin_insert" ON violation_photos;
CREATE POLICY "violation_photos_company_admin_insert" ON violation_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin' AND
    EXISTS (
      SELECT 1 FROM violations v
      WHERE v.id = violation_photos.violation_id
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) Default is now FALSE:
--   SELECT column_default FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='violations'
--     AND column_name='is_confirmed';
--   -- Expected: 'false'
--
-- 2) Policies (Commit A's 2 + Commit B's 2 = 4 total):
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'violation_photos'::regclass
--   ORDER BY polname;
--   -- Expected (polcmd: r=SELECT, a=INSERT, *=ALL):
--   --   violation_photos_admin_all                     *
--   --   violation_photos_company_admin_insert          a
--   --   violation_photos_driver_insert                 a
--   --   violation_photos_select_inherits_violation     r
--
-- 3) Smoke test as driver1@demotowing.com via app:
--    a. Submit a new violation with 2 photos → review screen
--    b. Check DB:
--       SELECT id, is_confirmed FROM violations
--       WHERE driver_name = 'Driver One' ORDER BY id DESC LIMIT 1;
--       -- is_confirmed should be FALSE
--    c. Check photo rows landed:
--       SELECT COUNT(*) FROM violation_photos WHERE violation_id = <id from above>;
--       -- Should be 2
--    d. Confirm + Submit → is_confirmed = TRUE in DB.
-- ════════════════════════════════════════════════════════════════════
