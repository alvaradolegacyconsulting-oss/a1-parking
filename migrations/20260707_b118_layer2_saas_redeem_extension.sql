-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 Commit 3 — redeem_proposal_code SaaS param extension
-- 2026-07-07
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Extends redeem_proposal_code() from 11 args (Commit 2 shape) to
--   13 args by appending optional p_saas_version + p_saas_reviewed_at
--   at the tail. When both are non-null, INSERTs a 4th sibling
--   tos_acceptances row (document_type='saas') and stamps
--   user_roles.saas_accepted_version (Commit 1 column) — atomic with
--   the rest of the redeem transaction.
--
-- SIGNATURE (13-arg — appended params at tail):
--   p_code, p_user_id, p_company_name, p_primary_contact_name,
--   p_primary_contact_phone, p_tos_version, p_privacy_version,
--   p_address, p_ip_address, p_user_agent, p_attestation_version,
--   p_saas_version, p_saas_reviewed_at
--
--   Both new params DEFAULT NULL — if a mid-deploy or legacy caller
--   sends only 11 args, the function still accepts them. The SaaS
--   INSERT branch guards on both being non-null before firing.
--
-- OVERLOAD DISCIPLINE (Commit 2 lesson applied preemptively)
--   Changing the signature creates a NEW overload. Explicitly
--   DROP FUNCTION the current 11-arg signature IN THIS MIGRATION so
--   post-apply VQ.A reports overload_count = 1 and VQ.B's grants
--   collapse to a clean single-signature ACL. Commit 2's zombie 10-arg
--   was the direct precedent — pay the same DROP tax up-front.
--
-- DROP-BEFORE-CREATE (the 11-arg is dropped, then the new 13-arg is
-- CREATE OR REPLACE'd). DROP wipes ACL → re-emit REVOKE PUBLIC + anon
-- + service_role + GRANT authenticated per grant discipline.
--
-- SAAS ROW INSERT (Section 4d)
--   Only fires when BOTH p_saas_version AND p_saas_reviewed_at are
--   non-null. Matches the tos_acceptances_version_match CHECK's saas
--   branch (Commit 1 PART 5): document_type='saas' requires
--   saas_version populated + the 3 other version cols NULL. reviewed_at
--   is client-stamped at the moment the readthrough gate unlocks
--   (before sign click — see [[project_b118_layer2_saas_agreement_scroll_gate]]).
--   ip_address + user_agent carried for evidence-record parity with
--   the tos/privacy/texas siblings.
--
-- USER_ROLES STAMP (Section 5)
--   Extends the Commit 2 UPDATE by one column. tos + privacy use
--   direct assignment (Section 2 just inserted the row → guaranteed
--   NULL; both version params required by the sanity check). SaaS
--   uses COALESCE — the p_saas_version param is OPTIONAL this deploy
--   (defensive if a caller sends only 11 args), and this column may
--   already carry a value from a prior SaaS-only acceptance flow in
--   the future (though not today).
--
-- RE-ACCEPTANCE POSTURE (Jose lock 2026-07-07)
--   The login-modal predicate at app/login/page.tsx:301-303 reads
--   only tos_accepted_at + tos_accepted_version + privacy_accepted_version.
--   saas_accepted_version is stored here for the record — NOT wired
--   into the modal. SaaS re-sign on version bump is deliberate + track-
--   sensitive UX (self-serve clickwrap = fine to auto-re-present;
--   Legacy/negotiated = never auto-lock). Fast-follow, out of scope
--   for Commit 3.
--
-- BACKWARD-COMPAT
--   Historical rows unchanged. All existing document_types
--   ('tos_and_privacy', 'texas_attestation', 'tos', 'privacy') still
--   valid. Only new redeems that supply both SaaS params write a
--   'saas' sibling row.
--
-- ROLLBACK
--   Re-apply migrations/20260707_b118_layer2_redeem_two_click_and_stamp.sql
--   → restores the 11-arg body. The tos_acceptances CHECK constraints
--   from Commit 1 accept both shapes (5-value whitelist, 5-branch
--   version_match), so rollback is schema-safe. Any existing 'saas'
--   rows in tos_acceptances remain valid; app-layer just won't fire
--   the acceptance path.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the 11-arg overload (Commit 2 shape) so the new 13-arg replaces
-- cleanly with overload_count = 1 post-apply. IF EXISTS so this
-- migration is safe to re-run.
DROP FUNCTION IF EXISTS public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT
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
  p_attestation_version    TEXT DEFAULT NULL,
  p_saas_version           TEXT DEFAULT NULL,        -- NEW (12th)
  p_saas_reviewed_at       TIMESTAMPTZ DEFAULT NULL  -- NEW (13th)
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

  -- ── 4a. Record ToS acceptance — separate row (Commit 2) ──────────
  INSERT INTO tos_acceptances (
    user_id, company_id,
    document_type,
    tos_version,
    ip_address, user_agent
  ) VALUES (
    v_caller_uid, v_company_id,
    'tos',
    p_tos_version,
    p_ip_address, p_user_agent
  );

  -- ── 4b. Record Privacy acceptance — separate row (Commit 2) ──────
  INSERT INTO tos_acceptances (
    user_id, company_id,
    document_type,
    privacy_version,
    ip_address, user_agent
  ) VALUES (
    v_caller_uid, v_company_id,
    'privacy',
    p_privacy_version,
    p_ip_address, p_user_agent
  );

  -- ── 4c. Record Texas attestation if version supplied (unchanged) ─
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

  -- ── 4d. Record SaaS acceptance if both params supplied (NEW) ─────
  -- Only fires when BOTH p_saas_version AND p_saas_reviewed_at are
  -- non-null. reviewed_at is client-stamped at the moment the
  -- readthrough gate unlocks (T1); the tos_acceptances row's own
  -- accepted_at column captures the sign-click moment (T2). T1 < T2
  -- is the review-to-sign evidence gap. Version_match CHECK from
  -- Commit 1 PART 5 enforces the shape: document_type='saas' requires
  -- saas_version populated + tos/privacy/attestation NULL.
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

  -- ── 5. Stamp user_roles version columns (Commit 2 + saas col) ────
  -- tos + privacy: direct assignment (Section 2 just inserted the row,
  -- guaranteed NULL; both version params required by sanity check).
  -- saas: COALESCE — p_saas_version is optional this deploy so
  -- defensive fallback preserves any pre-existing value.
  UPDATE user_roles
  SET tos_accepted_at         = now(),
      tos_accepted_version    = p_tos_version,
      privacy_accepted_version = p_privacy_version,
      saas_accepted_version   = COALESCE(p_saas_version, saas_accepted_version)
  WHERE lower(email) = lower(v_caller_email);

  -- ── 6. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$func$;

-- DROP wiped the ACL of the 11-arg overload. The new 13-arg needs its
-- own grants set explicitly per grant discipline. Same shape as prior
-- versions: REVOKE PUBLIC + anon + service_role, GRANT authenticated
-- only. Same [[feedback_function_public_grant_supabase_default]] +
-- [[feedback_revoke_from_anon_explicitly]] rules.
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM anon;
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ
) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT, TEXT, TIMESTAMPTZ
) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_REDEEM_SAAS_EXTENSION',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260707_b118_layer2_saas_redeem_extension',
    'change',    'redeem_proposal_code extended from 11-arg to 13-arg — appends optional p_saas_version + p_saas_reviewed_at; Section 4d inserts saas sibling row when both non-null; Section 5 stamps user_roles.saas_accepted_version via COALESCE; drops 11-arg overload preemptively to avoid overload_count drift',
    'rationale', 'B118 Layer 2 Commit 3 — SaaS scroll-to-sign gate wires acceptance capture into the redeem path; UI landing in the same commit. Consumes Commit 1 schema (saas_version, reviewed_at, saas_accepted_version). Placeholder SAAS_VERSION until attorney finals; version bump then re-fires the gate for future redeems.'
  ),
  now()
);

COMMIT;
