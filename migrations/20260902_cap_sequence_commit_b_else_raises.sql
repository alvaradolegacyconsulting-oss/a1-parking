-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_b_else_raises.sql
--
-- 🟢 Cap sequence Commit B of 4 (A → B → C → A₀)
--
-- Per Mateo Sep 1 §1 + Sep 2 §3. Flips the ELSE fallback in
-- public.get_company_property_limit() from `RETURN -1` to
-- `RAISE EXCEPTION 'tier_unrecognized'`.
--
-- Zero behavior change against current data: every live tier value
-- (pm_only, enforcement_only, legacy) has an explicit CASE branch
-- added in Commit A (7b67ff8) + pm_starter branch is present (dead
-- until Commit A₀). No company falls into ELSE today; ELSE is
-- dead-code that only fires when someone widens companies_tier_valid
-- without updating this helper — the drift-loud fallback.
--
-- ── COMMIT B SEQUENCE POSITION ─────────────────────────────────────
--
--     A (7b67ff8)  un-neuter helper, explicit CASE, ELSE returns -1
--   → B (THIS)     flip ELSE to RAISE (still zero behavior change today)
--     C            BEFORE UPDATE OF is_active branch on
--                  enforce_property_limit trigger (reactivation bypass)
--     A₀           widen companies_tier_valid CHECK for 'pm_starter'
--
-- ── SHAPE CHANGE ────────────────────────────────────────────────────
--
-- Postgres CASE is an expression, not a statement — can't RAISE from
-- inside it. Body switches to IF/ELSIF/ELSE with RETURN + a RAISE in
-- the ELSE branch. Same 4 tier values named; same return values.
-- Only the fallback path changes.
--
-- ── RAISE MESSAGE ──────────────────────────────────────────────────
--
-- Written for the person who hits it: someone who added a tier to
-- companies_tier_valid and forgot to update this helper — exactly
-- the drift class that produced this thread (Cap A un-neuter was
-- necessary because the June 26 neuter left the helper unable to
-- see pm_starter arriving in A₀).
--
-- Names: the unrecognized tier value, the function, the fix ("add
-- a branch to the CASE"). All in one line so the error shows the
-- next action.
--
-- ── BEHAVIOR PARITY PATTERN (Sep 2 memory rule 7) ──────────────────
--
-- 🔴 Mateo Sep 1 §5 + Sep 2 §3: "assert that computed limits for all
-- five companies are identical before and after." Sep 2 memory rule
-- (feedback_gates_must_assert_what_they_measured item 7): a parity
-- gate's post-state alone can't prove parity — need explicit
-- before-value.
--
-- Migration captures pre-apply computed limits (for all companies)
-- into the audit_logs.new_values JSONB BEFORE the CREATE OR REPLACE
-- fires. Verification reads that JSONB back, computes post-apply
-- limits live, asserts per-company equality. Any drift surfaces
-- explicitly with the offending company_id + before + after.
--
-- Sets the pattern Cap C will reuse.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- 1. BEGIN — atomic apply.
-- 2. Snapshot pre-apply limits per company into local variable.
-- 3. CREATE OR REPLACE FUNCTION (body swap only; signature,
--    DEFINER, search_path unchanged from Commit A).
-- 4. Verify post-apply per-company limits match snapshot inside the
--    same transaction — if any drift, RAISE and rollback.
--    (Belt + suspenders — the paired verification file does this
--    too, but in-migration catch means an apply that would corrupt
--    behavior never lands.)
-- 5. INSERT audit row with pre_apply_limits JSONB (post-apply values
--    provable-equal by the previous step; not redundantly stored).
-- 6. COMMIT.
--
-- CREATE OR REPLACE preserves grants + no parameter defaults on this
-- fn so feedback_create_or_replace_drops_defaults doesn't apply.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Snapshot pre-apply limits (before CREATE OR REPLACE) ──
DO $$
DECLARE
  v_pre_apply_limits JSONB := '{}'::jsonb;
  v_row RECORD;
  v_limit INT;
BEGIN
  FOR v_row IN SELECT id, name FROM public.companies ORDER BY id LOOP
    v_limit := public.get_company_property_limit(v_row.name);
    v_pre_apply_limits := v_pre_apply_limits || jsonb_build_object(v_row.id::TEXT, v_limit);
  END LOOP;

  -- Stash in a session GUC so the audit row (below, after
  -- CREATE OR REPLACE) can read it back without recomputing.
  PERFORM set_config('app.cap_b_pre_apply_limits', v_pre_apply_limits::TEXT, false);
END $$;

-- ── PART 2 — CREATE OR REPLACE with ELSE → RAISE ───────────────────
CREATE OR REPLACE FUNCTION public.get_company_property_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_tier      TEXT;
  v_tier_type TEXT;
BEGIN
  -- 🟢 2026-09-02 Cap sequence Commit B — ELSE flips to RAISE.
  -- Body shape changes from CASE-expression to IF/ELSIF/ELSE (CASE
  -- can't host a RAISE; it's a value expression). Signature +
  -- DEFINER + search_path unchanged from Commit A (7b67ff8). Lookup
  -- unchanged: lower(trim()) equality, metachar vector closed.
  SELECT tier, tier_type
    INTO v_tier, v_tier_type
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(p_company_name))
   LIMIT 1;

  IF v_tier IS NULL THEN
    -- Unknown company — behave as unlimited (unchanged from Commit A
    -- + the pre-Commit-A neuter). Trigger caller
    -- (enforce_property_limit) short-circuits on -1 → "no enforcement."
    -- Commit B does NOT flip this branch — a missing company row is a
    -- data issue, not a tier-unrecognized case.
    RETURN -1;
  END IF;

  -- 🔴 EXPLICIT BRANCHES FOR ALL FOUR VALUES (same as Commit A). The
  -- legacy branch remains load-bearing for A1 (T5 confirmed no
  -- proposal_code max_properties override). Do not change.
  IF v_tier = 'pm_only' THEN
    RETURN -1;
  ELSIF v_tier = 'enforcement_only' THEN
    RETURN -1;
  ELSIF v_tier = 'legacy' THEN
    RETURN -1;
  ELSIF v_tier = 'pm_starter' THEN
    RETURN 1;   -- dead until Commit A₀; correct the moment it lands
  ELSE
    -- 🔴 DRIFT-LOUD FALLBACK. Written for the person who hits it:
    -- someone who added a value to companies_tier_valid and forgot
    -- to add a branch here — exactly the drift class this arc closes.
    -- Message names the tier, the function, and the fix so the next
    -- action is one read.
    RAISE EXCEPTION 'tier_unrecognized: public.get_company_property_limit received tier=% for company=%. Every value in companies_tier_valid must have an explicit branch in this fn. Add ELSIF v_tier = ''%'' THEN RETURN <limit>. (Cap Commit B, 20260902.)',
      v_tier, p_company_name, v_tier;
  END IF;
END;
$func$;

COMMENT ON FUNCTION public.get_company_property_limit(TEXT) IS
  '2026-09-02 Cap sequence Commit B. Body shape IF/ELSIF/ELSE with RAISE on ELSE (drift-loud fallback for tier values not explicitly named). Zero behavior change from Commit A — every currently-recognized tier (pm_only/enforcement_only/legacy/pm_starter) has an explicit branch. RAISE only fires when someone widens companies_tier_valid without updating this fn. Callers unchanged: enforce_property_limit trigger consults proposal_codes.feature_overrides.max_properties FIRST before falling back here. Legacy branch load-bearing for A1 (no override exists). pm_starter branch dead until Commit A₀ widens companies_tier_valid.';

-- ── PART 3 — In-migration behavior parity check ────────────────────
-- Compute post-apply limits and compare to the pre-apply snapshot
-- captured in Part 1. Any drift → RAISE and rollback (no partial
-- apply, no corrupted state). Paired verification runs the same
-- shape outside the migration transaction as belt + suspenders.
DO $$
DECLARE
  v_pre_apply JSONB := current_setting('app.cap_b_pre_apply_limits', true)::JSONB;
  v_row RECORD;
  v_post INT;
  v_expected INT;
  v_drift TEXT := '';
BEGIN
  IF v_pre_apply IS NULL THEN
    RAISE EXCEPTION 'PART 3 SETUP FAIL: pre-apply snapshot not found in session GUC. Part 1 did not run correctly.';
  END IF;

  FOR v_row IN SELECT id, name, tier FROM public.companies ORDER BY id LOOP
    v_post := public.get_company_property_limit(v_row.name);
    v_expected := (v_pre_apply ->> v_row.id::TEXT)::INT;
    IF v_post IS DISTINCT FROM v_expected THEN
      v_drift := v_drift || format('company_id=%s name=%L tier=%s BEFORE=%s AFTER=%s; ',
        v_row.id, v_row.name, v_row.tier, v_expected, v_post);
    END IF;
  END LOOP;

  IF v_drift <> '' THEN
    RAISE EXCEPTION 'PART 3 BEHAVIOR PARITY FAIL: Commit B changed computed limit for one or more companies. This should be impossible against current data (every live tier has an explicit branch). ROLLING BACK. Drift: %', v_drift;
  END IF;
END $$;

-- ── PART 4 — Schema audit row (with pre-apply snapshot) ────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_CAP_SEQUENCE_COMMIT_B',
  'public.get_company_property_limit',
  'commit_b_else_raises',
  jsonb_build_object(
    'migration',            '20260902_cap_sequence_commit_b_else_raises',
    'arc',                  'Cap sequence — Commit B of 4 (A → B → C → A₀)',
    'change_shape',         'Body-only rewrite: CASE-expression → IF/ELSIF/ELSE with RAISE on ELSE. Signature + DEFINER + search_path unchanged.',
    'behavior_delta',       'ZERO against current data (every live tier + pm_starter has an explicit branch; ELSE is dead code). In-migration parity check (Part 3) asserted match per company. Paired verification re-checks.',
    'drift_loud',           'RAISE tier_unrecognized only fires when someone widens companies_tier_valid without adding a branch here. Message names tier + fn + fix.',
    'pre_apply_limits',     current_setting('app.cap_b_pre_apply_limits', true)::JSONB,
    'a1_gate',              'legacy branch preserved (returns -1). A1 uncapped as today. No override backstop exists (T5 Aug 28); this branch is load-bearing.',
    'next',                 'Commit C: BEFORE UPDATE OF is_active reactivation branch on enforce_property_limit. Commit A₀: widen companies_tier_valid for pm_starter (LAST).'
  ),
  now()
);

COMMIT;
