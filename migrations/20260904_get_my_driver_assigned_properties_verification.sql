-- ══════════════════════════════════════════════════════════════════════
-- 20260904_get_my_driver_assigned_properties_verification.sql
--
-- Paired verification for the driver-scope helper. v2 pattern (no
-- BEGIN/COMMIT wrap; terminal SELECT returns PASS row). 8 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  fn exists via to_regprocedure
--   VS2  STABLE + SECURITY DEFINER + search_path pinned
--   VS3  RETURNS TEXT[] (specific return type — catches accidental
--        RETURNS SETOF or RETURNS jsonb during future edits)
--   VS4  GRANTs — authenticated + service_role EXECUTE, anon REVOKEd
--   VS5  🔴 EXECUTION — impersonate a driver with assigned_properties;
--        assert returns their exact array
--   VS6  🔴 EXECUTION — impersonate a driver with NULL/empty
--        assigned_properties; assert returns NULL or '{}'
--        (skip with NOTICE if no such driver exists)
--   VS7  🔴 EXECUTION — no session (JWT reset); assert returns NULL
--        (SQL fn — no rows match → NULL, not RAISE)
--   VS8  schema audit row present
--
-- ── SESSION-RESET DISCIPLINE (per Sep 3 helper-verif VS8 lesson) ────
-- Supabase SQL Editor runs the whole file as ONE transaction; LOCAL
-- set_config values persist across DO blocks. VS7 explicitly RESETs
-- request.jwt.claims before probing "no session" so a prior VS's
-- impersonation doesn't leak in.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: fn exists ──────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_my_driver_assigned_properties()') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.get_my_driver_assigned_properties() not found';
  END IF;
END $$;

-- ── VS2: STABLE + DEFINER + search_path pinned ─────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_my_driver_assigned_properties()');
  v_volatile CHAR;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT provolatile, prosecdef, proconfig
    INTO v_volatile, v_secdef, v_config
    FROM pg_proc WHERE oid = v_oid;
  IF v_volatile <> 's' THEN
    RAISE EXCEPTION 'VS2 FAIL: volatility=% (want s=STABLE)', v_volatile;
  END IF;
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'VS2 FAIL: not SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'VS2 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
END $$;

-- ── VS3: RETURNS TEXT[] ────────────────────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_my_driver_assigned_properties()');
  v_result TEXT;
BEGIN
  v_result := pg_get_function_result(v_oid);
  IF v_result NOT ILIKE '%text[]%' THEN
    RAISE EXCEPTION 'VS3 FAIL: RETURNS % (want TEXT[]). Signature drift.', v_result;
  END IF;
END $$;

-- ── VS4: GRANTs ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_my_driver_assigned_properties()');
  v_acl TEXT;
BEGIN
  SELECT array_to_string(proacl::TEXT[], ',') INTO v_acl FROM pg_proc WHERE oid = v_oid;
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: proacl is NULL (default = EXECUTE to PUBLIC, defect)';
  END IF;
  IF v_acl NOT LIKE '%authenticated=X/%' THEN
    RAISE EXCEPTION 'VS4 FAIL: missing GRANT EXECUTE TO authenticated. proacl=%', v_acl;
  END IF;
  IF v_acl NOT LIKE '%service_role=X/%' THEN
    RAISE EXCEPTION 'VS4 FAIL: missing GRANT EXECUTE TO service_role. proacl=%', v_acl;
  END IF;
  IF v_acl LIKE '%anon=X/%' THEN
    RAISE EXCEPTION 'VS4 FAIL: EXECUTE to anon present (should be REVOKEd). proacl=%', v_acl;
  END IF;
END $$;

-- ── VS5: 🔴 EXECUTION — driver WITH assigned properties ─────────────
DO $$
DECLARE
  v_email TEXT;
  v_expected TEXT[];
  v_actual TEXT[];
BEGIN
  -- Find any driver with a non-empty assigned_properties array.
  SELECT email, assigned_properties
    INTO v_email, v_expected
    FROM public.drivers
   WHERE assigned_properties IS NOT NULL
     AND array_length(assigned_properties, 1) IS NOT NULL
     AND is_active = TRUE
   ORDER BY id LIMIT 1;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'VS5 FIXTURE FAIL: no active driver with non-empty assigned_properties. Cannot verify happy path.';
  END IF;

  -- Impersonate + call
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  v_actual := public.get_my_driver_assigned_properties();

  -- Reset for subsequent VS blocks
  BEGIN EXECUTE 'RESET request.jwt.claims'; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN EXECUTE 'RESET role'; EXCEPTION WHEN OTHERS THEN NULL; END;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'VS5 FAIL: driver (email=%) — expected %L, got %L', v_email, v_expected, v_actual;
  END IF;
END $$;

-- ── VS6: 🔴 EXECUTION — driver with NULL/empty assigned_properties ──
DO $$
DECLARE
  v_email TEXT;
  v_expected TEXT[];
  v_actual TEXT[];
BEGIN
  -- Find any driver with NULL or empty assigned_properties.
  SELECT email, assigned_properties
    INTO v_email, v_expected
    FROM public.drivers
   WHERE (assigned_properties IS NULL OR array_length(assigned_properties, 1) IS NULL)
     AND is_active = TRUE
   ORDER BY id LIMIT 1;

  IF v_email IS NULL THEN
    RAISE NOTICE 'VS6 SKIP: no active driver with NULL/empty assigned_properties found. Empty-state path not directly verifiable.';
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  v_actual := public.get_my_driver_assigned_properties();

  BEGIN EXECUTE 'RESET request.jwt.claims'; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN EXECUTE 'RESET role'; EXCEPTION WHEN OTHERS THEN NULL; END;

  -- Either NULL or empty array is acceptable — both signal "no
  -- assignments" and the caller treats them identically.
  IF v_actual IS NOT NULL AND array_length(v_actual, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'VS6 FAIL: driver with empty assigned_properties returned non-empty %L (email=%)', v_actual, v_email;
  END IF;
END $$;

-- ── VS7: 🔴 EXECUTION — no session → NULL ──────────────────────────
DO $$
DECLARE
  v_actual TEXT[];
BEGIN
  -- Reset any prior impersonation from VS5/VS6 (LOCAL settings
  -- persist across DO blocks in a single Supabase editor session).
  -- `set_config('role', '', true)` FAILS with 22023 "role \"\" does
  -- not exist" — role is a real Postgres setting, not a custom GUC.
  -- Use `EXECUTE 'RESET role'` (per space_payments precedent + Mateo
  -- Sep 3 followup §1). request.jwt.claims IS a custom GUC; clearing
  -- to '' gives us auth.jwt() ->> 'email' → NULL, which is the
  -- no-session state we want.
  EXECUTE 'RESET role';
  PERFORM set_config('request.jwt.claims', '', true);

  v_actual := public.get_my_driver_assigned_properties();

  -- SQL fn — no rows match → NULL, not RAISE. This helper is
  -- DELIBERATELY non-raising (contrast with my_tier_enforcement_capable
  -- which raises no_company_context). Callers handle NULL/empty as
  -- "no assignments" — safe fail-closed behavior at the caller.
  IF v_actual IS NOT NULL THEN
    RAISE EXCEPTION 'VS7 FAIL: no-session probe returned %L, expected NULL. Session-reset may have failed; check for LOCAL GUC pollution from prior VS blocks.', v_actual;
  END IF;
END $$;

-- ── VS8: schema audit row ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_MY_DRIVER_ASSIGNED_PROPERTIES'
     AND new_values ->> 'migration' = '20260904_get_my_driver_assigned_properties';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'get_my_driver_assigned_properties helper'::TEXT AS target,
  ARRAY[
    'VS1  fn exists',
    'VS2  STABLE + DEFINER + search_path pinned',
    'VS3  RETURNS TEXT[]',
    'VS4  GRANTs: authenticated + service_role EXECUTE; anon REVOKEd',
    'VS5  🔴 execution — driver with assigned_properties → exact array returned',
    'VS6  🔴 execution — driver with empty/NULL assigned_properties → NULL or {} (or SKIP)',
    'VS7  🔴 execution — no session → NULL (fail-closed at caller)',
    'VS8  SCHEMA_GET_MY_DRIVER_ASSIGNED_PROPERTIES audit row'
  ] AS gates_verified,
  now() AS verified_at;
