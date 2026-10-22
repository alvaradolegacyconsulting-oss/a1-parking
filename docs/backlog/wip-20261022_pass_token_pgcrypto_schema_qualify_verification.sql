-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — pairs with
-- wip-20261022_pass_token_pgcrypto_schema_qualify.sql
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 THE EXECUTION GATE IS THE POINT OF THIS FILE. The defect it closes
-- passed every structural check there is: function present, prosecdef
-- set, grants correct, anon refused. plpgsql resolves names inside a
-- body lazily, at first call, so the only check that can see a missing
-- pgcrypto is one that MAKES THE CALL and mints a real token.
--
-- VS1 is structural and exists only to stop a future CREATE OR REPLACE
-- from silently dropping the qualification back off. It is not the gate
-- that matters; VS2 is.
--
-- Probes: two throwaway properties at a test-env tenant, one switch ON
-- and one OFF, plus one visitor pass and its audit row. All removed,
-- and VS5 reads the removal back. Nothing is written to a
-- company_env = 'production' tenant.
--
-- No BEGIN/COMMIT. Re-runnable. Terminal SELECT returns a PASS row.
-- ════════════════════════════════════════════════════════════════════

-- ── VS1: the qualification is in the body, and nothing is unqualified ──
DO $$
DECLARE
  v_src  TEXT;
  v_bare INTEGER;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.mint_pass_token_if_printable(text)');

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: mint_pass_token_if_printable(text) does not exist';
  END IF;

  -- Strip -- comments first. The body's own comment names
  -- gen_random_bytes while explaining the fix, and an unstripped match
  -- would let a comment satisfy the assertion.
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');

  IF position('extensions.gen_random_bytes' IN v_src) = 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: body does not call extensions.gen_random_bytes';
  END IF;

  -- Count occurrences NOT preceded by a dot: any bare call is a
  -- regression, and asserting the COUNT means a second call site cannot
  -- hide behind the first qualified one.
  SELECT count(*) INTO v_bare
    FROM regexp_matches(v_src, '(^|[^.[:alnum:]_])gen_random_bytes', 'g');

  IF v_bare <> 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: % unqualified gen_random_bytes call(s) remain', v_bare;
  END IF;

  RAISE NOTICE 'VS1 PASS: gen_random_bytes is schema-qualified, 0 bare calls';
END $$;

-- ── VS2: 🔴 EXECUTION — a switch-ON property actually mints ───────────
DO $$
DECLARE
  v_co    TEXT;
  v_on    TEXT := 'zzsql-on-'  || floor(random() * 1e9)::TEXT;
  v_off   TEXT := 'zzsql-off-' || floor(random() * 1e9)::TEXT;
  v_tok   TEXT;
  v_tok2  TEXT;
  v_null  TEXT;
  v_pass  JSONB;
  v_row   TEXT;
  v_fix   BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim',  '{"role":"service_role"}', true);

  SELECT name INTO v_co FROM public.companies
   WHERE company_env = 'test' ORDER BY id LIMIT 1;
  IF v_co IS NULL THEN
    RAISE EXCEPTION 'VERIFICATION INCONCLUSIVE: no test-env company to probe on';
  END IF;

  INSERT INTO public.properties (name, company, is_active, printable_visitor_passes_enabled)
  VALUES (v_on, v_co, TRUE, TRUE), (v_off, v_co, TRUE, FALSE);

  -- 🔴 ASSERT THE FIXTURE. If the switch did not land, a NULL from the
  -- minter means "switch off", not "pgcrypto missing", and this gate
  -- would pass for the wrong reason.
  SELECT printable_visitor_passes_enabled INTO v_fix
    FROM public.properties WHERE name = v_on;
  IF v_fix IS NOT TRUE THEN
    RAISE EXCEPTION 'VS2 FAIL: fixture wrong — switch-ON probe reads %', v_fix;
  END IF;

  -- The call that the old body could not survive.
  v_tok := public.mint_pass_token_if_printable(v_on);

  IF v_tok IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: switch is ON and the fixture is confirmed, yet no token was minted';
  END IF;
  IF length(v_tok) <> 43 THEN
    RAISE EXCEPTION 'VS2 FAIL: token is % chars, expected 43', length(v_tok);
  END IF;
  IF v_tok ~ '[+/=]' THEN
    RAISE EXCEPTION 'VS2 FAIL: token is not URL-safe: %', v_tok;
  END IF;

  -- Two calls must differ, or the "random" bytes are not random.
  v_tok2 := public.mint_pass_token_if_printable(v_on);
  IF v_tok2 = v_tok THEN
    RAISE EXCEPTION 'VS2 FAIL: two mints returned the same token';
  END IF;

  RAISE NOTICE 'VS2 PASS: minted % chars, URL-safe, and two mints differ', length(v_tok);

  -- ── VS3: switch OFF returns NULL, and the property really exists ───
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE name = v_off) THEN
    RAISE EXCEPTION 'VS3 FAIL: switch-OFF probe property was not created';
  END IF;
  v_null := public.mint_pass_token_if_printable(v_off);
  IF v_null IS NOT NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: switch is OFF yet a token was minted: %', v_null;
  END IF;
  RAISE NOTICE 'VS3 PASS: switch OFF mints nothing';

  -- ── VS4: end to end — issue_visitor_pass carries the token ─────────
  v_pass := public.issue_visitor_pass('ZZSQL001', 'Probe', '9001', v_on, 'probe', 4);
  IF (v_pass ->> 'action') IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'VS4 FAIL: issue_visitor_pass returned action=%, body=%',
      v_pass ->> 'action', v_pass;
  END IF;
  SELECT pass_token INTO v_row FROM public.visitor_passes
   WHERE id = (v_pass ->> 'pass_id')::BIGINT;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: the issued pass carries no pass_token';
  END IF;
  IF length(v_row) <> 43 THEN
    RAISE EXCEPTION 'VS4 FAIL: issued token is % chars, expected 43', length(v_row);
  END IF;
  RAISE NOTICE 'VS4 PASS: issue_visitor_pass stored a 43-char token';

  -- ── VS5: remove the probes and read the removal back ──────────────
  DELETE FROM public.audit_logs
   WHERE action = 'VISITOR_TOS_ACCEPTED'
     AND new_values ->> 'property' = v_on;
  DELETE FROM public.visitor_passes WHERE property IN (v_on, v_off);
  DELETE FROM public.properties     WHERE name     IN (v_on, v_off);

  IF EXISTS (SELECT 1 FROM public.properties WHERE name IN (v_on, v_off))
     OR EXISTS (SELECT 1 FROM public.visitor_passes WHERE property IN (v_on, v_off)) THEN
    RAISE EXCEPTION 'VS5 FAIL: probe rows survived the delete';
  END IF;
  RAISE NOTICE 'VS5 PASS: probes removed, read back';
END $$;

-- ── terminal PASS row ────────────────────────────────────────────────
SELECT 'PASS — mint_pass_token_if_printable calls extensions.gen_random_bytes with 0 bare calls; a confirmed switch-ON fixture mints a 43-char URL-safe token, two mints differ, switch OFF mints nothing, issue_visitor_pass stores the token end to end, and every probe row was removed and read back' AS result;
