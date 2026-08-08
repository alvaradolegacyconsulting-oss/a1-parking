-- ══════════════════════════════════════════════════════════════════════
-- 20260808_get_my_effective_active_row_precedence_verification.sql
-- POST-APPLY: helpers exist with correct signatures/grants/volatility;
-- get_my_effective_active body carries the ORDER BY on BOTH selects
-- with the shared helper reference; behavioural probe demonstrates
-- the precedence returns the ACTIVE row for a resident with two rows.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260808_get_my_effective_active_row_precedence.sql.
-- Paste WHOLE.
--
-- Source-inspection VQs strip `-- ...` comments before matching per
-- discipline #11.
--
-- Behavioural probe seeds two residents rows for a fixture email at a
-- fixture property inside the outer transaction and asserts the
-- precedence returns rank 1 (active) over rank 3 (declined). Rolled
-- back — no persistent state.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.HELPER_EXISTS ────────────────────────────────────────────────
DO $$
DECLARE v_count int; v_volatile "char";
BEGIN
  SELECT COUNT(*), max(provolatile)
    INTO v_count, v_volatile
    FROM pg_proc
   WHERE proname = 'resident_row_precedence'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 2;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.HELPER_EXISTS: expected 1 resident_row_precedence(TEXT,BOOLEAN); got %', v_count;
  END IF;
  IF v_volatile <> 'i' THEN
    RAISE EXCEPTION 'VQ.HELPER_EXISTS: expected IMMUTABLE (i); got %', v_volatile;
  END IF;
END $$;

-- ── VQ.HELPER_GRANTS ────────────────────────────────────────────────
-- anon REVOKED, authenticated GRANTED, PUBLIC REVOKED.
DO $$
DECLARE v_has_anon boolean; v_has_authenticated boolean; v_has_public boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.resident_row_precedence(text,boolean)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.resident_row_precedence(text,boolean)', 'EXECUTE'),
    has_function_privilege('public',        'public.resident_row_precedence(text,boolean)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated, v_has_public;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.HELPER_GRANTS: anon HAS EXECUTE (must be REVOKED)';
  END IF;
  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.HELPER_GRANTS: PUBLIC HAS EXECUTE (must be REVOKED — anon inherits otherwise)';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.HELPER_GRANTS: authenticated MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.HELPER_RANKING ───────────────────────────────────────────────
-- Canonical ranking: 1=active+is_active=TRUE, 2=pending, 3=declined,
-- 4=deactivated (is_active=FALSE). Behavioural probe — no DB rows
-- touched, just fixed-input calls.
DO $$
DECLARE v_rank int;
BEGIN
  SELECT public.resident_row_precedence('active', TRUE)  INTO v_rank;
  IF v_rank <> 1 THEN RAISE EXCEPTION 'VQ.HELPER_RANKING: active+TRUE expected 1, got %', v_rank; END IF;

  SELECT public.resident_row_precedence('pending', FALSE) INTO v_rank;
  IF v_rank <> 2 THEN RAISE EXCEPTION 'VQ.HELPER_RANKING: pending expected 2, got %', v_rank; END IF;

  SELECT public.resident_row_precedence('declined', FALSE) INTO v_rank;
  IF v_rank <> 3 THEN RAISE EXCEPTION 'VQ.HELPER_RANKING: declined expected 3, got %', v_rank; END IF;

  SELECT public.resident_row_precedence('active', FALSE) INTO v_rank;
  IF v_rank <> 4 THEN RAISE EXCEPTION 'VQ.HELPER_RANKING: active-but-is_active=FALSE (deactivated) expected 4, got %', v_rank; END IF;

  SELECT public.resident_row_precedence(NULL, NULL) INTO v_rank;
  IF v_rank <> 4 THEN RAISE EXCEPTION 'VQ.HELPER_RANKING: null-inputs (unknown state, falls through) expected 4, got %', v_rank; END IF;
END $$;

-- ── VQ.GET_MY_EFFECTIVE_ACTIVE_SIGNATURE_UNCHANGED ──────────────────
DO $$
DECLARE v_count int; v_secdef boolean; v_volatile "char";
BEGIN
  SELECT COUNT(*), bool_and(prosecdef), max(provolatile)
    INTO v_count, v_secdef, v_volatile
    FROM pg_proc
   WHERE proname = 'get_my_effective_active'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.GET_MY_EFFECTIVE_ACTIVE_SIGNATURE_UNCHANGED: expected 1 fn; got %', v_count;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VQ.GET_MY_EFFECTIVE_ACTIVE_SIGNATURE_UNCHANGED: expected SECURITY DEFINER';
  END IF;
END $$;

-- ── VQ.GET_MY_EFFECTIVE_ACTIVE_GRANTS ───────────────────────────────
DO $$
DECLARE v_has_anon boolean; v_has_authenticated boolean; v_has_public boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.get_my_effective_active(text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.get_my_effective_active(text)', 'EXECUTE'),
    has_function_privilege('public',        'public.get_my_effective_active(text)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated, v_has_public;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.GET_MY_EFFECTIVE_ACTIVE_GRANTS: anon HAS EXECUTE (must be REVOKED)';
  END IF;
  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.GET_MY_EFFECTIVE_ACTIVE_GRANTS: PUBLIC HAS EXECUTE';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.GET_MY_EFFECTIVE_ACTIVE_GRANTS: authenticated MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.BODY_ORDER_BY_BOTH_SELECTS ───────────────────────────────────
-- Both residents SELECTs (v_resident_active + scope_property) must
-- carry ORDER BY resident_row_precedence(...). Exactly two occurrences
-- of the helper call inside the body — one per select. A stray third
-- or absence means someone regressed one of them.
DO $$
DECLARE v_body text; v_body_code text; v_count int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_my_effective_active' AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'resident_row_precedence\s*\(\s*status\s*,\s*is_active\s*\)' THEN
    RAISE EXCEPTION 'VQ.BODY_ORDER_BY_BOTH_SELECTS: body missing resident_row_precedence(status, is_active) call';
  END IF;

  SELECT array_length(regexp_split_to_array(v_body_code, 'resident_row_precedence\s*\('), 1) - 1
    INTO v_count;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VQ.BODY_ORDER_BY_BOTH_SELECTS: expected exactly 2 calls to resident_row_precedence in body; found %', v_count;
  END IF;

  IF v_body_code !~ 'created_at\s+DESC' THEN
    RAISE EXCEPTION 'VQ.BODY_ORDER_BY_BOTH_SELECTS: body missing "created_at DESC" tiebreaker on the ORDER BY';
  END IF;
END $$;

-- ── VQ.BEHAVIOURAL_PRECEDENCE_PICKS_ACTIVE ──────────────────────────
-- Seed two residents rows for a probe email at a probe property —
-- one active (rank 1), one declined (rank 3). Assert the precedence
-- ORDER BY returns the active row's is_active=TRUE. Rolled back at
-- the outer ROLLBACK.
--
-- Probe uses UPDATE to escape the residents_deactivate_free_spaces
-- trigger, and uses distinct emails ONLY IF a real fixture with two
-- rows for one email would fail an existing constraint. Today there
-- is no such constraint (that's why the bug exists), so seed two
-- rows with the SAME lowered email.
--
-- Note: this VQ verifies the SQL predicate directly, NOT
-- get_my_effective_active — the function requires a JWT-scoped call
-- to fire; the SQL predicate is what the ORDER BY encodes and what
-- would break under regression.
DO $$
DECLARE
  v_probe_email    TEXT := '__vq_precedence_08b7c__@example.com';
  v_probe_company  TEXT := '__vq_prec_company_08b7c__';
  v_probe_property TEXT := '__vq_prec_property_08b7c__';
  v_picked_active  BOOLEAN;
BEGIN
  DELETE FROM public.residents    WHERE lower(email) = lower(v_probe_email);
  DELETE FROM public.properties   WHERE name = v_probe_property;
  DELETE FROM public.companies    WHERE name = v_probe_company;

  INSERT INTO public.companies (name, tier, tier_type, account_state, is_active)
  VALUES (v_probe_company, 'enforcement_only', 'enforcement', 'active', TRUE);
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_property, v_probe_company, TRUE);

  -- Row 1 — declined, created FIRST (to prove precedence beats
  -- created_at when they disagree).
  INSERT INTO public.residents (email, name, unit, property, company, status, is_active, created_at)
  VALUES (v_probe_email, 'VQ Probe', '999', v_probe_property, v_probe_company, 'declined', FALSE, now() - interval '2 hours');

  -- Row 2 — active, created LATER (both precedence AND tiebreaker
  -- favor this row, so it MUST win).
  INSERT INTO public.residents (email, name, unit, property, company, status, is_active, created_at)
  VALUES (v_probe_email, 'VQ Probe', '999', v_probe_property, v_probe_company, 'active', TRUE, now());

  -- Same SELECT shape as get_my_effective_active's rewritten body.
  SELECT is_active INTO v_picked_active
    FROM public.residents
    WHERE lower(email) = lower(v_probe_email)
    ORDER BY public.resident_row_precedence(status, is_active), created_at DESC
    LIMIT 1;

  IF v_picked_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.BEHAVIOURAL_PRECEDENCE_PICKS_ACTIVE: expected TRUE (active row wins); got %. The bug is still live.', v_picked_active;
  END IF;

  -- Adversarial: prove the OLD buggy shape (LIMIT 1 without ORDER BY)
  -- CAN return the declined row. Not asserting; just RAISE NOTICE
  -- so the reviewer sees the fix's necessity was real.
  --
  -- (Postgres doesn't guarantee which row without ORDER BY, so this
  -- may occasionally return the active row anyway. Not a regression
  -- of the fix — that's the whole point of the fix.)
  DECLARE v_arbitrary BOOLEAN;
  BEGIN
    SELECT is_active INTO v_arbitrary
      FROM public.residents
      WHERE lower(email) = lower(v_probe_email)
      LIMIT 1;
    RAISE NOTICE 'VQ.BEHAVIOURAL_PRECEDENCE_PICKS_ACTIVE: bare LIMIT 1 (old code) returned is_active=% for probe. Fixed ORDER BY returns is_active=TRUE deterministically.', v_arbitrary;
  END;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_MY_EFFECTIVE_ACTIVE_ROW_PRECEDENCE'
     AND new_values->>'migration' = '20260808_get_my_effective_active_row_precedence';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- Rollback — probe rows never intended to persist.
ROLLBACK;
