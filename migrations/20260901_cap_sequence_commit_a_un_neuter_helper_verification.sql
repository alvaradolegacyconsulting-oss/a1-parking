-- ══════════════════════════════════════════════════════════════════════
-- 20260901_cap_sequence_commit_a_un_neuter_helper_verification.sql
--
-- Paired verification for the Commit A un-neuter. v2 pattern.
--
-- ── 8 GATES ─────────────────────────────────────────────────────────
--   VS1  helper exists via to_regprocedure
--   VS2  SECURITY DEFINER + search_path pinned
--   VS3  body references public.companies + lower(trim())
--        (NOT ILIKE — metacharacter-vector closed)
--   VS4  body contains ALL 4 explicit CASE branches (pm_only,
--        enforcement_only, legacy, pm_starter) — dead code check
--        for the pm_starter branch that A₀ will make reachable
--   VS5  🔴 BEHAVIOR PARITY — every existing company's computed limit
--        is -1 (matches pre-Commit-A neuter output). Stronger than
--        a structural check per Mateo Sep 1 §1.
--   VS6  🔴 A1 EXPLICIT — legacy branch returns -1 for A1's row.
--        Load-bearing gate: T5 confirmed no override exists.
--   VS7  UNKNOWN COMPANY — returns -1 (unchanged branch behavior)
--   VS8  schema audit row present
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: signature exists ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_company_property_limit(text)') IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.get_company_property_limit(text) not found';
  END IF;
END $$;

-- ── VS2: DEFINER + search_path pinned ───────────────────────────────
DO $$
DECLARE
  v_oid oid := to_regprocedure('public.get_company_property_limit(text)');
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'VS2 FAIL: not SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) s WHERE s LIKE 'search_path=%'
  ) THEN
    RAISE EXCEPTION 'VS2 FAIL: search_path not pinned. proconfig=%', v_config;
  END IF;
END $$;

-- ── VS3: body references companies + lower(trim()) — NOT ILIKE ─────
DO $$
DECLARE
  v_body TEXT := pg_get_functiondef(to_regprocedure('public.get_company_property_limit(text)'));
BEGIN
  IF v_body NOT ILIKE '%public.companies%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing reference to public.companies';
  END IF;
  IF v_body NOT ILIKE '%lower(trim(name))%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body missing lower(trim(name)) predicate — metacharacter vector may not be closed';
  END IF;
  IF v_body ILIKE '%name ilike p_company_name%' THEN
    RAISE EXCEPTION 'VS3 FAIL: body still contains `name ILIKE p_company_name` — metacharacter vector open';
  END IF;
END $$;

-- ── VS4: all 4 explicit CASE branches ───────────────────────────────
DO $$
DECLARE
  v_body TEXT := pg_get_functiondef(to_regprocedure('public.get_company_property_limit(text)'));
BEGIN
  IF v_body NOT ILIKE '%pm_only%' THEN
    RAISE EXCEPTION 'VS4 FAIL: body missing pm_only branch';
  END IF;
  IF v_body NOT ILIKE '%enforcement_only%' THEN
    RAISE EXCEPTION 'VS4 FAIL: body missing enforcement_only branch';
  END IF;
  IF v_body NOT ILIKE '%legacy%' THEN
    RAISE EXCEPTION 'VS4 FAIL: body missing legacy branch (A1 load-bearing)';
  END IF;
  IF v_body NOT ILIKE '%pm_starter%' THEN
    RAISE EXCEPTION 'VS4 FAIL: body missing pm_starter branch — dead until A₀, but must be present now so A₀ becomes a one-file DDL flip not a two-migration coordination';
  END IF;
END $$;

-- ── VS5: 🔴 BEHAVIOR PARITY — every company returns -1 ─────────────
-- All 3 currently-live tier values (pm_only, enforcement_only, legacy)
-- explicitly return -1 in the CASE. Every company should compute -1.
-- If any returns something else, either the CASE is wrong OR a tier
-- value exists that companies_tier_valid shouldn't have allowed.
DO $$
DECLARE
  v_row RECORD;
  v_limit INT;
  v_offenders TEXT := '';
BEGIN
  FOR v_row IN
    SELECT id, name, tier, tier_type FROM public.companies ORDER BY id
  LOOP
    v_limit := public.get_company_property_limit(v_row.name);
    IF v_limit <> -1 THEN
      v_offenders := v_offenders || format('company_id=%s name="%s" tier=%s tier_type=%s → limit=%s; ',
        v_row.id, v_row.name, v_row.tier, v_row.tier_type, v_limit);
    END IF;
  END LOOP;
  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'VS5 FAIL: computed limits not -1 for existing companies. Behavior parity broken. Offenders: %', v_offenders;
  END IF;
END $$;

-- ── VS6: 🔴 A1 EXPLICIT — legacy branch returns -1 ──────────────────
-- Load-bearing per Mateo Sep 1 §1. Find A1 (tier=legacy per T2) and
-- assert -1. Raises FIXTURE FAIL if no legacy company exists (Test
-- environment without A1 present — say so rather than silently pass).
DO $$
DECLARE
  v_a1_name TEXT;
  v_a1_limit INT;
BEGIN
  SELECT name INTO v_a1_name
    FROM public.companies
   WHERE tier = 'legacy' AND lower(name) LIKE '%a1%'
   ORDER BY id LIMIT 1;
  IF v_a1_name IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no legacy-tier company with name matching A1 found. A1 is tier=legacy per T2 (Aug 28); if missing, either this environment lacks A1 seed OR the legacy branch would go untested here. Report explicitly.';
  END IF;
  v_a1_limit := public.get_company_property_limit(v_a1_name);
  IF v_a1_limit <> -1 THEN
    RAISE EXCEPTION 'VS6 FAIL: A1 (company="%") computed limit=% (want -1). Legacy branch broken; A1 gets capped on Q4 rollout with no override backstop (T5).',
      v_a1_name, v_a1_limit;
  END IF;
END $$;

-- ── VS7: unknown company returns -1 ─────────────────────────────────
DO $$
DECLARE v_limit INT;
BEGIN
  v_limit := public.get_company_property_limit('__no_such_company_' || floor(extract(epoch from now()))::TEXT);
  IF v_limit <> -1 THEN
    RAISE EXCEPTION 'VS7 FAIL: unknown company returned %; want -1 (unchanged fallback behavior)', v_limit;
  END IF;
END $$;

-- ── VS8: schema audit row ──────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_CAP_SEQUENCE_COMMIT_A'
     AND new_values->>'migration' = '20260901_cap_sequence_commit_a_un_neuter_helper';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'get_company_property_limit (Cap Commit A un-neuter)'::TEXT AS target,
  ARRAY[
    'VS1  signature exists',
    'VS2  DEFINER + search_path pinned',
    'VS3  body reads companies via lower(trim()) — NOT ILIKE',
    'VS4  all 4 branches present (pm_only/enforcement_only/legacy/pm_starter)',
    'VS5  🔴 BEHAVIOR PARITY — every existing company still computes -1',
    'VS6  🔴 A1 EXPLICIT — legacy branch returns -1 for A1',
    'VS7  unknown company → -1 (unchanged fallback)',
    'VS8  SCHEMA_CAP_SEQUENCE_COMMIT_A audit row'
  ] AS gates_verified,
  now() AS verified_at;
