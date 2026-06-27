-- Verification queries for platform_settings 3-tier pricing migration.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (proves pre-state: 15 old cols
--      present, 5 new cols absent)
--   2. Apply 20260626_platform_settings_3tier_pricing.sql (single paste)
--   3. Sections B-E post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: column inventory flip — 15 old gone + 5 new present with
--        correct types. Catches a partial DROP or forgotten ADD.
--   - C: seed values readable (4 NUMERIC dollars + 1 JSONB).
--        Catches a forgotten UPDATE seed or NULL leak.
--   - D: permit_tiers JSONB parses as a 4-band ascending array
--        with positive rates + exactly one trailing null up_to.
--        Catches a malformed JSON in the seed string.
--
-- No behavioral test (no constraints / no functions in this commit;
-- the new permit_tiers shape rules live app-side per Jose's lean).

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — confirm pre-state
-- ════════════════════════════════════════════════════════════════════

SELECT
  -- 15 old columns present (sanity recheck of Jose's 2026-06-26 query)
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='platform_settings'
      AND column_name LIKE 'price\_%' ESCAPE '\') = 15                          AS pre_15_old_cols_present,
  -- 5 new columns absent
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_only_base')                          AS pre_no_pm_only_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='permit_tiers')                                AS pre_no_permit_tiers;
-- Expected PRE-APPLY: all 3 TRUE.
-- If pre_15_old_cols_present FALSE → drift since 0.3 audit; STOP and
-- investigate (a column may have been added/dropped in the dashboard
-- between 0.3 and this apply).
-- If pre_no_pm_only_base OR pre_no_permit_tiers FALSE → migration
-- already partially applied; STOP and investigate.


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — column inventory flip
-- ════════════════════════════════════════════════════════════════════

-- B.1 ALL 15 old columns are GONE
SELECT
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_starter_base')                          AS dropped_starter_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_starter_per_property')                  AS dropped_starter_per_property,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_starter_per_driver')                    AS dropped_starter_per_driver,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_growth_base')                           AS dropped_growth_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_growth_per_property')                   AS dropped_growth_per_property,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_growth_per_driver')                     AS dropped_growth_per_driver,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_legacy_base')                           AS dropped_legacy_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_legacy_per_property')                   AS dropped_legacy_per_property,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_legacy_per_driver')                     AS dropped_legacy_per_driver,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_essential_base')                     AS dropped_pm_essential_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_essential_per_property')             AS dropped_pm_essential_per_property,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_professional_base')                  AS dropped_pm_professional_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_professional_per_property')          AS dropped_pm_professional_per_property,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_enterprise_base')                    AS dropped_pm_enterprise_base,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='platform_settings'
                 AND column_name='price_pm_enterprise_per_property')            AS dropped_pm_enterprise_per_property;
-- Expected: all 15 TRUE.

-- B.2 5 new columns PRESENT with correct types
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='platform_settings'
   AND column_name IN (
     'price_pm_only_base',
     'price_pm_only_per_property',
     'price_enforcement_only_base',
     'price_enforcement_only_per_property',
     'permit_tiers'
   )
 ORDER BY column_name;
-- Expected 5 rows:
--   permit_tiers                        | jsonb   | YES
--   price_enforcement_only_base         | numeric | YES
--   price_enforcement_only_per_property | numeric | YES
--   price_pm_only_base                  | numeric | YES
--   price_pm_only_per_property          | numeric | YES

-- B.3 No leftover price_* columns (other than the new pm_only +
-- enforcement_only set — there should be exactly 4 price_* columns
-- now: the 4 flat ones. permit_tiers doesn't have the 'price_' prefix.)
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='platform_settings'
   AND column_name LIKE 'price\_%' ESCAPE '\'
 ORDER BY column_name;
-- Expected 4 rows (alphabetical):
--   price_enforcement_only_base
--   price_enforcement_only_per_property
--   price_pm_only_base
--   price_pm_only_per_property
-- If ANY 6-tier price_* column appears here → DROP didn't take, ABORT.


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — seed values readable + correct
-- ════════════════════════════════════════════════════════════════════

SELECT
  price_pm_only_base,
  price_pm_only_per_property,
  price_enforcement_only_base,
  price_enforcement_only_per_property,
  jsonb_array_length(permit_tiers) AS permit_tier_count
FROM public.platform_settings
WHERE id = 1;
-- Expected:
--   price_pm_only_base                  = 179
--   price_pm_only_per_property          = 20
--   price_enforcement_only_base         = 199
--   price_enforcement_only_per_property = 15
--   permit_tier_count                   = 4


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — permit_tiers JSONB shape correctness
-- ════════════════════════════════════════════════════════════════════
-- Validates the seed JSONB is the expected 4-band ascending shape
-- with exactly one trailing null up_to + all positive rate_cents.

WITH bands AS (
  SELECT
    ordinality AS band_idx,
    (band->>'up_to')::INTEGER     AS up_to,
    (band->>'rate_cents')::INTEGER AS rate_cents
  FROM public.platform_settings,
       jsonb_array_elements(permit_tiers) WITH ORDINALITY AS t(band, ordinality)
  WHERE id = 1
)
SELECT
  -- Exactly 4 bands
  (SELECT COUNT(*) FROM bands) = 4                                              AS band_count_correct,
  -- First 3 bands have up_to IS NOT NULL; last has up_to IS NULL
  (SELECT COUNT(*) FROM bands WHERE up_to IS NOT NULL) = 3                      AS three_bounded_bands,
  (SELECT COUNT(*) FROM bands WHERE up_to IS NULL) = 1                          AS one_unbounded_band,
  (SELECT up_to FROM bands WHERE band_idx = 4) IS NULL                          AS last_band_unbounded,
  -- Bounded up_to values strictly ascending: 50 < 200 < 500
  (SELECT (up_to)::INTEGER FROM bands WHERE band_idx = 1) = 50                  AS band_1_up_to_50,
  (SELECT (up_to)::INTEGER FROM bands WHERE band_idx = 2) = 200                 AS band_2_up_to_200,
  (SELECT (up_to)::INTEGER FROM bands WHERE band_idx = 3) = 500                 AS band_3_up_to_500,
  -- All rate_cents positive
  (SELECT COUNT(*) FROM bands WHERE rate_cents > 0) = 4                         AS all_rates_positive,
  -- Rate values match seed: 200, 175, 150, 125
  (SELECT rate_cents FROM bands WHERE band_idx = 1) = 200                       AS band_1_rate_200,
  (SELECT rate_cents FROM bands WHERE band_idx = 2) = 175                       AS band_2_rate_175,
  (SELECT rate_cents FROM bands WHERE band_idx = 3) = 150                       AS band_3_rate_150,
  (SELECT rate_cents FROM bands WHERE band_idx = 4) = 125                       AS band_4_rate_125;
-- Expected: all 12 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- E. Migration audit row landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration
  FROM public.audit_logs
 WHERE action = 'SCHEMA_COLUMNS_REPLACED'
   AND new_values->>'migration' = '20260626_platform_settings_3tier_pricing'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.
