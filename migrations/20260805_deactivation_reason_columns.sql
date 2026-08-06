-- ══════════════════════════════════════════════════════════════════════
-- 20260805_deactivation_reason_columns.sql
-- TASK 3 Commit 1 of the deactivation-reasons arc (Mateo Aug 5 spec).
-- Adds 4 columns to residents + vehicles for the structured
-- deactivation-reason field. Additive. Zero callers.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS MIGRATION SHIPS ALONE ──────────────────────────────────
--
-- Additive schema change. No callers until Task 3 Commits 2 and 3
-- extract deactivateResidentWrite / deactivateVehicleWrite and populate
-- these columns. Rolling out the schema first means:
--   - the follow-up commits can ship one at a time (residents Commit 2,
--     vehicles Commit 3) with independent rollback
--   - the columns exist for any hand-audit query Jose might run before
--     Commits 2 and 3 apply
--   - if Findings D+E (see Aug 5 relay #2) block the UI work, the
--     schema is already there and can be used from an admin-only path
--     while the manager UI waits
--
-- ── DELIBERATE: NO CHECK CONSTRAINT ON deactivation_reason ──────────
--
-- Instinct says "constrain reason to the valid codes." Do NOT.
--
-- The TS module (app/lib/deactivation-reasons.ts, added in Commit 2)
-- is the single source of truth for codes + labels + `notifies`
-- boolean. A SQL CHECK duplicates that list. This codebase already
-- carries the tier-config.ts / get_company_property_limit() drift as
-- a warning — the numeric caps mirrored between TS and SQL slowly
-- diverged until nobody remembered which was authoritative.
--
-- Same class here: if we add a code in TS and forget the SQL CHECK,
-- writes fail with a check_violation; if we drop a code in TS and
-- forget the CHECK, old rows survive but new writes fail. Both are
-- distraction, neither catches a real defect (codes come from a
-- dropdown, not user free-text — typos aren't a real path).
--
-- SQL stores the code as opaque text. TS interprets it.
--
-- ── DELIBERATE: NULLABLE, AND NULL-AS-SIGNAL ────────────────────────
--
-- Requiredness is enforced in the WRITE HELPER (Commit 2/3), not the
-- database. Consequence: a NULL reason on a row deactivated AFTER
-- Commit 2/3 lands means a write path BYPASSED the helper. That's a
-- queryable regression detector — worth more than the false safety of
-- a NOT NULL DEFAULT that would silently paper over the bypass.
--
-- Do NOT "fix" the NULL-ability with NOT NULL DEFAULT '<something>'.
-- The nullability is deliberate signal.
--
-- ── DELIBERATE: deactivated_by IS NOT EVIDENCE ──────────────────────
--
-- These columns are populated via direct client updates. Nothing in
-- SQL verifies the actor. `deactivated_by` is client-supplied and
-- spoofable — a manager could pass their colleague's email into it.
--
-- The TRUSTWORTHY record is the audit_logs row, whose RLS WITH CHECK
-- enforces self-attribution via JWT email. `deactivated_by` on the
-- table is for CRM display convenience only (so the manager reading
-- the record sees who deactivated without a join to audit_logs).
--
-- Do NOT cite this column as evidence in a dispute. Cite audit_logs.
--
-- ── NO BACKFILL ──────────────────────────────────────────────────────
--
-- Existing deactivated rows predate the field. NULL renders as "No
-- reason recorded" (Commit 2/3 CRM display). Honest — do not invent
-- history. A mild nudge if the manager wants to know "when did this
-- get deactivated"; they can look at audit_logs for the answer.
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- None. Additive columns on public.residents + public.vehicles.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── residents ────────────────────────────────────────────────────────
ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS deactivation_reason TEXT,
  ADD COLUMN IF NOT EXISTS deactivation_note   TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_by      TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.residents.deactivation_reason IS
  'Deactivation reason CODE (never label). Values managed by app/lib/deactivation-reasons.ts (TS module is the single source of truth for codes + labels + notifies boolean; SQL stores as opaque text and does not interpret). Deliberately no CHECK constraint — see 20260805_deactivation_reason_columns.sql header for rationale (tier-config drift class). Deliberately NULLABLE — a NULL on a row deactivated after 2026-08-05 Task 3 Commit 2 ships means a write path bypassed deactivateResidentWrite; that is a queryable regression detector, not a gap to backfill. Existing pre-2026-08-05 deactivated rows carry NULL and render as "No reason recorded" — do not backfill invented history.';

COMMENT ON COLUMN public.residents.deactivation_note IS
  'Optional free-text note. Required by the write helper when deactivation_reason=''other''. 256-char cap enforced at helper, not SQL. INTERNAL ONLY — rendered in the manager CRM when is_active=false. Not shown in the resident portal, not in any email, not on any driver surface (same data-minimization rule as B225 driver_email removal). Do NOT reuse the manager_note convention — that column renders directly to residents at resident/page.tsx:958-961.';

COMMENT ON COLUMN public.residents.deactivated_by IS
  'CRM display convenience only. Client-supplied and spoofable — no SQL verification of the actor. The trustworthy record of who deactivated is the audit_logs row (RLS WITH CHECK enforces self-attribution via JWT email). Do NOT cite this column as evidence in a dispute — cite audit_logs.';

COMMENT ON COLUMN public.residents.deactivated_at IS
  'CRM display convenience. Populated by the write helper alongside deactivation_reason. Not the same as audit_logs.created_at (which is the trustworthy record).';


-- ── vehicles ─────────────────────────────────────────────────────────
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS deactivation_reason TEXT,
  ADD COLUMN IF NOT EXISTS deactivation_note   TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_by      TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.vehicles.deactivation_reason IS
  'Deactivation reason CODE (never label). Values managed by app/lib/deactivation-reasons.ts. Deliberately no CHECK, deliberately NULLABLE — see residents.deactivation_reason comment. Distinct code set from residents (a vehicle can be `plate_superseded` — retired because the resident submitted a new plate; a resident cannot). Includes system codes for cascades (`cascade_resident_deactivated`, `owner_trim`, `admin_cascade`) that are never manager-selectable but stamp cascade-produced rows.';

COMMENT ON COLUMN public.vehicles.deactivation_note IS
  'Optional free-text note. Required when reason=''other''. INTERNAL ONLY — see residents.deactivation_note comment.';

COMMENT ON COLUMN public.vehicles.deactivated_by IS
  'Display convenience; spoofable. See residents.deactivated_by comment. Trustworthy record = audit_logs.';

COMMENT ON COLUMN public.vehicles.deactivated_at IS
  'Display convenience. See residents.deactivated_at comment.';


-- ── SCHEMA_ audit ────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_DEACTIVATION_REASON_COLUMNS',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260805_deactivation_reason_columns',
    'purpose',   'Task 3 Commit 1 (Mateo Aug 5): additive columns for structured deactivation reasons. Zero callers until Task 3 Commits 2 (deactivateResidentWrite) and 3 (deactivateVehicleWrite) extract the write cores and populate. Backfills nothing.',
    'columns_added', jsonb_build_object(
      'residents', jsonb_build_array('deactivation_reason', 'deactivation_note', 'deactivated_by', 'deactivated_at'),
      'vehicles',  jsonb_build_array('deactivation_reason', 'deactivation_note', 'deactivated_by', 'deactivated_at')
    ),
    'invariants', jsonb_build_object(
      'no_check_constraint', 'Deliberate. TS module (app/lib/deactivation-reasons.ts, added in Commit 2) is single source of truth for codes. SQL CHECK would duplicate the list and produce tier-config-style drift.',
      'nullable_deliberate', 'A NULL reason on a row deactivated AFTER Commit 2/3 = write path bypassed helper. Queryable regression detector.',
      'deactivated_by_not_evidence', 'Client-supplied, spoofable. audit_logs row is the trustworthy record.',
      'no_backfill', 'Existing rows keep NULL and render as "No reason recorded". Do not invent history.'
    ),
    'follow_ups', jsonb_build_object(
      'commit_2', 'Task 3 Commit 2 — resident path: TS module + deactivateResidentWrite + dropdown + CRM display + audit shape',
      'commit_3', 'Task 3 Commit 3 — vehicle path: deactivateVehicleWrite + server-side authority check (closes 1c1ce5a gate flip render-side gap) + dropdown + CRM display + audit shape',
      'commit_4_plus', 'Emails (resident + vehicle) with EMAIL_OVERRIDE_TO safe-test infra + dunning-style dedup'
    )
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_DEACTIVATION_REASON_COLUMNS'
     AND new_values->>'migration' = '20260805_deactivation_reason_columns'
);

COMMIT;
