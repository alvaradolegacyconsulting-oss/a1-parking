-- ════════════════════════════════════════════════════════════════════
-- B118 Layer 2 Commit 2 — Post-apply verification
-- Companion to 20260707_b118_layer2_redeem_two_click_and_stamp.sql
--
-- Paste into Supabase SQL Editor AFTER the forward migration applies.
-- Each VQ block is independent.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — redeem_proposal_code still SD, single overload, correct args
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
--                         p_attestation_version text
--   is_security_definer = true
--   overload_count      = 1   ← LOAD-BEARING (no signature drift)


-- ── VQ.B — grants: authenticated=EXECUTE, no anon/PUBLIC/service_role
SELECT array(
  SELECT grantee || '=' || privilege_type
  FROM information_schema.routine_privileges
  WHERE routine_name = 'redeem_proposal_code'
    AND routine_schema = 'public'
  ORDER BY grantee, privilege_type
) AS grants;
-- Expected: { 'authenticated=EXECUTE', 'postgres=EXECUTE' }
-- (postgres=EXECUTE = ownership implicit; anon + service_role revoked;
-- PUBLIC revoked. Per [[feedback_revoke_from_anon_explicitly]].)


-- ── VQ.C — audit row landed
SELECT action, new_values->>'migration' AS migration, created_at
FROM public.audit_logs
WHERE action = 'SCHEMA_REDEEM_TWO_CLICK_AND_STAMP'
ORDER BY created_at DESC
LIMIT 1;
-- Expected: 1 row, migration = '20260707_b118_layer2_redeem_two_click_and_stamp'.


-- ── VQ.D — app-level smoke (run from a fresh test redeem session):
--
-- After a fresh test redeem completes (a throwaway proposal code +
-- throwaway auth user), inspect the newly-inserted rows.
--
-- VQ.D.1 — Three sibling rows landed, NOT the old combined shape.
--   SELECT document_type, tos_version, privacy_version, attestation_version, accepted_at
--   FROM tos_acceptances
--   WHERE user_id = '<test-uid>'
--   ORDER BY document_type;
--   -- Column is `accepted_at`, NOT `created_at` (an earlier version of
--   -- this comment named the wrong column — the 2026-07-08 smoke caught it).
--   -- Expected 3 rows:
--   --   privacy           | NULL       | <PRIVACY_VERSION> | NULL            | true
--   --   texas_attestation | NULL       | NULL              | <TEXAS_VERSION> | true
--   --   tos               | <TOS_VERSION> | NULL           | NULL            | true
--   -- NO 'tos_and_privacy' row (previously the shape; retired here).
--
-- VQ.D.2 — user_roles version columns stamped (Surprise-A fix).
--   SELECT tos_accepted_at IS NOT NULL AS at_stamped,
--          tos_accepted_version,
--          privacy_accepted_version
--   FROM user_roles
--   WHERE lower(email) = '<test-email>';
--   -- Expected:
--   --   at_stamped                = true
--   --   tos_accepted_version      = current TOS_VERSION
--   --   privacy_accepted_version  = current PRIVACY_VERSION
--
-- VQ.D.3 — The A1 test (load-bearing per Jose's smoke doc).
--   After the test redeem completes, log the test user IN from a fresh
--   browser session. Expected: NO first-login ToS/Privacy modal fires.
--   The predicate at app/login/page.tsx:301-303 evaluates all three
--   read columns as truthy + current, so `needsConsent = false`.
--
-- VQ.D.4 — Historical row backward-compat sanity.
--   SELECT document_type, count(*) FROM tos_acceptances
--   GROUP BY document_type ORDER BY document_type;
--   -- Expected: existing 'tos_and_privacy' counts unchanged from
--   -- pre-Commit-2 baseline; historical rows are still legitimate
--   -- consent (Surprise-B lock). Only NEW redeems land the two-row
--   -- shape.


-- ── VQ.E — Rollback smoke (only if needed):
--   \i migrations/20260630_redeem_texas_attestation.sql
-- Restores the previous redeem_proposal_code body (single
-- tos_and_privacy row + no user_roles stamp). Whitelist + version_match
-- CHECKs from 20260707_b118_layer2_saas_schema.sql accept both shapes
-- (5-value whitelist includes 'tos_and_privacy'; 5-branch
-- version_match includes the tos_and_privacy branch), so rollback is
-- schema-safe.
