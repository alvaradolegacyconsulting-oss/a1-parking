-- ════════════════════════════════════════════════════════════════════
-- CONSOLIDATED CATALOG READ — 2026-09-18
-- Unblocks four items that are all waiting on the same SQL editor pass.
-- ════════════════════════════════════════════════════════════════════
--
-- 🟢 100% READ-ONLY. No DDL, no DML, no transaction block. Every block
-- is a bare SELECT. Safe to run in any order, any number of times, on
-- production, mid-registration.
--
-- WHY ONE FILE: blocks A–E each unblock a different stalled item. The
-- editor has been the bottleneck for all four; this makes it one sitting.
--
-- HOW TO RUN: the Supabase editor shows the result of the LAST
-- row-returning statement only. Run each lettered block SEPARATELY —
-- select the block, hit Run, copy the grid, move on. Running the whole
-- file at once shows you block E and silently discards A–D.
--
-- NO PLACEHOLDERS. Every value below is hardcoded. An unfilled
-- placeholder in a diagnostic does not error, it returns a
-- plausible-looking NULL, which is worse than a failure.
--
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
-- BLOCK A — C1′ blocker: every policy on `drivers`
-- ════════════════════════════════════════════════════════════════════
-- What this decides: whether the client-side `.ilike('email', …)` at
-- app/driver/page.tsx:445 can be DELETED. It can only be deleted if RLS
-- alone already restricts a driver's SELECT to their own row.
--
-- Read the `using_expr` column. Look for:
--   • a policy whose predicate contains `~~*` → still ILIKE, Tier 3
--   • a policy with `{public}` in roles    → reachable pre-auth
--   • any PERMISSIVE policy broader than own-row → the filter is NOT
--     redundant and must NOT be deleted
-- Four of six policies audited last month existed in NO migration file.
-- This is the authoritative list; the repo is not.

SELECT
  pol.polname                                   AS policy_name,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                  WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                  WHEN '*' THEN 'ALL'  END      AS command,
  CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS kind,
  COALESCE(
    (SELECT array_agg(r.rolname ORDER BY r.rolname)
       FROM pg_roles r WHERE r.oid = ANY(pol.polroles)),
    ARRAY['PUBLIC']
  )                                             AS roles,
  pg_get_expr(pol.polqual,      pol.polrelid)   AS using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid)   AS with_check_expr,
  (pg_get_expr(pol.polqual, pol.polrelid) LIKE '%~~*%') AS still_uses_ilike
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'drivers'
ORDER BY pol.polcmd, pol.polname;


-- ════════════════════════════════════════════════════════════════════
-- BLOCK B — the severity question: every policy on `violations`
-- ════════════════════════════════════════════════════════════════════
-- What this decides: whether the driver-portal fail-open is an
-- over-share WITHIN one company (bad, latent) or ACROSS companies
-- (cross-tenant disclosure, different item entirely).
--
-- Context for reading it: the client query at app/driver/page.tsx:592
-- applies NO property filter when assigned_properties contains 'All'.
-- Whatever RLS does here is therefore the ONLY remaining scope.
--
-- Blast radius if RLS does not company-scope it — 95 confirmed
-- violations live across THREE companies right now:
--     46  A1 Wrecker llc
--     30  Demo Company
--     19  Test-LEGACY
-- So a driver with the 'All' sentinel would receive all 95, not 46.
--
-- Look for a driver-reachable SELECT policy and check whether its
-- predicate reaches company at all — via get_my_company(), via a
-- properties join, or not at all.

SELECT
  pol.polname                                   AS policy_name,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                  WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                  WHEN '*' THEN 'ALL'  END      AS command,
  CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS kind,
  COALESCE(
    (SELECT array_agg(r.rolname ORDER BY r.rolname)
       FROM pg_roles r WHERE r.oid = ANY(pol.polroles)),
    ARRAY['PUBLIC']
  )                                             AS roles,
  pg_get_expr(pol.polqual, pol.polrelid)        AS using_expr,
  -- Does the predicate constrain by company AT ALL? A false here on the
  -- driver-reachable SELECT policy is the cross-tenant answer.
  (pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%company%') AS mentions_company,
  (pg_get_expr(pol.polqual, pol.polrelid) LIKE  '%~~*%')     AS still_uses_ilike
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'violations'
ORDER BY pol.polcmd, pol.polname;


-- ════════════════════════════════════════════════════════════════════
-- BLOCK C — C4 detection: any email holding more than one role row
-- ════════════════════════════════════════════════════════════════════
-- Why this matters: get_my_role(), get_my_company() and
-- get_my_properties() are all `… WHERE email … LIMIT 1` with NO
-- ORDER BY. With two rows for one email, which one answers is
-- arbitrary, and every scoped policy in the system reads through them.
--
-- Expected result TODAY: zero rows. That is the answer we want, and the
-- point of running it is that it keeps being zero.
--
-- 🔴 If this EVER returns a row, that person's role resolution is a coin
-- flip. Treat it as same-day, not as a backlog item.
--
-- Re-run cadence: worth a look after any week with heavy /register
-- traffic, since the /register:310 fallback is the mechanism that would
-- produce one.

SELECT
  lower(trim(email))                    AS email_key,
  count(*)                              AS role_row_count,
  array_agg(role     ORDER BY id)       AS roles,
  array_agg(company  ORDER BY id)       AS companies,
  array_agg(id       ORDER BY id)       AS row_ids
FROM public.user_roles
WHERE email IS NOT NULL AND trim(email) <> ''
GROUP BY lower(trim(email))
HAVING count(*) > 1
ORDER BY count(*) DESC, email_key;


-- ════════════════════════════════════════════════════════════════════
-- BLOCK D — C2: do the two plate indexes exist, and on what expression
-- ════════════════════════════════════════════════════════════════════
-- These may ALREADY exist from 20260917_ca_plate_activity.sql, which
-- created visitor_passes_property_plate_norm and
-- violations_property_plate_norm.
--
-- 🔴 Existence is not the question — the EXPRESSION is. The index only
-- gets used if its expression matches the query's expression character
-- for character. Both were written as
--     (property, UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')))
-- copied from the trigger so one index serves both call sites. If
-- indexdef below shows a different normalization than the trigger uses,
-- the index exists and is dead weight.
--
-- Compare the indexdef output against the trigger bodies in Block E.

SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('violations', 'visitor_passes', 'vehicles')
ORDER BY tablename, indexname;


-- ════════════════════════════════════════════════════════════════════
-- BLOCK E — do the live function bodies match what the repo claims
-- ════════════════════════════════════════════════════════════════════
-- Three separate questions in one grid:
--
--  1. PLATE NORMALIZATION DIVERGENCE. Three spellings are known to
--     exist — normalize_plate() (whitespace-only, and it is what backs
--     vehicles_plate_norm_uniq), the aggressive [^A-Za-z0-9] triggers,
--     and [^A-Z0-9]/'gi' in enforce_visitor_pass_limit. Read the bodies
--     and confirm which is which before trusting any index in Block D.
--
--  2. THE LIMIT 1 / NO ORDER BY HELPERS. get_my_role, get_my_company,
--     get_my_properties. Block C says duplicates do not exist yet; this
--     says what happens on the day one does. Confirm the `LIMIT 1`
--     with no ORDER BY is really there before filing the determinism
--     epic against it.
--
--  3. OVERLOADS. Two live signatures for one function name is the
--     PGRST203 landmine that already bit record_vehicle_removal. Any
--     name appearing twice below needs a look.
--
-- `prosecdef` = SECURITY DEFINER. `proacl IS NULL` means EXECUTE was
-- never revoked from PUBLIC and the Supabase default grant still stands.

SELECT
  p.proname                                     AS function_name,
  pg_get_function_identity_arguments(p.oid)     AS args,
  p.prosecdef                                   AS security_definer,
  COALESCE(array_to_string(p.proconfig, ', '), '(no search_path pin)') AS config,
  CASE WHEN p.proacl IS NULL
       THEN 'DEFAULT (PUBLIC still has EXECUTE)'
       ELSE array_to_string(p.proacl::text[], ' | ')
  END                                           AS grants,
  count(*) OVER (PARTITION BY p.proname)        AS signatures_with_this_name,
  pg_get_functiondef(p.oid)                     AS full_body
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'normalize_plate',
    'enforce_visitor_pass_limit',
    'get_my_role',
    'get_my_company',
    'get_my_properties',
    'insert_user_role',
    'record_vehicle_removal',
    'ca_plate_activity',
    'driver_plate_lookup'
  )
ORDER BY p.proname, args;
