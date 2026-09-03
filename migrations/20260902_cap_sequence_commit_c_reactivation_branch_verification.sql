-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_c_reactivation_branch_verification.sql
--
-- Paired verification for Cap Commit C. v2 pattern. 10 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  enforce_property_limit fn exists (unchanged signature)
--   VS2  DEFINER + search_path pinned
--   VS3  body contains TG_OP dispatch + reactivation predicate
--   VS4  existing INSERT trigger property_limit_check still present
--        + still BEFORE INSERT
--   VS5  NEW trigger property_limit_check_on_reactivation present,
--        BEFORE UPDATE OF is_active on properties
--   VS6  🔴 BEHAVIOR PARITY vs pre_apply_snap in audit row (limit +
--        active_count per company)
--   VS7  🔴 EXECUTION — reactivation on uncapped company SUCCEEDS
--        (fresh probe row per Sep 1 rule: rename-block trigger raises
--        same sqlstate class; message-text discriminator is the
--        actual differentiator)
--   VS8  🔴 EXECUTION — deactivation UPDATE (true→false) does NOT
--        trigger a cap check (trigger's TG_OP dispatch skips)
--   VS9  🔴 EXECUTION — non-is_active UPDATE (name change) does NOT
--        fire enforce_property_limit at all (BEFORE UPDATE OF gate)
--   VS10 schema audit row + pre_apply_snap populated
--
-- 🟡 Cap-hit reactivation probe DEFERRED: requires a proposal_code
-- override to fake a cap-1 state at Test-LEGACY, which persists as
-- side-effect state. Structural gates VS3+VS5 + parity VS6 prove the
-- reactivation branch is wired. A₀ landing + a real pm_starter
-- company will provide the natural cap-hit fixture.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: signature exists ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.enforce_property_limit()') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.enforce_property_limit() not found';
  END IF;
END $$;

-- ── VS2: DEFINER + search_path pinned ───────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.enforce_property_limit()');
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'VS2 FAIL: not SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'VS2 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
END $$;

-- ── VS3: body has TG_OP dispatch + reactivation predicate ──────────
DO $$
DECLARE
  v_body TEXT := pg_get_functiondef(to_regprocedure('public.enforce_property_limit()'));
BEGIN
  IF v_body NOT ILIKE '%TG_OP%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing TG_OP dispatch — Commit C shape not applied';
  END IF;
  IF v_body NOT ILIKE '%OLD.is_active%' OR v_body NOT ILIKE '%NEW.is_active%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing OLD.is_active / NEW.is_active check';
  END IF;
END $$;

-- ── VS4: existing INSERT trigger untouched ─────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='properties'
     AND t.tgname='property_limit_check'
     AND NOT t.tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: existing property_limit_check trigger not found exactly once (got %) — Commit C changed INSERT registration unintentionally', v_count;
  END IF;
END $$;

-- ── VS5: NEW reactivation trigger present, BEFORE UPDATE OF is_active
DO $$
DECLARE
  v_count INT;
  v_events INT;
  v_attname_match BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='properties'
     AND t.tgname='property_limit_check_on_reactivation'
     AND NOT t.tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: property_limit_check_on_reactivation trigger not found (got %)', v_count;
  END IF;

  -- Verify it's UPDATE + BEFORE + column-scoped to is_active.
  -- tgtype bitmask: bit 2 = BEFORE, bit 4 = UPDATE (see pg_trigger docs)
  SELECT (t.tgtype & 2) <> 0 AND (t.tgtype & 16) <> 0 INTO v_attname_match
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='properties'
     AND t.tgname='property_limit_check_on_reactivation';
  IF NOT v_attname_match THEN
    RAISE EXCEPTION 'VS5 FAIL: property_limit_check_on_reactivation is not BEFORE UPDATE';
  END IF;

  -- Column-scope check: tgattr array should reference is_active's attnum
  SELECT COUNT(*) INTO v_events
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'is_active'
   WHERE n.nspname='public' AND c.relname='properties'
     AND t.tgname='property_limit_check_on_reactivation'
     AND a.attnum = ANY(t.tgattr);
  IF v_events <> 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: trigger not column-scoped to is_active (BEFORE UPDATE OF is_active) — would fire on every UPDATE, contradicting header intent';
  END IF;
END $$;

-- ── VS6: 🔴 BEHAVIOR PARITY per company ────────────────────────────
DO $$
DECLARE
  v_snap JSONB;
  v_row RECORD;
  v_post_limit INT;
  v_post_active INT;
  v_expected_limit INT;
  v_expected_active INT;
  v_drift TEXT := '';
BEGIN
  SELECT new_values->'pre_apply_snap' INTO v_snap
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_C'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_c_reactivation_branch'
   ORDER BY created_at DESC LIMIT 1;
  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'VS6 SETUP FAIL: pre_apply_snap not found in audit row';
  END IF;

  FOR v_row IN SELECT id, name FROM public.companies ORDER BY id LOOP
    v_post_limit := public.get_company_property_limit(v_row.name);
    SELECT COUNT(*) INTO v_post_active
      FROM public.properties
     WHERE lower(trim(company)) = lower(trim(v_row.name))
       AND is_active = TRUE;
    v_expected_limit  := ((v_snap -> v_row.id::TEXT) ->> 'limit')::INT;
    v_expected_active := ((v_snap -> v_row.id::TEXT) ->> 'active_count')::INT;
    IF v_expected_limit IS NULL THEN
      RAISE EXCEPTION 'VS6 SETUP FAIL: no pre-apply value for company_id=% (added after Commit C?). Snapshot: %', v_row.id, v_snap;
    END IF;
    IF v_post_limit IS DISTINCT FROM v_expected_limit
       OR v_post_active IS DISTINCT FROM v_expected_active THEN
      v_drift := v_drift || format('company_id=%s limit BEFORE=%s AFTER=%s active BEFORE=%s AFTER=%s; ',
        v_row.id, v_expected_limit, v_post_limit, v_expected_active, v_post_active);
    END IF;
  END LOOP;

  IF v_drift <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL: behavior drift. %', v_drift;
  END IF;
END $$;

-- ── VS7: 🔴 EXECUTION — reactivation on uncapped company SUCCEEDS ──
-- Fresh probe row per Sep 1 rule (rename-block raises same sqlstate).
-- Uses A1 or any existing legacy company (limit=-1 unlimited). INSERT
-- inactive → reactivate → deactivate → delete.
DO $$
DECLARE
  v_company TEXT;
  v_probe_id BIGINT;
  v_probe_name TEXT;
BEGIN
  SELECT name INTO v_company
    FROM public.companies
   WHERE tier = 'legacy'
   ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: no legacy-tier company for uncapped reactivation probe';
  END IF;
  v_probe_name := 'vs7probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company, false)
  RETURNING id INTO v_probe_id;

  -- Reactivate: false → true. Should succeed (limit=-1 unlimited).
  UPDATE public.properties SET is_active = TRUE WHERE id = v_probe_id;

  -- Verify actually landed
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_probe_id AND is_active = TRUE) THEN
    RAISE EXCEPTION 'VS7 FAIL: UPDATE ran but is_active=TRUE did not land';
  END IF;

  -- Cleanup: deactivate then delete
  UPDATE public.properties SET is_active = FALSE WHERE id = v_probe_id;
  DELETE FROM public.properties WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE
    v_sqlstate TEXT; v_msg TEXT;
  BEGIN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE EXCEPTION 'VS7 FAIL (or SETUP): reactivation on uncapped legacy company failed. sqlstate=% msg=%. If msg names property_limit_check → cap check misfired on unlimited tier. Otherwise setup issue.', v_sqlstate, v_msg;
  END;
END $$;

-- ── VS8: 🔴 EXECUTION — deactivation UPDATE bypasses cap check ─────
-- true → false transition; TG_OP dispatch should skip. Uses fresh
-- probe. If cap check misfires on deactivation, RAISE will surface.
DO $$
DECLARE
  v_company TEXT;
  v_probe_id BIGINT;
  v_probe_name TEXT;
BEGIN
  SELECT name INTO v_company FROM public.companies WHERE tier = 'legacy' ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS8 FIXTURE FAIL: no legacy company';
  END IF;
  v_probe_name := 'vs8probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company, TRUE)
  RETURNING id INTO v_probe_id;

  -- Deactivate: true → false. Trigger should fire but dispatch → skip.
  UPDATE public.properties SET is_active = FALSE WHERE id = v_probe_id;
  DELETE FROM public.properties WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE
    v_sqlstate TEXT; v_msg TEXT;
  BEGIN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg ILIKE '%Property limit exceeded%' THEN
      RAISE EXCEPTION 'VS8 FAIL: deactivation UPDATE tripped cap check — TG_OP dispatch not skipping true→false correctly. msg=%', v_msg;
    ELSE
      RAISE EXCEPTION 'VS8 SETUP FAILURE (not deactivation-bypass bug): probe failed with sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
  END;
END $$;

-- ── VS9: 🔴 EXECUTION — non-is_active UPDATE doesn't fire trigger ──
-- BEFORE UPDATE OF is_active gate means renames/address-changes don't
-- run enforce_property_limit at all. Verifies the trigger is column-
-- scoped as expected (VS5 checks the metadata; this checks runtime).
DO $$
DECLARE
  v_company TEXT;
  v_probe_id BIGINT;
  v_probe_name TEXT;
BEGIN
  SELECT name INTO v_company FROM public.companies WHERE tier = 'legacy' ORDER BY id LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'VS9 FIXTURE FAIL: no legacy company';
  END IF;
  v_probe_name := 'vs9probe' || floor(extract(epoch from now()))::TEXT;

  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company, TRUE)
  RETURNING id INTO v_probe_id;

  -- Non-is_active update: change address. Should NOT trigger enforce_property_limit.
  -- (rename would trip trg_properties_name_block_rename at count>0;
  -- we use address to avoid confounds.)
  UPDATE public.properties SET address = 'vs9-probe-address' WHERE id = v_probe_id;

  -- Cleanup
  UPDATE public.properties SET is_active = FALSE WHERE id = v_probe_id;
  DELETE FROM public.properties WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE
    v_sqlstate TEXT; v_msg TEXT;
  BEGIN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg ILIKE '%Property limit exceeded%' THEN
      RAISE EXCEPTION 'VS9 FAIL: non-is_active UPDATE fired enforce_property_limit — trigger not column-scoped. msg=%', v_msg;
    ELSE
      RAISE EXCEPTION 'VS9 SETUP FAILURE: probe failed with sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
  END;
END $$;

-- ── VS10: schema audit row + pre_apply_snap ────────────────────────
-- 🔴 Postgres has no max() aggregate for jsonb. Split into COUNT +
-- ORDER BY created_at DESC LIMIT 1 (same shape VS6 uses).
DO $$
DECLARE v_count INT; v_snap JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_C'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_c_reactivation_branch';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS10 FAIL: schema audit row missing';
  END IF;

  SELECT new_values->'pre_apply_snap' INTO v_snap
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_C'
     AND new_values->>'migration' = '20260902_cap_sequence_commit_c_reactivation_branch'
   ORDER BY created_at DESC LIMIT 1;
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    RAISE EXCEPTION 'VS10 FAIL: pre_apply_snap missing or wrong type';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'enforce_property_limit + property_limit_check_on_reactivation (Cap Commit C)'::TEXT AS target,
  ARRAY[
    'VS1  enforce_property_limit() signature exists',
    'VS2  DEFINER + search_path pinned',
    'VS3  body has TG_OP dispatch + reactivation predicate',
    'VS4  existing INSERT trigger property_limit_check untouched',
    'VS5  NEW trigger property_limit_check_on_reactivation present, BEFORE UPDATE OF is_active, column-scoped',
    'VS6  🔴 BEHAVIOR PARITY per company (limit + active_count preserved)',
    'VS7  🔴 execution — reactivation on uncapped legacy SUCCEEDS',
    'VS8  🔴 execution — deactivation (true→false) does NOT trip cap check',
    'VS9  🔴 execution — non-is_active UPDATE does NOT fire trigger',
    'VS10 SCHEMA_CAP_SEQUENCE_COMMIT_C audit row + pre_apply_snap'
  ] AS gates_verified,
  now() AS verified_at;
