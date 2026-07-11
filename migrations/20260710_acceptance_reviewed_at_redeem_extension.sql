-- ════════════════════════════════════════════════════════════════════
-- redeem_proposal_code — reviewed_at extension (Commit 3, part 2/3)
-- 2026-07-10 · Acceptance-surface pass · A1 weekend gating item
--
-- WHY
--   A1 redeems this weekend. Their acceptance at redeem needs to
--   carry the same T1 (finished reading) → T2 (clicked sign)
--   evidence the SaaS gate already records — for the ToS + Privacy
--   docs too. Attorney ask; matches the accept_signup_consents
--   extension in the sibling 20260710 migration.
--
--   Same additive DEFAULT NULL discipline the SaaS-redeem extension
--   used (20260707_b118_layer2_saas_redeem_extension). Body changes:
--   the tos + privacy INSERTs at Section 4a + 4b add the reviewed_at
--   column + values. No other body changes.
--
-- SIGNATURE (15-arg — appends 2 new optional params at tail):
--   redeem_proposal_code(
--     p_code, p_user_id, p_company_name,
--     p_primary_contact_name, p_primary_contact_phone,
--     p_tos_version, p_privacy_version,
--     p_address, p_ip_address, p_user_agent,
--     p_attestation_version,
--     p_saas_version, p_saas_reviewed_at,
--     p_tos_reviewed_at,      -- NEW (14th)
--     p_privacy_reviewed_at   -- NEW (15th)
--   )
--
-- OVERLOAD DISCIPLINE (matches 20260707 pattern verbatim)
--   Explicit DROP of the 13-arg signature IN THIS MIGRATION so
--   post-apply overload_count = 1. Same [[feedback_function_public_grant_
--   supabase_default]] + [[feedback_revoke_from_anon_explicitly]] rules.
--
-- FAILURE MODES (unchanged from 13-arg)
--   'unauthenticated'          — no JWT
--   'auth.uid mismatch'        — client tampering
--   'company_name required'    — missing param
--   'tos_version/privacy_version required'
--   'code not found' / 'not redeemable' / 'expired'
--   'company name already in use'
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the 13-arg overload to keep the ACL surface clean.
DROP FUNCTION IF EXISTS public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
  p_address                TEXT        DEFAULT NULL,
  p_ip_address             INET        DEFAULT NULL,
  p_user_agent             TEXT        DEFAULT NULL,
  p_attestation_version    TEXT        DEFAULT NULL,
  p_saas_version           TEXT        DEFAULT NULL,
  p_saas_reviewed_at       TIMESTAMPTZ DEFAULT NULL,
  p_tos_reviewed_at        TIMESTAMPTZ DEFAULT NULL,   -- NEW (14th)
  p_privacy_reviewed_at    TIMESTAMPTZ DEFAULT NULL    -- NEW (15th)
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_code          proposal_codes%ROWTYPE;
  v_company_id    BIGINT;
BEGIN
  -- ── Auth sanity ──────────────────────────────────────────────────
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;
  IF v_caller_uid <> p_user_id THEN
    RAISE EXCEPTION 'auth.uid mismatch with p_user_id' USING ERRCODE = 'check_violation';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller_uid LIMIT 1;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'caller email not found' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Required-field sanity ────────────────────────────────────────
  IF p_company_name IS NULL OR length(trim(p_company_name)) = 0 THEN
    RAISE EXCEPTION 'company_name required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_tos_version IS NULL OR p_privacy_version IS NULL THEN
    RAISE EXCEPTION 'tos_version and privacy_version required' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Validate code under row lock (prevents double-redeem race) ───
  SELECT * INTO v_code FROM proposal_codes WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'code not found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.status <> 'issued' THEN
    RAISE EXCEPTION 'code not redeemable (status=%)' , v_code.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.base_tier IS NULL OR v_code.base_tier_type IS NULL THEN
    RAISE EXCEPTION 'code missing base tier/tier_type — not self-serve-ready' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM companies WHERE name ILIKE p_company_name) THEN
    RAISE EXCEPTION 'company name already in use' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Create company in configuring state ───────────────────────
  INSERT INTO companies (
    name, tier, tier_type,
    primary_contact_name, phone,
    address,
    acquisition_channel,
    is_active
  ) VALUES (
    p_company_name,
    v_code.base_tier,
    v_code.base_tier_type,
    p_primary_contact_name,
    p_primary_contact_phone,
    p_address,
    'proposal_code',
    TRUE
  )
  RETURNING id INTO v_company_id;

  -- ── 2. Insert user_roles row (company_admin, no property scope) ──
  INSERT INTO user_roles (email, role, company, property)
  VALUES (
    lower(v_caller_email),
    'company_admin',
    p_company_name,
    '{}'::text[]
  );

  -- ── 3. Link the code to the new company + flip status ────────────
  UPDATE proposal_codes
  SET company_id = v_company_id,
      status     = 'redeemed',
      redeemed_at = now()
  WHERE id = v_code.id;

  -- ── 4a. ToS acceptance row — NOW WRITES reviewed_at (T1) ─────────
  INSERT INTO tos_acceptances (
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

  -- ── 4b. Privacy acceptance row — NOW WRITES reviewed_at (T1) ─────
  INSERT INTO tos_acceptances (
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

  -- ── 4c. Texas attestation if version supplied (unchanged) ────────
  IF p_attestation_version IS NOT NULL THEN
    INSERT INTO tos_acceptances (
      user_id, company_id,
      document_type,
      attestation_version,
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, v_company_id,
      'texas_attestation',
      p_attestation_version,
      p_ip_address, p_user_agent
    );
  END IF;

  -- ── 4d. SaaS acceptance if both params supplied (unchanged) ──────
  IF p_saas_version IS NOT NULL AND p_saas_reviewed_at IS NOT NULL THEN
    INSERT INTO tos_acceptances (
      user_id, company_id,
      document_type,
      saas_version,
      reviewed_at,
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, v_company_id,
      'saas',
      p_saas_version,
      p_saas_reviewed_at,
      p_ip_address, p_user_agent
    );
  END IF;

  -- ── 5. Stamp user_roles version columns (unchanged) ──────────────
  UPDATE user_roles
  SET tos_accepted_at          = now(),
      tos_accepted_version     = p_tos_version,
      privacy_accepted_version = p_privacy_version,
      saas_accepted_version    = COALESCE(p_saas_version, saas_accepted_version)
  WHERE lower(email) = lower(v_caller_email);

  -- ── 6. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$func$;

-- ACL for the new 15-arg signature.
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_EXTENDED',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260710_acceptance_reviewed_at_redeem_extension',
    'rpc',       'redeem_proposal_code',
    'change',    'Extended from 13-arg to 15-arg — appends optional p_tos_reviewed_at + p_privacy_reviewed_at at tail. Section 4a + 4b INSERTs now write reviewed_at column (T1 gate-unlock stamp). SaaS + attestation branches unchanged. Dropped 13-arg overload preemptively.',
    'rationale', 'Acceptance-surface pass · A1 weekend critical path. A1 redeems this weekend; their acceptance at redeem carries the T1→T2 evidence gap on ToS + Privacy matching the SaaS pattern.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function at 15-arg only (no zombie 13-arg overload)
--   SELECT proname, prosecdef,
--          pg_get_function_arguments(oid) AS args,
--          count(*) OVER () AS overload_count
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'redeem_proposal_code';
--   -- Expected: 1 row; args tail should include
--   --   'p_tos_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
--   --    p_privacy_reviewed_at timestamp with time zone DEFAULT NULL::timestamp with time zone'
--   -- Expected: overload_count = 1.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'redeem_proposal_code';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.C — Body includes reviewed_at on tos + privacy INSERTs
--   SELECT pg_get_functiondef(oid) AS body
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'redeem_proposal_code';
--   -- Grep expected in returned body:
--   --   'p_tos_reviewed_at'      (arg + INSERT for tos branch)
--   --   'p_privacy_reviewed_at'  (arg + INSERT for privacy branch)
--
-- VQ.D — Migration audit row
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_acceptance_reviewed_at_redeem_extension'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════
