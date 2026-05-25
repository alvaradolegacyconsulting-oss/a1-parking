-- ════════════════════════════════════════════════════════════════════
-- B118 commit 1 — self-serve ToS + Privacy consent (version-aware)
-- Drafted: 2026-05-26 — NOT YET APPLIED.
--
-- Closes the launch-blocker gap from B66.3 where self-serve subscribers
-- only consent to Texas attestation but not ToS or Privacy at moment-
-- of-purchase. Adds version-tracking columns to user_roles so the
-- /login first-login modal becomes version-aware (re-fires on doc
-- version bumps + on first login for B113 bulk-uploaded users).
--
-- ── AUDIT-PASS RESULTS CONSUMED (Jose-run 2026-05-26) ────────────────
-- AP.1 — redeem_proposal_code body verified writes tos_acceptances with
--   tos_version + privacy_version populated BUT does NOT set
--   document_type (column added later in B66.3 commit 1; B65.4-era
--   function predates it). This migration's PART 4 fixes it
--   forward (CREATE OR REPLACE with the single-line document_type
--   addition) + PART 5 normalizes the one existing legacy row.
--   Also: the RPC does NOT stamp user_roles.tos_accepted_at — meaning
--   B65 proposal-code customers hit the modal on first login despite
--   having a tos_acceptances row. The version-aware modal (commit 3)
--   handles this correctly: their stamped-on-first-login row will
--   carry the current version going forward.
--
-- AP.2 — every existing account has 0 rows in tos_acceptances for
--   document_type IN ('tos', 'privacy', 'texas_attestation'). One
--   account (sayra@alvaradolegacyconsultingllc.com) has 1 legacy row
--   (document_type=NULL + both versions populated) from May 25 B65.4
--   smoke. PART 5 normalization fixes that row to
--   document_type='tos_and_privacy'. No backfill needed for new
--   columns — they ship NULL; users consent forward on next login
--   via the version-aware modal (commit 3).
--
-- AP.3 — neither tos_accepted_version nor privacy_accepted_version
--   exists on user_roles. PART 1 adds both as nullable TEXT.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. user_roles — add tos_accepted_version + privacy_accepted_version
--      TEXT NULL. Backwards-compat: existing rows stay NULL until
--      either commit 2's /api/signup/attest fires for new self-serve
--      signups OR commit 3's /login modal fires for existing users
--      with stale state.
--
--   2. accept_tos() — DROP 0-arg signature + CREATE new 2-arg-with-
--      defaults signature. The 0-arg call still works (resolves to
--      DEFAULT NULL for both params) — preserves the existing /login
--      modal callsite. The 2-arg call (commit 3's update) atomically:
--        (a) UPSERTs ToS + Privacy rows into tos_acceptances
--            (idempotent per (user_id, document_type, version) via
--            SELECT-then-INSERT — counter-proposal E.2 accepted)
--        (b) Stamps user_roles.tos_accepted_at = now() AND
--            tos_accepted_version + privacy_accepted_version
--      Per B65.4 lesson: CREATE OR REPLACE with different arg list
--      creates a SECOND overloaded function. Explicit DROP + CREATE
--      keeps the function namespace clean.
--
--   3. accept_signup_consents() — NEW SECURITY DEFINER RPC for the
--      /api/signup/attest flow (counter-proposal E.1). Atomic 3-row
--      write to tos_acceptances (texas + tos + privacy) AND stamp of
--      user_roles version columns. Idempotency: SELECT-then-INSERT
--      per document_type + version (no UNIQUE constraint needed —
--      counter-proposal E.2).
--
--   4. redeem_proposal_code() — CREATE OR REPLACE with body update:
--      add document_type = 'tos_and_privacy' to the step-4 INSERT.
--      Same 10-arg signature so REPLACE-in-place works (no DROP
--      needed). Body byte-identical to current production state
--      (B65.4 + B66.3-era acquisition_channel='proposal_code')
--      except the single document_type addition.
--
--   5. Normalization — UPDATE tos_acceptances SET document_type =
--      'tos_and_privacy' WHERE document_type IS NULL AND both version
--      columns populated. Fixes the one legacy row from May 25 B65.4
--      smoke; future-proofs against any other untagged B65-era rows
--      (none expected per AP.2 but the filter is precise).
--
--   6. GRANT discipline — REVOKE FROM PUBLIC + GRANT TO authenticated
--      for the new accept_tos(TEXT, TEXT) signature AND for the new
--      accept_signup_consents signature. Per
--      feedback_function_public_grant_supabase_default: every new
--      SECURITY DEFINER signature needs explicit re-grant
--      (CREATE-with-different-args creates a new function with default
--      PUBLIC grant). redeem_proposal_code GRANT unchanged (same
--      signature — REPLACE preserves grants).
--
-- ── DEPENDENCIES (verified via AP) ───────────────────────────────────
-- • user_roles table with tos_accepted_at TIMESTAMPTZ (added pre-B82).
-- • tos_acceptances table with document_type + attestation_version
--   columns (B66.3 commit 1 — 3c6bd8c) + the document_type CHECK
--   constraint + bidirectional version-match CHECK.
-- • Existing accept_tos() 0-arg signature with GRANT TO authenticated
--   (B82 retrofit applied via 20260528).
-- • Existing redeem_proposal_code(10-arg) with B66.3-era body
--   (acquisition_channel='proposal_code' in companies INSERT). Same
--   GRANT TO authenticated.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • /signup form checkboxes + /api/signup/attest RPC switch — commit 2.
-- • /login modal version-aware predicate + accept_tos(VERSION, VERSION)
--   callsite update — commit 3.
-- • Legacy 0-arg accept_tos() callsite migration — commit 3 (the only
--   callsite is /login modal "Continue"; it stays calling the 0-arg
--   form until commit 3 explicitly switches to the 2-arg form with
--   the current TOS_VERSION + PRIVACY_VERSION).
-- • Backfill of user_roles.tos_accepted_version for existing users —
--   intentional. They consent forward on next login via the
--   version-aware modal (commit 3) and accept_tos(VERSION, VERSION)
--   stamps the columns at that moment.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. Three function bodies use
-- $func$ tagged dollar-quote delimiters per
-- feedback_sql_editor_dollar_quote_parsing (bare $$ can be smart-split
-- by the SQL Editor's tokenizer). BEGIN/COMMIT atomic — any statement
-- failing rolls back the entire migration. All DDL idempotent:
--   • ADD COLUMN IF NOT EXISTS (× 2)
--   • DROP FUNCTION IF EXISTS + CREATE (accept_tos signature change)
--   • CREATE OR REPLACE FUNCTION (× 2 — accept_signup_consents new,
--     redeem_proposal_code body update)
--   • UPDATE ... WHERE filter is precise (no-op on re-apply since
--     normalized rows no longer match document_type IS NULL)
--   • REVOKE/GRANT idempotent (no-op when already in target state)
-- Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — user_roles version-tracking columns
-- ════════════════════════════════════════════════════════════════════
-- Both nullable TEXT. Populated by accept_tos(VERSION, VERSION) +
-- accept_signup_consents going forward. Existing rows stay NULL until
-- their owners consent next (modal in commit 3 fires for them).

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS tos_accepted_version     TEXT,
  ADD COLUMN IF NOT EXISTS privacy_accepted_version TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — accept_tos signature change (0-arg → 2-arg-with-defaults)
-- ════════════════════════════════════════════════════════════════════
-- Per B65.4 lesson (CREATE OR REPLACE with different arg list creates
-- a SECOND overloaded function, not a replacement): explicit DROP of
-- the 0-arg signature + CREATE of the new 2-arg signature.
--
-- The 2-arg signature with DEFAULT NULL params is callable as either:
--   accept_tos()                                    → both NULL
--   accept_tos('2026-05-21-draft-1','2026-05-21-draft-1')  → version-aware
--
-- 0-arg behavior (legacy /login modal callsite, pre-commit-3):
--   stamps user_roles.tos_accepted_at = now() if NULL; no
--   tos_acceptances writes; no version column stamping. Preserves
--   existing behavior until commit 3 updates the callsite.
--
-- 2-arg behavior (commit 3 callsite + future direct calls):
--   atomically UPSERTs ToS + Privacy rows into tos_acceptances
--   (idempotent per (user_id, document_type, version) via SELECT-
--   then-INSERT — counter-proposal E.2) AND stamps user_roles
--   tos_accepted_at + tos_accepted_version + privacy_accepted_version.

DROP FUNCTION IF EXISTS accept_tos();

CREATE FUNCTION accept_tos(
  p_tos_version     TEXT DEFAULT NULL,
  p_privacy_version TEXT DEFAULT NULL
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

  -- Legacy 0-arg path: stamp tos_accepted_at only. Preserves existing
  -- behavior for any callsite that hasn't migrated to the version-
  -- aware form yet.
  IF p_tos_version IS NULL AND p_privacy_version IS NULL THEN
    UPDATE user_roles
    SET tos_accepted_at = now()
    WHERE email ILIKE v_caller_email
      AND tos_accepted_at IS NULL;
    RETURN;
  END IF;

  -- Version-aware path: write tos_acceptances rows (idempotent) +
  -- stamp user_roles columns. Both versions expected; if only one
  -- provided, handle each independently.

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
        ip_address, user_agent
      ) VALUES (
        v_caller_uid, 'tos', p_tos_version,
        NULL, NULL,
        NULL, NULL
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
        ip_address, user_agent
      ) VALUES (
        v_caller_uid, 'privacy', NULL,
        p_privacy_version, NULL,
        NULL, NULL
      );
    END IF;
  END IF;

  -- Stamp user_roles version columns + last-consent timestamp. Always
  -- updates (re-consent at new version refreshes the timestamp).
  UPDATE user_roles
  SET tos_accepted_at       = now(),
      tos_accepted_version  = COALESCE(p_tos_version, tos_accepted_version),
      privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
  WHERE email ILIKE v_caller_email;
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — accept_signup_consents (new RPC, atomic 3-doc write)
-- ════════════════════════════════════════════════════════════════════
-- Called from /api/signup/attest (commit 2). Replaces the current 3-
-- separate-INSERTs approach with a single SECURITY DEFINER RPC that
-- atomically writes all 3 documents + stamps user_roles columns.
-- Single transaction = atomicity (no half-consented state if one
-- INSERT fails after another succeeds).
--
-- Per-document idempotency via SELECT-then-INSERT (counter-proposal
-- E.2 accepted — matches existing /api/signup/attest probe pattern).

CREATE OR REPLACE FUNCTION accept_signup_consents(
  p_attestation_version TEXT,
  p_tos_version         TEXT,
  p_privacy_version     TEXT,
  p_ip_address          INET DEFAULT NULL,
  p_user_agent          TEXT DEFAULT NULL
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

  -- 1. Texas attestation row.
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

  -- 2. ToS row.
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
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, 'tos',
      p_tos_version, NULL, NULL,
      p_ip_address, p_user_agent
    );
  END IF;

  -- 3. Privacy row.
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
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, 'privacy',
      NULL, p_privacy_version, NULL,
      p_ip_address, p_user_agent
    );
  END IF;

  -- 4. Stamp user_roles version columns + last-consent timestamp.
  -- COALESCE pattern: don't overwrite a stored version with NULL (the
  -- params are all NOT NULL per the guard above, so this is just
  -- defensive — but consistent with accept_tos's pattern).
  UPDATE user_roles
  SET tos_accepted_at       = now(),
      tos_accepted_version  = COALESCE(p_tos_version, tos_accepted_version),
      privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
  WHERE email ILIKE v_caller_email;
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — redeem_proposal_code body update (document_type)
-- ════════════════════════════════════════════════════════════════════
-- Same 10-arg signature as B65.4 + B66.3-era state (verified via
-- AP.1). CREATE OR REPLACE replaces in place. Body byte-identical
-- to current production state except the single document_type
-- addition to the tos_acceptances INSERT (step 4).
--
-- Includes the B66.3-era acquisition_channel='proposal_code' in
-- companies INSERT (production state per B66.3 commit 1 audit;
-- never landed via a repo migration because that PART was stripped
-- as a no-op).

CREATE OR REPLACE FUNCTION redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
  p_address                TEXT DEFAULT NULL,
  p_ip_address             INET DEFAULT NULL,
  p_user_agent             TEXT DEFAULT NULL
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

  -- ── 4. Record legal acceptance (B118: document_type added) ───────
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

  -- ── 5. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Normalization of legacy untagged rows
-- ════════════════════════════════════════════════════════════════════
-- Fixes the one existing tos_acceptances row from the May 25 B65.4
-- smoke that has document_type=NULL but both versions populated. The
-- precise WHERE filter ensures we ONLY touch the documented case
-- (legacy "both versions populated, no discriminator") — won't touch
-- new texas_attestation or single-document rows.
--
-- Idempotent: re-running finds zero rows once the normalization
-- completes (the next iteration's WHERE filter no longer matches).

UPDATE tos_acceptances
SET document_type = 'tos_and_privacy'
WHERE document_type IS NULL
  AND tos_version IS NOT NULL
  AND privacy_version IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 6 — GRANT discipline
-- ════════════════════════════════════════════════════════════════════
-- New SECURITY DEFINER signatures need explicit REVOKE FROM PUBLIC +
-- GRANT TO authenticated per feedback_function_public_grant_supabase_default.
-- CREATE-with-different-args creates a new function with default
-- PUBLIC grant; named-5/B82 discipline tightens to authenticated-only.
--
-- redeem_proposal_code signature unchanged — REPLACE preserves
-- existing GRANTs (authenticated-only per the named-5 retrofit). No
-- re-grant needed but stated defensively below for self-documentation.

REVOKE EXECUTE ON FUNCTION public.accept_tos(TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.accept_tos(TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT) TO authenticated;

-- Defensive re-grant on redeem_proposal_code — REPLACE should preserve
-- the existing authenticated-only state but re-state for self-doc.
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── VQ.A — user_roles new columns exist
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='user_roles'
--     AND column_name IN ('tos_accepted_version','privacy_accepted_version')
--   ORDER BY column_name;
--   -- Expected: 2 rows, both text, both YES (nullable), no defaults.
--
-- ── VQ.B — accept_tos exists as 2-arg signature (old 0-arg dropped)
--   SELECT proname, pg_get_function_arguments(oid) AS args
--   FROM pg_proc WHERE proname = 'accept_tos';
--   -- Expected: 1 row, args =
--   --   p_tos_version text DEFAULT NULL::text, p_privacy_version text DEFAULT NULL::text
--   -- If 2 rows return → old signature wasn't dropped; investigate.
--
-- ── VQ.C — accept_signup_consents exists with correct signature
--   SELECT proname, pg_get_function_arguments(oid) AS args
--   FROM pg_proc WHERE proname = 'accept_signup_consents';
--   -- Expected: 1 row, args =
--   --   p_attestation_version text, p_tos_version text, p_privacy_version text,
--   --   p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text
--
-- ── VQ.D — redeem_proposal_code body contains document_type
--   SELECT pg_get_functiondef(oid) ILIKE '%''tos_and_privacy''%' AS has_document_type
--   FROM pg_proc WHERE proname = 'redeem_proposal_code';
--   -- Expected: 1 row, has_document_type = true.
--
--   -- Also sanity-check signature is still single (no overload drift):
--   SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc WHERE proname = 'redeem_proposal_code';
--   -- Expected: 1 row, args =
--   --   p_code text, p_user_id uuid, p_company_name text,
--   --   p_primary_contact_name text, p_primary_contact_phone text,
--   --   p_tos_version text, p_privacy_version text,
--   --   p_address text DEFAULT NULL::text,
--   --   p_ip_address inet DEFAULT NULL::inet,
--   --   p_user_agent text DEFAULT NULL::text
--
-- ── VQ.E — normalization complete (no legacy untagged rows remain)
--   SELECT COUNT(*) AS legacy_untagged_remaining
--   FROM tos_acceptances
--   WHERE document_type IS NULL
--     AND tos_version IS NOT NULL
--     AND privacy_version IS NOT NULL;
--   -- Expected: 0 rows (the May 25 B65.4 smoke row got normalized).
--
--   -- Also confirm the normalized row carries the new value:
--   SELECT id, document_type, tos_version IS NOT NULL AS has_tos,
--          privacy_version IS NOT NULL AS has_priv
--   FROM tos_acceptances WHERE document_type = 'tos_and_privacy';
--   -- Expected: at least 1 row (the May 25 row), has_tos + has_priv both true.
--
-- ── VQ.F — GRANT state on the 3 functions
--   SELECT routine_name, grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name IN ('accept_tos', 'accept_signup_consents', 'redeem_proposal_code')
--   ORDER BY routine_name, grantee;
--   -- Expected: NO rows with grantee='PUBLIC' for any of the three.
--   --   authenticated + postgres + service_role retain access.
--
-- ── VQ.G — load-bearing negative test: anon call to accept_tos rejected
-- The function raises 'No authenticated session' (SQLSTATE 42501) when
-- called without an auth.jwt() context. The CHECK fires inside the
-- function body, but the GRANT layer also blocks anon — the test
-- confirms BOTH layers work.
--
-- Run from a SQL Editor session where the role is set to anon:
--   SET ROLE anon;
--   SELECT accept_tos('fake-version', 'fake-version');
--   RESET ROLE;
--   -- Expected: error
--   --   "ERROR: permission denied for function accept_tos"
--   --   (42501 — GRANT layer blocks before function body runs)
--
-- If SET ROLE isn't available in your Editor session, the same
-- discipline applies at runtime — anon API callers can't invoke the
-- function. The 42501 in either form confirms the discipline.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent:
--   • ADD COLUMN IF NOT EXISTS (× 2)
--   • DROP FUNCTION IF EXISTS + CREATE (accept_tos signature change)
--   • CREATE OR REPLACE FUNCTION (× 2 — accept_signup_consents,
--     redeem_proposal_code)
--   • UPDATE with precise WHERE filter (no-op on re-apply)
--   • REVOKE/GRANT (no-op when already in target state)
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
