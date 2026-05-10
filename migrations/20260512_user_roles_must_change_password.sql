-- ════════════════════════════════════════════════════════════════════
-- user_roles.must_change_password + helper RPC
-- Locked: May 12, 2026
--
-- Issue 2 from May 11 task: residents created by manager / admin /
-- company_admin currently have no auth user. Fix is to provision an
-- auth account at create-time with a server-generated temp password
-- and force the resident to change it on first login.
--
-- Today the codebase already checks user.user_metadata.force_password_reset
-- (see app/login/page.tsx and app/change-password/page.tsx). But setting
-- that metadata at user-creation time would require swift-handler changes
-- (the Edge Function is outside this repo). Path A from build plan: add
-- a parallel boolean on user_roles, OR'd into the login redirect check.
--
-- The new column is set during the resident-creation flow via the
-- set_must_change_password() RPC below (SECURITY DEFINER, role-gated).
-- /change-password clears it via the same RPC. Existing user_metadata
-- flag continues to work — login OR's both flags.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Column ────────────────────────────────────────────────────────
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. RPC: set_must_change_password(email, value) ───────────────────
-- Authorized callers:
--   - admin / manager / leasing_agent / company_admin (during resident
--     creation in their respective portals)
--   - the user themselves (during /change-password to clear the flag)
-- Anyone else gets 42501 (insufficient privilege).
--
-- Tradeoff: we don't gate this against "target email belongs to your
-- company". A malicious manager could set the flag on a user outside
-- their company. Worst case: that user gets a forced password change
-- on next login. Annoying but bounded — no data exposure.

CREATE OR REPLACE FUNCTION set_must_change_password(p_email TEXT, p_value BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_email TEXT := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_target_email TEXT := lower(coalesce(p_email, ''));
  v_caller_role TEXT;
BEGIN
  IF v_caller_email = '' THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  IF v_target_email = '' THEN
    RAISE EXCEPTION 'email is required' USING ERRCODE = 'P0001';
  END IF;

  -- Self can always toggle their own flag
  IF v_caller_email = v_target_email THEN
    UPDATE user_roles SET must_change_password = p_value
    WHERE lower(email) = v_target_email;
    RETURN;
  END IF;

  -- Otherwise must be an authorized creator role
  SELECT lower(role) INTO v_caller_role
  FROM user_roles WHERE lower(email) = v_caller_email LIMIT 1;

  IF v_caller_role NOT IN ('admin', 'manager', 'leasing_agent', 'company_admin') THEN
    RAISE EXCEPTION 'not authorized to set must_change_password' USING ERRCODE = '42501';
  END IF;

  UPDATE user_roles SET must_change_password = p_value
  WHERE lower(email) = v_target_email;
END;
$$;

GRANT EXECUTE ON FUNCTION set_must_change_password(TEXT, BOOLEAN) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification:
--
-- 1) Column present:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='user_roles'
--     AND column_name='must_change_password';
--
-- 2) RPC present:
--   SELECT proname FROM pg_proc WHERE proname='set_must_change_password';
-- ════════════════════════════════════════════════════════════════════
