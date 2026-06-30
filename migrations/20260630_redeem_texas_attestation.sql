-- ════════════════════════════════════════════════════════════════════
-- redeem_proposal_code — Texas attestation row alongside the existing
--                        tos_and_privacy capture (B118-class extension)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Extends redeem_proposal_code() to optionally record a
--   document_type='texas_attestation' row in tos_acceptances. Adds a
--   single optional param p_attestation_version (DEFAULT NULL) at the
--   end of the signature; when set, a sibling INSERT lands the Texas
--   attestation row in the same transaction as the existing
--   tos_and_privacy row.
--
-- WHY
--   /signup captures Texas attestation (via accept_signup_consents
--   from /api/signup/attest). The proposal-code redeem path
--   (/signup/redeem/verify → redeem_proposal_code) captures ToS +
--   Privacy but NOT Texas. A1 onboards via redeem, so the redeem
--   path needs the same attestation discipline. Add it now —
--   independent of the still-pending final SaaS Agreement text per
--   Jose's spec.
--
-- SIGNATURE
--   New optional 11th arg at the tail:
--     p_attestation_version TEXT DEFAULT NULL
--   When NULL → no Texas row inserted (backward compatible). When set
--   → inserts a document_type='texas_attestation' row alongside the
--   tos_and_privacy row.
--
-- DROP-BEFORE-CREATE
--   Adding a typed param changes the function signature even with
--   DEFAULT. CREATE OR REPLACE would attempt to replace the existing
--   10-arg function and fail, or create a new overload (the pg_proc=1
--   verification would then RED). DROP first; recreate with full body.
--
-- LOAD-BEARING REVOKE/GRANT
--   DROP wipes the ACL. Supabase defaults grant service_role +
--   PUBLIC to recreated functions. Per the standing discipline
--   ([[feedback-function-public-grant-supabase-default]]), explicit
--   REVOKE PUBLIC + anon + service_role + GRANT authenticated must
--   re-apply post-create.
--
-- VERIFICATION
--   See sibling _verification.sql:
--     §1 single redeem_proposal_code overload, DEFINER, search_path
--     §2 authenticated=X only on the new signature
--     §3 audit row landed
--     §4 app-level smoke prompts (incl. attestation row appears in
--        tos_acceptances after a redeem activate)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the existing 10-arg signature so the new 11-arg replaces cleanly
-- with no overload-trap risk. Both possible historical signatures get
-- dropped IF EXISTS — covers the 20260521 + 20260604 lineage.
DROP FUNCTION IF EXISTS public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
);

CREATE OR REPLACE FUNCTION public.redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
  p_address                TEXT DEFAULT NULL,
  p_ip_address             INET DEFAULT NULL,
  p_user_agent             TEXT DEFAULT NULL,
  p_attestation_version    TEXT DEFAULT NULL  -- NEW: Texas attestation
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

  -- ── 4. Record legal acceptance — tos_and_privacy row ─────────────
  INSERT INTO tos_acceptances (
    user_id, company_id,
    document_type,
    tos_version, privacy_version,
    ip_address, user_agent
  ) VALUES (
    v_caller_uid, v_company_id,
    'tos_and_privacy',
    p_tos_version, p_privacy_version,
    p_ip_address, p_user_agent
  );

  -- ── 4b. Record Texas attestation if version supplied ─────────────
  -- NEW: sibling row with document_type='texas_attestation'. The
  -- bidirectional CHECK from 20260601 enforces the row shape
  -- (texas_attestation requires attestation_version populated +
  -- tos_version/privacy_version NULL). Same transaction as the
  -- tos_and_privacy INSERT — atomic with the rest of the redeem.
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

  -- ── 5. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$func$;

-- Grants (explicit per the standing REVOKE-all-then-GRANT-authenticated
-- discipline). DROP wiped the ACL — these MUST re-apply.
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_REDEEM_TEXAS_ATTESTATION',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260630_redeem_texas_attestation',
    'change',    'redeem_proposal_code adds optional p_attestation_version + sibling INSERT for document_type=texas_attestation row',
    'rationale', 'A1 onboards via redeem path; needs the same Texas attestation discipline as /signup. Independent of pending final SaaS Agreement text.'
  ),
  now()
);

COMMIT;
