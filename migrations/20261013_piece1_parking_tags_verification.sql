-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Piece 1 Part A, parking tags
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 Standing rule (Jose, 2026-10-12): every verification file carries
-- at least one EXECUTION check. Reading prosrc proves the code says the
-- right thing, never that it runs — the protected-columns guard passed
-- six structural gates while raising `malformed array literal` for
-- every caller. G7-G9 below execute.
--
-- Not provable here: a manager refused / a resident read-only. Those
-- need real JWTs. Run `npm run verify:parkingtags`.

DO $$
DECLARE
  v_fail  TEXT[] := ARRAY[]::TEXT[];
  v_col   TEXT;
  v_n     INT;
  v_vehA  BIGINT; v_vehB BIGINT;
  v_propA BIGINT;
  v_tag   TEXT := 'ZZGATE' || (floor(random() * 1e6))::INT;
  v_tagid BIGINT;
  v_oldact BOOLEAN; v_oldstat TEXT;
  v_voided TIMESTAMPTZ;
BEGIN
  -- ── G1: the table and its columns ─────────────────────────────────
  IF to_regclass('public.vehicle_parking_tags') IS NULL THEN
    v_fail := v_fail || 'G1: vehicle_parking_tags does not exist';
  ELSE
    FOREACH v_col IN ARRAY ARRAY['id','vehicle_id','property_id','tag_number',
                                 'assigned_by','assigned_at','voided_at','voided_by',
                                 'voided_reason','voided_note'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute
                      WHERE attrelid = 'public.vehicle_parking_tags'::regclass
                        AND attname = v_col AND attnum > 0 AND NOT attisdropped) THEN
        v_fail := v_fail || format('G1: column %s is missing', v_col);
      END IF;
    END LOOP;

    -- 🔴 property_id must be a BIGINT FK, not the property NAME. The
    -- name is renameable and carries whitespace; four tables already
    -- key on it to our cost.
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = 'public.vehicle_parking_tags'::regclass
         AND a.attname = 'property_id'
         AND format_type(a.atttypid, a.atttypmod) = 'bigint'
    ) THEN
      v_fail := v_fail || 'G1: property_id is not bigint — it must be an FK to properties.id, never the name';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'public.vehicle_parking_tags'::regclass
                  AND attname IN ('property','company') AND attnum > 0 AND NOT attisdropped) THEN
      v_fail := v_fail || 'G1: a property/company NAME column was added — the table keys on property_id by design';
    END IF;

    -- Both FKs present
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.vehicle_parking_tags'::regclass AND contype = 'f';
    IF v_n < 2 THEN
      v_fail := v_fail || format('G1: expected 2 foreign keys (vehicle_id, property_id), found %s', v_n);
    END IF;
  END IF;

  -- ── G2: the two partial unique indexes ────────────────────────────
  -- Each asserted WITH its predicate: a unique index without the
  -- `WHERE voided_at IS NULL` clause would forbid ever re-issuing a
  -- collected tag number, which is the reason voiding exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'vehicle_parking_tags'
       AND indexname = 'vehicle_parking_tags_one_live_per_property'
       AND indexdef ~ 'UNIQUE' AND indexdef ~ 'property_id' AND indexdef ~ 'tag_number'
       AND indexdef ~ 'WHERE \(voided_at IS NULL\)'
  ) THEN
    v_fail := v_fail || 'G2: the one-live-tag-per-property unique index is missing or not partial on voided_at IS NULL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'vehicle_parking_tags'
       AND indexname = 'vehicle_parking_tags_one_live_per_vehicle'
       AND indexdef ~ 'UNIQUE' AND indexdef ~ 'WHERE \(voided_at IS NULL\)'
  ) THEN
    v_fail := v_fail || 'G2: the one-live-tag-per-vehicle unique index is missing or not partial';
  END IF;

  -- ── G3: 🔴 RLS, and NO WRITE POLICY. The load-bearing assertion. ──
  -- The whole reason this is a table and not a column on vehicles is
  -- that manager_update_vehicles grants a manager every column. If a
  -- write policy ever appears here, that hole is reopened and the RPC
  -- stops being the only write path.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.vehicle_parking_tags'::regclass AND relrowsecurity) THEN
    v_fail := v_fail || 'G3: RLS is not enabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.vehicle_parking_tags'::regclass AND relforcerowsecurity) THEN
    v_fail := v_fail || 'G3: RLS is not FORCED (the table owner would bypass it)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid = 'public.vehicle_parking_tags'::regclass AND polcmd <> 'r';
  IF v_n > 0 THEN
    v_fail := v_fail || format(
      'G3: 🔴 %s non-SELECT policy/policies exist on vehicle_parking_tags. There must be NONE — set_vehicle_tag/void_vehicle_tag are the only write path, and a write policy reopens what moving off vehicles closed.', v_n);
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid = 'public.vehicle_parking_tags'::regclass AND polcmd = 'r';
  IF v_n <> 3 THEN
    v_fail := v_fail || format('G3: expected 3 SELECT policies (manager, company_admin, resident-own), found %s', v_n);
  END IF;

  -- ── G4: grants. anon gets nothing; authenticated gets SELECT only ─
  -- has_table_privilege, not a relacl regex and not
  -- information_schema. The regex form is fragile (grantor names
  -- contain privilege letters) and information_schema under-reports;
  -- this asks Postgres the question directly, per privilege.
  FOREACH v_col IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.vehicle_parking_tags', v_col) THEN
      v_fail := v_fail || format('G4: 🔴 anon holds %s on vehicle_parking_tags', v_col);
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.vehicle_parking_tags', v_col) THEN
      v_fail := v_fail || format(
        'G4: 🔴 authenticated holds %s — the RPCs are SECURITY DEFINER and need no write grant, and without one a missing policy cannot become a write path', v_col);
    END IF;
  END LOOP;
  -- Positive control: the read grant the SELECT policies depend on must
  -- actually be there, or all three policies are decoration.
  IF NOT has_table_privilege('authenticated', 'public.vehicle_parking_tags', 'SELECT') THEN
    v_fail := v_fail || 'G4: authenticated has no SELECT grant — the three SELECT policies can never match anything';
  END IF;

  -- ── G5: the functions ─────────────────────────────────────────────
  FOREACH v_col IN ARRAY ARRAY[
    'public.set_vehicle_tag(bigint,text)',
    'public.void_vehicle_tag(bigint,text,text)',
    'public.may_manage_parking_tags_at(bigint)',
    'public.normalize_tag_number(text)',
    'public.vehicles_void_parking_tag()'
  ] LOOP
    IF to_regprocedure(v_col) IS NULL THEN
      v_fail := v_fail || format('G5: %s is missing', v_col);
    ELSE
      -- SECURITY DEFINER inherits EXECUTE to PUBLIC on this project's
      -- default; every one of these must have it revoked.
      IF v_col <> 'public.normalize_tag_number(text)'
         AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_col)) THEN
        v_fail := v_fail || format('G5: %s is not SECURITY DEFINER', v_col);
      END IF;
      IF (SELECT array_to_string(proacl, ',') FROM pg_proc WHERE oid = to_regprocedure(v_col)) ~ '(^|,)=X|anon=X' THEN
        v_fail := v_fail || format('G5: 🔴 %s is still executable by PUBLIC or anon', v_col);
      END IF;
    END IF;
  END LOOP;

  -- ── G6: the void trigger is attached ──────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'vehicles_void_parking_tag_trigger' AND NOT tgisinternal
                    AND tgrelid = 'public.vehicles'::regclass) THEN
    v_fail := v_fail || 'G6: the void trigger is not attached to vehicles';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- EXECUTION GATES
  -- ════════════════════════════════════════════════════════════════
  -- Fixtures are two ACTIVE vehicles at the Test Legacy fixture
  -- property. Tag rows are created here and deleted here; the vehicle
  -- flip in G9 is snapshotted and restored, and asserted restored.
  -- A failure anywhere raises, and because a DO block is one statement
  -- every probe write rolls back with it.
  SELECT p.id INTO v_propA FROM public.properties p
   WHERE lower(trim(p.name)) = 'test legacy property' LIMIT 1;

  -- NB: vehicles keys on `property` TEXT, not property_id. That is the
  -- fragility the new table exists to avoid, and the reason the join to
  -- properties below is lower(trim()) on both sides.
  SELECT v.id INTO v_vehA FROM public.vehicles v
   WHERE lower(trim(v.property)) = 'test legacy property'
     AND v.is_active AND v.status = 'active'
   ORDER BY v.id LIMIT 1;
  SELECT v.id INTO v_vehB FROM public.vehicles v
   WHERE lower(trim(v.property)) = 'test legacy property'
     AND v.is_active AND v.status = 'active' AND v.id <> COALESCE(v_vehA, -1)
   ORDER BY v.id LIMIT 1;

  IF v_propA IS NULL OR v_vehA IS NULL OR v_vehB IS NULL THEN
    -- Absence must not read as a pass.
    v_fail := v_fail || format(
      'G7: fixtures unresolved (property=%s vehA=%s vehB=%s) — the execution gates did NOT run, so nothing here proves the indexes or the trigger work',
      v_propA, v_vehA, v_vehB);
  ELSE
    -- ── G7: normalization ───────────────────────────────────────────
    IF public.normalize_tag_number('a-10 24') <> 'A1024' THEN
      v_fail := v_fail || format('G7: normalize_tag_number(''a-10 24'') = %L, want ''A1024''',
                                 public.normalize_tag_number('a-10 24'));
    END IF;
    IF public.normalize_tag_number('   ') IS NOT NULL THEN
      v_fail := v_fail || 'G7: a blank tag must normalize to NULL so a caller can clear it';
    END IF;

    -- ── G8: the unique indexes actually refuse ──────────────────────
    INSERT INTO public.vehicle_parking_tags (vehicle_id, property_id, tag_number, assigned_by)
    VALUES (v_vehA, v_propA, v_tag, 'gate@test.invalid')
    RETURNING id INTO v_tagid;

    BEGIN
      INSERT INTO public.vehicle_parking_tags (vehicle_id, property_id, tag_number, assigned_by)
      VALUES (v_vehB, v_propA, v_tag, 'gate@test.invalid');
      v_fail := v_fail || 'G8: 🔴 the same tag number was accepted TWICE live at one property';
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- correct
    END;

    BEGIN
      INSERT INTO public.vehicle_parking_tags (vehicle_id, property_id, tag_number, assigned_by)
      VALUES (v_vehA, v_propA, v_tag || 'X', 'gate@test.invalid');
      v_fail := v_fail || 'G8: 🔴 one vehicle was allowed TWO live tags';
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- correct
    END;

    -- Positive control: once voided, the SAME number is re-issuable.
    -- Without this, an index that refused everything would pass G8.
    UPDATE public.vehicle_parking_tags
       SET voided_at = now(), voided_by = 'gate@test.invalid', voided_reason = 'gate_positive_control'
     WHERE id = v_tagid;
    BEGIN
      INSERT INTO public.vehicle_parking_tags (vehicle_id, property_id, tag_number, assigned_by)
      VALUES (v_vehB, v_propA, v_tag, 'gate@test.invalid');
    EXCEPTION WHEN unique_violation THEN
      v_fail := v_fail || 'G8: 🔴 a VOIDED tag number could not be re-issued — voiding exists precisely so it can be';
    END;

    -- ── G9: the void trigger fires ──────────────────────────────────
    SELECT is_active, status INTO v_oldact, v_oldstat FROM public.vehicles WHERE id = v_vehB;
    UPDATE public.vehicles SET is_active = FALSE, status = 'deactivated' WHERE id = v_vehB;
    SELECT voided_at INTO v_voided FROM public.vehicle_parking_tags
     WHERE vehicle_id = v_vehB ORDER BY id DESC LIMIT 1;
    IF v_voided IS NULL THEN
      v_fail := v_fail || 'G9: 🔴 the vehicle left the authorized set and its tag was NOT voided';
    END IF;

    -- and must NOT un-void on reactivation
    UPDATE public.vehicles SET is_active = v_oldact, status = v_oldstat WHERE id = v_vehB;
    SELECT voided_at INTO v_voided FROM public.vehicle_parking_tags
     WHERE vehicle_id = v_vehB ORDER BY id DESC LIMIT 1;
    IF v_voided IS NULL THEN
      v_fail := v_fail || 'G9: 🔴 reactivating the vehicle UN-voided its tag. A collected physical tag must be re-issued deliberately.';
    END IF;

    -- restore the fixture vehicle, and prove it
    IF EXISTS (SELECT 1 FROM public.vehicles
                WHERE id = v_vehB
                  AND (is_active IS DISTINCT FROM v_oldact OR status IS DISTINCT FROM v_oldstat)) THEN
      v_fail := v_fail || format('G9: fixture vehicle %s NOT restored — set is_active=%s status=%L',
                                 v_vehB, v_oldact, v_oldstat);
    END IF;

    -- probe rows out
    DELETE FROM public.vehicle_parking_tags WHERE assigned_by = 'gate@test.invalid';
    IF EXISTS (SELECT 1 FROM public.vehicle_parking_tags WHERE assigned_by = 'gate@test.invalid') THEN
      v_fail := v_fail || 'G9: probe tag rows were not removed';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'piece 1 parking tags'::TEXT AS target,
  'PASS'::TEXT                 AS result,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='public.vehicle_parking_tags'::regclass AND polcmd='r')      AS select_policies_want_3,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='public.vehicle_parking_tags'::regclass AND polcmd<>'r')     AS write_policies_want_0,
  (SELECT count(*) FROM public.vehicle_parking_tags)                            AS tag_rows,
  (SELECT count(*) FROM public.vehicle_parking_tags WHERE voided_at IS NULL)    AS live_tags,
  (SELECT count(*) FROM public.properties WHERE parking_tags_enabled)           AS properties_switched_on,
  'G7-G9 EXECUTED: normalization, both unique indexes (with a voided-reissue positive control), and the void trigger firing and not un-voiding.'::TEXT AS execution_proof;
