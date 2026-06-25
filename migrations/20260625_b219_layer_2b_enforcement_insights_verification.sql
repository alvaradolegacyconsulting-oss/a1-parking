-- B219 Layer 2b — verification queries.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (RPC absent gate)
--   2. Apply 20260625_b219_layer_2b_enforcement_insights.sql
--   3. Run Sections B, C, D, E, F, G post-apply
--   4. After UAT flag-seed applied (separate file), Sections F + the
--      separate seed verification confirm flags fire as expected
--
-- LOAD-BEARING SECTIONS:
--   - C (grants): authenticated only / no anon / no PUBLIC. Catches
--     Supabase default-privilege drift.
--   - D (auth gate): SQL Editor caller has no JWT → returns
--     {error: 'unauthenticated'}. Same shape as Layer 1 Section E.
--
-- DEFERRED TO UAT (cannot be tested from SQL Editor):
--   - Real CA call → expect a populated jsonb with summary +
--     status_pipeline + … (impossible without a JWT)
--   - Cross-company denial (impossible without a real second-company CA)
--   - Role gate negative (real driver session → 'role_not_authorized')
--   - Flags firing on seeded data
--   See B219 Layer 1 Section E docstring for the role-gate
--   byte-identical-to-set_violation_status argument.

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — RPC absent
-- ════════════════════════════════════════════════════════════════════

SELECT proname, prosecdef
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'get_enforcement_insights';
-- Expected PRE-APPLY: 0 rows.
-- Expected POST-APPLY: 1 row, prosecdef=TRUE.


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — RPC metadata
-- ════════════════════════════════════════════════════════════════════

SELECT
  proname,
  prosecdef                  AS is_security_definer,
  provolatile                AS volatility,   -- 's' = STABLE
  pg_get_userbyid(proowner)  AS owner,
  proconfig                  AS config
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'get_enforcement_insights';
-- Expected: 1 row.
--   is_security_definer = TRUE
--   volatility          = 's'  (STABLE — read-only marker)
--   owner               = postgres (or supabase_admin)
--   config              includes 'search_path=public, pg_temp'


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants (authenticated only; no anon, no PUBLIC)
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'get_enforcement_insights'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.
-- Catches Supabase default-privilege drift (see
-- [[feedback-revoke-from-anon-explicitly]]).


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — auth gate (SQL Editor has no JWT)
-- ════════════════════════════════════════════════════════════════════
-- The SQL Editor caller has no JWT → auth.jwt() returns NULL →
-- the RPC's first guard fires before any role / scope / data work.
--
-- This PROVES: unauthenticated callers can't reach the data.
-- This DOES NOT PROVE: the role gate or company-scope predicate.
-- Both are deferred to UAT — the role gate's byte-identical-to-
-- set_violation_status argument (Layer 1 Section E) covers them
-- by code-review for tonight.

SELECT public.get_enforcement_insights() AS rpc_result;
-- Expected: jsonb_build_object('error', 'unauthenticated')
-- (NOT 'no_role_assigned' / not 'no_properties_in_scope' /
-- not a populated payload — the auth gate fires first.)


-- ════════════════════════════════════════════════════════════════════
-- E. RPC signature — 3-arg form present
-- ════════════════════════════════════════════════════════════════════

SELECT
  proname,
  pronargs                                                AS arg_count,
  pg_get_function_arguments(oid)                          AS arg_signature,
  pg_get_function_result(oid)                             AS return_type
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'get_enforcement_insights';
-- Expected: 1 row.
--   arg_count       = 3
--   arg_signature   = 'p_property text DEFAULT NULL::text,
--                      p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone,
--                      p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone'
--   return_type     = 'jsonb'


-- ════════════════════════════════════════════════════════════════════
-- F. Body-content invariants (grep-equivalents via pg_get_functiondef)
-- ════════════════════════════════════════════════════════════════════
-- Spot-check that the body includes the invariant predicates so a
-- future "drift" doesn't pass A–E without anyone noticing.

SELECT
  -- Invariant 1: company-scope uses ~~* (ILIKE) on properties.company
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%company ~~* v_caller_company%'                          AS company_predicate_ilike,

  -- Invariant 2: role gate hardcoded to company_admin
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%v_caller_role != ''company_admin''%'                    AS role_gate_company_admin,

  -- Invariant 3: void precedence (status counts exclude voided)
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%voided_at IS NULL AND status = ''new''%'                AS void_excluded_from_status,

  -- Invariant 4: stuck-tow uses COALESCE(status_changed_at, created_at)
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    LIKE '%COALESCE(status_changed_at, created_at)%'               AS stuck_tow_coalesce,

  -- Invariant 5: dispute source = status='disputed' (NOT dispute_requests)
  pg_get_functiondef('public.get_enforcement_insights(text, timestamptz, timestamptz)'::regprocedure)
    NOT LIKE '%dispute_requests%'                                  AS no_dispute_requests_ref;
-- Expected: all 5 columns return TRUE.


-- ════════════════════════════════════════════════════════════════════
-- G. Audit row recording the RPC ship
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values
  FROM public.audit_logs
 WHERE action = 'SCHEMA_RPC_ADDED'
   AND new_values->>'rpc' = 'get_enforcement_insights'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row, recent created_at, new_values includes rpc +
-- migration + role_gate ('company_admin') + read_only TRUE +
-- flag_count 6 + widget_count 6.
