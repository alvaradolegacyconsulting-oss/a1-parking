-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 3 — super_admin_(de)activate_company DEFINER RPCs
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   Two SECURITY DEFINER functions wrapping the existing proven cascade
--   (from app/admin/page.tsx:toggleCompany) with server-side super-admin
--   role enforcement. Replaces the render-gate-only path; closes the
--   gap where an admin token from any client (curl, devtools) could
--   trigger the cascade outside the UI.
--
-- SCOPE (LOCKED via project-b228-phase3-deactivate-scope memo)
--   ACCESS-ONLY. Extreme-case lever for contract/misuse breach. NOT
--   routine billing — dunning + Stripe own account_state and remain
--   the only writers to it.
--
--   • is_active cascade across the 5 surfaces (auth.users.banned_until,
--     user_roles, drivers, properties, companies)
--   • auth.users.banned_until set to far-future on deactivate / NULL
--     on reactivate. This is the same effect swift-handler.banUser
--     gives, but server-side via the DEFINER's postgres-owner rights.
--     If the env's DEFINER owner lacks auth.users write (rare in
--     Supabase but possible in self-hosted), the auth.users UPDATE
--     gracefully no-ops — the rest of the cascade still kills access
--     via portal gates + B211 idle-logout focus check.
--   • Audit row stamps reason + counts
--
--   REACTIVATE is a pure mirror. NO prior-state restoration logic —
--   deactivate never touched account_state, so nothing to restore.
--
-- WHY DEFINER + role-gate body
--   The cascade UPDATEs cross schemas (auth, public) + multiple tables.
--   RLS-aligned policies for each would be brittle. DEFINER + body
--   auth.jwt() role check is the security boundary; same pattern as
--   approve_vehicle, set_manager_approve_permission, get_console_*.
--
-- VERIFICATION
--   See _verification.sql:
--     §1 both functions exist, DEFINER, search_path pinned, count=1
--     §2 grants — authenticated=X only on each
--     §3 audit rows landed
--     §4 app-level smoke prompts (incl. role-bypass + account_state
--        invariance check)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. super_admin_deactivate_company
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.super_admin_deactivate_company(
  p_company_id BIGINT,
  p_reason     TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company_name   TEXT;
  v_company_active BOOLEAN;
  v_user_emails    TEXT[];
  v_users_affected INTEGER;
BEGIN
  -- ── Role gate: only admin (super-admin) may call ───────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(v_caller_email) = 0 THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501',
      HINT = 'super_admin_deactivate_company is super-admin-only.';
  END IF;

  -- ── Resolve company; refuse if already inactive ───────────────
  SELECT name, is_active INTO v_company_name, v_company_active
  FROM public.companies WHERE id = p_company_id LIMIT 1;
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'company_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_company_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'noop', TRUE, 'reason', 'company_already_inactive');
  END IF;

  -- ── Collect non-admin user emails for the auth ban ────────────
  SELECT array_agg(lower(email))
    INTO v_user_emails
    FROM public.user_roles
   WHERE company ~~* v_company_name
     AND role <> 'admin';
  v_users_affected := COALESCE(array_length(v_user_emails, 1), 0);

  -- ── auth.users ban (best-effort; defensive if the DEFINER's
  --    owner lacks auth schema write). banned_until in the far
  --    future replicates swift-handler.banUser effect. ─────────
  IF v_users_affected > 0 THEN
    BEGIN
      UPDATE auth.users
         SET banned_until = '2099-12-31T23:59:59Z'::TIMESTAMPTZ
       WHERE lower(email) = ANY (v_user_emails);
    EXCEPTION WHEN insufficient_privilege THEN
      -- DEFINER owner can't touch auth.users in this env; log via
      -- audit and continue. is_active cascade + B211 still cover
      -- the access-revoke path (portal gates block on next focus).
      RAISE NOTICE '[super_admin_deactivate_company] auth.users ban skipped (insufficient_privilege); is_active cascade + B211 still in force';
    END;
  END IF;

  -- ── is_active cascade across the 4 public tables ──────────────
  UPDATE public.user_roles SET is_active = FALSE
   WHERE company ~~* v_company_name
     AND role <> 'admin';

  UPDATE public.drivers SET is_active = FALSE
   WHERE company ~~* v_company_name;

  UPDATE public.properties SET is_active = FALSE
   WHERE company ~~* v_company_name;

  UPDATE public.companies SET is_active = FALSE
   WHERE id = p_company_id;

  -- ── Audit row (super-admin caller is the actor) ───────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'SUPER_ADMIN_DEACTIVATE_COMPANY',
    'companies',
    p_company_id::TEXT,
    jsonb_build_object(
      'company_id',     p_company_id,
      'company_name',   v_company_name,
      'reason',         p_reason,
      'users_affected', v_users_affected,
      'is_active',      FALSE
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',              TRUE,
    'company_id',      p_company_id,
    'company_name',    v_company_name,
    'users_affected',  v_users_affected
  );
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.super_admin_deactivate_company(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.super_admin_deactivate_company(BIGINT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.super_admin_deactivate_company(BIGINT, TEXT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.super_admin_deactivate_company(BIGINT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 2. super_admin_reactivate_company — pure mirror, no prior-state
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.super_admin_reactivate_company(
  p_company_id BIGINT
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company_name   TEXT;
  v_company_active BOOLEAN;
  v_user_emails    TEXT[];
  v_users_affected INTEGER;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(v_caller_email) = 0 THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501',
      HINT = 'super_admin_reactivate_company is super-admin-only.';
  END IF;

  SELECT name, is_active INTO v_company_name, v_company_active
  FROM public.companies WHERE id = p_company_id LIMIT 1;
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'company_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_company_active IS TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'noop', TRUE, 'reason', 'company_already_active');
  END IF;

  SELECT array_agg(lower(email))
    INTO v_user_emails
    FROM public.user_roles
   WHERE company ~~* v_company_name
     AND role <> 'admin';
  v_users_affected := COALESCE(array_length(v_user_emails, 1), 0);

  -- auth.users unban — mirror of deactivate. Same defensive shape.
  IF v_users_affected > 0 THEN
    BEGIN
      UPDATE auth.users SET banned_until = NULL
       WHERE lower(email) = ANY (v_user_emails);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '[super_admin_reactivate_company] auth.users unban skipped (insufficient_privilege)';
    END;
  END IF;

  UPDATE public.user_roles SET is_active = TRUE
   WHERE company ~~* v_company_name
     AND role <> 'admin';

  UPDATE public.drivers SET is_active = TRUE
   WHERE company ~~* v_company_name;

  UPDATE public.properties SET is_active = TRUE
   WHERE company ~~* v_company_name;

  UPDATE public.companies SET is_active = TRUE
   WHERE id = p_company_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'SUPER_ADMIN_REACTIVATE_COMPANY',
    'companies',
    p_company_id::TEXT,
    jsonb_build_object(
      'company_id',     p_company_id,
      'company_name',   v_company_name,
      'users_affected', v_users_affected,
      'is_active',      TRUE
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',              TRUE,
    'company_id',      p_company_id,
    'company_name',    v_company_name,
    'users_affected',  v_users_affected
  );
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.super_admin_reactivate_company(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.super_admin_reactivate_company(BIGINT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.super_admin_reactivate_company(BIGINT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.super_admin_reactivate_company(BIGINT) TO authenticated;


-- Audit row
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE3',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260630_b228_phase3_deactivate_rpcs',
    'fns',       jsonb_build_array(
      'super_admin_deactivate_company(BIGINT, TEXT)',
      'super_admin_reactivate_company(BIGINT)'
    ),
    'phase',     'B228 Phase 3 — access-only deactivate',
    'note',      'DOES NOT write companies.account_state (dunning + Stripe owned)'
  ),
  now()
);

COMMIT;
