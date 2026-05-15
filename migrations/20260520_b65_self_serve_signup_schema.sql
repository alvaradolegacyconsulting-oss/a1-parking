-- ════════════════════════════════════════════════════════════════════
-- B65.1 — Self-serve onboarding v1: schema + RPCs + RLS
-- Drafted: May 20, 2026 — NOT YET APPLIED.
--
-- First of four B65 commits. UI lands in B65.2–B65.4. This migration
-- adds the minimum DB state needed for self-serve proposal-code
-- redemption:
--   1. companies.account_state column (+ backfill existing → 'active')
--   2. tos_acceptances table (legal acceptance log, immutable)
--   3. validate_proposal_code() — pre-signup, minimum-leak summary
--   4. redeem_proposal_code() — atomic activation transaction
--   5. RLS on tos_acceptances (self-select + admin-all; INSERT via RPC only)
--
-- ── DESIGN DECISIONS BAKED IN ───────────────────────────────────────
-- • Zero new columns on proposal_codes. Existing schema (from the May 8
--   + May 10 migrations) already has redeemed_at, expires_at, and the
--   company_id BIGINT FK. The pre-flight (PF#6) confirmed all spec-
--   proposed additions were already present.
-- • Feature overrides STAY on proposal_codes — they are NOT copied to
--   the company at redemption. hasFeature() reads them at runtime via
--   proposal_codes_summary view. The "atomic activation" is therefore
--   simpler than originally spec'd: link company_id + flip status +
--   user_roles INSERT + tos_acceptances INSERT + account_state flip.
-- • BIGINT for company_id / proposal_codes.id (matches existing
--   schema). UUID only for user_id (FK to auth.users.id, Supabase
--   default). Spec wrote UUID throughout — corrected per pre-flight.
-- • redeem_proposal_code is SECURITY DEFINER so the mid-signup user
--   (no user_roles row yet, no company yet) can complete the
--   transaction. Caller's auth.uid() is validated at function top.
-- • validate_proposal_code is SECURITY DEFINER + GRANTed to anon so
--   the redemption URL is shareable pre-signup without leaking deal
--   terms. Return shape is intentionally minimum-leak: tier_type, tier,
--   client_name, expires_at. No feature_overrides, no pricing numbers,
--   no PDF URL.
-- • Codes intended for self-serve MUST have base_tier and
--   base_tier_type set. RPC raises if either is null. This forces
--   admin to set both when issuing a code for self-serve redemption.
--   Codes intended for the legacy admin "Apply to Company" flow are
--   unaffected — that flow doesn't call this RPC.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — companies.account_state + primary_contact_name + backfill
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS account_state TEXT NOT NULL DEFAULT 'configuring';

-- Identity of the human who signed up via self-serve (or whoever the
-- admin recorded as primary contact at company creation). Nullable —
-- existing companies were created without this captured.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS primary_contact_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_account_state_valid'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_account_state_valid
      CHECK (account_state IN ('configuring','active','suspended','cancelled'));
  END IF;
END $$;

-- Backfill: every existing company is manually provisioned and currently
-- operating. Flip them to 'active' so existing customers see zero change
-- when B65.2 deploys the account_state gate at CA portal entry. New rows
-- (post-deploy) default to 'configuring' and are flipped to 'active' by
-- the redeem_proposal_code RPC at the end of activation.
UPDATE companies SET account_state = 'active' WHERE account_state = 'configuring';

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — tos_acceptances table (legal acceptance log)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tos_acceptances (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- company_id NULL during signup before company exists; backfilled by
  -- redeem_proposal_code in the same transaction that creates the company.
  -- ON DELETE SET NULL so company deletion doesn't cascade-destroy
  -- legal acceptance records (those outlive the company).
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  tos_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address INET,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_tos_acceptances_user_id ON tos_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_tos_acceptances_company_id ON tos_acceptances(company_id);

ALTER TABLE tos_acceptances ENABLE ROW LEVEL SECURITY;

-- Self-SELECT: a user reads their own acceptance history.
DROP POLICY IF EXISTS "tos_acceptances_self_select" ON tos_acceptances;
CREATE POLICY "tos_acceptances_self_select" ON tos_acceptances
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Admin-all: super admin reads + audits all acceptances.
DROP POLICY IF EXISTS "tos_acceptances_admin_all" ON tos_acceptances;
CREATE POLICY "tos_acceptances_admin_all" ON tos_acceptances
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Deliberate absence: no client-side INSERT/UPDATE/DELETE policies.
-- Writes happen only through redeem_proposal_code() SECURITY DEFINER.
-- Acceptance records are immutable; no path to UPDATE or DELETE for
-- non-admin callers.

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — validate_proposal_code(): pre-signup summary
-- ════════════════════════════════════════════════════════════════════
-- Callable pre-auth so the /signup/redeem?code=XXX page can render
-- tier info before asking the user to sign up. Returns intentionally
-- minimum-leak JSON: tier identity, client name (for "welcome, A1
-- Wrecker LLC" framing), expiration. NEVER returns feature_overrides,
-- custom pricing numbers, or pdf_url.

CREATE OR REPLACE FUNCTION validate_proposal_code(p_code TEXT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row proposal_codes%ROWTYPE;
BEGIN
  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'missing_code');
  END IF;

  SELECT * INTO v_row FROM proposal_codes WHERE code = trim(p_code) LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_found');
  END IF;

  IF v_row.status = 'revoked' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'revoked');
  END IF;

  IF v_row.status = 'redeemed' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'redeemed');
  END IF;

  IF v_row.status = 'expired' OR (v_row.expires_at IS NOT NULL AND v_row.expires_at <= now()) THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'expired');
  END IF;

  IF v_row.status <> 'issued' THEN
    -- Catches 'draft' or any future status — never let drafts redeem.
    RETURN jsonb_build_object('valid', false, 'reason', 'not_issued');
  END IF;

  IF v_row.base_tier IS NULL OR v_row.base_tier_type IS NULL THEN
    -- Code has no anchored tier — not self-serve-ready.
    RETURN jsonb_build_object('valid', false, 'reason', 'tier_not_set');
  END IF;

  -- Valid. Return minimum-leak summary.
  RETURN jsonb_build_object(
    'valid', true,
    'tier_type', v_row.base_tier_type,
    'tier', v_row.base_tier,
    'has_custom_pricing', (
      v_row.custom_base_fee IS NOT NULL OR
      v_row.custom_per_property_fee IS NOT NULL OR
      v_row.custom_per_driver_fee IS NOT NULL
    ),
    'client_name', v_row.client_name,
    'expires_at', v_row.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_proposal_code(TEXT) TO anon, authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — redeem_proposal_code(): atomic activation
-- ════════════════════════════════════════════════════════════════════
-- All-or-nothing. Caller must be authenticated and p_user_id must
-- match auth.uid(). Row-locks the proposal code so two concurrent
-- redemption attempts can't both succeed.

CREATE OR REPLACE FUNCTION redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
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

  -- Resolve caller's email for the user_roles INSERT.
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

  -- Company-name uniqueness check (separate from the FK uniqueness
  -- below — fail early with a clean error rather than a duplicate-key
  -- exception leaking schema details).
  IF EXISTS (SELECT 1 FROM companies WHERE name ILIKE p_company_name) THEN
    RAISE EXCEPTION 'company name already in use' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Create company in configuring state ───────────────────────
  -- account_state defaults to 'configuring' (set in PART 1 above);
  -- flipped to 'active' as the last step below. `phone` is the
  -- existing company-line column on companies — at self-serve signup
  -- the primary contact's phone IS the company line; admin can split
  -- these later if needed. `primary_contact_name` is the new column
  -- added in PART 1; identifies the human (auth.users.id is also
  -- captured on tos_acceptances + user_roles for cross-reference).
  INSERT INTO companies (
    name, tier, tier_type,
    primary_contact_name, phone,
    is_active
  ) VALUES (
    p_company_name,
    v_code.base_tier,
    v_code.base_tier_type,
    p_primary_contact_name,
    p_primary_contact_phone,
    TRUE
  )
  RETURNING id INTO v_company_id;

  -- ── 2. Insert user_roles row (company_admin, no property scope) ──
  -- Direct INSERT rather than calling insert_user_role() RPC because
  -- this function is already SECURITY DEFINER and bypasses RLS; the
  -- indirection would add no value.
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

GRANT EXECUTE ON FUNCTION redeem_proposal_code(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT) TO authenticated;
-- Deliberately NOT granted to anon. Caller must be authenticated
-- (i.e., have completed supabase.auth.signUp() + email verification)
-- before this function is callable.

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. companies.account_state + primary_contact_name shapes ──────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name IN ('account_state','primary_contact_name')
--   ORDER BY column_name;
--   -- Expected:
--   --   account_state         text  'configuring'::text  NO
--   --   primary_contact_name  text  (null)               YES
--
-- ── B. Backfill correctness ────────────────────────────────────────
--   SELECT account_state, COUNT(*) FROM companies GROUP BY account_state;
--   -- Expected: every existing row is 'active'; zero 'configuring'.
--
-- ── C. CHECK constraint present ────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'companies_account_state_valid';
--   -- Expected: CHECK with 4 values.
--
-- ── D. tos_acceptances table + indexes + RLS ───────────────────────
--   \d+ tos_acceptances
--   SELECT polname, polcmd FROM pg_policy
--   WHERE polrelid = 'tos_acceptances'::regclass ORDER BY polname;
--   -- Expected 2 rows:
--   --   tos_acceptances_admin_all      *
--   --   tos_acceptances_self_select    r
--
-- ── E. Functions exist + are SECURITY DEFINER ──────────────────────
--   SELECT proname, prosecdef, provolatile
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('validate_proposal_code','redeem_proposal_code')
--   ORDER BY proname;
--   -- Expected:
--   --   redeem_proposal_code      t  v  (volatile — has side effects)
--   --   validate_proposal_code    t  s  (stable — read-only)
--
-- ── F. validate_proposal_code smoke test ───────────────────────────
-- (Pick an unredeemed test code from /admin/proposal-codes that has
--  base_tier + base_tier_type set. TESTPROP-YT0H if it still exists.)
--   SELECT validate_proposal_code('TESTPROP-YT0H');
--   -- Expected: { valid: true, tier_type, tier, has_custom_pricing,
--   --   client_name, expires_at }
--
-- ── G. Atomicity smoke test for redeem_proposal_code ──────────────
-- This is destructive — only run in dev or with a test code you can
-- afford to redeem.
--   -- 1. Pick a test code with status='issued' and base_tier set
--   -- 2. As an authenticated test user (via app or session JWT):
--   --    SELECT redeem_proposal_code(
--   --      'TEST-CODE',
--   --      auth.uid(),
--   --      'Test Company Inc',
--   --      'Test Contact',
--   --      '555-1234',
--   --      '1.0-draft-2026-05-19',
--   --      '1.0-draft-2026-05-19',
--   --      NULL,
--   --      'test-user-agent'
--   --    );
--   -- 3. Verify the returned company_id has account_state='active',
--   --    a matching user_roles row, a tos_acceptances row, and the
--   --    proposal_code now has status='redeemed' + company_id set.
--   -- 4. Retry the same call — should raise 'code not redeemable
--   --    (status=redeemed)' and leave state unchanged.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- Migration is DDL + idempotent UPDATE (backfill) + idempotent function
-- creates (CREATE OR REPLACE). BEGIN/COMMIT atomic. Any failure rolls
-- back the entire transaction. ADD COLUMN IF NOT EXISTS + DROP POLICY
-- IF EXISTS + CREATE TABLE IF NOT EXISTS make re-apply safe.
--
-- The redeem_proposal_code function itself uses FOR UPDATE on the
-- proposal_codes row to serialize concurrent redemptions. Two users
-- racing to redeem the same code: one wins, the other gets a clean
-- "code not redeemable (status=redeemed)" exception after the lock
-- releases.
-- ════════════════════════════════════════════════════════════════════
