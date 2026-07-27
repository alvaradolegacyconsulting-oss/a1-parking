-- ══════════════════════════════════════════════════════════════════════
-- 20260728_user_roles_update_grant_fix.sql
-- Stranded-policy fix: grant UPDATE on user_roles to authenticated.
--
-- DRAFT — NOT APPLIED. Confirm the grant gap first via:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema='public' AND table_name='user_roles' ORDER BY 1,2;
-- Expect authenticated → SELECT, INSERT only (no UPDATE). Then apply
-- this migration.
--
-- ── Root cause ─────────────────────────────────────────────────────
-- migrations/20260722_grant_remediation_deny_by_default.sql:127 granted
-- INSERT only on public.user_roles to authenticated. Every other table
-- with an UPDATE policy in that migration was granted INSERT + UPDATE.
-- user_roles alone got INSERT.
--
-- Meanwhile a live UPDATE policy exists:
--   • company_admin_update_users (20260610_b155_2_policy_tightens.sql
--     :211) — FOR UPDATE TO authenticated, USING CA-on-own-company,
--     WITH CHECK CA-on-own-company + role IN (mgr/la/drv/res).
-- Plus admin FOR ALL policies. All become unreachable when
-- authenticated lacks the base UPDATE privilege.
--
-- ── Symptom (2026-07-27, discovered A1 go-live day) ─────────────────
-- CA opens People-tab → clicks Edit on a manager → adds a property
-- → clicks Save → alert: "Edit failed: permission denied for table
-- user_roles" (SQLSTATE 42501, PostgREST HTTP 403).
-- saveUserName's 9956caf silent-write guard fired correctly; the
-- error surfaced instead of the write silently no-op'ing. No data
-- damage. The bug is that the CA edit path has been broken since
-- 2026-07-22 (grant remediation date); nobody noticed because no
-- CA-side user edits were exercised until A1 went live 5 days later.
--
-- ── Scope ──────────────────────────────────────────────────────────
-- ONE grant. company_admin_update_users' USING + WITH CHECK already
-- constrain writes to CA-on-own-company with role in the allowed set,
-- so this doesn't over-widen — RLS filters what CAs can touch. Admin
-- retains its FOR ALL access. No other role gains UPDATE (no other
-- UPDATE policies to enable).
--
-- The lesson for the grant remediation pattern: whenever a table gets
-- INSERT but not UPDATE (or vice versa), verify against pg_policies
-- that the omitted grant doesn't strand a matching policy. Reported
-- separately as a broader audit — this migration fixes only the
-- user_roles gap.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

GRANT UPDATE ON public.user_roles TO authenticated;

-- Verification — expect exactly one grant row with UPDATE for authenticated.
DO $chk$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.user_roles', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.GRANT FAILED — authenticated still lacks UPDATE on public.user_roles';
  END IF;
END $chk$;

-- Schema audit row.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_USER_ROLES_UPDATE_GRANT_FIX',
  'proc',
  NULL,
  jsonb_build_object(
    'migration',   '20260728_user_roles_update_grant_fix',
    'root_cause',  '20260722_grant_remediation_deny_by_default.sql L127 granted INSERT only on user_roles; UPDATE was omitted, stranding company_admin_update_users policy since 2026-07-22.',
    'symptom',     'CA edit-user via People-tab returned "permission denied for table user_roles" 42501/HTTP 403 (2026-07-27, A1 go-live day).',
    'fix',         'GRANT UPDATE ON public.user_roles TO authenticated. Policy constrains scope; grant just makes it evaluable.'
  ),
  now()
);

COMMIT;
