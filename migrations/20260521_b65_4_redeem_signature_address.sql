-- ════════════════════════════════════════════════════════════════════
-- B65.4 — redeem_proposal_code signature change: add p_address
-- Drafted: May 21, 2026 — NOT YET APPLIED.
--
-- Single change: the activation RPC now accepts an optional billing
-- address (path A from B65.4 pre-flight — reuse the existing single
-- `companies.address TEXT` column rather than adding structured
-- billing_street/city/state/zip columns). Form-side enforces required;
-- RPC-side keeps DEFAULT NULL so a missing field doesn't break
-- atomicity (defense-in-depth) and so future callers can omit address
-- without re-signaturing.
--
-- ── WHY DROP + CREATE INSTEAD OF CREATE OR REPLACE ─────────────────
-- Postgres treats overloaded function signatures as distinct functions.
-- CREATE OR REPLACE with a different arg list creates a SECOND
-- redeem_proposal_code rather than replacing the B65.1 one. We DROP
-- the B65.1 signature explicitly, CREATE the new one, then re-GRANT.
-- The footer overload-check query (per Jose's Q2 addition) confirms
-- only one signature remains after apply.
--
-- The function body is byte-identical to B65.1 except for:
--   • new p_address parameter declared at the bottom of the arg list
--     (with the other optional DEFAULT-NULL params)
--   • companies INSERT now sets address = p_address (line marked B65.4)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
);

CREATE FUNCTION redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
  p_address                TEXT DEFAULT NULL,   -- B65.4: new
  p_ip_address             INET DEFAULT NULL,
  p_user_agent             TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    address,                              -- B65.4: billing address from form
    is_active
  ) VALUES (
    p_company_name,
    v_code.base_tier,
    v_code.base_tier_type,
    p_primary_contact_name,
    p_primary_contact_phone,
    p_address,
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

  -- ── 4. Record legal acceptance ───────────────────────────────────
  INSERT INTO tos_acceptances (
    user_id, company_id, tos_version, privacy_version,
    ip_address, user_agent
  ) VALUES (
    v_caller_uid, v_company_id, p_tos_version, p_privacy_version,
    p_ip_address, p_user_agent
  );

  -- ── 5. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) TO authenticated;
-- Deliberately NOT granted to anon (matches B65.1).

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
--
-- ── A. Overload-collision check (per Jose's Q2 addition) ───────────
-- Should return EXACTLY ONE row. Two rows = DROP didn't take and we
-- have two overloaded redeem_proposal_code functions; rollback and
-- investigate.
--   SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc
--   WHERE proname = 'redeem_proposal_code';
--   -- Expected: 1 row, args include `p_address text DEFAULT NULL`
--   --   between p_privacy_version and p_ip_address.
--
-- ── B. Column-reference sanity (Finding 9 first-contact check) ─────
-- Before any real redemption attempt, confirm every column the
-- function body references exists on the live schema. Throws "column
-- does not exist" immediately if anything's off; runs zero writes.
--   SELECT
--     'companies.name' AS col, name FROM companies LIMIT 0;
--   SELECT
--     'companies.tier' AS col, tier FROM companies LIMIT 0;
--   SELECT
--     'companies.tier_type' AS col, tier_type FROM companies LIMIT 0;
--   SELECT
--     'companies.primary_contact_name' AS col, primary_contact_name FROM companies LIMIT 0;
--   SELECT
--     'companies.phone' AS col, phone FROM companies LIMIT 0;
--   SELECT
--     'companies.address' AS col, address FROM companies LIMIT 0;
--   SELECT
--     'companies.is_active' AS col, is_active FROM companies LIMIT 0;
--   SELECT
--     'companies.account_state' AS col, account_state FROM companies LIMIT 0;
--   SELECT
--     'proposal_codes.code' AS col, code FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.status' AS col, status FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.expires_at' AS col, expires_at FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.base_tier' AS col, base_tier FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.base_tier_type' AS col, base_tier_type FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.company_id' AS col, company_id FROM proposal_codes LIMIT 0;
--   SELECT
--     'proposal_codes.redeemed_at' AS col, redeemed_at FROM proposal_codes LIMIT 0;
--   SELECT
--     'user_roles.email' AS col, email FROM user_roles LIMIT 0;
--   SELECT
--     'user_roles.role' AS col, role FROM user_roles LIMIT 0;
--   SELECT
--     'user_roles.company' AS col, company FROM user_roles LIMIT 0;
--   SELECT
--     'user_roles.property' AS col, property FROM user_roles LIMIT 0;
--   SELECT
--     'tos_acceptances.user_id' AS col, user_id FROM tos_acceptances LIMIT 0;
--   SELECT
--     'tos_acceptances.company_id' AS col, company_id FROM tos_acceptances LIMIT 0;
--   SELECT
--     'tos_acceptances.tos_version' AS col, tos_version FROM tos_acceptances LIMIT 0;
--   SELECT
--     'tos_acceptances.privacy_version' AS col, privacy_version FROM tos_acceptances LIMIT 0;
--   -- Expected: all 22 statements return 0 rows successfully. Any
--   -- "column does not exist" error = abort B65.4 testing and investigate.
--
-- ── C. End-to-end redemption smoke (destructive — dev/staging only) ─
-- (Same caveat as B65.1's verification G. Pick a test code with
--  status='issued' and base_tier set.)
--   SELECT redeem_proposal_code(
--     'TEST-CODE-HERE',
--     auth.uid(),
--     'Test Company Inc',
--     'Test Contact',
--     '555-1234',
--     '2026-05-21-draft-1',
--     '2026-05-21-draft-1',
--     '123 Test St, Houston, TX 77001',
--     NULL,
--     'test-user-agent'
--   );
--   -- Expected: returns a BIGINT company_id. Verify post-call:
--   --   • new companies row with account_state='active', address set,
--   --     primary_contact_name set, tier from code
--   --   • new user_roles row (role='company_admin', empty property[])
--   --   • proposal_codes row flipped to status='redeemed' + company_id
--   --   • tos_acceptances row with both versions pinned + user_agent
--   -- Re-run with the same code → 'code not redeemable (status=redeemed)'.
-- ════════════════════════════════════════════════════════════════════
