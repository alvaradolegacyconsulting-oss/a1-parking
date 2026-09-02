-- ══════════════════════════════════════════════════════════════════════
-- 20260902_cap_sequence_commit_c_reactivation_branch.sql
--
-- 🟢 Cap sequence Commit C of 4 (A → B → C → A₀)
--
-- Per Mateo Sep 1 §1 + Sep 2 §3. Closes the reactivation bypass:
-- create property 1 → deactivate → create property 2 → reactivate
-- property 1 leaves the tenant with 2 active properties on a cap
-- of 1. Four clicks from meaningless.
--
-- ── COMMIT C SEQUENCE POSITION ─────────────────────────────────────
--
--     A (7b67ff8)   un-neuter helper, explicit CASE, ELSE returns -1
--     B (56cce2d)   flip ELSE to RAISE
--   → C (THIS)      BEFORE UPDATE OF is_active branch (reactivation)
--     A₀            widen companies_tier_valid CHECK for 'pm_starter'
--
-- ── SHAPE ───────────────────────────────────────────────────────────
--
-- Extends the SAME public.enforce_property_limit() function to
-- dispatch on TG_OP. New trigger property_limit_check_on_reactivation
-- fires BEFORE UPDATE OF is_active (limits firing to only when
-- is_active changes — cheaper than BEFORE UPDATE).
--
-- Function logic:
--   IF TG_OP = 'UPDATE' AND NOT (OLD.is_active = FALSE AND
--                                NEW.is_active = TRUE) THEN
--     RETURN NEW   -- not a reactivation; skip cap check
--   END IF
--   -- Reach here on INSERT (any is_active) OR reactivation UPDATE
--   -- Rest of the cap-check logic unchanged
--
-- Preserves INSERT behavior exactly (existing INSERT trigger
-- property_limit_check unchanged in registration). Adds a new
-- trigger name so BEFORE UPDATE fires the same function under a
-- distinct event.
--
-- ── EDGE CASES BY TG_OP ────────────────────────────────────────────
--
--   INSERT any is_active state       → check (unchanged from pre-C)
--   UPDATE, is_active unchanged      → trigger doesn't fire (OF gate)
--   UPDATE, TRUE  → FALSE (deactivate)→ trigger fires; dispatched skip
--   UPDATE, FALSE → TRUE  (reactivate)→ trigger fires; cap check runs
--
-- Property edits that don't touch is_active (rename, address, PM
-- assignment) do NOT hit the trigger — the BEFORE UPDATE OF is_active
-- clause is the gate. Mateo Sep 2 §3: "A property edit that doesn't
-- touch is_active must not hit a cap check."
--
-- ── OUT OF SCOPE (documented followups) ────────────────────────────
--
-- 🟡 name ILIKE NEW.company on lines 188 + 225 of the original fn
-- is a metachar vector of the same class Cap A closed for
-- get_company_property_limit. §4 CHECK constraints (1c3e8ef)
-- functionally protect it at the write layer, so no live attack
-- vector today. Not fixed here to keep Cap C scope tight per Mateo
-- Sep 2 §3 ("reactivation branch"). File as future micro-followup.
--
-- 🟡 INSERT of is_active=false at cap-limit currently RAISES (existing
-- INSERT trigger runs check unconditionally). Semantically wrong —
-- inactive rows don't count toward cap. Not fixed here. Same scope
-- reason.
--
-- ── BEHAVIOR PARITY (per Sep 2 memory rule 7) ──────────────────────
--
-- Uses Cap B's pre-apply snapshot pattern. Migration Part 1 snapshots
-- pre-apply per-company limits via get_company_property_limit +
-- per-company active-property counts (proxy for "no live tenant is
-- currently over cap"; if any is, the reactivation trigger would
-- retroactively reject something legitimate). Part 3 asserts post-
-- apply parity for both metrics.
--
-- Because Cap C only ADDS a new trigger (doesn't change existing
-- INSERT behavior against current data — all live tiers return -1 =
-- unlimited), parity is expected to hold trivially. But asserting
-- makes the claim testable.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- 1. BEGIN — atomic
-- 2. Snapshot pre-apply per-company (limit, active_count) into GUC
-- 3. CREATE OR REPLACE FUNCTION (body swap only; signature unchanged)
-- 4. DROP TRIGGER IF EXISTS + CREATE TRIGGER (new UPDATE trigger)
-- 5. In-migration parity check against Part 2 snapshot
-- 6. Audit row with pre_apply snapshot
-- 7. COMMIT
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Snapshot pre-apply per-company state ──────────────────
DO $$
DECLARE
  v_snap JSONB := '{}'::jsonb;
  v_row RECORD;
  v_limit INT;
  v_active INT;
BEGIN
  FOR v_row IN SELECT id, name FROM public.companies ORDER BY id LOOP
    v_limit := public.get_company_property_limit(v_row.name);
    SELECT COUNT(*) INTO v_active
      FROM public.properties
     WHERE lower(trim(company)) = lower(trim(v_row.name))
       AND is_active = TRUE;
    v_snap := v_snap || jsonb_build_object(
      v_row.id::TEXT,
      jsonb_build_object('limit', v_limit, 'active_count', v_active)
    );
  END LOOP;
  PERFORM set_config('app.cap_c_pre_apply_snap', v_snap::TEXT, false);
END $$;

-- ── PART 2 — CREATE OR REPLACE enforce_property_limit ──────────────
-- Body change: TG_OP dispatch at top. INSERT branch semantics
-- preserved (any INSERT still triggers check). UPDATE branch (from
-- new trigger) checks only false→true reactivation transitions.
CREATE OR REPLACE FUNCTION public.enforce_property_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company_id BIGINT;
  v_limit INTEGER;
  v_override_text TEXT;
  v_override INTEGER;
  v_active_count INTEGER;
BEGIN
  -- 🟢 2026-09-02 Cap sequence Commit C — TG_OP dispatch added.
  -- On UPDATE, only proceed if this is a reactivation (false→true).
  -- Other UPDATE cases (deactivation, is_active unchanged which the
  -- trigger's OF clause already gates out) skip the cap check. INSERT
  -- branch semantics unchanged from pre-Commit-C.
  IF TG_OP = 'UPDATE' THEN
    IF NOT (OLD.is_active = FALSE AND NEW.is_active = TRUE) THEN
      RETURN NEW;
    END IF;
    -- Reactivation — fall through to cap check
  END IF;

  IF NEW.company IS NULL OR NEW.company = '' THEN
    RETURN NEW;
  END IF;

  -- 🟡 Existing ILIKE — metachar vector open in principle, functionally
  -- closed by §4 CHECK constraints (companies_name_no_sql_metachar +
  -- properties_name_no_sql_metachar, 1c3e8ef). Cap C intentionally
  -- doesn't rewrite this to lower(trim()) equality — separate follow-up.
  SELECT id INTO v_company_id
  FROM companies
  WHERE name ILIKE NEW.company
  LIMIT 1;

  v_override := NULL;
  IF v_company_id IS NOT NULL THEN
    SELECT (feature_overrides ->> 'max_properties')
    INTO v_override_text
    FROM proposal_codes
    WHERE company_id = v_company_id
      AND status = 'redeemed'
      AND feature_overrides ? 'max_properties'
    ORDER BY redeemed_at DESC NULLS LAST
    LIMIT 1;

    IF v_override_text IS NOT NULL THEN
      BEGIN
        v_override := v_override_text::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_override := NULL;
      END;
    END IF;
  END IF;

  IF v_override IS NOT NULL THEN
    v_limit := v_override;
  ELSE
    v_limit := get_company_property_limit(NEW.company);
  END IF;

  -- -1 = unlimited
  IF v_limit < 0 THEN
    RETURN NEW;
  END IF;

  -- Count ACTIVE properties for the company. On INSERT, this row is
  -- not yet counted — the check compares pre-insert count to limit.
  -- On UPDATE reactivation, this row is currently is_active=FALSE
  -- (guarded above), so also not counted — same semantics.
  SELECT COUNT(*)
  INTO v_active_count
  FROM properties
  WHERE company ILIKE NEW.company
    AND is_active = TRUE;

  IF v_active_count >= v_limit THEN
    RAISE EXCEPTION 'Property limit exceeded: tier allows % active properties for %', v_limit, NEW.company
      USING HINT = 'Upgrade tier or contact support@shieldmylot.com to issue a proposal_code override. (Cap Commit C reactivation branch: this fired on a false→true reactivation of an existing property.)',
            ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.enforce_property_limit() IS
  '2026-09-02 Cap sequence Commit C. Trigger fn for property_limit_check (INSERT, since 2026-05-08) + property_limit_check_on_reactivation (UPDATE OF is_active, added Commit C). Dispatches on TG_OP: UPDATE only proceeds when OLD.is_active=FALSE AND NEW.is_active=TRUE (reactivation). INSERT semantics unchanged. Cap-check logic identical for both — count active properties for company, RAISE if count >= limit. ILIKE metachar close deferred (functionally protected by §4 CHECK).';

-- ── PART 3 — Add UPDATE trigger ────────────────────────────────────
DROP TRIGGER IF EXISTS property_limit_check_on_reactivation ON public.properties;
CREATE TRIGGER property_limit_check_on_reactivation
  BEFORE UPDATE OF is_active ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_property_limit();

-- Existing property_limit_check (BEFORE INSERT) untouched. Verify via
-- pg_trigger in the paired verification.

-- ── PART 4 — In-migration parity check ─────────────────────────────
-- Snapshot compared: per-company limit + per-company active_count.
-- Both should be unchanged (Commit C doesn't alter INSERT trigger
-- behavior against current data; UPDATE trigger is NEW so has no
-- historical effect).
DO $$
DECLARE
  v_snap JSONB := current_setting('app.cap_c_pre_apply_snap', true)::JSONB;
  v_row RECORD;
  v_post_limit INT;
  v_post_active INT;
  v_expected_limit INT;
  v_expected_active INT;
  v_drift TEXT := '';
BEGIN
  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'PART 4 SETUP FAIL: pre-apply snapshot not found';
  END IF;

  FOR v_row IN SELECT id, name FROM public.companies ORDER BY id LOOP
    v_post_limit := public.get_company_property_limit(v_row.name);
    SELECT COUNT(*) INTO v_post_active
      FROM public.properties
     WHERE lower(trim(company)) = lower(trim(v_row.name))
       AND is_active = TRUE;
    v_expected_limit  := ((v_snap -> v_row.id::TEXT) ->> 'limit')::INT;
    v_expected_active := ((v_snap -> v_row.id::TEXT) ->> 'active_count')::INT;
    IF v_post_limit IS DISTINCT FROM v_expected_limit
       OR v_post_active IS DISTINCT FROM v_expected_active THEN
      v_drift := v_drift || format('company_id=%s name=%L limit BEFORE=%s AFTER=%s active BEFORE=%s AFTER=%s; ',
        v_row.id, v_row.name,
        v_expected_limit, v_post_limit,
        v_expected_active, v_post_active);
    END IF;
  END LOOP;

  IF v_drift <> '' THEN
    RAISE EXCEPTION 'PART 4 BEHAVIOR PARITY FAIL: Commit C changed live state for one or more companies. ROLLING BACK. Drift: %', v_drift;
  END IF;
END $$;

-- ── PART 5 — Schema audit row (with pre-apply snapshot) ────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_CAP_SEQUENCE_COMMIT_C',
  'public.enforce_property_limit + trigger property_limit_check_on_reactivation',
  'commit_c_reactivation_branch',
  jsonb_build_object(
    'migration',       '20260902_cap_sequence_commit_c_reactivation_branch',
    'arc',             'Cap sequence — Commit C of 4 (A → B → C → A₀)',
    'change_shape',    'enforce_property_limit fn: added TG_OP dispatch at top (UPDATE proceeds only on false→true). New trigger property_limit_check_on_reactivation on BEFORE UPDATE OF is_active. INSERT trigger property_limit_check unchanged.',
    'closes',          'Reactivation bypass: create → deactivate → create → reactivate loop that used to allow cap+1 active without violation.',
    'behavior_delta',  'ZERO against current data (every live tier limit is -1 = unlimited; RAISE unreachable today). Trigger becomes load-bearing only after A₀ makes pm_starter possible (limit=1).',
    'pre_apply_snap',  current_setting('app.cap_c_pre_apply_snap', true)::JSONB,
    'deferred_scope',  jsonb_build_array(
      'ILIKE NEW.company → lower(trim()) equality — same metachar vector Cap A closed for get_company_property_limit. Protected by §4 CHECK constraints. Micro-followup.',
      'INSERT of is_active=false at cap-limit currently RAISEs (INSERT trigger runs check unconditionally). Semantically wrong. Micro-followup.'
    ),
    'next',            'Commit A₀ (LAST): widen companies_tier_valid for pm_starter — makes the cap actually reachable + this trigger load-bearing.'
  ),
  now()
);

COMMIT;
