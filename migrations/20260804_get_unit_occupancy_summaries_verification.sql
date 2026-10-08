-- ══════════════════════════════════════════════════════════════════════
-- 20260804_get_unit_occupancy_summaries_verification.sql
-- POST-APPLY: assert RPC exists, grants correct (anon DENIED,
-- authenticated GRANTED), volatility STABLE, SECURITY DEFINER, body
-- carries the enforcement-matching predicates and the Path B scope
-- check.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260804_get_unit_occupancy_summaries.sql.
-- Paste WHOLE. Inspection only — no probe rows.
--
-- BEHAVIOURAL PROBES are DEFERRED to app-level integration once the
-- client commit lands. JWT-simulation from the SQL editor requires a
-- SET LOCAL request.jwt.claims dance + real user_roles rows for the
-- probe identity — heavier than what a static inspection VQ warrants,
-- and the live fixture (Test Legacy Property Unit 205, `test new`
-- resident, per Jose 2026-08-04) is the correct validation surface.
--
-- Manual behavioural test recipes (RUN AFTER CLIENT DEPLOYS):
--   1. Log in as a manager scoped to Test Legacy Property. Open
--      Residents tab. Confirm `test new` row shows `⚑ 2 active in
--      unit` badge; opening the record shows the occupancy line with
--      the two active residents named + their plate counts summed to
--      the total.
--   2. Log in as a MULTI-property manager. Switch VIEWING PROPERTY.
--      Confirm occupancy renders correctly on both properties (this
--      is the regression probe for the get_my_properties() LIMIT 1
--      dependency Path B bypasses).
--   3. Attempt via network dev-tools to call the RPC with
--      p_property = a property the caller is NOT scoped to. Confirm
--      the response is a 4xx error (not a 200 with zeros). Confirm
--      the UI renders NOTHING — no badge, no line, no "0 residents".
--   4. Log in as a resident, driver, or leasing_agent scoped to a
--      different property. Confirm the RPC RAISEs for all three
--      (only manager/leasing_agent/company_admin/admin scoped to the
--      queried property pass).
--   5. Look up the audit_logs row after approving a resident at
--      Unit 205 — confirm `occupancy_at_decision` holds the counts
--      that were on screen at click time.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RPC_EXISTS ────────────────────────────────────────────────────
DO $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_unit_occupancy_summaries'
      AND pronamespace = 'public'::regnamespace
      AND pronargs = 2
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: get_unit_occupancy_summaries(TEXT, TEXT[]) NOT FOUND';
  END IF;
END $$;

-- ── VQ.RPC_GRANTS ────────────────────────────────────────────────────
-- anon MUST NOT have EXECUTE (manager-portal-only per Mateo lock —
-- rendering occupancy on /register would hand a stranger a per-unit
-- occupancy oracle). authenticated MUST have EXECUTE (the internal
-- role check inside the RPC gates by user_roles role).
DO $$
DECLARE
  v_has_anon          boolean;
  v_has_authenticated boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.get_unit_occupancy_summaries(text,text[])', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.get_unit_occupancy_summaries(text,text[])', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: anon HAS EXECUTE (must be REVOKED — anon-facing render is the /register oracle risk)';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: authenticated MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.VOLATILITY_STABLE + SECURITY_DEFINER ──────────────────────────
DO $$
DECLARE
  v_provolatile "char";
  v_prosecdef   boolean;
BEGIN
  SELECT provolatile, prosecdef
    INTO v_provolatile, v_prosecdef
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  -- 'i' = immutable, 's' = stable, 'v' = volatile
  IF v_provolatile <> 's' THEN
    RAISE EXCEPTION 'VQ.VOLATILITY_STABLE: expected STABLE (s); got %', v_provolatile;
  END IF;
  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'VQ.SECURITY_DEFINER: expected SECURITY DEFINER; got INVOKER';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Source-inspection VQs below strip `-- ...` comments before matching.
-- pg_get_functiondef() includes in-body SQL comments; asserting on the
-- raw text produces false positives (as this file did on its 2026-08-04
-- first run — VQ.BODY_PATH_B_SCOPING matched a `-- get_my_company()`
-- comment). Codify the rule: source-inspection VQs assert on executable
-- syntax, so strip line comments first. When an assertion fires, the
-- RAISE message quotes the matched code line so the reviewer doesn't
-- have to re-derive the evidence.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.BODY_ENFORCEMENT_PREDICATE ────────────────────────────────────
-- Body must filter on v.is_active = TRUE (matches check_resident_plate
-- 20260524:139). If a future edit "aligns" this to countVehicles'
-- status-only predicate, the display drifts from enforcement and the
-- whole point of the RPC is undermined.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'v\.is_active\s*=\s*TRUE' THEN
    RAISE EXCEPTION 'VQ.BODY_ENFORCEMENT_PREDICATE: body missing v.is_active = TRUE (enforcement predicate — see check_resident_plate 20260524:139)';
  END IF;
  IF v_body_code !~ 'r\.is_active\s*=\s*TRUE' THEN
    RAISE EXCEPTION 'VQ.BODY_ENFORCEMENT_PREDICATE: body missing r.is_active = TRUE (residents predicate)';
  END IF;
END $$;

-- ── VQ.BODY_PATH_B_SCOPING ───────────────────────────────────────────
-- Body must NOT call get_my_properties() or get_my_company() —
-- Path B (direct user_roles aggregation) is deliberate. Body MUST
-- contain a direct user_roles aggregation.
--
-- Comments stripped before matching; matched code line quoted on
-- failure.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
  v_matched   text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code ~ 'get_my_properties\s*\(' THEN
    SELECT trim(regexp_replace(l, '--.*$', ''))
      INTO v_matched
      FROM regexp_split_to_table(v_body, E'\n') AS l
     WHERE regexp_replace(l, '--.*$', '') ~ 'get_my_properties\s*\('
     LIMIT 1;
    RAISE EXCEPTION 'VQ.BODY_PATH_B_SCOPING: body calls get_my_properties() at code line: [%]', v_matched;
  END IF;

  IF v_body_code ~ 'get_my_company\s*\(' THEN
    SELECT trim(regexp_replace(l, '--.*$', ''))
      INTO v_matched
      FROM regexp_split_to_table(v_body, E'\n') AS l
     WHERE regexp_replace(l, '--.*$', '') ~ 'get_my_company\s*\('
     LIMIT 1;
    RAISE EXCEPTION 'VQ.BODY_PATH_B_SCOPING: body calls get_my_company() at code line: [%]', v_matched;
  END IF;

  IF position('FROM public.user_roles ur, unnest(ur.property)' in v_body_code) = 0 THEN
    RAISE EXCEPTION 'VQ.BODY_PATH_B_SCOPING: body missing direct user_roles aggregation (expected: FROM public.user_roles ur, unnest(ur.property))';
  END IF;
END $$;

-- ── VQ.BODY_OUT_OF_SCOPE_RAISES ──────────────────────────────────────
-- Out-of-scope MUST raise, not return zeros. A client reading
-- total_active_residents without checking an error flag would render
-- "0 residents" as fact.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF position('RAISE EXCEPTION ''out_of_scope' in v_body_code) = 0 THEN
    RAISE EXCEPTION 'VQ.BODY_OUT_OF_SCOPE_RAISES: body missing RAISE EXCEPTION ''out_of_scope'' (out-of-scope must raise, not return zeros)';
  END IF;
  IF position('insufficient_privilege' in v_body_code) = 0 THEN
    RAISE EXCEPTION 'VQ.BODY_OUT_OF_SCOPE_RAISES: body missing ERRCODE = ''insufficient_privilege''';
  END IF;
END $$;

-- ── VQ.BODY_SCOPE_ROLE_ALLOWLIST ─────────────────────────────────────
-- Scope check must allow exactly the four authenticated roles.
-- Resident + driver + anon must be excluded.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF position('ur.role IN (''manager'',''leasing_agent'',''company_admin'',''admin'')' in v_body_code) = 0 THEN
    RAISE EXCEPTION 'VQ.BODY_SCOPE_ROLE_ALLOWLIST: body missing role allowlist (expected: ur.role IN (''manager'',''leasing_agent'',''company_admin'',''admin''))';
  END IF;
END $$;

-- ── VQ.BODY_RESIDENTS_DEDUP ──────────────────────────────────────────
-- Defensive: residents grouped by lower(email) so one person cannot
-- appear twice in a unit panel. residents table has no unique
-- constraint on email (20260704's UNIQUE is on user_roles). Jose
-- 2026-08-04 found natalielop08@gmail.com with two residents rows
-- at Apt 136 — this dedup fires against that case.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'DISTINCT ON \(lower\(r\.email\)\)' THEN
    RAISE EXCEPTION 'VQ.BODY_RESIDENTS_DEDUP: body missing DISTINCT ON (lower(r.email)) — residents dedup required against multi-row states';
  END IF;
  IF v_body_code !~ 'COUNT\(DISTINCT lower\(r\.email\)\)' THEN
    RAISE EXCEPTION 'VQ.BODY_RESIDENTS_DEDUP: total_active_residents must use COUNT(DISTINCT lower(r.email)) to match array cardinality after dedup';
  END IF;
END $$;

-- ── VQ.EMPTY_UNITS_NO_SCOPE_CHECK ────────────────────────────────────
-- Empty p_units returns empty units map without scope check (nothing
-- to leak). Confirms the early-return path exists in the body.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'get_unit_occupancy_summaries'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF position('array_length(p_units, 1) IS NULL' in v_body_code) = 0 THEN
    RAISE EXCEPTION 'VQ.EMPTY_UNITS_NO_SCOPE_CHECK: body missing empty-batch early return (expected: IF ... array_length(p_units, 1) IS NULL THEN RETURN ...)';
  END IF;
END $$;

-- ── VQ.COMMENT_ON_PRESENT ────────────────────────────────────────────
-- Comment must exist and reference key invariants (Path B, is_active,
-- normalization limit). Not a strict-content check — just presence.
DO $$
DECLARE
  v_comment text;
BEGIN
  SELECT obj_description('public.get_unit_occupancy_summaries(text,text[])'::regprocedure, 'pg_proc')
    INTO v_comment;
  IF v_comment IS NULL OR length(v_comment) < 100 THEN
    RAISE EXCEPTION 'VQ.COMMENT_ON_PRESENT: COMMENT ON FUNCTION missing or truncated';
  END IF;
END $$;

COMMIT;
