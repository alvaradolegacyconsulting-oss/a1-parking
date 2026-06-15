-- A2 BLOCK-A1 close-out — get_company_admin_emails
--
-- Closes the only A2-flagged block-A1 finding in one migration:
--
--   1. B68 CAPTURE (Dashboard-only → repo)
--      The function has lived in production for months, applied via
--      Supabase Dashboard, never captured in a repo migration. Three
--      prior migrations explicitly deferred it ("blocked behind B68",
--      "stays open for a separate sweep"):
--        • 20260526_public_grant_retrofit_named5.sql:20
--        • 20260528_b82_public_grant_retrofit_phase_2.sql:10
--        • 20260613_d2_user_roles_name_with_rpc_guard.sql:21
--      The full current body is captured verbatim in the
--      "BEFORE STATE" block below for diff auditability.
--
--   2. ANON CLOSURE (block-A1)
--      Before-state proacl:
--        {=X/postgres,postgres=X/postgres,anon=X/postgres,
--         authenticated=X/postgres,service_role=X/postgres}
--      anon=X/postgres means ANY anonymous REST RPC call against this
--      DEFINER fn returns the company_admin emails of ANY company
--      passed in target_company — PII enumeration over an unauthenticated
--      channel. Closed by REVOKE FROM PUBLIC + REVOKE FROM anon +
--      GRANT TO authenticated, per the standard B82-retrofit pattern.
--
--   3. CROSS-COMPANY AUTHENTICATED ENUMERATION (pre-flip hardening,
--      bundled per A2 every-path discipline)
--      The current body filters by `company ILIKE target_company` — a
--      caller-supplied string. After (2), an authenticated low-privilege
--      user (driver/resident/etc.) could still call the fn with another
--      company's name and read that company's admin emails. Inert today
--      at A1 (single tenant) but live the moment public signup flips.
--      Bundling avoids a second migration on the same fn later. Body
--      rewritten to IGNORE target_company and resolve the caller's
--      company server-side via an inline subquery (a verbatim copy of
--      the b155_2 get_my_company() body — see PART 1 reasoning block
--      for why we inline rather than call the helper). NULL caller-
--      company → 0 rows. Wildcard input ('%') → 0 cross-tenant rows.
--      Signature preserved (target_company text stays in the args) so
--      no UI change is required; the SupportContact component (the
--      sole app-side caller) already only passes the caller's own
--      company string, so behavior is unchanged for legitimate calls.
--
-- AUTH MODEL after this migration
--   • PUBLIC and anon CANNOT execute (REVOKE'd)
--   • authenticated CAN execute (GRANTed)
--   • Caller's view of admin emails is clamped to their own company by
--     the inline body guard — DEFINER bypass on user_roles is fine
--     because the SELECT is now scoped server-side via auth.jwt()
--   • service_role retains EXECUTE (unaffected — DB ownership default)
--
-- APPLY DISCIPLINE
--   SINGLE-PASTE SINGLE-RUN. Paste this entire file into the Supabase
--   SQL Editor and Run. Statement-by-statement apply CAN partial-state
--   the function definition + the grant block separately, which would
--   leave proacl in a transient PUBLIC-bearing form between the body
--   replace and the REVOKE/GRANT block. Don't do that. See
--   [[feedback_sql_editor_partial_apply]] — surfaced 2026-05-19 via
--   4c733d5; the boilerplate exists because we've been bitten.
--
-- RE-APPLY POSTURE
--   The 2026-06-15 first attempt rolled back: PART 1 CREATE OR REPLACE
--   failed (cause inconclusive — possibilities included get_my_company()
--   resolution edge, SQL-language cross-fn validation, owner/permission
--   surface). Production is still in the BEFORE STATE shown below. This
--   revision INLINES the caller-company lookup as a scalar subquery
--   (same semantic as get_my_company() — copies the b155_2 body verbatim)
--   so the new body has zero cross-fn dependency. If a CREATE failure
--   recurs, it is NOT a helper-resolution issue and we look elsewhere.
--   The PRE-APPLY SELECT block now also enumerates the get_my_company()
--   helper's current state so its existence/signature is part of the
--   visual eye-check.
--
-- ============================================================================
-- BEFORE STATE — captured 2026-06-14 23:56 UTC from production (Jose's pg_proc
-- read). Quoted verbatim for diff auditability. After this migration:
--
--   • The function body becomes guarded (target_company arg ignored;
--     SELECT clamped via the inline auth.jwt() → user_roles lookup)
--   • proacl drops anon=X and PUBLIC=X (the leading `=X/postgres`)
--   • search_path moves from 'public' alone to 'public, pg_temp'
--     (defensive — matches B182 + D2 standing pattern)
--
-- ----- pg_get_functiondef() output, verbatim -----
--   CREATE OR REPLACE FUNCTION public.get_company_admin_emails(target_company text)
--    RETURNS TABLE(email text)
--    LANGUAGE sql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     SELECT email
--     FROM user_roles
--     WHERE role = 'company_admin'
--       AND company ILIKE target_company
--     ORDER BY email;
--   $function$
--
-- ----- proacl before -----
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,
--    authenticated=X/postgres,service_role=X/postgres}
-- ============================================================================

-- ── PRE-APPLY SANITY VERIFICATION (visual; informational; safe to paste) ────
-- Run before the rest. Confirms the function still exists and the proacl
-- still matches the before-state captured above. If proacl has already
-- shifted (someone else applied a retrofit out-of-band), STOP and re-audit.

SELECT '─────── PRE-APPLY: get_company_admin_emails current state ───────' AS marker;

SELECT
  p.proname                                 AS fn,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef                               AS is_definer,
  p.proconfig                               AS config,
  p.proacl::TEXT                            AS proacl_before
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'get_company_admin_emails';

-- ── PRE-APPLY: caller-company helpers (post-mortem aid) ─────────────────────
-- Enumerates get_my_company() (and siblings) so the eye-check confirms what
-- the b40/b155_2 repo migrations claim. If get_my_company() is MISSING from
-- this output, the first attempt's failure WAS helper-resolution and we
-- need to backfill that migration before any DEFINER fn referencing it can
-- ship — but this revision inlines the lookup, so it's resilient either way.

SELECT '─────── PRE-APPLY: caller-company helpers (diagnostic) ───────' AS marker;

SELECT
  p.proname                                 AS fn,
  pg_get_function_identity_arguments(p.oid) AS args,
  pg_get_function_result(p.oid)             AS returns,
  p.prosecdef                               AS is_definer,
  p.provolatile                             AS volatility,
  p.proconfig                               AS config
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('get_my_company', 'get_my_role', 'get_my_properties')
ORDER BY p.proname;
-- Expected (per b40 + b155_2): three rows, all SECURITY DEFINER STABLE,
-- args=<none>, returns=text/text[]/text. If any are missing, that's the
-- finding to file before applying.

-- ── PART 1 — CREATE OR REPLACE with body guard ──────────────────────────────
-- Signature preserved: target_company TEXT stays as the sole arg. The arg
-- is INTENTIONALLY UNUSED in the body — the SELECT clamps to the caller's
-- company resolved server-side from a user_roles lookup. SupportContact
-- (the one app-side caller) already only passes the caller's own company
-- string, so behavior is unchanged for legitimate calls.
--
-- Inline caller-company lookup (NOT a get_my_company() call):
--   The first attempt called get_my_company() and rolled back. Cause
--   inconclusive, but the helper-resolution surface is exactly what
--   makes A2-grade DEFINER fns brittle: a Dashboard-only or
--   ownership-skewed helper version can fail CREATE-time validation in
--   ways the captured-in-repo state can't predict. Inlining eliminates
--   the dependency. The inline subquery is a verbatim copy of the
--   b155_2 get_my_company() body:
--     SELECT company FROM user_roles
--     WHERE lower(email) = lower(auth.jwt() ->> 'email')
--     LIMIT 1
--   Same semantics, same NULL-safety, same case-insensitive email match.
--   If get_my_company() is later confirmed reliable in prod, this fn
--   can be refactored to call it; until then, inline is the safer
--   posture for a security-critical close-out.
--
-- Match strategy — lower()=lower(), NOT ILIKE (deliberate; do NOT restore):
--   The pre-A2 body was `company ILIKE target_company`. β cannot preserve
--   ILIKE on the RHS of the guard. ILIKE is pattern-match: % and _ are
--   wildcards. If any single user_roles row has company set to '%' (typo,
--   imported legacy data, test fixture, or an attacker writing through a
--   different surface), the inline subquery returns '%' for that caller
--   and `ur.company ILIKE '%'` matches EVERY row — all-tenant admin-email
--   enumeration via the SECURITY DEFINER fn. That's the exact cross-company
--   leak β exists to prevent, reintroduced through the guard. The "company
--   names don't contain wildcards in practice" argument is happy-path data
--   hygiene — a B155.2-class assumption β-grade guards cannot rest on. The
--   guard MUST behave literally regardless of the row contents it reads.
--
--   `lower(ur.company) = lower(<inline lookup>)` swaps the pattern-match
--   for case-insensitive equality:
--     • Case-insensitivity preserved — defensive against cross-row casing
--       drift within one company (e.g. "Demo Towing LLC" vs "demo towing
--       llc" in two rows of the same tenant). Matches the b155_2 lower-
--       match pattern used elsewhere for email comparisons.
--     • Wildcard interpretation gone — '%' on either side is now a literal
--       single-character string and only matches another '%'. A malicious
--       or legacy company='%' caller gets ZERO cross-tenant rows.
--     • NULL handling identical to ILIKE — `lower(NULL) = lower(x)` yields
--       NULL → row excluded by WHERE's three-valued logic. An authenticated
--       caller with no user_roles row (or company=NULL) gets zero results,
--       no leak.
--     • Stable. Subquery + WHERE are deterministic on the inputs; neither
--       side is user-supplied at call time (target_company is ignored;
--       the inline lookup reads pg_proc-defined state).
--
--   DO NOT "restore" the ILIKE clause if you see it later in cleanup.
--   The probe at scripts/probe-a2-get-company-admin-emails-close.ts
--   includes a wildcard-spoof case (driver with user_roles.company='%')
--   asserting 0 cross-tenant rows; restoring ILIKE makes that case fail.
--
-- Name-vs-id confirmed:
--   user_roles.company is text (a name string, not a FK to companies.id).
--   The inline lookup reads the same column. Match is name↔name — no
--   resolve step needed.
--
-- search_path:
--   `public, pg_temp` (was: 'public' alone in the captured before-state).
--   Defensive against temp-table-shadowing attacks within DEFINER context.
--   Matches the B182 + D2 standing pattern.

CREATE OR REPLACE FUNCTION public.get_company_admin_emails(target_company text)
 RETURNS TABLE(email text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO public, pg_temp
AS $function$
  -- A2 body guard. target_company preserved in signature for API stability
  -- (no UI change) but DELIBERATELY IGNORED. The caller's company is
  -- resolved server-side via the CTE below — an inline copy of the b155_2
  -- get_my_company() body to eliminate cross-fn resolution surface (see
  -- header block). A driver in company A asking for company B's admins
  -- gets zero rows; a caller with no user_roles row gets zero rows;
  -- a malicious or legacy company='%' caller gets zero cross-tenant rows.
  --
  -- The case-insensitive equality (lower=lower) is deliberate; do NOT
  -- switch to ILIKE — see the header block for the wildcard-injection
  -- reasoning. The probe asserts a wildcard-spoof case.
  WITH me AS (
    SELECT company AS caller_company
    FROM user_roles
    WHERE lower(email) = lower(auth.jwt() ->> 'email')
    LIMIT 1
  )
  SELECT ur.email
  FROM user_roles ur
  CROSS JOIN me
  WHERE ur.role = 'company_admin'
    AND lower(ur.company) = lower(me.caller_company)
  ORDER BY ur.email;
$function$;

-- ── PART 2 — GRANT discipline ───────────────────────────────────────────────
-- REVOKE-then-GRANT pattern per [[feedback_function_public_grant_supabase_default]].
-- Supabase's default GRANT pipeline does NOT override Postgres's PUBLIC-EXECUTE
-- default on new/replaced functions — REVOKE is mandatory.
--
-- We REVOKE anon explicitly even though REVOKE FROM PUBLIC removes the
-- PUBLIC grant, because Supabase has a separate explicit anon=X grant
-- in proacl (proven by the before-state: anon=X/postgres is a distinct
-- ACE from =X/postgres). Two REVOKEs cover both ACEs. Standing practice
-- per the B82 retrofit pattern.

REVOKE EXECUTE ON FUNCTION public.get_company_admin_emails(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_company_admin_emails(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_company_admin_emails(text) TO authenticated;

-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────────────
-- VQ.A — proacl shows no anon, no PUBLIC; authenticated=X present.
-- VQ.B — body contains the inline 'auth.jwt' caller-company lookup AND the
--        new 'lower(' equality form; does NOT contain the old
--        'ILIKE target_company' pattern.
-- VQ.C — search_path advanced to 'public, pg_temp'.
--
-- If any of these don't match, the migration didn't fully apply — re-paste
-- single-paste from the top.

SELECT '─────── POST-APPLY: get_company_admin_emails final state ───────' AS marker;

-- VQ.A — proacl shape check.
SELECT
  p.proname                                  AS fn,
  p.proacl::TEXT                             AS proacl_after,
  -- Convenience flags for the eye-check.
  CASE WHEN p.proacl::TEXT LIKE '%anon=X%' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END
                                             AS anon_executable,
  CASE WHEN p.proacl::TEXT ~ '(^|[,{])=X' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END
                                             AS public_executable,
  CASE WHEN p.proacl::TEXT LIKE '%authenticated=X%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS authenticated_executable
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'get_company_admin_emails';

-- Expected proacl_after:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- (anon=X and the leading =X/postgres PUBLIC ACE both gone)

-- VQ.B — body faithfulness.
-- Three checks (revised for inline-subquery body):
--   (1) inline caller-company lookup present (positive: 'auth.jwt' substring
--       — confirms the CTE/subquery that resolves the caller's company is
--       in place; this used to be a get_my_company() call before re-apply
--       inlined the lookup)
--   (2) old guard substring gone (negative: 'ILIKE target_company' substring
--       — the pre-A2 wildcard-vulnerable clamp is gone)
--   (3) new equality form present (positive: 'lower(' substring — proves the
--       lower=lower clamp landed, not a regressed ILIKE form)
SELECT
  p.proname                                  AS fn,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%auth.jwt%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_inline_caller_lookup,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%ILIKE target_company%' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END
                                             AS body_has_old_ilike_guard,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%lower(%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_new_lower_clamp
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'get_company_admin_emails';

-- VQ.C — search_path + DEFINER flag.
SELECT
  p.proname                                  AS fn,
  p.prosecdef                                AS is_definer_expect_true,
  p.proconfig                                AS config_expect_public_pg_temp
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'get_company_admin_emails';

-- VQ.D — information_schema grants (alternate view of post-apply ACL).
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_routine_grants
WHERE specific_schema = 'public'
  AND routine_name = 'get_company_admin_emails'
ORDER BY grantee;
-- Expected rows: postgres EXECUTE / authenticated EXECUTE / service_role EXECUTE.
-- No anon. No PUBLIC.
