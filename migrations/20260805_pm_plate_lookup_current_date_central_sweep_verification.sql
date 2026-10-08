-- ══════════════════════════════════════════════════════════════════════
-- 20260805_pm_plate_lookup_current_date_central_sweep_verification.sql
-- POST-APPLY: pm_plate_lookup signature stable, CURRENT_DATE gone from
-- body, current_date_central() present in the right slots, other 5
-- branches byte-preserved, AP-VIEWING predicates intact, primitive
-- boundary probe demonstrates the fix differs from old code at 8pm
-- Central instant.
-- BEGIN…COMMIT wrap — aborts at first RAISE. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260805_pm_plate_lookup_current_date_central_sweep.sql.
-- Paste WHOLE.
--
-- Source-inspection VQs strip `-- ...` comments before matching per
-- discipline #11 (2026-08-04 codification).
--
-- ── EXPECTED OUTPUT ──────────────────────────────────────────────────
-- Every VQ silent EXCEPT exactly ONE NOTICE from VQ.PRIMITIVE_BOUNDARY_
-- DIFFERS. The NOTICE reads (verbatim except date arithmetic):
--
--   NOTICE:  VQ.PRIMITIVE_BOUNDARY_DIFFERS: at 2026-08-05 01:30 UTC
--            (= 8:30pm CDT Aug 4): OLD CURRENT_DATE(under UTC
--            session)=2026-08-05 [would deny guest w/ end_date=Aug 4];
--            NEW current_date_central()=2026-08-04 [admits guest w/
--            end_date=Aug 4]. Fix substitution proven.
--
-- Any OTHER output (a second NOTICE, or an ERROR/WARNING) means
-- something fired that wasn't expected — investigate before proceeding.
--
-- MANUAL BEHAVIOURAL RECIPES — run after client re-deploys any surface
-- that hits pm_plate_lookup (manager plate lookup):
--
--   BEHAVIOURAL 1 (end-edge inclusion — the fix):
--     Log in as a manager scoped to a property with a guest_auth whose
--     end_date is TODAY (Central). At 7pm+ Central, look up the guest's
--     plate. Expect: `guest_authorized`. Before fix, same setup returned
--     `unauthorized`.
--
--   BEHAVIOURAL 2 (start-edge exclusion — the new deny):
--     Same manager, a guest_auth whose start_date is TOMORROW (Central).
--     At 7pm+ Central, look up. Expect: `unauthorized`. Before fix,
--     same setup returned `guest_authorized` (fail-open).
--
--   BEHAVIOURAL 3 (other 5 branches still work): resident vehicle,
--     visitor pass, authorized_plate, DNT, unauthorized — one plate
--     each. Result_type unchanged from pre-fix behaviour.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.SIGNATURE_UNCHANGED ────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants only when signature stable.
-- pm_plate_lookup still (TEXT, TEXT) → jsonb, SECURITY DEFINER,
-- VOLATILE (as-is from 20260724).
DO $$
DECLARE v_count int; v_secdef boolean; v_volatile "char";
BEGIN
  SELECT COUNT(*), bool_and(prosecdef), max(provolatile)
    INTO v_count, v_secdef, v_volatile
    FROM pg_proc
   WHERE proname = 'pm_plate_lookup'
     AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.SIGNATURE_UNCHANGED: expected 1 pm_plate_lookup; got %', v_count;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'VQ.SIGNATURE_UNCHANGED: expected SECURITY DEFINER; got INVOKER';
  END IF;
  IF v_volatile <> 'v' THEN
    RAISE EXCEPTION 'VQ.SIGNATURE_UNCHANGED: expected VOLATILE (v); got %', v_volatile;
  END IF;
END $$;

-- ── VQ.GRANTS ────────────────────────────────────────────────────────
-- anon MUST NOT have EXECUTE; authenticated MUST. Same shape as 20260724.
DO $$
DECLARE v_has_anon boolean; v_has_authenticated boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.pm_plate_lookup(text,text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.pm_plate_lookup(text,text)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.GRANTS: anon HAS EXECUTE on pm_plate_lookup (must be REVOKED)';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.GRANTS: authenticated MISSING EXECUTE on pm_plate_lookup';
  END IF;
END $$;

-- ── VQ.CURRENT_DATE_GONE ─────────────────────────────────────────────
-- Grep gate. NO CURRENT_DATE in the code body (comments stripped).
-- If a future edit reintroduces one with legit rationale, mark it
-- with `-- tz-ok: <reason>` on the same line — this VQ then still
-- passes because comment-strip removes the marker AND the code, but
-- the reader sees the marker.
--
-- (No CURRENT_DATE is expected in this body today. This gate would
-- ONLY fire on a regression.)
DO $$
DECLARE
  v_body      text;
  v_body_code text;
  v_matched   text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'pm_plate_lookup'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code ~ '\yCURRENT_DATE\y' THEN
    SELECT trim(regexp_replace(l, '--.*$', ''))
      INTO v_matched
      FROM regexp_split_to_table(v_body, E'\n') AS l
     WHERE regexp_replace(l, '--.*$', '') ~ '\yCURRENT_DATE\y'
     LIMIT 1;
    RAISE EXCEPTION 'VQ.CURRENT_DATE_GONE: pm_plate_lookup body still calls CURRENT_DATE at code line: [%]', v_matched;
  END IF;
END $$;

-- ── VQ.CURRENT_DATE_CENTRAL_PRESENT ──────────────────────────────────
-- Body MUST reference public.current_date_central() at the guest-auth
-- branch predicate (twice: start_date and end_date). Comment-strip
-- before matching per discipline #11.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
  v_count     int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'pm_plate_lookup'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'ga\.start_date\s*<=\s*public\.current_date_central\(\)' THEN
    RAISE EXCEPTION 'VQ.CURRENT_DATE_CENTRAL_PRESENT: body missing `ga.start_date <= public.current_date_central()` in guest-auth branch';
  END IF;
  IF v_body_code !~ 'ga\.end_date\s*>=\s*public\.current_date_central\(\)' THEN
    RAISE EXCEPTION 'VQ.CURRENT_DATE_CENTRAL_PRESENT: body missing `ga.end_date >= public.current_date_central()` in guest-auth branch';
  END IF;

  -- Belt: exactly 2 references (not 3, not 1). A stray third means
  -- someone swapped a different branch's predicate too — regression.
  SELECT array_length(regexp_split_to_array(v_body_code, 'current_date_central\s*\('), 1) - 1
    INTO v_count;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VQ.CURRENT_DATE_CENTRAL_PRESENT: expected exactly 2 calls to current_date_central() in body; found %', v_count;
  END IF;
END $$;

-- ── VQ.OTHER_BRANCHES_INTACT ─────────────────────────────────────────
-- The five branches NOT touched by this migration must be byte-
-- preserved. Assert distinctive signatures per branch. If any is
-- missing, this migration silently regressed something else.
DO $$
DECLARE
  v_body      text;
  v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'pm_plate_lookup'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  -- Branch 0: DNT
  IF v_body_code !~ 'do_not_tow_plates dnt' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: DNT branch (do_not_tow_plates dnt) missing';
  END IF;
  IF v_body_code !~ 'dnt\.removed_at IS NULL' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: DNT branch lifecycle predicate (removed_at IS NULL) missing';
  END IF;

  -- Branch 1: Resident (active permit)
  IF v_body_code !~ 'v\.is_active = TRUE' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Resident branch (v.is_active = TRUE) missing';
  END IF;
  IF v_body_code !~ 'v_result_type := ''resident''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Resident branch result_type assignment missing';
  END IF;

  -- Branch 1.5: Authorized plate
  IF v_body_code !~ 'check_authorized_plate\s*\(' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: AP branch (check_authorized_plate call) missing';
  END IF;
  IF v_body_code !~ 'v_result_type\s*:=\s*''authorized_plate''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: AP branch result_type assignment missing';
  END IF;

  -- Branch 2: Pending permit
  IF v_body_code !~ 'v\.is_active = FALSE' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Pending branch (v.is_active = FALSE) missing';
  END IF;
  IF v_body_code !~ 'v\.status\s*=\s*''pending''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Pending branch (v.status = pending) missing';
  END IF;
  IF v_body_code !~ 'v_result_type := ''pending''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Pending branch result_type assignment missing';
  END IF;

  -- Branch 3: Plate change under review
  IF v_body_code !~ 'vehicle_plate_changes vpc' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Plate-change branch (vehicle_plate_changes vpc) missing';
  END IF;
  IF v_body_code !~ 'v_result_type := ''plate_under_review''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Plate-change branch result_type assignment missing';
  END IF;

  -- Branch 4: Guest auth (the branch we edited — sanity check
  --   guest_authorized result_type still set)
  IF v_body_code !~ 'v_result_type := ''guest_authorized''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Guest-auth branch result_type assignment missing';
  END IF;

  -- Branch 5: Visitor pass
  IF v_body_code !~ 'visitor_passes vp' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Visitor branch (visitor_passes vp) missing';
  END IF;
  IF v_body_code !~ 'vp\.expires_at\s*>\s*now\(\)' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Visitor branch (vp.expires_at > now()) missing';
  END IF;
  IF v_body_code !~ 'v_result_type := ''visitor''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Visitor branch result_type assignment missing';
  END IF;

  -- Branch 6: Unauthorized
  IF v_body_code !~ 'v_result_type := ''unauthorized''' THEN
    RAISE EXCEPTION 'VQ.OTHER_BRANCHES_INTACT: Unauthorized branch result_type assignment missing';
  END IF;
END $$;

-- ── VQ.AP_VIEWING_PREDICATES_INTACT ──────────────────────────────────
-- July 24's AP-VIEWING work added viewing-property predicates to 7
-- sites (6 branches + 1 argument change). All must survive Commit B.
-- Count the `p_viewing_property IS NULL OR lower(trim(` pattern —
-- expected 6 (one per branch that has a predicate; the AP argument
-- change is separate).
DO $$
DECLARE
  v_body      text;
  v_body_code text;
  v_count     int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'pm_plate_lookup'
     AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  SELECT array_length(
    regexp_split_to_array(v_body_code, 'p_viewing_property IS NULL OR lower\(trim\('),
    1
  ) - 1
    INTO v_count;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'VQ.AP_VIEWING_PREDICATES_INTACT: expected 6 viewing-property predicates (branches 0,1,2,3,4,5); found %', v_count;
  END IF;

  -- Also: the AP-argument-change site (branch 1.5 passes p_viewing_property
  -- to check_authorized_plate instead of NULL).
  IF v_body_code !~ 'check_authorized_plate\s*\(\s*v_normalized\s*,\s*p_viewing_property\s*\)' THEN
    RAISE EXCEPTION 'VQ.AP_VIEWING_PREDICATES_INTACT: check_authorized_plate(v_normalized, p_viewing_property) argument-change from AP-VIEWING missing';
  END IF;
END $$;

-- ── VQ.PRIMITIVE_BOUNDARY_DIFFERS (Mateo probe 4c) ───────────────────
-- Simulate 8:30pm Central on Aug 4 (= 01:30 UTC Aug 5). Show that
-- CURRENT_DATE-under-UTC-session and current_date_central() disagree
-- at this instant, and that they disagree in the way the fix predicts.
-- This is a PRIMITIVE probe against the SQL expressions, not against
-- pm_plate_lookup's body — the body-inspection VQs above cover that
-- axis. Here we prove the SUBSTITUTION changes the answer.
--
-- Uses SET LOCAL TIME ZONE to control the session context; both
-- SELECTs happen within the same DO block so no state leaks.
DO $$
DECLARE
  v_utc_curdate     date;
  v_central_curdate date;
BEGIN
  -- Under UTC session, CURRENT_DATE resolves in UTC. We cast a known
  -- instant to date the same way CURRENT_DATE would resolve at that
  -- instant, then cast the same instant through Central for
  -- current_date_central()'s answer.
  --
  -- Chosen instant: 2026-08-05 01:30 UTC = 2026-08-04 20:30 CDT.

  v_utc_curdate     := ('2026-08-05 01:30:00+00'::timestamptz)::date;
  v_central_curdate := (('2026-08-05 01:30:00+00'::timestamptz) AT TIME ZONE 'America/Chicago')::date;

  IF v_utc_curdate = v_central_curdate THEN
    RAISE EXCEPTION 'VQ.PRIMITIVE_BOUNDARY_DIFFERS: expected UTC vs Central to disagree at 8:30pm CDT boundary; got UTC=% Central=% (both %)',
      v_utc_curdate, v_central_curdate, v_utc_curdate;
  END IF;

  -- Direction assertions — belt against a swap that fires but
  -- points the wrong way.
  IF v_utc_curdate <> DATE '2026-08-05' THEN
    RAISE EXCEPTION 'VQ.PRIMITIVE_BOUNDARY_DIFFERS: UTC cast expected 2026-08-05; got %', v_utc_curdate;
  END IF;
  IF v_central_curdate <> DATE '2026-08-04' THEN
    RAISE EXCEPTION 'VQ.PRIMITIVE_BOUNDARY_DIFFERS: Central cast expected 2026-08-04; got %', v_central_curdate;
  END IF;

  RAISE NOTICE 'VQ.PRIMITIVE_BOUNDARY_DIFFERS: at 2026-08-05 01:30 UTC (= 8:30pm CDT Aug 4): OLD CURRENT_DATE(under UTC session)=% [would deny guest w/ end_date=Aug 4]; NEW current_date_central()=% [admits guest w/ end_date=Aug 4]. Fix substitution proven.',
    v_utc_curdate, v_central_curdate;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ──────────────────────────────────────────────
-- Confirms the SCHEMA_ audit was written by the migration (STEP 4).
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PM_PLATE_LOOKUP_CURRENT_DATE_CENTRAL'
     AND new_values->>'migration' = '20260805_pm_plate_lookup_current_date_central_sweep';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing (STEP 4 in migration did not write)';
  END IF;
END $$;

COMMIT;
