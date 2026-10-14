-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — cascade stamps
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT.
--
-- 🔴 THE FIRST VERSION OF THIS FILE DID ITS JOB AND FAILED THE
-- MIGRATION. It asserted a column REVOKE from pg_attribute.attacl and
-- got NULL for all three columns — because a column-level REVOKE
-- CANNOT SUBTRACT FROM A TABLE-LEVEL GRANT. `authenticated` holds
-- UPDATE on all of user_roles, so REVOKE UPDATE(col) recorded nothing;
-- attacl stayed NULL, which means "default privileges apply", which
-- means writable. The REVOKE looked installed and did nothing.
--
-- It was caught only because the gate treated attacl IS NULL as a
-- FAILURE rather than an absence. Had it read NULL as "no grant
-- recorded, therefore not granted", it would have passed a wide-open
-- column — the absence-as-answer trap, in the gate rather than the
-- product.
--
-- The guard is now a SECURITY INVOKER trigger, and what this file
-- proves is that it REFUSES BY EXECUTION, not that its text exists.

DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_n    INT;
  v_col  TEXT;
BEGIN

  -- ── G1. The three columns, nullable ───────────────────────────────
  FOREACH v_col IN ARRAY ARRAY['cascade_deactivated_by_property','cascade_deactivated_run','cascade_deactivated_at']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid='public.user_roles'::regclass AND attname=v_col
                      AND attnum>0 AND NOT attisdropped) THEN
      v_fail := array_append(v_fail, format('G1: user_roles.%s is missing', v_col));
      CONTINUE;
    END IF;
    -- NOT NULL would be wrong: the absence of a stamp is the meaningful
    -- "unknown provenance" state, and every pre-existing row has it.
    IF (SELECT attnotnull FROM pg_attribute
         WHERE attrelid='public.user_roles'::regclass AND attname=v_col) THEN
      v_fail := array_append(v_fail, format('G1a: user_roles.%s is NOT NULL — an unstamped row is the point', v_col));
    END IF;

    -- ── G2. The trigger must be scoped to THIS column ───────────────
    -- `UPDATE OF` is what keeps the guard inert for the 8 existing
    -- user_roles writers, none of which touches these columns.
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr)
       WHERE t.tgrelid = 'public.user_roles'::regclass
         AND t.tgname = 'user_roles_cascade_stamp_guard_trigger'
         AND a.attname = v_col) THEN
      v_fail := array_append(v_fail, format(
        'G2: the guard trigger is not scoped UPDATE OF %s, so a write to that column would not fire it', v_col));
    END IF;
  END LOOP;

  -- ── G2b. The guard exists, and is NOT DEFINER ─────────────────────
  -- 🔴 As DEFINER current_user would be the OWNER, so the guard would
  -- read `postgres` for every caller and permit everything while
  -- looking perfectly installed.
  IF to_regprocedure('public.user_roles_cascade_stamp_guard()') IS NULL THEN
    v_fail := array_append(v_fail, 'G2b: user_roles_cascade_stamp_guard() is missing');
  ELSE
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.user_roles_cascade_stamp_guard()')) THEN
      v_fail := array_append(v_fail, 'G2c: 🔴 the guard is SECURITY DEFINER — current_user would be the owner, so it permits everything while looking installed');
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.user_roles_cascade_stamp_guard()'))
         !~ 'current_user <> ''authenticated''' THEN
      v_fail := array_append(v_fail, 'G2d: the guard does not exempt non-authenticated callers by current_user — service_role and every DEFINER RPC would be refused');
    END IF;
  END IF;

  -- ── G3. 🔴 EXECUTION, BOTH WAYS, ON A PROBE ROW ───────────────────
  -- Reading the trigger proves it is installed, not that it refuses.
  -- Same shape as the companies guard's G4c: a temporary permissive
  -- policy so RLS cannot refuse FIRST and make this pass for the wrong
  -- reason, then SET LOCAL ROLE authenticated and try the write.
  DECLARE
    v_probe TEXT := 'zz-stampguard-' || extract(epoch from now())::BIGINT || '@test.invalid';
    v_id    BIGINT;
    v_msg   TEXT;
    v_rows  INT;
    v_prop  BIGINT;
  BEGIN
    SELECT id INTO v_prop FROM public.properties WHERE is_active ORDER BY id LIMIT 1;
    INSERT INTO public.user_roles (email, role, company, property, is_active)
    VALUES (v_probe, 'manager', 'Test-LEGACY', ARRAY['Test Legacy Property'], TRUE)
    RETURNING id INTO v_id;

    -- 3a. the OWNER (and so service_role, and every DEFINER RPC) passes.
    -- A guard that catches the writer is a feature nobody can use: the
    -- cascade would silently stop stamping and reactivation would skip
    -- every user forever.
    BEGIN
      UPDATE public.user_roles SET cascade_deactivated_by_property = v_prop WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN
      v_fail := array_append(v_fail, format('G3a: 🔴 the guard refused the OWNER (%s) — the cascade could never stamp anything', SQLERRM));
    END;

    -- 3b. an `authenticated` session is refused.
    --
    -- 🔴 TWO TEMP POLICIES, NOT ONE. The first version created only
    -- FOR UPDATE and the gate reported 0 rows — correctly refusing to
    -- call that a pass. The cause: for `UPDATE … WHERE`, PostgreSQL
    -- requires SELECT privilege and APPLIES THE SELECT POLICIES, and
    -- under SET LOCAL ROLE authenticated there is no JWT, so no
    -- email- or company-scoped SELECT policy on user_roles matches the
    -- probe row. The row was INVISIBLE, not protected — and an
    -- invisible row and a guarded one produce the same 0.
    --
    -- So visibility is established first and asserted SEPARATELY,
    -- because "authenticated could not see the row" and "the guard
    -- refused the write" are different outcomes that must not share a
    -- diagnosis.
    BEGIN
      CREATE POLICY zz_tmp_stamp_select ON public.user_roles
        FOR SELECT TO authenticated USING (TRUE);
      CREATE POLICY zz_tmp_stamp_update ON public.user_roles
        FOR UPDATE TO authenticated USING (TRUE) WITH CHECK (TRUE);

      -- Visibility first. If this is 0 the gate says so plainly rather
      -- than blaming the guard.
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_rows FROM public.user_roles WHERE id = v_id;
      RESET ROLE;
      IF v_rows <> 1 THEN
        v_fail := array_append(v_fail, format(
          'G3b-pre: an authenticated session cannot SEE the probe row (%s visible), so the write below would return 0 for the wrong reason. The temp SELECT policy did not take. NOT a pass.', v_rows));
      END IF;

      SET LOCAL ROLE authenticated;
      v_msg := NULL; v_rows := -1;
      BEGIN
        UPDATE public.user_roles SET cascade_deactivated_by_property = NULL WHERE id = v_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      RESET ROLE;

      IF v_msg IS DISTINCT FROM 'cascade_stamp_not_permitted' THEN
        IF v_msg IS NULL AND v_rows = 0 THEN
          v_fail := array_append(v_fail, 'G3b: the UPDATE matched 0 rows and raised nothing. With G3b-pre passing, the row WAS visible, so this is the UPDATE policy failing to take — the guard was still NOT exercised. Do not accept this as a pass.');
        ELSIF v_msg IS NULL THEN
          v_fail := array_append(v_fail, format('G3b: 🔴 THE GUARD DID NOT FIRE. An authenticated session cleared the provenance (%s row(s)) — which is exactly the hole it exists for.', v_rows));
        ELSE
          v_fail := array_append(v_fail, format('G3b: expected cascade_stamp_not_permitted, got %L', v_msg));
        END IF;
      END IF;

      -- 3c. and a write that changes NOTHING must still pass, or an
      -- ordinary client sending the column with its existing value is
      -- refused for no reason.
      SET LOCAL ROLE authenticated;
      v_msg := NULL;
      BEGIN
        UPDATE public.user_roles SET cascade_deactivated_by_property = v_prop WHERE id = v_id;
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      RESET ROLE;
      IF v_msg IS NOT NULL THEN
        v_fail := array_append(v_fail, format('G3c: the guard refused a no-change write (%L) — it must fire only when a stamp actually changes', v_msg));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      v_fail := array_append(v_fail, format('G3b: the execution gate itself failed: %s', SQLERRM));
    END;

    DROP POLICY IF EXISTS zz_tmp_stamp_select ON public.user_roles;
    DROP POLICY IF EXISTS zz_tmp_stamp_update ON public.user_roles;
    DELETE FROM public.user_roles WHERE id = v_id;
    IF EXISTS (SELECT 1 FROM public.user_roles WHERE id = v_id) THEN
      v_fail := array_append(v_fail, format('G3d: the probe row %s was NOT removed', v_id));
    END IF;

    -- 🔴 And the temp policies must be GONE. A leftover
    -- USING(TRUE) FOR SELECT TO authenticated on user_roles would let
    -- every signed-in user read every role row in the system — far
    -- worse than the hole this gate was testing for.
    IF EXISTS (SELECT 1 FROM pg_policy
                WHERE polrelid='public.user_roles'::regclass
                  AND polname LIKE 'zz_tmp_stamp%') THEN
      -- Accurate about the blast radius: this file's terminal RAISE
      -- aborts the DO block, and the CREATE POLICY went in the same
      -- transaction, so a reported failure here is ALSO rolled back.
      -- The check earns its place as the one that would notice if that
      -- stopped being true — and the DROPs below are the fallback if a
      -- future edit ever commits mid-block.
      v_fail := array_append(v_fail, '🔴 G3e: a zz_tmp_stamp policy is still present at the end of the block. The failure below rolls this transaction back, so it should disappear with it — but CONFIRM, because a surviving USING(TRUE) FOR SELECT TO authenticated on user_roles would let every signed-in user read every role row in the system. Confirm with: SELECT polname FROM pg_policy WHERE polrelid = ''public.user_roles''::regclass AND polname LIKE ''zz_tmp_stamp%'';');
    END IF;
  END;

  -- ── G4. The FK direction ──────────────────────────────────────────
  -- ON DELETE SET NULL, so losing the property loses the provenance and
  -- the row falls to SKIP. CASCADE would delete the user_roles row and
  -- RESTRICT would block deleting a property — both wrong.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.user_roles'::regclass AND c.contype='f'
       AND c.confrelid='public.properties'::regclass
       AND c.confdeltype='n') THEN
    v_fail := array_append(v_fail, format(
      'G4: the FK to properties is not ON DELETE SET NULL (confdeltype=%s). Losing a property must fail toward "leave them deactivated", never toward "restore them".',
      (SELECT string_agg(c.confdeltype::TEXT, ',') FROM pg_constraint c
        WHERE c.conrelid='public.user_roles'::regclass AND c.contype='f'
          AND c.confrelid='public.properties'::regclass)));
  END IF;

  -- ── G5. Nothing is stamped yet ────────────────────────────────────
  SELECT count(*) INTO v_n FROM public.user_roles WHERE cascade_deactivated_by_property IS NOT NULL;
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G5: %s rows are already stamped before the route exists — somebody wrote them another way', v_n));
  END IF;

  -- ── G6. The deactivated rows are all unstamped, as ruled ──────────
  SELECT count(*) INTO v_n FROM public.user_roles
   WHERE is_active IS NOT TRUE AND cascade_deactivated_by_property IS NULL;
  IF v_n <> (SELECT count(*) FROM public.user_roles WHERE is_active IS NOT TRUE) THEN
    v_fail := array_append(v_fail, 'G6: some pre-existing deactivated row carries a stamp it cannot have earned');
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'CASCADE STAMPS VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

SELECT 'PASS — cascade stamps' AS result,
       (SELECT count(*) FROM pg_attribute
         WHERE attrelid='public.user_roles'::regclass
           AND attname LIKE 'cascade_deactivated%' AND attnum>0 AND NOT attisdropped) AS columns_want_3,
       (SELECT count(DISTINCT a.attname) FROM pg_trigger t
          JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr)
         WHERE t.tgrelid='public.user_roles'::regclass
           AND t.tgname='user_roles_cascade_stamp_guard_trigger')                AS guard_scoped_columns_want_3,
       (SELECT NOT prosecdef FROM pg_proc
         WHERE oid=to_regprocedure('public.user_roles_cascade_stamp_guard()'))   AS guard_is_invoker_want_true,
       (SELECT count(*) FROM public.user_roles WHERE cascade_deactivated_by_property IS NOT NULL) AS stamped_want_0,
       (SELECT count(*) FROM public.user_roles WHERE is_active IS NOT TRUE) AS deactivated_all_unstamped_so_all_skipped,
       '🔴 these 4 will be SKIPPED by any reactivation — "deactivated separately", as ruled' AS note;
