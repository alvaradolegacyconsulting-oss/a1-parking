-- B220 — verification queries for pm_plate_lookup stage-2.5 add.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (function body LIKE old shape;
--      NOT LIKE 'guest_authorizations')
--   2. Apply 20260626_b220_pm_plate_lookup_guest_auth_stage.sql
--   3. Sections B, C, D post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: body invariants — NEW stage 2.5 query present + return shape
--     additions present + role-gate predicate unchanged
--   - C: grants — authenticated only / no anon / no PUBLIC (catches
--     CREATE OR REPLACE default-privilege drift)
--
-- DEFERRED TO UAT (cannot be tested from SQL Editor — no JWT):
--   - Real manager call with a plate that has an active
--     guest_authorization → expect result_type='guest_authorized'
--     with populated guest_name + valid_through
--   - Real manager call with an unrelated plate → expect existing
--     result_type='unauthorized' behavior unchanged
--   - Cross-property scope: manager with property X looks up a guest
--     authorized at property Y → expect 'unauthorized' (scope honored)

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — function exists with OLD body
-- ════════════════════════════════════════════════════════════════════
-- pm_plate_lookup already exists from B70/B71. The pre-apply
-- discriminator is the absence of 'guest_authorizations' in the body.

SELECT
  proname,
  prosecdef                                                                        AS is_security_definer,
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure) NOT LIKE '%guest_authorizations%' AS body_is_pre_b220
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'pm_plate_lookup';
-- Expected PRE-APPLY:
--   is_security_definer = TRUE
--   body_is_pre_b220    = TRUE  (old body, no stage 2.5)
-- Expected POST-APPLY:
--   is_security_definer = TRUE
--   body_is_pre_b220    = FALSE (new body, stage 2.5 present)


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — body invariants (post-apply)
-- ════════════════════════════════════════════════════════════════════
-- Five booleans that should all be TRUE after the migration. Each
-- targets a CODE pattern (not a comment-only string) so a future
-- maintainer can't accidentally weaken the gate without flipping one
-- to FALSE.

SELECT
  -- Invariant 1: stage 2.5 query present (the join + predicate keywords)
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    ~* 'FROM\s+guest_authorizations'                                            AS stage_2_5_query_present,

  -- Invariant 2: NEW return-shape additions present
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    LIKE '%guest_name%'                                                         AS return_shape_has_guest_name,
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    LIKE '%valid_through%'                                                      AS return_shape_has_valid_through,

  -- Invariant 3: role gate unchanged ({manager, leasing_agent})
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    LIKE '%NOT IN (''manager'', ''leasing_agent'')%'                            AS role_gate_unchanged,

  -- Invariant 4: property-scope predicate unchanged (ILIKE ANY caller's props)
  pg_get_functiondef('public.pm_plate_lookup(text)'::regprocedure)
    LIKE '%ga.property ILIKE ANY (v_properties)%'                               AS guest_auth_property_scope_intact;
-- Expected: all 5 columns return TRUE.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — grants (authenticated only; no anon, no PUBLIC)
-- ════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves grants in most cases, but Supabase
-- default-privilege drift has bitten before
-- ([[feedback-revoke-from-anon-explicitly]]). Verify explicit.

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'pm_plate_lookup'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- D. Migration audit row present
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values
  FROM public.audit_logs
 WHERE action = 'SCHEMA_RPC_UPDATED'
   AND new_values->>'rpc' = 'pm_plate_lookup'
   AND new_values->>'migration' = '20260626_b220_pm_plate_lookup_guest_auth_stage'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row with the migration metadata in new_values.
