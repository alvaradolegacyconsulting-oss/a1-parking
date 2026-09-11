-- ══════════════════════════════════════════════════════════════════════
-- 20260911_email_ilike_tier1_equality_verification.sql
--
-- EXECUTION gates for the Tier 1 `email ~~*` rewrite.
--
-- ── 🔴 WHY THIS FILE IS EXECUTION-BASED AND NOT STRUCTURAL ──────────
-- A structural gate would confirm the predicate TEXT changed. That is
-- not the claim. The claim is that a caller whose JWT email is a
-- wildcard SEES NOTHING and CANNOT WRITE. Only attempting it proves
-- that. String-matching `qual` is discovery, never a gate
-- (feedback_rpc_verification_must_include_execution_gate).
--
-- ── NO auth.users ROW IS NEEDED ─────────────────────────────────────
-- The policies read `auth.jwt() ->> 'email'`. set_config on
-- request.jwt.claims supplies that claim directly, so the whole thing
-- runs in SQL with no account creation, no session minting, and nothing
-- to clean up in auth. That also sidesteps a real trap: the 2026-09-11
-- tourniquet now blocks `%` at every ingress, so a fixture built by
-- POSTing to a route would be refused BY OUR OWN FIX and the gate would
-- pass for the wrong reason.
--
-- ── 🔴 THE POSITIVE CONTROL IS THE LOAD-BEARING HALF ────────────────
-- "Zero rows under a wildcard JWT" is satisfied by a broken fixture, a
-- missing seed, a typo'd claim, or RLS being off entirely. Every gate
-- therefore runs TWICE against the same seeded row:
--   · EXACT-MATCH JWT  → must return the row   (proves the fixture
--                                               exists and the policy
--                                               still lets the real
--                                               owner in)
--   · WILDCARD JWT     → must return zero      (the actual claim)
-- A wildcard-denial without its matching control is uninterpretable and
-- is reported as such, not as a pass.
--
-- ── DISCIPLINE ──────────────────────────────────────────────────────
-- Seeds inside BEGIN/ROLLBACK; nothing persists. Terminal PASS SELECT
-- sits AFTER the ROLLBACK so it is the last row-returning statement.
-- Probe emails live on @tier1probe.invalid — a reserved TLD that cannot
-- collide with a real tenant (feedback_probes_collide_with_production_state).
--
-- ── WHAT THIS DOES NOT PROVE ────────────────────────────────────────
-- Tier 2 and Tier 3 policies are untouched and still carry ILIKE. A
-- green run here says Tier 1 is closed, nothing more.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── FIXTURE ═════════════════════════════════════════════════════════
-- One user_roles row and one residents row whose addresses a wildcard
-- WOULD have matched under ILIKE. `%@tier1probe.invalid` matches both
-- under `~~*` and neither under equality — that difference is the
-- entire test.
DO $fixture$
BEGIN
  INSERT INTO public.user_roles (email, role, company, property)
  VALUES ('victim@tier1probe.invalid', 'company_admin', 'Tier1Probe Co', '{}'::text[]);

  INSERT INTO public.residents (email, name, unit, property, company, status, is_active)
  VALUES ('victim@tier1probe.invalid', 'Tier1 Probe', '1A', 'Tier1 Probe Property', 'Tier1Probe Co', 'active', true);

  -- 🔴 A REAL properties ROW IS REQUIRED FOR E3 TO MEAN ANYTHING.
  -- Without it the wildcard UPDATE matches no row and returns 0 —
  -- which is the PASS value, produced by an empty WHERE rather than by
  -- RLS. A gate that passes when its target does not exist is not a
  -- gate (feedback_gates_must_assert_what_they_measured). Caught while
  -- writing this file: the first draft had no properties seed.
  INSERT INTO public.properties (name, company, is_active)
  VALUES ('Tier1 Probe Property', 'Tier1Probe Co', true);
END $fixture$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 — user_roles.user_read_own_role  (THE DIRECTORY)
--   The whole policy is the email predicate, so this is the cleanest
--   read of the fix. Pre-rewrite a wildcard JWT returned every row.
-- ══════════════════════════════════════════════════════════════════════
DO $e1$
DECLARE
  v_exact    INT;
  v_wildcard INT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"victim@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"victim@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_exact FROM public.user_roles;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_wildcard FROM public.user_roles;
  RESET ROLE;

  IF v_exact < 1 THEN
    RAISE EXCEPTION
      'E1 CONTROL FAILED: the exact-match JWT sees % rows of its own user_roles row (expected >= 1). The fixture, the claim, or the policy is broken — the wildcard result below (% rows) is UNINTERPRETABLE until this passes.',
      v_exact, v_wildcard;
  END IF;
  IF v_wildcard <> 0 THEN
    RAISE EXCEPTION
      'E1 FAIL: a wildcard JWT (%%@tier1probe.invalid) reads % user_roles row(s). user_read_own_role is still matching with ILIKE — this is the directory, and the reconnaissance step for the escalation policies.',
      v_wildcard;
  END IF;
END $e1$;


-- ══════════════════════════════════════════════════════════════════════
-- E2 — residents.residents_company_admin_update  (ESCALATION, WRITE)
--   The inline user_roles lookup is what bypassed the equality-locked
--   helpers. A wildcard JWT used to match the seeded company_admin row
--   and inherit that role. Asserted as an actual UPDATE, not a SELECT:
--   this policy governs writes and only a write exercises it.
--   🔴 RETURNING is required — a denied UPDATE reports 0 rows affected,
--   not an error (feedback_delete_smoke_must_use_returning).
-- ══════════════════════════════════════════════════════════════════════
DO $e2$
DECLARE
  v_exact    INT := 0;
  v_wildcard INT := 0;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"victim@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"victim@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  WITH upd AS (
    UPDATE public.residents SET name = 'control-write'
     WHERE email = 'victim@tier1probe.invalid' RETURNING 1
  ) SELECT COUNT(*) INTO v_exact FROM upd;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  WITH upd AS (
    UPDATE public.residents SET name = 'ESCALATED'
     WHERE email = 'victim@tier1probe.invalid' RETURNING 1
  ) SELECT COUNT(*) INTO v_wildcard FROM upd;
  RESET ROLE;

  IF v_exact < 1 THEN
    RAISE EXCEPTION
      'E2 CONTROL FAILED: the real company_admin updated % rows (expected >= 1). Either the fixture company does not line up or the rewrite broke the legitimate path. The wildcard result (% rows) is UNINTERPRETABLE until this passes — and a rewrite that denies everyone is not a fix.',
      v_exact, v_wildcard;
  END IF;
  IF v_wildcard <> 0 THEN
    RAISE EXCEPTION
      'E2 FAIL: a wildcard JWT UPDATED % residents row(s). residents_company_admin_update still resolves its inline user_roles lookup with ILIKE — this is PRIVILEGE ESCALATION, not disclosure.',
      v_wildcard;
  END IF;
END $e2$;


-- ══════════════════════════════════════════════════════════════════════
-- E3 — properties.properties_manager_update  (ESCALATION, WRITE)
--   No positive control is possible without inventing a manager whose
--   property array matches a real properties row, which would mean
--   writing to production properties. So this gate asserts the DENIAL
--   ONLY, and says so rather than implying more.
--   E2 already carries the control for the inline-lookup shape — the
--   two policies share it — so the pattern is proven there.
--   The fixture seeds a REAL properties row, so a 0 here means RLS
--   refused the write, not that the WHERE matched nothing.
-- ══════════════════════════════════════════════════════════════════════
DO $e3$
DECLARE v_wildcard INT := 0;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  WITH upd AS (
    -- No-op write on a nullable column. properties has NO updated_at —
    -- checked against the live column list rather than assumed, after
    -- the first draft used one that does not exist.
    UPDATE public.properties SET notes = notes
     WHERE name = 'Tier1 Probe Property' RETURNING 1
  ) SELECT COUNT(*) INTO v_wildcard FROM upd;
  RESET ROLE;

  IF v_wildcard <> 0 THEN
    RAISE EXCEPTION
      'E3 FAIL: a wildcard JWT UPDATED % properties row(s). properties_manager_update still resolves its inline user_roles lookup with ILIKE.',
      v_wildcard;
  END IF;
END $e3$;


-- ══════════════════════════════════════════════════════════════════════
-- E4 — residents.resident_read_own is TIER 2 AND STILL ILIKE.
--   Recorded as a NEGATIVE expectation so a green run cannot be read as
--   "the email vector is closed". If this ever returns 0, Tier 2 landed
--   and this gate should be inverted — not deleted.
--   (feedback_absence_must_not_be_failure_output — an untested boundary
--   must not look the same as a passing one.)
-- ══════════════════════════════════════════════════════════════════════
DO $e4$
DECLARE v_wildcard INT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier1probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_wildcard FROM public.residents;
  RESET ROLE;

  IF v_wildcard = 0 THEN
    RAISE NOTICE 'E4 NOTE: a wildcard JWT now reads 0 residents rows. Tier 2 appears to have landed — invert this gate rather than deleting it.';
  ELSE
    RAISE NOTICE 'E4 EXPECTED: a wildcard JWT still reads % residents row(s). Tier 2 is NOT in this commit. Do not read a green run as "the email vector is closed".', v_wildcard;
  END IF;
END $e4$;

ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- PASS row — last statement in the paste, AFTER the rollback.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'email ~~* Tier 1 — execution gates'::TEXT AS target,
  ARRAY[
    'E1  user_roles: exact-match JWT reads its own row (CONTROL) AND a wildcard JWT reads ZERO',
    'E2  residents: real company_admin UPDATE succeeds (CONTROL) AND a wildcard JWT UPDATEs ZERO — escalation closed',
    'E3  properties: a wildcard JWT UPDATEs ZERO (denial-only; control lives in E2, same policy shape)',
    'E4  residents SELECT still open under a wildcard — Tier 2 is NOT in this commit, recorded so green is not misread',
    'DISCIPLINE: every wildcard denial is paired with a positive control. Zero rows is also what a broken fixture, a typo''d claim, or RLS being off produces.',
    'DISCIPLINE: writes asserted with RETURNING — a denied UPDATE reports 0 rows affected, not an error.'
  ] AS gates_verified,
  now() AS verified_at;
