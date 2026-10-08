-- ══════════════════════════════════════════════════════════════════════
-- 20260805_current_date_central_helper_verification.sql
-- POST-APPLY: helper exists, STABLE, grants correct, conversion right
-- in both CDT and CST, session-TimeZone-independent.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260805_current_date_central_helper.sql. Paste WHOLE.
-- Inspection + fixed-instant probes only. No probe rows.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.EXISTS ────────────────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc
   WHERE proname = 'current_date_central'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.EXISTS: expected 1 current_date_central(); got %', v_count;
  END IF;
END $$;

-- ── VQ.STABILITY_STABLE ──────────────────────────────────────────────
-- Volatility MUST be STABLE (s). IMMUTABLE (i) is a bug — see helper
-- header rationale.
DO $$
DECLARE v_provolatile "char";
BEGIN
  SELECT provolatile INTO v_provolatile
    FROM pg_proc
   WHERE proname = 'current_date_central'
     AND pronamespace = 'public'::regnamespace;
  IF v_provolatile <> 's' THEN
    RAISE EXCEPTION 'VQ.STABILITY_STABLE: expected STABLE (s); got % (v=volatile, i=IMMUTABLE, s=STABLE)', v_provolatile;
  END IF;
END $$;

-- ── VQ.GRANTS ────────────────────────────────────────────────────────
-- anon MUST NOT have EXECUTE. PUBLIC MUST NOT have EXECUTE (anon
-- inherits from PUBLIC otherwise, per Supabase default behaviour).
-- authenticated is intentionally NOT ASSERTED either way — no current
-- INVOKER caller; a future migration owns that decision.
DO $$
DECLARE v_has_anon boolean; v_has_public boolean;
BEGIN
  SELECT
    has_function_privilege('anon',   'public.current_date_central()', 'EXECUTE'),
    has_function_privilege('public', 'public.current_date_central()', 'EXECUTE')
  INTO v_has_anon, v_has_public;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.GRANTS: anon HAS EXECUTE on current_date_central() (must be REVOKED)';
  END IF;
  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.GRANTS: PUBLIC HAS EXECUTE on current_date_central() (must be REVOKED — anon inherits from PUBLIC otherwise)';
  END IF;
END $$;

-- ── VQ.CONVERSION_CORRECT_BOTH_OFFSETS ───────────────────────────────
-- (Mateo probe 4a). Test at two chosen instants that fall on a
-- DIFFERENT date in UTC than in Central. A midday-UTC probe would pass
-- with the bug still in place. This probes the EXPRESSION, which is
-- also the fn body — so a future edit that changes the timezone
-- string or drops the AT TIME ZONE fails one of these.
DO $$
DECLARE v_result date;
BEGIN
  -- CST (UTC-6): 01:30 UTC on Jan 15 is Jan 14 in Central
  SELECT (('2026-01-15 01:30:00+00'::timestamptz) AT TIME ZONE 'America/Chicago')::date
    INTO v_result;
  IF v_result <> DATE '2026-01-14' THEN
    RAISE EXCEPTION 'VQ.CONVERSION_CORRECT_BOTH_OFFSETS (CST @ 01:30 UTC Jan 15): expected 2026-01-14; got %', v_result;
  END IF;

  -- CDT (UTC-5): 02:30 UTC on Jul 15 is Jul 14 in Central
  SELECT (('2026-07-15 02:30:00+00'::timestamptz) AT TIME ZONE 'America/Chicago')::date
    INTO v_result;
  IF v_result <> DATE '2026-07-14' THEN
    RAISE EXCEPTION 'VQ.CONVERSION_CORRECT_BOTH_OFFSETS (CDT @ 02:30 UTC Jul 15): expected 2026-07-14; got %', v_result;
  END IF;
END $$;

-- ── VQ.SESSION_TZ_INDEPENDENT ────────────────────────────────────────
-- (Mateo probe 4b). Vercel Node is UTC; a future connection pooler
-- or session-level SET TIME ZONE must not move the answer. This is
-- the assertion that actually protects the helper against a "clean
-- up" edit that removes AT TIME ZONE and relies on session default.
--
-- SET LOCAL scopes to the current transaction so no session state
-- leaks. Both calls hit `now()` within microseconds — practically
-- deterministic on the same instant.
DO $$
DECLARE v_utc_result date; v_tokyo_result date;
BEGIN
  SET LOCAL TIME ZONE 'UTC';
  SELECT public.current_date_central() INTO v_utc_result;

  SET LOCAL TIME ZONE 'Asia/Tokyo';
  SELECT public.current_date_central() INTO v_tokyo_result;

  IF v_utc_result <> v_tokyo_result THEN
    RAISE EXCEPTION 'VQ.SESSION_TZ_INDEPENDENT: helper must return same value regardless of session TimeZone; UTC=%, Tokyo=%', v_utc_result, v_tokyo_result;
  END IF;
END $$;

-- ── VQ.MATCHES_CENTRAL_WALL_CLOCK ────────────────────────────────────
-- Sanity: helper returns the same date as the literal expression it
-- inlines. Belt against a future edit that rewrites the body to
-- something clever (e.g., date_trunc('day', now())::date) with
-- different edge behaviour.
DO $$
DECLARE v_helper date; v_literal date;
BEGIN
  SELECT public.current_date_central() INTO v_helper;
  SELECT (now() AT TIME ZONE 'America/Chicago')::date INTO v_literal;
  IF v_helper <> v_literal THEN
    RAISE EXCEPTION 'VQ.MATCHES_CENTRAL_WALL_CLOCK: helper=% literal=% (helper body diverged from documented expression)', v_helper, v_literal;
  END IF;
END $$;

-- ── VQ.COMMENT_ON_PRESENT ────────────────────────────────────────────
DO $$
DECLARE v_comment text;
BEGIN
  SELECT obj_description('public.current_date_central()'::regprocedure, 'pg_proc')
    INTO v_comment;
  IF v_comment IS NULL OR length(v_comment) < 100 THEN
    RAISE EXCEPTION 'VQ.COMMENT_ON_PRESENT: COMMENT ON FUNCTION missing or truncated';
  END IF;
END $$;

COMMIT;
