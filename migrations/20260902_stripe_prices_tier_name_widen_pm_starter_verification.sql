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

-- ── VS3: 🔴 real-data proof — pm_starter rows exist in stripe_prices
-- 🔴 Sep 3 2026 rewrite: was an INSERT probe; probe collided with real
-- data (23505 unique on stripe_prices_unique_combo_standard) after
-- Jose ran create-stripe-prices.ts and real pm_starter rows landed.
-- Per feedback_probes_collide_with_production_state: when real rows
-- exist at the probe's address, don't probe — assert the real data.
-- Real rows are the stronger proof (CHECK accepted the value in
-- production, at scale, from the actual writer path).
DO $$
DECLARE
  v_pm_starter_count INT;
  v_wrong_track INT;
BEGIN
  SELECT COUNT(*) INTO v_pm_starter_count
    FROM public.stripe_prices
   WHERE tier_name = 'pm_starter'
     AND proposal_code_id IS NULL;

  IF v_pm_starter_count < 1 THEN
    RAISE EXCEPTION 'VS3 FAIL: no pm_starter rows in stripe_prices — create-stripe-prices.ts has not run since the tier_name CHECK widen. Cannot prove the CHECK accepts pm_starter without either real data or a probe. Run the amended script and re-verify.';
  END IF;

  -- All pm_starter rows must be on property_management track
  -- (Bar-2 catalog invariant; scoping mismatch would indicate a
  -- script bug or manual DB tampering).
  SELECT COUNT(*) INTO v_wrong_track
    FROM public.stripe_prices
   WHERE tier_name = 'pm_starter'
     AND tier_track <> 'property_management';
  IF v_wrong_track > 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: % pm_starter row(s) have unexpected tier_track (want property_management)', v_wrong_track;
  END IF;
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

-- ── VS6: pm_starter catalog shape (4 rows per mode) ────────────────
-- 🔴 Sep 3 2026 rewrite: was "expect 0 or informational" — stale the
-- moment Jose ran create-stripe-prices.ts (both modes). Flipped to
-- assert the catalog's real shape post-run:
--   4 pm_starter rows per mode (base × 2 cycles + per_permit × 2 cycles)
-- Per feedback_probes_collide_with_production_state: post-apply
-- counts that assumed empty must flip when the real writer runs.
--
-- If Jose ran only test mode (not live yet), the live half of this
-- gate raises — that's the correct behavior (surfaces the incomplete
-- state rather than passing silently on partial catalog).
DO $$
DECLARE
  v_test INT;
  v_live INT;
BEGIN
  SELECT COUNT(*) INTO v_test
    FROM public.stripe_prices
   WHERE tier_name = 'pm_starter'
     AND mode = 'test'
     AND proposal_code_id IS NULL;
  SELECT COUNT(*) INTO v_live
    FROM public.stripe_prices
   WHERE tier_name = 'pm_starter'
     AND mode = 'live'
     AND proposal_code_id IS NULL;

  IF v_test <> 4 THEN
    RAISE EXCEPTION 'VS6 FAIL: pm_starter test-mode rows = % (want 4: base m/a + per_permit m/a). Test rehearsal may not have completed or may have collided.', v_test;
  END IF;
  IF v_live <> 4 THEN
    RAISE EXCEPTION 'VS6 FAIL: pm_starter live-mode rows = % (want 4). Live catalog run has not been performed yet — re-run this verification AFTER STRIPE_MODE=live create-stripe-prices.ts.', v_live;
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
    'VS3  🔴 real-data proof — pm_starter rows exist + all on property_management track',
    'VS4  🔴 execution — invalid tier_name → 23514 (constraint still enforcing)',
    'VS5  existing pm_only + enforcement_only rows preserved',
    'VS6  pm_starter catalog shape — exactly 4 rows per mode (base m/a + per_permit m/a)',
    'VS7  SCHEMA_STRIPE_PRICES_TIER_NAME_WIDEN audit row'
  ] AS gates_verified,
  now() AS verified_at;
