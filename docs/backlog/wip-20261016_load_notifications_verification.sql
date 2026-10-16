-- Verification for wip-20261016_load_notifications.sql  (v2)
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
--
-- 🔴 v1 FAILED, AND NOT ON WHAT IT WAS VERIFYING. Its probe INSERT
-- listed the columns I remembered rather than the ones the table
-- requires, and died on 23502: attested_by_user_id is NOT NULL. The
-- probe now copies that value from a real batch. Nothing else in the
-- row needed changing: every column the probe leaves NULL is proved
-- nullable by an existing batch row, which is a better authority than
-- my recollection of the DDL.
--
-- 🔴 AND THE PROBE IS NOT INERT. import_batches_status_audit fires
-- AFTER INSERT, so creating a probe batch writes one audit_logs row
-- naming a batch that will not exist a moment later. On the failure
-- path the RAISE rolls that back with everything else; on the PASS path
-- it would be committed and left behind. It is cleaned up and the
-- cleanup is asserted — an audit log describing a probe is noise in the
-- one table people trust to describe real events.
--
-- The G3/G4 updates touch only the notify columns, and the trigger is
-- scoped UPDATE OF status, so they add no further audit rows.
--
-- Each run consumes one import_batches id. A gap in the sequence is
-- this file, not a lost batch.
DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_cols INT;
  v_probe BIGINT;
  v_audit INT;
  v_sqlstate TEXT;
BEGIN
  -- G1 — all four columns exist, with the types the writer assumes
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'import_batches'
     AND (column_name, data_type) IN (
       ('notify_ca_outcome', 'text'), ('notify_admin_outcome', 'text'),
       ('notify_error', 'text'), ('notified_at', 'timestamp with time zone'));
  IF v_cols <> 4 THEN
    v_fail := array_append(v_fail, format('G1: expected 4 columns with the right types, found %s', v_cols));
  END IF;

  -- G2 — NULL is still allowed, because every batch before today is NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'import_batches'
       AND column_name IN ('notify_ca_outcome', 'notify_admin_outcome', 'notify_error', 'notified_at')
       AND is_nullable = 'NO'
  ) THEN
    v_fail := array_append(v_fail, 'G2: a notify column is NOT NULL — the existing 5 batches would be unreadable');
  END IF;

  -- G3 — the vocabulary is actually enforced, proved by EXECUTION on a
  -- fresh probe row. 🔴 Not on an existing batch: another trigger or
  -- constraint on a real row can raise the same sqlstate and would be
  -- read as this constraint working.
  --
  -- status 'submitted' with no approved_by satisfies
  -- import_batches_approval_complete, both reject_* NULL satisfies
  -- import_batches_reject_errors_shape, and a sha of 64 zeroes cannot
  -- collide with import_batches_one_live_per_file.
  INSERT INTO public.import_batches
    (company_id, property_id, source_filename, storage_path, file_sha256,
     attested_by_user_id, attested_name, attested_title,
     status, resident_count, vehicle_count)
  SELECT b.company_id, b.property_id, 'zz_notify_probe.csv', 'batches/zz_notify_probe.csv',
         repeat('0', 64),
         b.attested_by_user_id,          -- NOT NULL; copied, not invented
         'probe', 'probe', 'submitted', 0, 0
    FROM public.import_batches b ORDER BY b.id LIMIT 1
  RETURNING id INTO v_probe;

  IF v_probe IS NULL THEN
    v_fail := array_append(v_fail, 'G3: could not insert a probe row, so the CHECK was never executed');
  ELSE
    BEGIN
      UPDATE public.import_batches SET notify_ca_outcome = 'definitely-sent' WHERE id = v_probe;
      v_fail := array_append(v_fail, 'G3: the CHECK ACCEPTED an unknown outcome value');
    EXCEPTION WHEN check_violation THEN
      NULL;  -- the refusal we wanted
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
      v_fail := array_append(v_fail, format('G3: refused with %s, not check_violation — a different guard answered', v_sqlstate));
    END;

    -- G4 — and every legal value is accepted, so the constraint is not
    -- simply refusing everything
    BEGIN
      UPDATE public.import_batches
         SET notify_ca_outcome = 'overridden', notify_admin_outcome = 'skipped',
             notify_error = NULL, notified_at = now()
       WHERE id = v_probe;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
      v_fail := array_append(v_fail, format('G4: a LEGAL outcome was refused with %s', v_sqlstate));
    END;

    -- G5 — the probe row goes, and is checked rather than assumed
    DELETE FROM public.import_batches WHERE id = v_probe;
    IF EXISTS (SELECT 1 FROM public.import_batches WHERE id = v_probe) THEN
      v_fail := array_append(v_fail, format('G5: the probe row %s SURVIVED cleanup', v_probe));
    END IF;

    -- G6 — and so does the audit row its INSERT caused
    DELETE FROM public.audit_logs
     WHERE table_name = 'import_batches'
       AND record_id = v_probe::TEXT
       AND action = 'IMPORT_BATCH_SUBMITTED';
    SELECT count(*) INTO v_audit
      FROM public.audit_logs
     WHERE table_name = 'import_batches' AND record_id = v_probe::TEXT;
    IF v_audit <> 0 THEN
      v_fail := array_append(v_fail, format('G6: %s audit row(s) still name probe batch %s', v_audit, v_probe));
    END IF;
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n%', array_to_string(v_fail, E'\n');
  END IF;
END
$do$;

SELECT 'PASS — notify columns present and nullable, vocabulary enforced by execution, probe row and its audit row removed' AS result;
