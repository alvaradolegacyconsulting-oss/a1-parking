-- ══════════════════════════════════════════════════════════════════════
-- 20260730_violations_other_requires_note.sql
-- Server-side backstop: "Other" violation type requires a describing note
-- ══════════════════════════════════════════════════════════════════════
--
-- Part 1 of the pre-A1-enforcement bundle (Jose greenlight 2026-07-30).
-- Chapter 2308 posture: a tow ticket reading "Other" with no describing
-- note is not defensible. Client-side validation (driver + CA forms)
-- already covers the UI path in this same commit; the CHECK is the
-- direct-INSERT / API-hit backstop.
--
-- ── SHAPE ─────────────────────────────────────────────────────────────
--
--   ALTER TABLE public.violations
--     ADD CONSTRAINT violations_other_requires_note
--     CHECK (
--       violation_type <> 'other'
--       OR (notes IS NOT NULL AND length(trim(notes)) >= 10)
--     )
--     NOT VALID;                             -- see JOSE PRE-APPLY below
--
--   ALTER TABLE public.violations
--     VALIDATE CONSTRAINT violations_other_requires_note;
--
-- NOT VALID + separate VALIDATE is the belt-and-suspenders shape:
-- adds the constraint for NEW rows first (fast, no full-table scan on
-- the CHECK); then validates all EXISTING rows against it. If any
-- existing 'other' row fails, VALIDATE fails but the constraint is
-- still enforcing on writes. Jose's pre-apply diagnostic below must
-- come back clean OR he patches the offending rows BEFORE running
-- VALIDATE.
--
-- ── LOCKED DECISIONS ──────────────────────────────────────────────────
--   1. length(trim(notes)) >= 10 — matches OTHER_NOTE_MIN_LENGTH in
--      app/lib/tow-reasons.ts. Trim guards a 10-space workaround.
--   2. violation_type <> 'other' short-circuits — all non-'other' rows
--      pass regardless of notes. Notes stay optional for other types.
--   3. Constraint on violations, not on a trigger — DIRECT INSERT path
--      (no RPC) means trigger would need BEFORE INSERT + BEFORE UPDATE;
--      CHECK is atomic, simpler, and executes on both.
--   4. Case-sensitive 'other' — the stored codes are lowercase per
--      TOW_REASONS canonical list; historical freetext rows use
--      'Other' (capital O) which passes the CHECK vacuously (they're
--      not 'other'). Old rows unaffected by design.
--
-- ── JOSE PRE-APPLY ────────────────────────────────────────────────────
-- Run 20260730_violations_other_requires_note_diagnostic.sql FIRST.
-- It returns a jsonb readout of every 'other' row's notes length.
-- If any row has length(trim(notes)) < 10:
--   • Confirm it's test data (probably is — 3 rows total per Jose)
--   • DELETE the row OR UPDATE its notes to describe the reason
--   • Re-run the diagnostic; expect all rows to pass
-- ONLY THEN paste this file whole into the Supabase SQL editor. Do
-- NOT paste line-by-line — the two ALTER TABLE statements must land
-- as one atomic operation.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.violations
  ADD CONSTRAINT violations_other_requires_note
  CHECK (
    violation_type <> 'other'
    OR (notes IS NOT NULL AND length(trim(notes)) >= 10)
  )
  NOT VALID;

ALTER TABLE public.violations
  VALIDATE CONSTRAINT violations_other_requires_note;

COMMIT;
