-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_drop_creation_trigger.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT Commit A — pure removal of the creation trigger.
--
-- ── Design pivot (Jose 2026-07-23) ─────────────────────────────────────
-- Original design: BEFORE INSERT trigger on violations rejects DNT plates
-- at creation time. Rationale: authoritative gate at the write layer,
-- no client/RPC/service_role path bypasses.
--
-- Revised design: TAG ALLOWED, TOW BLOCKED. Consistent with resident
-- model — authorization to be present ≠ immunity from citation. A DNT
-- vehicle can still be blocking a fire lane or occupying someone else's
-- reserved space; a manager needs the tag record to make list-adjustment
-- decisions. The list protects the vehicle from the TRUCK, not from
-- the CITATION.
--
-- Enforcement moves entirely to the tow decision:
--   • set_violation_status(id,'tow_ticket') — RPC-level DNT guard
--   • stamp_tow_ticket(id, ...)             — RPC-level DNT guard
--   • regenerate_tow_ticket(...)            — RPC-level DNT guard [added in Commit B]
--   • CSV export                             — client-side DNT filter [added in Commit B]
--
-- Corrective paths remain allowed on DNT plates:
--   • set_violation_status → resolved / disputed
--   • void_violation
--
-- ── Why this commit is pure removal ────────────────────────────────────
-- Boundary set per Mateo 2026-07-23 to avoid touching regenerate_tow_ticket
-- twice. Commit B rewrites regenerate_tow_ticket ONCE with both the DNT
-- guard AND company scope. This commit only removes.
--
-- ── Safety ─────────────────────────────────────────────────────────────
-- do_not_tow_plates table has ZERO rows. The creation trigger has never
-- fired against any real production write. Removal is functionally
-- inert — no behavior change today. Commit B (or the interim state
-- between A and B) is safe because nothing is protectable until DNT
-- Commit 5 lands and a manager adds a plate.
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────
-- To restore the dropped trigger + function, re-apply the CREATE FUNCTION
-- and CREATE TRIGGER blocks from:
--   migrations/20260723_do_not_tow_cascade_and_guards.sql, lines 101–140
--     - lines 101–134: CREATE OR REPLACE FUNCTION public.dnt_reject_violation_insert()
--     - lines 136–140: DROP TRIGGER IF EXISTS + CREATE TRIGGER dnt_reject_violation_insert_trigger
-- NOT recoverable from pg_get_functiondef after this migration applies —
-- source lives ONLY in the migration file. Line numbers verified against
-- the file at the time this header was written; if the file has been
-- edited since, re-locate with:
--   grep -n 'dnt_reject_violation_insert' migrations/20260723_do_not_tow_cascade_and_guards.sql

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Drop the trigger
-- ══════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS dnt_reject_violation_insert_trigger ON public.violations;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — Drop the trigger function
-- ══════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.dnt_reject_violation_insert();

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_DNT_DROP_CREATION_TRIGGER',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260723_dnt_drop_creation_trigger',
    'purpose',   'DNT Commit A — pure removal. Drops dnt_reject_violation_insert_trigger + function. Enforcement moves entirely to tow-decision RPCs per revised tag-not-block model.',
    'rationale', 'Resident-consistent: authorization to be present ≠ immunity from citation. Tag allowed for the record; tow refused at ticket time. Manager needs tag history to decide whether the DNT plate should stay on the list; a rejected INSERT leaves no trace.',
    'safety',    'do_not_tow_plates has 0 rows; trigger has never fired. Removal is functionally inert today.',
    'followup',  'Commit B adds regenerate_tow_ticket DNT guard (currently unguarded — was implicitly covered by the creation trigger; now needs explicit RPC guard) + company scope on all 5 lookup sites + CSV export filter + VQ.PARITY.'
  ),
  now()
);

COMMIT;
