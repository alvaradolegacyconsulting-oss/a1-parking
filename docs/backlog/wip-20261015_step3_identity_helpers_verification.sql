-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — step 3 identity helpers
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable, no BEGIN/COMMIT so the terminal SELECT returns.
--
-- 🔴 WHAT THIS FILE CANNOT DO. It proves the three bodies are what we
-- intended and that they fail closed with no JWT. It CANNOT prove that
-- 159 policies and 58 functions still let every live role do what it
-- did yesterday — only real sessions can, which is
-- npm run verify:identityhelpers. That gate records a BEFORE baseline
-- and compares, so run it BEFORE this migration too: a suite only run
-- afterwards cannot tell you it was ever testing the right thing.

DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_fn   OID;
  v_src  TEXT;
  v_name TEXT;
  v_n    INT;
  v_b    TEXT;
BEGIN

  FOREACH v_name IN ARRAY ARRAY['get_my_role','get_my_company','get_my_properties']
  LOOP
    v_fn := to_regprocedure('public.' || v_name || '()');
    IF v_fn IS NULL THEN
      v_fail := array_append(v_fail, format('G1: %s() is missing', v_name));
      CONTINUE;
    END IF;

    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;

    -- G1. Still DEFINER and STABLE. A silent drop to INVOKER would make
    -- every policy read user_roles under the caller's own RLS.
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
      v_fail := array_append(v_fail, format('G1a: %s is no longer SECURITY DEFINER', v_name));
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 's' THEN
      v_fail := array_append(v_fail, format('G1b: %s is no longer STABLE (%s)', v_name,
        (SELECT provolatile FROM pg_proc WHERE oid = v_fn)));
    END IF;

    -- G2. search_path pinned, matched on word boundaries so
    -- 'public_staging' cannot satisfy it.
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                     AND array_to_string(proconfig,',') ~ 'search_path=[^,]*\mpublic\M'
                     AND array_to_string(proconfig,',') ~ '\mpg_temp\M') THEN
      v_fail := array_append(v_fail, format('G2: %s search_path is not pinned (proconfig=%s)', v_name,
        (SELECT proconfig FROM pg_proc WHERE oid = v_fn)));
    END IF;

    -- G3. The three terms, each by itself, so a partial edit cannot pass.
    IF v_src !~ '\mis_active\M' THEN
      v_fail := array_append(v_fail, format('G3a: 🔴 %s does not test is_active — a deactivated user still resolves to their role', v_name));
    END IF;
    IF v_src !~ 'ORDER BY' THEN
      v_fail := array_append(v_fail, format('G3b: %s has LIMIT 1 with no ORDER BY — it returns an arbitrary row', v_name));
    END IF;
    IF v_src ~ 'ORDER BY\s+id\s+DESC' THEN
      v_fail := array_append(v_fail, format('G3c: 🔴 %s orders id DESC — a row inserted later would supersede an existing identity', v_name));
    END IF;
    IF v_src !~ 'lower\(email\)' THEN
      v_fail := array_append(v_fail, format('G3d: %s no longer matches on lower(email) — case-sensitivity would silently drop sessions', v_name));
    END IF;

    -- G4. 🔴 EXECUTION. Reading prosrc proves text, not behaviour. This
    -- session has no JWT, so every helper must return NULL — if one
    -- returned a value here it would be resolving an identity for an
    -- unauthenticated caller.
    EXECUTE format('SELECT (public.%I())::TEXT', v_name) INTO v_b;
    IF v_b IS NOT NULL THEN
      v_fail := array_append(v_fail, format('G4: 🔴 %s() returned %L with NO JWT — it does not fail closed', v_name, v_b));
    END IF;

    -- G5. Grants REPORTED, not enforced. Revoking PUBLIC here would
    -- change the reachability of 159 policies in the same breath as
    -- their semantics; that is its own change with its own sweep.
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_fail := array_append(v_fail, format('G5: 🔴 authenticated lost EXECUTE on %s — every policy using it now denies everyone', v_name));
    END IF;
  END LOOP;

  -- ── G6. The data the is_active term rests on ──────────────────────
  SELECT count(*) INTO v_n FROM public.user_roles WHERE is_active IS NULL;
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G6: 🔴 %s user_roles rows have is_active NULL — `AND is_active` silently excludes them, and nobody decided that', v_n));
  END IF;

  -- ── G7. 🔴 The /deactivated routing must not depend on these ──────
  -- A deactivated user has to be TOLD their access was removed. That
  -- routing goes through get_my_effective_active(), which reads
  -- user_roles directly. The day it calls get_my_role() instead, this
  -- change starts hiding the explanation from the person who needs it,
  -- and they get a blank portal or a login loop.
  IF to_regprocedure('public.get_my_effective_active(text)') IS NULL THEN
    v_fail := array_append(v_fail, 'G7: get_my_effective_active(text) is missing — the deactivated-user routing is gone');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.get_my_effective_active(text)');
    IF v_src ~ '\mget_my_role\M|\mget_my_company\M|\mget_my_properties\M' THEN
      v_fail := array_append(v_fail,
        'G7a: 🔴 get_my_effective_active now CALLS one of the three helpers. With is_active filtered it will see NULL for a deactivated user and can no longer tell them apart from a stranger — they get a login loop instead of /deactivated.');
    END IF;
    IF v_src !~ '\mis_active\M' THEN
      v_fail := array_append(v_fail, 'G7b: get_my_effective_active no longer reads is_active itself');
    END IF;
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'STEP 3 VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

-- ── PASS row: the numbers a reader needs, including who is cut off ──
SELECT 'PASS — identity helpers' AS result,
       (SELECT count(*) FROM pg_proc
         WHERE pronamespace='public'::regnamespace
           AND proname IN ('get_my_role','get_my_company','get_my_properties')
           AND prosecdef
           AND array_to_string(proconfig,',') ~ 'search_path'
           AND prosrc ~ '\mis_active\M'
           AND prosrc ~ 'ORDER BY')                                      AS helpers_fixed_want_3,
       (SELECT count(*) FROM public.user_roles WHERE is_active IS NULL)  AS is_active_null_want_0,
       (SELECT count(*) FROM public.user_roles WHERE is_active IS NOT TRUE) AS rows_now_cut_off,
       (SELECT string_agg(role || ' ' || email, ' · ' ORDER BY email)
          FROM public.user_roles WHERE is_active IS NOT TRUE)            AS who_is_cut_off,
       (SELECT count(*) FROM (SELECT lower(btrim(email)) e FROM public.user_roles
                               GROUP BY 1 HAVING count(*) > 1) d)        AS emails_with_2plus_rows_want_0,
       (SELECT count(*) FROM pg_policy pol
         WHERE (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
               ~ 'get_my_(role|company|properties)')                     AS policies_inheriting_this,
       (SELECT string_agg(DISTINCT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                                        THEN p.proname || ':anon' END, ', ')
          FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
           AND p.proname IN ('get_my_role','get_my_company','get_my_properties')) AS anon_execute_reported_not_enforced,
       '🔴 npm run verify:identityhelpers — only real sessions prove 159 policies still work' AS next;
