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
-- paragraph, the PARKED notice and the do-not-re-grant warning would be
-- gone and nothing else would notice.
DO $vs2$
DECLARE
  v_comment TEXT;
  v_missing TEXT := '';
BEGIN
  v_comment := obj_description('public.do_not_tow_plates'::regclass, 'pg_class');

  IF position('PARKED' IN v_comment) = 0 THEN
    v_missing := v_missing || 'PARKED notice; ';
  END IF;
  IF position('Do not re-grant' IN v_comment) = 0 THEN
    v_missing := v_missing || 'do-not-re-grant INSERT/UPDATE warning; ';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'VS2 FAIL: do_not_tow_plates comment LOST pre-existing content: %. COMMENT ON TABLE replaces rather than appends — the migration must read obj_description() and append. Restore from 20260723_dnt_park_revoke_writes.sql:60 before re-running.',
      v_missing;
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
DO $vs4$
DECLARE
  v_comment TEXT;
  v_missing TEXT := '';
BEGIN
  v_comment := obj_description('public.authorized_plates'::regclass, 'pg_class');

  IF position('Standing authorization' IN v_comment) = 0 THEN
    v_missing := v_missing || 'Standing authorization definition; ';
  END IF;
  IF position('do_not_tow_plates' IN v_comment) = 0 THEN
    v_missing := v_missing || 'NOT-tow-protection distinction; ';
  END IF;
  IF position('exempt_plates' IN v_comment) = 0 THEN
    v_missing := v_missing || 'NOT-quota-exemption distinction; ';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'VS4 FAIL: authorized_plates comment LOST pre-existing content: %. The three-way distinction (standing authorization vs tow protection vs quota exemption) is the thing that stops these three capabilities being merged. Restore from 20260723_authorized_plates_v1_schema.sql:85 before re-running.',
      v_missing;
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
    'VS2  do_not_tow_plates PARKED notice + do-not-re-grant warning SURVIVED (anti-clobber)',
    'VS3  authorized_plates comment carries the requirement, the POST-STRIP rule, and LOAD-BEARING',
    'VS4  authorized_plates three-way distinction SURVIVED (anti-clobber)',
    'VS5  SCHEMA_PLATE_TABLE_WRITE_PATH_COMMENTS audit row present',
    'DISCIPLINE: VS2/VS4 are the load-bearing pair — VS1/VS3 alone would pass on an implementation that REPLACED each comment with only the new paragraph'
  ] AS gates_verified,
  now() AS verified_at;
