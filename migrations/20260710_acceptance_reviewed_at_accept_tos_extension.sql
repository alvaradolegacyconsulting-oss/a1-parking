-- ════════════════════════════════════════════════════════════════════
-- accept_tos — reviewed_at extension (Commit 3, part 4/4)
-- 2026-07-10 · Acceptance-surface pass · A1 weekend gating item
--
-- WHY
--   The login re-consent modal at app/login/page.tsx:79 calls
--   accept_tos(p_tos_version, p_privacy_version) — a separate 2-arg
--   RPC from accept_signup_consents. Missed in the earlier 3-migration
--   batch; caught when the client-side gate conversion landed and had
--   no matching write path for reviewed_at at the login modal.
--
--   Without this extension: version-bump re-consent (the highest-
--   frequency ToS/Privacy re-sign path — every existing user hits it
--   when TOS_VERSION or PRIVACY_VERSION bumps) writes tos + privacy
--   rows to tos_acceptances without reviewed_at. Attorney evidence
--   gap same as the pre-extension signup/redeem paths.
--
--   Same additive DEFAULT NULL discipline as the sibling 20260710
--   migrations. Body change: the tos + privacy INSERTs add the
--   reviewed_at column + values. Legacy 0-arg-like path (both
--   versions NULL → just stamp user_roles.tos_accepted_at) unchanged.
--
-- SIGNATURE (4-arg — appends 2 new optional params at tail):
--   accept_tos(
--     p_tos_version         TEXT       DEFAULT NULL,
--     p_privacy_version     TEXT       DEFAULT NULL,
--     p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,  -- NEW (3rd)
--     p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL   -- NEW (4th)
--   )
--
--   Legacy 2-arg callers still succeed (both new params default NULL).
--
-- OVERLOAD DISCIPLINE
--   Explicit DROP of the 2-arg overload IN THIS MIGRATION so post-
--   apply overload_count = 1. Same pattern the 20260604 B118 migration
--   used when it replaced the 0-arg accept_tos with the 2-arg version.
--
-- IDEMPOTENCY UNCHANGED
--   SELECT-then-INSERT keyed on (user_id, document_type, version).
--   reviewed_at is NOT part of the uniqueness key — re-signing
--   preserves the first review timestamp.
--
-- FAILURE MODES (unchanged from 2-arg)
--   'No authenticated session' — no JWT
--   Legacy 0-arg-like path (both versions NULL) still stamps
--   user_roles.tos_accepted_at only.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the 2-arg overload to keep the ACL surface clean.
DROP FUNCTION IF EXISTS public.accept_tos(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.accept_tos(
  p_tos_version         TEXT        DEFAULT NULL,
  p_privacy_version     TEXT        DEFAULT NULL,
  p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,  -- NEW (3rd)
  p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL   -- NEW (4th)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_existing_id   BIGINT;
BEGIN
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'No authenticated session' USING ERRCODE = '42501';
  END IF;

  -- Legacy path: stamp tos_accepted_at only when both versions null.
  -- Preserves existing behavior for any callsite that hasn't migrated
  -- to the version-aware form yet.
  IF p_tos_version IS NULL AND p_privacy_version IS NULL THEN
    UPDATE user_roles
    SET tos_accepted_at = now()
    WHERE email ILIKE v_caller_email
      AND tos_accepted_at IS NULL;
    RETURN;
  END IF;

  -- Version-aware path: write tos_acceptances rows (idempotent) +
  -- stamp user_roles columns. Now with reviewed_at persistence.

  IF p_tos_version IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM tos_acceptances
    WHERE user_id = v_caller_uid
      AND document_type = 'tos'
      AND tos_version = p_tos_version
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      INSERT INTO tos_acceptances (
        user_id, document_type, tos_version,
        privacy_version, attestation_version,
        ip_address, user_agent,
        reviewed_at
      ) VALUES (
        v_caller_uid, 'tos', p_tos_version,
        NULL, NULL,
        NULL, NULL,
        p_tos_reviewed_at
      );
    END IF;
  END IF;

  IF p_privacy_version IS NOT NULL THEN
    v_existing_id := NULL;
    SELECT id INTO v_existing_id
    FROM tos_acceptances
    WHERE user_id = v_caller_uid
      AND document_type = 'privacy'
      AND privacy_version = p_privacy_version
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      INSERT INTO tos_acceptances (
        user_id, document_type, tos_version,
        privacy_version, attestation_version,
        ip_address, user_agent,
        reviewed_at
      ) VALUES (
        v_caller_uid, 'privacy', NULL,
        p_privacy_version, NULL,
        NULL, NULL,
        p_privacy_reviewed_at
      );
    END IF;
  END IF;

  -- Stamp user_roles version columns (unchanged from 2-arg body).
  UPDATE user_roles
  SET tos_accepted_at          = now(),
      tos_accepted_version     = COALESCE(p_tos_version, tos_accepted_version),
      privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
  WHERE email ILIKE v_caller_email;
END
$func$;

-- ACL for the new 4-arg signature.
REVOKE EXECUTE ON FUNCTION public.accept_tos(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_tos(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
GRANT  EXECUTE ON FUNCTION public.accept_tos(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_EXTENDED',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260710_acceptance_reviewed_at_accept_tos_extension',
    'rpc',       'accept_tos',
    'change',    'Extended from 2-arg to 4-arg — appends optional p_tos_reviewed_at + p_privacy_reviewed_at at tail. tos + privacy INSERTs now write reviewed_at column (T1 gate-unlock stamp). Legacy 0-arg-like path (both versions NULL) unchanged. Dropped 2-arg overload preemptively.',
    'rationale', 'Acceptance-surface pass · A1 weekend critical path. Login re-consent modal (the highest-frequency re-sign path on version bumps) uses accept_tos — must persist reviewed_at same as the signup + redeem paths.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function at 4-arg only (no zombie 2-arg overload)
--   SELECT proname, prosecdef,
--          pg_get_function_arguments(oid) AS args,
--          count(*) OVER () AS overload_count
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'accept_tos';
--   -- Expected: 1 row; args =
--   --   'p_tos_version text DEFAULT NULL::text,
--   --    p_privacy_version text DEFAULT NULL::text,
--   --    p_tos_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
--   --    p_privacy_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone'
--   -- Expected: overload_count = 1.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'accept_tos';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.C — Body writes reviewed_at on tos + privacy branches
--   SELECT pg_get_functiondef(oid) AS body
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'accept_tos';
--   -- Grep expected in returned body:
--   --   'p_tos_reviewed_at'      (arg + INSERT for tos branch)
--   --   'p_privacy_reviewed_at'  (arg + INSERT for privacy branch)
--
-- VQ.D — Migration audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_acceptance_reviewed_at_accept_tos_extension'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════
