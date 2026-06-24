-- Spaces v1.1 hotfix migration — relax spaces_assignment_coherence CHECK
--
-- WHY: the original CHECK from commit 1 (20260621_spaces_v1_schema.sql:195-199)
-- coupled status='assigned' to assigned_to_resident_email IS NOT NULL. That
-- was correct in v1 (1:1 single-resident world). In v1.1 the legacy column
-- is intentionally NULL when the set has 2+ residents (dual-write rule —
-- email when set-size=1, NULL when set-size=0 or 2+). The 1→2 transition
-- in assign_space therefore produces a row state (status='assigned',
-- email=NULL) that the old CHECK forbids.
--
-- UAT 2026-06-23 hit this on every attempt to add a second resident.
--
-- THE FIX moves one half of coherence to the RPC/trigger layer (where it
-- was already atomically guaranteed) and keeps the other half in-row:
--
--   OLD CHECK: status='assigned' ⇔ email IS NOT NULL
--              (forbids the multi-resident state)
--
--   NEW CHECK: email IS NULL OR status='assigned'
--              ("if email is populated, status must be 'assigned'")
--
-- Truth table:
--   status='assigned'              + email NULL     → ✓ (2+ residents)
--   status='assigned'              + email NOT NULL → ✓ (1 resident)
--   status='available'/'occupied'/'reserved' + email NULL     → ✓ (0 residents)
--   status='available'/'occupied'/'reserved' + email NOT NULL → ✗ (data drift)
--
-- The "assigned ⇒ ≥1 tie" half (which the old CHECK approximated via the
-- legacy column as a proxy) is now guaranteed by:
--   1. assign_space atomicity — inserts the tie BEFORE flipping status
--   2. free_space atomicity — flips status='available' in the same txn
--      as the last tie DELETE
--   3. trigger atomicity — same discipline as free_space
--   4. decommission_space — pre-gated on empty set
--   5. RLS on spaces table — only admin/CA can UPDATE directly; managers
--      and drivers must route through the RPCs
--   6. FK space_residents.space_id → spaces(id) — no orphan ties possible
--
-- NOT a loss of safety; correction of a proxy that no longer represents
-- the truth in multi-resident state.
--
-- SAFETY CONFIRMED PRE-APPLY (Mateo audit 2026-06-23):
--   - 8 of 9 RPC/trigger transitions are already compliant with the new
--     CHECK (see Section E of verification file for the comprehensive trace)
--   - The 1 violating transition (assign_space 1→2) is exactly the bug
--     this relaxes
--   - No production data currently violates the new CHECK (verified by
--     Section B query in verification file — must run pre-apply)

BEGIN;

ALTER TABLE public.spaces
  DROP CONSTRAINT IF EXISTS spaces_assignment_coherence;

ALTER TABLE public.spaces
  ADD CONSTRAINT spaces_assignment_coherence CHECK (
    assigned_to_resident_email IS NULL OR status = 'assigned'
  );

-- Audit row so the relaxation is discoverable in audit_logs without
-- needing to grep the migrations folder.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1_1',
  'SCHEMA_CONSTRAINT_RELAX',
  'spaces',
  NULL,
  jsonb_build_object(
    'constraint_name',  'spaces_assignment_coherence',
    'migration',        '20260623_spaces_v1_1_coherence_check_relax',
    'old_definition',   'status=assigned <-> email IS NOT NULL',
    'new_definition',   'email IS NULL OR status=assigned',
    'reason',           'v1.1 multi-resident state requires email=NULL while status=assigned',
    'coherence_guard',  'moved to RPC/trigger atomicity + RLS + FK'
  ),
  now()
);

COMMIT;
