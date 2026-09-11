-- ══════════════════════════════════════════════════════════════════════
-- 20260911_email_ilike_tier2_equality_verification.sql
--
-- EXECUTION gates for the Tier 2 `email ~~*` rewrite, plus ONE catalog
-- gate that execution cannot reach.
--
-- Same discipline as Tier 1:
--   · every wildcard denial is paired with a POSITIVE CONTROL, because
--     zero rows is equally what a broken fixture, a typo'd claim or RLS
--     being off produces. A denial gate without a control is not weaker
--     evidence — it is no evidence.
--   · set_config supplies the JWT claim directly; no auth.users row, no
--     session minting, nothing to clean up in auth. It also dodges the
--     trap that the 2026-09-11 tourniquet now blocks `%` at every
--     ingress, so a route-built fixture would be refused by our own fix
--     and the gate would pass for the wrong reason.
--   · seeds inside BEGIN/ROLLBACK; terminal PASS SELECT after the
--     rollback so it is the last row-returning statement.
--   · probe addresses on @tier2probe.invalid — a reserved TLD that
--     cannot collide with a real tenant.
--
-- ── 🔴 WHY G3 IS A CATALOG GATE AND NOT AN EXECUTION ONE ────────────
-- driver_read_own changes TWO things: the predicate and the role it is
-- granted to ({public} → {authenticated}). Execution cannot distinguish
-- them. A run that omitted the retarget would still deny the wildcard —
-- the predicate is what denies — so E2 would pass green with the
-- {public} grant still in place.
--
-- The retarget is half the commit, so it gets its own assertion against
-- pg_policy.polroles. PUBLIC is oid 0 in that array.
-- (feedback_gates_must_assert_what_they_measured.)
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── FIXTURE ═════════════════════════════════════════════════════════
-- One residents row and one drivers row whose addresses a wildcard
-- WOULD match under ILIKE and does NOT match under equality. That
-- difference is the entire test.
--
-- No user_roles row is seeded on purpose: neither Tier 2 policy has a
-- role gate, so adding one would introduce a second reason the gate
-- might pass and blur which one fired.
DO $fixture$
BEGIN
  INSERT INTO public.residents (email, name, unit, property, company, status, is_active)
  VALUES ('victim@tier2probe.invalid', 'Tier2 Probe', '2B', 'Tier2 Probe Property', 'Tier2Probe Co', 'active', true);

  -- assigned_properties supplied explicitly rather than left to a
  -- default — if the column is NOT NULL the fixture would fail, and a
  -- fixture that fails takes the whole gate with it.
  INSERT INTO public.drivers (email, name, company, operator_license, assigned_properties, is_active)
  VALUES ('victim@tier2probe.invalid', 'Tier2 Probe Driver', 'Tier2Probe Co', 'TDLR-TIER2PROBE', '{}'::text[], true);
END $fixture$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 — residents.resident_read_own
--   No role gate: the email predicate is the whole policy, so this is a
--   direct read of the fix. Pre-rewrite a wildcard JWT read every
--   resident row in the table.
-- ══════════════════════════════════════════════════════════════════════
DO $e1$
DECLARE
  v_exact    INT;
  v_wildcard INT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"victim@tier2probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"victim@tier2probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_exact FROM public.residents;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_wildcard FROM public.residents;
  RESET ROLE;

  IF v_exact < 1 THEN
    RAISE EXCEPTION
      'E1 CONTROL FAILED: the exact-match JWT reads % residents row(s) (expected >= 1). The fixture, the claim, or the policy is broken, so the wildcard result (% rows) is UNINTERPRETABLE. A rewrite that denies the real owner is not a fix.',
      v_exact, v_wildcard;
  END IF;
  IF v_wildcard <> 0 THEN
    RAISE EXCEPTION
      'E1 FAIL: a wildcard JWT reads % residents row(s). resident_read_own is still matching with ILIKE — that is bulk resident PII to any authenticated caller, with no role required.',
      v_wildcard;
  END IF;
END $e1$;


-- ══════════════════════════════════════════════════════════════════════
-- E2 — drivers.driver_read_own  (PREDICATE ONLY — see G3 for the role)
-- ══════════════════════════════════════════════════════════════════════
DO $e2$
DECLARE
  v_exact    INT;
  v_wildcard INT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"victim@tier2probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"victim@tier2probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_exact FROM public.drivers;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT COUNT(*) INTO v_wildcard FROM public.drivers;
  RESET ROLE;

  IF v_exact < 1 THEN
    RAISE EXCEPTION
      'E2 CONTROL FAILED: the exact-match JWT reads % drivers row(s) (expected >= 1). The wildcard result (% rows) is UNINTERPRETABLE until this passes.',
      v_exact, v_wildcard;
  END IF;
  IF v_wildcard <> 0 THEN
    RAISE EXCEPTION
      'E2 FAIL: a wildcard JWT reads % drivers row(s). driver_read_own is still matching with ILIKE — names, contact details and TDLR operator licence numbers to any authenticated caller.',
      v_wildcard;
  END IF;
END $e2$;


-- ══════════════════════════════════════════════════════════════════════
-- G3 — 🔴 driver_read_own is no longer granted to PUBLIC.
--   The half of the commit execution cannot see: a run that omitted the
--   retarget still denies the wildcard, because the PREDICATE is what
--   denies. E2 would pass green with {public} intact.
--   polroles is an oid[]; PUBLIC is oid 0.
-- ══════════════════════════════════════════════════════════════════════
DO $g3$
DECLARE
  v_roles     oid[];
  v_role_names TEXT;
BEGIN
  SELECT pol.polroles INTO v_roles
    FROM pg_policy pol
   WHERE pol.polrelid = 'public.drivers'::regclass
     AND pol.polname  = 'driver_read_own';

  IF v_roles IS NULL THEN
    RAISE EXCEPTION 'G3 FAIL: policy driver_read_own not found on public.drivers. The DROP landed and the CREATE did not.';
  END IF;

  IF 0 = ANY (v_roles) THEN
    RAISE EXCEPTION
      'G3 FAIL: driver_read_own is STILL granted to PUBLIC (polroles contains oid 0). The predicate rewrite landed but the {public} -> {authenticated} retarget did not. Not exploitable while anon holds no table grant, but that is defence living outside this policy — on a table carrying TDLR operator licence numbers.';
  END IF;

  SELECT string_agg(rolname, ', ') INTO v_role_names
    FROM pg_roles WHERE oid = ANY (v_roles);
  IF v_role_names IS DISTINCT FROM 'authenticated' THEN
    RAISE NOTICE 'G3 NOTE: driver_read_own is granted to "%" — PUBLIC is correctly absent, but this is not the expected single grant to authenticated. Worth a look.', v_role_names;
  END IF;
END $g3$;


-- ══════════════════════════════════════════════════════════════════════
-- E4 — 🔴 CARRIED FORWARD AND INVERTED FROM TIER 1.
--   Tier 1's E4 recorded that residents SELECT was still open. Tier 2
--   closes that, so the negative expectation now names WHAT IS LEFT:
--   Tier 3's role-gated reads, still carrying ILIKE, plus the audit_logs
--   policies still targeting {public}.
--
--   This is a DISCOVERY query used as a reminder, never as a security
--   gate — string-matching qual cannot prove anything about behaviour.
--   Its only job is to stop a green Tier 2 run being read as "the email
--   vector is closed."
-- ══════════════════════════════════════════════════════════════════════
DO $e4$
DECLARE
  v_remaining INT;
  v_names     TEXT;
BEGIN
  SELECT COUNT(*), string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname)
    INTO v_remaining, v_names
    FROM pg_policies
   WHERE qual       ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
      OR with_check ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)';

  IF v_remaining = 0 THEN
    RAISE NOTICE 'E4: ZERO policies still carry an email ILIKE. If Tier 3 has landed, this gate should be INVERTED (assert 0) rather than deleted — an untested boundary must not look like a passing one.';
  ELSE
    RAISE NOTICE 'E4 EXPECTED: % policies still carry an email ILIKE — Tier 3 is NOT in this commit. Do NOT read a green run as "the email vector is closed". Remaining: %', v_remaining, v_names;
  END IF;
END $e4$;

ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- PASS row — last statement in the paste, AFTER the rollback.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'email ~~* Tier 2 — execution gates + the polroles retarget'::TEXT AS target,
  ARRAY[
    'E1  residents: exact-match JWT reads its own row (CONTROL) AND a wildcard JWT reads ZERO',
    'E2  drivers: exact-match JWT reads its own row (CONTROL) AND a wildcard JWT reads ZERO',
    'G3  driver_read_own polroles no longer contains PUBLIC (oid 0) — the half of the commit execution cannot see',
    'E4  counts the Tier 3 policies still carrying ILIKE, so a green run is not misread as the vector being closed',
    'DISCIPLINE: a denial gate without a positive control is not weaker evidence — it is no evidence. Zero rows is also what a broken fixture produces.',
    'DISCIPLINE: G3 exists because a run that omitted the retarget would still deny the wildcard — the predicate is what denies, so E2 alone would pass green with {public} intact.'
  ] AS gates_verified,
  now() AS verified_at;
