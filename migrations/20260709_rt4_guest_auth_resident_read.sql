-- ════════════════════════════════════════════════════════════════════
-- RT-4 — guest_authorizations.resident_read + mark_my_guest_auth_declined_read
-- 2026-07-09
--
-- Adds the mark-as-read rail on guest_authorizations so a declined
-- guest auth can be acknowledged by the resident (same shape as the
-- vehicle + space request patterns already shipped). Pre-fix, the
-- Guests tab badge counted every declined row as unread → badge
-- stayed red forever once a resident had any declined guest.
--
-- PARTS
--   PART 1 — ADD COLUMN resident_read BOOLEAN NOT NULL DEFAULT FALSE
--   PART 2 — mark_my_guest_auth_declined_read(p_id BIGINT) RPC
--            (SECURITY DEFINER, resident-only, own-email-only)
--
-- INVARIANT
--   Only the resident who submitted (matches lower(email) = auth.jwt()
--   ->> 'email') may mark their own declined guest as read. RPC role-
--   gates + email-scopes; no manager or CA touches this column.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- PART 1 — column
ALTER TABLE public.guest_authorizations
  ADD COLUMN IF NOT EXISTS resident_read BOOLEAN NOT NULL DEFAULT FALSE;

-- PART 2 — RPC
CREATE OR REPLACE FUNCTION public.mark_my_guest_auth_declined_read(p_id BIGINT)
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

  -- Load row + verify ownership + status.
  SELECT resident_email, status
    INTO v_row_email, v_row_status
    FROM public.guest_authorizations
   WHERE id = p_id;

  IF v_row_email IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF lower(v_row_email) <> lower(v_caller_email) THEN
    RETURN jsonb_build_object('error', 'not_your_guest_auth');
  END IF;
  IF v_row_status <> 'declined' THEN
    RETURN jsonb_build_object('error', 'not_declined',
      'hint', 'Only declined guest authorizations can be marked read via this RPC. Current status: ' || v_row_status);
  END IF;

  -- Idempotent write. Already-read is a no-op returning ok=true.
  UPDATE public.guest_authorizations
     SET resident_read = TRUE
   WHERE id = p_id
     AND resident_read = FALSE;

  RETURN jsonb_build_object('ok', TRUE);
END
$func$;

REVOKE ALL ON FUNCTION public.mark_my_guest_auth_declined_read(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_my_guest_auth_declined_read(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_my_guest_auth_declined_read(BIGINT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'guest_authorizations',
  NULL,
  jsonb_build_object(
    'migration', '20260709_rt4_guest_auth_resident_read',
    'rpc',       'mark_my_guest_auth_declined_read',
    'change',    'ADD COLUMN resident_read + resident-scoped mark-as-read RPC',
    'rationale', 'RT-4 mark-as-read rail — Guests tab badge stayed red forever on declined; parity with vehicle + space_request patterns'
  ),
  now()
);

COMMIT;
