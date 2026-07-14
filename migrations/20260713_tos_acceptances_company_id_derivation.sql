-- ════════════════════════════════════════════════════════════════════
-- tos_acceptances.company_id — server-side derivation on all 4 write RPCs
-- 2026-07-13
--
-- ORIGIN
--   Jose's 2026-07-13 audit on prod: 28 of 32 tos_acceptances rows have
--   company_id IS NULL (88% orphan rate). The 4 linked rows are A1's CA
--   from `redeem_proposal_code` (the only RPC that currently sets
--   company_id). Every other write path — accept_signup_consents,
--   accept_tos (both 2-arg legacy + 4-arg extended), accept_saas_
--   agreement, and record_resident_tos_acceptance's NULL-tolerant
--   fallback — silently orphans.
--
--   This is an attributability failure, not a consent failure. All
--   orphan rows have reviewed_at populated (scroll-to-sign fired). But
--   `SELECT * FROM tos_acceptances WHERE company_id = 91` misses 75%
--   of A1's users. If we ever produce A1's consent records for a
--   dispute or audit, the obvious query silently under-returns.
--
-- SCOPE — 4 RPCs, server-side derivation only
--   1. accept_signup_consents  (7-arg, 3 INSERTs)
--   2. accept_tos              (4-arg, 2 INSERTs)
--   3. record_resident_tos_acceptance (6-arg, 3 INSERTs — invert derivation)
--   4. accept_saas_agreement   (4-arg, 1 INSERT — also fixes user_id landmine)
--
-- NORMALIZATION — matches Commit #1 (companies_name_lower_unique)
--   The derivation join uses `lower(trim(c.name)) = lower(trim(ur.company))`
--   — the exact same normalization as the 2026-07-13 UNIQUE index. One
--   normalization rule across the schema. If one ever changes, both
--   change.
--
-- THE ONE LEGITIMATE NULL
--   accept_signup_consents called at self-serve pre-checkout: the
--   user_roles row doesn't yet exist (created by the checkout webhook
--   after Stripe returns). Derivation returns NULL and we leave it —
--   the row is a proto-user for whom no company exists yet.
--
--   Everywhere else must resolve. If derivation misses on a path where
--   user_roles must exist, RAISE — we want to know, not orphan silently.
--   The one exception is super-admin (role='admin', company=NULL by
--   design): NULL company_id is correct and expected there.
--
-- LANDMINE FIX RIDING IN THIS COMMIT
--   accept_saas_agreement:275-277 (pre-commit) UPDATEs user_roles with
--   WHERE user_id = v_uid. Jose's information_schema check confirms
--   user_roles has no `user_id` column — every other user_roles UPDATE
--   in the codebase keys by email (accept_tos, must_change_password,
--   B228 phase3 deactivate). This UPDATE has been throwing 42703
--   silently since 2026-07-10; SAAS_VERSION hasn't bumped yet so the
--   RPC has never actually been called in production (A1's SaaS row
--   came from redeem_proposal_code's inline SaaS INSERT, not from this
--   RPC). This commit fixes the keying to `lower(email) = lower(v_
--   caller_email)`. Deliberate latent-bug fix, not incidental.
--
-- CLIENT-PASSED COMPANY_ID
--   Never trusted. All derivation is inside DEFINER from auth.jwt()->>
--   'email'. Client cannot influence which tenant a consent row is
--   attributed to.
--
-- DROP-FIRST + OVERLOAD=1 ASSERTION
--   Per the July 13 correction: defaulted-new-argument on an existing
--   RPC creates a second overload; PostgREST then resolves ambiguously.
--   Each RPC's old signature is DROP-FUNCTION-IF-EXISTS'd first;
--   pg_proc.count is asserted = 1 after CREATE. Whole migration lives
--   in ONE transaction — any assertion trips → all four roll back.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- RPC 1 of 4 — accept_signup_consents
-- ══════════════════════════════════════════════════════════════════
-- Adds v_company_id derivation + company_id in 3 INSERTs.
-- Legitimate NULL: pre-checkout self-serve (no user_roles row yet).

DROP FUNCTION IF EXISTS public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT);  -- defensive: pre-2026-07-10 5-arg
DROP FUNCTION IF EXISTS public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);  -- 2026-07-10 7-arg

CREATE OR REPLACE FUNCTION public.accept_signup_consents(
  p_attestation_version TEXT,
  p_tos_version         TEXT,
  p_privacy_version     TEXT,
  p_ip_address          INET        DEFAULT NULL,
  p_user_agent          TEXT        DEFAULT NULL,
  p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,
  p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_company_id    BIGINT;
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

  -- Server-side company_id derivation. Trust auth-derived email + our
  -- own tables; never a client-passed arg. Legitimate NULL on the
  -- self-serve pre-checkout path: user_roles doesn't exist yet.
  SELECT c.id INTO v_company_id
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  -- 1. Texas attestation row (no reviewed_at — checkbox, not a gate).
  SELECT id INTO v_existing_id
  FROM tos_acceptances
  WHERE user_id = v_caller_uid
    AND document_type = 'texas_attestation'
    AND attestation_version = p_attestation_version
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO tos_acceptances (
      user_id, company_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent
    ) VALUES (
      v_caller_uid, v_company_id, 'texas_attestation',
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
      user_id, company_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id, 'tos',
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
      user_id, company_id, document_type,
      tos_version, privacy_version, attestation_version,
      ip_address, user_agent,
      reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id, 'privacy',
      NULL, p_privacy_version, NULL,
      p_ip_address, p_user_agent,
      p_privacy_reviewed_at
    );
  END IF;
END
$func$;

REVOKE ALL ON FUNCTION public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_signup_consents(TEXT, TEXT, TEXT, INET, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

DO $chk1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_signup_consents';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'accept_signup_consents has % overloads; expected 1', v_count;
  END IF;
END $chk1$;


-- ══════════════════════════════════════════════════════════════════
-- RPC 2 of 4 — accept_tos
-- ══════════════════════════════════════════════════════════════════
-- Adds v_company_id + company_id in 2 INSERTs. RAISE on missing
-- derivation (invited users always have user_roles at accept time;
-- super-admin exempt via role check).

DROP FUNCTION IF EXISTS public.accept_tos(TEXT, TEXT);                              -- defensive: pre-2026-07-10 2-arg
DROP FUNCTION IF EXISTS public.accept_tos(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);     -- 2026-07-10 4-arg

CREATE OR REPLACE FUNCTION public.accept_tos(
  p_tos_version         TEXT        DEFAULT NULL,
  p_privacy_version     TEXT        DEFAULT NULL,
  p_tos_reviewed_at     TIMESTAMPTZ DEFAULT NULL,
  p_privacy_reviewed_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_caller_role   TEXT;
  v_company_id    BIGINT;
  v_existing_id   BIGINT;
BEGIN
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'No authenticated session' USING ERRCODE = '42501';
  END IF;

  -- Legacy path: stamp tos_accepted_at only when both versions null.
  -- Preserves existing behavior for any callsite that hasn't migrated
  -- to the version-aware form yet. (Behavior unchanged from 2026-07-10.)
  IF p_tos_version IS NULL AND p_privacy_version IS NULL THEN
    UPDATE user_roles
    SET tos_accepted_at = now()
    WHERE email ILIKE v_caller_email
      AND tos_accepted_at IS NULL;
    RETURN;
  END IF;

  -- Version-aware path: derive company_id, then write tos_acceptances
  -- rows + stamp user_roles columns.
  SELECT ur.role, c.id
    INTO v_caller_role, v_company_id
    FROM public.user_roles ur
    LEFT JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  -- v_caller_role IS NULL → no user_roles row (should never happen for
  -- invited-accept callers). RAISE — orphaning silently is exactly the
  -- pattern the 2026-07-13 audit closed.
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'accept_tos: no user_roles row for authenticated caller' USING ERRCODE = '42501';
  END IF;

  -- v_company_id IS NULL only legitimately for super-admin (role='admin').
  -- Every other role must resolve; RAISE if not.
  IF v_company_id IS NULL AND v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'accept_tos: could not derive company_id for role=% (user_roles.company unmatched or NULL)', v_caller_role
      USING ERRCODE = '42501',
            HINT = 'Check user_roles.company vs companies.name for lower(trim(...)) match';
  END IF;

  IF p_tos_version IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM tos_acceptances
    WHERE user_id = v_caller_uid
      AND document_type = 'tos'
      AND tos_version = p_tos_version
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      INSERT INTO tos_acceptances (
        user_id, company_id, document_type, tos_version,
        privacy_version, attestation_version,
        ip_address, user_agent,
        reviewed_at
      ) VALUES (
        v_caller_uid, v_company_id, 'tos', p_tos_version,
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
        user_id, company_id, document_type, tos_version,
        privacy_version, attestation_version,
        ip_address, user_agent,
        reviewed_at
      ) VALUES (
        v_caller_uid, v_company_id, 'privacy', NULL,
        p_privacy_version, NULL,
        NULL, NULL,
        p_privacy_reviewed_at
      );
    END IF;
  END IF;

  -- Stamp user_roles version columns (unchanged from 2026-07-10).
  UPDATE user_roles
  SET tos_accepted_at          = now(),
      tos_accepted_version     = COALESCE(p_tos_version, tos_accepted_version),
      privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
  WHERE email ILIKE v_caller_email;
END
$func$;

REVOKE ALL ON FUNCTION public.accept_tos(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_tos(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_tos(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

DO $chk2$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_tos';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'accept_tos has % overloads; expected 1', v_count;
  END IF;
END $chk2$;


-- ══════════════════════════════════════════════════════════════════
-- RPC 3 of 4 — record_resident_tos_acceptance
-- ══════════════════════════════════════════════════════════════════
-- Inverts derivation: user_roles FIRST (tenancy source of truth), then
-- residents as widener for the edge case (self-registration in flight,
-- no user_roles yet — but residents row already exists). Kills the
-- "NULL is fine, backfilled later" comment and posture — RAISE if
-- BOTH miss.

DROP FUNCTION IF EXISTS public.record_resident_tos_acceptance(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT);

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

  -- Derivation: user_roles FIRST (the tenancy source of truth every
  -- RLS predicate + the B228 cascade key on), residents as widener for
  -- the edge case (registration in flight, no user_roles yet, but
  -- residents row exists via bulk-upload).
  SELECT c.id INTO v_company_id
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  IF v_company_id IS NULL THEN
    SELECT c.id INTO v_company_id
      FROM public.residents r
      JOIN public.companies c
        ON lower(trim(c.name)) = lower(trim(r.company))
     WHERE lower(r.email) = lower(v_caller_email)
     LIMIT 1;
  END IF;

  -- Residents flow ONLY (never super-admin): a resident with no
  -- user_roles AND no residents row cannot legitimately reach this
  -- RPC. If both miss, that's a bug worth surfacing.
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'record_resident_tos_acceptance: could not derive company_id (no user_roles or residents row for caller)'
      USING ERRCODE = '42501',
            HINT = 'Check user_roles.company / residents.company vs companies.name for lower(trim(...)) match';
  END IF;

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

  -- Stamp user_roles version columns (behavior preserved from 2026-07-10).
  UPDATE public.user_roles
     SET tos_accepted_at          = now(),
         tos_accepted_version     = COALESCE(p_tos_version, tos_accepted_version),
         privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
   WHERE lower(email) = lower(v_caller_email);
END
$func$;

REVOKE ALL ON FUNCTION public.record_resident_tos_acceptance(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_resident_tos_acceptance(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_resident_tos_acceptance(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INET, TEXT) TO authenticated;

DO $chk3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_resident_tos_acceptance';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'record_resident_tos_acceptance has % overloads; expected 1', v_count;
  END IF;
END $chk3$;


-- ══════════════════════════════════════════════════════════════════
-- RPC 4 of 4 — accept_saas_agreement
-- ══════════════════════════════════════════════════════════════════
-- Adds v_company_id + company_id in the SaaS INSERT. ALSO fixes the
-- 2026-07-10 landmine: UPDATE user_roles WHERE user_id = v_uid → WHERE
-- lower(email) = lower(v_caller_email). user_roles has no user_id
-- column (Jose's information_schema check 2026-07-13); the RPC has
-- been throwing 42703 silently. Deliberate latent-bug fix riding in
-- the data-integrity commit.

DROP FUNCTION IF EXISTS public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT);

CREATE OR REPLACE FUNCTION public.accept_saas_agreement(
  p_saas_version TEXT,
  p_reviewed_at  TIMESTAMPTZ,
  p_ip_address   INET DEFAULT NULL,
  p_user_agent   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_caller_role   TEXT;
  v_company_id    BIGINT;
BEGIN
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_saas_version IS NULL OR length(p_saas_version) = 0 THEN
    RAISE EXCEPTION 'p_saas_version required' USING ERRCODE = '22004';
  END IF;

  IF p_reviewed_at IS NULL THEN
    RAISE EXCEPTION 'p_reviewed_at required (client stamp when gate unlocked)' USING ERRCODE = '22004';
  END IF;

  -- Server-side derivation. Every SaaS-accept caller is a subscriber
  -- (or super-admin) with a user_roles row.
  SELECT ur.role, c.id
    INTO v_caller_role, v_company_id
    FROM public.user_roles ur
    LEFT JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'accept_saas_agreement: no user_roles row for authenticated caller' USING ERRCODE = '42501';
  END IF;

  IF v_company_id IS NULL AND v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'accept_saas_agreement: could not derive company_id for role=% (user_roles.company unmatched or NULL)', v_caller_role
      USING ERRCODE = '42501',
            HINT = 'Check user_roles.company vs companies.name for lower(trim(...)) match';
  END IF;

  -- Idempotent write on (user_id, document_type='saas', saas_version).
  IF NOT EXISTS (
    SELECT 1 FROM tos_acceptances
    WHERE user_id = v_caller_uid
      AND document_type = 'saas'
      AND saas_version = p_saas_version
  ) THEN
    INSERT INTO tos_acceptances (
      user_id,
      company_id,
      document_type,
      saas_version,
      reviewed_at,
      ip_address,
      user_agent
    ) VALUES (
      v_caller_uid,
      v_company_id,
      'saas',
      p_saas_version,
      p_reviewed_at,
      p_ip_address,
      p_user_agent
    );
  END IF;

  -- Stamp user_roles.saas_accepted_version. LANDMINE FIX: pre-commit
  -- keyed WHERE user_id = v_uid (no such column, silent 42703 since
  -- 2026-07-10). Corrected to email-keying which matches every other
  -- user_roles UPDATE in the codebase.
  UPDATE user_roles
     SET saas_accepted_version = COALESCE(p_saas_version, saas_accepted_version)
   WHERE lower(email) = lower(v_caller_email);
END
$body$;

REVOKE ALL ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) TO authenticated;

DO $chk4$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_saas_agreement';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'accept_saas_agreement has % overloads; expected 1', v_count;
  END IF;
END $chk4$;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_DERIVATION',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260713_tos_acceptances_company_id_derivation',
    'change',    'Add server-side company_id derivation (lower(trim(user_roles.company)) join lower(trim(companies.name))) to accept_signup_consents (7-arg), accept_tos (4-arg), record_resident_tos_acceptance (6-arg), accept_saas_agreement (4-arg). All 4 INSERTs into tos_acceptances now populate company_id. Legitimate NULL only on accept_signup_consents pre-checkout (user_roles doesn''t exist yet); everywhere else RAISEs when derivation misses (super-admin role=''admin'' exempted). record_resident_tos_acceptance derivation inverted: user_roles FIRST (tenancy source of truth), residents as widener. accept_saas_agreement''s user_roles UPDATE keying corrected from user_id (nonexistent column, silent 42703 since 2026-07-10) to lower(email). All 4 RPCs: DROP-first + REVOKE PUBLIC/anon + GRANT authenticated + pg_proc overload=1 assertion. Whole migration atomic in one transaction.',
    'rationale', 'Jose 2026-07-13 audit found 88% tos_acceptances.company_id orphan rate on prod (28/32 rows NULL). Only redeem_proposal_code was setting company_id; the 4 other write paths orphaned every row silently. Attributability failure — SELECT * FROM tos_acceptances WHERE company_id = 91 misses 75% of A1''s users. Also caught latent accept_saas_agreement UPDATE landmine referencing nonexistent user_roles.user_id (never fired in prod because SAAS_VERSION hasn''t bumped since 2026-07-10; A1''s SaaS row landed via redeem_proposal_code''s inline INSERT). Companion backfill lands as separate migration (20260713_tos_acceptances_company_id_backfill).'
  ),
  now()
);

COMMIT;
