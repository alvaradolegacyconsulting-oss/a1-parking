-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 Commit 3 — Post-apply verification
-- Companion to 20260707_b118_layer2_saas_redeem_extension.sql
--
-- Paste into Supabase SQL Editor AFTER the forward migration applies.
-- Each VQ block is independent.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — single 13-arg overload, SD, expected args, no stragglers
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS is_security_definer,
       (SELECT count(*) FROM pg_proc p2
        WHERE p2.proname = 'redeem_proposal_code'
          AND p2.pronamespace = n.oid)           AS overload_count
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'redeem_proposal_code';
-- Expected 1 row:
--   proname             = redeem_proposal_code
--   args                = p_code text, p_user_id uuid, p_company_name text,
--                         p_primary_contact_name text, p_primary_contact_phone text,
--                         p_tos_version text, p_privacy_version text,
--                         p_address text, p_ip_address inet, p_user_agent text,
--                         p_attestation_version text, p_saas_version text,
--                         p_saas_reviewed_at timestamp with time zone
--   is_security_definer = true
--   overload_count      = 1   ← LOAD-BEARING (11-arg zombie dropped cleanly)


-- ── VQ.B — grants: authenticated only, no anon/PUBLIC/service_role
SELECT array(
  SELECT grantee || '=' || privilege_type
  FROM information_schema.routine_privileges
  WHERE routine_name = 'redeem_proposal_code'
    AND routine_schema = 'public'
  ORDER BY grantee, privilege_type
) AS grants;
-- Expected: { 'authenticated=EXECUTE', 'postgres=EXECUTE' }
-- (postgres = ownership implicit; anon + service_role revoked; PUBLIC
-- revoked. If either anon= or service_role= appears, the REVOKE emit
-- at end of forward migration didn't take.)


-- ── VQ.C — audit row landed
SELECT action, new_values->>'migration' AS migration, created_at
FROM public.audit_logs
WHERE action = 'SCHEMA_REDEEM_SAAS_EXTENSION'
ORDER BY created_at DESC
LIMIT 1;
-- Expected 1 row, migration = '20260707_b118_layer2_saas_redeem_extension'.


-- ── VQ.D — schema still enforces the saas branch from Commit 1
-- Sanity: the version_match CHECK is still 5 branches incl. saas.
-- (Untouched by this migration, but confirms no regression.)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'tos_acceptances_version_match';
-- Expected: 5 OR-branches (tos_and_privacy, texas_attestation, tos,
-- privacy, saas). Saas branch requires saas_version populated + the
-- 3 other version cols NULL.


-- ── VQ.E — app-level smoke (run from a fresh test redeem, deploy-then-verify):
--
-- After a fresh throwaway redeem (comp Legacy code, ~$2, refund after)
-- via the deployed UI (Commit 3 UI shipped in the same commit as this
-- migration), inspect the inserted rows for the smoke user:
--
-- VQ.E.1 — Four sibling rows landed
--   SELECT document_type, tos_version, privacy_version,
--          attestation_version, saas_version,
--          reviewed_at, accepted_at
--   FROM tos_acceptances
--   WHERE user_id = '<test-uid>'
--   ORDER BY document_type;
--   -- Expected 4 rows:
--   --   privacy           | NULL      | <PRIVACY_VERSION> | NULL      | NULL          | NULL       | <t2>
--   --   saas              | NULL      | NULL              | NULL      | <SAAS_VERSION>| <t1>       | <t2>
--   --   texas_attestation | NULL      | NULL              | <TEXAS_V> | NULL          | NULL       | <t2>
--   --   tos               | <TOS_V>   | NULL              | NULL      | NULL          | NULL       | <t2>
--   -- Load-bearing on the saas row: reviewed_at < accepted_at (t1 < t2),
--   -- proving the readthrough-then-sign evidence gap.
--
-- VQ.E.2 — user_roles.saas_accepted_version stamped
--   SELECT tos_accepted_at IS NOT NULL AS at_stamped,
--          tos_accepted_version, privacy_accepted_version, saas_accepted_version
--   FROM user_roles
--   WHERE lower(email) = '<test-email>';
--   -- Expected: at_stamped=true; tos_accepted_version=<TOS_VERSION>;
--   -- privacy_accepted_version=<PRIVACY_VERSION>; saas_accepted_version=<SAAS_VERSION>.
--
-- VQ.E.3 — No first-login modal on next login (Surprise-A still holds).
--   The login-modal predicate reads only tos_accepted_at + tos_version
--   + privacy_version — NOT saas_accepted_version. Verify by logging
--   the smoke user in/out; modal should not fire.
--
-- VQ.E.4 — Local SAAS_VERSION bump does NOT auto-prompt the Legacy user.
--   Bump SAAS_VERSION in legal-versions.ts locally + rebuild; log the
--   smoke user in. Expected: no auto modal (SaaS bump is deliberate
--   re-sign UX, out of scope for Commit 3). Revert.


-- ── VQ.F — Rollback smoke (only if needed):
--   \i migrations/20260707_b118_layer2_redeem_two_click_and_stamp.sql
-- Restores the 11-arg body (Commit 2 shape). The tos_acceptances CHECK
-- constraints from Commit 1 accept both shapes (5-value whitelist,
-- 5-branch version_match), so rollback is schema-safe. Existing 'saas'
-- rows remain valid; new redeems just won't fire the saas INSERT
-- (Section 4d) or the saas_accepted_version stamp.
