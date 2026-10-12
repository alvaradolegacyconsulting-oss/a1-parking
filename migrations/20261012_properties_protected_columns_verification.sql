-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — properties CA-only columns
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 CANNOT PROVE a manager is refused — the guard keys on auth.jwt()
-- and a SQL session deliberately passes through. Run
--   npm run verify:propcolumns
-- which attempts each protected column as a manager and, as the control
-- that matters, confirms a manager can STILL edit pass caps, house
-- rules and the everyday columns.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_src  TEXT;
  v_col  TEXT;
  -- The list is asserted by CONTENTS, not trusted to stay complete.
  -- This is a denylist on purpose (a new column must default to
  -- manager-editable), so the only protection against an omission is
  -- naming every member here.
  v_protected TEXT[] := ARRAY[
    'company','is_active',
    'auth_status','auth_document_url','auth_reference','auth_uploaded_by',
    'auth_uploaded_at','auth_expires_at','auth_notes',
    'authorization_pdf_path','authorization_expiration_date','authorization_notes',
    'parking_tags_enabled','printable_visitor_passes_enabled'
  ];
  -- Must NOT appear: protecting any of these breaks the manager portal.
  v_allowed TEXT[] := ARRAY[
    'visitor_pass_limit','visitor_capacity','exempt_plates',
    'house_rules_text','house_rules_version','house_rules_effective_date',
    'house_rules_updated_at','house_rules_updated_by_email',
    'address','city','state','zip','notes','pm_name','pm_phone','pm_email'
  ];
  v_guarded_count INT;
  v_pid           INT;
  v_probe_old     TEXT;
BEGIN
  IF to_regprocedure('public.properties_protected_columns_guard()') IS NULL THEN
    v_fail := v_fail || 'G1: properties_protected_columns_guard() is missing';
  ELSE
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.properties_protected_columns_guard()'));

    -- 🔴 WORD-BOUNDARY, AND AGAINST THE COMPARISON ITSELF — not a
    -- substring of the source. A plain LIKE '%notes%' matches
    -- NEW.auth_notes and NEW.authorization_notes, so the first version
    -- of G3 failed claiming `notes` was guarded when it is not: every
    -- short column name is a substring of a longer guarded one
    -- (notes ⊂ auth_notes, city/state/zip ⊂ nothing here but one
    -- rename away from it). Matching `NEW.x IS DISTINCT FROM OLD.x`
    -- with \M also proves the column is actually COMPARED rather than
    -- merely mentioned in a comment or an error string.
    FOREACH v_col IN ARRAY v_protected LOOP
      IF v_src !~ ('NEW\.' || v_col || '\M\s+IS DISTINCT FROM\s+OLD\.' || v_col || '\M') THEN
        v_fail := v_fail || format('G2: 🔴 %s is NOT compared in the guard — a manager can still change it', v_col);
      END IF;
    END LOOP;

    -- 🔴 The inverse assertion. A guard that crept into the pass caps
    -- or house rules would pass every check above and silently take
    -- those away from managers, who own them.
    FOREACH v_col IN ARRAY v_allowed LOOP
      IF v_src ~ ('(NEW|OLD)\.' || v_col || '\M') THEN
        v_fail := v_fail || format('G3: 🔴 %s is referenced in the guard — it must stay manager-editable', v_col);
      END IF;
    END LOOP;

    -- 🔴 Neither list alone catches a FIFTEENTH column added to the
    -- guard that is in neither array — it would be silently CA-only,
    -- which is the failure mode Piece 0 rejected column grants over.
    SELECT count(DISTINCT m[1]) INTO v_guarded_count
      FROM regexp_matches(v_src, 'NEW\.(\w+)\s+IS DISTINCT FROM', 'g') AS m;
    IF v_guarded_count <> array_length(v_protected, 1) THEN
      v_fail := v_fail || format(
        'G2: the guard compares %s columns but %s are ruled on — an unruled column is silently CA-only',
        v_guarded_count, array_length(v_protected, 1));
    END IF;

    IF v_src NOT LIKE '%protected_column_not_permitted%' THEN
      v_fail := v_fail || 'G4: the guard does not raise protected_column_not_permitted';
    END IF;
    -- The no-JWT passthrough must survive: migrations and the demo
    -- seeder write these columns.
    IF v_src NOT LIKE '%v_email = ''''%' THEN
      v_fail := v_fail || 'G4: the no-JWT passthrough is gone — migrations and the prospect-demo seeder would be refused';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.properties_protected_columns_guard()')) THEN
      v_fail := v_fail || 'G4: the guard is not SECURITY DEFINER';
    END IF;
  END IF;

  -- G5 — the trigger is installed, and the Piece 0 one is gone
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname='properties_protected_columns_guard_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'G5: 🔴 the trigger is not installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname='properties_feature_switch_guard_trigger' AND NOT tgisinternal) THEN
    v_fail := v_fail || 'G5: the superseded Piece 0 trigger is STILL attached — both would fire and the narrower one is redundant';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- G7 — 🔴 EXECUTION GATE. The one check that is not about text.
  -- ════════════════════════════════════════════════════════════════
  -- Every gate above reads prosrc, which proves the guard SAYS the
  -- right thing — never that it RUNS. v1 of this guard appended to a
  -- TEXT[] with `v_changed || 'company'`; Postgres resolved that as
  -- anyarray || anyarray and raised `malformed array literal` on every
  -- protected write, for every caller, BEFORE the role check. G1–G6 all
  -- passed green over it. The CA portal could not touch an
  -- authorization document and set_property_feature_switch was dead.
  --
  -- A SQL session has no user JWT, so the guard must let this through.
  -- If it raises at all, the guard is broken for migrations, the
  -- prospect-demo seeder and the CA's own RPC.
  --
  -- The write is undone two ways: explicitly on success, and by the
  -- subtransaction rollback that an EXCEPTION block performs on error.
  -- A Test-LEGACY property is chosen so a live tenant is never the
  -- probe subject.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname='properties_protected_columns_guard_trigger' AND NOT tgisinternal) THEN
    SELECT id, authorization_notes INTO v_pid, v_probe_old
      FROM public.properties
     WHERE company = 'Test-LEGACY'
     ORDER BY id LIMIT 1;

    IF v_pid IS NULL THEN
      -- Absence must not read as success.
      v_fail := v_fail || 'G7: could not resolve a Test-LEGACY probe property — the execution gate did NOT run, so nothing here proves the guard executes';
    ELSE
      BEGIN
        UPDATE public.properties
           SET authorization_notes = 'zz-g7-exec-probe'
         WHERE id = v_pid;
        UPDATE public.properties
           SET authorization_notes = v_probe_old
         WHERE id = v_pid;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail || format(
          'G7: 🔴 the guard RAISED on a no-JWT write to a protected column: %s (SQLSTATE %s). Observed on properties.id=%s. Migrations, the prospect-demo seeder and set_property_feature_switch are ALL refused by this.',
          SQLERRM, SQLSTATE, v_pid);
      END;

      -- Prove the restore held rather than assuming the UPDATE above ran.
      IF EXISTS (SELECT 1 FROM public.properties
                  WHERE id = v_pid
                    AND authorization_notes IS DISTINCT FROM v_probe_old) THEN
        v_fail := v_fail || format(
          'G7: the probe value is still on properties.id=%s — restore it to %s',
          v_pid, COALESCE(quote_literal(v_probe_old), 'NULL'));
      END IF;
    END IF;
  END IF;

  -- G6 — the data check that preceded this, re-asserted. If a property
  -- ever points at a company that does not exist, the thing this guard
  -- prevents has already happened by some other route.
  IF EXISTS (
    SELECT 1 FROM public.properties p
     WHERE NOT EXISTS (SELECT 1 FROM public.companies c
                        WHERE lower(trim(c.name)) = lower(trim(p.company)))
  ) THEN
    v_fail := v_fail || 'G6: 🔴 a property points at a company that does not exist';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'properties CA-only columns'::TEXT AS target,
  'PASS'::TEXT                       AS result,
  (SELECT count(*) FROM pg_trigger
    WHERE tgname='properties_protected_columns_guard_trigger' AND NOT tgisinternal) AS guard_trigger_want_1,
  (SELECT count(*) FROM pg_trigger
    WHERE tgname='properties_feature_switch_guard_trigger' AND NOT tgisinternal)    AS superseded_trigger_want_0,
  (SELECT count(DISTINCT m[1]) FROM pg_proc,
     regexp_matches(prosrc, 'NEW\.(\w+)\s+IS DISTINCT FROM', 'g') AS m
    WHERE oid = to_regprocedure('public.properties_protected_columns_guard()'))      AS guarded_columns_want_14,
  (SELECT count(*) FROM public.properties)                                          AS properties,
  (SELECT count(*) FROM public.properties p
    WHERE NOT EXISTS (SELECT 1 FROM public.companies c
                       WHERE lower(trim(c.name)) = lower(trim(p.company))))         AS orphan_company_want_0,
  'G7 executed the guard on a no-JWT write (passthrough). NOT PROVEN HERE: a manager refused / still able to edit caps. Run npm run verify:propcolumns.'::TEXT AS execution_proof;
