-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 Commit 2 — redeem two-click normalization + Surprise-A
--                          user_roles version-stamping fold
-- 2026-07-07
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Rewrites redeem_proposal_code() (previously CREATE'd in
--   20260630_redeem_texas_attestation.sql) so that:
--   • The single combined 'tos_and_privacy' row is REPLACED with two
--     sibling rows — document_type='tos' + document_type='privacy' —
--     matching the two-row shape the self-serve /signup +
--     first-login modal paths already use.
--   • user_roles.tos_accepted_at + tos_accepted_version +
--     privacy_accepted_version are STAMPED at redeem time (Surprise-A
--     fix — the previous version stamped nothing on user_roles, so
--     redeemed users hit the first-login ToS/Privacy modal on their
--     first post-redeem visit despite having just signed at redeem).
--
-- SIGNATURE — unchanged (still the 11-arg shape from 20260630):
--   redeem_proposal_code(
--     p_code, p_user_id, p_company_name, p_primary_contact_name,
--     p_primary_contact_phone, p_tos_version, p_privacy_version,
--     p_address, p_ip_address, p_user_agent, p_attestation_version
--   )
--
--   SaaS parameters are NOT added here. Commit 3 will extend with
--   p_saas_version + p_saas_reviewed_at (12th + 13th args), which is
--   a signature change requiring the DROP+CREATE rhythm the 20260630
--   migration used. Commit 2 stays a pure CREATE OR REPLACE — ACL
--   preserved, no re-GRANT needed.
--
-- WHY TWO ROWS (Ask 1.2 of B118 Layer 2)
--   • Parity with /signup + /login: both already write separate
--     document_type='tos' and 'privacy' rows via accept_signup_consents
--     / accept_tos.
--   • The version-aware first-login predicate reads
--     user_roles.tos_accepted_version + privacy_accepted_version and
--     re-fires on either version bump — a combined row can't be
--     re-consented per-document.
--   • Historical 'tos_and_privacy' rows stay valid consent (whitelist
--     retains the value indefinitely per Surprise-C lock in
--     20260707_b118_layer2_saas_schema.sql PART 4); no backfill.
--
-- WHY STAMP user_roles VERSION COLUMNS (Surprise A)
--   Login modal predicate at app/login/page.tsx:301-303:
--     !roleData.tos_accepted_at
--       || roleData.tos_accepted_version !== TOS_VERSION
--       || roleData.privacy_accepted_version !== PRIVACY_VERSION
--   Pre-fix: all three NULL on user_roles for redeemed users → modal
--   fires on their first post-redeem visit even though they signed
--   at redeem. Fix: stamp all three inside the redeem transaction.
--
-- SERVER-SIDE VERSION PINNING (Jose lock 2026-07-07)
--   p_tos_version + p_privacy_version are still passed by the caller
--   (app/signup/redeem/verify/page.tsx activate()), but they come from
--   the build-bundled static import of TOS_VERSION + PRIVACY_VERSION
--   in app/lib/legal-versions.ts — not from user_metadata or any
--   client-owned mutable field. This matches accept_signup_consents +
--   accept_tos discipline. See [[feedback_legal_version_pinning]].
--
-- IP + USER-AGENT ON BOTH NEW ROWS (Jose lock 2026-07-07)
--   Both new INSERTs carry the same p_ip_address + p_user_agent as
--   the (now-removed) combined row and the Texas-attestation sibling.
--   Evidence record stays consistent across surfaces.
--
-- CHECK-CONSTRAINT COMPATIBILITY
--   • 'tos' + 'privacy' were added to the whitelist in
--     20260605_b118_constraint_extension.sql PART 1.
--   • tos_acceptances_version_match (also extended in that migration,
--     then tightened in 20260707_b118_layer2_saas_schema.sql PART 5)
--     requires exactly one version column populated per document_type:
--       - 'tos' → tos_version populated; privacy/attestation/saas NULL.
--       - 'privacy' → privacy_version populated; tos/attestation/saas NULL.
--
-- CREATE OR REPLACE + defensive 10-arg DROP
--   Signature of the target (11-arg) is identical to 20260630, so
--   CREATE OR REPLACE preserves the 11-arg's ACL (authenticated=EXECUTE
--   only, per [[feedback_function_public_grant_supabase_default]] +
--   [[feedback_revoke_from_anon_explicitly]]).
--
--   HOWEVER — Commit 2's VQ.A caught overload_count = 2 in prod: the
--   20260630 migration was supposed to have DROPped the 10-arg
--   (pre-attestation) overload before CREATE'ing the 11-arg, but that
--   DROP appears to have partial-applied (likely per
--   [[feedback_sql_editor_partial_apply]] — SQL Editor split across
--   statements). Result: BOTH signatures were live in prod, VQ.B
--   showed a doubled grant list, and PostgreSQL's function-resolution
--   rules would pick the 10-arg for any legacy call shape.
--
--   Grep confirms zero code callers of the 10-arg: only
--   app/signup/redeem/verify/page.tsx:297 invokes redeem_proposal_code,
--   and it sends p_attestation_version → 11-arg. Safe to drop.
--
--   This migration therefore DROPs the 10-arg overload before the
--   CREATE OR REPLACE of the 11-arg. Post-apply: exactly one overload
--   (VQ.A overload_count = 1), single canonical grant list
--   ({ authenticated=EXECUTE, postgres=EXECUTE } — see VQ.B).
--
-- ROLLBACK
--   Revert to 20260630's function body via psql \i on that file. The
--   two schema features (5-value whitelist, 5-branch version_match)
--   both accept the pre-fix 'tos_and_privacy' shape, so an emergency
--   rollback of this migration does not require a schema rollback.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the stale 10-arg overload (20260521/20260604 shape, pre-attestation).
-- 20260630 intended to drop this + create the 11-arg; the DROP appears to
-- have partial-applied in SQL Editor, leaving overload_count = 2 in prod.
-- IF EXISTS so this migration is safe to re-run and safe on environments
-- where 20260630 dropped cleanly.
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
  p_attestation_version    TEXT DEFAULT NULL
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

  -- ── 4a. Record ToS acceptance — separate row ─────────────────────
  -- B118 Layer 2 Commit 2: split the previous combined
  -- document_type='tos_and_privacy' row into two per-document rows so
  -- the version-aware first-login predicate + re-consent surfaces can
  -- reason per-document. ip_address + user_agent carried onto both
  -- rows for evidence-record consistency across surfaces.
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

  -- ── 4b. Record Privacy acceptance — separate row ─────────────────
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

  -- ── 4c. Record Texas attestation if version supplied ─────────────
  -- Unchanged from 20260630. Sibling row; version_match CHECK
  -- requires attestation_version populated + other version cols NULL.
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

  -- ── 5. Stamp user_roles version columns (Surprise-A fix) ─────────
  -- Prior version stamped NONE of these on the newly-inserted
  -- user_roles row (see Section 2 above — INSERT lands with all three
  -- NULL). Login modal predicate at app/login/page.tsx:301-303:
  --   !roleData.tos_accepted_at
  --     || roleData.tos_accepted_version !== TOS_VERSION
  --     || roleData.privacy_accepted_version !== PRIVACY_VERSION
  -- Without this stamp, A1 (redeemed) hits the first-login ToS/Privacy
  -- modal on their next visit despite consenting at redeem. Direct
  -- assignment (not COALESCE) — Section 2 just inserted the row, so
  -- the columns are guaranteed NULL, and both p_tos_version +
  -- p_privacy_version are required (see the sanity check above), so
  -- there's no defensive-fallback concern.
  UPDATE user_roles
  SET tos_accepted_at       = now(),
      tos_accepted_version  = p_tos_version,
      privacy_accepted_version = p_privacy_version
  WHERE lower(email) = lower(v_caller_email);

  -- ── 6. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$func$;

-- Defensive re-emit of the grant discipline. CREATE OR REPLACE with an
-- identical signature preserves the ACL from 20260630, so these are
-- no-ops if the environment is at expected state. Emitted anyway per
-- [[feedback_function_public_grant_supabase_default]] +
-- [[feedback_revoke_from_anon_explicitly]] — if the ACL ever drifted
-- (e.g., an out-of-band Supabase catalog rebuild), this brings it back.
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
  'SCHEMA_REDEEM_TWO_CLICK_AND_STAMP',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260707_b118_layer2_redeem_two_click_and_stamp',
    'change',    'redeem_proposal_code — Section 4 split from single tos_and_privacy INSERT into two sibling rows (tos + privacy); Section 5 stamps user_roles.tos_accepted_at + tos_accepted_version + privacy_accepted_version; drops stale 10-arg pre-attestation overload that survived 20260630 partial-apply',
    'rationale', 'Parity with self-serve /signup + first-login modal (two-row shape); Surprise-A fix suppresses spurious first-login modal for redeemed users (A1 near-term); overload cleanup collapses grant list to canonical single-signature ACL; prep for B118 Layer 2 Commit 3 SaaS scroll-to-sign gate'
  ),
  now()
);

COMMIT;
