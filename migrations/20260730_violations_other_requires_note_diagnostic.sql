-- ══════════════════════════════════════════════════════════════════════
-- 20260730_violations_other_requires_note_diagnostic.sql
-- PRE-APPLY: list every 'other' row + note-length verdict per row.
-- Read-only. Discipline #8 (jsonb readout, not RAISE) + #9 (ships as
-- a file, not chat).
-- ══════════════════════════════════════════════════════════════════════
--
-- Run this FIRST, before 20260730_violations_other_requires_note.sql.
-- Any row where `passes = false` will fail the CHECK on VALIDATE.
-- Options if surfaced:
--   • Confirm the row is test data → DELETE it, or UPDATE its notes
--   • Re-run this diagnostic; every row should return passes = true
-- ONLY THEN paste the migration.
--
-- Expected today (Jose 2026-07-30): 3 rows, unknown whether their
-- notes meet the threshold. Read the JSON, decide per row.
-- ══════════════════════════════════════════════════════════════════════

SELECT jsonb_build_object(
  'total_other_rows', COUNT(*) FILTER (WHERE violation_type = 'other'),
  'rows_that_will_pass_check', COUNT(*) FILTER (
    WHERE violation_type = 'other'
      AND notes IS NOT NULL
      AND length(trim(notes)) >= 10
  ),
  'rows_that_will_FAIL_check', COUNT(*) FILTER (
    WHERE violation_type = 'other'
      AND (notes IS NULL OR length(trim(notes)) < 10)
  ),
  'per_row', COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'property', property,
        'created_at', created_at,
        'notes', notes,
        'notes_trim_length', COALESCE(length(trim(notes)), 0),
        'passes', (notes IS NOT NULL AND length(trim(notes)) >= 10)
      )
      ORDER BY created_at
    ) FILTER (WHERE violation_type = 'other'),
    '[]'::jsonb
  )
) AS diagnostic
FROM public.violations;
