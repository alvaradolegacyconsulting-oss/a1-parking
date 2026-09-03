-- ══════════════════════════════════════════════════════════════════════
-- 20260903_track_gating_write_path_gates_verification.sql
--
-- Paired verification for the track-gating write-path gates
-- (Commit 2 of 2). v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT
-- returns PASS row). 9 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  all 8 fns exist via to_regprocedure (structural OID)
--   VS2  all 8 SECURITY DEFINER + search_path pinned
--   VS3  all 8 bodies contain my_tier_enforcement_capable + tier_not_permitted
--   VS4  SCHEMA_TRACK_GATING_WRITE_PATH_GATES audit row present with snapshot
--   VS5  🔴 EXECUTION — pm_only OR pm_starter tenant → tier_not_permitted RAISED
--   VS6  🔴 EXECUTION LOAD-BEARING — A1 (legacy) → NO tier_not_permitted
--   VS7  🔴 EXECUTION — enforcement_only tenant → NO tier_not_permitted
--   VS8  🔴 EXECUTION — pm_only tenant (specific) → tier_not_permitted RAISED
--   VS9  PASS row
--
-- ── FIXTURE STRATEGY (VS5–VS8) ──────────────────────────────────────
-- For each tier under test, SELECT a user_roles row whose role passes
-- the strictest of the 8 fns' role gates. Two fns are company_admin-
-- only (set_violation_status, update_my_company_tdlr), so a
-- company_admin from the target tenant is the universal fixture.
--
-- Fixture resolution:
--   • Prefer role='company_admin' + is_active=TRUE.
--   • Skip the gate with NOTICE if no CA exists for the tier (except
--     VS6 — A1 CA missing raises FIXTURE FAIL because VS6 is
--     load-bearing).
--
-- ── CALL SHAPES ──────────────────────────────────────────────────────
-- Each fn called with type-correct placeholder inputs — INTs = 1,
-- TEXTs = 'probe' (except regenerate's p_reason which validates
-- against a fixed list; using 'other' + short note is fine — the
-- reason validation happens AFTER the tier gate in the new order,
-- so it never fires for VS5/VS8. For VS6/VS7 it may fire; that's
-- fine — we only assert ABSENCE of tier_not_permitted).
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: all 8 fns exist ────────────────────────────────────────────
DO $vs1$
DECLARE
  v_sig TEXT;
  v_missing TEXT := '';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
    'public.set_violation_status(bigint, text)',
    'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
    'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
    'public.void_violation(bigint, text)',
    'public.set_violation_view_token(bigint)',
    'public.set_driver_regenerate_permission(text, boolean)',
    'public.update_my_company_tdlr(text)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_missing := v_missing || v_sig || '; ';
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'VS1 FAIL: missing fn(s): %', v_missing;
  END IF;
END $vs1$;


-- ── VS2: all 8 SECURITY DEFINER + search_path pinned ────────────────
DO $vs2$
DECLARE
  v_sig TEXT;
  v_oid oid;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
    'public.set_violation_status(bigint, text)',
    'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
    'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
    'public.void_violation(bigint, text)',
    'public.set_violation_view_token(bigint)',
    'public.set_driver_regenerate_permission(text, boolean)',
    'public.update_my_company_tdlr(text)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc WHERE oid = v_oid;
    IF NOT COALESCE(v_secdef, false) THEN
      RAISE EXCEPTION 'VS2 FAIL: % not SECURITY DEFINER', v_sig;
    END IF;
    IF v_config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'VS2 FAIL: % search_path not pinned. proconfig=%', v_sig, v_config;
    END IF;
  END LOOP;
END $vs2$;


-- ── VS3: all 8 bodies contain gate substrings ───────────────────────
DO $vs3$
DECLARE
  v_sig TEXT;
  v_body TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
    'public.set_violation_status(bigint, text)',
    'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
    'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
    'public.void_violation(bigint, text)',
    'public.set_violation_view_token(bigint)',
    'public.set_driver_regenerate_permission(text, boolean)',
    'public.update_my_company_tdlr(text)'
  ] LOOP
    v_body := pg_get_functiondef(to_regprocedure(v_sig));
    IF v_body NOT LIKE '%my_tier_enforcement_capable%' THEN
      RAISE EXCEPTION 'VS3 FAIL: % body missing my_tier_enforcement_capable substring', v_sig;
    END IF;
    IF v_body NOT LIKE '%tier_not_permitted%' THEN
      RAISE EXCEPTION 'VS3 FAIL: % body missing tier_not_permitted substring', v_sig;
    END IF;
  END LOOP;
END $vs3$;


-- ── VS4: schema audit row + snapshot present ────────────────────────
DO $vs4$
DECLARE v_count INT; v_snap JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TRACK_GATING_WRITE_PATH_GATES'
     AND new_values ->> 'migration' = '20260903_track_gating_write_path_gates';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: schema audit row missing';
  END IF;

  SELECT new_values -> 'pre_apply_snap' INTO v_snap
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TRACK_GATING_WRITE_PATH_GATES'
     AND new_values ->> 'migration' = '20260903_track_gating_write_path_gates'
   ORDER BY created_at DESC LIMIT 1;
  IF v_snap IS NULL OR jsonb_typeof(v_snap) <> 'object' THEN
    RAISE EXCEPTION 'VS4 FAIL: pre_apply_snap missing or wrong shape in audit row';
  END IF;
END $vs4$;


-- ══════════════════════════════════════════════════════════════════════
-- VS5 — 🔴 EXECUTION: pm_only OR pm_starter → tier_not_permitted
-- ══════════════════════════════════════════════════════════════════════
-- Picks a company_admin from any pm_only or pm_starter tenant, impersonates,
-- iterates all 8 fns with placeholder inputs, asserts every fn RAISES with
-- tier_not_permitted in SQLERRM.
DO $vs5$
DECLARE
  v_email      TEXT;
  v_tier       TEXT;
  v_company    TEXT;
  v_fn         TEXT;
  v_msg        TEXT;
  v_offenders  TEXT := '';
BEGIN
  SELECT ur.email, c.tier, c.name
    INTO v_email, v_tier, v_company
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ur.role = 'company_admin'
     AND ur.is_active = TRUE
     AND c.tier IN ('pm_only', 'pm_starter')
   ORDER BY ur.id
   LIMIT 1;

  IF v_email IS NULL THEN
    RAISE NOTICE 'VS5 SKIP: no active company_admin in any pm_only/pm_starter tenant. Cannot exercise gate.';
    RETURN;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'driver_create_violation_with_snapshot',
    'set_violation_status',
    'stamp_tow_ticket',
    'regenerate_tow_ticket',
    'void_violation',
    'set_violation_view_token',
    'set_driver_regenerate_permission',
    'update_my_company_tdlr'
  ] LOOP
    -- Re-impersonate before each call (LOCAL=true auto-resets at DO block end)
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
    PERFORM set_config('role', 'authenticated', true);

    v_msg := '<no_raise>';
    BEGIN
      IF v_fn = 'driver_create_violation_with_snapshot' THEN
        PERFORM public.driver_create_violation_with_snapshot('{}'::jsonb, '{}'::jsonb);
      ELSIF v_fn = 'set_violation_status' THEN
        PERFORM public.set_violation_status(1::BIGINT, 'probe');
      ELSIF v_fn = 'stamp_tow_ticket' THEN
        PERFORM public.stamp_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC);
      ELSIF v_fn = 'regenerate_tow_ticket' THEN
        PERFORM public.regenerate_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC, 'other'::TEXT, 'probe'::TEXT);
      ELSIF v_fn = 'void_violation' THEN
        PERFORM public.void_violation(1::BIGINT, 'probe');
      ELSIF v_fn = 'set_violation_view_token' THEN
        PERFORM public.set_violation_view_token(1::BIGINT);
      ELSIF v_fn = 'set_driver_regenerate_permission' THEN
        PERFORM public.set_driver_regenerate_permission('probe@example.com', false);
      ELSIF v_fn = 'update_my_company_tdlr' THEN
        PERFORM public.update_my_company_tdlr('probe');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;

    EXECUTE 'RESET role';

    IF v_msg NOT LIKE '%tier_not_permitted%' THEN
      v_offenders := v_offenders || format(
        '%s: expected tier_not_permitted RAISE, got %L; ',
        v_fn, v_msg
      );
    END IF;
  END LOOP;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS5 FAIL — pm_only/pm_starter tenant (email=% company=% tier=%): %', v_email, v_company, v_tier, v_offenders;
  END IF;
END $vs5$;


-- ══════════════════════════════════════════════════════════════════════
-- VS6 — 🔴 EXECUTION LOAD-BEARING: A1 (legacy) → NO tier_not_permitted
-- ══════════════════════════════════════════════════════════════════════
-- Impersonates an A1 (legacy) company_admin, iterates all 8 fns.
-- Fns may raise for other reasons (not_found, invalid input, etc.) —
-- that's fine. We assert the ABSENCE of tier_not_permitted specifically.
-- If A1 fires tier_not_permitted, the legacy branch is broken and A1
-- loses enforcement.
DO $vs6$
DECLARE
  v_a1_name    TEXT;
  v_a1_email   TEXT;
  v_fn         TEXT;
  v_msg        TEXT;
  v_offenders  TEXT := '';
  v_seen       TEXT := '';
BEGIN
  SELECT name INTO v_a1_name
    FROM public.companies
   WHERE tier = 'legacy' AND lower(name) LIKE '%a1%'
   ORDER BY id LIMIT 1;
  IF v_a1_name IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no legacy-tier company matching A1 found.';
  END IF;

  SELECT email INTO v_a1_email
    FROM public.user_roles
   WHERE lower(trim(company)) = lower(trim(v_a1_name))
     AND role = 'company_admin'
     AND is_active = TRUE
   ORDER BY id LIMIT 1;
  IF v_a1_email IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: A1 (company=%) has no active company_admin. Cannot impersonate to exercise all 8 role gates.', v_a1_name;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'driver_create_violation_with_snapshot',
    'set_violation_status',
    'stamp_tow_ticket',
    'regenerate_tow_ticket',
    'void_violation',
    'set_violation_view_token',
    'set_driver_regenerate_permission',
    'update_my_company_tdlr'
  ] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_a1_email)::TEXT, true);
    PERFORM set_config('role', 'authenticated', true);

    v_msg := '<no_raise>';
    BEGIN
      IF v_fn = 'driver_create_violation_with_snapshot' THEN
        PERFORM public.driver_create_violation_with_snapshot('{}'::jsonb, '{}'::jsonb);
      ELSIF v_fn = 'set_violation_status' THEN
        PERFORM public.set_violation_status(1::BIGINT, 'probe');
      ELSIF v_fn = 'stamp_tow_ticket' THEN
        PERFORM public.stamp_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC);
      ELSIF v_fn = 'regenerate_tow_ticket' THEN
        PERFORM public.regenerate_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC, 'other'::TEXT, 'probe'::TEXT);
      ELSIF v_fn = 'void_violation' THEN
        PERFORM public.void_violation(1::BIGINT, 'probe');
      ELSIF v_fn = 'set_violation_view_token' THEN
        PERFORM public.set_violation_view_token(1::BIGINT);
      ELSIF v_fn = 'set_driver_regenerate_permission' THEN
        PERFORM public.set_driver_regenerate_permission('probe@example.com', false);
      ELSIF v_fn = 'update_my_company_tdlr' THEN
        PERFORM public.update_my_company_tdlr('probe');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;

    EXECUTE 'RESET role';

    -- Record what came back (for visibility on the noticed RAISE row)
    v_seen := v_seen || format('%s → %L; ', v_fn, v_msg);

    IF v_msg LIKE '%tier_not_permitted%' THEN
      v_offenders := v_offenders || format(
        '%s: A1 hit tier_not_permitted (LEGACY BRANCH BROKEN — msg=%L); ',
        v_fn, v_msg
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'VS6 A1 legacy per-fn results (email=%): %', v_a1_email, v_seen;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL — A1 (legacy) hit tier_not_permitted: %', v_offenders;
  END IF;
END $vs6$;


-- ══════════════════════════════════════════════════════════════════════
-- VS7 — 🔴 EXECUTION: enforcement_only → NO tier_not_permitted
-- ══════════════════════════════════════════════════════════════════════
DO $vs7$
DECLARE
  v_email      TEXT;
  v_company    TEXT;
  v_fn         TEXT;
  v_msg        TEXT;
  v_offenders  TEXT := '';
BEGIN
  SELECT ur.email, c.name
    INTO v_email, v_company
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ur.role = 'company_admin'
     AND ur.is_active = TRUE
     AND c.tier = 'enforcement_only'
   ORDER BY ur.id
   LIMIT 1;

  IF v_email IS NULL THEN
    RAISE NOTICE 'VS7 SKIP: no active company_admin in any enforcement_only tenant.';
    RETURN;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'driver_create_violation_with_snapshot',
    'set_violation_status',
    'stamp_tow_ticket',
    'regenerate_tow_ticket',
    'void_violation',
    'set_violation_view_token',
    'set_driver_regenerate_permission',
    'update_my_company_tdlr'
  ] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
    PERFORM set_config('role', 'authenticated', true);

    v_msg := '<no_raise>';
    BEGIN
      IF v_fn = 'driver_create_violation_with_snapshot' THEN
        PERFORM public.driver_create_violation_with_snapshot('{}'::jsonb, '{}'::jsonb);
      ELSIF v_fn = 'set_violation_status' THEN
        PERFORM public.set_violation_status(1::BIGINT, 'probe');
      ELSIF v_fn = 'stamp_tow_ticket' THEN
        PERFORM public.stamp_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC);
      ELSIF v_fn = 'regenerate_tow_ticket' THEN
        PERFORM public.regenerate_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC, 'other'::TEXT, 'probe'::TEXT);
      ELSIF v_fn = 'void_violation' THEN
        PERFORM public.void_violation(1::BIGINT, 'probe');
      ELSIF v_fn = 'set_violation_view_token' THEN
        PERFORM public.set_violation_view_token(1::BIGINT);
      ELSIF v_fn = 'set_driver_regenerate_permission' THEN
        PERFORM public.set_driver_regenerate_permission('probe@example.com', false);
      ELSIF v_fn = 'update_my_company_tdlr' THEN
        PERFORM public.update_my_company_tdlr('probe');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;

    EXECUTE 'RESET role';

    IF v_msg LIKE '%tier_not_permitted%' THEN
      v_offenders := v_offenders || format(
        '%s: enforcement_only hit tier_not_permitted (msg=%L); ',
        v_fn, v_msg
      );
    END IF;
  END LOOP;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS7 FAIL — enforcement_only tenant (email=% company=%) hit tier_not_permitted: %', v_email, v_company, v_offenders;
  END IF;
END $vs7$;


-- ══════════════════════════════════════════════════════════════════════
-- VS8 — 🔴 EXECUTION: pm_only (specifically) → tier_not_permitted
-- ══════════════════════════════════════════════════════════════════════
DO $vs8$
DECLARE
  v_email      TEXT;
  v_company    TEXT;
  v_fn         TEXT;
  v_msg        TEXT;
  v_offenders  TEXT := '';
BEGIN
  SELECT ur.email, c.name
    INTO v_email, v_company
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ur.role = 'company_admin'
     AND ur.is_active = TRUE
     AND c.tier = 'pm_only'
   ORDER BY ur.id
   LIMIT 1;

  IF v_email IS NULL THEN
    RAISE NOTICE 'VS8 SKIP: no active company_admin in any pm_only tenant.';
    RETURN;
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'driver_create_violation_with_snapshot',
    'set_violation_status',
    'stamp_tow_ticket',
    'regenerate_tow_ticket',
    'void_violation',
    'set_violation_view_token',
    'set_driver_regenerate_permission',
    'update_my_company_tdlr'
  ] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
    PERFORM set_config('role', 'authenticated', true);

    v_msg := '<no_raise>';
    BEGIN
      IF v_fn = 'driver_create_violation_with_snapshot' THEN
        PERFORM public.driver_create_violation_with_snapshot('{}'::jsonb, '{}'::jsonb);
      ELSIF v_fn = 'set_violation_status' THEN
        PERFORM public.set_violation_status(1::BIGINT, 'probe');
      ELSIF v_fn = 'stamp_tow_ticket' THEN
        PERFORM public.stamp_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC);
      ELSIF v_fn = 'regenerate_tow_ticket' THEN
        PERFORM public.regenerate_tow_ticket(1::BIGINT, 1::BIGINT, 1::NUMERIC, 'other'::TEXT, 'probe'::TEXT);
      ELSIF v_fn = 'void_violation' THEN
        PERFORM public.void_violation(1::BIGINT, 'probe');
      ELSIF v_fn = 'set_violation_view_token' THEN
        PERFORM public.set_violation_view_token(1::BIGINT);
      ELSIF v_fn = 'set_driver_regenerate_permission' THEN
        PERFORM public.set_driver_regenerate_permission('probe@example.com', false);
      ELSIF v_fn = 'update_my_company_tdlr' THEN
        PERFORM public.update_my_company_tdlr('probe');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;

    EXECUTE 'RESET role';

    IF v_msg NOT LIKE '%tier_not_permitted%' THEN
      v_offenders := v_offenders || format(
        '%s: expected tier_not_permitted RAISE, got %L; ',
        v_fn, v_msg
      );
    END IF;
  END LOOP;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS8 FAIL — pm_only tenant (email=% company=%): %', v_email, v_company, v_offenders;
  END IF;
END $vs8$;


-- ══════════════════════════════════════════════════════════════════════
-- VS9 — PASS row
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'track gating write-path gates (8 enforcement RPCs)'::TEXT AS target,
  ARRAY[
    'VS1  all 8 fns exist via to_regprocedure',
    'VS2  all 8 SECURITY DEFINER + search_path pinned',
    'VS3  all 8 bodies contain my_tier_enforcement_capable + tier_not_permitted',
    'VS4  SCHEMA_TRACK_GATING_WRITE_PATH_GATES audit row + pre_apply_snap present',
    'VS5  🔴 execution — pm_only/pm_starter CA → tier_not_permitted RAISED (or SKIP)',
    'VS6  🔴 execution LOAD-BEARING — A1 (legacy) CA → NO tier_not_permitted',
    'VS7  🔴 execution — enforcement_only CA → NO tier_not_permitted (or SKIP)',
    'VS8  🔴 execution — pm_only CA → tier_not_permitted RAISED (or SKIP)',
    'VS9  PASS row'
  ] AS gates_verified,
  now() AS verified_at;
