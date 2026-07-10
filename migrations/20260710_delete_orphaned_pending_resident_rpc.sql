-- ════════════════════════════════════════════════════════════════════
-- delete_orphaned_pending_resident — DEFINER RPC for rollback cleanup
-- 2026-07-10 · Silent-write triage Commit 1b + 1c
--
-- WHY
--   Two client-side rollback DELETEs on residents (both in error
--   branches of add-user flows) were silently 0-rowing:
--     • company_admin/page.tsx:1624 — .delete().ilike('email', targetEmail)
--     • manager/page.tsx:2055       — .delete().ilike('email',…).ilike('property',…)
--   pg_policies map: residents has _admin_all (ALL, admin), but NO
--   DELETE policy for company_admin or manager. Both rollbacks left
--   orphan residents rows every time. Debris that would bite the
--   pre-launch wipe and any bulk-invite flow.
--
--   Bonus: the CA rollback used email-alone (no company filter) — a
--   cross-tenant risk if two companies ever created the same email as
--   a resident. This RPC's server-side company scope for CA callers
--   fixes the cross-tenant bug at the same time.
--
-- SCOPE — role-derived, server-enforced
--   • Manager caller: must pass p_property; DELETE limited to
--     lower(email)=email AND lower(property)=lower(p_property).
--     (Manager can only rollback residents at their own property; the
--     property-scope RLS on the manager's SELECTs already prevents
--     them from targeting other properties, but the DEFINER RPC needs
--     its own predicate since RLS is bypassed.)
--   • CA caller: DELETE limited to email AND company = get_my_company().
--     Closes the cross-tenant hole in the prior code.
--   • Admin caller: no additional scope (admin is expected to know what
--     they're doing).
--
-- SHAPE
--   • SECURITY DEFINER, search_path pinned.
--   • Role gate: {admin, company_admin, manager}.
--   • Returns rows-deleted count (INTEGER). 0 is a valid outcome
--     ("nothing to clean up") — does NOT raise on 0, unlike the profile
--     RPC. This is a cleanup path, not a user-triggered mutation.
--   • Emits an audit row per invocation with rows_deleted count so
--     forensic traces are always available.
--   • REVOKE PUBLIC + anon, GRANT authenticated.
--
-- WHY NOT check auth.users existence?
--   Considered; rejected. The rollback fires immediately (microseconds)
--   after a residents INSERT that landed but before/during a
--   subsequent step that failed. In that window auth.users may or
--   may not exist depending on which step failed. The auth-existence
--   predicate would either over-block (if auth exists from another
--   company's prior successful create with the same email — the
--   cross-tenant case) or under-block (race). Role-derived scope +
--   audit trail is simpler and correct.
--
-- FAILURE MODES
--   'unauthenticated'         → no auth.jwt email
--   'role_not_authorized'     → role not in {admin, company_admin, manager}
--   'invalid_email'           → p_email empty
--   'manager_scope_required'  → manager caller without p_property
--   'no_company_scope'        → CA caller with no get_my_company()
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
       AND lower(property) = lower(trim(p_property));
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := public.get_my_company();
    IF v_caller_company IS NULL OR length(trim(v_caller_company)) = 0 THEN
      RAISE EXCEPTION 'no_company_scope'
        USING HINT = 'Your session is missing a company scope. Refresh and try again.';
    END IF;
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND lower(company) = lower(v_caller_company);
  ELSE
    -- admin: unscoped by design (mirrors admin_all_residents)
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email;
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
      'source',       'delete_orphaned_pending_resident'
    ),
    now()
  );

  RETURN v_count;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'residents',
  NULL,
  jsonb_build_object(
    'migration', '20260710_delete_orphaned_pending_resident_rpc',
    'rpc',       'delete_orphaned_pending_resident',
    'change',    'DEFINER RPC for rollback cleanup of residents rows created during a failed add-user flow. Replaces silently-0-rowing direct .delete().ilike() at CA:1624 and manager:2055. Adds role-derived scope enforcement (CA gets company scope, manager gets required-property scope).',
    'rationale', 'Silent-write triage 2026-07-10. Neither CA nor manager has a residents DELETE policy; direct client-side deletes were 0-row every time. Same class-fix as the logo bug.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists + SECURITY DEFINER + args
--   SELECT proname, prosecdef AS is_security_definer,
--          pg_get_function_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'delete_orphaned_pending_resident';
--   -- Expected: 1 row; is_security_definer = true;
--   -- args = 'p_email text, p_property text DEFAULT NULL::text'.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'delete_orphaned_pending_resident';
--   -- Expected: authenticated=EXECUTE only. Not anon, not PUBLIC.
--
-- VQ.C — Audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_delete_orphaned_pending_resident_rpc'
--   ORDER BY created_at DESC LIMIT 1;
--   -- Expected: 1 row.
-- ════════════════════════════════════════════════════════════════════
