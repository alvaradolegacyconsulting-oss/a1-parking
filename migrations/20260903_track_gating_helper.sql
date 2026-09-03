-- ══════════════════════════════════════════════════════════════════════
-- 20260903_track_gating_helper.sql
--
-- 🟢 Track gating — Commit 1 of 2 (the helper).
--
-- Adds two SECURITY DEFINER helpers callers use to decide whether a
-- given authenticated user's company tier is permitted to invoke
-- enforcement-track or PM-track write RPCs:
--
--   public.my_tier_enforcement_capable() → BOOLEAN
--   public.my_tier_pm_capable()          → BOOLEAN
--
-- Both look up the caller's company via get_my_company() (existing
-- helper reading user_roles.company from JWT email), then read
-- companies.tier and return a boolean per spec.
--
-- ── 🔴 FOUR RULES (Mateo Sep 3 §2) ─────────────────────────────────
--
-- 1. **`tier = 'legacy'` checked FIRST**, both true regardless of
--    `tier_type`. A1 is `tier_type='enforcement'`, `tier='legacy'`.
--    A helper keying PM off `tier_type='enforcement'` denies A1
--    spaces, residents, visitor passes, payment tracking — every
--    PM-side thing that shipped this week. Load-bearing per T5.
--
-- 2. **`pm_only` → PM-capable, NOT enforcement-capable.** Per Jose:
--    negotiated PM customers ride `pm_only`. Keying enforcement off
--    `tier_type='enforcement'` would hand them capability they
--    didn't buy.
--
-- 3. **Fail closed** on unknown tier — RAISE, never return false.
--    get_company_property_limit had `ELSE -1` pre-Commit-B and that
--    fail-open cost a day. Drift-loud fallback.
--
-- 4. **`lower(trim())`, not `ILIKE`.** Copies the prior art's shape
--    (get_company_property_limit body post-Cap-A) but NOT its
--    predicate — the ILIKE metachar vector is closed by the CHECK
--    constraints (companies_name_no_sql_metachar, 1c3e8ef) but
--    equality is stronger + matches the discipline.
--
-- ── EXPECTED BEHAVIOR BY TIER ──────────────────────────────────────
--
--                    my_tier_enforcement_capable  my_tier_pm_capable
--   legacy             TRUE (A1)                    TRUE (A1)
--   pm_only            FALSE (Jose correction)      TRUE
--   pm_starter         FALSE                        TRUE
--   enforcement_only   TRUE                         FALSE
--   <anything else>    RAISE tier_unrecognized      RAISE tier_unrecognized
--
-- ── CONTEXT (Mateo Sep 3 §3) ───────────────────────────────────────
-- ~12 enforcement write-path RPCs will call
-- `IF NOT my_tier_enforcement_capable() THEN RAISE tier_not_permitted`
-- as their first check (after existing role/company lookup). Those
-- gates ship in Commit 2. Hybrids (approve_vehicle, deactivate_vehicle,
-- request_my_vehicle, pm_plate_lookup) stay ungated as a deliberate
-- exclusion.
--
-- ── SCOPE ORDER (Sep 3 §1) ─────────────────────────────────────────
-- Track gating → rehearsal → flip. NOT rehearsal → gating → flip. If
-- an incidental signup lands during the flip-flag rehearsal window
-- and gating is not yet standing, that stranger becomes a real paying
-- customer able to reach enforcement RPCs — precisely what this
-- system exists to prevent.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- 1. BEGIN — atomic apply.
-- 2. CREATE OR REPLACE both fns.
-- 3. REVOKE FROM PUBLIC + anon; GRANT EXECUTE TO authenticated + service_role.
--    (feedback_function_public_grant_supabase_default —
--     SECURITY DEFINER inherits EXECUTE to PUBLIC by default; the
--     explicit REVOKE+GRANT is the pattern.)
-- 4. Schema audit row with per-company expected-capability snapshot
--    (so paired verification can compare LIVE results to what was
--    expected at apply time — parity discipline from Cap B/C).
-- 5. NOTIFY pgrst.
-- 6. COMMIT.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Snapshot per-company expected capabilities ────────────
-- Reads current tier for every company, computes expected enf/pm
-- values per spec, stashes into session GUC for Part 4's audit row.
DO $$
DECLARE
  v_snap JSONB := '{}'::jsonb;
  v_row RECORD;
  v_exp_enf BOOLEAN;
  v_exp_pm BOOLEAN;
BEGIN
  FOR v_row IN SELECT id, name, tier FROM public.companies ORDER BY id LOOP
    IF v_row.tier = 'legacy' THEN
      v_exp_enf := TRUE;  v_exp_pm := TRUE;
    ELSIF v_row.tier = 'pm_only' THEN
      v_exp_enf := FALSE; v_exp_pm := TRUE;
    ELSIF v_row.tier = 'pm_starter' THEN
      v_exp_enf := FALSE; v_exp_pm := TRUE;
    ELSIF v_row.tier = 'enforcement_only' THEN
      v_exp_enf := TRUE;  v_exp_pm := FALSE;
    ELSE
      v_exp_enf := NULL;  v_exp_pm := NULL;   -- would-raise
    END IF;
    v_snap := v_snap || jsonb_build_object(
      v_row.id::TEXT,
      jsonb_build_object(
        'name', v_row.name,
        'tier', v_row.tier,
        'expected_enforcement', v_exp_enf,
        'expected_pm', v_exp_pm
      )
    );
  END LOOP;
  PERFORM set_config('app.track_gating_pre_apply_snap', v_snap::TEXT, false);
END $$;

-- ── PART 2 — my_tier_enforcement_capable ───────────────────────────
CREATE OR REPLACE FUNCTION public.my_tier_enforcement_capable()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company TEXT := public.get_my_company();
  v_tier    TEXT;
BEGIN
  IF v_company IS NULL OR v_company = '' THEN
    RAISE EXCEPTION 'no_company_context: my_tier_enforcement_capable requires an authenticated user with a user_roles.company row. get_my_company() returned NULL/empty.'
      USING ERRCODE = '42501';
  END IF;

  -- lower(trim()) equality, NOT ILIKE. Metachar vector closed by
  -- companies_name_no_sql_metachar (1c3e8ef) but equality is the
  -- stronger discipline + matches Cap A un-neuter shape.
  SELECT tier INTO v_tier
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(v_company))
   LIMIT 1;

  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'company_not_found: my_tier_enforcement_capable for company=%. get_my_company() returned a name not present in companies table.', v_company
      USING ERRCODE = '42501';
  END IF;

  -- 🔴 legacy FIRST — A1 (tier_type='enforcement', tier='legacy') and
  -- any other legacy tenant gets BOTH capabilities regardless of
  -- tier_type. Load-bearing per T5 Aug 28 (no proposal_code override).
  IF v_tier = 'legacy' THEN
    RETURN TRUE;
  ELSIF v_tier = 'enforcement_only' THEN
    RETURN TRUE;
  ELSIF v_tier = 'pm_only' THEN
    -- Jose Sep 3 correction: negotiated PM customers ride pm_only.
    -- Enforcement capability is NOT bundled — a helper that granted
    -- enforcement to pm_only would hand negotiated-PM tenants
    -- Chapter 2308 tow-ticket authority they didn't buy.
    RETURN FALSE;
  ELSIF v_tier = 'pm_starter' THEN
    RETURN FALSE;
  ELSE
    RAISE EXCEPTION 'tier_unrecognized: my_tier_enforcement_capable received tier=% for company=%. Every value in companies_tier_valid must have an explicit branch in this fn. Add ELSIF v_tier = ''%'' THEN RETURN <bool>.',
      v_tier, v_company, v_tier;
  END IF;
END;
$func$;

-- ── PART 3 — my_tier_pm_capable ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_tier_pm_capable()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company TEXT := public.get_my_company();
  v_tier    TEXT;
BEGIN
  IF v_company IS NULL OR v_company = '' THEN
    RAISE EXCEPTION 'no_company_context: my_tier_pm_capable requires an authenticated user with a user_roles.company row. get_my_company() returned NULL/empty.'
      USING ERRCODE = '42501';
  END IF;

  SELECT tier INTO v_tier
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(v_company))
   LIMIT 1;

  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'company_not_found: my_tier_pm_capable for company=%.', v_company
      USING ERRCODE = '42501';
  END IF;

  -- 🔴 legacy FIRST — A1 gets BOTH capabilities. Load-bearing.
  IF v_tier = 'legacy' THEN
    RETURN TRUE;
  ELSIF v_tier = 'pm_only' THEN
    RETURN TRUE;
  ELSIF v_tier = 'pm_starter' THEN
    RETURN TRUE;
  ELSIF v_tier = 'enforcement_only' THEN
    RETURN FALSE;
  ELSE
    RAISE EXCEPTION 'tier_unrecognized: my_tier_pm_capable received tier=% for company=%. Every value in companies_tier_valid must have an explicit branch in this fn. Add ELSIF v_tier = ''%'' THEN RETURN <bool>.',
      v_tier, v_company, v_tier;
  END IF;
END;
$func$;

-- ── PART 4 — Grants (feedback_function_public_grant_supabase_default) ─
REVOKE EXECUTE ON FUNCTION public.my_tier_enforcement_capable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_tier_enforcement_capable() FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_tier_enforcement_capable() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.my_tier_enforcement_capable() TO service_role;

REVOKE EXECUTE ON FUNCTION public.my_tier_pm_capable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_tier_pm_capable() FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_tier_pm_capable() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.my_tier_pm_capable() TO service_role;

-- ── PART 5 — Comments ──────────────────────────────────────────────
COMMENT ON FUNCTION public.my_tier_enforcement_capable() IS
  '2026-09-03 Track gating Commit 1 of 2. Returns TRUE iff caller''s company tier permits enforcement-track RPCs. legacy→TRUE (A1), enforcement_only→TRUE, pm_only→FALSE (Jose Sep 3), pm_starter→FALSE, unknown→RAISE tier_unrecognized. Fail-closed on missing session (no_company_context) or missing company row.';

COMMENT ON FUNCTION public.my_tier_pm_capable() IS
  '2026-09-03 Track gating Commit 1 of 2. Returns TRUE iff caller''s company tier permits PM-track RPCs. legacy→TRUE (A1), pm_only→TRUE, pm_starter→TRUE, enforcement_only→FALSE, unknown→RAISE tier_unrecognized. Fail-closed on missing session/company.';

-- ── PART 6 — Schema audit row (with pre-apply snapshot) ────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TRACK_GATING_HELPER',
  'public.my_tier_enforcement_capable + public.my_tier_pm_capable',
  'track_gating_commit_1',
  jsonb_build_object(
    'migration',    '20260903_track_gating_helper',
    'arc',          'Track gating — Commit 1 of 2 (helper)',
    'behavior_spec', jsonb_build_object(
      'legacy',           jsonb_build_object('enforcement', true,  'pm', true),
      'pm_only',          jsonb_build_object('enforcement', false, 'pm', true),
      'pm_starter',       jsonb_build_object('enforcement', false, 'pm', true),
      'enforcement_only', jsonb_build_object('enforcement', true,  'pm', false),
      'unknown',          'RAISE tier_unrecognized'
    ),
    'a1_gate',      'legacy → both TRUE. A1 (tier_type=enforcement, tier=legacy) is load-bearing per T5.',
    'pm_only_correction', 'pm_only → PM only, NOT enforcement (Jose Sep 3). Negotiated PM customers ride pm_only.',
    'fail_closed',  'Unknown tier RAISES tier_unrecognized. Missing session RAISES no_company_context (42501). Missing company row RAISES company_not_found (42501).',
    'per_company_snap', current_setting('app.track_gating_pre_apply_snap', true)::JSONB,
    'next',         'Commit 2: ~12 enforcement write-path RPCs gain `IF NOT my_tier_enforcement_capable() THEN RAISE tier_not_permitted`. Hybrids (approve_vehicle, deactivate_vehicle, request_my_vehicle, pm_plate_lookup) stay ungated per Mateo Sep 3 §2 — listed in Commit 2 header as deliberate exclusion.'
  ),
  now()
);

-- ── PART 7 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
