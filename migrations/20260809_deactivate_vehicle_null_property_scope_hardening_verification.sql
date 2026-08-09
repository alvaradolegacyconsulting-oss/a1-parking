-- ══════════════════════════════════════════════════════════════════════
-- 20260809_deactivate_vehicle_null_property_scope_hardening_verification.sql
-- POST-APPLY: RPC still exists at same identity signature, defaults
-- preserved, grants preserved, both hardening layers present in the
-- function body, comment updated, schema audit row landed.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
--
-- 🔴 Function lookup uses `pg_get_function_identity_arguments` (the
-- stable identity signature — no DEFAULTs, no parameter names' fillers)
-- rather than `pg_get_function_arguments` (which includes DEFAULT
-- expressions and would drift with any harmless default tweak). The
-- default-preservation check is its own VQ.DEFAULTS_PRESERVED gate
-- below.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260809_deactivate_vehicle_null_property_scope_hardening.sql.
-- Paste WHOLE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RPC_EXISTS ────────────────────────────────────────────────────
-- Identity signature is unchanged from 20260806 install; hardening
-- is body-only. Uses pg_get_function_identity_arguments so a future
-- default tweak on p_note doesn't break the lookup.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected 1 deactivate_vehicle(BIGINT,TEXT,TEXT); got %', v_count;
  END IF;
END $$;

-- ── VQ.DEFAULTS_PRESERVED ────────────────────────────────────────────
-- 🔴 The 20260806 install carried `p_note TEXT DEFAULT NULL::text`.
-- CREATE OR REPLACE replaces the ENTIRE function definition including
-- DEFAULTs; a signature drop would silently break two-arg callers
-- with 42883 at call time (no earlier signal). Verify the default
-- survived the re-definition.
DO $$
DECLARE v_args_with_defaults TEXT;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_args_with_defaults
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_args_with_defaults NOT LIKE '%DEFAULT NULL%' THEN
    RAISE EXCEPTION 'VQ.DEFAULTS_PRESERVED: p_note DEFAULT NULL was dropped by the re-definition; two-arg callers would break. Got: %', v_args_with_defaults;
  END IF;
END $$;

-- ── VQ.RPC_STILL_DEFINER ─────────────────────────────────────────────
DO $$
DECLARE v_security TEXT;
BEGIN
  SELECT CASE prosecdef WHEN true THEN 'DEFINER' ELSE 'INVOKER' END
    INTO v_security
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_security <> 'DEFINER' THEN
    RAISE EXCEPTION 'VQ.RPC_STILL_DEFINER: expected SECURITY DEFINER; got %', v_security;
  END IF;
END $$;

-- ── VQ.LAYER_1_PROPERTY_PRESENCE_GATE ───────────────────────────────
-- pg_get_functiondef must contain the vehicle_property_missing error
-- class. Body-string check proves the Layer 1 gate actually landed.
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_body NOT LIKE '%vehicle_property_missing%' THEN
    RAISE EXCEPTION 'VQ.LAYER_1_PROPERTY_PRESENCE_GATE: function body missing vehicle_property_missing error class; hardening did not land';
  END IF;
END $$;

-- ── VQ.LAYER_2_COALESCE_SCOPE_FLAG ──────────────────────────────────
-- Body must COALESCE(v_in_scope, false) — the defense-in-depth belt.
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_body !~* 'COALESCE\s*\(\s*v_in_scope\s*,\s*false\s*\)' THEN
    RAISE EXCEPTION 'VQ.LAYER_2_COALESCE_SCOPE_FLAG: function body missing COALESCE(v_in_scope, false); hardening did not land';
  END IF;
END $$;

-- ── VQ.GRANTS_PRESERVED ─────────────────────────────────────────────
-- authenticated must have EXECUTE; anon MUST NOT.
DO $$
DECLARE v_anon_has BOOLEAN; v_auth_has BOOLEAN; v_public_has BOOLEAN;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE'),
    has_function_privilege('public',        'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE')
  INTO v_anon_has, v_auth_has, v_public_has;
  IF v_anon_has THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED: anon HAS EXECUTE on deactivate_vehicle (must be REVOKED)';
  END IF;
  IF v_public_has THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED: PUBLIC HAS EXECUTE on deactivate_vehicle (must be REVOKED)';
  END IF;
  IF NOT v_auth_has THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED: authenticated MISSING EXECUTE on deactivate_vehicle';
  END IF;
END $$;

-- ── VQ.COMMENT_UPDATED ──────────────────────────────────────────────
DO $$
DECLARE v_comment TEXT;
BEGIN
  SELECT obj_description(p.oid, 'pg_proc') INTO v_comment
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'deactivate_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_vehicle_id bigint, p_reason text, p_note text';
  IF v_comment IS NULL OR v_comment NOT LIKE '%Item 2 hardening%' THEN
    RAISE EXCEPTION 'VQ.COMMENT_UPDATED: function comment missing Item 2 hardening reference';
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DEACTIVATE_VEHICLE_NULL_PROPERTY_HARDENING'
     AND new_values->>'migration' = '20260809_deactivate_vehicle_null_property_scope_hardening';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

COMMIT;
