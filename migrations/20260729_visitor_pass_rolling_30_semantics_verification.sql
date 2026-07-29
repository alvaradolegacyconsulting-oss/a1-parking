-- ══════════════════════════════════════════════════════════════════════
-- 20260729_visitor_pass_rolling_30_semantics_verification.sql
-- Post-apply structural verification. Silent success = PASS.
--
-- Asserts:
--   • Old predicate ABSENT from both function bodies (is_active + expires_at)
--   • New predicate PRESENT in both (created_at 30-day)
--   • v_is_anon variable + auth.uid() branch PRESENT in RPC
--   • Both count-carrying exits gated on v_is_anon
--   • Trigger HINT rewritten
--   • Grants preserved (anon+authenticated retain EXECUTE on RPC)
--   • Both functions still exactly 1 overload each
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def_enforce TEXT;
  v_def_rpc     TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def_enforce
    FROM pg_proc
   WHERE proname = 'enforce_visitor_pass_limit'
     AND pronamespace = 'public'::regnamespace;
  SELECT pg_get_functiondef(oid) INTO v_def_rpc
    FROM pg_proc
   WHERE proname = 'get_plate_pass_status'
     AND pronamespace = 'public'::regnamespace;

  -- ── VQ.OLD_ABSENT_ENFORCE — old concurrency predicate gone from trigger ──
  IF v_def_enforce ILIKE '%is_active = TRUE%expires_at > now()%' THEN
    RAISE EXCEPTION 'VQ.OLD_ABSENT_ENFORCE FAILED — enforce_visitor_pass_limit still contains is_active + expires_at count predicate';
  END IF;

  -- ── VQ.NEW_PRESENT_ENFORCE — 30-day predicate in trigger ──
  IF v_def_enforce NOT ILIKE '%created_at > now() - interval%30 days%' THEN
    RAISE EXCEPTION 'VQ.NEW_PRESENT_ENFORCE FAILED — enforce_visitor_pass_limit missing created_at 30-day predicate';
  END IF;

  -- ── VQ.HINT_NEW_ENFORCE — new HINT copy in trigger ──
  IF v_def_enforce NOT ILIKE '%Contact the property manager if you need access%' THEN
    RAISE EXCEPTION 'VQ.HINT_NEW_ENFORCE FAILED — enforce_visitor_pass_limit missing new HINT copy';
  END IF;

  -- ── VQ.OLD_ABSENT_RPC — old concurrency predicate gone from RPC ──
  IF v_def_rpc ILIKE '%is_active = TRUE%expires_at > now()%' THEN
    RAISE EXCEPTION 'VQ.OLD_ABSENT_RPC FAILED — get_plate_pass_status still contains is_active + expires_at count predicate';
  END IF;

  -- ── VQ.NEW_PRESENT_RPC — 30-day predicate in RPC ──
  IF v_def_rpc NOT ILIKE '%created_at > now() - interval%30 days%' THEN
    RAISE EXCEPTION 'VQ.NEW_PRESENT_RPC FAILED — get_plate_pass_status missing created_at 30-day predicate';
  END IF;

  -- ── VQ.V_IS_ANON — v_is_anon variable + auth.uid() present ──
  IF v_def_rpc NOT ILIKE '%v_is_anon%auth.uid() IS NULL%' THEN
    RAISE EXCEPTION 'VQ.V_IS_ANON FAILED — get_plate_pass_status missing v_is_anon := (auth.uid() IS NULL)';
  END IF;

  -- ── VQ.AT_LIMIT_GATED — at_limit exit branches on v_is_anon ──
  IF v_def_rpc NOT ILIKE '%at_limit%CASE WHEN v_is_anon%' THEN
    RAISE EXCEPTION 'VQ.AT_LIMIT_GATED FAILED — at_limit exit not gated on v_is_anon (anon count leak risk)';
  END IF;

  -- ── VQ.WITHIN_GATED — within exit branches on v_is_anon ──
  IF v_def_rpc NOT ILIKE '%within%CASE WHEN v_is_anon%' THEN
    RAISE EXCEPTION 'VQ.WITHIN_GATED FAILED — within exit not gated on v_is_anon (anon count leak risk)';
  END IF;

  -- ── VQ.NO_JWT_IS_NULL_TRAP — anti-refactor guard ──
  -- If someone "simplifies" v_is_anon back to `auth.jwt() IS NULL`, the
  -- guard silently never fires. Detect and reject the anti-pattern.
  IF v_def_rpc ILIKE '%auth.jwt() IS NULL%' THEN
    RAISE EXCEPTION 'VQ.NO_JWT_IS_NULL_TRAP FAILED — get_plate_pass_status contains auth.jwt() IS NULL — Supabase anon key IS a JWT, guard would silently not fire. Use auth.uid() IS NULL.';
  END IF;

  -- ── VQ.GRANTS_PRESERVED — anon+authenticated retain EXECUTE on RPC ──
  IF NOT has_function_privilege('anon', 'public.get_plate_pass_status(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED FAILED — anon lost EXECUTE on get_plate_pass_status';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_plate_pass_status(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED FAILED — authenticated lost EXECUTE on get_plate_pass_status';
  END IF;

  -- ── VQ.SIG_ENFORCE — exactly 1 overload of trigger fn ──
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'enforce_visitor_pass_limit'
         AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_ENFORCE FAILED — enforce_visitor_pass_limit not exactly 1 overload';
  END IF;

  -- ── VQ.SIG_RPC — exactly 1 overload of RPC ──
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'get_plate_pass_status'
         AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_RPC FAILED — get_plate_pass_status not exactly 1 overload';
  END IF;
END $$;

COMMIT;
