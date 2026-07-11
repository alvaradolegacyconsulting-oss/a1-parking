-- ════════════════════════════════════════════════════════════════════
-- accept_signup_consents — reviewed_at extension (Commit 3, part 1/3)
-- 2026-07-10 · Acceptance-surface pass · A1 weekend gating item
--
-- WHY
--   Attorney's ask for the ToS/Privacy readthrough gate is that
--   acceptance carry the same T1 (finished reading) → T2 (clicked
--   sign) evidence gap the SaaS gate already records. reviewed_at is
--   the T1 stamp; the row's own accepted_at column is T2. Extending
--   the write path is the whole point — a version stamp alone would
--   be UX theater without the persisted timestamp.
--
--   The tos_acceptances.reviewed_at column already exists (added by
--   the 20260707 SaaS Layer 2 schema migration for the SaaS row).
--   This migration extends accept_signup_consents to WRITE it on
--   the tos + privacy rows too. No schema change; RPC signature +
--   body only.
--
-- SIGNATURE (7-arg — appends 2 new optional params at tail):
--   accept_signup_consents(
--     p_attestation_version TEXT,
--     p_tos_version         TEXT,
--     p_privacy_version     TEXT,
--     p_ip_address          INET       DEFAULT NULL,
--     p_user_agent          TEXT       DEFAULT NULL,
--     p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,  -- NEW (6th)
--     p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL   -- NEW (7th)
--   )
--
--   Both new params DEFAULT NULL — mid-deploy legacy callers that
--   send only 5 args still succeed. The tos + privacy INSERTs write
--   reviewed_at when non-null; texas_attestation branch never gets
--   reviewed_at (attestation is a checkbox, not a gate).
--
-- OVERLOAD DISCIPLINE
--   Signature change creates a new overload. Explicit DROP of the
--   5-arg signature IN THIS MIGRATION so post-apply VQ.A reports
--   overload_count = 1 (no zombie signature). Same pattern the
--   20260707 SaaS extension used.
--
-- IDEMPOTENCY UNCHANGED
--   SELECT-then-INSERT per row keyed on (user_id, document_type,
--   version). reviewed_at is NOT part of the uniqueness key —
--   re-signing preserves the first review timestamp (correct;
--   attorney evidence is when they FIRST reviewed, not the last
--   re-sign click).
--
-- FAILURE MODES (unchanged from prior signature)
--   'No authenticated session' — no JWT
--   'All three versions required' — one of attestation/tos/privacy null
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the 5-arg overload to keep the ACL surface clean.
DROP FUNCTION IF EXISTS public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT);

CREATE OR REPLACE FUNCTION public.accept_signup_consents(
  p_attestation_version TEXT,
  p_tos_version         TEXT,
  p_privacy_version     TEXT,
  p_ip_address          INET        DEFAULT NULL,
  p_user_agent          TEXT        DEFAULT NULL,
  p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,  -- NEW (6th)
  p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL   -- NEW (7th)
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

  IF p_attestation_version IS NULL OR p_tos_version IS NULL OR p_privacy_version IS NULL THEN
    RAISE EXCEPTION 'All three versions (attestation, tos, privacy) required' USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Texas attestation row (no reviewed_at — checkbox, not a gate).
  SELECT id INTO v_existing_id
  FROM tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'texas_attestation'
    AND attestation_version = p_attestation_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO tos_acceptances (
      user_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, 'texas_attestation',
      NULL, NULL, p_attestation_version,
      p_ip_address, p_user_agent
    );
  END IF;

  -- 2. ToS row — WRITES reviewed_at (T1).
  v_existing_id := NULL;
  SELECT id INTO v_existing_id
  FROM tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'tos'
    AND tos_version = p_tos_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO tos_acceptances (
      user_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, 'tos',
      p_tos_version, NULL, NULL,
      p_ip_address, p_user_agent,
      p_tos_reviewed_at
    );
  END IF;

  -- 3. Privacy row — WRITES reviewed_at (T1).
  v_existing_id := NULL;
  SELECT id INTO v_existing_id
  FROM tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'privacy'
    AND privacy_version = p_privacy_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO tos_acceptances (
      user_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, 'privacy',
      NULL, p_privacy_version, NULL,
      p_ip_address, p_user_agent,
      p_privacy_reviewed_at
    );
  END IF;
END
$func$;

-- ACL for the new 7-arg signature.
REVOKE EXECUTE ON FUNCTION public.accept_signup_consents(
  TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_signup_consents(
  TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
GRANT  EXECUTE ON FUNCTION public.accept_signup_consents(
  TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_EXTENDED',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260710_acceptance_reviewed_at_signup_extension',
    'rpc',       'accept_signup_consents',
    'change',    'Extended from 5-arg to 7-arg — appends optional p_tos_reviewed_at + p_privacy_reviewed_at at tail. ToS + Privacy INSERTs now write reviewed_at column (T1 gate-unlock stamp). Attestation branch unchanged (checkbox, no gate). Dropped 5-arg overload preemptively.',
    'rationale', 'Acceptance-surface pass · A1 weekend critical path. Attorney evidence gap requires reviewed_at persistence on ToS + Privacy rows matching the SaaS pattern.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists at 7-arg signature only (no zombie 5-arg)
--   SELECT proname, prosecdef,
--          pg_get_function_arguments(oid) AS args,
--          count(*) OVER () AS overload_count
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'accept_signup_consents';
--   -- Expected: 1 row; args = 'p_attestation_version text, p_tos_version text,
--   --   p_privacy_version text, p_ip_address inet DEFAULT NULL::inet,
--   --   p_user_agent text DEFAULT NULL::text,
--   --   p_tos_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
--   --   p_privacy_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone';
--   -- Expected: overload_count = 1.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'accept_signup_consents';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.C — Body writes reviewed_at on tos + privacy branches
--   SELECT pg_get_functiondef(oid) AS body
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'accept_signup_consents';
--   -- Grep expected in returned body:
--   --   'p_tos_reviewed_at'      (both as arg AND in INSERT VALUES for tos branch)
--   --   'p_privacy_reviewed_at'  (both as arg AND in INSERT VALUES for privacy branch)
--
-- VQ.D — Migration audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_acceptance_reviewed_at_signup_extension'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════
