-- ══════════════════════════════════════════════════════════════════════
-- 20260904_violations_column_grant_tightening_verification.sql
--
-- Paired verification for Commit 3 Commit C. v2 pattern (no
-- BEGIN/COMMIT wrap; terminal SELECT returns PASS row). 9 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  INSERT grant surface — authenticated has EXACTLY the 19
--        allowlist columns
--   VS2  UPDATE grant surface — authenticated has EXACTLY is_confirmed
--   VS3  🔴 EXECUTION — direct INSERT of tow_ticket_generated as
--        authenticated → "permission denied for table violations"
--        (Postgres reports table-level even for column-scoped denials;
--        empirically confirmed 2026-09-04 by R1/R2 probes)
--   VS4  🔴 EXECUTION — direct UPDATE of status as authenticated →
--        "permission denied for table violations"
--   VS5  🔴 LOAD-BEARING — DEFINER RPC (void_violation) still works;
--        DEFINER-runs-as-owner premise verified
--   VS6  service_role posture unchanged (INSERT + UPDATE full grants)
--   VS7  anon posture unchanged (no grants beyond baseline)
--   VS8  DELETE policies still 3 + gated by is_confirmed (post-apply
--        parity vs Part 1 pre-flight)
--   VS9  audit row present
--
-- ── SESSION-RESET DISCIPLINE ────────────────────────────────────────
-- VS3/VS4/VS5 impersonate real users via set_config; each uses
-- `EXECUTE 'RESET role'` after (per Sep 3 followup §1 fix — never
-- `set_config('role', '', true)`).
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: INSERT grant surface ═══════════════════════════════════════
-- information_schema.column_privileges lists per-column grants.
-- authenticated should have INSERT on exactly the 19 allowlist columns
-- and NOTHING else.
DO $vs1$
DECLARE
  v_expected TEXT[] := ARRAY[
    'plate','violation_type','location','notes','property',
    'driver_name','driver_license','video_url',
    'vehicle_color','vehicle_make','vehicle_model','vehicle_year',
    'is_confirmed',
    'was_authorized_at_time','decline_reason','decline_reason_note',
    'scanned_at','headline_status_at_scan',
    'snapshot_status'
  ];
  v_actual TEXT[];
  v_missing TEXT[];
  v_extra TEXT[];
BEGIN
  SELECT array_agg(column_name::TEXT ORDER BY column_name)
    INTO v_actual
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'violations'
     AND grantee = 'authenticated'
     AND privilege_type = 'INSERT';

  IF v_actual IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: authenticated has NO column-level INSERT grants on violations. Commit C over-revoked.';
  END IF;

  SELECT array_agg(c) INTO v_missing FROM unnest(v_expected) c
   WHERE c <> ALL (v_actual);
  SELECT array_agg(c) INTO v_extra FROM unnest(v_actual) c
   WHERE c <> ALL (v_expected);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: authenticated MISSING INSERT grant on allowlist columns: %', v_missing;
  END IF;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: authenticated has UNEXPECTED INSERT grant on non-allowlist columns (mass-assignment surface still open): %', v_extra;
  END IF;
END $vs1$;


-- ── VS2: UPDATE grant surface ═══════════════════════════════════════
DO $vs2$
DECLARE v_actual TEXT[];
BEGIN
  SELECT array_agg(column_name::TEXT ORDER BY column_name)
    INTO v_actual
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'violations'
     AND grantee = 'authenticated'
     AND privilege_type = 'UPDATE';

  IF v_actual IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: authenticated has NO UPDATE grants — over-revoked (is_confirmed confirm step will break)';
  END IF;
  IF v_actual <> ARRAY['is_confirmed']::TEXT[] THEN
    RAISE EXCEPTION 'VS2 FAIL: authenticated UPDATE grants = % (want exactly [is_confirmed])', v_actual;
  END IF;
END $vs2$;


-- ── VS3: 🔴 EXECUTION — direct INSERT of revoked column REJECTS ═══
-- Impersonate a CA + attempt INSERT with tow_ticket_generated. Should
-- fail with sqlstate 42501 msg="permission denied for table violations".
--
-- 🔴 2026-09-04 message-shape correction: prior version asserted
-- "permission denied for COLUMN X". Empirically wrong (R1 probe).
-- Postgres reports at TABLE level for INSERT and UPDATE denials
-- even when the cause is a missing per-column grant. The column-
-- named form ("permission denied for column X") appears in some
-- other privilege paths (e.g. SELECT of a column the user can't
-- read within a table they otherwise can) but NOT here.
--
-- Postgres's own HINT on this error suggests
-- "GRANT INSERT ON public.violations TO authenticated" — WHICH
-- WOULD UNDO COMMIT C ENTIRELY. If a future reader hits this
-- error, DO NOT follow the hint.
DO $vs3$
DECLARE
  v_email TEXT;
  v_property TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT ur.email, p.name
    INTO v_email, v_property
    FROM public.user_roles ur
    JOIN public.properties p
      ON lower(trim(p.company)) = lower(trim(ur.company))
   WHERE ur.role = 'company_admin'
     AND ur.is_active = TRUE
   ORDER BY ur.id LIMIT 1;
  IF v_email IS NULL OR v_property IS NULL THEN
    RAISE EXCEPTION 'VS3 FIXTURE FAIL: no active CA with a property in their company. Cannot verify column-grant enforcement.';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    -- Attempt INSERT with tow_ticket_generated (revoked column).
    -- RLS would admit (CA + own property); column grant should deny.
    INSERT INTO public.violations (
      plate, violation_type, property, is_confirmed,
      tow_ticket_generated   -- ← REVOKED column; expected denial here
    )
    VALUES ('VS3PROBE', 'probe', v_property, false, true);

    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VS3 FAIL: INSERT with tow_ticket_generated SUCCEEDED — column grant not enforcing';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    EXECUTE 'RESET role';
    -- 🔴 Discriminate by MESSAGE_TEXT — sqlstate 42501 is shared
    -- across column-grant denials AND RLS violations AND custom
    -- tier-policy RAISEs. Only the specific phrase distinguishes.
    -- INSERT column-grant denial → "permission denied for table X"
    -- (Postgres reports at relation level even for column-scoped
    -- denials — empirically confirmed 2026-09-04 R1 probe).
    IF v_msg ILIKE '%permission denied for table%' THEN
      -- Expected shape — column grant fired. Pass.
      NULL;
    ELSIF v_msg ILIKE '%row-level security%' OR v_msg ILIKE '%violates row-level%' THEN
      RAISE EXCEPTION 'VS3 FIXTURE FAIL: RLS INSERT policy rejected the probe before column-grant check ran. Property + CA combination doesn''t admit — fix probe fixture to use CA + property in the same company. sqlstate=% msg=%', v_sqlstate, v_msg;
    ELSE
      RAISE EXCEPTION 'VS3 FAIL: expected column-grant denial ("permission denied for table violations"); got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
  END;
END $vs3$;


-- ── VS4: 🔴 EXECUTION — direct UPDATE of revoked column REJECTS ═══
DO $vs4$
DECLARE
  v_email TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT email INTO v_email
    FROM public.user_roles
   WHERE role = 'company_admin' AND is_active = TRUE
   ORDER BY id LIMIT 1;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'VS4 FIXTURE FAIL: no active CA to impersonate';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    -- Attempt UPDATE of status (revoked column). RLS may reject on
    -- non-matching id/property, but column-grant check runs first.
    UPDATE public.violations SET status = 'new' WHERE id = 999999999;
    EXECUTE 'RESET role';
    RAISE EXCEPTION 'VS4 FAIL: UPDATE of status SUCCEEDED — column grant not enforcing';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    EXECUTE 'RESET role';
    -- 🔴 Same discriminator as VS3 — MESSAGE_TEXT alone.
    -- UPDATE column-grant denial → "permission denied for table X"
    -- (same relation-level rendering as INSERT — R2 probe confirmed).
    IF v_msg ILIKE '%permission denied for table%' THEN
      NULL;   -- Expected: column grant fired.
    ELSE
      RAISE EXCEPTION 'VS4 FAIL: expected column-grant denial ("permission denied for table violations"); got sqlstate=% msg=%. sqlstate 42501 shared across column/RLS/tier RAISEs — message text discriminates.', v_sqlstate, v_msg;
    END IF;
  END;
END $vs4$;


-- ══════════════════════════════════════════════════════════════════════
-- VS5 — 🔴 LOAD-BEARING: DEFINER RPC still works after column revoke
-- ══════════════════════════════════════════════════════════════════════
-- Commit C's entire premise: column-level grants don't apply to
-- SECURITY DEFINER functions because they run as OWNER. If the premise
-- is wrong, void_violation (which UPDATEs voided_at/voided_by_email/
-- voided_by_role/void_reason — all revoked from authenticated) fails
-- with "permission denied for column" instead of the expected business
-- error (not_found for garbage id).
--
-- ── 🔴 2026-09-04 fix (first run FIXTURE + DISCRIMINATOR both wrong) ─
--
-- FIXTURE: prior version picked ANY active CA. On first run this
-- hit a CA on pm_only or pm_starter tier — void_violation's OWN
-- Commit 2 tier gate raised 'tier_not_permitted' BEFORE ever
-- reaching the UPDATE that tests the DEFINER premise. Fix: filter
-- fixture to tier IN ('legacy', 'enforcement_only') so
-- my_tier_enforcement_capable returns TRUE and the RPC proceeds to
-- the DEFINER-premise-testing UPDATE.
--
-- DISCRIMINATOR: prior version used
--   IF v_sqlstate = '42501' OR v_msg ILIKE '%permission denied for column%'
-- The OR was wrong. sqlstate 42501 (insufficient_privilege) is used
-- by BOTH column-grant denials (Postgres core) AND our own Commit 2
-- 'tier_not_permitted' RAISE (we chose that ERRCODE). Only the
-- MESSAGE_TEXT discriminates — column-grant denials say "permission
-- denied for column X" specifically. Fix: check MESSAGE_TEXT alone
-- for the column-denial phrase; treat any other 42501 as unrelated.
--
-- Filed as memory rule: sqlstate 42501 is shared across
-- column/table-grant denials AND custom-policy RAISEs that chose
-- insufficient_privilege as their errcode. Discriminate by
-- MESSAGE_TEXT, not sqlstate alone.
--
-- Probe: impersonate a legacy/enforcement_only CA + call
-- void_violation(9999999999, 'probe').
-- Expected: { error: 'not_found' } (the RPC's own guard).
-- FAIL: msg contains "permission denied for column" (DEFINER premise
-- broken; Commit C rolled back to production immediately).
DO $vs5$
DECLARE
  v_email TEXT;
  v_tier TEXT;
  v_result JSONB;
  v_err TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  -- Filter to CA whose tier passes the enforcement check (legacy or
  -- enforcement_only). Prefer enforcement_only over legacy — legacy
  -- is A1 (load-bearing); avoid coupling this test to A1's fixture.
  SELECT ur.email, c.tier
    INTO v_email, v_tier
    FROM public.user_roles ur
    JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE ur.role = 'company_admin'
     AND ur.is_active = TRUE
     AND c.tier IN ('legacy', 'enforcement_only')
   ORDER BY
     CASE c.tier WHEN 'enforcement_only' THEN 1 ELSE 2 END,
     ur.id
   LIMIT 1;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'VS5 FIXTURE FAIL: no active CA on legacy or enforcement_only tier. LOAD-BEARING gate needs a CA whose tier gate PASSES so void_violation reaches the DEFINER-premise-testing UPDATE.';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    v_result := public.void_violation(9999999999::BIGINT, 'vs5probe');
    EXECUTE 'RESET role';
    v_err := v_result ->> 'error';
    -- Expected: 'not_found' (row doesn't exist). Any other jsonb
    -- error surfaces a different regression (not DEFINER premise).
    IF v_err IS DISTINCT FROM 'not_found' THEN
      RAISE EXCEPTION 'VS5 UNEXPECTED: void_violation returned error=%L (want ''not_found'') using tier=% CA. Full result: %. Not the DEFINER-premise failure shape — surfaces a different regression worth investigating.', v_err, v_tier, v_result::TEXT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    EXECUTE 'RESET role';
    -- 🔴 DISCRIMINATOR: MESSAGE_TEXT alone. sqlstate 42501 is used by
    -- both column-grant denials AND our Commit 2 tier RAISE — sqlstate
    -- alone doesn't distinguish them. If DEFINER premise broke, the
    -- RPC's internal INSERT/UPDATE would fail with "permission denied
    -- for table violations" (relation-level rendering — R1/R2 probes
    -- 2026-09-04 confirmed both INSERT and UPDATE report this way,
    -- not "for column X").
    IF v_msg ILIKE '%permission denied for table%' THEN
      RAISE EXCEPTION 'VS5 FAIL (LOAD-BEARING): DEFINER premise BROKEN. void_violation surfaced table-level permission denial (sqlstate=% msg=%). Commit C rolled back the ability of DEFINER RPCs to write revoked columns — this hits every enforcement RPC. Immediate revert of Commit C required.', v_sqlstate, v_msg;
    ELSE
      RAISE EXCEPTION 'VS5 UNEXPECTED: void_violation raised sqlstate=% msg=% (tier=% CA). Not the DEFINER-premise failure shape (msg does NOT contain "permission denied for table"). Another regression worth investigating.', v_sqlstate, v_msg, v_tier;
    END IF;
  END;
END $vs5$;


-- ── VS6: service_role posture unchanged ═════════════════════════════
DO $vs6$
DECLARE
  v_ins_count INT;
  v_upd_count INT;
BEGIN
  SELECT COUNT(*) INTO v_ins_count
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'violations'
     AND grantee = 'service_role' AND privilege_type = 'INSERT';
  SELECT COUNT(*) INTO v_upd_count
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'violations'
     AND grantee = 'service_role' AND privilege_type = 'UPDATE';

  -- service_role typically holds full-table grants (not per-column).
  -- Either it's per-column all-columns OR it's table-level; both are
  -- fine. If BOTH counts are 0, something revoked service_role.
  IF v_ins_count = 0 AND v_upd_count = 0 THEN
    RAISE EXCEPTION 'VS6 FAIL: service_role has NO column-level INSERT/UPDATE grants on violations. Table-level grants may still cover it — check has_table_privilege(''service_role'', ''public.violations'', ''INSERT'') separately if this fires.';
  END IF;
END $vs6$;


-- ── VS7: anon posture unchanged (no grants beyond baseline) ═════════
DO $vs7$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.column_privileges
   WHERE table_schema = 'public' AND table_name = 'violations'
     AND grantee = 'anon'
     AND privilege_type IN ('INSERT', 'UPDATE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS7 FAIL: anon has UNEXPECTED INSERT/UPDATE column grants on violations (count=%). Commit C shouldn''t have touched anon; investigate.', v_count;
  END IF;
END $vs7$;


-- ── VS8: DELETE policies post-apply parity ═════════════════════════
-- Same shape as Part 1 pre-flight — assert 3 policies + is_confirmed
-- presence + 0 admin-prefixed. If Commit C somehow altered a DELETE
-- policy, this catches it.
DO $vs8$
DECLARE
  v_count INT;
  v_admin_count INT;
  v_no_confirmed TEXT := '';
  v_qual TEXT;
  v_policyname TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'violations' AND cmd = 'DELETE'
     AND policyname IN ('company_admin_delete_own_drafts',
                        'driver_delete_own_drafts',
                        'manager_delete_own_drafts');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VS8 FAIL: expected 3 DELETE policies post-apply; got %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_admin_count
    FROM pg_policies
   WHERE schemaname='public' AND tablename='violations' AND cmd='DELETE'
     AND policyname LIKE 'admin%';
  IF v_admin_count > 0 THEN
    RAISE EXCEPTION 'VS8 FAIL: unexpected admin DELETE policy post-apply (count=%)', v_admin_count;
  END IF;

  FOR v_policyname, v_qual IN
    SELECT policyname, qual
      FROM pg_policies
     WHERE schemaname='public' AND tablename='violations' AND cmd='DELETE'
  LOOP
    IF v_qual NOT LIKE '%is_confirmed%' THEN
      v_no_confirmed := v_no_confirmed || format('%s; ', v_policyname);
    END IF;
  END LOOP;
  IF v_no_confirmed <> '' THEN
    RAISE EXCEPTION 'VS8 FAIL: DELETE policies without is_confirmed in qual post-apply: %', v_no_confirmed;
  END IF;
END $vs8$;


-- ── VS9: audit row present ═════════════════════════════════════════
DO $vs9$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_VIOLATIONS_COLUMN_GRANT_TIGHTENING'
     AND new_values ->> 'migration' = '20260904_violations_column_grant_tightening';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS9 FAIL: audit row missing';
  END IF;
END $vs9$;


-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'violations column-grant tightening (Commit 3 Commit C)'::TEXT AS target,
  ARRAY[
    'VS1  authenticated INSERT grants = exactly the 19 allowlist cols',
    'VS2  authenticated UPDATE grants = exactly [is_confirmed]',
    'VS3  🔴 execution — direct INSERT of tow_ticket_generated → 42501 "permission denied for table violations"',
    'VS4  🔴 execution — direct UPDATE of status → 42501 "permission denied for table violations"',
    'VS5  🔴 LOAD-BEARING — void_violation DEFINER RPC still works (returns not_found for garbage id, NOT "permission denied for table")',
    'VS6  service_role posture unchanged',
    'VS7  anon has no INSERT/UPDATE column grants',
    'VS8  DELETE policies post-apply parity (3 + is_confirmed in each qual + 0 admin-prefixed)',
    'VS9  SCHEMA_VIOLATIONS_COLUMN_GRANT_TIGHTENING audit row'
  ] AS gates_verified,
  now() AS verified_at;
