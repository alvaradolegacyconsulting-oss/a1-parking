-- ════════════════════════════════════════════════════════════════════
-- B78 — violations.vehicle_year column
-- Drafted: May 23, 2026 — NOT YET APPLIED.
--
-- Single change: add nullable SMALLINT vehicle_year to violations so
-- the driver violation form can capture the at-scene vehicle year
-- alongside vehicle_color / vehicle_make / vehicle_model. Matches the
-- existing Family-2 column convention (driver-entered scene values,
-- loose validation, optional).
--
-- WHY SMALLINT: covers any year a driver could plausibly type
-- (-32768..32767). INTEGER would waste 2 bytes per row; SMALLINT
-- matches the value range. Nullable + no DEFAULT so existing rows
-- stay clean (no backfill — they predate this capture).
--
-- WHY NO CHECK CONSTRAINT: year validity is enforced client-side via
-- HTML5 min/max attrs (1900..currentYear+1) — same loose-at-DB pattern
-- as vehicle_color/make/model (all TEXT with no length or content
-- constraints). DB stays permissive; UI stays helpful.
--
-- See [[project-b78-tow-ticket-vehicle-fields]] for the full Design X
-- arc: collapse the dead v.year/make/model/color/vin template slots,
-- repoint the Make/Model/Color labels to v.vehicle_*, drop the
-- redundant "Vehicle Description" line, add Year capture + render
-- as its own conditional slot.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS vehicle_year SMALLINT;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
--
-- ── A. Column shape ────────────────────────────────────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'violations'
--     AND column_name = 'vehicle_year';
--   -- Expected: smallint · YES · (null)
--
-- ── B. Existing rows untouched ─────────────────────────────────────
--   SELECT COUNT(*) AS total,
--          COUNT(vehicle_year) AS with_year_set,
--          COUNT(*) - COUNT(vehicle_year) AS null_year
--   FROM violations;
--   -- Expected: with_year_set=0, null_year=total. No backfill.
-- ════════════════════════════════════════════════════════════════════
