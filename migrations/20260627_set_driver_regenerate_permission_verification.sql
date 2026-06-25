-- Layer 3 — verification queries for set_driver_regenerate_permission.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (RPC absent)
--   2. Apply 20260627_set_driver_regenerate_permission.sql
--   3. Sections B–G post-apply
--
-- LOAD-BEARING SECTIONS:
--   - C: grants — authenticated only / no anon / no PUBLIC
--   - D: auth gate — SQL Editor unauthenticated call → unauthenticated
--   - E: body-content invariants — driver-to-CA ILIKE scope present,
--     role='driver' check present, audit-row INSERT present,
--     DRIVER_REGENERATE_PERMISSION_CHANGED action name present
--   - G: B155.2 backstop intact — the SPLIT user_roles RLS policies
--     (company_admin_insert_users + _update_users) unchanged. Both
--     must have the role-enum WITH CHECK constraint enforcing
--     role ∈ ('manager','leasing_agent','driver','resident')
--     (the CA→admin escalation guard from B155.2's split).
--     This RPC is additive, NOT a substitute for the RLS path.
--
-- DEFERRED TO UAT (cannot test from SQL Editor — no JWT):
--   - Real CA call grants/revokes a real driver in same company
--   - CA tries to grant a driver in DIFFERENT company → driver_out_of_scope
--   - CA tries to grant a manager → not_a_driver
--   - Driver tries to call the RPC → role_not_authorized

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — RPC absent
-- ════════════════════════════════════════════════════════════════════

SELECT EXISTS (
  SELECT 1 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'set_driver_regenerate_permission'
) AS rpc_exists;
-- Expected PRE-APPLY:  rpc_exists = FALSE
-- Expected POST-APPLY: rpc_exists = TRUE


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — schema metadata
-- ════════════════════════════════════════════════════════════════════

SELECT
  proname,
  prosecdef                    AS is_security_definer,
  pg_get_function_result(oid)  AS returns_type,
  pg_get_function_arguments(oid) AS arg_signature
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'set_driver_regenerate_permission';
-- Expected 1 row:
--   is_security_definer = TRUE
--   returns_type        = jsonb
--   arg_signature       = p_driver_email text, p_allowed boolean


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants (authenticated only; no anon, no PUBLIC)
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'set_driver_regenerate_permission'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — auth gate (SQL Editor has no JWT → unauthenticated)
-- ════════════════════════════════════════════════════════════════════

SELECT public.set_driver_regenerate_permission('any@example.com', TRUE) AS rpc_result;
-- Expected: jsonb_build_object('error', 'unauthenticated')
-- SQL Editor sends no JWT; auth gate fires before role / scope / target
-- lookup. The deferred-to-UAT smoke covers the real role gate end-to-end.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — body-content invariants
-- ════════════════════════════════════════════════════════════════════
-- Four code-pattern booleans — all must be TRUE post-apply.
-- pg_get_functiondef returns the function body only (no surrounding
-- file docstring). Patterns grep the actual SQL inside AS $func$ ... $$.

SELECT
  -- E.1 Driver-to-CA company scope predicate (NOT Layer 1's
  --     properties-join shape; this is the user_roles-to-user_roles
  --     ILIKE described in the docstring)
  pg_get_functiondef('public.set_driver_regenerate_permission(text, boolean)'::regprocedure)
    ~* 'v_driver_company\s+~~\*\s+v_caller_company'                       AS scope_predicate_ilike,

  -- E.2 not_a_driver validation (target must be role='driver')
  pg_get_functiondef('public.set_driver_regenerate_permission(text, boolean)'::regprocedure)
    LIKE '%not_a_driver%'                                                   AS not_a_driver_gate_present,

  -- E.3 Audit INSERT with the correct action name
  pg_get_functiondef('public.set_driver_regenerate_permission(text, boolean)'::regprocedure)
    LIKE '%DRIVER_REGENERATE_PERMISSION_CHANGED%'                           AS audit_action_present,

  -- E.4 Single-column update — confirm the SET clause touches ONLY
  --     can_regenerate_tow_ticket (narrows the surface vs. direct
  --     UPDATE through RLS). Loose match on the keyword pair.
  pg_get_functiondef('public.set_driver_regenerate_permission(text, boolean)'::regprocedure)
    ~* 'SET\s+can_regenerate_tow_ticket\s*=\s*p_allowed'                    AS single_column_update;
-- Expected: all 4 columns return TRUE.


-- ════════════════════════════════════════════════════════════════════
-- F. Migration audit row present
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values
  FROM public.audit_logs
 WHERE action = 'SCHEMA_RPC_ADDED'
   AND new_values->>'rpc' = 'set_driver_regenerate_permission'
   AND new_values->>'migration' = '20260627_set_driver_regenerate_permission'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row with the migration metadata in new_values.


-- ════════════════════════════════════════════════════════════════════
-- G. ★ LOAD-BEARING — B155.2 split-policy backstop intact
-- ════════════════════════════════════════════════════════════════════
-- This RPC is ADDITIVE — it does not replace or weaken the existing
-- user_roles RLS policies. B155.2 (2026-06-10) DROPPED the combined
-- `company_admin_own_users` FOR ALL policy and replaced it with three
-- command-specific policies:
--   - company_admin_select_users  (FOR SELECT) — own-company filter
--   - company_admin_insert_users  (FOR INSERT) — own-company + role enum
--   - company_admin_update_users  (FOR UPDATE) — own-company + role enum
--
-- The role-enum WITH CHECK constraint enforcing
--   role IN ('manager','leasing_agent','driver','resident')
-- lives on _insert_users AND _update_users — these are the CA→admin
-- escalation guards. If a future maintainer drops or weakens either
-- thinking "the regenerate RPC handles its own auth," they'd open
-- the role-escalation path back up. Verify BOTH policies are present
-- with the role-enum constraint intact.
--
-- HISTORICAL NOTE: An earlier version of this Section G targeted
-- `company_admin_own_users` — the pre-B155.2 combined name. That
-- policy was DROPPED in B155.2; querying for it returned no rows,
-- which made the EXISTS check return FALSE and look like a
-- regression. Fixed 2026-06-27 to target the actual post-B155.2
-- policy names.

-- G.1 — raw inspection for eyeball context
SELECT
  polname                              AS policy_name,
  polcmd                               AS cmd,
  pg_get_expr(polqual,    polrelid)    AS using_expr,
  pg_get_expr(polwithcheck, polrelid)  AS with_check_expr
FROM pg_policy
WHERE polrelid = 'public.user_roles'::regclass
  AND polname IN ('company_admin_insert_users', 'company_admin_update_users')
ORDER BY polname;
-- Expected: 2 rows.
--   company_admin_insert_users | a (INSERT) | NULL using | WITH CHECK
--     contains: get_my_role() / company ~~* / role ∈ enum
--   company_admin_update_users | w (UPDATE) | USING + WITH CHECK both
--     contain the company + role-enum constraints

-- G.2 — boolean assertion: BOTH split policies have the role-enum
-- WITH CHECK + the company ~~* scope predicate. Content-check by
-- role-string presence rather than exact regex form (covers both
-- `IN (...)` and `= ANY (ARRAY[...])` deparser variants).
WITH policy_check AS (
  SELECT
    polname,
    pg_get_expr(polwithcheck, polrelid) AS wc
  FROM pg_policy
  WHERE polrelid = 'public.user_roles'::regclass
    AND polname IN ('company_admin_insert_users', 'company_admin_update_users')
)
SELECT
  -- Both policies exist
  (SELECT COUNT(*) FROM policy_check) = 2 AS both_policies_present,
  -- Both have non-null WITH CHECK
  (SELECT bool_and(wc IS NOT NULL) FROM policy_check) AS both_have_with_check,
  -- Both contain all 4 allowed role values
  (SELECT bool_and(wc ~* 'manager' AND wc ~* 'leasing_agent'
                   AND wc ~* 'driver' AND wc ~* 'resident')
     FROM policy_check) AS both_have_role_enum,
  -- Both contain the company ~~* (ILIKE) scope predicate
  (SELECT bool_and(wc ~* 'company\s*~~\*') FROM policy_check) AS both_have_company_scope,
  -- Single load-bearing summary (TRUE iff all 4 above are TRUE)
  (SELECT COUNT(*) FROM policy_check) = 2
    AND (SELECT bool_and(wc IS NOT NULL
                         AND wc ~* 'manager' AND wc ~* 'leasing_agent'
                         AND wc ~* 'driver' AND wc ~* 'resident'
                         AND wc ~* 'company\s*~~\*')
           FROM policy_check)            AS b155_2_split_backstop_intact;
-- Expected: all 5 columns return TRUE.
-- If b155_2_split_backstop_intact = FALSE, eyeball G.1's raw output
-- to see which policy / which sub-check failed.
