-- ══════════════════════════════════════════════════════════════════════
-- 20260829_spaces_add_monthly_fee_and_extend_rpc_verification.sql
--
-- Paired verification for 20260829_spaces_add_monthly_fee_and_extend_rpc.
-- v2 pattern: no BEGIN/COMMIT wrap; terminal SELECT returns one PASS
-- row on success; any gate failure surfaces via RAISE EXCEPTION.
--
-- ── 8 GATES ─────────────────────────────────────────────────────────
--   VQ1  structural — spaces.monthly_fee exists, is NUMERIC, is nullable
--   VQ2  structural — OLD 5-arg update_space_metadata is GONE (no overload
--        left alive that a stale caller could still hit)
--   VQ3  structural — NEW 6-arg update_space_metadata exists with the
--        expected signature
--   VQ4  🔴 EXECUTION — call the RPC with a specific fee, confirm the
--        row stores exactly that value (write-then-read)
--   VQ5  🔴 EXECUTION — call the RPC AGAIN with the SAME 6 args (no-op
--        edit; not a 5-arg call — the 5-arg signature is gone), confirm
--        the fee is PRESERVED, not nulled. This is the NULL-wipe trap
--        Mateo Aug 29 §2.4 named as "the single most likely way Commit 1
--        goes wrong" — belt-and-braces despite the DROP approach.
--   VQ6  🔴 EXECUTION — call the RPC with p_monthly_fee=NULL, confirm
--        the row stores NULL (i.e., "clear the fee" works)
--   VQ7  EXECUTION — call the RPC with p_monthly_fee=-1, confirm
--        monthly_fee_negative is raised (validation branch fires)
--   VQ8  schema audit row present
--
-- ── PROBE ROW LIFECYCLE ─────────────────────────────────────────────
-- One synthetic Test-LEGACY row created via INSERT (service_role bypass
-- via the same JWT context the RPC lives inside). Kept for the entire
-- VQ4→VQ7 sequence — each gate builds on the prior state. Deleted at
-- the end. If any RAISE fires mid-sequence, the row survives (visible
-- for forensics); manual cleanup one-liner is at the bottom of this
-- file as a comment.
--
-- ── EXECUTION GATE PREREQ — JWT IMPERSONATION ───────────────────────
-- The RPC role guard at PART 3 requires v_email in user_roles with
-- role IN ('manager','company_admin'). Running this file directly in
-- the SQL Editor without impersonating such a user would raise
-- role_not_allowed on EVERY execution gate, false-failing them.
--
-- Per feedback_rpc_verification_must_include_execution_gate.md +
-- Mateo's admin-impersonate pattern (654558e), the SQL Editor session
-- runs as the service role — auth.jwt() is NULL and v_email is NULL,
-- which makes v_role NULL and the guard raises role_not_allowed.
--
-- 🔴 To make VQ4-VQ7 executable in the SQL Editor: set the JWT
-- claims header BEFORE running this file, impersonating a
-- Test-LEGACY manager whose user_roles row exists:
--
--   SET LOCAL "request.jwt.claims" = '{"email":"<test-legacy-mgr-email>"}';
--
-- The Jose apply runbook (docs/backlog/apply-batch-2026-08-29-*.md)
-- names the specific email to use.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ1: monthly_fee column exists, NUMERIC, nullable ───────────────
DO $$
DECLARE
  v_data_type   TEXT;
  v_nullable    TEXT;
  v_precision   INT;
  v_scale       INT;
BEGIN
  SELECT data_type, is_nullable, numeric_precision, numeric_scale
    INTO v_data_type, v_nullable, v_precision, v_scale
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'spaces'
     AND column_name  = 'monthly_fee';
  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'VQ1 FAIL: column public.spaces.monthly_fee not found';
  END IF;
  IF v_data_type <> 'numeric' THEN
    RAISE EXCEPTION 'VQ1 FAIL: expected data_type=numeric; got %', v_data_type;
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VQ1 FAIL: expected nullable YES; got %', v_nullable;
  END IF;
  IF v_precision <> 10 OR v_scale <> 2 THEN
    RAISE EXCEPTION 'VQ1 FAIL: expected NUMERIC(10,2); got NUMERIC(%,%)', v_precision, v_scale;
  END IF;
END $$;

-- ── VQ2: OLD 5-arg signature is GONE ────────────────────────────────
-- 🔴 2026-08-29 REWRITE — original VQ2 filtered on
-- pg_get_function_identity_arguments() = <exact string>, which
-- silently misbehaves for TWO reasons on this PG version:
--   1. identity_arguments INCLUDES parameter names in some formats
--      (returned 'p_space_id bigint, ...' not 'bigint, ...')
--   2. Function parameter type modifiers are stripped at creation —
--      NUMERIC(10,2) → 'numeric' — so any filter written from the
--      migration text disagrees with the catalog
-- Net: the string comparison returned 0 rows for ANY function,
-- meaning VQ2 = 0 = pass regardless of whether the 5-arg version
-- was actually gone. A gate that always passes is worse than no gate.
--
-- FIX: use to_regprocedure(), the built-in signature resolver.
-- Returns the OID if a function with that EXACT signature exists,
-- NULL if not. Handles all the type-name canonicalization + modifier
-- stripping + PG-version formatting differences internally, because
-- it IS the resolver Postgres uses when parsing function references.
DO $$
DECLARE
  v_old_oid oid;
BEGIN
  v_old_oid := to_regprocedure('public.update_space_metadata(bigint, text, text, text, boolean)');
  IF v_old_oid IS NOT NULL THEN
    RAISE EXCEPTION 'VQ2 FAIL: OLD 5-arg update_space_metadata still exists (oid=%). DROP FUNCTION did not run. Any stale caller can still hit it and miss monthly_fee.', v_old_oid;
  END IF;
END $$;

-- ── VQ3: NEW 6-arg signature exists ─────────────────────────────────
-- 🔴 2026-08-29 REWRITE — same class of bug as VQ2. Original filtered
-- against a hand-composed exact string that never matches what
-- pg_get_function_identity_arguments actually returns on this PG
-- version, so VQ3 returned count=0 (fail) for a function that DID
-- exist. Diagnosed as false-negative via D1 sweep 02:11 (D1 saw
-- pronargs=6, args='p_space_id bigint, ...', prosecdef=true).
--
-- FIX: to_regprocedure() takes a signature by base type name (bigint,
-- not int8; numeric, not numeric(10,2)) and returns the OID iff a
-- function with that exact base-type signature exists. Zero string
-- matching, zero PG-version dependency.
DO $$
DECLARE
  v_new_oid oid;
  v_definer BOOLEAN;
BEGIN
  v_new_oid := to_regprocedure('public.update_space_metadata(bigint, text, text, text, boolean, numeric)');
  IF v_new_oid IS NULL THEN
    RAISE EXCEPTION 'VQ3 FAIL: 6-arg update_space_metadata does not exist (to_regprocedure returned NULL). Migration CREATE FUNCTION did not run, or landed with a different signature.';
  END IF;
  SELECT prosecdef INTO v_definer FROM pg_proc WHERE oid = v_new_oid;
  IF NOT COALESCE(v_definer, false) THEN
    RAISE EXCEPTION 'VQ3 FAIL: new 6-arg update_space_metadata (oid=%) is not SECURITY DEFINER', v_new_oid;
  END IF;
END $$;

-- ── VQ4-VQ7 EXECUTION SEQUENCE ──────────────────────────────────────
-- Set up: one synthetic Test-LEGACY probe space + JWT impersonation
-- of a Test-LEGACY manager. Each gate builds on the prior row state.

DO $$
DECLARE
  v_probe_space_id BIGINT;
  v_test_property  TEXT := 'Test Legacy Property';
  v_test_company   TEXT := 'Test-LEGACY';
  v_test_email     TEXT;
  v_probe_label    TEXT := '__V-COMMIT-1-PROBE-' || floor(extract(epoch from now()))::text;
  v_read_fee       NUMERIC(10,2);
  v_expected_fee_1 NUMERIC(10,2) := 42.50;
  v_expected_fee_2 NUMERIC(10,2) := 42.50; -- same as _1 for the "no-op preserves" check
  v_rpc_result     BOOLEAN;
  v_neg_error_sqlstate TEXT;
  v_neg_error_msg      TEXT;
BEGIN
  -- Resolve any manager or company_admin for Test-LEGACY to impersonate.
  SELECT lower(email) INTO v_test_email
    FROM public.user_roles
   WHERE company ~~* v_test_company
     AND role IN ('manager','company_admin')
     AND lower(coalesce(is_active::text, 'true')) <> 'false'
   ORDER BY id
   LIMIT 1;
  IF v_test_email IS NULL THEN
    RAISE EXCEPTION 'VQ4 PREREQ FAIL: no manager or company_admin found for company % — cannot impersonate for execution gates. Adjust probe or seed Test-LEGACY first.', v_test_company;
  END IF;

  -- Impersonate. SET LOCAL is bound to this transaction only.
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', v_test_email)::text,
                     true);

  -- Create probe space directly (bypasses RPC on setup; RPC is under
  -- test in VQ4-VQ7, not setup). company + label + created_by required.
  INSERT INTO public.spaces (company, property, label, type, is_active, created_by_email)
  VALUES (v_test_company, v_test_property, v_probe_label, 'regular', TRUE, v_test_email)
  RETURNING id INTO v_probe_space_id;
  IF v_probe_space_id IS NULL THEN
    RAISE EXCEPTION 'VQ4 SETUP FAIL: probe space INSERT returned no id';
  END IF;

  -- ── VQ4: call RPC with a specific fee, assert stored ─────────────
  BEGIN
    v_rpc_result := public.update_space_metadata(
      p_space_id    => v_probe_space_id,
      p_label       => v_probe_label,
      p_description => 'V4 probe',
      p_type        => 'regular',
      p_is_bundled  => FALSE,
      p_monthly_fee => v_expected_fee_1
    );
  EXCEPTION WHEN others THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ4 FAIL: RPC raised on write-with-fee: SQLSTATE=% %', SQLSTATE, SQLERRM;
  END;
  SELECT monthly_fee INTO v_read_fee FROM public.spaces WHERE id = v_probe_space_id;
  IF v_read_fee IS DISTINCT FROM v_expected_fee_1 THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ4 FAIL: wrote fee=%, read fee=%. write-then-read mismatch.', v_expected_fee_1, v_read_fee;
  END IF;

  -- ── VQ5: 🔴 no-op edit (same 6 args) preserves fee, doesn't null ──
  BEGIN
    v_rpc_result := public.update_space_metadata(
      p_space_id    => v_probe_space_id,
      p_label       => v_probe_label,
      p_description => 'V5 no-op',
      p_type        => 'regular',
      p_is_bundled  => FALSE,
      p_monthly_fee => v_expected_fee_2   -- same value as VQ4
    );
  EXCEPTION WHEN others THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ5 FAIL: RPC raised on no-op edit: SQLSTATE=% %', SQLSTATE, SQLERRM;
  END;
  SELECT monthly_fee INTO v_read_fee FROM public.spaces WHERE id = v_probe_space_id;
  IF v_read_fee IS DISTINCT FROM v_expected_fee_2 THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ5 FAIL: after no-op edit (same fee passed), fee=% (expected %). Fee was silently altered — the NULL-wipe trap fired.', v_read_fee, v_expected_fee_2;
  END IF;

  -- ── VQ6: call RPC with p_monthly_fee=NULL, assert cleared ────────
  BEGIN
    v_rpc_result := public.update_space_metadata(
      p_space_id    => v_probe_space_id,
      p_label       => v_probe_label,
      p_description => 'V6 clear',
      p_type        => 'regular',
      p_is_bundled  => FALSE,
      p_monthly_fee => NULL
    );
  EXCEPTION WHEN others THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ6 FAIL: RPC raised on clear-fee: SQLSTATE=% %', SQLSTATE, SQLERRM;
  END;
  SELECT monthly_fee INTO v_read_fee FROM public.spaces WHERE id = v_probe_space_id;
  IF v_read_fee IS NOT NULL THEN
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ6 FAIL: after passing NULL, fee=% (expected NULL). Clear-fee semantics broken.', v_read_fee;
  END IF;

  -- ── VQ7: call RPC with p_monthly_fee=-1, assert monthly_fee_negative ─
  BEGIN
    v_rpc_result := public.update_space_metadata(
      p_space_id    => v_probe_space_id,
      p_label       => v_probe_label,
      p_description => 'V7 negative',
      p_type        => 'regular',
      p_is_bundled  => FALSE,
      p_monthly_fee => -1
    );
    -- If we reach here, validation didn't fire.
    DELETE FROM public.spaces WHERE id = v_probe_space_id;
    RAISE EXCEPTION 'VQ7 FAIL: RPC accepted p_monthly_fee=-1 without raising monthly_fee_negative. Validation branch not firing.';
  EXCEPTION
    WHEN raise_exception THEN
      -- Expected. Confirm the message text says monthly_fee_negative.
      v_neg_error_sqlstate := SQLSTATE;
      v_neg_error_msg      := SQLERRM;
      IF v_neg_error_msg NOT LIKE '%monthly_fee_negative%' THEN
        DELETE FROM public.spaces WHERE id = v_probe_space_id;
        RAISE EXCEPTION 'VQ7 FAIL: RPC raised on -1 but message did not include monthly_fee_negative. SQLSTATE=% msg=%', v_neg_error_sqlstate, v_neg_error_msg;
      END IF;
  END;

  -- ── Cleanup ──────────────────────────────────────────────────────
  DELETE FROM public.spaces WHERE id = v_probe_space_id;
END $$;

-- ── VQ8: schema audit row present ───────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_SPACES_ADD_MONTHLY_FEE'
     AND new_values->>'migration' = '20260829_spaces_add_monthly_fee_and_extend_rpc';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ8 FAIL: SCHEMA_SPACES_ADD_MONTHLY_FEE audit row missing. Migration DO block did not complete — check for a mid-run RAISE EXCEPTION in the error pane.';
  END IF;
END $$;

-- ── FINAL: one PASS row on all 8 gates ──────────────────────────────
SELECT
  'PASS'::TEXT                                 AS status,
  'spaces.monthly_fee + update_space_metadata(6-arg)'::TEXT AS target,
  ARRAY[
    'VQ1 column NUMERIC(10,2) nullable',
    'VQ2 old 5-arg RPC gone',
    'VQ3 new 6-arg RPC exists + DEFINER',
    'VQ4 EXECUTION write-then-read fee stored',
    'VQ5 EXECUTION no-op edit preserves fee (NULL-wipe trap check)',
    'VQ6 EXECUTION NULL clears fee',
    'VQ7 EXECUTION negative fee raises monthly_fee_negative',
    'VQ8 SCHEMA_SPACES_ADD_MONTHLY_FEE audit row present'
  ]                                            AS gates_verified,
  now()                                        AS verified_at;

-- ══════════════════════════════════════════════════════════════════════
-- MANUAL CLEANUP (only if a VQ4-VQ7 gate raised and the DELETE at end
-- of that DO block did NOT run — probe row survives with a __V-COMMIT-1-
-- PROBE-… label at Test-LEGACY):
--
--   DELETE FROM public.spaces WHERE label LIKE '__V-COMMIT-1-PROBE-%';
-- ══════════════════════════════════════════════════════════════════════
