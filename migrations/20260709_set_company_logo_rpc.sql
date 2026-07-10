-- ════════════════════════════════════════════════════════════════════
-- set_company_logo — DEFINER RPC for CA-side logo write
-- 2026-07-09
--
-- WHY
--   pg_policies enumeration on 2026-07-09 confirmed there is NO
--   UPDATE policy for company_admin on `companies`. CA has SELECT
--   (via authenticated_read_own_company + company_admin_read_own)
--   but every client-side .update() has been silently RLS-denied —
--   0 rows affected, no error surfaced. Ground-truth probe: id=56
--   A1 Test Run 2 had logo_url=NULL despite 7 audited EDIT_COMPANY_LOGO
--   write attempts.
--
--   Fix per Jose's recommended option 1 (DEFINER RPC) — matches the
--   established scoped-mutation pattern already used for
--   update_my_company_tdlr, set_driver_regenerate_permission, etc.
--   Bypasses RLS via SECURITY DEFINER while keeping the narrow
--   {logo_url}-only allowlist server-side (never exposes broader
--   companies UPDATE).
--
-- SCOPE (locked to logo)
--   Single-column UPDATE on logo_url. Do NOT expand this RPC to
--   accept additional fields — if the CA needs to update other
--   companies columns in the future, use a separate scoped RPC.
--   Blanket UPDATE on companies would expose tier, billing IDs,
--   Stripe IDs, account_state, company_env — all of which have
--   their own dedicated update surfaces or are admin-only.
--
-- INVARIANTS
--   • Role gate: {admin, company_admin} only. Not manager / driver /
--     resident / leasing_agent / anon. All others → role_not_authorized.
--   • Scope gate: caller's company via get_my_company() (session-
--     derived, NOT client-supplied). Not spoofable.
--   • Idempotent: setting the same value twice is a no-op UPDATE
--     (no rowcount error; RETURNING captures the row id regardless).
--   • Clear allowed: p_logo_url = NULL/empty/whitespace normalizes
--     to NULL — CA can revert to platform default.
--
-- FAILURE MODES
--   'unauthenticated'      → no auth.jwt email
--   'no_role_assigned'     → no user_roles row for this email
--   'role_not_authorized'  → role not in {admin, company_admin}
--   'no_company_scope'     → get_my_company() returned null/empty
--   'company_not_found'    → UPDATE matched 0 rows (name drift?
--                           deleted company? — surface as error
--                           rather than silent success)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.set_company_logo(p_logo_url TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email  TEXT;
  v_caller_role   TEXT;
  v_company_name  TEXT;
  v_company_id    BIGINT;
  v_norm_url      TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_company_name := get_my_company();
  IF v_company_name IS NULL OR length(trim(v_company_name)) = 0 THEN
    RETURN jsonb_build_object('error', 'no_company_scope');
  END IF;

  -- Normalize: empty / whitespace-only → NULL. Allows clearing.
  v_norm_url := NULLIF(trim(coalesce(p_logo_url, '')), '');

  -- Update by name-match via get_my_company() (session-derived, not
  -- client-supplied). RETURNING id catches the 0-row case (e.g.,
  -- companies.name drift vs. user_roles.company denorm string).
  UPDATE companies
     SET logo_url = v_norm_url
   WHERE name ~~* v_company_name
  RETURNING id INTO v_company_id;

  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('error', 'company_not_found',
      'hint', 'No companies row matched the caller''s company name. Check user_roles.company vs companies.name for drift.');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'company_id', v_company_id, 'logo_url', v_norm_url);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.set_company_logo(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_company_logo(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_company_logo(TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'companies',
  NULL,
  jsonb_build_object(
    'migration', '20260709_set_company_logo_rpc',
    'rpc',       'set_company_logo',
    'change',    'DEFINER RPC for CA-side logo write (bypasses missing UPDATE policy on companies for company_admin role)',
    'rationale', 'pg_policies showed only admin_all_companies + 2 SELECT policies; CA-side client .update() was silently 0-row RLS-denied. This RPC keeps the narrow logo_url-only allowlist server-side while dodging the RLS-policy surgery.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists + SECURITY DEFINER
--   SELECT proname, prosecdef AS is_security_definer,
--          pg_get_function_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'set_company_logo';
--   -- Expected: 1 row; is_security_definer = true; args = 'p_logo_url text'.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'set_company_logo';
--   -- Expected: authenticated=EXECUTE only. Not anon, not PUBLIC.
--
-- VQ.C — Audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260709_set_company_logo_rpc'
--   ORDER BY created_at DESC LIMIT 1;
--   -- Expected: 1 row.
-- ════════════════════════════════════════════════════════════════════
