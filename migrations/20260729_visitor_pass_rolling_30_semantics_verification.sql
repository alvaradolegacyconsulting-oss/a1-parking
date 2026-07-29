-- ══════════════════════════════════════════════════════════════════════
-- 20260729_visitor_pass_rolling_30_semantics_verification.sql
-- Post-apply structural verification. Silent success = PASS.
--
-- ── 2026-07-29 v2 — whitespace-normalized + structural count ──────────
-- v1 shipped with a pattern-order fragility: ILIKE patterns encoding
-- token order + implicit whitespace mis-fired against the deparsed body
-- (VQ.WITHIN_GATED false-failed on a correct function because
-- `CASE WHEN v_is_anon` appears BEFORE `within` in the deparsed output,
-- so `%within%CASE WHEN v_is_anon%` couldn't match). Rewritten to:
--   1. Normalize both bodies once (regexp_replace '\s+' → ' ') so
--      indentation and line breaks can't affect matches.
--   2. Use single-substring assertions where a token is diagnostic
--      by itself (e.g. 'expires_at' means the old predicate is back).
--   3. Structural count assertion (VQ.GATED_EXIT_COUNT) — exactly 2
--      v_is_anon-gated exits — catches a third count-carrying exit
--      being added ungated, which no LIKE would notice.
--   4. Anti-refactor guards for BOTH auth.jwt() IS NULL (Supabase
--      anon key is a JWT; guard silently no-ops) AND expires_at
--      (old concurrency predicate returning).
--
-- Discipline: "Normalize whitespace in VQ patterns — column alignment
-- is not executable syntax." Bitten twice this week (rename probe's
-- <PID> placeholder, this file's within-block indent). Pair with the
-- negative-control-arrival discipline in the next CURRENT_STATE update.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def_enforce      TEXT;
  v_def_rpc          TEXT;
  v_norm_enforce     TEXT;
  v_norm_rpc         TEXT;
  v_gated_exit_count INT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def_enforce
    FROM pg_proc
   WHERE proname = 'enforce_visitor_pass_limit'
     AND pronamespace = 'public'::regnamespace;
  SELECT pg_get_functiondef(oid) INTO v_def_rpc
    FROM pg_proc
   WHERE proname = 'get_plate_pass_status'
     AND pronamespace = 'public'::regnamespace;

  -- Whitespace normalization — collapse all runs of whitespace (spaces,
  -- tabs, newlines, deparser indentation) to a single space. Every
  -- pattern check below runs against these normalized strings, so
  -- indentation and line-wrap variations can't cause false failures.
  v_norm_enforce := regexp_replace(v_def_enforce, '\s+', ' ', 'g');
  v_norm_rpc     := regexp_replace(v_def_rpc,     '\s+', ' ', 'g');


  -- ═══════════ enforce_visitor_pass_limit (trigger) ═══════════════════

  -- VQ.OLD_ABSENT_ENFORCE — old predicate gone. `expires_at` was only
  -- used inside the concurrency count predicate; its presence is
  -- diagnostic of the old code returning.
  IF v_norm_enforce ILIKE '%expires_at%' THEN
    RAISE EXCEPTION 'VQ.OLD_ABSENT_ENFORCE FAILED — enforce_visitor_pass_limit still references expires_at (old concurrency predicate returned)';
  END IF;

  -- VQ.NEW_PRESENT_ENFORCE — 30-day rolling window predicate present.
  IF v_norm_enforce NOT ILIKE '%created_at%interval%30 days%' THEN
    RAISE EXCEPTION 'VQ.NEW_PRESENT_ENFORCE FAILED — enforce_visitor_pass_limit missing created_at + interval + 30 days';
  END IF;

  -- VQ.HINT_NEW_ENFORCE — new HINT copy (plain substring, safe as-is).
  IF v_norm_enforce NOT ILIKE '%Contact the property manager if you need access%' THEN
    RAISE EXCEPTION 'VQ.HINT_NEW_ENFORCE FAILED — enforce_visitor_pass_limit missing new HINT copy';
  END IF;


  -- ═══════════ get_plate_pass_status (RPC) ════════════════════════════

  -- VQ.OLD_ABSENT_RPC — same shape as trigger. `expires_at` only used
  -- in the old concurrency count.
  IF v_norm_rpc ILIKE '%expires_at%' THEN
    RAISE EXCEPTION 'VQ.OLD_ABSENT_RPC FAILED — get_plate_pass_status still references expires_at (old concurrency predicate returned)';
  END IF;

  -- VQ.NEW_PRESENT_RPC — 30-day predicate.
  IF v_norm_rpc NOT ILIKE '%created_at%interval%30 days%' THEN
    RAISE EXCEPTION 'VQ.NEW_PRESENT_RPC FAILED — get_plate_pass_status missing created_at + interval + 30 days';
  END IF;

  -- VQ.V_IS_ANON — v_is_anon variable + auth.uid() branch present.
  -- Normalized form: 'v_is_anon := (auth.uid() IS NULL)' collapses to
  -- 'v_is_anon := (auth.uid() IS NULL)' (already single-spaced in source).
  IF v_norm_rpc NOT ILIKE '%v_is_anon := (auth.uid() IS NULL)%' THEN
    RAISE EXCEPTION 'VQ.V_IS_ANON FAILED — get_plate_pass_status missing `v_is_anon := (auth.uid() IS NULL)` assignment';
  END IF;

  -- VQ.AT_LIMIT_GATED — the at_limit exit branches on v_is_anon. The
  -- structural signature is `THEN jsonb_build_object('state', 'at_limit')
  -- ELSE` — a bare THEN...ELSE around 'state', 'at_limit' proves the
  -- CASE-around-anon shape is intact. Whitespace-normalized.
  IF v_norm_rpc NOT LIKE '%THEN jsonb_build_object(''state'', ''at_limit'') ELSE%' THEN
    RAISE EXCEPTION 'VQ.AT_LIMIT_GATED FAILED — at_limit exit not gated on v_is_anon (expected THEN jsonb_build_object(''state'', ''at_limit'') ELSE ...)';
  END IF;

  -- VQ.WITHIN_GATED — same shape for the within exit.
  IF v_norm_rpc NOT LIKE '%THEN jsonb_build_object(''state'', ''within'') ELSE%' THEN
    RAISE EXCEPTION 'VQ.WITHIN_GATED FAILED — within exit not gated on v_is_anon (expected THEN jsonb_build_object(''state'', ''within'') ELSE ...)';
  END IF;

  -- VQ.GATED_EXIT_COUNT — exactly 2 v_is_anon-gated exits. Catches the
  -- case where a third count-carrying exit is added ungated (which
  -- neither LIKE above would notice — they'd both still find their
  -- specific state string). Structural, format-invariant.
  v_gated_exit_count := (length(v_norm_rpc) - length(replace(v_norm_rpc, 'CASE WHEN v_is_anon', '')))
                        / length('CASE WHEN v_is_anon');
  IF v_gated_exit_count <> 2 THEN
    RAISE EXCEPTION 'VQ.GATED_EXIT_COUNT FAILED — expected exactly 2 v_is_anon-gated exits, got %', v_gated_exit_count;
  END IF;

  -- VQ.NO_JWT_IS_NULL_TRAP — anti-refactor guard. If someone
  -- "simplifies" v_is_anon back to `auth.jwt() IS NULL`, the guard
  -- silently never fires (Supabase anon key IS a JWT).
  IF v_norm_rpc ILIKE '%auth.jwt() IS NULL%' THEN
    RAISE EXCEPTION 'VQ.NO_JWT_IS_NULL_TRAP FAILED — get_plate_pass_status contains auth.jwt() IS NULL. Supabase anon key IS a JWT — guard silently no-ops. Use auth.uid() IS NULL.';
  END IF;


  -- ═══════════ Grants + signatures ════════════════════════════════════

  -- VQ.GRANTS_PRESERVED — CREATE OR REPLACE keeps grants; if this fails,
  -- someone converted to DROP+CREATE and forgot the re-grant.
  IF NOT has_function_privilege('anon', 'public.get_plate_pass_status(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED FAILED — anon lost EXECUTE on get_plate_pass_status';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_plate_pass_status(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_PRESERVED FAILED — authenticated lost EXECUTE on get_plate_pass_status';
  END IF;

  -- VQ.SIG_ENFORCE / VQ.SIG_RPC — exactly 1 overload each; no overload trap.
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'enforce_visitor_pass_limit'
         AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_ENFORCE FAILED — enforce_visitor_pass_limit not exactly 1 overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'get_plate_pass_status'
         AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_RPC FAILED — get_plate_pass_status not exactly 1 overload';
  END IF;
END $$;

COMMIT;
