-- ════════════════════════════════════════════════════════════════════
-- 20260725_insert_user_role_resident_self_attach_idempotency_verification.sql
-- Post-apply structural verification. Silent success = PASS.
-- BEGIN…COMMIT wrap: aborts at first RAISE, correct post-apply shape.
--
-- Notes carried forward from commit 0's verification pass:
--   • VQ.IDEMPOTENCY_BRANCH uses regexp_matches with \s+ to tolerate
--     whitespace variation in Postgres's deparsed function body.
--   • Absence-VQs would need to match executable syntax specific enough
--     that no prose could contain it (discipline #3 codified 2026-07-25).
--     This file has no absence checks — all six VQs assert presence.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def   TEXT;
  v_args  TEXT;
  v_count INT;
BEGIN
  -- ── VQ.PROC_COUNT — exactly one function, no overload trap ──
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'insert_user_role' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.PROC_COUNT FAILED — expected 1, got %', v_count;
  END IF;

  -- ── VQ.SIG — signature preserved ──
  SELECT pg_get_function_arguments(oid) INTO v_args
    FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace;
  IF v_args <> 'p_email text, p_role text, p_company text, p_property text[], p_name text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VQ.SIG FAILED — got: %', v_args;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace;

  -- ── VQ.IDEMPOTENCY_BRANCH — caller-role + p_role gate present ──
  IF (regexp_matches(v_def, 'v_caller_role = ''resident''\s+AND p_role = ''resident'''))[1] IS NULL THEN
    RAISE EXCEPTION 'VQ.IDEMPOTENCY_BRANCH FAILED — caller-role+p_role gate missing';
  END IF;

  -- ── VQ.NORMALIZATION — matches get_my_role() byte-for-byte ──
  -- Load-bearing: any deviation (adding trim, changing to ILIKE, etc.) means
  -- the idempotency check disagrees with the reader and misses edge-case rows.
  IF v_def NOT LIKE '%lower(email) = lower(v_caller_email)%' THEN
    RAISE EXCEPTION 'VQ.NORMALIZATION FAILED — must match get_my_role()''s lower(email) = lower(auth.jwt().email)';
  END IF;

  -- ── VQ.SELF_EMAIL_GATE — idempotency only fires for own email ──
  IF v_def NOT LIKE '%lower(p_email) = lower(v_caller_email)%' THEN
    RAISE EXCEPTION 'VQ.SELF_EMAIL_GATE FAILED — idempotency branch must gate on p_email matching caller';
  END IF;

  -- ── VQ.INVARIANT_ELSE_DENY — ELSE default-deny preserved ──
  IF v_def NOT LIKE '%caller_role_not_authorized%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_ELSE_DENY FAILED — default-deny reshaped';
  END IF;

  -- ── VQ.INVARIANT_SELF_REG — self-reg NULL-role branch preserved ──
  IF v_def NOT LIKE '%self_reg_role_violation%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_SELF_REG FAILED — self-reg branch reshaped';
  END IF;

  -- ── VQ.INVARIANT_CA_SCOPE — company-scope guard preserved ──
  IF v_def NOT LIKE '%company_scope_violation%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_CA_SCOPE FAILED — CA scope guard reshaped';
  END IF;

  -- ── VQ.INVARIANT_INSERT — the INSERT itself preserved ──
  IF v_def NOT LIKE '%INSERT INTO public.user_roles (email, role, company, property, name)%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_INSERT FAILED — INSERT clause reshaped';
  END IF;
END $$;

COMMIT;
