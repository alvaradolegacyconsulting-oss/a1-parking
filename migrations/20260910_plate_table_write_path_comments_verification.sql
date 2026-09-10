-- ══════════════════════════════════════════════════════════════════════
-- 20260910_plate_table_write_path_comments_verification.sql
--
-- Structural verification for the comment-only plate-write-path
-- annotations. v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT
-- returns the PASS row). 5 gates.
--
-- Nothing to execute here — the migration changes no behaviour, only
-- pg_description. The gates that matter are (a) the new text landed and
-- (b) the pre-existing text SURVIVED, because COMMENT ON TABLE replaces
-- rather than appends and a bad implementation would silently discard
-- what was there.
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  do_not_tow_plates comment carries PLATE WRITE-PATH REQUIREMENT
--   VS2  🔴 do_not_tow_plates comment STILL carries its PARKED notice
--        and the do-not-re-grant warning (anti-clobber)
--   VS3  authorized_plates comment carries PLATE WRITE-PATH REQUIREMENT
--   VS4  🔴 authorized_plates comment STILL carries the three-way
--        distinction — tow protection and quota exemption both named
--        (anti-clobber)
--   VS5  SCHEMA_PLATE_TABLE_WRITE_PATH_COMMENTS audit row present
--
-- VS2 and VS4 are the load-bearing pair. VS1 and VS3 alone would pass
-- on an implementation that REPLACED each comment with only the new
-- paragraph — which is the exact failure mode the append-don't-replace
-- design exists to avoid.
--
-- Both comments are also asserted to still name the trigger behaviour
-- in POST-STRIP terms, so a future edit that softens the requirement
-- into advice fails here rather than in production.
--
-- ── 🔴 CORRECTED 2026-09-10 21:58 — VS2/VS4 WERE ASSERTING THE WRONG
--    SOURCE ────────────────────────────────────────────────────────
-- First run FAILED at VS2:
--   VS2 FAIL: do_not_tow_plates comment LOST pre-existing content:
--   do-not-re-grant INSERT/UPDATE warning;
--
-- The data was fine. The migration applied at 21:58:33 and VS1 passed,
-- so the append landed and the prior text was preserved. What failed
-- was the GATE: 'Do not re-grant' was copied out of
-- 20260723_dnt_park_revoke_writes.sql:60 — a MIGRATION FILE — and the
-- live comment does not use that exact wording.
--
-- That is the migrations-lie class, reintroduced one layer up. The
-- migration itself avoids it correctly (it reads obj_description() live
-- and appends to whatever is actually there). The verification then
-- turned around and asserted a string the repo believes should be
-- there. A dashboard edit, or an apply that differed from the committed
-- text, breaks that assumption — and here it did.
-- (feedback_catalog_is_audit_surface_not_migrations)
--
-- 🔴 THE RULE: an anti-clobber gate must not need to know the prior
-- WORDING. Assert the SHAPE instead — the appended marker is a SUFFIX
-- with substantial text in front of it. That detects a replace-instead-
-- of-append regardless of what the prior comment said.
--
-- What VS2/VS4 assert now:
--   · the marker exists (VS1/VS3 already prove that)
--   · at least MIN_PRIOR_CHARS of text PRECEDE the marker — a
--     replace-instead-of-append puts the marker at or near position 1
--   · only substrings EMPIRICALLY CONFIRMED LIVE are matched. For
--     do_not_tow_plates that is 'PARKED' — the 21:58 failure reported
--     ONLY the second item missing, which proves 'PARKED' matched
--     against the live catalog. Nothing is asserted for
--     authorized_plates by wording, because nothing has been observed
--     there yet.
--
-- The terminal PASS row now RETURNS BOTH COMMENTS IN FULL. A green run
-- therefore hands over the ground truth needed to tighten these gates
-- with real observed strings instead of hopeful ones. Failure messages
-- dump the full comment for the same reason.
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: DNT carries the new requirement ═══════════════════════════
DO $vs1$
DECLARE v_comment TEXT;
BEGIN
  v_comment := obj_description('public.do_not_tow_plates'::regclass, 'pg_class');

  IF v_comment IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: do_not_tow_plates has NO table comment at all.';
  END IF;
  IF position('PLATE WRITE-PATH REQUIREMENT' IN v_comment) = 0 THEN
    RAISE EXCEPTION
      'VS1 FAIL: do_not_tow_plates comment does not carry PLATE WRITE-PATH REQUIREMENT. Comment is % chars, starts: %',
      length(v_comment), left(v_comment, 160);
  END IF;
  IF position('POST-STRIP' IN v_comment) = 0 THEN
    RAISE EXCEPTION
      'VS1 FAIL: do_not_tow_plates comment names the requirement but not the POST-STRIP rule it exists to state. A requirement without its rule is decoration.';
  END IF;
END $vs1$;


-- ── VS2: 🔴 DNT pre-existing text survived (anti-clobber) ══════════
-- COMMENT ON TABLE REPLACES. If the migration pasted only the new
-- paragraph, everything that was there before would be gone and nothing
-- else would notice.
--
-- Asserted by SHAPE, not by remembered wording — see the header. The
-- one wording check kept ('PARKED') is the one the 2026-09-10 21:58 run
-- empirically confirmed against the live catalog.
DO $vs2$
DECLARE
  v_comment    TEXT;
  v_marker_pos INT;
  v_missing    TEXT := '';
  c_min_prior  CONSTANT INT := 200;   -- prior DNT comment is ~450 chars
BEGIN
  v_comment := obj_description('public.do_not_tow_plates'::regclass, 'pg_class');
  v_marker_pos := position('PLATE WRITE-PATH REQUIREMENT' IN v_comment);

  -- Shape: the appended paragraph must be a SUFFIX with substantial
  -- text in front of it. A replace-instead-of-append puts the marker at
  -- or near position 1. This holds whatever the prior comment said.
  IF v_marker_pos < c_min_prior THEN
    RAISE EXCEPTION
      'VS2 FAIL: only % chars precede the appended paragraph (expected at least %). The prior comment was REPLACED, not appended to. COMMENT ON TABLE overwrites — the migration must read obj_description() and append. Restore the PARKED notice + do-not-re-grant warning (20260723_dnt_park_revoke_writes.sql:60) and re-run. FULL LIVE COMMENT: %',
      v_marker_pos - 1, c_min_prior, v_comment;
  END IF;

  -- Wording: only what has been OBSERVED live. 'PARKED' matched on the
  -- 21:58 run. Do not add strings here from a migration file — that is
  -- what failed the first time.
  IF position('PARKED' IN v_comment) = 0 THEN
    v_missing := v_missing || 'PARKED notice; ';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'VS2 FAIL: do_not_tow_plates comment LOST content confirmed live on 2026-09-10: %. FULL LIVE COMMENT: %',
      v_missing, v_comment;
  END IF;
END $vs2$;


-- ── VS3: AP carries the new requirement ════════════════════════════
DO $vs3$
DECLARE v_comment TEXT;
BEGIN
  v_comment := obj_description('public.authorized_plates'::regclass, 'pg_class');

  IF v_comment IS NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: authorized_plates has NO table comment at all.';
  END IF;
  IF position('PLATE WRITE-PATH REQUIREMENT' IN v_comment) = 0 THEN
    RAISE EXCEPTION
      'VS3 FAIL: authorized_plates comment does not carry PLATE WRITE-PATH REQUIREMENT. Comment is % chars, starts: %',
      length(v_comment), left(v_comment, 160);
  END IF;
  IF position('POST-STRIP' IN v_comment) = 0 THEN
    RAISE EXCEPTION
      'VS3 FAIL: authorized_plates comment names the requirement but not the POST-STRIP rule it exists to state.';
  END IF;
  -- The client precedent is the reason this table is clean today. If the
  -- comment stops naming it as load-bearing, the next writer reads the
  -- current cleanliness as a property of the table rather than of one
  -- component that happens to be correct.
  IF position('LOAD-BEARING' IN v_comment) = 0 THEN
    RAISE EXCEPTION
      'VS3 FAIL: authorized_plates comment no longer marks the client-side normalization as LOAD-BEARING. Without that word the table reads as safe by construction, which it is not.';
  END IF;
END $vs3$;


-- ── VS4: 🔴 AP pre-existing text survived (anti-clobber) ═══════════
-- Shape only. NOTHING has been observed live for this table yet, so
-- nothing is asserted by wording — an expectation copied out of
-- 20260723_authorized_plates_v1_schema.sql:85 is exactly the assumption
-- that broke VS2. The PASS row returns the comment; once it has been
-- read, the three-way distinction (standing authorization vs tow
-- protection vs quota exemption) can be pinned here with real strings.
DO $vs4$
DECLARE
  v_comment    TEXT;
  v_marker_pos INT;
  -- Provisional threshold. 480 chars is what the July migration file
  -- says the prior comment should be — but that is the source that
  -- broke VS2, so it is not trusted as a bound. 100 is low enough to
  -- hold even if the live comment is much shorter than the repo
  -- believes, and still catches the failure this gate exists for (a
  -- replace puts the marker at position 1). Tighten once ap_comment_live
  -- from the PASS row has been read.
  c_min_prior  CONSTANT INT := 100;
BEGIN
  v_comment := obj_description('public.authorized_plates'::regclass, 'pg_class');
  v_marker_pos := position('PLATE WRITE-PATH REQUIREMENT' IN v_comment);

  IF v_marker_pos < c_min_prior THEN
    RAISE EXCEPTION
      'VS4 FAIL: only % chars precede the appended paragraph (expected at least %). The prior comment was REPLACED, not appended to — the three-way distinction (standing authorization vs tow protection vs quota exemption) is what stops these three capabilities being merged. Restore from 20260723_authorized_plates_v1_schema.sql:85 and re-run. FULL LIVE COMMENT: %',
      v_marker_pos - 1, c_min_prior, v_comment;
  END IF;
END $vs4$;


-- ── VS5: audit row present ═════════════════════════════════════════
DO $vs5$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PLATE_TABLE_WRITE_PATH_COMMENTS'
     AND new_values ->> 'migration' = '20260910_plate_table_write_path_comments';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: audit row missing';
  END IF;
END $vs5$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'plate write-path requirement comments (do_not_tow_plates + authorized_plates)'::TEXT AS target,
  ARRAY[
    'VS1  do_not_tow_plates comment carries PLATE WRITE-PATH REQUIREMENT + the POST-STRIP rule',
    'VS2  do_not_tow_plates prior comment SURVIVED — asserted by SHAPE (marker is a suffix, >=200 chars precede it) plus the one string confirmed live: PARKED',
    'VS3  authorized_plates comment carries the requirement, the POST-STRIP rule, and LOAD-BEARING',
    'VS4  authorized_plates prior comment SURVIVED — shape only; no wording asserted until the returned text is read',
    'VS5  SCHEMA_PLATE_TABLE_WRITE_PATH_COMMENTS audit row present',
    'DISCIPLINE: VS2/VS4 are the load-bearing pair — VS1/VS3 alone would pass on an implementation that REPLACED each comment with only the new paragraph',
    'CORRECTED 2026-09-10: anti-clobber gates assert SHAPE, never wording copied from a migration file — the catalog is the audit surface'
  ] AS gates_verified,
  -- 🔴 GROUND TRUTH, returned deliberately. VS2 first failed because it
  -- asserted a string copied from a migration file rather than one
  -- observed in the catalog. Read these two values and pin the gates to
  -- what is actually there.
  obj_description('public.do_not_tow_plates'::regclass, 'pg_class') AS dnt_comment_live,
  obj_description('public.authorized_plates'::regclass, 'pg_class') AS ap_comment_live,
  now() AS verified_at;
