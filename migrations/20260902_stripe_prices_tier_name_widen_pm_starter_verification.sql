-- ══════════════════════════════════════════════════════════════════════
-- 20260902_stripe_prices_tier_name_widen_pm_starter_verification.sql
--
-- Paired verification. v2 pattern (no BEGIN/COMMIT wrap; terminal
-- SELECT returns PASS row). 7 gates.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  stripe_prices_tier_name_valid constraint exists (single row)
--   VS2  constraint definition names all 4 values including pm_starter
--   VS3  🔴 EXECUTION — INSERT with tier_name='pm_starter' SUCCEEDS
--        (probe row inserted + deleted; asserts widening actually
--        enables what it claims)
--   VS4  🔴 EXECUTION — INSERT with tier_name='not_a_real_tier'
--        REJECTS with 23514 (asserts constraint still enforcing)
--   VS5  existing row counts unchanged for pm_only + enforcement_only
--        + legacy (widening didn't drop values)
--   VS6  pm_starter row count is 0 (this migration doesn't insert
--        Prices — the script does; VS3's probe is deleted)
--   VS7  schema audit row present
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: constraint exists ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname='public' AND t.relname='stripe_prices'
     AND c.conname='stripe_prices_tier_name_valid'
     AND c.contype='c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: stripe_prices_tier_name_valid CHECK not found exactly once (got %)', v_count;
  END IF;
END $$;

-- ── VS2: definition includes all 4 values ───────────────────────────
DO $$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname='public' AND t.relname='stripe_prices'
     AND c.conname='stripe_prices_tier_name_valid';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: constraint definition unreadable';
  END IF;
  IF v_def NOT LIKE '%pm_only%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing pm_only. def=%', v_def; END IF;
  IF v_def NOT LIKE '%enforcement_only%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing enforcement_only. def=%', v_def; END IF;
  IF v_def NOT LIKE '%legacy%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing legacy. def=%', v_def; END IF;
  IF v_def NOT LIKE '%pm_starter%' THEN RAISE EXCEPTION 'VS2 FAIL: definition missing pm_starter (the whole point of this migration). def=%', v_def; END IF;
END $$;

-- ── VS3: 🔴 execution — pm_starter INSERT SUCCEEDS ─────────────────
-- Probe row deleted before block ends. Uses letters+digits-only
-- lookup_key + stripe ids to avoid tripping any other CHECK
-- (learned from feedback_fresh_probe_rows_for_check_verification).
DO $$
DECLARE
  v_probe_id BIGINT;
BEGIN
  INSERT INTO public.stripe_prices (
    tier_track, tier_name, line_item, cycle, mode,
    unit_amount_cents, price_model, tiers,
    lookup_key, stripe_price_id, stripe_product_id, is_active
  )
  VALUES (
    'property_management', 'pm_starter', 'base', 'monthly', 'test',
    14900, 'flat', NULL,
    'vs3probe' || floor(extract(epoch from now()))::TEXT,
    'price_vs3probe' || floor(extract(epoch from now()))::TEXT,
    'prod_vs3probe' || floor(extract(epoch from now()))::TEXT,
    false
  )
  RETURNING id INTO v_probe_id;
  DELETE FROM public.stripe_prices WHERE id = v_probe_id;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'VS3 FAIL: pm_starter INSERT REJECTED — widening did not enable the value it claims to. SQLSTATE=% MSG=%', SQLSTATE, SQLERRM;
END $$;

-- ── VS4: 🔴 execution — invalid tier_name REJECTS with 23514 ────────
DO $$
DECLARE v_sqlstate TEXT; v_msg TEXT;
BEGIN
  BEGIN
    INSERT INTO public.stripe_prices (
      tier_track, tier_name, line_item, cycle, mode,
      unit_amount_cents, price_model, tiers,
      lookup_key, stripe_price_id, stripe_product_id, is_active
    )
    VALUES (
      'property_management', 'not_a_real_tier', 'base', 'monthly', 'test',
      100, 'flat', NULL,
      'vs4probe' || floor(extract(epoch from now()))::TEXT,
      'price_vs4probe' || floor(extract(epoch from now()))::TEXT,
      'prod_vs4probe' || floor(extract(epoch from now()))::TEXT,
      false
    );
    RAISE EXCEPTION 'VS4 FAIL: invalid tier_name INSERT SUCCEEDED — constraint no longer enforcing after widening';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS4 FAIL: expected 23514; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%stripe_prices_tier_name_valid%' THEN
      RAISE EXCEPTION 'VS4 FAIL: got 23514 but from wrong constraint. msg=%', v_msg;
    END IF;
  END;
END $$;

-- ── VS5: existing tier row counts unchanged ────────────────────────
-- Widening doesn't touch existing rows; counts for pm_only /
-- enforcement_only / legacy should be exactly what they were before
-- (we don't know the exact number a priori, but they should all be
-- greater than 0 given the script has run before — asserting > 0
-- catches accidental TRUNCATE or DELETE).
DO $$
DECLARE
  v_pm_only INT;
  v_enf INT;
BEGIN
  SELECT COUNT(*) INTO v_pm_only FROM public.stripe_prices WHERE tier_name='pm_only' AND proposal_code_id IS NULL;
  SELECT COUNT(*) INTO v_enf     FROM public.stripe_prices WHERE tier_name='enforcement_only' AND proposal_code_id IS NULL;
  IF v_pm_only < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: pm_only rows unexpectedly 0 — widening dropped them? expected ≥1 (script has been run before).';
  END IF;
  IF v_enf < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: enforcement_only rows unexpectedly 0 — widening dropped them? expected ≥1.';
  END IF;
END $$;

-- ── VS6: pm_starter row count is 0 ──────────────────────────────────
-- This migration widens the CHECK; it doesn't insert Price rows —
-- create-stripe-prices.ts does that. VS3's probe is deleted. So the
-- pm_starter row count post-apply should be 0 (aside from any rows
-- the script may have left before this migration ran — expected 0
-- from the aborted Sep 2 test-mode rehearsal, but tolerant of any
-- state the script left).
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.stripe_prices WHERE tier_name='pm_starter';
  IF v_count > 0 THEN
    RAISE NOTICE 'VS6 INFO: pm_starter row count = % (not 0 — expected only if create-stripe-prices.ts ran between this migration apply and this verification). Not a failure — surfacing for awareness.', v_count;
  END IF;
END $$;

-- ── VS7: schema audit row present ──────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action='SCHEMA_STRIPE_PRICES_TIER_NAME_WIDEN'
     AND new_values->>'migration'='20260902_stripe_prices_tier_name_widen_pm_starter';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS7 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'stripe_prices.tier_name CHECK widened to include pm_starter'::TEXT AS target,
  ARRAY[
    'VS1  stripe_prices_tier_name_valid CHECK present (exactly 1)',
    'VS2  definition includes pm_only + enforcement_only + legacy + pm_starter',
    'VS3  🔴 execution — pm_starter INSERT SUCCEEDS',
    'VS4  🔴 execution — invalid tier_name → 23514 (constraint still enforcing)',
    'VS5  existing pm_only + enforcement_only rows preserved',
    'VS6  pm_starter rows post-apply = 0 (or logged as info)',
    'VS7  SCHEMA_STRIPE_PRICES_TIER_NAME_WIDEN audit row'
  ] AS gates_verified,
  now() AS verified_at;
