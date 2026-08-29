-- ══════════════════════════════════════════════════════════════════════
-- 20260829_get_auth_user_id_by_email.sql
--
-- 🟢 Item 2 (deactivate_user atomicity) — Commit 1 of 3
--
-- Deterministic email → auth.users.id resolver for use by the
-- Supabase Edge Function `swift-handler`. Replaces the O(n)
-- `admin.listUsers().find()` scan currently used by every branch of
-- that function (deactivate_user, activate_user, reset_password).
--
-- ── ROOT CAUSE THIS FIXES ──────────────────────────────────────────
--
-- `supabase.auth.admin.listUsers()` with no arguments defaults to
-- page=1, perPage=50, ordered created_at DESC. swift-handler was
-- reading page 1 and finding matches only there. As auth.users
-- grew past 50 (roughly 2026-07-30 with Green Acres self-registration
-- volume), older accounts became silently invisible to the ban /
-- activate / reset paths.
--
-- Jose's ranking query 2026-08-29 confirmed:
--   auth.users total   = 185
--   6 succeeded calls  = all at page-1 slots 1, 19, 43
--   6 failed calls     = all at slots 85, 92, 102 (beyond the 50-cap)
-- 135 of 185 accounts (73%) currently unreachable.
--
-- ── SHAPE ─────────────────────────────────────────────────────────
--
-- Constant-time lookup by lowered + trimmed email. Returns NULL when
-- no match (the caller returns `"User not found"` — which will now
-- actually be true when it fires). Never raises for missing rows.
--
-- SECURITY DEFINER because service-role callers (the Edge Function)
-- read auth.users, which is not directly queryable via PostgREST from
-- anon/authenticated regardless. `set search_path = ''` ensures the
-- body's `auth.users` reference resolves to the auth schema by fully-
-- qualified name — no search_path shadowing surface.
--
-- ── 🔴 GRANTS ARE LOAD-BEARING ─────────────────────────────────────
--
-- This function returns auth user ids from an email. It is an
-- identity-lookup primitive; anyone who can invoke it can enumerate
-- users by email address. Deny by default — REVOKE from PUBLIC, anon,
-- authenticated. GRANT only to service_role.
--
-- Post-apply, run the grant-table check (verification G4 asserts
-- this). If `anon`, `authenticated`, or `PUBLIC` appears anywhere on
-- this function's routine_privileges row, STOP AND REPORT — the
-- function has become an anonymous email-existence oracle and must
-- be restored to service_role-only before any call site references it.
--
-- ── ZERO CALLERS UNTIL EDGE FUNCTION IS REDEPLOYED ─────────────────
--
-- The Edge Function (swift-handler) is deployed via the Supabase
-- dashboard, outside the Vercel push path. Until Jose pastes the
-- Commit 2 rewrite and hits Deploy, this RPC has zero production
-- callers. That means the migration is safe to land on its own —
-- an incorrect body, wrong grants, or missing search_path would
-- surface at verification time, not at request time.
--
-- APPLY: single database. Wrapped in BEGIN/COMMIT. Verification
-- returns one PASS row on 7 gates including execution + NULL-safe
-- negative-case gate.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_auth_user_id_by_email(p_email TEXT)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  -- Fully-qualified auth.users to resolve under `search_path = ''`.
  -- lower(trim()) on both sides so a call with mixed case / stray
  -- whitespace still hits the row. Returns NULL on no match rather
  -- than raising — caller distinguishes "user genuinely not found"
  -- (null result) from "lookup failed" (RPC error).
  SELECT id
    FROM auth.users
   WHERE lower(email) = lower(trim(p_email))
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_auth_user_id_by_email(TEXT) IS
  'Item 2 Commit 1 (2026-08-29). Deterministic email→auth.users.id lookup for swift-handler Edge Function. Replaces admin.listUsers().find() O(n) scan that silently failed for 73% of users once auth.users grew past 50 rows. SECURITY DEFINER + service_role-only. Returns NULL on no match (never raises). Caller pattern: on NULL → 404 "User not found"; on RPC error → 500 with underlying message. Do NOT grant to anon/authenticated/PUBLIC — this is an email-existence oracle and must stay service-role only.';

-- ── Grants: service_role EXCLUSIVE ──────────────────────────────────
-- Explicit REVOKE from every non-service_role principal. Grant-table
-- check in verification G4 asserts service_role=1 + all others=0.
REVOKE ALL     ON FUNCTION public.get_auth_user_id_by_email(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_auth_user_id_by_email(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_auth_user_id_by_email(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_auth_user_id_by_email(TEXT) TO   service_role;

-- ── PostgREST schema cache reload ───────────────────────────────────
-- The Edge Function calls this via supabase-js .rpc() which routes
-- through PostgREST. PostgREST caches function signatures — reload
-- so the first Commit 2 invocation doesn't fail with PGRST202
-- (function-not-in-cache). Belt-and-braces; Supabase auto-issues
-- on DDL but explicit fires from a known point.
NOTIFY pgrst, 'reload schema';

-- ── Schema audit row ────────────────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_GET_AUTH_USER_ID_BY_EMAIL',
  'public.get_auth_user_id_by_email(TEXT)',
  'get_auth_user_id_by_email',
  jsonb_build_object(
    'migration',    '20260829_get_auth_user_id_by_email',
    'item',         'Item 2 (deactivate_user atomicity) — Commit 1 of 3',
    'purpose',      'Replace listUsers().find() O(n) scan in swift-handler; 73% of auth.users unreachable pre-fix',
    'grants',       'service_role EXECUTE; REVOKED from PUBLIC/anon/authenticated (identity oracle discipline)',
    'security',     'SECURITY DEFINER + SET search_path = '''' + returns NULL on no match (never raises)',
    'next_step',    'Commit 2 = swift-handler rewrite (Supabase dashboard paste; not in this repo). Commit 3 = client-side hard-error banner.',
    'zero_callers_until_c2', TRUE
  )
);

COMMIT;
