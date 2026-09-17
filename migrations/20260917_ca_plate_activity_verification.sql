-- ══════════════════════════════════════════════════════════════════════
-- 20260917_ca_plate_activity_verification.sql
--
-- Structural gates + EXECUTION gates for ca_plate_activity.
--
-- ── 🔴 THE TWO REFUSAL GATES ARE THE POINT ─────────────────────────
-- E2 (a manager is refused) and E3 (a CA gets nothing for another
-- company's property) are the claims a render condition cannot make.
-- Both are asserted by CALLING the function as that caller, not by
-- reading its text.
--
-- 🔴 AND BOTH CARRY A POSITIVE CONTROL. "role_not_authorized" and
-- "property_not_found" are also what a broken fixture, a missing seed or
-- a typo'd claim produce. E1 proves the SAME plate at the SAME property
-- returns real rows for a legitimate CA first — so a refusal below is a
-- refusal, not an absence.
--
-- ── VS3 GUARDS THE INDEX SPELLING ──────────────────────────────────
-- The index expressions are copied verbatim from
-- enforce_visitor_pass_limit so ONE index serves both it and this RPC.
-- That is invisible to any behavioural test: tidying the spelling breaks
-- nothing a query returns, it just silently un-indexes the trigger that
-- scans visitor_passes on every pass issued. So it gets a catalog gate.
--
-- Seeds inside BEGIN/ROLLBACK; PASS row after the rollback.
-- Probe plate CAPROBE1, probe company/property from the Test-LEGACY
-- fixture set.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: function exists, SECURITY DEFINER, 1 default ══════════════
DO $vs1$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
  v_ndef   INT;
BEGIN
  v_oid := to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: ca_plate_activity(TEXT,TEXT,INT) not found';
  END IF;

  SELECT prosecdef, pronargdefaults INTO v_secdef, v_ndef FROM pg_proc WHERE oid = v_oid;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS1 FAIL: ca_plate_activity is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
  IF v_ndef <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: pronargdefaults = % (expected 1 — p_days DEFAULT 30). CREATE OR REPLACE drops any default not re-typed.', v_ndef;
  END IF;
END $vs1$;

-- ── VS2: EXECUTE to authenticated only ════════════════════════════
-- ⚠ CORRECTED 2026-09-17. An earlier version of this comment said the
-- first run's `ERROR 42P01: relation "a" does not exist` was caused by
--     SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '…'
-- resolving `a` as a relation rather than the function scan's implicit
-- column. 🔴 THAT DIAGNOSIS WAS WRONG. There was no defect in the SQL.
--
-- The isolation probe (docs/backlog/wip-vs2-42p01-isolation-2026-09-17
-- .sql) ran all three forms — bare alias multi-line, explicit
-- AS x(item), and the collapsed one-line shape byte-for-byte — and ALL
-- THREE passed. Then the corrected file failed the same way in a fresh
-- tab, and then this, containing no alias at all, failed too:
--     SELECT prosrc FROM pg_proc
--      WHERE oid = to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');
--   → 42P01: relation "a" does not exist
-- while `SELECT 1;` returned normally.
--
-- An error naming an identifier that is not in the submitted statement
-- is not a property of the statement. It was the Supabase SQL EDITOR,
-- alongside results not rendering and queries echoing back unexecuted
-- the same day. See docs/backlog/supabase-sql-editor-phantom-42p01-
-- 2026-09-17.md.
--
-- AS x(item) is KEPT — explicit beats implicit and it costs nothing —
-- but it fixed nothing, because nothing was broken. The three
-- bare-alias blocks in 20260909_tow_log_commit_4_rpcs_verification
-- (VS2, VS4, VS6) are FINE and were deliberately left alone.
--
-- 🔴 The lesson that survives, in its corrected form: retyping a proven
-- block in a new, shorter spelling did not introduce a bug — it created
-- a SUSPECTED difference that cost an hour to rule out. Had this been a
-- copy of 20260910 VS5 with the function name changed, there would have
-- been nothing in the text to blame and the environmental cause would
-- have been obvious immediately. A novel spelling does not just risk a
-- defect; it absorbs suspicion that belongs elsewhere.
DO $vs2$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: function not found (VS1 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: proacl NULL — the default PUBLIC EXECUTE grant was not revoked (feedback_function_public_grant_supabase_default)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_acl) AS x(item) WHERE x.item::text LIKE 'authenticated=X/%') THEN
    v_bad := v_bad || format('missing authenticated EXECUTE (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_acl) AS x(item) WHERE x.item::text LIKE 'anon=%') THEN
    v_bad := v_bad || format('anon EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_acl) AS x(item) WHERE x.item::text LIKE '=%') THEN
    v_bad := v_bad || format('PUBLIC EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS2 FAIL: %', v_bad;
  END IF;
END $vs2$;

-- ── VS3: 🔴 index expressions still match the enforcement trigger ══
-- Behaviourally invisible, which is exactly why it needs a gate.
DO $vs3$
DECLARE
  v_vp  TEXT;
  v_vi  TEXT;
  v_src TEXT;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO v_vp
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'visitor_passes_property_plate_norm';
  SELECT pg_get_indexdef(i.indexrelid) INTO v_vi
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'violations_property_plate_norm';

  IF v_vp IS NULL THEN RAISE EXCEPTION 'VS3 FAIL: visitor_passes_property_plate_norm missing'; END IF;
  IF v_vi IS NULL THEN RAISE EXCEPTION 'VS3 FAIL: violations_property_plate_norm missing'; END IF;

  -- pg_get_indexdef re-renders from the parse tree, so match on the
  -- pieces that survive rendering rather than the literal source.
  IF v_vp !~* 'regexp_replace' OR v_vp !~ '\[\^A-Z0-9\]' THEN
    RAISE EXCEPTION 'VS3 FAIL: the visitor_passes index no longer uses the [^A-Z0-9] normalization the enforcement trigger uses. It will serve this RPC and leave enforce_visitor_pass_limit scanning on every pass issued. def=%', v_vp;
  END IF;
  IF v_vi !~* 'regexp_replace' OR v_vi !~ '\[\^A-Z0-9\]' THEN
    RAISE EXCEPTION 'VS3 FAIL: the violations index no longer uses [^A-Z0-9]. def=%', v_vi;
  END IF;

  -- And the trigger must still be spelled that way too — if IT changed,
  -- the index stopped serving it and this gate is the only place that
  -- would notice.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.enforce_visitor_pass_limit()');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: enforce_visitor_pass_limit() not found — the index shape was chosen to serve it.';
  END IF;
  IF position('[^A-Z0-9]' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: enforce_visitor_pass_limit no longer normalizes with [^A-Z0-9], so the shared index shape no longer serves it. Re-shape the index to the trigger''s new expression, or accept the scan deliberately.';
  END IF;
END $vs3$;


BEGIN;

DO $fixture$
DECLARE v_prop TEXT := 'Test Legacy Property';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE name = v_prop AND lower(trim(company)) = 'test-legacy') THEN
    RAISE EXCEPTION 'FIXTURE FAIL: property "%" in company Test-LEGACY not found. Seed the test tenants.', v_prop;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE lower(trim(email)) = 'legacy-ca@test.shieldmylot.com' AND role = 'company_admin') THEN
    RAISE EXCEPTION 'FIXTURE FAIL: no company_admin user_roles row for legacy-ca@test.shieldmylot.com.';
  END IF;

  -- One expired pass and one live pass, so E1 proves the window
  -- includes history rather than only what is live now.
  INSERT INTO public.visitor_passes (plate, visitor_name, visiting_unit, duration_hours, expires_at, is_active, property, created_at)
  VALUES ('CA-PROBE-1', 'CA Probe Expired', '1A', 24, now() - interval '2 days', TRUE,  v_prop, now() - interval '3 days'),
         ('CAPROBE1',   'CA Probe Live',    '1A', 24, now() + interval '20 hours', TRUE, v_prop, now() - interval '4 hours');

  INSERT INTO public.violations (plate, violation_type, property, is_confirmed, created_at)
  VALUES ('caprobe1', 'fire_lane', v_prop, TRUE, now() - interval '1 day');
END $fixture$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 — POSITIVE CONTROL. A legitimate CA sees real history.
--   Punctuated input 'ca-probe-1' against rows stored as 'CA-PROBE-1',
--   'CAPROBE1' and lowercase 'caprobe1' — so this also proves both-side
--   normalization across three spellings and both tables in one call.
--   Without this, E2 and E3's refusals are uninterpretable.
-- ══════════════════════════════════════════════════════════════════════
DO $e1$
DECLARE r JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  r := public.ca_plate_activity('Test Legacy Property', 'ca-probe-1');
  RESET ROLE;

  IF (r ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'E1 CONTROL FAILED: a legitimate CA was refused: %. Every refusal gate below is uninterpretable until this passes.', r;
  END IF;
  IF (r ->> 'pass_count')::INT <> 2 THEN
    RAISE EXCEPTION 'E1 FAIL: pass_count = % (expected 2 — one expired, one live). Either the 30-day window is excluding history, or normalization missed a spelling. result=%', r ->> 'pass_count', r;
  END IF;
  IF (r ->> 'violation_count')::INT <> 1 THEN
    RAISE EXCEPTION 'E1 FAIL: violation_count = % (expected 1, stored lowercase). A plate matching in passes but not violations is the SILENT PARTIAL ANSWER this design exists to prevent.', r ->> 'violation_count';
  END IF;
  -- Liveness is BOTH predicates. Exactly one of the two passes is live.
  IF (SELECT count(*) FROM jsonb_array_elements(r -> 'passes') p WHERE (p ->> 'is_live')::BOOLEAN) <> 1 THEN
    RAISE EXCEPTION 'E1 FAIL: expected exactly 1 live pass. is_active alone would report the expired one as live. passes=%', r -> 'passes';
  END IF;
  -- Minimisation: nothing from the excluded set may appear.
  IF r::text ~* '(tow_fee|tow_storage|driver_license|vehicle_vin|"photos")' THEN
    RAISE EXCEPTION 'E1 FAIL: the payload carries an EXCLUDED field (tow fee / storage / officer licence / VIN / photos). This answers "was this plate here and was it cited", not what the tow cost.';
  END IF;
END $e1$;


-- ══════════════════════════════════════════════════════════════════════
-- E2 — 🔴 A MANAGER IS REFUSED. Server-side, not a render condition.
--   Same property, same plate that E1 just proved returns rows.
-- ══════════════════════════════════════════════════════════════════════
DO $e2$
DECLARE r JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"legacy-manager@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"legacy-manager@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  r := public.ca_plate_activity('Test Legacy Property', 'ca-probe-1');
  RESET ROLE;

  IF r ->> 'error' IS DISTINCT FROM 'role_not_authorized' THEN
    RAISE EXCEPTION 'E2 FAIL: a MANAGER got % for a plate E1 proved returns 2 passes and 1 violation. CA-only must be a server-side gate — a UI that does not render a button is not a control.', r;
  END IF;
END $e2$;


-- ══════════════════════════════════════════════════════════════════════
-- E3 — 🔴 CROSS-COMPANY. A CA gets nothing for another company's
--   property. The Test-LEGACY CA asks about a Test-PM property.
-- ══════════════════════════════════════════════════════════════════════
DO $e3$
DECLARE r JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  r := public.ca_plate_activity('Test PM Property', 'ca-probe-1');
  RESET ROLE;

  IF r ->> 'error' IS DISTINCT FROM 'property_not_found' THEN
    RAISE EXCEPTION 'E3 FAIL: a Test-LEGACY CA got % for a Test-PM property. Company scoping is server-side or it is not scoping. (Note the error deliberately does NOT distinguish "other company" from "does not exist" — that would let a CA enumerate property names across tenants.)', r;
  END IF;
END $e3$;


-- ══════════════════════════════════════════════════════════════════════
-- E4 — a plate with no activity returns EMPTY, not an error.
--   "No history" is an answer a CA needs to be able to trust. An error
--   here would read as "the lookup broke" and send them to support.
-- ══════════════════════════════════════════════════════════════════════
DO $e4$
DECLARE r JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  r := public.ca_plate_activity('Test Legacy Property', 'ZZNOTHINGZZ');
  RESET ROLE;

  IF (r ->> 'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'E4 FAIL: a plate with no activity returned an error rather than an empty result: %', r;
  END IF;
  IF (r ->> 'pass_count')::INT <> 0 OR (r ->> 'violation_count')::INT <> 0 THEN
    RAISE EXCEPTION 'E4 FAIL: expected zero of both; got passes=% violations=%', r ->> 'pass_count', r ->> 'violation_count';
  END IF;
END $e4$;


-- ══════════════════════════════════════════════════════════════════════
-- E5 — the day window is CLAMPED, not trusted.
--   p_days = 100000 would turn a 30-day lookup into a full scan of both
--   tables for any CA who edits a request.
-- ══════════════════════════════════════════════════════════════════════
DO $e5$
DECLARE r JSONB;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim',  '{"email":"legacy-ca@test.shieldmylot.com","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  r := public.ca_plate_activity('Test Legacy Property', 'ca-probe-1', 100000);
  RESET ROLE;

  IF (r ->> 'window_days')::INT <> 365 THEN
    RAISE EXCEPTION 'E5 FAIL: p_days=100000 produced window_days=% (expected the 365 clamp).', r ->> 'window_days';
  END IF;
END $e5$;

ROLLBACK;


SELECT
  'PASS'::TEXT AS status,
  'ca_plate_activity — CA-only, company-scoped, 30-day plate history'::TEXT AS target,
  ARRAY[
    'VS1 function exists, SECURITY DEFINER, p_days default intact',
    'VS2 EXECUTE to authenticated only (no anon, no PUBLIC)',
    'VS3 🔴 index expressions still match enforce_visitor_pass_limit''s — behaviourally invisible, so it gets a catalog gate. Also asserts the TRIGGER still uses that spelling, since the index was shaped to serve it.',
    'E1  CONTROL: a legitimate CA sees 2 passes + 1 violation for a punctuated input against three stored spellings, exactly one pass live, and NO excluded field in the payload',
    'E2  🔴 a MANAGER is refused role_not_authorized for the same call E1 proved returns rows',
    'E3  🔴 a CA gets property_not_found for another company''s property — and not a distinguishable error, which would allow cross-tenant name enumeration',
    'E4  a plate with no activity returns EMPTY and ok:true, never an error',
    'E5  p_days is clamped (100000 → 365), so a caller cannot turn this into a full scan',
    'DISCIPLINE: E2/E3 are refusals, and a refusal is also what a broken fixture produces. E1 runs FIRST and proves the same plate and property return real rows.'
  ] AS gates_verified,
  now() AS verified_at;
