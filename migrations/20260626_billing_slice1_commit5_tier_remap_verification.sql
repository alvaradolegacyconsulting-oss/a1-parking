-- Verification queries for slice 1 commit 5 tier remap + neuter + ADD COLUMN.
--
-- RUN ORDER:
--   1. Section A BEFORE applying (pre-state confirms)
--   2. Apply 20260626_billing_slice1_commit5_tier_remap.sql (single paste)
--   3. Sections B–F post-apply
--
-- LOAD-BEARING SECTIONS:
--   - B: distinct tier values ⊆ new 3-set AND companies_tier_valid CHECK present
--   - C: get_company_property_limit returns -1 (behavioral; calls it for any company)
--   - D: pg_proc count = 1 for get_company_property_limit (overload-trap discipline)
--   - E: custom_per_permit_fee column present with correct type
--
-- A, F sanity (audit row + pre-state).

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE
-- ════════════════════════════════════════════════════════════════════

SELECT
  -- Distinct tier values currently include OLD set (proves pre-state)
  EXISTS (SELECT 1 FROM public.companies WHERE tier IN ('starter','growth','essential','professional','enterprise','premium'))
    AS pre_has_old_tier_values,
  -- companies_tier_valid CHECK does NOT yet exist
  NOT EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid='public.companies'::regclass
                 AND conname='companies_tier_valid')
    AS pre_no_tier_check,
  -- custom_per_permit_fee column does NOT yet exist
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='proposal_codes'
                 AND column_name='custom_per_permit_fee')
    AS pre_no_permit_fee_col,
  -- get_company_property_limit exists with 1 signature (commit 1 era unchanged)
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='get_company_property_limit' AND pronamespace='public'::regnamespace) = 1
    AS pre_func_one_signature;
-- Expected: all 4 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- B. ★ LOAD-BEARING — tier remap clean + CHECK present
-- ════════════════════════════════════════════════════════════════════

-- B.1 — Distinct tier values now ⊆ new 3-set (no old values survive)
SELECT
  (SELECT COUNT(*) FROM public.companies
    WHERE tier NOT IN ('pm_only','enforcement_only','legacy')) = 0
    AS all_tiers_in_new_set,
  -- Belt + suspenders: no old tier value remaining
  (SELECT COUNT(*) FROM public.companies
    WHERE tier IN ('starter','growth','essential','professional','enterprise','premium')) = 0
    AS no_old_tier_values_remain,
  -- CHECK constraint present + correct
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.companies'::regclass
             AND conname='companies_tier_valid'
             AND pg_get_constraintdef(oid) ~ 'pm_only'
             AND pg_get_constraintdef(oid) ~ 'enforcement_only'
             AND pg_get_constraintdef(oid) ~ 'legacy')
    AS tier_check_present_and_correct,
  -- tier_type CHECK survives unchanged
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid='public.companies'::regclass
             AND conname='companies_tier_type_valid')
    AS tier_type_check_survived;
-- Expected: all 4 TRUE.

-- B.2 — Per-tier counts (for cross-check against Jose's pre-apply data)
SELECT tier, COUNT(*) FROM public.companies GROUP BY tier ORDER BY tier;
-- Expected (per Jose §0.1 mapping):
--   enforcement_only | 2   (was: starter 2)
--   pm_only          | 2   (was: essential 1 + professional 1)
--   legacy           | 10  (was: legacy 10 — KEPT AS-IS)
-- Total = 14 (matches pre-count)


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — get_company_property_limit() behavioral test
-- ════════════════════════════════════════════════════════════════════
-- Calls the function for any existing company; expects -1 (unlimited).
-- Mirrors the call shape the enforce_property_limit() trigger uses.

DO $get_limit_d$
DECLARE
  v_test_company TEXT;
  v_returned     INTEGER;
BEGIN
  -- Pick any company name (we don't care which; the function should
  -- return -1 for all of them post-neuter)
  SELECT name INTO v_test_company FROM public.companies ORDER BY id LIMIT 1;
  IF v_test_company IS NULL THEN
    RAISE NOTICE 'Section C SKIPPED — no companies in DB to test against';
    RETURN;
  END IF;

  v_returned := public.get_company_property_limit(v_test_company);

  RAISE NOTICE '── Section C get_company_property_limit() ──';
  RAISE NOTICE '  test_company = "%"', v_test_company;
  RAISE NOTICE '  returned     = % (expected -1 = unlimited)', v_returned;

  IF v_returned <> -1 THEN
    RAISE EXCEPTION 'Section C FAIL — function returned % (expected -1). Neuter not applied; tier-derived caps may still fire.', v_returned;
  END IF;
END;
$get_limit_d$;


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — pg_proc count for get_company_property_limit
-- ════════════════════════════════════════════════════════════════════

SELECT
  (SELECT COUNT(*) FROM pg_proc
    WHERE proname='get_company_property_limit' AND pronamespace='public'::regnamespace) = 1
    AS exactly_one_signature,
  -- Signature unchanged: (text) returns integer
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='get_company_property_limit'
             AND pronamespace='public'::regnamespace
             AND pronargs = 1
             AND proargtypes::oid[] = ARRAY['text'::regtype::oid])
    AS signature_unchanged,
  -- Still SECURITY DEFINER
  EXISTS (SELECT 1 FROM pg_proc
           WHERE proname='get_company_property_limit'
             AND pronamespace='public'::regnamespace
             AND prosecdef = TRUE)
    AS still_security_definer;
-- Expected: all 3 TRUE.


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — custom_per_permit_fee column present + correct
-- ════════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name='proposal_codes'
   AND column_name='custom_per_permit_fee';
-- Expected 1 row:
--   custom_per_permit_fee | numeric | YES | (null)

-- Belt-and-suspenders: confirm the existing custom_*_fee columns SURVIVE
-- (defensive — back-compat for existing proposal_codes; custom_per_driver_fee
-- specifically must stay per Jose's "keep for back-compat" decision)
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='proposal_codes'
   AND column_name LIKE 'custom_%_fee'
 ORDER BY column_name;
-- Expected 4 rows:
--   custom_base_fee
--   custom_per_driver_fee   ← KEPT for back-compat
--   custom_per_permit_fee   ← NEW
--   custom_per_property_fee


-- ════════════════════════════════════════════════════════════════════
-- F. Migration audit row landed
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, table_name, new_values->>'migration' AS migration, new_values->>'slice' AS slice
  FROM public.audit_logs
 WHERE action = 'SCHEMA_SLICE_CLOSE'
   AND new_values->>'migration' = '20260626_billing_slice1_commit5_tier_remap'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: 1 row.
