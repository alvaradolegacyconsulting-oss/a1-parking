-- ══════════════════════════════════════════════════════════════════════
-- ISOLATION PROBE — why did `unnest(v_acl) a WHERE a::text` raise
-- 42P01 on 2026-09-17 when the identical construct ran green on 09-09
-- and twice on 09-10?
--
-- Paste the WHOLE thing, run ONCE. Read-only: three DO blocks, no
-- writes, no transaction. Each reports its own outcome, so a failure in
-- one does not hide the others — EXCEPT that a raise aborts the paste,
-- which is why the suspected-bad form is LAST.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────
-- A mechanical diff of the failing block against the one that passed
-- found ONLY whitespace differences:
--     v_acl declared type          aclitem[]   identical
--     unnest alias                 a           identical
--     bare `a` tokens              6           identical
--     IF+assign+END IF on one line 3  vs  0    ← the only difference
--     DECLARE collapsed to one line yes vs no  ← the only difference
-- Whitespace is not supposed to change how Postgres parses. So either
-- the cause is outside the text, or line-collapsing matters in this
-- editor in a way it should not.
--
-- 🔴 THIS MATTERS BEYOND ONE GATE. If the construct is fine and
-- something environmental caused it, then the THREE blocks still using
-- the bare-alias form — 20260909_tow_log_commit_4_rpcs_verification VS2,
-- VS4, VS6 — can fail the same way on a future run. Only the 09-17 file
-- was changed to `AS x(item)`; the others were left alone deliberately,
-- because rewriting applied, passing verifications on an unproven theory
-- is churn.
-- ══════════════════════════════════════════════════════════════════════

-- ── A: the construct alone, multi-line. Expect a NOTICE, no error. ──
DO $probe_a$
DECLARE
  v_acl aclitem[];
  v_hit BOOLEAN;
BEGIN
  SELECT proacl INTO v_acl FROM pg_proc
   WHERE oid = to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');

  SELECT EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%')
    INTO v_hit;

  RAISE NOTICE 'A OK — bare alias, MULTI-LINE parsed and ran. authenticated grant found: %', v_hit;
END $probe_a$;


-- ── B: explicit column alias, the shipped fix. Expect the same. ─────
DO $probe_b$
DECLARE
  v_acl aclitem[];
  v_hit BOOLEAN;
BEGIN
  SELECT proacl INTO v_acl FROM pg_proc
   WHERE oid = to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');

  SELECT EXISTS (SELECT 1 FROM unnest(v_acl) AS x(item) WHERE x.item::text LIKE 'authenticated=X/%')
    INTO v_hit;

  RAISE NOTICE 'B OK — explicit AS x(item) parsed and ran. authenticated grant found: %', v_hit;
END $probe_b$;


-- ── C: 🔴 THE SUSPECT. Bare alias with IF + assignment + END IF
--    collapsed onto ONE LINE, and a semicolon inside the string
--    literal — byte-for-byte the shape that failed.
--    LAST, because if this is the cause it aborts the paste and A and B
--    will already have reported.
-- ══════════════════════════════════════════════════════════════════════
DO $probe_c$
DECLARE v_acl aclitem[]; v_bad TEXT := '';
BEGIN
  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');
  IF NOT EXISTS (SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%') THEN v_bad := v_bad || 'missing authenticated EXECUTE; '; END IF;
  RAISE NOTICE 'C OK — collapsed form ALSO parsed. v_bad=%. So line-collapsing is NOT the cause and the 09-17 failure is still unexplained.', COALESCE(NULLIF(v_bad,''),'(empty)');
END $probe_c$;


-- ══════════════════════════════════════════════════════════════════════
-- HOW TO READ IT
--   A, B and C all NOTICE       → the construct is fine in every form.
--                                 The 09-17 failure was environmental
--                                 (session state, search_path, a
--                                 partial paste) and the three blocks
--                                 still on the bare form are equally
--                                 exposed. Worth finding before trusting
--                                 any of them.
--   A and B ok, C raises 42P01  → line-collapsing IS the trigger in this
--                                 editor. Then the rule is concrete:
--                                 never collapse IF/assignment/END IF
--                                 onto one line inside a DO block, and
--                                 the other three files are SAFE because
--                                 they are already multi-line.
--   A raises, B ok              → the bare alias is genuinely unreliable
--                                 and the other three files need the
--                                 same fix as this one.
-- ══════════════════════════════════════════════════════════════════════
