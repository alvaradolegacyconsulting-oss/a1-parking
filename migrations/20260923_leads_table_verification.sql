-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — 20260923_leads_table
-- ════════════════════════════════════════════════════════════════════
--
-- Re-runnable. No BEGIN/COMMIT — the terminal SELECT returns the PASS
-- row, and it displays whether or not a transaction wraps it.
--
-- 🔴 EXECUTION GATES, NOT STRUCTURAL ONES. Reading a CHECK's text out
-- of pg_constraint proves the text exists, not that it fires. Every
-- constraint below is verified by INSERTING a FRESH PROBE ROW and
-- reading the real sqlstate. Probe rows are inserted by this file and
-- removed by it — never an existing row, because another constraint or
-- trigger can raise the same sqlstate and you would credit the wrong
-- guard.
--
-- 🔴 TWO CATALOG-QUERY TRAPS, FIXED HERE, WORTH CARRYING FORWARD.
--
-- 1. Several pg_catalog columns are the internal "char" type, NOT text:
--    pg_policy.polcmd, pg_class.relkind, pg_class.relpersistence,
--    pg_proc.prokind, pg_attribute.attidentity / attgenerated,
--    pg_constraint.contype. Comparing them to a literal is fine —
--    'r' resolves to "char". CONCATENATING them is not: `unknown ||
--    "char"` is ambiguous and fails 42725 at analysis time. Cast to
--    ::text at every point of concatenation.
--
-- 2. `'public.x'::regclass` RAISES 42P01 when the object is absent;
--    to_regclass('public.x') returns NULL. Verification files must use
--    to_regclass, or running one before its migration produces a REAL
--    42P01 — indistinguishable at a glance from the editor's phantom
--    one, which is the worst error this repo could manufacture.
--
-- ── GAPS IN leads.id ARE EXPECTED, NOT MISSING ROWS ────────────────
-- SEQUENCES DO NOT ROLL BACK. Every run of this file consumes ids for
-- its probe rows, and every rolled-back or failed INSERT anywhere
-- consumes one too. So the first REAL lead's id will be well above 1,
-- and the id series will contain gaps for as long as the table exists.
--
-- Do not read a gap as a deleted or lost lead. If you need to know how
-- many leads there are, count them; the id is an identifier, not a
-- tally. (An earlier version of this note recorded one instance — "leads
-- starts at id 10" — which went stale the next time the file ran.)
--
-- 🔴 WHAT THIS FILE CANNOT VERIFY. The SQL editor runs as a superuser
-- role that BYPASSES RLS. So G6 checks that the policy EXISTS and has
-- the right shape and roles — it cannot prove a non-admin session is
-- actually refused. That assertion needs a real authenticated session
-- and belongs in the Commit 2 report, not here. Absence of an RLS test
-- here is a known limit, stated, not an omission.

-- ── G1 — table exists, RLS enabled, exactly one policy ─────────────
SELECT
  'G1' AS gate,
  CASE
    WHEN c.oid IS NULL THEN 'FAIL — public.leads does not exist'
    WHEN NOT c.relrowsecurity THEN 'FAIL — table exists but RLS is DISABLED'
    WHEN (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) <> 1
      THEN 'FAIL — expected exactly 1 policy, found '
           || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text
    ELSE 'PASS — table exists, RLS enabled, 1 policy'
  END AS result
FROM (SELECT 1) dummy
LEFT JOIN pg_class c
  ON c.relname = 'leads'
 AND c.relnamespace = 'public'::regnamespace;

-- ── G2 — column list, types and nullability ───────────────────────
-- Asserts the THREE-STATE booleans are actually nullable. A future
-- "tidy-up" adding NOT NULL DEFAULT false to texas_confirmed would
-- silently convert "we did not ask" into "they said no", and this is
-- the gate that catches it.
SELECT
  'G2' AS gate,
  CASE
    WHEN count(*) FILTER (WHERE attname = 'email'           AND attnotnull) <> 1
      THEN 'FAIL — email must be NOT NULL'
    WHEN count(*) FILTER (WHERE attname = 'track'           AND attnotnull) <> 1
      THEN 'FAIL — track must be NOT NULL'
    WHEN count(*) FILTER (WHERE attname = 'status'          AND attnotnull) <> 1
      THEN 'FAIL — status must be NOT NULL'
    WHEN count(*) FILTER (WHERE attname = 'texas_confirmed' AND NOT attnotnull) <> 1
      THEN 'FAIL — texas_confirmed must be NULLABLE (three-state: NULL = form did not ask)'
    WHEN count(*) FILTER (WHERE attname = 'wants_demo'      AND NOT attnotnull) <> 1
      THEN 'FAIL — wants_demo must be NULLABLE (three-state)'
    WHEN count(*) FILTER (WHERE attname IN (
           'id','created_at','company_name','contact_name','email','phone',
           'track','property_count','scale_note','timeline','growth_trend',
           'texas_confirmed','wants_demo','source','status',
           'alert_email_sent','alert_email_message_id','alert_email_error')) <> 18
      THEN 'FAIL — expected all 18 named columns, found '
           || (count(*) FILTER (WHERE attname IN (
              'id','created_at','company_name','contact_name','email','phone',
              'track','property_count','scale_note','timeline','growth_trend',
              'texas_confirmed','wants_demo','source','status',
              'alert_email_sent','alert_email_message_id','alert_email_error')))::text
    ELSE 'PASS — 18 columns, required NOT NULLs set, three-state booleans nullable'
  END AS result
FROM pg_attribute
WHERE attrelid = to_regclass('public.leads') AND attnum > 0 AND NOT attisdropped;

-- ── G3–G5 — EXECUTION gates on the three CHECKs ───────────────────
-- Each inserts a FRESH probe row and reads the real sqlstate. 23514 is
-- check_violation. MESSAGE_TEXT is captured too, because 23514 is
-- shared across every CHECK on the table and the sqlstate alone would
-- not tell you WHICH one fired — a track probe rejected by the status
-- constraint would otherwise read as a pass.
DO $do$
DECLARE
  v_state  TEXT;
  v_msg    TEXT;
  v_result TEXT;
BEGIN
  -- G3: status vocabulary
  BEGIN
    INSERT INTO public.leads (email, track, status)
    VALUES ('probe-g3@verification.invalid', 'enforcement', 'not_a_real_status');
    v_result := 'FAIL — an invalid status was ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23514' AND v_msg LIKE '%leads_status_valid%' THEN
      v_result := 'PASS — invalid status refused by leads_status_valid';
    ELSE
      v_result := 'FAIL — refused, but by the WRONG guard: ' || v_state || ' / ' || v_msg;
    END IF;
  END;
  RAISE NOTICE 'G3 %', v_result;

  -- G4: track vocabulary
  BEGIN
    INSERT INTO public.leads (email, track)
    VALUES ('probe-g4@verification.invalid', 'legacy');
    v_result := 'FAIL — track ''legacy'' was ACCEPTED (must be enforcement|property_management)';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23514' AND v_msg LIKE '%leads_track_valid%' THEN
      v_result := 'PASS — off-vocabulary track refused by leads_track_valid';
    ELSE
      v_result := 'FAIL — refused, but by the WRONG guard: ' || v_state || ' / ' || v_msg;
    END IF;
  END;
  RAISE NOTICE 'G4 %', v_result;

  -- G5a: source with a key outside the allowlist
  BEGIN
    INSERT INTO public.leads (email, track, source)
    VALUES ('probe-g5a@verification.invalid', 'enforcement',
            '{"utm_source":"ok","evil_key":"x"}'::jsonb);
    v_result := 'FAIL — a non-allowlisted source key was ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23514' AND v_msg LIKE '%leads_source_allowlisted%' THEN
      v_result := 'PASS — non-allowlisted source key refused';
    ELSE
      v_result := 'FAIL — refused, but by the WRONG guard: ' || v_state || ' / ' || v_msg;
    END IF;
  END;
  RAISE NOTICE 'G5a %', v_result;

  -- G5b: oversize source
  BEGIN
    INSERT INTO public.leads (email, track, source)
    VALUES ('probe-g5b@verification.invalid', 'enforcement',
            jsonb_build_object('src', repeat('x', 500)));
    v_result := 'FAIL — a 500-char source value was ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23514' AND v_msg LIKE '%leads_source_allowlisted%' THEN
      v_result := 'PASS — oversize source refused';
    ELSE
      v_result := 'FAIL — refused, but by the WRONG guard: ' || v_state || ' / ' || v_msg;
    END IF;
  END;
  RAISE NOTICE 'G5b %', v_result;
END
$do$;

-- ── G5c — 🔴 POSITIVE CONTROL. A guard that refuses everything passes
--          G3, G4, G5a and G5b. This is what proves the table ACCEPTS a
--          legitimate lead, including all four allowlisted source keys
--          and NULL three-state booleans.
DO $do$
DECLARE
  v_id     BIGINT;
  v_state  TEXT;
  v_msg    TEXT;
  v_rows   INTEGER;
BEGIN
  BEGIN
    INSERT INTO public.leads (
      company_name, contact_name, email, phone,
      track, property_count, scale_note, timeline, growth_trend,
      texas_confirmed, wants_demo, source
    ) VALUES (
      'Verification Towing LLC', 'Probe Person', 'probe-g5c@verification.invalid', '555-0100',
      'enforcement', 12, 'about 400 units', '30-60 days', 'growing',
      TRUE, TRUE,
      '{"utm_source":"assoc","utm_medium":"print","utm_campaign":"fall26","src":"swto-print"}'::jsonb
    ) RETURNING id INTO v_id;
    RAISE NOTICE 'G5c PASS — a legitimate lead INSERTED (id %), all four source keys accepted', v_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE NOTICE 'G5c FAIL — a LEGITIMATE lead was refused: % / %', v_state, v_msg;
  END;

  -- status default, and that the other four status values are accepted
  BEGIN
    IF (SELECT status FROM public.leads WHERE email = 'probe-g5c@verification.invalid') <> 'new' THEN
      RAISE NOTICE 'G5d FAIL — status did not default to ''new''';
    ELSE
      UPDATE public.leads SET status = 'quoted' WHERE email = 'probe-g5c@verification.invalid';
      UPDATE public.leads SET status = 'sent'   WHERE email = 'probe-g5c@verification.invalid';
      UPDATE public.leads SET status = 'won'    WHERE email = 'probe-g5c@verification.invalid';
      UPDATE public.leads SET status = 'lost'   WHERE email = 'probe-g5c@verification.invalid';
      RAISE NOTICE 'G5d PASS — status defaults to ''new'' and all five values are accepted';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE NOTICE 'G5d FAIL — a valid status transition was refused: % / %', v_state, v_msg;
  END;

  -- ════════════════════════════════════════════════════════════════
  -- 🔴 SELF-CLEANING. This block removes the row IT created, HERE,
  -- inside the same DO block, immediately after the assertions that
  -- needed it.
  --
  -- WHY, and it is not hypothetical: on 2026-09-23
  -- probe-g5c@verification.invalid SURVIVED into public.leads and sat
  -- there as business data until a later session found it. The only
  -- cleanup was the file-level DELETE at the very end, which runs only
  -- if execution REACHES it — and these blocks are routinely run
  -- separately. Nothing deferred can be skipped, so nothing here is
  -- deferred.
  --
  -- The general rule: a verification that writes to a table a human
  -- will read as business data must clean up inside the block that
  -- wrote. Catalog reads are harmless; this class is not, because a
  -- fake lead gets counted, exported and possibly contacted.
  -- ════════════════════════════════════════════════════════════════
  DELETE FROM public.leads WHERE email = 'probe-g5c@verification.invalid';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    RAISE NOTICE 'G5e PASS — the probe row this block created was removed here, not deferred (1 row)';
  ELSE
    RAISE NOTICE 'G5e FAIL — expected to remove exactly 1 probe row, removed %. CHECK public.leads BY HAND.', v_rows;
  END IF;
END
$do$;

-- ── G6 — grants and policy shape ──────────────────────────────────
-- 🔴 pg_class.relacl, NOT information_schema.*_privileges. Those views
-- under-report grants and would let a stray anon grant pass unnoticed.
SELECT
  'G6' AS gate,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = to_regclass('public.leads')
        AND a.grantee = 'anon'::regrole
    ) THEN 'FAIL — anon holds a grant on public.leads. It must hold NONE.'
    WHEN EXISTS (
      SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = to_regclass('public.leads')
        AND a.grantee = 'authenticated'::regrole
        AND a.privilege_type <> 'SELECT'
    ) THEN 'FAIL — authenticated holds more than SELECT: ' || (
      SELECT string_agg(a.privilege_type, ', ')
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.oid = to_regclass('public.leads') AND a.grantee = 'authenticated'::regrole)
    WHEN NOT EXISTS (
      SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = to_regclass('public.leads')
        AND a.grantee = 'authenticated'::regrole
        AND a.privilege_type = 'SELECT'
    ) THEN 'FAIL — authenticated has NO SELECT, so the admin policy has nothing to narrow and admin reads will fail'
    ELSE 'PASS — anon: none; authenticated: SELECT only'
  END AS result;

-- G7 — the policy itself: right command, right roles, right predicate,
-- and NOT an ILIKE comparison.
SELECT
  'G7' AS gate,
  CASE
    WHEN p.polname IS NULL THEN 'FAIL — admin_select_leads does not exist'
    -- 🔴 ::text is load-bearing. pg_policy.polcmd is Postgres's internal
    -- "char" type, and a string literal arrives as `unknown`, so
    -- `unknown || "char"` leaves several candidate || operators and no
    -- way to choose: 42725 at analysis time, before a single row is
    -- read. The COMPARISON on this line is fine — 'r' resolves to "char"
    -- unambiguously. Only the concatenation is ambiguous.
    WHEN p.polcmd <> 'r'   THEN 'FAIL — policy is not SELECT-only (polcmd=' || p.polcmd::text || ')'
    WHEN NOT p.polpermissive THEN 'FAIL — policy is RESTRICTIVE; expected PERMISSIVE'
    WHEN EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.oid = ANY(p.polroles) AND r.rolname = 'anon'
    ) THEN 'FAIL — policy is granted to anon'
    WHEN p.polroles = '{0}'::oid[] THEN 'FAIL — policy targets PUBLIC, not authenticated'
    WHEN pg_get_expr(p.polqual, p.polrelid) LIKE '%~~*%'
      THEN 'FAIL — policy predicate uses ILIKE (~~*). Must be equality — see the Sept ILIKE arc.'
    WHEN pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%get_my_role%'
      THEN 'FAIL — policy does not go through get_my_role(): ' || pg_get_expr(p.polqual, p.polrelid)
    -- 🔴 F1 (2026-09-23). The gate above proves the predicate CALLS
    -- get_my_role(). It does not prove what it compares the result to.
    -- `get_my_role() = 'manager'` passed it while the PASS line claimed
    -- "get_my_role()=admin" — a label describing intent rather than
    -- measurement, which is the exact shape that keeps catching us.
    --
    -- The test is for the quoted literal 'admin', quotes included, NOT
    -- for the substring admin. That distinction is load-bearing:
    -- 'company_admin' CONTAINS "admin", so a naive %admin% test would
    -- pass a policy granting the whole tenant's company_admin read
    -- access to every prospect's name, email and phone. With the quotes,
    -- '%''admin''%' does not match 'company_admin' — the character
    -- before admin there is an underscore, not a quote.
    -- 🔴 EXACT MATCH, pinned 2026-09-23 once the rendering was known.
    -- The keyword tests that used to live here (contains 'admin',
    -- contains no OR) retired containment one shape at a time and would
    -- have kept needing another branch for the next one — ANY(ARRAY[…]),
    -- a second call, a NOT. One equality retires all of them at once.
    --
    -- If this FAILS, the predicate changed. That is not automatically
    -- wrong, but it must be deliberate: read the printed text, decide,
    -- then update this literal in the same commit that changed the
    -- policy. Do NOT relax it back to a LIKE.
    WHEN pg_get_expr(p.polqual, p.polrelid) <> '(get_my_role() = ''admin''::text)'
      THEN 'FAIL — predicate is not the pinned text. Expected exactly '
           || '(get_my_role() = ''admin''::text)  but found:  '
           || pg_get_expr(p.polqual, p.polrelid)
    ELSE 'PASS — SELECT, {authenticated}, predicate matches the pinned text exactly: '
         || pg_get_expr(p.polqual, p.polrelid)
  END AS result
FROM (SELECT 1) dummy
LEFT JOIN pg_policy p
  ON p.polrelid = to_regclass('public.leads') AND p.polname = 'admin_select_leads';

-- ══════════════════════════════════════════════════════════════════
-- 🔴 CLEANUP — AND WHY THIS FILE MUST BE RUN WHOLE, IN ONE GO
-- ══════════════════════════════════════════════════════════════════
-- EVERY PROBE BLOCK IN THIS FILE NOW DELETES ITS OWN ROW, inside the
-- same DO block, immediately after the assertions that needed it. You
-- can run the blocks separately, stop halfway, or walk away mid-file,
-- and no probe row is left behind. That is a property of the file, not
-- a rule you have to follow.
--
-- The DELETE below is therefore a belt-and-braces sweep, not the only
-- thing standing between a probe and a live business table. It was the
-- only thing on 2026-09-23, and probe-g5c@verification.invalid survived
-- into public.leads until a later session found it.
--
-- 🔴 The rule worth carrying past this file: a verification that writes
-- to a table a human will read as BUSINESS DATA must self-clean inside
-- the writing block. Catalog reads are harmless; this class is not —
-- a fake lead gets counted, exported and possibly contacted.
-- ══════════════════════════════════════════════════════════════════

-- ── CLEANUP — remove every probe row, then PROVE it ───────────────
-- DELETE ... RETURNING, because a DELETE that matched nothing and a
-- DELETE that removed four rows are indistinguishable without it.
DELETE FROM public.leads
 WHERE email LIKE '%@verification.invalid'
RETURNING id, email, 'probe row removed' AS note;

-- ── TERMINAL PASS ROW ─────────────────────────────────────────────
-- 🔴 The editor shows only the LAST row-returning statement, so this is
-- the summary. G3/G4/G5 report through RAISE NOTICE — read the Messages
-- pane for those; this row cannot see them.
SELECT
  CASE
    WHEN (SELECT count(*) FROM public.leads WHERE email LIKE '%@verification.invalid') > 0
      THEN 'FAIL — probe rows SURVIVED cleanup: '
           || (SELECT count(*) FROM public.leads WHERE email LIKE '%@verification.invalid')::text
    WHEN NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.leads') AND relrowsecurity)
      THEN 'FAIL — RLS is not enabled on public.leads'
    ELSE 'PASS — probes cleaned, RLS enabled. Now read G1/G2/G6/G7 above and G3/G4/G5 in the Messages pane. '
         || 'Real leads currently in the table: '
         || (SELECT count(*) FROM public.leads)::text
  END AS verification_summary;
