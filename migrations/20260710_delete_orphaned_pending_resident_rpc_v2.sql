-- ════════════════════════════════════════════════════════════════════
-- delete_orphaned_pending_resident — v2 patch
-- 2026-07-10 · Silent-write triage Commit 1 · patch on top of v1
--
-- WHY THIS PATCH
--   v1 (migrations/20260710_delete_orphaned_pending_resident_rpc.sql)
--   deliberately omitted a `NOT EXISTS auth.users` guard on the DELETE
--   and treated p_property as a manager-only concept (dead code for
--   CA + admin). Per Jose's 2026-07-10 greenlight two adjustments:
--
--     1. HONOR p_property AS AN OPTIONAL NARROWER FILTER for CA + admin
--        (Option A from the report). Manager path unchanged — still
--        RAISEs `manager_scope_required` on NULL. CA/admin gain a
--        (p_property IS NULL OR lower(property) = lower(trim(...)))
--        clause so their rollbacks can be property-precise when the
--        caller knows the property (the CA add-user form does), and
--        default to the wider role-scope when they don't.
--
--     2. ADD A `NOT EXISTS auth.users` GUARD to all three branches,
--        INSIDE the same atomic DELETE ... WHERE. Prevents any
--        accidental nuke of a residents row that's linked to a live
--        auth account. Defensive posture: if the auth user still
--        exists, the residents row is not orphaned by definition — the
--        rollback path should not fire in that state, and if it does
--        (bug elsewhere), this guard blocks the damage.
--
--     Guard notes:
--       • auth.users is in the `auth` schema; SECURITY DEFINER
--         functions owned by postgres can SELECT from it (Supabase
--         default). Same pattern as any DEFINER helper that touches
--         auth.users.
--       • The check is uncorrelated (uses v_norm_email, not the outer
--         residents.email column), so PG can plan it as a scalar
--         subquery. Cost is one indexed lookup on auth.users(email).
--       • Deactivated auth users still have a row → NOT EXISTS is
--         FALSE → guard blocks the delete. That's intentional; admin
--         cleanup of a deactivated resident needs to remove the auth
--         user first, then call this RPC.
--
-- SHAPE
--   CREATE OR REPLACE FUNCTION — same signature, same permissions.
--   No REVOKE/GRANT changes (envelope already correct from v1).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_orphaned_pending_resident(
  p_email    TEXT,
  p_property TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_norm_email     TEXT;
  v_count          INTEGER;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  v_caller_role := public.get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'company_admin', 'manager') THEN
    RAISE EXCEPTION 'role_not_authorized'
      USING HINT = 'Only admin, company_admin, or manager can invoke rollback cleanup.';
  END IF;

  v_norm_email := lower(trim(coalesce(p_email, '')));
  IF v_norm_email = '' THEN
    RAISE EXCEPTION 'invalid_email'
      USING HINT = 'p_email must be a non-empty string.';
  END IF;

  IF v_caller_role = 'manager' THEN
    IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
      RAISE EXCEPTION 'manager_scope_required'
        USING HINT = 'Manager callers must pass p_property to scope the delete.';
    END IF;
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND lower(property) = lower(trim(p_property))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
         WHERE lower(email) = v_norm_email
       );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := public.get_my_company();
    IF v_caller_company IS NULL OR length(trim(v_caller_company)) = 0 THEN
      RAISE EXCEPTION 'no_company_scope'
        USING HINT = 'Your session is missing a company scope. Refresh and try again.';
    END IF;
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND lower(company) = lower(v_caller_company)
       AND (p_property IS NULL OR lower(property) = lower(trim(p_property)))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
         WHERE lower(email) = v_norm_email
       );
  ELSE
    -- admin: role-unscoped, but p_property still an optional narrower
    -- filter + auth-user existence guard still applies.
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND (p_property IS NULL OR lower(property) = lower(trim(p_property)))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
         WHERE lower(email) = v_norm_email
       );
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'ROLLBACK_DELETE_RESIDENT',
    'residents',
    NULL,
    jsonb_build_object(
      'email',        v_norm_email,
      'property',     p_property,
      'role',         v_caller_role,
      'rows_deleted', v_count,
      'source',       'delete_orphaned_pending_resident_v2'
    ),
    now()
  );

  RETURN v_count;
END
$func$;

-- Permissions envelope idempotent (no-op if v1 already granted).
REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_PATCHED',
  'residents',
  NULL,
  jsonb_build_object(
    'migration', '20260710_delete_orphaned_pending_resident_rpc_v2',
    'rpc',       'delete_orphaned_pending_resident',
    'patch_of',  '20260710_delete_orphaned_pending_resident_rpc',
    'change',    'Two adjustments: (1) p_property honored as optional narrower filter on CA + admin branches (was dead code); (2) NOT EXISTS auth.users guard added INSIDE the same atomic DELETE for all three role branches (defensive posture — never nuke a residents row linked to a live auth account). Manager branch predicate unchanged aside from the auth-guard addition.',
    'rationale', 'Silent-write triage 2026-07-10 · post-report iteration. CA rollback now property-precise (matches manager pattern) and CA + admin can no longer collateral-damage a live resident''s row.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists + SD + args (unchanged signature)
--   SELECT proname, prosecdef AS is_security_definer,
--          pg_get_function_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'delete_orphaned_pending_resident';
--   -- Expected: 1 row, sd=true, args='p_email text, p_property text DEFAULT NULL::text'.
--
-- VQ.B — Body contains the new predicates
--   SELECT pg_get_functiondef(oid) AS body
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'delete_orphaned_pending_resident';
--   -- Grep expected fragments in the returned body:
--   --   'NOT EXISTS (' followed by 'FROM auth.users'     (guard present)
--   --   'p_property IS NULL OR lower(property)'          (Option A filter)
--
-- VQ.C — Grants unchanged (envelope re-applied idempotently)
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'delete_orphaned_pending_resident';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.D — Patch audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_delete_orphaned_pending_resident_rpc_v2'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════
