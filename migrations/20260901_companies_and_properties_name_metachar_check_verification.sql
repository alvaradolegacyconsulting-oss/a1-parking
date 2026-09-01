-- ══════════════════════════════════════════════════════════════════════
-- 20260901_companies_and_properties_name_metachar_check_verification.sql
--
-- Paired verification. v2 pattern (no BEGIN/COMMIT wrap; terminal
-- SELECT returns PASS row). 10 gates + session guard.
--
-- ── GATES ───────────────────────────────────────────────────────────
--   VS1  companies_name_no_sql_metachar constraint exists
--   VS2  properties_name_no_sql_metachar constraint exists
--   VS3  🔴 EXECUTION — INSERT company with `%` in name → expect 23514
--   VS4  🔴 EXECUTION — UPDATE company setting name to `_` → expect 23514
--   VS5  🔴 EXECUTION — INSERT property with `\` in name → expect 23514
--   VS6  🔴 EXECUTION — UPDATE property setting name to `%_` → expect 23514
--   VS7  🔴 EXECUTION — INSERT company with legitimate chars
--        (apostrophe, ampersand, hyphen, period) → expect SUCCESS
--        (guardrail against over-strict validator per Mateo Sep 1 §5)
--   VS8  no CHECK on properties.company (out of scope per header;
--        gate asserts absence so a future silent add doesn't sneak in)
--   VS9  post-apply parity — same pre-flight scan returns 0/0/0
--        (constraint holding; nothing snuck in during apply)
--   VS10 schema audit row present
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: companies constraint exists ────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'companies'
     AND c.conname = 'companies_name_no_sql_metachar'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: companies_name_no_sql_metachar CHECK constraint not found (got %)', v_count;
  END IF;
END $$;

-- ── VS2: properties constraint exists ───────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'properties'
     AND c.conname = 'properties_name_no_sql_metachar'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS2 FAIL: properties_name_no_sql_metachar CHECK constraint not found (got %)', v_count;
  END IF;
END $$;

-- ── VS3: INSERT %-named company → 23514 ─────────────────────────────
DO $$
DECLARE v_sqlstate TEXT; v_msg TEXT;
BEGIN
  BEGIN
    INSERT INTO public.companies (name, tier, tier_type, is_active)
    VALUES ('__vs3_probe_' || floor(extract(epoch from now()))::TEXT || '_%', 'legacy', 'enforcement', false);
    RAISE EXCEPTION 'VS3 FAIL: INSERT with %% in name SUCCEEDED — CHECK constraint not blocking';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS3 FAIL: expected 23514 check_violation on %%-named INSERT; got sqlstate=% msg=%. If it is 23502 not-null, add the required column to this probe INSERT.', v_sqlstate, v_msg;
    END IF;
    -- Verify the message named our constraint (defensive against
    -- an unrelated CHECK firing on a different column).
    IF v_msg NOT LIKE '%companies_name_no_sql_metachar%' THEN
      RAISE EXCEPTION 'VS3 FAIL: got 23514 but from wrong constraint. msg=%. Expected companies_name_no_sql_metachar to fire.', v_msg;
    END IF;
  END;
END $$;

-- ── VS4: UPDATE company name to `_` → 23514 ─────────────────────────
-- 🔴 Uses a FRESH PROBE row rather than the first existing company —
-- any pre-existing row can carry defenses (rename-block triggers,
-- RLS, etc.) that fire BEFORE the CHECK and mask what we're
-- verifying. See VS6 note.
-- The whole DO block is atomic: on the correct-behavior path, the
-- inner BEGIN/EXCEPTION swallows check_violation, we fall through
-- to DELETE the probe row. On any raise path, the block rolls back
-- (INSERT undone too) — net zero rows in either case.
DO $$
DECLARE
  v_probe_id BIGINT;
  v_probe_name TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  v_probe_name := '__vs4_probe_' || floor(extract(epoch from now()))::TEXT;
  INSERT INTO public.companies (name, tier, tier_type, is_active)
  VALUES (v_probe_name, 'legacy', 'enforcement', false)
  RETURNING id INTO v_probe_id;
  BEGIN
    UPDATE public.companies SET name = v_probe_name || '_' WHERE id = v_probe_id;
    RAISE EXCEPTION 'VS4 FAIL: UPDATE with _ in name SUCCEEDED — CHECK constraint not blocking (probe id=%s)', v_probe_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS4 FAIL: expected 23514 check_violation; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%companies_name_no_sql_metachar%' THEN
      RAISE EXCEPTION 'VS4 FAIL: got 23514 but from wrong constraint. msg=%', v_msg;
    END IF;
  END;
  -- CHECK fired correctly; clean up probe row.
  DELETE FROM public.companies WHERE id = v_probe_id;
END $$;

-- ── VS5: INSERT property with `\` in name → 23514 ───────────────────
DO $$
DECLARE
  v_company_name TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT name INTO v_company_name FROM public.companies ORDER BY id LIMIT 1;
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'VS5 FIXTURE FAIL: no companies exist to attach a probe property to';
  END IF;
  BEGIN
    INSERT INTO public.properties (name, company, is_active)
    VALUES ('__vs5_probe_' || floor(extract(epoch from now()))::TEXT || E'_\\', v_company_name, false);
    RAISE EXCEPTION 'VS5 FAIL: INSERT with \ in name SUCCEEDED — CHECK constraint not blocking';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS5 FAIL: expected 23514 check_violation; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%properties_name_no_sql_metachar%' THEN
      RAISE EXCEPTION 'VS5 FAIL: got 23514 but from wrong constraint. msg=%', v_msg;
    END IF;
  END;
END $$;

-- ── VS6: UPDATE property setting name containing `%_` → 23514 ───────
-- 🔴 Uses a FRESH PROBE property rather than the first existing row.
-- Rationale (surfaced in v1 apply Sep 1 2026): every existing property
-- with count>0 active user assignments trips
-- trg_properties_name_block_rename (migration 20260715) BEFORE the CHECK
-- fires — the trigger raises with sqlstate 23514 too (matching CHECK by
-- design so callers can't distinguish "blocked by name policy" from
-- "blocked by assignment policy"), which masks whether OUR CHECK
-- constraint is actually working. Fresh probe row has 0 assignments →
-- rename-block trigger returns count=0 → passes → CHECK fires → we
-- observe cleanly.
--
-- Whole DO block is atomic: correct behavior swallows check_violation
-- and DELETEs the probe row. Any raise path rolls back INSERT + all —
-- net zero rows.
--
-- Same trigger doesn't exist on companies, but VS4 uses the same
-- fresh-probe pattern for defense: any future trigger we didn't
-- anticipate can't mask the verification.
DO $$
DECLARE
  v_probe_id BIGINT;
  v_probe_name TEXT;
  v_company_name TEXT;
  v_sqlstate TEXT;
  v_msg TEXT;
BEGIN
  SELECT name INTO v_company_name FROM public.companies ORDER BY id LIMIT 1;
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'VS6 FIXTURE FAIL: no companies exist to attach a probe property to';
  END IF;
  v_probe_name := '__vs6_probe_' || floor(extract(epoch from now()))::TEXT;
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_probe_name, v_company_name, false)
  RETURNING id INTO v_probe_id;
  BEGIN
    UPDATE public.properties SET name = v_probe_name || '_%' WHERE id = v_probe_id;
    RAISE EXCEPTION 'VS6 FAIL: UPDATE with %%_ in name SUCCEEDED — CHECK constraint not blocking (probe id=%s)', v_probe_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_sqlstate <> '23514' THEN
      RAISE EXCEPTION 'VS6 FAIL: expected 23514 check_violation; got sqlstate=% msg=%', v_sqlstate, v_msg;
    END IF;
    IF v_msg NOT LIKE '%properties_name_no_sql_metachar%' THEN
      RAISE EXCEPTION 'VS6 FAIL: got 23514 but from wrong constraint. msg=%', v_msg;
    END IF;
  END;
  -- CHECK fired correctly; clean up probe row.
  DELETE FROM public.properties WHERE id = v_probe_id;
END $$;

-- ── VS7: 🔴 GUARDRAIL — legitimate chars must still SUCCEED ─────────
-- Per Mateo Sep 1 §5: "Do not reject anything beyond those three
-- characters. Apostrophes, ampersands, hyphens and periods are
-- ordinary in real property names, and A1 is adding 10-15 properties
-- by Q4 — a validator that blocks a legitimate name blocks their
-- rollout."
-- Ensures the regex character class is exactly [%_\] and hasn't
-- accidentally caught anything else.
DO $$
DECLARE
  v_new_id BIGINT;
BEGIN
  INSERT INTO public.companies (name, tier, tier_type, is_active)
  VALUES ('__vs7_probe_' || floor(extract(epoch from now()))::TEXT || ' O''Brien & Co. - Ltd.', 'legacy', 'enforcement', false)
  RETURNING id INTO v_new_id;
  -- Legit; clean up probe row.
  DELETE FROM public.companies WHERE id = v_new_id;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'VS7 FAIL: legitimate name (apostrophe/ampersand/hyphen/period) REJECTED — CHECK constraint over-strict. SQLSTATE=% MESSAGE=%', SQLSTATE, SQLERRM;
END $$;

-- ── VS8: no CHECK on properties.company (out of scope) ──────────────
-- Guards against future silent add. Named-constraint check keeps this
-- gate simple; if a properties.company CHECK is intentionally added
-- later, drop this gate + update the migration header together.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'properties'
     AND c.contype = 'c'
     AND c.conname IN (
       'properties_company_no_sql_metachar',
       'properties_company_no_metachar'
     );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS8 FAIL: unexpected CHECK on properties.company found (count=%). Migration header explicitly kept this out of scope — companies.name CHECK is the source-of-truth constraint. If this is being added later, update the header comment + drop this gate together.', v_count;
  END IF;
END $$;

-- ── VS9: post-apply parity — pre-flight scan still 0/0/0 ────────────
-- The CHECK apply itself would have rejected any bad row, so this
-- should be tautologically 0 for companies.name + properties.name.
-- properties.company still relies on the pre-flight baseline.
DO $$
DECLARE
  v_companies_bad     INT;
  v_props_name_bad    INT;
  v_props_company_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_companies_bad     FROM public.companies  WHERE name    ~ '[%_\\]';
  SELECT COUNT(*) INTO v_props_name_bad    FROM public.properties WHERE name    ~ '[%_\\]';
  SELECT COUNT(*) INTO v_props_company_bad FROM public.properties WHERE company ~ '[%_\\]';
  IF v_companies_bad <> 0 OR v_props_name_bad <> 0 THEN
    RAISE EXCEPTION 'VS9 FAIL: post-apply scan nonzero (should be impossible with CHECK active). companies.name=% properties.name=%',
      v_companies_bad, v_props_name_bad;
  END IF;
  IF v_props_company_bad <> 0 THEN
    RAISE EXCEPTION 'VS9 FAIL: properties.company scan nonzero (=%). Constraint not on this column (see VS8 + header); denormalized drift needs cleanup + a follow-up decision on adding a CHECK here.',
      v_props_company_bad;
  END IF;
END $$;

-- ── VS10: schema audit row ─────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_NAME_METACHAR_CHECK'
     AND new_values->>'migration' = '20260901_companies_and_properties_name_metachar_check';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS10 FAIL: schema audit row missing';
  END IF;
END $$;

-- ── FINAL: PASS row ────────────────────────────────────────────────
SELECT
  'PASS'::TEXT AS status,
  'companies.name + properties.name CHECK (no SQL metacharacters)'::TEXT AS target,
  ARRAY[
    'VS1  companies_name_no_sql_metachar constraint exists',
    'VS2  properties_name_no_sql_metachar constraint exists',
    'VS3  🔴 execution — INSERT %-named company → 23514',
    'VS4  🔴 execution — UPDATE company name to _ → 23514',
    'VS5  🔴 execution — INSERT property with \ in name → 23514',
    'VS6  🔴 execution — UPDATE property name to %_ → 23514',
    'VS7  🔴 guardrail — apostrophe/ampersand/hyphen/period still SUCCEED',
    'VS8  properties.company has no CHECK (kept out of scope per header)',
    'VS9  post-apply pre-flight scan 0/0/0',
    'VS10 SCHEMA_NAME_METACHAR_CHECK audit row'
  ] AS gates_verified,
  now() AS verified_at;
