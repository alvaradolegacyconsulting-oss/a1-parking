-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — companies.bulk_onboarding_enabled
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G4 TESTS THE GUARD'S REASON FOR EXISTING. RLS already limits
-- companies UPDATE to super-admin, so a CA write is refused today by
-- RLS and the guard never fires — which would make a green run prove
-- nothing. So G4 CREATES a temporary permissive UPDATE policy for
-- authenticated (the exact future change we are insuring against),
-- proves the guard refuses anyway, and DROPS the policy again.
--
-- The policy is dropped in an EXCEPTION handler too, so a failure
-- mid-test cannot leave companies writable by every authenticated user.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_co    TEXT;
  v_was   BOOLEAN;
  v_msg   TEXT;
  v_n     INT;
  v_r     JSONB;
  v_adm   TEXT := 'zz-cbo-adm-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'@test.invalid';
BEGIN
  -- ── G1: the column ────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.companies'::regclass
                    AND attname='bulk_onboarding_enabled' AND attnum>0 AND NOT attisdropped) THEN
    v_fail := v_fail || 'G1: companies.bulk_onboarding_enabled is missing';
  ELSE
    IF NOT (SELECT attnotnull FROM pg_attribute
             WHERE attrelid='public.companies'::regclass AND attname='bulk_onboarding_enabled') THEN
      v_fail := v_fail || 'G1: the column is nullable — NULL would be a third state for a two-state switch';
    END IF;
    -- Default FALSE: every existing company must be OFF, or the feature
    -- appears for tenants nobody enabled it for.
    IF EXISTS (SELECT 1 FROM public.companies WHERE bulk_onboarding_enabled) THEN
      v_fail := v_fail || format('G1: 🔴 %s company/companies already have the flag ON. It must default OFF for every tenant.',
        (SELECT count(*) FROM public.companies WHERE bulk_onboarding_enabled));
    END IF;
  END IF;

  -- ── G2: 🔴 the guard must NOT be SECURITY DEFINER ─────────────────
  IF to_regprocedure('public.companies_protected_columns_guard()') IS NULL THEN
    v_fail := v_fail || 'G2: companies_protected_columns_guard() is missing';
  ELSE
    IF (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.companies_protected_columns_guard()')) THEN
      v_fail := v_fail || 'G2: 🔴 the guard is SECURITY DEFINER. current_user then resolves to the OWNER for every caller, so it permits everything while looking installed.';
    END IF;
    -- The array_append lesson, asserted. `v_changed || 'col'` raises
    -- malformed array literal for every caller.
    IF position('array_append(v_changed' IN COALESCE((SELECT prosrc FROM pg_proc
         WHERE oid=to_regprocedure('public.companies_protected_columns_guard()')),'')) = 0 THEN
      v_fail := v_fail || 'G2: the guard does not use array_append — a bare || on an untyped literal raises malformed array literal for EVERY caller';
    END IF;
    -- Asserted by CONTENTS, so a column cannot quietly leave the list.
    IF (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.companies_protected_columns_guard()'))
       !~ 'NEW\.bulk_onboarding_enabled\M\s+IS DISTINCT FROM\s+OLD\.bulk_onboarding_enabled\M' THEN
      v_fail := v_fail || 'G2: bulk_onboarding_enabled is not COMPARED in the guard';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.companies'::regclass
                    AND tgname='companies_protected_columns_guard_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'G2: the guard trigger is not attached';
  END IF;

  -- ── G3: the RPC ───────────────────────────────────────────────────
  IF to_regprocedure('public.set_company_bulk_onboarding(text,boolean)') IS NULL THEN
    v_fail := v_fail || 'G3: set_company_bulk_onboarding is missing';
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.set_company_bulk_onboarding(text,boolean)')) THEN
      v_fail := v_fail || 'G3: the RPC is not SECURITY DEFINER, so it cannot bypass the guard it is the exception to';
    END IF;
    IF has_function_privilege('anon','public.set_company_bulk_onboarding(text,boolean)','EXECUTE') THEN
      v_fail := v_fail || 'G3: 🔴 anon can execute the RPC';
    END IF;
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- EXECUTION
  -- ════════════════════════════════════════════════════════════════
  SELECT name, COALESCE(bulk_onboarding_enabled,FALSE) INTO v_co, v_was
    FROM public.companies WHERE lower(trim(name))='test-legacy' LIMIT 1;
  IF v_co IS NULL THEN
    v_fail := v_fail || 'G4: fixture company Test-LEGACY unresolved — the execution gates did NOT run';
  ELSE
    INSERT INTO public.user_roles (email, role, company, property, is_active)
    VALUES (v_adm, 'admin', v_co, ARRAY[]::TEXT[], TRUE);
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_adm, 'role','authenticated')::TEXT, TRUE);

    -- ── G4a: POSITIVE CONTROL — super-admin can set it via the RPC ──
    v_r := public.set_company_bulk_onboarding(v_co, TRUE);
    IF COALESCE((v_r->>'ok')::BOOLEAN,FALSE) IS NOT TRUE
       OR (SELECT bulk_onboarding_enabled FROM public.companies WHERE name=v_co) IS NOT TRUE THEN
      v_fail := v_fail || format('G4a: 🔴 a super-admin could not turn the flag ON through the RPC: %s', v_r);
    END IF;
    -- and the prior value is recorded, so a re-save is distinguishable
    v_r := public.set_company_bulk_onboarding(v_co, TRUE);
    IF (v_r->>'changed') <> 'false' THEN
      v_fail := v_fail || format('G4b: a re-save must report changed=false; got %s', v_r);
    END IF;

    -- ── G4c: 🔴 THE GUARD, UNDER A TEMPORARY PERMISSIVE POLICY ──────
    -- Without the policy, RLS refuses a CA before the trigger fires and
    -- this would pass for the wrong reason. The policy IS the future
    -- change we are insuring against, so we create it, prove the guard
    -- still refuses, and drop it.
    BEGIN
      CREATE POLICY zz_tmp_ca_update_companies ON public.companies
        FOR UPDATE TO authenticated
        USING (TRUE) WITH CHECK (TRUE);

      SET LOCAL ROLE authenticated;
      v_msg := NULL; v_n := -1;
      BEGIN
        UPDATE public.companies SET bulk_onboarding_enabled = FALSE WHERE name = v_co;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      RESET ROLE;

      IF v_msg IS DISTINCT FROM 'company_protected_column_not_permitted' THEN
        IF v_msg IS NULL AND v_n = 0 THEN
          v_fail := v_fail || 'G4c: the UPDATE matched 0 rows and raised nothing — the temp policy did not take, so the guard was NOT exercised. Do not accept this as a pass.';
        ELSIF v_msg IS NULL THEN
          v_fail := v_fail || format('G4c: 🔴 THE GUARD DID NOT FIRE. With a permissive UPDATE policy an authenticated session changed the flag (%s row(s)) — which is exactly the hole the guard exists for.', v_n);
        ELSE
          v_fail := v_fail || format('G4c: refused, but not by the guard: %L', v_msg);
        END IF;
      END IF;

      -- ── G4d: POSITIVE CONTROL — other columns stay writable ───────
      -- A guard that refused every authenticated UPDATE to companies
      -- would pass G4c and break the super-admin console's company edit.
      SET LOCAL ROLE authenticated;
      v_msg := NULL;
      BEGIN
        UPDATE public.companies SET billing_city = 'ZZGUARD' WHERE name = v_co;
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      RESET ROLE;
      IF v_msg IS NOT NULL THEN
        v_fail := v_fail || format('G4d: 🔴 the guard refused an UNPROTECTED column (%L). It must cover bulk_onboarding_enabled ONLY.', v_msg);
      END IF;

      DROP POLICY IF EXISTS zz_tmp_ca_update_companies ON public.companies;
    EXCEPTION WHEN OTHERS THEN
      -- 🔴 The policy must never survive a failure. An exception here
      -- would otherwise leave companies writable by every authenticated
      -- user — far worse than the failing test.
      RESET ROLE;
      DROP POLICY IF EXISTS zz_tmp_ca_update_companies ON public.companies;
      v_fail := v_fail || format('G4: the execution block errored (%s); the temp policy was dropped', SQLERRM);
    END;

    -- restore everything this block touched
    UPDATE public.companies SET billing_city = 'Houston' WHERE name = v_co AND billing_city = 'ZZGUARD';
    PERFORM public.set_company_bulk_onboarding(v_co, v_was);
    IF (SELECT COALESCE(bulk_onboarding_enabled,FALSE) FROM public.companies WHERE name=v_co) <> v_was THEN
      v_fail := v_fail || format('G5: the flag was left at the wrong value; set it back to %s for %s', v_was, v_co);
    END IF;
    DELETE FROM public.audit_logs WHERE action='COMPANY_BULK_ONBOARDING_SET' AND user_email=v_adm;
    DELETE FROM public.user_roles WHERE email=v_adm;
  END IF;

  -- The temp policy must be gone no matter which path ran.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname='zz_tmp_ca_update_companies') THEN
    DROP POLICY IF EXISTS zz_tmp_ca_update_companies ON public.companies;
    v_fail := v_fail || 'G5: 🔴 the temporary permissive policy survived the run. It has been dropped now, but find out why.';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'companies bulk_onboarding_enabled'::TEXT AS target,
  'PASS'::TEXT                              AS result,
  (SELECT prosecdef FROM pg_proc
    WHERE oid=to_regprocedure('public.companies_protected_columns_guard()'))       AS guard_definer_want_false,
  (SELECT count(*) FROM public.companies)                                          AS companies,
  (SELECT count(*) FROM public.companies WHERE bulk_onboarding_enabled)            AS flag_on_want_0,
  (SELECT count(*) FROM pg_policy WHERE polname='zz_tmp_ca_update_companies')       AS temp_policy_want_0,
  (SELECT count(*) FROM pg_policy WHERE polrelid='public.companies'::regclass)      AS companies_policies_want_3,
  'G4 EXECUTED: super-admin sets the flag through the RPC and a re-save reports changed=false; then under a TEMPORARY permissive UPDATE policy an authenticated session is still refused by the guard, an unprotected column stays writable, and the policy is dropped on every path including failure.'::TEXT AS execution_proof;
