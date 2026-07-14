-- ════════════════════════════════════════════════════════════════════
-- VERIFY — 20260714_anon_rpc_ilike_wildcard_close.sql
-- Paste in Supabase SQL Editor AFTER the migration applies.
-- Every 'ok' column must be TRUE.
--
-- 🔴 VQs test the THREAT, not the diff. The predicate change is
--    incidental; the assertion is that wildcard args return zero rows.
--    A green VQ suite against the branch we changed instead of the
--    attack we were preventing is exactly the failure mode we're
--    closing here (see 2026-07-13 held-Commit-2 review).
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — Each of the 3 RPCs has exactly ONE overload ───────────
SELECT p.proname,
       COUNT(*) OVER (PARTITION BY p.proname) AS overload_count,
       (COUNT(*) OVER (PARTITION BY p.proname) = 1) AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'get_properties_for_visitor_select',
     'get_company_branding',
     'get_property_for_visitor'
   )
 ORDER BY p.proname;
-- Expected: 3 rows, each ok=true.

-- ── VQ.B — Each RPC's body contains lower(trim(...)), NOT ILIKE ──
-- Reads pg_get_functiondef and asserts:
--   (a) contains 'lower(trim('  — the normalization is in the body
--   (b) does NOT contain 'ILIKE' — the vulnerable predicate is gone
SELECT p.proname,
       (pg_get_functiondef(p.oid) ~* 'lower\s*\(\s*trim\s*\(')  AS has_lower_trim,
       (pg_get_functiondef(p.oid) !~* 'ILIKE')                   AS no_ilike,
       (pg_get_functiondef(p.oid) ~* 'lower\s*\(\s*trim\s*\('
        AND pg_get_functiondef(p.oid) !~* 'ILIKE')               AS ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'get_properties_for_visitor_select',
     'get_company_branding',
     'get_property_for_visitor'
   )
 ORDER BY p.proname;
-- Expected: 3 rows, each ok=true.

-- ══════════════════════════════════════════════════════════════════
-- 🔴 VQ.C — THREAT TEST: wildcard args return ZERO rows.
--    The bug: ILIKE '%' returned every row across every tenant.
--    The fix: exact-match on lower(trim(...)) returns UNKNOWN on
--    NULL / zero on a literal '%'/'_'/'%something%'.
-- ══════════════════════════════════════════════════════════════════

-- VQ.C1 — get_properties_for_visitor_select
SELECT
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select(NULL))        AS null_arg,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%'))         AS pct,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%%'))        AS pct2,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('_'))         AS underscore,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%a1%'))      AS targeted_a1,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%wrecker%')) AS targeted_wrecker,
  (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%company%')) AS targeted_company,
  (
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select(NULL))        = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%%'))        = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('_'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%a1%'))      = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%wrecker%')) = 0 AND
    (SELECT COUNT(*) FROM public.get_properties_for_visitor_select('%company%')) = 0
  ) AS ok;
-- Expected: all counts 0, ok=true.

-- VQ.C2 — get_company_branding
SELECT
  (SELECT COUNT(*) FROM public.get_company_branding(NULL))        AS null_arg,
  (SELECT COUNT(*) FROM public.get_company_branding('%'))         AS pct,
  (SELECT COUNT(*) FROM public.get_company_branding('%%'))        AS pct2,
  (SELECT COUNT(*) FROM public.get_company_branding('_'))         AS underscore,
  (SELECT COUNT(*) FROM public.get_company_branding('%a1%'))      AS targeted_a1,
  (SELECT COUNT(*) FROM public.get_company_branding('%wrecker%')) AS targeted_wrecker,
  (SELECT COUNT(*) FROM public.get_company_branding('%company%')) AS targeted_company,
  (
    (SELECT COUNT(*) FROM public.get_company_branding(NULL))        = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('%'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('%%'))        = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('_'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('%a1%'))      = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('%wrecker%')) = 0 AND
    (SELECT COUNT(*) FROM public.get_company_branding('%company%')) = 0
  ) AS ok;
-- Expected: all counts 0, ok=true.

-- VQ.C3 — get_property_for_visitor
SELECT
  (SELECT COUNT(*) FROM public.get_property_for_visitor(NULL))        AS null_arg,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('%'))         AS pct,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('%%'))        AS pct2,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('_'))         AS underscore,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('%a1%'))      AS targeted_a1,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('%miramar%')) AS targeted_miramar,
  (SELECT COUNT(*) FROM public.get_property_for_visitor('%sunset%'))  AS targeted_sunset,
  (
    (SELECT COUNT(*) FROM public.get_property_for_visitor(NULL))        = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('%'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('%%'))        = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('_'))         = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('%a1%'))      = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('%miramar%')) = 0 AND
    (SELECT COUNT(*) FROM public.get_property_for_visitor('%sunset%'))  = 0
  ) AS ok;
-- Expected: all counts 0, ok=true.

-- ══════════════════════════════════════════════════════════════════
-- VQ.D — HAPPY PATH: real names still resolve.
--    Uses Demo Company (seed) + one of its properties. Confirms
--    the fix didn't break the flow it's supposed to preserve.
-- ══════════════════════════════════════════════════════════════════

-- VQ.D1 — get_properties_for_visitor_select('Demo Company') → >0 rows
SELECT COUNT(*)                          AS demo_property_count,
       (COUNT(*) > 0)                    AS ok
  FROM public.get_properties_for_visitor_select('Demo Company');
-- Expected: > 0 (Demo Company has 3 properties per 2026-07-11 seed).

-- VQ.D2 — get_company_branding('Demo Company') → 1 row
SELECT COUNT(*)                          AS demo_branding_rows,
       (COUNT(*) = 1)                    AS ok
  FROM public.get_company_branding('Demo Company');
-- Expected: 1 row.

-- VQ.D3 — get_property_for_visitor('Sunset Ridge Apartments') → 1 row
-- (Sunset Ridge is Demo Company's first property per the demo seed
--  rename cascade shipped 2026-07-11.)
SELECT COUNT(*)                          AS sunset_row_count,
       (COUNT(*) = 1)                    AS ok
  FROM public.get_property_for_visitor('Sunset Ridge Apartments');
-- Expected: 1 row.

-- ══════════════════════════════════════════════════════════════════
-- VQ.E — Case + whitespace tolerance (the payoff of lower(trim()))
-- ══════════════════════════════════════════════════════════════════

-- Case-differing arg should still hit
SELECT COUNT(*)                          AS demo_lowercase_hits,
       (COUNT(*) > 0)                    AS ok
  FROM public.get_properties_for_visitor_select('demo company');
-- Expected: > 0 (lowercase-differing match via lower() on both sides).

-- Whitespace-differing arg should still hit
SELECT COUNT(*)                          AS demo_padded_hits,
       (COUNT(*) > 0)                    AS ok
  FROM public.get_properties_for_visitor_select('  Demo Company  ');
-- Expected: > 0 (whitespace-padding trimmed via trim() on both sides).

-- ══════════════════════════════════════════════════════════════════
-- VQ.F — ACL discipline: anon + authenticated, no PUBLIC
-- ══════════════════════════════════════════════════════════════════
SELECT routine_name,
       array_agg(grantee || '=' || privilege_type ORDER BY grantee) AS grants,
       (
         'anon=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
         AND 'authenticated=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
         AND NOT 'PUBLIC=EXECUTE'
           = ANY (array_agg(grantee || '=' || privilege_type ORDER BY grantee))
       ) AS ok
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name IN (
     'get_properties_for_visitor_select',
     'get_company_branding',
     'get_property_for_visitor'
   )
 GROUP BY routine_name
 ORDER BY routine_name;
-- Expected: 3 rows, each ok=true.

-- ══════════════════════════════════════════════════════════════════
-- 🔴 VQ.F2 — ANON HTTP THREAT TEST (run OUTSIDE Supabase SQL Editor)
-- ══════════════════════════════════════════════════════════════════
-- SQL Editor executes as postgres/service_role. The real attacker is
-- anon via PostgREST. VQ.C1/C2/C3 above prove the Postgres predicate
-- returns zero rows — but that is not the same as proving anon over
-- HTTP cannot broadside enumerate. Run these curls FROM A SHELL (not
-- the Editor). Use the NEXT_PUBLIC_SUPABASE_ANON_KEY from Vercel's
-- environment; no Authorization: Bearer header (anon calls only carry
-- apikey).
--
-- Each command asserts an EMPTY JSON array []. If any returns a
-- non-empty array, the anon HTTP path is still enumerating even
-- though the Postgres predicate looks clean — investigate before
-- shipping.
--
-- Replace <SUPABASE_URL> with the project URL (https://<ref>.supabase.co)
-- and <ANON_KEY> with the anon publishable key. Substitute in your shell.
--
--   # get_properties_for_visitor_select — wildcard threats (expect []):
--   for arg in '%' '%%' '_' '%a1%' '%wrecker%' '%company%'; do
--     echo "-- p_company=$arg"
--     curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_properties_for_visitor_select" \
--       -H "apikey: <ANON_KEY>" \
--       -H "Content-Type: application/json" \
--       -d "{\"p_company\": \"$arg\"}"
--     echo
--   done
--   # Expected: each response body is exactly []
--
--   # POSITIVE CONTROL — real company name (expect >0 rows).
--   # If anon key is wrong or route is broken, both the threat and
--   # this control return []. The control catches that false-green.
--   curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_properties_for_visitor_select" \
--     -H "apikey: <ANON_KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"p_company": "Demo Company"}'
--   # Expected: JSON array of Demo Company property rows.
--
--   # get_company_branding — same shape
--   for arg in '%' '%%' '_' '%a1%' '%wrecker%'; do
--     echo "-- p_name=$arg"
--     curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_company_branding" \
--       -H "apikey: <ANON_KEY>" \
--       -H "Content-Type: application/json" \
--       -d "{\"p_name\": \"$arg\"}"
--     echo
--   done
--   # Expected each: []
--
--   # Positive control
--   curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_company_branding" \
--     -H "apikey: <ANON_KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"p_name": "Demo Company"}'
--   # Expected: 1-row array with Demo Company branding.
--
--   # get_property_for_visitor
--   for arg in '%' '%%' '_' '%a1%' '%miramar%' '%sunset%'; do
--     echo "-- p_name=$arg"
--     curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_property_for_visitor" \
--       -H "apikey: <ANON_KEY>" \
--       -H "Content-Type: application/json" \
--       -d "{\"p_name\": \"$arg\"}"
--     echo
--   done
--   # Expected each: []
--
--   # Positive control
--   curl -sS -X POST "<SUPABASE_URL>/rest/v1/rpc/get_property_for_visitor" \
--     -H "apikey: <ANON_KEY>" \
--     -H "Content-Type: application/json" \
--     -d '{"p_name": "Sunset Ridge Apartments"}'
--   # Expected: 1-row array with Sunset Ridge.
--
-- 🔴 VQ.F2 GATE: every threat curl above must return exactly []; every
--    positive control must return a non-empty array. If any threat
--    returns rows, DO NOT close the ticket — investigate PostgREST
--    routing / SD/SI semantics / caching before merging.

-- ══════════════════════════════════════════════════════════════════
-- VQ.E2 — Realistic customer-link happy path (mixed case + padding)
-- ══════════════════════════════════════════════════════════════════
-- Regression check that ?company=a1%20wrecker%20llc-shaped URLs still
-- resolve (URL-decoded to "a1 wrecker llc" — lowercase and different
-- from the stored "A1 Wrecker LLC"). Confirms lower(trim()) both-sides
-- normalization catches the real customer-typed variance.
SELECT COUNT(*)                                                    AS demo_realistic_hits,
       (COUNT(*) > 0)                                              AS ok
  FROM public.get_properties_for_visitor_select('  demo COMPANY  ');
-- Expected: > 0 rows. Trailing whitespace + mixed case both tolerated.

-- ══════════════════════════════════════════════════════════════════
-- VQ.G — SCHEMA_ audit ledger row landed
-- ══════════════════════════════════════════════════════════════════
SELECT action,
       new_values ->> 'migration' AS migration,
       created_at,
       (action = 'SCHEMA_ANON_RPC_ILIKE_WILDCARD_CLOSED') AS ok
  FROM public.audit_logs
 WHERE action = 'SCHEMA_ANON_RPC_ILIKE_WILDCARD_CLOSED'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row, migration='20260714_anon_rpc_ilike_wildcard_close', ok=true.
