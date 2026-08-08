-- ══════════════════════════════════════════════════════════════════════
-- 20260808_get_residents_row_by_precedence_verification.sql
-- POST-APPLY: RPC exists with SECURITY DEFINER + STABLE volatility;
-- grants are service_role ONLY (PUBLIC/anon/authenticated REVOKED);
-- body references the shared precedence helper; behavioural probe
-- seeds an (active, declined) pair and asserts the RPC returns the
-- active row's (unit, property).
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260808_get_residents_row_by_precedence.sql.
-- Depends on 20260808_get_my_effective_active_row_precedence.sql
-- (installs the resident_row_precedence helper). Apply order:
--   1. 20260808_get_my_effective_active_row_precedence.sql
--   2. 20260808_get_my_effective_active_row_precedence_verification.sql
--   3. 20260808_get_residents_row_by_precedence.sql
--   4. THIS FILE
--
-- Paste WHOLE.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RPC_EXISTS ───────────────────────────────────────────────────
DO $$
DECLARE v_count int; v_secdef boolean; v_volatile "char";
BEGIN
  SELECT COUNT(*), bool_and(prosecdef), max(provolatile)
    INTO v_count, v_secdef, v_volatile
    FROM pg_proc
   WHERE proname = 'get_residents_row_by_precedence'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected 1 get_residents_row_by_precedence(TEXT); got %', v_count;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected SECURITY DEFINER';
  END IF;
  IF v_volatile <> 's' THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected STABLE (s); got %', v_volatile;
  END IF;
END $$;

-- ── VQ.RPC_GRANTS_SERVICE_ROLE_ONLY ─────────────────────────────────
-- The email-parameter DEFINER is a leak footgun if callable by
-- authenticated (any user could pass anyone's email and get back their
-- unit/property). service_role ONLY.
DO $$
DECLARE
  v_has_anon boolean; v_has_authenticated boolean;
  v_has_public boolean; v_has_service_role boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.get_residents_row_by_precedence(text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.get_residents_row_by_precedence(text)', 'EXECUTE'),
    has_function_privilege('public',        'public.get_residents_row_by_precedence(text)', 'EXECUTE'),
    has_function_privilege('service_role',  'public.get_residents_row_by_precedence(text)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated, v_has_public, v_has_service_role;

  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS_SERVICE_ROLE_ONLY: PUBLIC HAS EXECUTE (leak)';
  END IF;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS_SERVICE_ROLE_ONLY: anon HAS EXECUTE (leak)';
  END IF;
  IF v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS_SERVICE_ROLE_ONLY: authenticated HAS EXECUTE (leak — email-param DEFINER)';
  END IF;
  IF NOT v_has_service_role THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS_SERVICE_ROLE_ONLY: service_role MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.RPC_BODY_USES_PRECEDENCE_HELPER ──────────────────────────────
-- Body must ORDER BY resident_row_precedence(status, is_active) —
-- the whole point of routing through the shared helper. Any
-- refactor that inlines the CASE regresses the "one place" lock.
DO $$
DECLARE v_body text; v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_residents_row_by_precedence'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'resident_row_precedence\s*\(\s*status\s*,\s*is_active\s*\)' THEN
    RAISE EXCEPTION 'VQ.RPC_BODY_USES_PRECEDENCE_HELPER: body missing resident_row_precedence(status, is_active) — someone inlined the CASE';
  END IF;
  IF v_body_code !~ 'created_at\s+DESC' THEN
    RAISE EXCEPTION 'VQ.RPC_BODY_USES_PRECEDENCE_HELPER: body missing "created_at DESC" tiebreaker';
  END IF;
END $$;

-- ── VQ.BEHAVIOURAL_PICKS_ACTIVE_ROWS_UNIT_PROPERTY ──────────────────
-- Seed two residents rows for a probe email: one active
-- (unit='UNIT_A'), one declined (unit='UNIT_D'). Call the RPC as-is
-- and assert unit='UNIT_A' — proves the ORDER BY beats arbitrary
-- Postgres row-order. Rolled back at outer ROLLBACK.
DO $$
DECLARE
  v_probe_email    TEXT := '__vq_prec2_08b7c__@example.com';
  v_probe_company  TEXT := '__vq_prec2_company_08b7c__';
  v_probe_property TEXT := '__vq_prec2_property_08b7c__';
  v_row RECORD;
BEGIN
  DELETE FROM public.residents    WHERE lower(email) = lower(v_probe_email);
  DELETE FROM public.properties   WHERE name = v_probe_property;
  DELETE FROM public.companies    WHERE name = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'enforcement_only', 'enforcement', 'active', TRUE);
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_property, v_probe_company, TRUE);

  -- Declined row created FIRST (bare LIMIT 1 without ORDER BY may
  -- pick this one). ORDER BY the helper should ignore this order and
  -- rank the active row first.
  INSERT INTO public.residents (email, name, unit, property, company, status, is_active, created_at)
  VALUES (v_probe_email, 'VQ Probe', 'UNIT_D', v_probe_property, v_probe_company, 'declined', FALSE, now() - interval '2 hours');
  INSERT INTO public.residents (email, name, unit, property, company, status, is_active, created_at)
  VALUES (v_probe_email, 'VQ Probe', 'UNIT_A', v_probe_property, v_probe_company, 'active', TRUE, now());

  SELECT email, unit, property INTO v_row
    FROM public.get_residents_row_by_precedence(v_probe_email);

  IF v_row.unit IS DISTINCT FROM 'UNIT_A' THEN
    RAISE EXCEPTION 'VQ.BEHAVIOURAL_PICKS_ACTIVE_ROWS_UNIT_PROPERTY: expected unit=UNIT_A (active row wins); got unit=%. Bug still live — companion-vehicle would insert against wrong scope.', v_row.unit;
  END IF;
  IF v_row.property IS DISTINCT FROM v_probe_property THEN
    RAISE EXCEPTION 'VQ.BEHAVIOURAL_PICKS_ACTIVE_ROWS_UNIT_PROPERTY: expected property=%, got property=%', v_probe_property, v_row.property;
  END IF;
END $$;

-- ── VQ.BEHAVIOURAL_EMPTY_FOR_UNKNOWN_EMAIL ──────────────────────────
-- No row for a non-existent email → RPC returns zero rows (RETURNS
-- TABLE with LIMIT 1 on an empty result). Proxy handles null; this
-- VQ pins the semantic.
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.get_residents_row_by_precedence('__vq_prec2_no_such_email_ever__@example.com');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VQ.BEHAVIOURAL_EMPTY_FOR_UNKNOWN_EMAIL: expected 0 rows; got %', v_count;
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_RESIDENTS_ROW_BY_PRECEDENCE'
     AND new_values->>'migration' = '20260808_get_residents_row_by_precedence';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

ROLLBACK;
