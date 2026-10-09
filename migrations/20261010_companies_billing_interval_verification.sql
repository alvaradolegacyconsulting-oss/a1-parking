-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — companies.billing_interval
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_probe BIGINT;
BEGIN
  -- G1 — column exists, nullable, no default
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='companies' AND column_name='billing_interval'
  ) THEN
    v_fail := v_fail || 'G1: companies.billing_interval does not exist';
  ELSE
    IF (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='companies' AND column_name='billing_interval') <> 'YES' THEN
      v_fail := v_fail || 'G1: billing_interval is NOT NULL — unknown must be representable';
    END IF;
    -- 🔴 A default would make every unknown company look monthly.
    IF (SELECT column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name='companies' AND column_name='billing_interval') IS NOT NULL THEN
      v_fail := v_fail || 'G1: billing_interval has a DEFAULT — an unknown company would render a confident wrong cycle';
    END IF;
  END IF;

  -- G2 — the CHECK exists AND FIRES. Structural presence is not proof;
  -- a fresh probe row is inserted and rolled back inside a subtxn.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.companies'::regclass AND conname='companies_billing_interval_valid'
  ) THEN
    v_fail := v_fail || 'G2: the CHECK constraint is missing';
  ELSE
    BEGIN
      INSERT INTO public.companies (name, tier, tier_type, is_active, billing_interval)
      VALUES ('ZZ interval probe '||clock_timestamp()::text, 'legacy', 'enforcement', FALSE, 'month')
      RETURNING id INTO v_probe;
      -- Reached only if the CHECK did NOT fire.
      DELETE FROM public.companies WHERE id = v_probe;
      v_fail := v_fail || 'G2: 🔴 billing_interval accepted ''month'' — Stripe vocabulary would leak into the quote call';
    EXCEPTION
      WHEN check_violation THEN
        NULL;  -- correct: refused
      WHEN OTHERS THEN
        -- Another trigger raised first; the CHECK is unproven, so say so
        -- rather than counting an unrelated refusal as a pass.
        v_fail := v_fail || format('G2: probe refused by something OTHER than the CHECK (%s: %s) — the CHECK is UNPROVEN', SQLSTATE, SQLERRM);
    END;
  END IF;

  -- G3 — nothing holds a Stripe-vocabulary value
  IF EXISTS (SELECT 1 FROM public.companies WHERE billing_interval IN ('month','year')) THEN
    v_fail := v_fail || 'G3: a row holds Stripe''s month/year instead of monthly/annual';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'companies.billing_interval'::TEXT AS target,
  'PASS'::TEXT                       AS result,
  (SELECT count(*) FROM public.companies WHERE billing_interval = 'monthly') AS monthly,
  (SELECT count(*) FROM public.companies WHERE billing_interval = 'annual')  AS annual,
  (SELECT count(*) FROM public.companies WHERE billing_interval IS NULL)     AS unknown,
  (SELECT count(*) FROM public.companies WHERE stripe_subscription_id IS NOT NULL
     AND billing_interval IS NULL)                                          AS subscribed_but_unknown_backfill_these;
