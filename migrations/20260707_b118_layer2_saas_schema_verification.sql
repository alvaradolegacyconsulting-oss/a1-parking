-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 — Post-apply verification for 20260707_b118_layer2_saas_schema
--
-- Paste into Supabase SQL Editor AFTER the forward migration applies.
-- Each block is independent — run any or all.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — 5-doc whitelist active ──────────────────────────────────
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'tos_acceptances_document_type_valid';
-- Expected: whitelist contains all 5 values:
--   'tos_and_privacy', 'texas_attestation', 'tos', 'privacy', 'saas'


-- ── VQ.B — 5-branch version-match constraint ───────────────────────
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'tos_acceptances_version_match';
-- Expected: 5 OR-branches. New 'saas' branch requires saas_version
-- populated + tos_version, privacy_version, attestation_version all NULL.


-- ── VQ.C — new columns present + correctly typed ───────────────────
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'tos_acceptances' AND column_name IN ('saas_version', 'reviewed_at'))
    OR (table_name = 'user_roles' AND column_name = 'saas_accepted_version')
  )
ORDER BY table_name, column_name;
-- Expected 3 rows:
--   tos_acceptances | reviewed_at            | timestamp with time zone | YES
--   tos_acceptances | saas_version           | text                     | YES
--   user_roles      | saas_accepted_version  | text                     | YES


-- ── VQ.D — accept_saas_agreement RPC exists, SECURITY DEFINER, correct grants
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS is_security_definer,
       array(
         SELECT grantee || '=' || privilege_type
         FROM information_schema.routine_privileges
         WHERE routine_name = 'accept_saas_agreement'
           AND routine_schema = 'public'
         ORDER BY grantee, privilege_type
       )                                         AS grants
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'accept_saas_agreement';
-- Expected 1 row:
--   proname               = accept_saas_agreement
--   args                  = p_saas_version text, p_reviewed_at timestamp with time zone,
--                           p_ip_address inet, p_user_agent text
--   is_security_definer   = true
--   grants                = { 'authenticated=EXECUTE' }
-- (No 'anon=EXECUTE' and no 'PUBLIC=EXECUTE' — otherwise
-- [[feedback_function_public_grant_supabase_default]] rules apply.)


-- ── VQ.E — CHECK enforcement smoke: invalid shapes reject (rollback each) ──
-- Each block below is meant to be run as a probe of an already-authenticated
-- SESSION with a valid auth.uid(). Wrap each in ROLLBACK so nothing lands.
--
-- VQ.E.1 — 'saas' row without saas_version → violates version_match
--   BEGIN;
--   INSERT INTO tos_acceptances (user_id, document_type, saas_version)
--   VALUES (auth.uid(), 'saas', NULL);
--   -- Expected: ERROR check constraint "tos_acceptances_version_match"
--   ROLLBACK;
--
-- VQ.E.2 — 'saas' row with both saas_version and tos_version → violates
--   BEGIN;
--   INSERT INTO tos_acceptances (user_id, document_type, saas_version, tos_version)
--   VALUES (auth.uid(), 'saas', 'probe', 'probe-tos');
--   -- Expected: ERROR check constraint "tos_acceptances_version_match"
--   ROLLBACK;
--
-- VQ.E.3 — unknown document_type → violates document_type_valid
--   BEGIN;
--   INSERT INTO tos_acceptances (user_id, document_type) VALUES (auth.uid(), 'made_up');
--   -- Expected: ERROR check constraint "tos_acceptances_document_type_valid"
--   ROLLBACK;
--
-- VQ.E.4 — valid 'saas' shape → accepts
--   BEGIN;
--   INSERT INTO tos_acceptances (user_id, document_type, saas_version, reviewed_at)
--   VALUES (auth.uid(), 'saas', 'vq-e-4-probe', now());
--   -- Expected: 1 row inserted; no CHECK violation.
--   ROLLBACK;


-- ── VQ.F — anon path blocked at execute-grant layer ────────────────
-- From a fresh anon-only session (no auth cookie, only NEXT_PUBLIC_SUPABASE_ANON_KEY):
--   SELECT accept_saas_agreement('probe', now());
-- Expected: ERROR permission denied for function accept_saas_agreement.
-- (Per [[feedback_revoke_from_anon_explicitly]] — REVOKE FROM anon
-- makes this deterministic.)


-- ── VQ.G — historical rows still valid (no backfill regression) ────
SELECT document_type, count(*) FROM tos_acceptances GROUP BY document_type ORDER BY document_type;
-- Expected: existing 'tos_and_privacy', 'texas_attestation', 'tos',
-- 'privacy' counts unchanged. 'saas' = 0 until Commit 3 ships and
-- the first user signs.
