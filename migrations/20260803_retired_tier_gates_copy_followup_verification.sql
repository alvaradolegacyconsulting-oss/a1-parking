-- ══════════════════════════════════════════════════════════════════════
-- 20260803_retired_tier_gates_copy_followup_verification.sql
-- POST-APPLY: assert signatures stable, bodies scrubbed of support
-- address + "Upgrade tier", bodies carry the new fact-not-permission
-- copy, and the standing global gate returns zero.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260803_retired_tier_gates_copy_followup.sql.
-- Paste WHOLE. No behavioural probes — inspection only. No probe rows.
--
-- The original tier-gate verification file
-- (20260803_retired_tier_gates_visitor_passes_verification.sql) is
-- re-runnable and will now pass VQ.SUPPORT_ADDRESS_ZERO after this
-- follow-up applies. Recommend re-running it once as a sanity check.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.SIGNATURES_STABLE ─────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants only when signature is stable.
-- Both reworded functions must still exist with (0 args, trigger).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'enforce_visitor_pass_monthly_limit'
    AND p.pronargs = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURES_STABLE: expected 1 enforce_visitor_pass_monthly_limit(); found %', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'enforce_visitor_pass_duration'
    AND p.pronargs = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURES_STABLE: expected 1 enforce_visitor_pass_duration(); found %', v_count;
  END IF;
END $$;

-- ── VQ.MONTHLY_LIMIT_COPY ────────────────────────────────────────────
-- Body scrubbed of the old copy; new fact-not-permission copy present.
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
  FROM pg_proc
  WHERE proname = 'enforce_visitor_pass_monthly_limit'
    AND pronamespace = 'public'::regnamespace;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.MONTHLY_LIMIT_COPY: function body unreadable';
  END IF;

  IF position('support@shieldmylot' in v_body) <> 0 THEN
    RAISE EXCEPTION 'VQ.MONTHLY_LIMIT_COPY: body still contains support address';
  END IF;
  IF position('Upgrade tier' in v_body) <> 0 THEN
    RAISE EXCEPTION 'VQ.MONTHLY_LIMIT_COPY: body still contains "Upgrade tier" copy';
  END IF;
  IF position('monthly visitor pass limit' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.MONTHLY_LIMIT_COPY: body missing expected new copy ("monthly visitor pass limit")';
  END IF;
  IF position('Contact the property manager' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.MONTHLY_LIMIT_COPY: body missing expected HINT ("Contact the property manager")';
  END IF;
END $$;

-- ── VQ.DURATION_COPY ─────────────────────────────────────────────────
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
  FROM pg_proc
  WHERE proname = 'enforce_visitor_pass_duration'
    AND pronamespace = 'public'::regnamespace;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.DURATION_COPY: function body unreadable';
  END IF;

  IF position('support@shieldmylot' in v_body) <> 0 THEN
    RAISE EXCEPTION 'VQ.DURATION_COPY: body still contains support address';
  END IF;
  IF position('Upgrade tier' in v_body) <> 0 THEN
    RAISE EXCEPTION 'VQ.DURATION_COPY: body still contains "Upgrade tier" copy';
  END IF;
  IF position('limited to % hours' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.DURATION_COPY: body missing expected new copy ("limited to %% hours")';
  END IF;
  IF position('Contact the property manager' in v_body) = 0 THEN
    RAISE EXCEPTION 'VQ.DURATION_COPY: body missing expected HINT ("Contact the property manager")';
  END IF;
END $$;

-- ── VQ.SUPPORT_ADDRESS_ZERO ──────────────────────────────────────────
-- The standing global gate. Zero support-address / "Upgrade tier"
-- leaks across every function in public schema. Keep this VQ in the
-- permanent set — it's cheap, it's now demonstrated to catch things,
-- and it's the standing guard against the next person copying that
-- RAISE block into a new gate.
DO $$
DECLARE
  v_leaks int;
  v_names text;
BEGIN
  SELECT COUNT(*), string_agg(p.oid::regprocedure::text, ', ')
  INTO v_leaks, v_names
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND (p.prosrc ILIKE '%support@shieldmylot%' OR p.prosrc ILIKE '%Upgrade tier%');
  IF v_leaks <> 0 THEN
    RAISE EXCEPTION 'VQ.SUPPORT_ADDRESS_ZERO: expected 0 support-address/Upgrade-tier leaks in public fns; found % — %', v_leaks, v_names;
  END IF;
END $$;

-- ── VQ.TRIGGER_INVENTORY_UNCHANGED ───────────────────────────────────
-- Sanity: this follow-up must NOT have re-attached either trigger.
-- Still exactly 1 non-internal trigger on visitor_passes (the
-- rolling-30). If a re-attach slipped in, it arms retired caps.
DO $$
DECLARE
  v_count int;
  v_names text;
BEGIN
  SELECT COUNT(*), string_agg(tgname, ', ' ORDER BY tgname)
  INTO v_count, v_names
  FROM pg_trigger
  WHERE tgrelid = 'public.visitor_passes'::regclass
    AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.TRIGGER_INVENTORY_UNCHANGED: expected 1 non-internal trigger on visitor_passes; found % (%)', v_count, v_names;
  END IF;
  IF v_names NOT ILIKE '%enforce_visitor_pass_limit%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_INVENTORY_UNCHANGED: sole trigger is not rolling-30 (%)', v_names;
  END IF;
END $$;

COMMIT;
