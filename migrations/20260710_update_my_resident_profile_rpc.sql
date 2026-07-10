-- ════════════════════════════════════════════════════════════════════
-- update_my_resident_profile — DEFINER RPC for resident-self profile edits
-- 2026-07-10 · Silent-write triage Commit 1a
--
-- WHY
--   saveResident() at resident/page.tsx:447 was doing a direct
--   .from('residents').update({name,phone,email}).eq('id', ...) and
--   checking only { error }. Cross-referenced pg_policies (migrations
--   grep 2026-07-10): residents has _admin_all, _manager_read/update/
--   insert, _company_admin_read/update/insert, _self_insert, and
--   resident_read_own — but NO residents_self_update or _resident_update
--   policy. Every resident profile save has silently 0-rowed since the
--   portal launched: alert("Profile updated!") but the DB never changed.
--
-- SCOPE — name + phone ONLY (email excluded)
--   Jose's spec was p_name + p_phone + p_email. Investigation showed
--   allowing email creates identity drift:
--     • residents.email + user_roles.email + auth.users.email are three
--       separate stores keyed off the same string.
--     • saveResident() only touches residents.email. On next login, the
--       JWT carries auth.users.email (OLD) which no longer matches
--       residents.email (NEW). resident_read_own scope predicate
--       (lower(email) = lower(auth.jwt() ->> 'email')) then returns 0
--       rows → resident locks themselves out. Every other scoped RPC
--       (update_my_vehicle_cosmetic, submit_space_request, etc.) also
--       breaks the same way.
--   Correct email-change is a 3-way flip + supabase.auth.updateUser({
--   email}) OTP round-trip. Out of scope for this RPC. UI removes the
--   email input in favor of a read-only display + "contact your PM"
--   hint. Jose's conditional in the greenlight explicitly allowed this
--   reduction if identity drift was real; it is.
--
-- SHAPE — mirror update_my_vehicle_cosmetic
--   • SECURITY DEFINER, search_path pinned.
--   • Effective-active guard first (stale-session deactivated residents
--     can't edit either — matches request_my_vehicle / cosmetic).
--   • Role gate: {resident} only.
--   • Scope: lower(residents.email) = lower(auth.jwt() ->> 'email').
--   • Column allowlist enforced by function signature (2 args, 2 cols).
--     No other column reachable.
--   • GET DIAGNOSTICS v_count = ROW_COUNT + RAISE on 0 (this is the
--     assertion that makes silent-0-row structurally impossible).
--   • REVOKE PUBLIC + anon, GRANT authenticated.
--
-- FAILURE MODES
--   'account_deactivated'   → get_my_effective_active() returned false
--   'caller_not_resident'   → role gate rejected
--   'resident_row_not_found'→ 0 rows matched the caller's email
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.update_my_resident_profile(
  p_name  TEXT,
  p_phone TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_count       INTEGER;
  v_resident_id BIGINT;
BEGIN
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  IF public.get_my_role() IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller_not_resident'
      USING HINT = 'This RPC is for resident-self profile edits only.';
  END IF;

  UPDATE public.residents
     SET name  = p_name,
         phone = p_phone
   WHERE lower(email) = lower(auth.jwt() ->> 'email')
  RETURNING id INTO v_resident_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'resident_row_not_found'
      USING HINT = 'No residents row matched your account email. Contact your property manager.';
  END IF;

  RETURN v_resident_id;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.update_my_resident_profile(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_my_resident_profile(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_my_resident_profile(TEXT, TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'residents',
  NULL,
  jsonb_build_object(
    'migration', '20260710_update_my_resident_profile_rpc',
    'rpc',       'update_my_resident_profile',
    'change',    'DEFINER RPC for resident-self profile edits. Replaces silently-0-rowing direct .update() at resident/page.tsx:447. Name+phone only; email excluded pending 3-way identity flip.',
    'rationale', 'Silent-write triage 2026-07-10. residents has no _self_update / _resident_update policy — every resident Save Profile click has been alerting success without persisting since portal launch. Class-fix of the same shape as set_company_logo.'
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
--     AND proname = 'update_my_resident_profile';
--   -- Expected: 1 row; is_security_definer = true; args = 'p_name text, p_phone text'.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'update_my_resident_profile';
--   -- Expected: authenticated=EXECUTE only. Not anon, not PUBLIC.
--
-- VQ.C — Audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260710_update_my_resident_profile_rpc'
--   ORDER BY created_at DESC LIMIT 1;
--   -- Expected: 1 row.
-- ════════════════════════════════════════════════════════════════════
