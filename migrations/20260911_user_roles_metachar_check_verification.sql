-- ══════════════════════════════════════════════════════════════════════
-- 20260911_user_roles_metachar_check_verification.sql
--
-- Structural gates (the constraints exist) + EXECUTION gates (they
-- actually reject) for the user_roles metacharacter CHECKs.
--
-- ── 🔴 WHY THE EXECUTION GATES DISCRIMINATE ON CONSTRAINT NAME ──────
-- sqlstate 23514 is check_violation for EVERY check on this table, and
-- user_roles carries others. A gate asserting "23514 was raised" would
-- pass if some unrelated constraint fired instead — the sqlstate-shared
-- problem, same class as 42501 covering both tier_not_permitted and a
-- grant-layer denial (feedback_sqlstate_42501_shared_across_causes).
--
-- GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME names the exact
-- constraint, which is stronger than matching message text and does not
-- break when Postgres rewords.
--
-- ── FRESH PROBE ROWS, NOT EXISTING ONES ─────────────────────────────
-- Every attempt runs against a row THIS FILE inserted. Mutating an
-- existing user_roles row risks tripping a different trigger or
-- constraint that raises the same sqlstate, and
-- feedback_probe_hygiene_rule forbids touching real role rows at all.
--
-- ── 🔴 THE POSITIVE CONTROLS ARE NOT OPTIONAL ───────────────────────
-- "The write was rejected" is also what a broken fixture, a NOT NULL
-- violation or a typo'd column produces. G3/G4 assert that LEGITIMATE
-- values are ACCEPTED — a constraint that rejects everything would
-- satisfy every rejection gate in this file and be catastrophic.
--
-- Seeds inside BEGIN/ROLLBACK; terminal PASS SELECT after the rollback.
-- Probe values on @metacharprobe.invalid, a reserved TLD.
-- ══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
-- VS1 — both constraints exist, by name, as CHECK constraints.
-- ══════════════════════════════════════════════════════════════════════
DO $vs1$
DECLARE
  v_missing TEXT := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_roles'::regclass
       AND contype  = 'c'
       AND conname  = 'user_roles_company_no_sql_metachar'
  ) THEN v_missing := v_missing || 'user_roles_company_no_sql_metachar; ';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_roles'::regclass
       AND contype  = 'c'
       AND conname  = 'user_roles_property_no_sql_metachar'
  ) THEN v_missing := v_missing || 'user_roles_property_no_sql_metachar; ';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'VS1 FAIL: missing CHECK constraint(s): %', v_missing;
  END IF;
END $vs1$;


BEGIN;

-- ── FIXTURE ═════════════════════════════════════════════════════════
-- One clean row to mutate. Inserted with LEGITIMATE values, which also
-- proves the constraints do not block an ordinary write before any
-- rejection gate runs.
DO $fixture$
BEGIN
  INSERT INTO public.user_roles (email, role, company, property)
  VALUES ('probe@metacharprobe.invalid', 'manager', 'Metachar Probe Co',
          ARRAY['Metachar Probe Property']::text[]);
END $fixture$;


-- ══════════════════════════════════════════════════════════════════════
-- E1 — company = '%' is REJECTED by the company constraint specifically
-- ══════════════════════════════════════════════════════════════════════
DO $e1$
DECLARE
  v_sqlstate TEXT := NULL;
  v_conname  TEXT := NULL;
  v_affected INT  := 0;
BEGIN
  BEGIN
    WITH upd AS (
      UPDATE public.user_roles SET company = '%'
       WHERE email = 'probe@metacharprobe.invalid' RETURNING 1
    ) SELECT COUNT(*) INTO v_affected FROM upd;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_conname  = CONSTRAINT_NAME;
  END;

  IF v_sqlstate IS NULL THEN
    RAISE EXCEPTION
      'E1 FAIL: company = ''%%'' was ACCEPTED (% row(s) updated). The company CHECK is not enforcing — a user_roles.company of ''%%'' reads every resident in every tenant through the ~80 policies scoping on company ~~* get_my_company().',
      v_affected;
  END IF;
  IF v_sqlstate <> '23514' THEN
    RAISE EXCEPTION 'E1 FAIL: rejected with sqlstate % (expected 23514 check_violation), constraint=%. Something other than the CHECK refused this write.', v_sqlstate, COALESCE(v_conname, 'NULL');
  END IF;
  IF v_conname IS DISTINCT FROM 'user_roles_company_no_sql_metachar' THEN
    RAISE EXCEPTION
      'E1 FAIL: rejected by constraint "%" rather than user_roles_company_no_sql_metachar. 23514 is shared by every check on this table, so the sqlstate alone would have passed this gate for the wrong reason.',
      COALESCE(v_conname, 'NULL');
  END IF;
END $e1$;


-- ══════════════════════════════════════════════════════════════════════
-- E2 — a metacharacter in ANY array element is rejected.
--   The FIRST element is deliberately clean: array_to_string must catch
--   a wildcard anywhere, not just in position 1.
-- ══════════════════════════════════════════════════════════════════════
DO $e2$
DECLARE
  v_sqlstate TEXT := NULL;
  v_conname  TEXT := NULL;
  v_affected INT  := 0;
BEGIN
  BEGIN
    WITH upd AS (
      UPDATE public.user_roles
         SET property = ARRAY['Perfectly Fine Property', 'Bad%Property']::text[]
       WHERE email = 'probe@metacharprobe.invalid' RETURNING 1
    ) SELECT COUNT(*) INTO v_affected FROM upd;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_conname  = CONSTRAINT_NAME;
  END;

  IF v_sqlstate IS NULL THEN
    RAISE EXCEPTION
      'E2 FAIL: a property array whose SECOND element carries ''%%'' was ACCEPTED (% row(s)). array_to_string is not flattening as expected, or the constraint only inspects the first element.',
      v_affected;
  END IF;
  IF v_conname IS DISTINCT FROM 'user_roles_property_no_sql_metachar' THEN
    RAISE EXCEPTION 'E2 FAIL: rejected by constraint "%" (sqlstate %) rather than user_roles_property_no_sql_metachar.', COALESCE(v_conname, 'NULL'), v_sqlstate;
  END IF;
END $e2$;


-- ══════════════════════════════════════════════════════════════════════
-- G3 — 🔴 POSITIVE CONTROL. Legitimate values are ACCEPTED.
--   Without this, a constraint that rejected EVERY write would satisfy
--   E1 and E2 and read as a clean pass — while locking every user
--   management path in the product.
-- ══════════════════════════════════════════════════════════════════════
DO $g3$
DECLARE v_affected INT := 0;
BEGIN
  WITH upd AS (
    UPDATE public.user_roles
       SET company  = 'Green Acres Management',
           property = ARRAY['Green Acres', 'Oak Ridge Apartments']::text[]
     WHERE email = 'probe@metacharprobe.invalid' RETURNING 1
  ) SELECT COUNT(*) INTO v_affected FROM upd;

  IF v_affected <> 1 THEN
    RAISE EXCEPTION
      'G3 CONTROL FAILED: an ordinary company + property write updated % row(s) (expected 1). The constraints are rejecting legitimate values — E1 and E2 passing means nothing, and this would break every user-management write path.',
      v_affected;
  END IF;
END $g3$;


-- ══════════════════════════════════════════════════════════════════════
-- G4 — 🔴 POSITIVE CONTROL, the NULL and empty-array edges.
--   `IS NULL OR` in both predicates, and array_to_string('{}') = ''.
--   A CHECK that rejected NULL would break every company_admin row
--   (property is '{}') and every admin row (company NULL).
-- ══════════════════════════════════════════════════════════════════════
DO $g4$
DECLARE v_affected INT := 0;
BEGIN
  WITH upd AS (
    UPDATE public.user_roles
       SET company = NULL, property = '{}'::text[]
     WHERE email = 'probe@metacharprobe.invalid' RETURNING 1
  ) SELECT COUNT(*) INTO v_affected FROM upd;

  IF v_affected <> 1 THEN
    RAISE EXCEPTION
      'G4 CONTROL FAILED: NULL company + empty property array updated % row(s) (expected 1). Admin rows carry company NULL and company_admin rows carry property ''{}'' — this would lock both out.',
      v_affected;
  END IF;
END $g4$;


-- ══════════════════════════════════════════════════════════════════════
-- E5 — the underscore, explicitly.
--   `_` is the metacharacter we deliberately ALLOWED in email. Here it
--   is blocked, and the asymmetry is intentional — no company name
--   legitimately contains one (companies_name_no_sql_metachar has
--   forbidden it since 2026-09-01). Asserted so nobody "restores
--   consistency" with the email decision by removing it.
-- ══════════════════════════════════════════════════════════════════════
DO $e5$
DECLARE
  v_sqlstate TEXT := NULL;
  v_conname  TEXT := NULL;
BEGIN
  BEGIN
    UPDATE public.user_roles SET company = 'Acme_Corp'
     WHERE email = 'probe@metacharprobe.invalid';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_conname  = CONSTRAINT_NAME;
  END;

  IF v_sqlstate IS NULL THEN
    RAISE EXCEPTION
      'E5 FAIL: company = ''Acme_Corp'' was ACCEPTED. `_` matches ONE character under ILIKE, so a company of ''Acme_Corp'' also matches ''AcmeXCorp''. It is allowed in EMAIL deliberately (11 real accounts carry one); it is NOT allowed here, and companies.name has forbidden it since 2026-09-01.';
  END IF;
  IF v_conname IS DISTINCT FROM 'user_roles_company_no_sql_metachar' THEN
    RAISE EXCEPTION 'E5 FAIL: rejected by "%" (sqlstate %) rather than the company metachar CHECK.', COALESCE(v_conname, 'NULL'), v_sqlstate;
  END IF;
END $e5$;

ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- PASS row — last statement in the paste, AFTER the rollback.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'user_roles company + property metacharacter CHECKs'::TEXT AS target,
  ARRAY[
    'VS1 both CHECK constraints exist by name on public.user_roles',
    'E1  company = ''%'' rejected, and BY user_roles_company_no_sql_metachar specifically',
    'E2  a metachar in the SECOND array element rejected by user_roles_property_no_sql_metachar — array_to_string flattens the whole array',
    'G3  CONTROL: ordinary company + multi-element property write ACCEPTED',
    'G4  CONTROL: NULL company + empty property array ACCEPTED (admin and company_admin row shapes)',
    'E5  underscore rejected here, though deliberately ALLOWED in email — the asymmetry is intentional and asserted so it is not "made consistent" away',
    'DISCIPLINE: every rejection discriminates on CONSTRAINT_NAME via GET STACKED DIAGNOSTICS. 23514 is shared by every check on this table, so sqlstate alone would pass for the wrong reason.',
    'DISCIPLINE: G3/G4 exist because a constraint that rejected EVERYTHING would satisfy every rejection gate here and lock every user-management write path.'
  ] AS gates_verified,
  now() AS verified_at;
