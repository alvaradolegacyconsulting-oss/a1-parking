-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — Stage 1a, server-side vehicle state audit
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- 🔴 G4 EXECUTES. A trigger that raises breaks every write to vehicles,
-- which is not hypothetical: the properties guard shipped a type error
-- (`malformed array literal`) that refused every caller and passed six
-- structural gates. audit_logs.record_id is TEXT and NEW.id is bigint,
-- so this one had a cast to get right. Structure alone cannot see that.

DO $$
DECLARE
  v_fail    TEXT[] := ARRAY[]::TEXT[];
  v_n       INT;
  v_vid     BIGINT;
  v_plate   TEXT := 'ZZAUD' || (floor(random() * 1e5))::INT;
  v_before  INT;
  v_row     public.audit_logs;
BEGIN
  -- ── G1: the function ──────────────────────────────────────────────
  IF to_regprocedure('public.vehicles_audit_state_change()') IS NULL THEN
    v_fail := v_fail || 'G1: vehicles_audit_state_change() is missing';
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.vehicles_audit_state_change()')) THEN
      v_fail := v_fail || 'G1: not SECURITY DEFINER — it must write audit_logs regardless of the caller''s grants';
    END IF;
    -- Postgres grants EXECUTE to PUBLIC by default, and this project
    -- also grants it to authenticated via default privileges. A trigger
    -- function needs neither.
    IF has_function_privilege('anon', 'public.vehicles_audit_state_change()', 'EXECUTE') THEN
      v_fail := v_fail || 'G1: 🔴 anon can execute it';
    END IF;
    IF has_function_privilege('authenticated', 'public.vehicles_audit_state_change()', 'EXECUTE') THEN
      v_fail := v_fail || 'G1: 🔴 authenticated can execute it — a trigger function needs no caller EXECUTE';
    END IF;
    IF (SELECT array_to_string(proacl, ',') FROM pg_proc
         WHERE oid = to_regprocedure('public.vehicles_audit_state_change()')) ~ '(^|,)=X' THEN
      v_fail := v_fail || 'G1: 🔴 PUBLIC still holds EXECUTE';
    END IF;
  END IF;

  -- ── G2: the trigger, on the right events ──────────────────────────
  -- Asserted WITH its event list: declared on status/is_active only, so
  -- a cosmetic edit does not write an audit row. AFTER, so it records
  -- what was committed rather than what was proposed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.vehicles'::regclass
       AND t.tgname = 'vehicles_audit_state_change_trigger'
       AND NOT t.tgisinternal
       AND pg_get_triggerdef(t.oid) ~ 'AFTER INSERT OR UPDATE OF (status, is_active|is_active, status)'
  ) THEN
    v_fail := v_fail || format('G2: trigger missing or wrong events. Found: %s',
      COALESCE((SELECT pg_get_triggerdef(oid) FROM pg_trigger
                 WHERE tgrelid='public.vehicles'::regclass
                   AND tgname='vehicles_audit_state_change_trigger'), '(none)'));
  END IF;

  -- ── G3: audit_logs still shaped the way the trigger writes ────────
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.audit_logs'::regclass AND attname='record_id'
                    AND format_type(atttypid, atttypmod) = 'text') THEN
    v_fail := v_fail || 'G3: audit_logs.record_id is no longer text — the trigger casts NEW.id::TEXT to match it';
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- G4 — EXECUTION, on a vehicle this block creates and removes
  -- ════════════════════════════════════════════════════════════════
  -- A FRESH row, never an existing one: other triggers on vehicles
  -- (plate prohibition BEFORE INSERT/UPDATE, space designation, tag
  -- void) fire on the same events, and a real row could already be in
  -- a state that masks the behaviour under test.
  SELECT count(*) INTO v_before FROM public.audit_logs WHERE action = 'VEHICLE_STATE_CHANGE';

  INSERT INTO public.vehicles (plate, state, make, model, property, company, unit, resident_email, status, is_active)
  SELECT v_plate, 'TX', 'Probe', 'Audit', p.name, p.company, 'AUD',
         'zz-aud-res@test.invalid', 'pending', FALSE
    FROM public.properties p
   WHERE lower(trim(p.name)) = 'test legacy property'
   LIMIT 1
  RETURNING id INTO v_vid;

  IF v_vid IS NULL THEN
    v_fail := v_fail || 'G4: could not create the probe vehicle (fixture property missing?) — the execution gate did NOT run';
  ELSE
    -- INSERT must have logged
    SELECT * INTO v_row FROM public.audit_logs
     WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_vid::TEXT
     ORDER BY created_at DESC LIMIT 1;
    IF v_row.id IS NULL THEN
      v_fail := v_fail || 'G4: 🔴 the INSERT wrote NO audit row';
    ELSE
      IF COALESCE(v_row.new_values ->> 'op', '') <> 'INSERT' THEN
        v_fail := v_fail || format('G4: INSERT row has op=%L', v_row.new_values ->> 'op');
      END IF;
      IF v_row.old_values IS NOT NULL THEN
        v_fail := v_fail || 'G4: an INSERT must carry NULL old_values — "no prior state" is not the same as "prior state was null"';
      END IF;
      -- the actor must be answered, always
      IF COALESCE(v_row.user_email, '') = '' THEN
        v_fail := v_fail || 'G4: 🔴 no actor recorded. A SQL session has no JWT and must read as ''system'', never blank';
      END IF;
      IF COALESCE(v_row.new_values ->> 'property', '') = '' THEN
        v_fail := v_fail || 'G4: the row does not name the property';
      END IF;
    END IF;

    -- a real state change must log old -> new
    UPDATE public.vehicles SET is_active = TRUE, status = 'active' WHERE id = v_vid;
    SELECT * INTO v_row FROM public.audit_logs
     WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_vid::TEXT
       AND new_values ->> 'op' = 'UPDATE'
     ORDER BY created_at DESC LIMIT 1;
    IF v_row.id IS NULL THEN
      v_fail := v_fail || 'G4: 🔴 a status/is_active change wrote NO audit row';
    ELSE
      IF COALESCE(v_row.old_values ->> 'status', '') <> 'pending'
         OR COALESCE(v_row.new_values ->> 'status', '') <> 'active' THEN
        v_fail := v_fail || format('G4: old->new not recorded correctly: %s -> %s',
                                   v_row.old_values ->> 'status', v_row.new_values ->> 'status');
      END IF;
      -- This write did NOT go through approve_vehicle, so the flag must
      -- say so. If it ever reads true here, the flag is leaking and the
      -- guard built on it is worthless.
      IF COALESCE((v_row.new_values ->> 'via_approve_rpc')::BOOLEAN, FALSE) THEN
        v_fail := v_fail || 'G4: 🔴 via_approve_rpc is TRUE for a direct SQL write — the approve flag is leaking';
      END IF;
    END IF;

    -- 🔴 POSITIVE CONTROL, INVERTED: a cosmetic edit must write NOTHING.
    -- A trigger that logged every UPDATE would pass every check above
    -- while flooding the log and making the signal useless.
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_vid::TEXT;
    UPDATE public.vehicles SET color = 'ZZ', model = 'AuditCosmetic' WHERE id = v_vid;
    IF (SELECT count(*) FROM public.audit_logs
         WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_vid::TEXT) <> v_n THEN
      v_fail := v_fail || 'G4: a cosmetic edit wrote a state-change audit row — the trigger is too broad';
    END IF;

    -- and an UPDATE that mentions status without changing it
    UPDATE public.vehicles SET status = 'active' WHERE id = v_vid;
    IF (SELECT count(*) FROM public.audit_logs
         WHERE action = 'VEHICLE_STATE_CHANGE' AND record_id = v_vid::TEXT) <> v_n THEN
      v_fail := v_fail || 'G4: an UPDATE that set status to its EXISTING value wrote a row — the column trigger fires on mention, so the value comparison is required';
    END IF;

    -- teardown
    DELETE FROM public.audit_logs WHERE record_id = v_vid::TEXT AND action = 'VEHICLE_STATE_CHANGE';
    DELETE FROM public.vehicle_parking_tags WHERE vehicle_id = v_vid;
    DELETE FROM public.vehicles WHERE id = v_vid;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE id = v_vid) THEN
      v_fail := v_fail || format('G4: probe vehicle %s not removed', v_vid);
    END IF;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate) THEN
      v_fail := v_fail || 'G4: a probe vehicle row survived teardown';
    END IF;
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'stage 1a vehicle state audit'::TEXT AS target,
  'PASS'::TEXT                         AS result,
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.vehicles'::regclass AND NOT tgisinternal)                  AS vehicles_triggers,
  (SELECT count(*) FROM public.audit_logs WHERE action='VEHICLE_STATE_CHANGE')       AS state_change_rows,
  (SELECT count(*) FROM public.audit_logs
    WHERE table_name='vehicles' AND action IN ('DECLINE_VEHICLE','REMOVE_VEHICLE'))  AS legacy_client_rows,
  'G4 EXECUTED on a probe vehicle: INSERT logged with NULL old_values, a real change logged old->new with an actor, a cosmetic edit and a no-op status write logged NOTHING, probe removed.'::TEXT AS execution_proof;
