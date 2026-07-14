-- ════════════════════════════════════════════════════════════════════
-- Audit correction — SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL
-- 2026-07-13
--
-- WHY
--   The backfill migration (20260713_tos_acceptances_company_id_
--   backfill.sql) computed its `residual_null_rows` audit field via a
--   COUNT inside the SAME CTE as its UPDATE. Postgres CTE snapshot
--   semantics: sub-queries within a single top-level statement all
--   see the same pre-mutation snapshot of the row. So the audit row
--   was written with `residual_null_rows = 28` (the PRE-UPDATE count)
--   when the TRUE post-state was 2 (both admin, super-admin exempt by
--   design per the derivation migration).
--
--   audit_logs is a compliance record. Leaving a row that misstates
--   its own outcome is worse than no row — future readers (Jose, an
--   attorney reconstructing what happened, a super-admin auditing a
--   version bump) conclude the backfill FAILED.
--
-- WHAT THIS CORRECTS
--   • Rewrite `residual_null_rows` in the original audit row's
--     new_values from 28 → the true post-state count (2).
--   • Append `correction_note` to the same new_values documenting
--     the correction, the reason, and the date. The record now shows
--     BOTH the truth AND the fact of correction — visible, not silent.
--
-- WHY UPDATE-IN-PLACE VS APPEND A NEW ROW
--   Both approaches were considered. This migration takes the "in-
--   place with visible correction_note" shape (per Mateo's directive):
--   a reader querying the backfill's audit row sees `residual_null_
--   rows = 2` alongside `correction_note = ...`, one row, no cross-
--   reference chasing. Full immutability would require an append-
--   only ledger design that audit_logs doesn't have today. If we
--   move audit_logs to append-only in a future migration, this row's
--   correction_note is the artifact that survives the migration.
--
-- ── STANDING RULE (codify in migration conventions) ─────────────────
--   Any audit_logs row that reports post-state counts MUST compute
--   those counts in a statement AFTER the mutation, never inside the
--   same CTE as the mutation. Post-state COUNT queries and mutation
--   sub-queries must live in different top-level statements so the
--   COUNT reads the post-commit-inside-transaction visibility of the
--   UPDATE.
--
--   Correct pattern:
--     WITH updated AS (UPDATE ... RETURNING id) SELECT COUNT(*) FROM updated;   -- ← safe: reads updated CTE
--     INSERT INTO audit_logs (...)
--       SELECT ..., (SELECT COUNT(*) FROM public.<table> WHERE <post-state predicate>);
--                                                         -- ← now reads the mutated state
--
--   Incorrect (what this migration corrects):
--     WITH updated AS (UPDATE ... RETURNING id)
--     INSERT INTO audit_logs (...) SELECT ...,
--       (SELECT COUNT(*) FROM public.<table> WHERE <post-state predicate>);
--                                                         -- ← reads pre-mutation snapshot
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Sanity: exactly one backfill audit row to correct ────────────
DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 backfill audit row to correct; found %', v_count;
  END IF;
END $chk$;

-- ── Correction: rewrite residual_null_rows + append correction_note
UPDATE public.audit_logs
   SET new_values =
         jsonb_set(
           new_values,
           '{residual_null_rows}',
           to_jsonb((SELECT COUNT(*) FROM public.tos_acceptances WHERE company_id IS NULL))
         )
         || jsonb_build_object(
              'correction_note',
              'residual_null_rows originally recorded 28 (CTE pre-mutation snapshot inside a single top-level statement; sub-query read the pre-UPDATE state, not the post-UPDATE state). True post-state is 2 — both admin rows, company=NULL by super-admin exempt design. Corrected 2026-07-13. Standing rule added to migration conventions in this migration''s header block: post-state audit counts must live in a statement AFTER the mutation, never inside the same CTE.'
            )
 WHERE action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL';

-- ── Companion audit row: forward-only record of the correction ───
-- The UPDATE above rewrites the original row's field. This INSERT
-- preserves an append-only footprint of the correction event itself,
-- so a future reader who queries by created_at range sees both the
-- backfill and the correction as distinct compliance events.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'AUDIT_CORRECTION_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL',
  'audit_logs',
  NULL,
  jsonb_build_object(
    'migration',        '20260713_backfill_audit_correction',
    'corrects_action',  'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_BACKFILL',
    'corrects_migration','20260713_tos_acceptances_company_id_backfill',
    'change',           'Rewrote residual_null_rows in the backfill audit row from 28 (pre-mutation CTE snapshot) to actual post-state count. Appended correction_note documenting the reason. Standing rule codified: post-state audit counts must live in a statement AFTER the mutation.',
    'true_post_state',  (SELECT COUNT(*) FROM public.tos_acceptances WHERE company_id IS NULL),
    'true_flipped',     26,
    'rationale',        'audit_logs is a compliance record; a row that misstates its own outcome is worse than no row. Backfill worked correctly (verified independently via per-role VQ + A1 driver row check); only the metadata field was wrong. This correction makes the ledger match the ground truth while preserving a visible record of the correction.'
  ),
  now()
);

COMMIT;
