-- ════════════════════════════════════════════════════════════════════
-- VERIFY — 20260713_tos_acceptances_company_id_derivation.sql
-- Paste in Supabase SQL Editor AFTER the migration applies.
-- Every 'ok' column must be TRUE.
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — Each RPC has exactly ONE overload ─────────────────────
SELECT p.proname,
       COUNT(*)                    AS overload_count,
       (COUNT(*) = 1)               AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'accept_signup_consents',
     'accept_tos',
     'record_resident_tos_acceptance',
     'accept_saas_agreement'
   )
 GROUP BY p.proname
 ORDER BY p.proname;
-- Expected: 4 rows, each ok=true. If any row shows overload_count > 1
-- the DROP-first didn't clear a stale signature — investigate before
-- treating this as green.

-- ── VQ.B — Each RPC is SECURITY DEFINER, LANGUAGE plpgsql ────────
SELECT p.proname,
       p.prosecdef                                                 AS is_security_definer,
       l.lanname                                                   AS language,
       (p.prosecdef = true AND l.lanname = 'plpgsql')              AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l  ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'accept_signup_consents',
     'accept_tos',
     'record_resident_tos_acceptance',
     'accept_saas_agreement'
   )
 ORDER BY p.proname;
-- Expected: 4 rows, each ok=true.

-- ── VQ.C — ACL: authenticated=EXECUTE; PUBLIC/anon NOT present ────
SELECT routine_name,
       array_agg(grantee || '=' || privilege_type ORDER BY grantee) AS grants,
       -- Expect an EXECUTE for `authenticated`. Must NOT contain `anon`
       -- or `PUBLIC`. Postgres owner (`postgres`) is always present.
       (
         'authenticated=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
         AND NOT 'anon=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
         AND NOT 'PUBLIC=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
       )                                                             AS ok
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name IN (
     'accept_signup_consents',
     'accept_tos',
     'record_resident_tos_acceptance',
     'accept_saas_agreement'
   )
 GROUP BY routine_name
 ORDER BY routine_name;
-- Expected: 4 rows, each ok=true. grants array contains
-- 'authenticated=EXECUTE' and 'postgres=EXECUTE' only.

-- ── VQ.D — SCHEMA_ audit ledger row landed ────────────────────────
SELECT action,
       new_values ->> 'migration' AS migration,
       created_at,
       (action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_DERIVATION')     AS ok
  FROM public.audit_logs
 WHERE action = 'SCHEMA_TOS_ACCEPTANCES_COMPANY_ID_DERIVATION'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row, migration='20260713_tos_acceptances_company_id_derivation', ok=true.

-- ── VQ.E — LIVE SMOKE — the SaaS user_id landmine is dead ─────────
-- Purpose: pre-fix accept_saas_agreement UPDATE at line 275-277 was
-- keyed WHERE user_id = v_uid on user_roles. user_roles has no user_id
-- column (Jose 2026-07-13 information_schema check). Post-fix keys by
-- lower(email). This smoke drives A1's CA through the SaaS re-consent
-- path to prove the RPC no longer throws 42703.
--
-- 🔴 RUN AS A1's CA (authenticated JWT). Substitute the current
-- SAAS_VERSION at HEAD (app/lib/legal-versions.ts). Wrap in a
-- BEGIN/ROLLBACK if you want to leave no trace.
--
--   BEGIN;
--   SELECT public.accept_saas_agreement(
--     p_saas_version := '2026-07-10-v1',
--     p_reviewed_at  := now(),
--     p_ip_address   := NULL::inet,
--     p_user_agent   := NULL::text
--   );
--   -- Expected: no error. A row lands in tos_acceptances with
--   -- document_type='saas', company_id = 91 (A1's id).
--   SELECT id, user_id, company_id, document_type, saas_version, reviewed_at
--     FROM public.tos_acceptances
--    WHERE document_type = 'saas'
--      AND user_id = auth.uid()
--    ORDER BY id DESC LIMIT 1;
--   -- Expected: company_id = 91 (or A1's actual companies.id).
--   ROLLBACK;

-- ── VQ.F — 4 RPCs no longer omit company_id from their INSERTs ────
-- Reads each function definition and confirms the substring
-- 'company_id' appears at least twice per RPC body — once in the
-- derivation SELECT, once (or more) in the INSERT column list.
SELECT p.proname,
       (position('company_id' in pg_get_functiondef(p.oid)) > 0)     AS has_company_id_ref,
       (
         array_length(
           regexp_split_to_array(pg_get_functiondef(p.oid), 'company_id'),
           1
         ) >= 3   -- occurrences = matches + 1; 3 = 2 refs minimum
       )                                                             AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'accept_signup_consents',
     'accept_tos',
     'record_resident_tos_acceptance',
     'accept_saas_agreement'
   )
 ORDER BY p.proname;
-- Expected: 4 rows, each ok=true (all 4 RPCs now reference company_id
-- in derivation + at least one INSERT).

-- ── VQ.G — accept_saas_agreement UPDATE keying is fixed ──────────
-- Post-fix must reference `email` in the UPDATE. Pre-fix referenced
-- the nonexistent `user_id` column. Uses pg_get_functiondef.
SELECT p.proname,
       (
         pg_get_functiondef(p.oid) ~* 'UPDATE\s+user_roles\s+SET\s+saas_accepted_version\s+=\s+COALESCE'
         AND pg_get_functiondef(p.oid) ~* 'WHERE\s+lower\s*\(\s*email\s*\)'
       )                                                             AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'accept_saas_agreement';
-- Expected: 1 row, ok=true. If false, the UPDATE keying wasn't
-- rewritten and the landmine is still live.
