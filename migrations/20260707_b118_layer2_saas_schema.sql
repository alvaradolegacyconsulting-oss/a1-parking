-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 — SaaS Subscription Agreement schema + accept RPC
--
-- Preflight discipline: BEFORE APPLYING, run the live CHECK-constraint
-- query (see B118_LAYER2_LIVE_CHECK_QUERY below) and paste output back
-- so we confirm no drift from the constraint-extension migration
-- (20260605_b118_constraint_extension.sql). See
-- [[feedback_audit_pass_must_query_production_schema]].
--
-- ── PARTS ─────────────────────────────────────────────────────────────
--   PART 1 — tos_acceptances.saas_version TEXT column
--   PART 2 — tos_acceptances.reviewed_at TIMESTAMPTZ column
--   PART 3 — user_roles.saas_accepted_version TEXT column
--   PART 4 — tos_acceptances_document_type_valid CHECK extension (+'saas')
--   PART 5 — tos_acceptances_version_match CHECK extension (+5th branch)
--   PART 6 — accept_saas_agreement() SECURITY DEFINER RPC + grants
--
-- ── PATTERNS FOLLOWED ────────────────────────────────────────────────
-- • Idempotent DDL (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS then
--   guarded ADD) — safe to re-run.
-- • Single BEGIN/COMMIT wrapping the whole migration —
--   [[feedback_sql_editor_partial_apply]] (SQL Editor doesn't atomically
--   apply multi-BEGIN blocks; single-paste discipline).
-- • Dollar-quote tags use $func$ / $body$ to avoid the ; parsing bug
--   in [[feedback_sql_editor_dollar_quote_parsing]].
-- • SECURITY DEFINER RPC: REVOKE FROM PUBLIC + explicit REVOKE FROM
--   anon, GRANT EXECUTE TO authenticated only. Matches accept_tos +
--   accept_signup_consents (B118 commit 1 PART 6). See
--   [[feedback_revoke_from_anon_explicitly]] +
--   [[feedback_function_public_grant_supabase_default]].
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────
-- Reverse of forward steps. Given both columns are additive-only and
-- nullable, rollback is safe: DROP FUNCTION accept_saas_agreement;
-- DROP the two CHECK constraints, re-ADD the pre-Layer-2 shapes; DROP
-- COLUMN saas_version, reviewed_at, saas_accepted_version. Do NOT
-- rollback in prod without draining any live saas rows first (there
-- shouldn't be any before Commit 3 ships).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — tos_acceptances.saas_version TEXT
--
-- Mirrors tos_version / privacy_version / attestation_version. The
-- version-match CHECK enforces exactly-one-populated per document_type
-- so we can't reuse an existing column (would break the 4 existing
-- branches). Nullable for the 4 existing document_types.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tos_acceptances
  ADD COLUMN IF NOT EXISTS saas_version TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — tos_acceptances.reviewed_at TIMESTAMPTZ
--
-- Review-evidence column. Populated only for scroll-gated documents
-- (SaaS today). Client stamps the moment the readthrough gate unlocks
-- (scroll-to-end / focus / wheel-past-last-frame — any of the 3);
-- server records it via the accept_saas_agreement RPC.
--
-- Nullable so the 4 existing document_types (tos, privacy,
-- tos_and_privacy, texas_attestation) leave it NULL — they aren't
-- scroll-gated. Not enforced by the version-match CHECK (that CHECK
-- governs the version columns only; reviewed_at is independent).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tos_acceptances
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — user_roles.saas_accepted_version TEXT
--
-- Matches user_roles.tos_accepted_version + privacy_accepted_version
-- (from 20260604_b118_consent_version_tracking.sql). Enables the
-- version-aware modal / gate re-prompt logic — however per Jose's
-- track-sensitivity guardrail the *behavior* on bump differs by track
-- (self-serve = re-present, Legacy/negotiated = deliberate re-sign,
-- NOT an auto-lockout). The column itself is track-neutral: it just
-- records what version this user last signed. Behavior lives above it.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS saas_accepted_version TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Extend tos_acceptances_document_type_valid whitelist
--
-- Old (from 20260605_b118_constraint_extension.sql):
--   ['tos_and_privacy', 'texas_attestation', 'tos', 'privacy']
-- New:
--   + 'saas'
--
-- Postgres has no ALTER CHECK CONSTRAINT in place. DROP + guarded
-- re-ADD is the atomic path (all within this BEGIN/COMMIT).
--
-- Preserving 'tos_and_privacy' in the whitelist indefinitely per Jose
-- lock — historical rows are valid consent and must remain queryable.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tos_acceptances
  DROP CONSTRAINT IF EXISTS tos_acceptances_document_type_valid;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_document_type_valid'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_document_type_valid
      CHECK (document_type = ANY (ARRAY[
        'tos_and_privacy',
        'texas_attestation',
        'tos',
        'privacy',
        'saas'
      ]));
  END IF;
END
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Extend tos_acceptances_version_match with 5th branch
--
-- Old (from 20260605_b118_constraint_extension.sql): 4 branches —
--   1. tos_and_privacy: tos+privacy populated, others NULL
--   2. texas_attestation: attestation populated, others NULL
--   3. tos: tos_version populated, others NULL
--   4. privacy: privacy_version populated, others NULL
-- New:
--   5. saas: saas_version populated, tos + privacy + attestation NULL
--
-- Note the CHECK governs only the version columns — reviewed_at is
-- outside the CHECK (independent). Setting reviewed_at is permitted on
-- any document_type row but is only *meaningful* for scroll-gated docs.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE tos_acceptances
  DROP CONSTRAINT IF EXISTS tos_acceptances_version_match;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_version_match'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_version_match
      CHECK (
        (document_type = 'tos_and_privacy'
           AND tos_version IS NOT NULL
           AND privacy_version IS NOT NULL
           AND attestation_version IS NULL
           AND saas_version IS NULL)
        OR
        (document_type = 'texas_attestation'
           AND attestation_version IS NOT NULL
           AND tos_version IS NULL
           AND privacy_version IS NULL
           AND saas_version IS NULL)
        OR
        (document_type = 'tos'
           AND tos_version IS NOT NULL
           AND privacy_version IS NULL
           AND attestation_version IS NULL
           AND saas_version IS NULL)
        OR
        (document_type = 'privacy'
           AND privacy_version IS NOT NULL
           AND tos_version IS NULL
           AND attestation_version IS NULL
           AND saas_version IS NULL)
        OR
        (document_type = 'saas'
           AND saas_version IS NOT NULL
           AND tos_version IS NULL
           AND privacy_version IS NULL
           AND attestation_version IS NULL)
      );
  END IF;
END
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 6 — accept_saas_agreement() SECURITY DEFINER RPC
--
-- Called by the /api/signup/accept-saas server route AFTER the user
-- has scrolled through the SaaS pane and clicked Sign (self-serve
-- path only — redeem path folds the SaaS row into redeem_proposal_code
-- via extra params, applied in Commit 3).
--
-- Idempotency: check-then-insert on (user_id, document_type='saas',
-- saas_version) — reuse of the pattern from accept_signup_consents /
-- accept_tos (see 20260604_b118_consent_version_tracking.sql).
-- Same user re-signing the same version is a no-op; version bump is
-- a new row.
--
-- Also stamps user_roles.saas_accepted_version so the version-aware
-- read path (client / /login predicate) can detect stale acceptance
-- WITHOUT scanning tos_acceptances on every login.
--
-- SECURITY:
-- • SECURITY DEFINER — the function bypasses RLS for the
--   tos_acceptances + user_roles writes that the caller can't do
--   directly.
-- • auth.uid() read internally — never trust user_id from a param
--   ([[feedback_legal_version_pinning]] + B118 commit 2 security note).
-- • REVOKE FROM PUBLIC + REVOKE FROM anon explicitly per
--   [[feedback_revoke_from_anon_explicitly]] +
--   [[feedback_function_public_grant_supabase_default]].
-- • GRANT EXECUTE TO authenticated only (not anon, not service_role —
--   the SD context grants the necessary DB access; API layer
--   authenticates the user before invoking).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION accept_saas_agreement(
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
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_saas_version IS NULL OR length(p_saas_version) = 0 THEN
    RAISE EXCEPTION 'p_saas_version required' USING ERRCODE = '22004';
  END IF;

  IF p_reviewed_at IS NULL THEN
    RAISE EXCEPTION 'p_reviewed_at required (client stamp when gate unlocked)' USING ERRCODE = '22004';
  END IF;

  -- ── Idempotent write on (user_id, document_type='saas', saas_version)
  --
  -- Same user re-signing the same version: no new row. Bump: new row.
  IF NOT EXISTS (
    SELECT 1 FROM tos_acceptances
    WHERE user_id = v_uid
      AND document_type = 'saas'
      AND saas_version = p_saas_version
  ) THEN
    INSERT INTO tos_acceptances (
      user_id,
      document_type,
      saas_version,
      reviewed_at,
      ip_address,
      user_agent
    ) VALUES (
      v_uid,
      'saas',
      p_saas_version,
      p_reviewed_at,
      p_ip_address,
      p_user_agent
    );
  END IF;

  -- ── Stamp user_roles.saas_accepted_version so the version-aware
  -- read paths (login predicate / any gate re-present check) can
  -- detect stale acceptance without scanning tos_acceptances.
  --
  -- Matches the accept_signup_consents / accept_tos pattern for tos +
  -- privacy versions. Uses COALESCE to avoid clobbering with NULL if
  -- a future call ever passes an empty value — defensive.
  UPDATE user_roles
    SET saas_accepted_version = COALESCE(p_saas_version, saas_accepted_version)
    WHERE user_id = v_uid;
END
$body$;

-- Lock down execution: PUBLIC + anon revoked; only authenticated
-- role can invoke. Service-role explicitly not granted (defense in
-- depth — the SECURITY DEFINER context is sufficient for the writes).
REVOKE ALL ON FUNCTION accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- B118_LAYER2_LIVE_CHECK_QUERY — run BEFORE applying this migration
--
-- Paste into Supabase SQL Editor and drop the output back to the
-- planning chat. Confirms the two CHECK constraints on tos_acceptances
-- are still at the shape 20260605_b118_constraint_extension.sql
-- established — no drift, no other extension we didn't ship.
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.tos_acceptances'::regclass
--   AND contype = 'c'
-- ORDER BY conname;
--
-- Expected 2 rows:
--   tos_acceptances_document_type_valid |
--     CHECK ((document_type = ANY (ARRAY['tos_and_privacy'::text,
--       'texas_attestation'::text, 'tos'::text, 'privacy'::text])))
--
--   tos_acceptances_version_match       |
--     CHECK (
--       ((document_type = 'tos_and_privacy' AND tos_version IS NOT NULL
--         AND privacy_version IS NOT NULL AND attestation_version IS NULL))
--       OR ((document_type = 'texas_attestation' AND attestation_version
--         IS NOT NULL AND tos_version IS NULL AND privacy_version IS NULL))
--       OR ((document_type = 'tos' AND tos_version IS NOT NULL
--         AND privacy_version IS NULL AND attestation_version IS NULL))
--       OR ((document_type = 'privacy' AND privacy_version IS NOT NULL
--         AND tos_version IS NULL AND attestation_version IS NULL))
--     )
--
-- If the live output matches expected → PART 4 + PART 5's DROP +
-- ADD is safe. If drift is seen (extra branches, extra doc types,
-- different constraint names) → SURFACE + PAUSE; do not apply.
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run AFTER migration applies)
--
-- VQ.A — 5-doc whitelist active
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'tos_acceptances_document_type_valid';
--   -- Expected: … ARRAY['tos_and_privacy', 'texas_attestation',
--   --   'tos', 'privacy', 'saas'] …
--
-- VQ.B — 5-branch version-match
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'tos_acceptances_version_match';
--   -- Expected: 5 OR-branches, saas branch requires saas_version
--   -- populated + the 3 other version columns NULL.
--
-- VQ.C — new columns present + typed
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND (
--       (table_name = 'tos_acceptances' AND column_name IN ('saas_version', 'reviewed_at'))
--       OR (table_name = 'user_roles' AND column_name = 'saas_accepted_version')
--     )
--   ORDER BY table_name, column_name;
--   -- Expected 3 rows: saas_version TEXT/YES; reviewed_at
--   -- TIMESTAMPTZ/YES (in tos_acceptances); saas_accepted_version
--   -- TEXT/YES (in user_roles).
--
-- VQ.D — accept_saas_agreement RPC exists with the expected grants
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--          p.prosecdef AS is_security_definer,
--          array(SELECT grantee || '=' || privilege_type
--                FROM information_schema.routine_privileges
--                WHERE routine_name = 'accept_saas_agreement'
--                  AND routine_schema = 'public'
--                ORDER BY grantee, privilege_type) AS grants
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'accept_saas_agreement';
--   -- Expected: 1 row; is_security_definer = true; grants includes
--   -- 'authenticated=EXECUTE' and DOES NOT include 'anon=EXECUTE' or
--   -- 'PUBLIC=EXECUTE'.
--
-- VQ.E — reject-anon smoke (belt-and-suspenders, from a fresh psql /
--   supabase-cli session unauthenticated):
--   SELECT accept_saas_agreement('probe', now());
--   -- Expected: permission denied for function accept_saas_agreement.
-- ════════════════════════════════════════════════════════════════════
