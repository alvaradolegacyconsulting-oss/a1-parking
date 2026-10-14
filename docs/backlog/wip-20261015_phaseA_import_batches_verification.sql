-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Phase A schema: import_batches + the batch stamp
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 THE WRITER LIST IS THE POSITIVE-CONTROL LIST (binding lesson from
-- Stage 1c, where a guard shipped against a verb nobody enumerated and
-- broke two live paths). The guard here sits on two tables with 41
-- existing write sites, so most of this file proves it is INERT.
--
-- The six representative paths are exercised with real sessions in
-- `npm run verify:importbatches`, because four of them need a JWT.
-- What SQL can prove is asserted here.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_stamp TEXT := to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  v_co    BIGINT; v_prop BIGINT; v_pname TEXT; v_cname TEXT;
  v_batch BIGINT;
  v_vid   BIGINT;
  v_msg   TEXT;
  v_n     INT;
BEGIN
  -- ── G1: the table, its constraints, and NO write policy ───────────
  IF to_regclass('public.import_batches') IS NULL THEN
    v_fail := v_fail || 'G1: import_batches does not exist';
  ELSE
    SELECT count(*) INTO v_n FROM pg_policy
     WHERE polrelid='public.import_batches'::regclass AND polcmd <> 'r';
    IF v_n > 0 THEN
      v_fail := v_fail || format('G1: 🔴 %s non-SELECT policy/policies on import_batches. There must be NONE: submission is a server route and status changes are RPCs, so a client write policy can only be a mistake.', v_n);
    END IF;
    SELECT count(*) INTO v_n FROM pg_policy
     WHERE polrelid='public.import_batches'::regclass AND polcmd = 'r';
    IF v_n <> 2 THEN
      v_fail := v_fail || format('G1: expected 2 SELECT policies (own company, super-admin), found %s', v_n);
    END IF;
    -- grants: read only
    IF has_table_privilege('anon','public.import_batches','SELECT') THEN
      v_fail := v_fail || 'G1: 🔴 anon can read import_batches';
    END IF;
    FOREACH v_msg IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('authenticated','public.import_batches',v_msg) THEN
        v_fail := v_fail || format('G1: 🔴 authenticated holds %s on import_batches', v_msg);
      END IF;
    END LOOP;
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.import_batches'::regclass) THEN
      v_fail := v_fail || 'G1: RLS is not FORCED';
    END IF;
    -- the status allowlist must be an allowlist
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid='public.import_batches'::regclass
                      AND conname='import_batches_status_allowed') THEN
      v_fail := v_fail || 'G1: the status CHECK is missing — an unknown status must fail closed';
    END IF;
  END IF;

  -- ── G2: 🔴 the stamp FKs are ON DELETE RESTRICT ───────────────────
  -- SET NULL would either trip the write-once guard or silently detach
  -- rows from the batch rollback needs to find them by.
  FOREACH v_msg IN ARRAY ARRAY['residents','vehicles'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = ('public.'||v_msg)::regclass
         AND c.contype = 'f'
         AND c.confrelid = 'public.import_batches'::regclass
         AND c.confdeltype = 'r'           -- 'r' = RESTRICT
    ) THEN
      v_fail := v_fail || format('G2: 🔴 %s.import_batch_id is not ON DELETE RESTRICT (found %s). Batch rows are audit and are never deleted.',
        v_msg,
        COALESCE((SELECT c.confdeltype::TEXT FROM pg_constraint c
                   WHERE c.conrelid=('public.'||v_msg)::regclass AND c.contype='f'
                     AND c.confrelid='public.import_batches'::regclass LIMIT 1), 'no FK at all'));
    END IF;
    -- and NULLABLE, because 41 existing writers do not supply it
    IF (SELECT attnotnull FROM pg_attribute
         WHERE attrelid=('public.'||v_msg)::regclass AND attname='import_batch_id') THEN
      v_fail := v_fail || format('G2: 🔴 %s.import_batch_id is NOT NULL. 41 existing write sites do not supply it; every one would break.', v_msg);
    END IF;
  END LOOP;

  -- ── G3: the guard, and that it is INVOKER ─────────────────────────
  IF to_regprocedure('public.import_batch_write_once_guard()') IS NULL THEN
    v_fail := v_fail || 'G3: import_batch_write_once_guard() is missing';
  ELSE
    IF (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.import_batch_write_once_guard()')) THEN
      v_fail := v_fail || 'G3: 🔴 the guard is SECURITY DEFINER. current_user would read the OWNER for every caller and the client check would never fire.';
    END IF;
  END IF;
  -- 🔴 Declared on the COLUMN, so it does not even fire for the 41
  -- writers that never mention it.
  FOREACH v_msg IN ARRAY ARRAY['residents','vehicles'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = ('public.'||v_msg)::regclass AND NOT t.tgisinternal
         AND pg_get_triggerdef(t.oid) ~ 'UPDATE OF import_batch_id'
    ) THEN
      v_fail := v_fail || format('G3: the %s trigger is not scoped to UPDATE OF import_batch_id — it would evaluate on every update to a table with dozens of writers', v_msg);
    END IF;
  END LOOP;

  -- ════════════════════════════════════════════════════════════════
  -- G4 — EXECUTION
  -- ════════════════════════════════════════════════════════════════
  SELECT p.id, p.name, c.id, c.name INTO v_prop, v_pname, v_co, v_cname
    FROM public.properties p JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(p.company))
   WHERE lower(trim(p.name))='test legacy property' AND p.is_active LIMIT 1;

  IF v_prop IS NULL THEN
    v_fail := v_fail || 'G4: fixture property unresolved — the execution gates did NOT run, so nothing here proves the guard is inert OR that it refuses';
  ELSE
    INSERT INTO public.import_batches
      (company_id, property_id, source_filename, storage_path, file_sha256,
       attested_by_user_id, attested_name, attested_title, resident_count, vehicle_count)
    VALUES (v_co, v_prop, 'zz-gate.csv', format('%s/zz-%s.csv', v_co, v_stamp),
            repeat('a',64), gen_random_uuid(), 'ZZ Gate', 'Gate Tester', 0, 0)
    RETURNING id INTO v_batch;

    -- ── G4a: POSITIVE CONTROL — the guard is INERT for a normal write
    -- A plain insert that never mentions the column, which is what all
    -- 41 existing writers do.
    BEGIN
      INSERT INTO public.vehicles (plate,state,make,model,property,company,unit,resident_email,status,is_active)
      VALUES ('ZZIB1'||right(v_stamp,5),'TX','P','IB',v_pname,v_cname,'IB','zz-ib-res@test.invalid','pending',FALSE)
      RETURNING id INTO v_vid;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail || format('G4a: 🔴 the guard broke an ordinary vehicle insert (%s). It must be inert for all 41 existing writers.', SQLERRM);
    END;

    -- an ordinary UPDATE that does not mention the column
    IF v_vid IS NOT NULL THEN
      BEGIN
        UPDATE public.vehicles SET color='ZZIB', manager_note='gate' WHERE id=v_vid;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail || format('G4a: 🔴 the guard broke an ordinary vehicle UPDATE (%s)', SQLERRM);
      END;

      -- ── G4b: the loader path — service/owner context may SET it once
      BEGIN
        UPDATE public.vehicles SET import_batch_id = v_batch WHERE id=v_vid;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail || format('G4b: 🔴 the LOADER could not stamp the batch (%s). This is the one path that must work.', SQLERRM);
      END;

      -- ── G4c: write-once, for EVERY caller including this one ──────
      v_msg := NULL;
      BEGIN
        UPDATE public.vehicles SET import_batch_id = v_batch WHERE id=v_vid;  -- same value: a no-op, allowed
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      IF v_msg IS NOT NULL THEN
        v_fail := v_fail || format('G4c: re-writing the SAME batch id should be a no-op, got %L', v_msg);
      END IF;

      v_msg := NULL;
      BEGIN
        UPDATE public.vehicles SET import_batch_id = NULL WHERE id=v_vid;
      EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      IF v_msg IS DISTINCT FROM 'import_batch_id_already_set' THEN
        v_fail := v_fail || format('G4c: 🔴 CLEARING a batch stamp was not refused (got %L). Rollback finds rows by this column; clearing one hides it.', COALESCE(v_msg,'no error'));
      END IF;

      -- ── G4d: the FK is RESTRICT, proved by execution ──────────────
      v_msg := NULL;
      BEGIN
        DELETE FROM public.import_batches WHERE id = v_batch;
      EXCEPTION WHEN foreign_key_violation THEN
        v_msg := 'restricted';
      WHEN OTHERS THEN
        v_msg := SQLERRM;
      END;
      IF v_msg <> 'restricted' THEN
        v_fail := v_fail || format('G4d: 🔴 a batch with stamped rows was DELETABLE (%s). Batch rows are audit; deleting one would orphan or detach its rows.', COALESCE(v_msg,'no error'));
      END IF;
    END IF;

    -- ── teardown ────────────────────────────────────────────────────
    -- The stamp is write-once, so the ROW goes, not the stamp.
    DELETE FROM public.audit_logs WHERE record_id = v_vid::TEXT;
    DELETE FROM public.vehicle_parking_tags WHERE vehicle_id = v_vid;
    DELETE FROM public.vehicles WHERE id = v_vid;
    DELETE FROM public.import_batches WHERE id = v_batch;
    IF EXISTS (SELECT 1 FROM public.import_batches WHERE id = v_batch)
       OR EXISTS (SELECT 1 FROM public.vehicles WHERE plate LIKE 'ZZIB%') THEN
      v_fail := v_fail || 'teardown: probe rows survived';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'phase A import_batches'::TEXT AS target,
  'PASS'::TEXT                   AS result,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='public.import_batches'::regclass AND polcmd='r')          AS select_policies_want_2,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='public.import_batches'::regclass AND polcmd<>'r')         AS write_policies_want_0,
  (SELECT prosecdef FROM pg_proc
    WHERE oid=to_regprocedure('public.import_batch_write_once_guard()'))      AS guard_definer_want_false,
  (SELECT count(*) FROM pg_constraint
    WHERE confrelid='public.import_batches'::regclass AND confdeltype='r')    AS restrict_fks_want_2,
  (SELECT count(*) FROM public.import_batches)                                AS batches,
  (SELECT count(*) FROM public.vehicles WHERE import_batch_id IS NOT NULL)    AS stamped_vehicles_want_0,
  'G4 EXECUTED: the guard is INERT for an ordinary insert and update (the shape all 41 existing writers use); the loader can stamp once; re-writing the same id is a no-op; CLEARING it is refused; and a batch with stamped rows is NOT deletable (ON DELETE RESTRICT, proved by execution).'::TEXT AS execution_proof;
