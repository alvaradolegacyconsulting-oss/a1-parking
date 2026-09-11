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
-- ── ⚠ A FIXTURE ABORT INVALIDATES THE WHOLE RUN, NOT PART OF IT ─────
-- 2026-09-11: the first run aborted inside the fixture. E1, E2, G3 and
-- E4 produced no output — and "passed silently" is indistinguishable
-- from "never executed" in that output, which is the absence problem
-- again, one layer up from the gates themselves.
-- RE-RUN THE WHOLE FILE from the top after any fixture failure. Do not
-- reason about which gates had already gone green.
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

  -- ── H1 fixture only, below ──────────────────────────────────────
  -- 🔴 TWO user_roles rows, and the wildcard one is the whole point.
  -- Group C's policies are gated on get_my_role() = 'resident'. A
  -- wildcard caller with NO user_roles row gets NULL from that helper
  -- and is refused BEFORE the subquery is ever reached — so the naive
  -- version of H1 returns zero for a reason unrelated to RLS
  -- inheritance and "confirms" the hypothesis vacuously.
  --
  -- get_my_role() matches lower(email) = lower(jwt) since 20260610. For
  -- a caller whose JWT email IS the literal '%@tier2probe.invalid',
  -- that equality is TRUE against a row storing the same literal — so
  -- the wildcard caller legitimately holds role='resident' and reaches
  -- the subquery, which is the only place the hypothesis lives.
  INSERT INTO public.user_roles (email, role, company, property)
  VALUES ('%@tier2probe.invalid',      'resident', 'Tier2Probe Co', '{}'::text[]),
         ('victim@tier2probe.invalid', 'resident', 'Tier2Probe Co', '{}'::text[]);

  -- Rows Group C WOULD return if its subquery matched. Without these,
  -- H1 is vacuous a second way — zero because nothing exists.
  --
  -- 🔴 label and created_by_email ARE NOT OPTIONAL. Both are NOT NULL
  -- with NO DEFAULT on spaces, and the first draft omitted both: the
  -- run aborted on `label`, and `created_by_email` would have thrown on
  -- the retry. Second fixture defect in two days — properties.updated_at
  -- yesterday, these today — and the same root both times: the table
  -- under TEST gets read carefully because it is the subject, while
  -- tables the fixture WRITES to get filled in from memory because they
  -- are scaffolding. Scaffolding that will not compile stops the gate
  -- from ever running.
  --
  -- Checked rather than remembered this time: PostgREST's OpenAPI doc
  -- (GET /rest/v1/) lists `required` per table. ⚠ It reports NOT NULL
  -- regardless of default, so it OVER-reports — spaces.type and
  -- is_active appear there too and both default. It narrows the
  -- candidates; it does not settle them.
  INSERT INTO public.spaces (property, space_number, label, company, created_by_email, is_active)
  VALUES ('Tier2 Probe Property', 'T2-1', 'T2-1', 'Tier2Probe Co', 'h1-probe@tier2probe.invalid', true);

  -- vehicles NOT NULL set is (property, company) beyond the identity
  -- columns — both supplied. Verified against the same spec rather than
  -- assumed, because vehicles.company going NOT NULL in the August 28
  -- arc is exactly the omission that broke manager add-vehicle for ten
  -- days.
  INSERT INTO public.vehicles (plate, property, unit, company, status, is_active, resident_read)
  VALUES ('T2PROBE1', 'Tier2 Probe Property', '2B', 'Tier2Probe Co', 'active', true, false);
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

-- ══════════════════════════════════════════════════════════════════════
-- H1 — 🔴 HYPOTHESIS TEST, NOT A GATE. Does RLS on `residents` filter
--      the subqueries inside Tier 3's Group C policies?
--
-- Group C (spaces, vehicles, properties, visitor_passes, violations)
-- does not match on its own table's email. It subqueries residents:
--     property IN (SELECT residents.property FROM residents
--                   WHERE residents.email ~~* (auth.jwt() ->> 'email'))
--
-- Postgres applies RLS to tables referenced inside policy expressions —
-- the same behaviour behind the familiar "infinite recursion detected in
-- policy for relation" error. If that holds, then once Tier 2 rewrites
-- residents.resident_read_own to equality, the subquery is filtered
-- TWICE: by its own ILIKE and by residents' RLS, which now returns only
-- the caller's own row. A wildcard would get nothing regardless of the
-- ILIKE still sitting in the outer policy.
--
-- ⚠ THE NAIVE VERSION OF THIS TEST LIES. A wildcard caller with no
-- user_roles row fails `get_my_role() = 'resident'` and reads zero rows
-- from spaces and vehicles WITHOUT THE SUBQUERY EVER RUNNING. Zero would
-- look like confirmation and mean nothing. The fixture therefore gives
-- the wildcard caller a real resident role AND seeds rows the policies
-- would return on a match — so a zero here can only come from the
-- subquery being empty.
--
-- 🔴 CORRECTED 2026-09-11, AFTER WRITING THIS: H1'S ANSWER MUST NOT
--    MOVE GROUP C'S SCHEDULE. An earlier draft of this header said a
--    ZERO result meant "Group C is already mitigated by Tier 2, the
--    urgency drops." That was wrong about WHICH protection is doing the
--    work.
--
--    Group C's real protection is the ROLE GATE, and it is stronger
--    than the inheritance the hypothesis is about:
--      1. attacker's JWT email is '%@gmail.com'
--      2. Group C evaluates get_my_role() = 'resident'
--      3. get_my_role() matches lower(email) = lower(jwt) — EQUALITY
--         since 20260610
--      4. no user_roles row holds the LITERAL string '%@gmail.com'
--      5. NULL role, policy fails, the subquery is never reached
--    So Group C needs a stored user_roles row containing the wildcard
--    literally — not a pattern match. Two independent things prevent
--    that: the 2026-09-11 tourniquet blocks % at every ingress, and
--    zero accounts carry % today (counted 09-07, re-confirmed 09-11).
--
--    It WAS reachable before the tourniquet — register as
--    '%@gmail.com', get a real user_roles row, equality-match your own
--    literal, pass the role gate, and the subquery's ILIKE then matched
--    every Gmail resident. That path is closed at the ingress.
--
-- H1 still earns its place: the fixture seeds that literal row, so it
-- reconstructs exactly the pre-tourniquet state and tests the
-- INHERITANCE question rather than the role gate. Whatever it returns
-- is real information about how nested policies behave in this
-- database, which matters beyond this arc.
--
-- READ THE NOTICE, NOT A PASS/FAIL. Neither answer changes Tier 3's
-- ordering:
--   ZERO     → inheritance holds; residents' RLS filters the subquery
--              as well. A second layer under the role gate. Group C
--              still gets rewritten — safety resting on another table's
--              policy is fragile — on its existing schedule.
--   NON-ZERO → inheritance does not apply the way we think. Group C is
--              no MORE exposed than the role gate already leaves it,
--              but every nested policy in this codebase needs
--              re-reading on the same question.
-- ══════════════════════════════════════════════════════════════════════
DO $h1$
DECLARE
  v_role_seen TEXT;
  v_spaces    INT;
  v_vehicles  INT;
  v_residents INT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"%@tier2probe.invalid","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  -- Precondition. If the wildcard caller is NOT seen as a resident, the
  -- counts below are role-gate refusals and say nothing about
  -- inheritance. Reported, never folded silently into the answer.
  v_role_seen := get_my_role();
  SELECT COUNT(*) INTO v_residents FROM public.residents;
  SELECT COUNT(*) INTO v_spaces    FROM public.spaces;
  SELECT COUNT(*) INTO v_vehicles  FROM public.vehicles;
  RESET ROLE;

  IF v_role_seen IS DISTINCT FROM 'resident' THEN
    RAISE NOTICE 'H1 INCONCLUSIVE: wildcard caller resolves get_my_role() = % (expected resident). spaces=% vehicles=% are role-gate refusals and prove NOTHING about RLS inheritance.',
      COALESCE(v_role_seen, 'NULL'), v_spaces, v_vehicles;
  ELSE
    RAISE NOTICE 'H1: wildcard caller holds role=resident and reads residents=% (expect 0 after Tier 2), spaces=%, vehicles=%.',
      v_residents, v_spaces, v_vehicles;
    IF v_spaces = 0 AND v_vehicles = 0 THEN
      RAISE NOTICE 'H1 RESULT — INHERITANCE HOLDS. residents RLS filtered the subqueries inside Group C, so those five policies are already mitigated by Tier 2. Rewrite them anyway; the urgency drops.';
    ELSE
      RAISE NOTICE 'H1 RESULT — INHERITANCE DOES NOT HOLD as assumed. Group C is exactly as exposed as the tier list says, and every nested policy in this codebase needs re-reading on the same question.';
    END IF;
  END IF;
END $h1$;

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
    'H1  HYPOTHESIS, not a gate — does residents RLS filter the subqueries inside Tier 3 Group C? Read the NOTICE. NEITHER answer moves Group C''s schedule: its real protection is the equality-locked role gate, which needs a stored user_roles row containing the wildcard LITERALLY.',
    'DISCIPLINE: a denial gate without a positive control is not weaker evidence — it is no evidence. Zero rows is also what a broken fixture produces.',
    'DISCIPLINE: G3 exists because a run that omitted the retarget would still deny the wildcard — the predicate is what denies, so E2 alone would pass green with {public} intact.'
  ] AS gates_verified,
  now() AS verified_at;
