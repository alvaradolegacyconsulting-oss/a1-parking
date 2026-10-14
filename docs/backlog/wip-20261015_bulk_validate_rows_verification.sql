-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — bulk_validate_rows
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT, so the terminal SELECT returns the PASS
-- row.
--
-- 🔴 WHAT THIS FILE CANNOT CATCH, AND WHO CATCHES IT.
-- A RETURNS TABLE function whose output column types do not match its
-- SELECT list raises 42804 — at CALL time, not at CREATE time. So a
-- structural gate can be green on a function that cannot run. This file
-- therefore calls it (G4), but the call lands on the authority check
-- and raises property_not_in_scope before the query body is ever
-- reached, because this session has no JWT and no company has the flag
-- on. That proves the function runs; it does NOT prove the eight output
-- columns line up.
--
-- The body is only reached with a real company_admin JWT, which is
-- npm run verify:bulkvalidate — it creates the CA, turns the flag on
-- for the test tenant, calls the RPC with a real file, asserts all
-- eight columns, and restores the flag. 🔴 That gate is mandatory
-- before the preview route ships; this one is not sufficient.

DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_fn   OID;
  v_res  TEXT;
  v_sql  TEXT;
  v_msg  TEXT;
  v_st   TEXT;
BEGIN

  -- ── G1. The function exists, with this exact signature ────────────
  -- to_regprocedure, because parameter type MODIFIERS are stripped
  -- from pg_proc and a name-only check would match a different arity.
  v_fn := to_regprocedure('public.bulk_validate_rows(bigint,jsonb)');
  IF v_fn IS NULL THEN
    v_fail := array_append(v_fail, 'G1: bulk_validate_rows(bigint,jsonb) is missing');
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
      v_fail := array_append(v_fail, 'G1a: not SECURITY DEFINER — the preview would then run under the caller''s RLS and under-report conflicts');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                     AND array_to_string(proconfig,',') ~ 'search_path=[^,]*\mpublic\M'
                     AND array_to_string(proconfig,',') ~ '\mpg_temp\M') THEN
      v_fail := array_append(v_fail, 'G1b: search_path is not pinned');
    END IF;

    -- ── G2. Grants ──────────────────────────────────────────────────
    IF has_function_privilege('anon','public.bulk_validate_rows(bigint,jsonb)','EXECUTE') THEN
      v_fail := array_append(v_fail, 'G2a: 🔴 anon holds EXECUTE');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
      v_fail := array_append(v_fail, 'G2b: 🔴 PUBLIC holds a grant (the Supabase DEFINER default)');
    END IF;
    IF NOT has_function_privilege('authenticated','public.bulk_validate_rows(bigint,jsonb)','EXECUTE') THEN
      v_fail := array_append(v_fail, 'G2c: authenticated cannot EXECUTE — no CA could preview');
    END IF;

    -- ── G3. The output shape, column by column ──────────────────────
    -- Asserted here precisely BECAUSE a mismatch against the SELECT
    -- list surfaces as 42804 at call time, which the execution gate
    -- below cannot reach.
    SELECT pg_get_function_result(v_fn) INTO v_res;
    FOR v_sql IN SELECT unnest(ARRAY[
      'row_index integer', 'plate_norm text', 'plate_active_here boolean',
      'plate_active_other boolean', 'other_property text',
      'plate_prohibited boolean', 'resident_exists boolean', 'resident_active boolean'])
    LOOP
      IF position(v_sql IN v_res) = 0 THEN
        v_fail := array_append(v_fail, format('G3: output column %L is not in the result type (%s)', v_sql, v_res));
      END IF;
    END LOOP;

    -- ── G4. 🔴 The authority gate comes FIRST, and it runs ──────────
    -- With no JWT may_bulk_upload_at() is FALSE, so a call must raise
    -- property_not_in_scope. Two things are proven: the function
    -- executes rather than failing to compile, and it refuses before
    -- touching resident data. A function that returned rows here would
    -- be handing a file's worth of plates to an unauthenticated
    -- session.
    BEGIN
      PERFORM * FROM public.bulk_validate_rows(
        (SELECT id FROM public.properties WHERE is_active ORDER BY id LIMIT 1),
        '[{"i":0,"email":"zz-probe@test.invalid","plate":"ZZPROBE1"}]'::jsonb);
      v_fail := array_append(v_fail, 'G4: 🔴 the RPC RETURNED ROWS with no JWT — the authority gate is not reached');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_st = RETURNED_SQLSTATE;
      -- MESSAGE_TEXT, not sqlstate: P0001 is raised by every RAISE in
      -- the codebase, so the state alone cannot tell this refusal from
      -- an unrelated one.
      IF v_msg <> 'property_not_in_scope' THEN
        v_fail := array_append(v_fail, format('G4: expected property_not_in_scope, got %s / %s', v_st, v_msg));
      END IF;
    END;

    -- ── G5. The predicates are the INDEX's predicates ───────────────
    -- The active-plate check must mirror vehicles_plate_norm_uniq, and
    -- the index is the thing that will actually refuse the load. If the
    -- index ever changes, this gate fails and the RPC has to follow.
    IF NOT EXISTS (
      SELECT 1 FROM pg_index ix
       WHERE ix.indexrelid = 'public.vehicles_plate_norm_uniq'::regclass
         AND pg_get_expr(ix.indpred, ix.indrelid) ~ '\mis_active\M'
         AND pg_get_expr(ix.indpred, ix.indrelid) ~ '\munder_review\M'
         AND pg_get_indexdef(ix.indexrelid) ~ '\mnormalize_plate\M'
         AND pg_get_indexdef(ix.indexrelid) ~ '\mproperty\M') THEN
      v_fail := array_append(v_fail,
        format('G5: 🔴 vehicles_plate_norm_uniq is not the index the RPC was written against. def=%s pred=%s',
          (SELECT pg_get_indexdef('public.vehicles_plate_norm_uniq'::regclass)),
          (SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid='public.vehicles_plate_norm_uniq'::regclass)));
    END IF;
    -- And the RPC must actually say so, in both halves.
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_fn) !~ '\munder_review\M' THEN
      v_fail := array_append(v_fail, 'G5a: the RPC does not test status under_review — it would miss conflicts the index will raise');
    END IF;
    -- Exactly two, named: the EXISTS for this property, and the
    -- LATERAL for the sibling properties. An exact count is the point
    -- — a third vehicle-matching site with a looser predicate would
    -- hide behind a >= check, and this gate has already caught one.
    IF (SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_fn), 'under_review', 'g')) <> 2 THEN
      v_fail := array_append(v_fail, format('G5b: under_review appears %s times in the RPC; want exactly 2 — the EXISTS for this property and the LATERAL for the sibling properties. More means a third place matches vehicles and its predicate is unruled.',
        (SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_fn), 'under_review', 'g'))));
    END IF;

    -- ── G5c. 🔴 The sibling flag and the sibling NAME are one answer ─
    -- They were two: an EXISTS for the boolean and a scalar subquery
    -- for the name, each carrying its own copy of the index predicate.
    -- That is what made under_review appear three times. A LATERAL
    -- makes the boolean the name's presence, so they cannot disagree
    -- and the predicate exists once.
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_fn) !~ 'LEFT JOIN LATERAL' THEN
      v_fail := array_append(v_fail, 'G5c: the sibling check is not a LATERAL — plate_active_other and other_property are being derived separately');
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_fn) !~ 'other\.property IS NOT NULL' THEN
      v_fail := array_append(v_fail, 'G5d: plate_active_other is not derived from other.property — the flag and the name can disagree');
    END IF;

    -- ── G6. 🔴 No TypeScript-side normalizer crept in ───────────────
    -- The whole reason this RPC exists. Two calls to normalize_plate on
    -- the vehicles side plus one on the input.
    -- Exactly three: the input key, this property, the siblings. Not
    -- ">= 3" — a fourth call is a fourth place the key is derived, and
    -- the whole reason this RPC exists is that the key has one source.
    IF (SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_fn), 'normalize_plate', 'g')) <> 3 THEN
      v_fail := array_append(v_fail, format('G6: normalize_plate appears %s times; want exactly 3 (the input key, this property, the sibling LATERAL)',
        (SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = v_fn), 'normalize_plate', 'g'))));
    END IF;

    -- ── G7. The sibling scope is company-bounded ────────────────────
    -- "Active at another property" must not name another operator's
    -- property. An error message is a disclosure channel.
    IF (SELECT prosrc FROM pg_proc WHERE oid = v_fn) !~ '\mv_company\M' THEN
      v_fail := array_append(v_fail, 'G7: 🔴 the sibling-property scope does not reference the company — cross-tenant disclosure');
    END IF;
  END IF;

  -- ── G8. The helper it depends on is still there ───────────────────
  IF to_regprocedure('public.may_bulk_upload_at(bigint)') IS NULL THEN
    v_fail := array_append(v_fail, 'G8: may_bulk_upload_at(bigint) is missing — the RPC''s authority gate cannot work');
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'BULK_VALIDATE_ROWS VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

SELECT 'PASS — bulk_validate_rows'                                                       AS result,
       (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.bulk_validate_rows(bigint,jsonb)')) AS is_definer,
       has_function_privilege('anon','public.bulk_validate_rows(bigint,jsonb)','EXECUTE') AS anon_execute_want_false,
       (SELECT count(*) FROM regexp_matches(
          (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.bulk_validate_rows(bigint,jsonb)')),
          'normalize_plate','g'))                                                        AS normalize_plate_calls,
       (SELECT pg_get_expr(indpred, indrelid) FROM pg_index
         WHERE indexrelid='public.vehicles_plate_norm_uniq'::regclass)                    AS index_predicate_mirrored,
       '🔴 npm run verify:bulkvalidate still required — the query body is only reached with a real JWT (42804 class)' AS next;
