-- ═══════════════════════════════════════════════════════════════════
-- B166 — vehicles.resident_email column
-- Date:   2026-06-10
-- Branch: b166/owner-trim-plus-b167-pm-vehicle-fields (aa4b0c6)
--
-- WHAT'S CHANGING
-- ───────────────
-- ALTER TABLE vehicles ADD COLUMN resident_email TEXT (nullable, no
-- default, no backfill). Forward-only stamps per the locked B166
-- design. The B166 stamps + owner-trim + picker + B167 fields shipped
-- in commit aa4b0c6 all reference this column; they cannot function
-- against the live DB until the column lands.
--
-- WHY THIS MIGRATION EXISTS (after the original audit said it wouldn't)
-- ───────────────────────────────────────────────────────────────────
-- The B166 preflight audit concluded "vehicles.resident_email already
-- exists" because app/api/billing/bulk-invite/route.ts:315 writes to
-- it. The audit conflated that with read references to a
-- resident_email column on dispute_requests (a different table) and
-- never queried information_schema.columns against production to
-- confirm. Live-schema pull on 2026-06-09 showed vehicles has no
-- resident_email column. The bulk-invite vehicle-insert path has
-- been latent (would error on any CSV with vehicle_plate populated).
--
-- The locked B166 design said "no migration" — that finding was
-- wrong. This migration is the unblock.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste, single-run in Supabase SQL Editor. Each verification
-- block runs as part of the same script.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Expected: 0 rows. Column does NOT exist yet.
-- If 1 row appears: column already exists (this migration ran before,
-- or someone added it via Dashboard). The IF NOT EXISTS in the ALTER
-- would silently no-op — investigate which prior change introduced it
-- before re-running.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'vehicles'
    AND column_name  = 'resident_email';


-- ── APPLY ───────────────────────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS resident_email TEXT;


-- ── POST-APPLY VERIFICATION (column shape) ──────────────────────────
-- Expected: 1 row.
--   column_name    = resident_email
--   data_type      = text
--   is_nullable    = YES
--   column_default = NULL  (no default; forward-only stamps)
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'vehicles'
    AND column_name  = 'resident_email';


-- ── POST-APPLY VERIFICATION (no backfill) ───────────────────────────
-- Expected: count_all > 0 (the table has existing rows);
--           null_count = count_all (no row has resident_email yet).
-- This confirms the forward-only intent — no row gets retroactively
-- owned by a guess at attribution.
SELECT
  COUNT(*)                                       AS count_all,
  COUNT(*) FILTER (WHERE resident_email IS NULL) AS null_count
  FROM vehicles;


-- ── NEXT STEPS (manual) ────────────────────────────────────────────
-- 1. Re-run the corrected B166 seed (drops the phantom `company`
--    column from the vehicles INSERT; otherwise identical).
-- 2. Smoke per the locked plan: turnover, concurrent roommate,
--    enforcement half (driver portal plate lookup), underscore-email
--    roommate (the wildcard-escape regression case).
-- 3. After smoke passes, signal go for the squash-merge to main.
-- 4. File the bulk-invite vehicle.company phantom-write fix (B172)
--    — drop the `company:` line from app/api/billing/bulk-invite/
--    route.ts:316 (do NOT add the column; vehicles already scopes
--    by property, which carries the company association).
