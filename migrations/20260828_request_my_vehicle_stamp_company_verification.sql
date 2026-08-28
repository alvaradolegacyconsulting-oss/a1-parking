-- ══════════════════════════════════════════════════════════════════════
-- 20260828_request_my_vehicle_stamp_company_verification.sql
--
-- Post-apply verification for 20260828_request_my_vehicle_stamp_company.
-- v2 pattern:
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with status='PASS' on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 7 gates:
--   G1 function exists with 6-param signature intact
--   G2 SECURITY DEFINER + search_path pinned + LANGUAGE plpgsql
--      (all three attributes preserved through CREATE OR REPLACE)
--   G3 RETURNS BIGINT (return type unchanged)
--   G4 grants preserved: PUBLIC=0, anon=0, authenticated=1 (CREATE OR
--      REPLACE preserves grants; if this fails, the reissue slot is
--      needed and grants were silently wiped)
--   G5 body-delta assertions — BOTH must be present:
--        (a) SELECT includes company (via `company INTO v_company` OR
--            equivalent — we match the DECLARE literal)
--        (b) INSERT column list includes company
--   G6 schema audit row present (SCHEMA_REQUEST_MY_VEHICLE_STAMP_COMPANY)
--   G7 🔴 EXECUTION — impersonate a resident whose residents row has
--      company populated, call the RPC, assert the inserted vehicle
--      row carries company matching residents.company. Then DELETE
--      the probe row. Per Mateo Aug 28 §C: assertion is "correct
--      company," not "company present."
--
-- 🔴 JWT IMPERSONATION IS REQUIRED HERE — request_my_vehicle reads
-- auth.jwt() ->> 'email' AND is authenticated-scoped. Without
-- impersonation the RPC hits 'account_deactivated' (get_my_effective_
-- active returns FALSE on NULL email) or the resident-role gate
-- before its body executes.
--
-- Probe cleanup: DELETE the inserted row from vehicles regardless of
-- assertion pass/fail (finally-block equivalent via nested EXCEPTION).
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_body           TEXT;
  v_args           TEXT;
  v_lang           TEXT;
  v_prosecdef      BOOLEAN;
  v_proconfig      TEXT[];
  v_rettype        TEXT;
  v_grants_public  INT;
  v_grants_anon    INT;
  v_grants_authed  INT;
  v_audit_count    INT;
BEGIN
  -- ── G1 signature ─────────────────────────────────────────────────
  SELECT pg_get_function_arguments(p.oid)
    INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'request_my_vehicle';
  IF v_args IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.request_my_vehicle not found';
  END IF;
  IF v_args NOT ILIKE '%p_plate%text%p_state%text%p_make%text%p_model%text%p_year%integer%p_color%text%' THEN
    RAISE EXCEPTION 'G1 FAIL: 6-param signature mismatch. Got [%]', v_args;
  END IF;

  -- ── G2 DEFINER + search_path + LANGUAGE plpgsql ─────────────────
  SELECT p.prosecdef, p.proconfig, l.lanname
    INTO v_prosecdef, v_proconfig, v_lang
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname = 'request_my_vehicle';
  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'G2 FAIL: prosecdef must be TRUE; got %', v_prosecdef;
  END IF;
  IF v_proconfig IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(v_proconfig) AS s WHERE s ILIKE 'search_path=%') THEN
    RAISE EXCEPTION 'G2 FAIL: search_path not pinned; proconfig=%', v_proconfig;
  END IF;
  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'G2 FAIL: expected LANGUAGE plpgsql; got %', v_lang;
  END IF;

  -- ── G3 RETURNS BIGINT ────────────────────────────────────────────
  SELECT pg_catalog.format_type(p.prorettype, NULL)
    INTO v_rettype
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'request_my_vehicle';
  IF v_rettype <> 'bigint' THEN
    RAISE EXCEPTION 'G3 FAIL: expected RETURNS bigint; got %', v_rettype;
  END IF;

  -- ── G4 grants preserved ──────────────────────────────────────────
  SELECT
    COUNT(*) FILTER (WHERE grantee = 'PUBLIC'         AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'anon'           AND privilege_type = 'EXECUTE'),
    COUNT(*) FILTER (WHERE grantee = 'authenticated'  AND privilege_type = 'EXECUTE')
    INTO v_grants_public, v_grants_anon, v_grants_authed
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
     AND routine_name   = 'request_my_vehicle';
  IF v_grants_public <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: PUBLIC EXECUTE grant present (count=%); CREATE OR REPLACE should have preserved the REVOKE', v_grants_public;
  END IF;
  IF v_grants_anon <> 0 THEN
    RAISE EXCEPTION 'G4 FAIL: anon EXECUTE grant present (count=%); CREATE OR REPLACE should have preserved the REVOKE', v_grants_anon;
  END IF;
  IF v_grants_authed <> 1 THEN
    RAISE EXCEPTION 'G4 FAIL: authenticated EXECUTE grant count=% (want 1); CREATE OR REPLACE should have preserved this', v_grants_authed;
  END IF;

  -- ── G5 body-delta assertions (both must be present) ──────────────
  SELECT pg_get_functiondef(p.oid)
    INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'request_my_vehicle';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'G5 FAIL: could not resolve function definition';
  END IF;
  -- (a) SELECT must resolve company from residents
  IF v_body NOT ILIKE '%v_company%TEXT%' THEN
    RAISE EXCEPTION 'G5 FAIL(a): v_company TEXT DECLARE missing from body — SELECT would have nothing to store residents.company into';
  END IF;
  IF v_body NOT ILIKE '%SELECT property, unit, company INTO v_property, v_unit, v_company%' THEN
    RAISE EXCEPTION 'G5 FAIL(a): SELECT residents (property, unit, company) not present in body — INSERT would stamp NULL company';
  END IF;
  -- (b) INSERT column list must include company
  IF v_body NOT ILIKE '%INSERT INTO public.vehicles%company%is_active%' THEN
    RAISE EXCEPTION 'G5 FAIL(b): INSERT column list does not include company between resident_email and is_active';
  END IF;

  -- ── G6 schema audit row ──────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_REQUEST_MY_VEHICLE_STAMP_COMPANY'
     AND new_values->>'migration' = '20260828_request_my_vehicle_stamp_company';
  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G6 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 6 structural gates passed. G7 execution gate next.';
END $$;

-- ── G7 EXECUTION — impersonate resident, call RPC, assert + cleanup
-- 🔴 JWT impersonation required. request_my_vehicle:
--   - Reads auth.jwt() ->> 'email' → NULL in SQL Editor without
--     impersonation → account_deactivated exception fires first.
--   - Also has a caller-role gate requiring role='resident'.
-- We must impersonate a real resident whose residents row has
-- company populated. Same set_config('request.jwt.claims',…, TRUE)
-- discipline as feedback_rpc_verification_must_include_execution_gate.
-- Probe cleanup uses BEGIN/EXCEPTION/END nested block so a mid-run
-- failure still deletes the vehicle row before re-raising.
DO $$
DECLARE
  v_resident_email    TEXT;
  v_expected_company  TEXT;
  v_expected_property TEXT;
  v_expected_unit     TEXT;
  v_new_vehicle_id    BIGINT;
  v_probe_plate       TEXT := 'G7PROBE' || floor(extract(epoch from now()))::TEXT;
  v_actual_company    TEXT;
  v_actual_property   TEXT;
BEGIN
  -- Pick any ACTIVE resident with company populated. Must be effective-
  -- active so get_my_effective_active() returns TRUE. Constraints:
  --   - residents.is_active = TRUE
  --   - residents.company IS NOT NULL and non-blank
  --   - user_roles row for this email with role='resident' and is_active=TRUE
  -- Additionally the resident's company + property must be effective-
  -- active (companies.account_state='active', properties.is_active=TRUE).
  SELECT lower(r.email), r.company, r.property, r.unit
    INTO v_resident_email, v_expected_company, v_expected_property, v_expected_unit
    FROM public.residents r
    JOIN public.user_roles ur ON lower(ur.email) = lower(r.email)
      AND ur.role = 'resident' AND ur.is_active = TRUE
    JOIN public.companies c ON lower(trim(c.name)) = lower(trim(r.company))
      AND c.account_state = 'active' AND c.is_active = TRUE
    JOIN public.properties p ON lower(trim(p.name)) = lower(trim(r.property))
      AND p.is_active = TRUE
   WHERE r.is_active = TRUE
     AND r.company IS NOT NULL AND length(trim(r.company)) > 0
     AND r.property IS NOT NULL
     AND r.unit IS NOT NULL
   ORDER BY r.id
   LIMIT 1;
  IF v_resident_email IS NULL THEN
    RAISE EXCEPTION 'G7 PREREQ FAIL: no eligible effective-active resident with company populated to probe execution gate';
  END IF;

  -- Impersonate the resident's JWT claims
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('email', v_resident_email, 'role', 'authenticated')::text,
    TRUE
  );

  BEGIN
    -- Call the RPC with harmless probe data
    SELECT public.request_my_vehicle(
      v_probe_plate,        -- p_plate
      'TX',                 -- p_state
      'Probe',              -- p_make
      'Gate',               -- p_model
      2020,                 -- p_year
      'Silver'              -- p_color
    ) INTO v_new_vehicle_id;

    IF v_new_vehicle_id IS NULL THEN
      RAISE EXCEPTION 'G7 EXECUTION FAIL: request_my_vehicle returned NULL id';
    END IF;

    -- Read back the inserted row
    SELECT company, property
      INTO v_actual_company, v_actual_property
      FROM public.vehicles
     WHERE id = v_new_vehicle_id;

    -- Assertions
    IF v_actual_property IS DISTINCT FROM v_expected_property THEN
      RAISE EXCEPTION 'G7 EXECUTION FAIL: inserted vehicle property=% but resident row property=%',
        v_actual_property, v_expected_property;
    END IF;
    IF v_actual_company IS NULL OR length(trim(v_actual_company)) = 0 THEN
      RAISE EXCEPTION 'G7 EXECUTION FAIL: inserted vehicle has NULL/blank company (expected %) — RPC did not stamp company from residents row',
        v_expected_company;
    END IF;
    IF v_actual_company IS DISTINCT FROM v_expected_company THEN
      RAISE EXCEPTION 'G7 EXECUTION FAIL: inserted vehicle company=% but expected % (from residents row for %)',
        v_actual_company, v_expected_company, v_resident_email;
    END IF;

    RAISE NOTICE 'G7 execution: probe resident=% → vehicle id=% property=% company=% (matches residents row). Cleaning up.',
      v_resident_email, v_new_vehicle_id, v_actual_property, v_actual_company;

    -- Cleanup on success
    DELETE FROM public.vehicles WHERE id = v_new_vehicle_id;

  EXCEPTION WHEN OTHERS THEN
    -- Cleanup on failure — attempt delete then re-raise
    IF v_new_vehicle_id IS NOT NULL THEN
      DELETE FROM public.vehicles WHERE id = v_new_vehicle_id;
      RAISE NOTICE 'G7 execution failed; probe vehicle id=% deleted before re-raise.', v_new_vehicle_id;
    END IF;
    RAISE;
  END;
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
SELECT
  'PASS'::TEXT                                                   AS status,
  'request_my_vehicle — stamp company on INSERT'::TEXT           AS target,
  '7 gates: signature / DEFINER+searchpath+LANG / RETURNS bigint / grants preserved / body-delta (SELECT+INSERT include company) / audit / EXECUTION (real resident probe, company stamped matches residents row, probe row deleted)'::TEXT AS gates,
  now()                                                          AS verified_at;
