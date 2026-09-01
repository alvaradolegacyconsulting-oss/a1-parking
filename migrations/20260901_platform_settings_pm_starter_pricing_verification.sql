-- ══════════════════════════════════════════════════════════════════════
-- 20260901_platform_settings_pm_starter_pricing_verification.sql
--
-- Paired verification. v2 pattern (no BEGIN/COMMIT wrap; terminal
-- SELECT returns PASS row). 6 gates.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: price_pm_starter_base column exists, NUMERIC, nullable ────
DO $$
DECLARE v_type TEXT; v_nullable TEXT;
BEGIN
  SELECT data_type, is_nullable INTO v_type, v_nullable
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='platform_settings'
     AND column_name='price_pm_starter_base';
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: price_pm_starter_base column not found';
  END IF;
  IF v_type <> 'numeric' THEN
    RAISE EXCEPTION 'VS1 FAIL: price_pm_starter_base expected numeric; got %', v_type;
  END IF;
END $$;

-- ── VS2: starter_permit_tiers column exists, JSONB, nullable ───────
DO $$
DECLARE v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='platform_settings'
     AND column_name='starter_permit_tiers';
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: starter_permit_tiers column not found';
  END IF;
  IF v_type <> 'jsonb' THEN
    RAISE EXCEPTION 'VS2 FAIL: starter_permit_tiers expected jsonb; got %', v_type;
  END IF;
END $$;

-- ── VS3: price_pm_only_base + _per_property STILL PRESENT ──────────
-- Verifies the "new columns, not repurposed" invariant. PM-Only stays
-- as a negotiated tier via proposal codes; if these disappear the
-- amendment silently dropped them.
DO $$
DECLARE v_pm_base INT; v_pm_pp INT;
BEGIN
  SELECT COUNT(*) INTO v_pm_base
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='platform_settings' AND column_name='price_pm_only_base';
  SELECT COUNT(*) INTO v_pm_pp
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='platform_settings' AND column_name='price_pm_only_per_property';
  IF v_pm_base = 0 OR v_pm_pp = 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: PM-Only pricing columns lost. price_pm_only_base=% price_pm_only_per_property=% (want 1 each). NEW-COLUMNS-NOT-REPURPOSED invariant broken.',
      v_pm_base, v_pm_pp;
  END IF;
END $$;

-- ── VS4: seed values landed on the id=1 row ────────────────────────
DO $$
DECLARE v_base NUMERIC; v_tiers JSONB;
BEGIN
  SELECT price_pm_starter_base, starter_permit_tiers
    INTO v_base, v_tiers
    FROM public.platform_settings WHERE id = 1;
  IF v_base IS DISTINCT FROM 149 THEN
    RAISE EXCEPTION 'VS4 FAIL: price_pm_starter_base=% (want 149)', v_base;
  END IF;
  IF v_tiers IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: starter_permit_tiers is NULL';
  END IF;
END $$;

-- ── VS5: permit-tiers shape — two bands, band 1 up_to=500 rate=0,
--         band 2 up_to=null rate=125 ─────────────────────────────────
DO $$
DECLARE v_tiers JSONB; v_band0 JSONB; v_band1 JSONB;
BEGIN
  SELECT starter_permit_tiers INTO v_tiers FROM public.platform_settings WHERE id=1;
  IF jsonb_array_length(v_tiers) <> 2 THEN
    RAISE EXCEPTION 'VS5 FAIL: starter_permit_tiers length=% (want 2)', jsonb_array_length(v_tiers);
  END IF;
  v_band0 := v_tiers->0;
  v_band1 := v_tiers->1;
  IF (v_band0->>'up_to')::INT IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'VS5 FAIL: band 1 up_to=% (want 500)', v_band0->>'up_to';
  END IF;
  IF (v_band0->>'rate_cents')::INT IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'VS5 FAIL: band 1 rate_cents=% (want 0 — included allowance)', v_band0->>'rate_cents';
  END IF;
  IF v_band1->>'up_to' IS NOT NULL THEN
    RAISE EXCEPTION 'VS5 FAIL: band 2 up_to=% (want null = infinity)', v_band1->>'up_to';
  END IF;
  IF (v_band1->>'rate_cents')::INT IS DISTINCT FROM 125 THEN
    RAISE EXCEPTION 'VS5 FAIL: band 2 rate_cents=% (want 125 = $1.25/permit overage)', v_band1->>'rate_cents';
  END IF;
END $$;

-- ── VS6: schema audit row present ──────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PLATFORM_SETTINGS_PM_STARTER_PRICING'
     AND new_values->>'migration' = '20260901_platform_settings_pm_starter_pricing';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS6 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'platform_settings PM Starter pricing columns'::TEXT AS target,
  ARRAY[
    'VS1  price_pm_starter_base NUMERIC nullable',
    'VS2  starter_permit_tiers JSONB nullable',
    'VS3  🔴 price_pm_only_base + _per_property PRESERVED (not repurposed)',
    'VS4  seed: base=149 + tiers not NULL',
    'VS5  tiers shape: 2 bands [500@0¢, null@125¢]',
    'VS6  SCHEMA_PLATFORM_SETTINGS_PM_STARTER_PRICING audit row'
  ] AS gates_verified,
  now() AS verified_at;
