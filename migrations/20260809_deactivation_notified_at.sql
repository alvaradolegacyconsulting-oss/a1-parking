-- ══════════════════════════════════════════════════════════════════════
-- 20260809_deactivation_notified_at.sql
-- Deactivation-email arc, Commit A (Mateo Aug 9 greenlight).
--
-- Adds `deactivation_notified_at TIMESTAMPTZ` to residents + vehicles.
-- Nullable, no default. Additive; zero callers on apply.
--
-- Feeds the dedup predicate used by Commits C + D:
--
--     deactivation_notified_at IS NULL
--       OR deactivation_notified_at < deactivated_at
--
-- A resident deactivated, reactivated, and deactivated again gets two
-- emails — both are real events. A single deactivation that fires the
-- hook twice sends once. A null check gets the first half right and
-- the second half wrong (Mateo lock, Aug 9 relay).
--
-- ── DO NOT ────────────────────────────────────────────────────────
--
-- - DO NOT add a DEFAULT. NULL is meaningful ("never notified"); a
--   DEFAULT would break the dedup predicate on the very rows it
--   protects.
-- - DO NOT NOT NULL. Every existing row has never been notified.
-- - DO NOT CHECK-constrain the ordering against deactivated_at.
--   deactivation_notified_at may legitimately be later than
--   deactivated_at (send delay), and older than deactivated_at when
--   the row is later re-deactivated (that's the whole point). Any
--   CHECK would fight the dedup semantic.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────
--
-- ALTER TABLE public.residents DROP COLUMN deactivation_notified_at;
-- ALTER TABLE public.vehicles  DROP COLUMN deactivation_notified_at;
--
-- Trivially reversible. No code depends on the column until Commit C.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — residents.deactivation_notified_at ──────────────────────
ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS deactivation_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.residents.deactivation_notified_at IS
  'When the deactivation notification email was successfully sent (or overridden to EMAIL_OVERRIDE_TO for a test/demo tenant). Nullable = never notified. Dedup predicate at the send hook: send only when (deactivation_notified_at IS NULL OR deactivation_notified_at < deactivated_at) so a reactivate-then-redeactivate cycle sends the second email while a double-fire of a single deactivation sends once. Set inside deactivateResidentWrite after the send helper returns ok.';

-- ── PART 2 — vehicles.deactivation_notified_at ───────────────────────
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS deactivation_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vehicles.deactivation_notified_at IS
  'When the vehicle-deactivation notification email was successfully sent (or overridden). Nullable = never notified. Same dedup predicate as residents.deactivation_notified_at. Set inside deactivateVehicleWrite after the send helper returns ok. The three-cars-one-email invariant does NOT rely on this column — it falls out of Option A''s writer-only hook placement (cascade paths bypass the writer, so the hook never fires for cascade-deactivated vehicles); this column exists to dedup a repeated-fire against a single writer-initiated deactivation.';

-- ── PART 3 — SCHEMA_ audit row ───────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_ADD_DEACTIVATION_NOTIFIED_AT',
  'residents,vehicles',
  NULL,
  jsonb_build_object(
    'migration', '20260809_deactivation_notified_at',
    'purpose',   'Deactivation-email arc Commit A. Adds deactivation_notified_at TIMESTAMPTZ (nullable, no default) to both residents and vehicles. Feeds the dedup predicate (deactivation_notified_at IS NULL OR deactivation_notified_at < deactivated_at) used by the send hooks in deactivateResidentWrite + deactivateVehicleWrite (Commits C + D). Zero callers on apply; column is populated only after Commit C/D land.',
    'do_not', jsonb_build_array(
      'DEFAULT — NULL is the "never notified" signal',
      'NOT NULL — every existing row has never been notified',
      'CHECK against deactivated_at — the dedup semantic requires both directions of the comparison'
    ),
    'follow_ups', jsonb_build_object(
      'commit_b', 'sendCompanyScopedEmail helper + notify-resident-decision migration + gate probes',
      'commit_c', 'resident-deactivation email hook inside deactivateResidentWrite; dedup on this column',
      'commit_d', 'vehicle-deactivation email hook inside deactivateVehicleWrite; dedup on this column',
      'commit_e', 'notify-resident-decision send dedup (independent of this column; different mechanism)'
    )
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_ADD_DEACTIVATION_NOTIFIED_AT'
     AND new_values->>'migration' = '20260809_deactivation_notified_at'
);

COMMIT;
