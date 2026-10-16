-- Verification for wip-20261016_load_notifications.sql
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_cols INT;
  v_probe BIGINT;
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
  INSERT INTO public.import_batches
    (company_id, property_id, source_filename, storage_path, file_sha256,
     attested_name, attested_title, status, resident_count, vehicle_count)
  SELECT b.company_id, b.property_id, 'zz_notify_probe.csv', 'batches/zz_notify_probe.csv',
         repeat('0', 64), 'probe', 'probe', 'submitted', 0, 0
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

    DELETE FROM public.import_batches WHERE id = v_probe;
    IF EXISTS (SELECT 1 FROM public.import_batches WHERE id = v_probe) THEN
      v_fail := array_append(v_fail, format('G5: the probe row %s SURVIVED cleanup', v_probe));
    END IF;
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n%', array_to_string(v_fail, E'\n');
  END IF;
END
$do$;

SELECT 'PASS — notify columns present, nullable, vocabulary enforced by execution, probe removed' AS result;
