-- ════════════════════════════════════════════════════════════════════
-- RT-3 — vehicle_plate_changes.resident_read + mark_my_plate_change_decision_read
-- 2026-07-09
--
-- Adds the mark-as-read rail on plate-change decisions so approved +
-- declined outcomes get a resident-facing acknowledgement (matching
-- the vehicle + space-request patterns). Pre-fix, the resident saw
-- "under review" while pending; once the PM decided, the row silently
-- disappeared from the pending map and the resident had no explicit
-- outcome surface.
--
-- PARTS
--   PART 1 — ADD COLUMN resident_read BOOLEAN NOT NULL DEFAULT FALSE
--   PART 2 — mark_my_plate_change_decision_read(p_id BIGINT) RPC
--            (SECURITY DEFINER, resident-only, own-submitted_by-only)
--
-- INVARIANT
--   Only the resident who submitted the change may mark it read.
--   Submitted_by ILIKE auth.jwt() email (case-insensitive, matches
--   the resident_read_own_plate_changes RLS predicate). Decisions
--   only — pending rows can't be marked read (nothing to acknowledge
--   yet).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- PART 1 — column
ALTER TABLE public.vehicle_plate_changes
  ADD COLUMN IF NOT EXISTS resident_read BOOLEAN NOT NULL DEFAULT FALSE;

-- PART 2 — RPC
CREATE OR REPLACE FUNCTION public.mark_my_plate_change_decision_read(p_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email  TEXT;
  v_row_email     TEXT;
  v_row_status    TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Load row + verify ownership + status is a decision (not pending).
  SELECT submitted_by, status
    INTO v_row_email, v_row_status
    FROM public.vehicle_plate_changes
   WHERE id = p_id;

  IF v_row_email IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF lower(v_row_email) <> lower(v_caller_email) THEN
    RETURN jsonb_build_object('error', 'not_your_plate_change');
  END IF;
  IF v_row_status NOT IN ('approved', 'declined') THEN
    RETURN jsonb_build_object('error', 'not_a_decision',
      'hint', 'Only approved or declined plate changes can be marked read via this RPC. Current status: ' || v_row_status);
  END IF;

  -- Idempotent write.
  UPDATE public.vehicle_plate_changes
     SET resident_read = TRUE
   WHERE id = p_id
     AND resident_read = FALSE;

  RETURN jsonb_build_object('ok', TRUE);
END
$func$;

REVOKE ALL ON FUNCTION public.mark_my_plate_change_decision_read(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_my_plate_change_decision_read(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_my_plate_change_decision_read(BIGINT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'vehicle_plate_changes',
  NULL,
  jsonb_build_object(
    'migration', '20260709_rt3_plate_change_resident_read',
    'rpc',       'mark_my_plate_change_decision_read',
    'change',    'ADD COLUMN resident_read + resident-scoped mark-as-read RPC (approved/declined only)',
    'rationale', 'RT-3 acknowledgement rail — decision outcomes silently disappeared from resident view once no longer pending'
  ),
  now()
);

COMMIT;
