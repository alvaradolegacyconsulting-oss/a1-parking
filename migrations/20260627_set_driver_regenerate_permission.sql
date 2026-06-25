-- ═══════════════════════════════════════════════════════════════════
-- Tow Ticket Regenerate — Layer 3 (CA permission UI grant path)
-- Date:   2026-06-27
-- Branch: a1/tow-ticket-regenerate-layer-3
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Adds set_driver_regenerate_permission DEFINER RPC — the CA-facing
-- write path for granting/revoking user_roles.can_regenerate_tow_ticket
-- per driver. The column itself was added in Layer 1
-- (20260626_tow_ticket_regenerate_layer_1.sql, DEFAULT FALSE).
--
-- WHY AN RPC (not a direct UPDATE)
-- ────────────────────────────────
-- Two reasons (Jose lock 2026-06-27):
--
--   1. AUDIT COMPLETENESS — granting regenerate is a privilege
--      change. The Layer 1 regenerate audit chain (VIOLATION_VOIDED
--      with via_regenerate=TRUE + VIOLATION_REGENERATED on the new
--      row) tells us WHAT happened. Without an audit on the grant,
--      WHO ENABLED the driver to do it is unrecoverable. This RPC
--      writes DRIVER_REGENERATE_PERMISSION_CHANGED atomic with the
--      UPDATE — the forensic chain now closes.
--
--   2. SURFACE NARROWING — the B155.2 split RLS policies on
--      user_roles (company_admin_select_users / _insert_users /
--      _update_users, applied 2026-06-10) allow CAs to UPDATE rows
--      in their company, with WITH CHECK enforcing role ∈ (manager,
--      leasing_agent, driver, resident) — but WITH CHECK only
--      validates columns the policy expression references. Other
--      columns (name, phone, can_regenerate_tow_ticket, etc.) ride
--      through on a direct UPDATE. A DEFINER RPC that touches only
--      can_regenerate_tow_ticket is a single-column write surface;
--      nothing else is touchable through this path.
--
-- The RLS UPDATE policy (B155.4) STAYS INTACT — Section G of
-- verification proves it. This RPC is ADDITIVE, not a replacement.
--
-- COMPANY-SCOPE PREDICATE
-- ────────────────────────
-- ⚠ DIFFERENT SHAPE THAN LAYER 1.
--
-- Layer 1 (regenerate_tow_ticket) joins through properties:
--   properties.company ~~* v_caller_company
--   AND properties.name = v_original.property
--   (violation → property → company)
--
-- This RPC compares driver's user_roles.company directly against the
-- caller's user_roles.company:
--   v_driver_company ~~* v_caller_company
--   (user_roles → user_roles)
--
-- Both use the same ILIKE (~~*) operator to absorb case/whitespace
-- drift, but the JOIN PATH differs because the target row IS the
-- user_roles record being authorized (not a violation downstream of
-- a property). Same drift-tolerance discipline; different shape.
--
-- VALIDATIONS
-- ───────────
-- 1. caller role ∈ {admin, company_admin}      → role_not_authorized
-- 2. p_driver_email exists in user_roles       → driver_not_found
-- 3. that row's role = 'driver'                → not_a_driver
--    (granting regenerate to non-drivers is nonsense; reject)
-- 4. p_allowed is non-null BOOLEAN             → invalid_allowed
-- 5. caller company matches driver company     → driver_out_of_scope
--    (CA only; admin bypasses scope)
-- 6. p_allowed = current value                 → noop=TRUE return,
--                                                 no UPDATE, no audit
--
-- AUDIT
-- ─────
-- DRIVER_REGENERATE_PERMISSION_CHANGED on the user_roles table,
-- record_id NULL (user_roles primary key is text email, not bigint;
-- the driver_email lives in new_values jsonb for indexed query).
-- new_values includes old_value + new_value + driver_email +
-- caller_role + company for full forensic context.
--
-- APPLY DISCIPLINE (mirrors Layer 1)
-- ──────────────────────────────────
-- 1. Section A → confirm RPC absent
-- 2. Apply this file as a single paste in SQL Editor
-- 3. Sections B–G → confirm pass; report C/D/E/G (load-bearing)
-- 4. UI commit (Layer 3 toggle + REGEN dot) ships AFTER the RPC
--    is live in prod
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.set_driver_regenerate_permission(
  p_driver_email TEXT,
  p_allowed      BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email     TEXT;
  v_caller_role      TEXT;
  v_caller_company   TEXT;
  v_normalized_email TEXT;
  v_driver_role      TEXT;
  v_driver_company   TEXT;
  v_old_value        BOOLEAN;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ AUTH GATE                                               ║
  -- ╚══════════════════════════════════════════════════════════╝
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Single user_roles lookup: caller role + company
  SELECT role, company INTO v_caller_role, v_caller_company
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ROLE GATE — admin OR company_admin                      ║
  -- ║   admin: super-admin access, no scope                   ║
  -- ║   company_admin: company-scoped (see scope check below) ║
  -- ║   all others: refused                                   ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ INPUT VALIDATION                                        ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF p_allowed IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'invalid_allowed',
      'hint',  'p_allowed must be TRUE or FALSE (not null).'
    );
  END IF;

  v_normalized_email := lower(trim(COALESCE(p_driver_email, '')));
  IF length(v_normalized_email) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'driver_email_required',
      'hint',  'p_driver_email cannot be null or empty.'
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ TARGET DRIVER: load + state checks                      ║
  -- ╚══════════════════════════════════════════════════════════╝
  SELECT role, company, can_regenerate_tow_ticket
    INTO v_driver_role, v_driver_company, v_old_value
    FROM public.user_roles
   WHERE lower(email) = v_normalized_email
   LIMIT 1;

  IF v_driver_role IS NULL THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;

  -- Target must be a driver — granting regenerate to a manager,
  -- leasing_agent, resident, etc. is nonsense and refused. Layer 1's
  -- can_regenerate_tow_ticket flag is only consulted in
  -- regenerate_tow_ticket's `IF v_caller_role = 'driver'` branch;
  -- non-drivers don't read it.
  IF v_driver_role <> 'driver' THEN
    RETURN jsonb_build_object(
      'error', 'not_a_driver',
      'hint',  'Regenerate permission applies only to drivers. Target role: ' || v_driver_role
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ COMPANY-SCOPE PREDICATE                                 ║
  -- ║                                                          ║
  -- ║ ⚠ Different shape than Layer 1 — see file docstring.     ║
  -- ║   Layer 1 joins through properties.                      ║
  -- ║   This RPC compares user_roles.company directly.         ║
  -- ║                                                          ║
  -- ║ admin: bypasses scope.                                  ║
  -- ║ company_admin: driver.company ~~* caller.company.        ║
  -- ║                                                          ║
  -- ║ ILIKE (~~*) absorbs case/whitespace drift, same as       ║
  -- ║ Layer 1's intent — different join path, same tolerance.  ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF v_driver_company IS NULL
       OR NOT (v_driver_company ~~* v_caller_company) THEN
      RETURN jsonb_build_object('error', 'driver_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ IDEMPOTENT SHORT-CIRCUIT                                ║
  -- ║   If new == old, no-op. No UPDATE, no audit row.         ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF COALESCE(v_old_value, FALSE) = p_allowed THEN
    RETURN jsonb_build_object(
      'ok',           TRUE,
      'noop',         TRUE,
      'driver_email', v_normalized_email,
      'allowed',      p_allowed
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ATOMIC UPDATE + AUDIT                                   ║
  -- ║   Single-column UPDATE — narrow surface.                ║
  -- ║   Audit row writes old/new + driver + caller context.    ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.user_roles
     SET can_regenerate_tow_ticket = p_allowed
   WHERE lower(email) = v_normalized_email;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'DRIVER_REGENERATE_PERMISSION_CHANGED',
    'user_roles',
    NULL,
    jsonb_build_object(
      'driver_email',  v_normalized_email,
      'old_value',     COALESCE(v_old_value, FALSE),
      'new_value',     p_allowed,
      'caller_role',   v_caller_role,
      'company',       v_caller_company
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',           TRUE,
    'noop',         FALSE,
    'driver_email', v_normalized_email,
    'old_value',    COALESCE(v_old_value, FALSE),
    'new_value',    p_allowed
  );
END;
$func$;

-- Explicit REVOKE from anon + PUBLIC per
-- [[feedback-revoke-from-anon-explicitly]] +
-- [[feedback-function-public-grant-supabase-default]]
REVOKE EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) TO authenticated;

-- Audit row recording the migration ships
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'set_driver_regenerate_permission',
  NULL,
  jsonb_build_object(
    'rpc',          'set_driver_regenerate_permission',
    'migration',    '20260627_set_driver_regenerate_permission',
    'returns',      'jsonb',
    'role_gate',    'admin + company_admin',
    'scope',        'driver.company ~~* caller.company (user_roles-to-user_roles ILIKE)',
    'audit_action', 'DRIVER_REGENERATE_PERMISSION_CHANGED',
    'invariant',    'B155.2 split user_roles RLS policies (company_admin_insert_users + _update_users) untouched (Section G of verification)'
  ),
  now()
);

COMMIT;
