-- ════════════════════════════════════════════════════════════════════
-- record_resident_tos_acceptance — NEW RPC (Commit 3, part 3/3)
-- 2026-07-10 · Acceptance-surface pass · A1 weekend gating item
--
-- WHY
--   Silent-write triage audit (2026-07-10) surfaced that resident
--   registration at app/register/page.tsx:263 was writing ONLY an
--   audit_logs entry — no tos_acceptances rows. Residents were the
--   only user role without a canonical consent record in the same
--   evidence table as CA/manager/driver. For a Texas enforcement
--   product where resident consent can matter in a tow dispute,
--   that is the wrong shape.
--
--   Jose confirmed on 2026-07-10 (acceptance-surface greenlight):
--   close this gap in the same pass that adds the readthrough
--   gate to resident registration. Without this RPC, the resident
--   gate would produce UX evidence with no persisted record.
--
--   A1 onboards residents this weekend. This lands BEFORE A1
--   redeems so every A1 resident signs through the gated flow
--   with a real tos_acceptances row from first login.
--
-- SIGNATURE
--   record_resident_tos_acceptance(
--     p_tos_version         TEXT,
--     p_privacy_version     TEXT,
--     p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,
--     p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL,
--     p_ip_address          INET        DEFAULT NULL,
--     p_user_agent          TEXT        DEFAULT NULL
--   ) RETURNS VOID
--
-- SCOPE — server-derived (Call A confirmed 2026-07-10)
--   Auth guard: auth.uid() non-null AND JWT email non-empty.
--
--   No explicit role gate. Rationale: at registration time the
--   resident has just signed up via swift-handler; they have an
--   auth.users row + a residents row (pending) but user_roles is
--   populated in the same registration transaction later. A role
--   gate here would be a chicken-and-egg problem. Trust the JWT
--   auth + the residents-row lookup + the RLS on tos_acceptances
--   (self-SELECT via user_id = auth.uid()).
--
--   company_id resolution: server-side JOIN via residents row
--     SELECT c.id
--     FROM residents r JOIN companies c ON lower(c.name) = lower(r.company)
--     WHERE lower(r.email) = lower(auth.jwt() ->> 'email')
--     LIMIT 1
--   If the residents row doesn't exist yet OR the company lookup
--   misses (property drift), we still write with company_id = NULL.
--   Matches the accept_signup_consents precedent (company_id NULL
--   during signup before company exists; backfilled later).
--
-- IDEMPOTENCY — SELECT-then-INSERT per row on
--   (user_id, document_type, version). Re-clicks preserve the
--   first review timestamp. Same pattern used by
--   accept_signup_consents + accept_saas_agreement.
--
-- FAILURE MODES
--   'not authenticated'                — no JWT
--   'p_tos_version required'           — client bug
--   'p_privacy_version required'       — client bug
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.record_resident_tos_acceptance(
  p_tos_version         TEXT,
  p_privacy_version     TEXT,
  p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,
  p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL,
  p_ip_address          INET        DEFAULT NULL,
  p_user_agent          TEXT        DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_company_id    BIGINT;
  v_existing_id   BIGINT;
BEGIN
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_tos_version IS NULL OR length(trim(p_tos_version)) = 0 THEN
    RAISE EXCEPTION 'p_tos_version required' USING ERRCODE = '22004';
  END IF;
  IF p_privacy_version IS NULL OR length(trim(p_privacy_version)) = 0 THEN
    RAISE EXCEPTION 'p_privacy_version required' USING ERRCODE = '22004';
  END IF;

  -- ── Server-side company_id resolution (Call A) ───────────────────
  --
  -- Match by email (auth-derived, not client-supplied). Joins the
  -- resident's denormalized company string against companies.name
  -- (case-insensitive). If no match — property/company drift or the
  -- residents row isn't yet created — we still write with
  -- company_id = NULL. Matches the accept_signup_consents precedent
  -- (backfilled later if needed).
  SELECT c.id INTO v_company_id
  FROM public.residents r
  JOIN public.companies c ON lower(c.name) = lower(r.company)
  WHERE lower(r.email) = lower(v_caller_email)
  LIMIT 1;

  -- 1. ToS row — idempotent per (user_id, 'tos', tos_version).
  v_existing_id := NULL;
  SELECT id INTO v_existing_id
  FROM public.tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'tos'
    AND tos_version = p_tos_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO public.tos_acceptances (
      user_id, company_id,
      document_type,
      tos_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id,
      'tos',
      p_tos_version,
      p_ip_address, p_user_agent,
      p_tos_reviewed_at
    );
  END IF;

  -- 2. Privacy row — idempotent per (user_id, 'privacy', privacy_version).
  v_existing_id := NULL;
  SELECT id INTO v_existing_id
  FROM public.tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'privacy'
    AND privacy_version = p_privacy_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO public.tos_acceptances (
      user_id, company_id,
      document_type,
      privacy_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id,
      'privacy',
      p_privacy_version,
      p_ip_address, p_user_agent,
      p_privacy_reviewed_at
    );
  END IF;
END
$func$;

-- ACL — authenticated only. Same discipline as accept_signup_consents.
REVOKE EXECUTE ON FUNCTION public.record_resident_tos_acceptance(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_resident_tos_acceptance(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT
) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_resident_tos_acceptance(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'tos_acceptances',
  NULL,
  jsonb_build_object(
    'migration', '20260710_record_resident_tos_acceptance_rpc',
    'rpc',       'record_resident_tos_acceptance',
    'change',    'New DEFINER RPC — writes tos + privacy rows to tos_acceptances for residents at registration. Closes the gap where resident registration only wrote an audit_logs entry (silent-write triage 2026-07-10). Server-side company_id join via residents.company → companies. Idempotent. Bypasses the residents_self_update RLS gap that would otherwise block the write.',
    'rationale', 'Acceptance-surface pass · A1 weekend critical path. Attorney evidence requires residents in the same canonical tos_acceptances table as CA/manager/driver. Without this RPC, the resident readthrough gate produces UX evidence with no persisted record.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists + SD + args
--   SELECT proname, prosecdef,
--          pg_get_function_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'record_resident_tos_acceptance';
--   -- Expected: 1 row; prosecdef = true; args =
--   --   'p_tos_version text, p_privacy_version text,
--   --    p_tos_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
--   --    p_privacy_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
--   --    p_ip_address inet DEFAULT NULL::inet,
--   --    p_user_agent text DEFAULT NULL::text'
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'record_resident_tos_acceptance';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.C — Migration audit row
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_record_resident_tos_acceptance_rpc'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════
