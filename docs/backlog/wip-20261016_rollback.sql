-- ════════════════════════════════════════════════════════════════════
-- SAME-DAY ROLLBACK — all or nothing, and it refuses rather than guess
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-16. Apply after wip-20261016_loader.sql.
--
-- Paired: wip-20261016_rollback_verification.sql
-- Execution half: npm run verify:rollback  (on batch 8)
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block and Run ONCE.
--
-- ── 🔴 "SAME DAY" MEANS THE PROPERTY'S DAY, NOT THE SERVER'S ────────
-- The database session is UTC and the business is in Texas. A batch
-- loaded at 8pm Central Monday is 02:00 UTC Tuesday, so CURRENT_DATE
-- would refuse to roll it back at 9pm Central on the same Monday
-- evening — the operator watching the mistake happen.
--
-- The codebase already settled this: public.current_date_central(),
-- added 2026-08-05 after exactly this class of bug in the guest-auth
-- window. It is (now() AT TIME ZONE 'America/Chicago')::date, and it
-- has no GRANT to authenticated because only DEFINER callers use it.
-- This function is one. Using it rather than inventing a second
-- convention is the point.
--
-- ── 🔴 WHY A CLAIMED RESIDENT STOPS THE WHOLE ROLLBACK ──────────────
-- Ruled: refuse if any resident in the batch has an auth account, list
-- them, and roll nothing back. That is not a limitation — it is what
-- makes the rest sound.
--
-- A resident who has claimed has an auth account, and auth is the one
-- thing no transaction can undo. Deleting their role row would leave a
-- login with no role, which is the blank portal; leaving it would leave
-- a role row pointing at a property whose records are gone. Refusing
-- avoids choosing between two wrong answers.
--
-- It also closes a question the loader gate raised. A role row created
-- by the CLAIM carries no import_batch_id, so rollback could not find
-- it by the stamp — but for a loaded resident the claim never creates
-- one, because the loader already did and the claim reuses it. The only
-- way an unstamped role row exists for a batch resident is if they
-- claimed, and this refusal is exactly that case. Both problems close
-- with one rule.
--
-- ── 🔴 DEPENDENTS ARE DISCOVERED, NOT LISTED ────────────────────────
-- The ruling says refuse if any batch row has dependents "in the 9
-- referencing tables". A hardcoded list of nine would silently miss the
-- tenth, and the repo is not the audit surface — an FK added from the
-- dashboard never enters it, which is why the list could not be
-- confirmed from here at all.
--
-- So the check walks pg_constraint for every FK pointing at residents
-- or vehicles and tests each one dynamically. It cannot miss a
-- referencing table, including one added after this was written. Part 0
-- PRINTS what it found so the number can be compared with the nine; if
-- they differ, the discovered set is the true one.
--
-- A dependent is refused whatever its ON DELETE action. CASCADE would
-- destroy a row that is not the batch's; SET NULL would quietly
-- detach one; RESTRICT would abort halfway. None of those is an undo.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — sweep, and the dependent map printed
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE
  v_n INT;
  v_s TEXT;
  r   RECORD;
BEGIN
  IF to_regprocedure('public.load_import_batch(bigint, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'sweep: the loader is absent. There is nothing to roll back.';
  END IF;
  IF to_regprocedure('public.current_date_central()') IS NULL THEN
    RAISE EXCEPTION 'sweep: current_date_central() is absent. Same-day must mean the property''s day, and that helper is the established answer.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass, 'public.user_roles'::regclass)
     AND attname = 'import_batch_id' AND NOT attisdropped;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'sweep: import_batch_id is on % of 3 tables. Rollback deletes by it.', v_n;
  END IF;

  -- 🔴 EVERY FK POINTING AT THE TWO DATA TABLES, DISCOVERED AND
  -- PRINTED. Compare the count with the nine in the ruling.
  v_n := 0;
  FOR r IN
    SELECT con.conname,
           (con.confrelid::regclass)::TEXT AS target,
           (con.conrelid::regclass)::TEXT  AS referencing,
           a.attname                       AS fk_column,
           con.confdeltype                 AS on_delete,
           array_length(con.conkey, 1)     AS cols
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND con.confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)
     ORDER BY 2, 3
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE 'dependent %: %.% → % (on delete %, % column(s))',
      v_n, r.referencing, r.fk_column, r.target, r.on_delete, r.cols;
    -- 🔴 A COMPOSITE FK WOULD BE HALF-CHECKED BY conkey[1]. Refuse
    -- rather than test one column of two and report "no dependents".
    IF r.cols <> 1 THEN
      RAISE EXCEPTION 'sweep: % is a %-column foreign key. The dependent check reads conkey[1] only and would half-check it.', r.conname, r.cols;
    END IF;
  END LOOP;
  RAISE NOTICE 'sweep: % foreign key(s) reference residents or vehicles. The ruling said 9 — if this differs, the discovered set is the true one and the function checks all of them dynamically.', v_n;
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — the rollback
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rollback_import_batch(p_batch_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid       UUID;
  v_status    TEXT;
  v_loaded_at TIMESTAMPTZ;
  v_res_n     INT;
  v_veh_n     INT;
  v_role_n    INT;
  v_claimed   JSONB;
  v_claimed_n INT;
  v_dep       RECORD;
  v_sql       TEXT;
  v_hits      BIGINT;
  v_blockers  JSONB := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_caller_identity',
      'detail', 'A rollback records who did it. A call with no auth.uid() cannot.');
  END IF;

  SELECT status, loaded_at INTO v_status, v_loaded_at
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;
  IF v_status <> 'loaded' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status', 'status', v_status,
      'detail', 'Only a loaded batch can be rolled back.');
  END IF;

  -- ── 🔴 the property's day, not the server's ──────────────────────
  IF v_loaded_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_load_time',
      'detail', 'This batch is marked loaded with no load time, so same-day cannot be decided. Do not roll it back without looking at it.');
  END IF;
  IF (v_loaded_at AT TIME ZONE 'America/Chicago')::date <> public.current_date_central() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_same_day',
      'loaded_on', (v_loaded_at AT TIME ZONE 'America/Chicago')::date,
      'today',     public.current_date_central(),
      'detail', 'Rollback is same-day only. This batch was loaded on an earlier day, and residents have had time to use it — removing their records now would take away access they have been relying on.');
  END IF;

  -- ── 🔴 anyone who has claimed stops the whole rollback ───────────
  -- Listed, not counted: the operator has to be able to see who, and
  -- "3 residents have logins" is not something anyone can act on.
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('email', t.email, 'unit', t.unit)
                                      ORDER BY t.unit, t.email), '[]'::jsonb)
    INTO v_claimed_n, v_claimed
    FROM (
      SELECT r.email, r.unit
        FROM public.residents r
        JOIN auth.users u ON lower(btrim(u.email)) = lower(btrim(r.email))
       WHERE r.import_batch_id = p_batch_id
       LIMIT 200
    ) t;
  IF v_claimed_n > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_claimed',
      'claimed_count', v_claimed_n, 'claimed', v_claimed,
      'detail', 'Residents in this batch have already set up logins. A login is not something a rollback can take back — deleting their role row would leave them signed in with no access, and deleting the account is not part of an undo. Deactivate the ones that should not be there instead.');
  END IF;

  -- ── 🔴 dependents, discovered rather than listed ─────────────────
  FOR v_dep IN
    SELECT (con.conrelid::regclass)::TEXT  AS referencing,
           (con.confrelid::regclass)::TEXT AS target,
           a.attname                       AS fk_column,
           con.conname                     AS fk_name,
           EXISTS (SELECT 1 FROM pg_attribute ia
                    WHERE ia.attrelid = con.conrelid
                      AND ia.attname = 'import_batch_id'
                      AND NOT ia.attisdropped) AS has_stamp
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND con.confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)
       AND array_length(con.conkey, 1) = 1
  LOOP
    -- A referencing row that is ITSELF part of this batch is not a
    -- dependent; it is going too. Only tables that carry the stamp can
    -- be excluded that way, which is why the flag is computed above.
    v_sql := format(
      'SELECT count(*) FROM %s d WHERE d.%I IN (SELECT id FROM %s WHERE import_batch_id = $1)%s',
      v_dep.referencing, v_dep.fk_column, v_dep.target,
      CASE WHEN v_dep.has_stamp THEN ' AND d.import_batch_id IS DISTINCT FROM $1' ELSE '' END);
    EXECUTE v_sql INTO v_hits USING p_batch_id;
    IF v_hits > 0 THEN
      v_blockers := v_blockers || jsonb_build_object(
        'table', v_dep.referencing, 'column', v_dep.fk_column,
        'references', v_dep.target, 'rows', v_hits, 'constraint', v_dep.fk_name);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'has_dependents',
      'blockers', v_blockers,
      'detail', 'Other records now point at rows this batch created — a pass, a violation, a space assignment. Removing the batch would destroy or orphan them, and that is not an undo. Deal with those records first.');
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- 🔴 ONE UNIT. The deletes and the status change share an EXCEPTION
  -- block, so a failure anywhere rolls back every delete AND leaves the
  -- batch 'loaded' — the same structure as the loader, for the same
  -- reason. A half-undone load is worse than one that is still there.
  -- ══════════════════════════════════════════════════════════════════
  BEGIN
    -- Vehicles first: nothing references them from residents, but
    -- deleting the narrower set first keeps any future FK honest.
    DELETE FROM public.vehicles WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_veh_n = ROW_COUNT;
    DELETE FROM public.user_roles WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_role_n = ROW_COUNT;
    DELETE FROM public.residents WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_res_n = ROW_COUNT;

    UPDATE public.import_batches
       SET status = 'rolled_back'
     WHERE id = p_batch_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN jsonb_build_object('ok', false, 'error', 'has_dependents',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Something references a row this batch created that the pre-flight did not find. Nothing was removed and the batch is still loaded.');
    WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'error', 'rollback_failed',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Nothing was removed and the batch is still loaded. It can be retried.');
  END;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', 'rolled_back',
    'residents', v_res_n, 'vehicles', v_veh_n, 'roles', v_role_n, 'rolled_back_by', v_uid);
END
$fn$;

COMMENT ON FUNCTION public.rollback_import_batch(BIGINT) IS
  'Same-day undo of a loaded bulk-onboarding batch, in ONE transaction: deletes vehicles, the stamped role rows and residents by import_batch_id and sets status rolled_back. Active-admin only, FOR UPDATE, loaded-only. 🔴 Same-day means the PROPERTY''S day via current_date_central(), not CURRENT_DATE — the session is UTC and a batch loaded at 8pm Central would otherwise be unrollbackable an hour later. 🔴 REFUSES ENTIRELY if any resident has an auth account, listing them: a login is the one thing no transaction can undo, and that refusal also closes the unstamped-role-row question, because a claim only creates a role row when the loader did not. 🔴 Dependents are DISCOVERED from pg_constraint rather than listed, so no referencing table can be missed — including one added after this was written — and a dependent is refused whatever its ON DELETE action, because CASCADE destroys a row that is not the batch''s and SET NULL quietly detaches one. The deletes and the status change share one EXCEPTION block: a failure leaves the batch loaded and nothing removed. The audit trigger records the transition.';

REVOKE ALL ON FUNCTION public.rollback_import_batch(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rollback_import_batch(BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.rollback_import_batch(BIGINT) TO authenticated;

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'rollback' AS migration,
  to_regprocedure('public.rollback_import_batch(bigint)')::TEXT AS rollback_fn,
  (SELECT count(*)::INT FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass))
    AS fks_referencing_residents_or_vehicles,
  public.current_date_central() AS today_central,
  'execution half: npm run verify:rollback' AS and_then;
