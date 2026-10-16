-- Verification for wip-20261016_ticket_view_explicit_projection.sql
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
--
-- 🔴 STRUCTURE IS NOT ENOUGH HERE. A gate that greps the body for
-- 'jsonb_build_object' passes against a projection that still carries
-- notes. This one EXECUTES the function against a real tokened
-- violation and compares the key set exactly — present keys and absent
-- keys both asserted, because a projection check that only counts
-- would pass while naming the wrong twenty.
DO $do$
DECLARE
  v_fail   TEXT[] := '{}';
  v_token  TEXT;
  v_id     BIGINT;
  v_out    jsonb;
  v_keys   TEXT[];
  v_want   TEXT[] := ARRAY[
    'id','plate','violation_type','location','property','created_at',
    'vehicle_year','vehicle_make','vehicle_model','vehicle_color',
    'driver_name','driver_license',
    'tow_storage_name','tow_storage_address','tow_storage_phone',
    'tow_fee','tow_mileage_fee','tow_ticket_generated_at',
    'resolved_tdlr_license','resolved_vsf_license'
  ];
  v_banned TEXT[] := ARRAY[
    'notes','void_reason','voided_at','voided_by_email','voided_by_role',
    'regenerate_reason','regenerate_reason_note','regenerated_from',
    'decline_reason','decline_reason_note',
    'status_changed_by','status_changed_at','status',
    'view_token','view_token_expires_at',
    'is_confirmed','scanned_at','headline_status_at_scan','snapshot_status',
    'was_authorized_at_time','video_url','vehicle_vin','tow_ticket_generated','photos'
  ];
  v_extra  TEXT[];
  v_miss   TEXT[];
  v_leak   TEXT[];
BEGIN
  -- G1 — a live, non-voided, unexpired tokened violation to read.
  SELECT v.view_token, v.id INTO v_token, v_id
    FROM violations v
   WHERE v.view_token IS NOT NULL
     AND v.is_confirmed = true
     AND v.voided_at IS NULL
     AND v.view_token_expires_at > now()
   ORDER BY v.id
   LIMIT 1;

  IF v_token IS NULL THEN
    -- 🔴 Absence is not a pass. With no fixture the key set was never
    -- compared, and a green row here would mean nothing.
    RAISE EXCEPTION 'VERIFICATION INCONCLUSIVE: no live tokened violation to read. The projection was NOT checked.';
  END IF;

  v_out := public.get_violation_by_view_token(v_token);
  IF v_out ? 'error' OR v_out ? 'status' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: the function refused the fixture token (%): %', v_id, v_out;
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(v_out -> 'violation') AS k;

  -- G2 — exactly the intended keys, no more
  SELECT array_agg(k) INTO v_extra FROM unnest(v_keys) k WHERE NOT (k = ANY (v_want));
  IF v_extra IS NOT NULL THEN
    v_fail := array_append(v_fail, format('G2: UNEXPECTED keys in the payload: %s', array_to_string(v_extra, ', ')));
  END IF;

  -- G3 — and no fewer. A page that renders a missing key shows a blank
  -- where a legal disclosure belongs.
  SELECT array_agg(k) INTO v_miss FROM unnest(v_want) k WHERE NOT (k = ANY (v_keys));
  IF v_miss IS NOT NULL THEN
    v_fail := array_append(v_fail, format('G3: MISSING keys: %s', array_to_string(v_miss, ', ')));
  END IF;

  -- G4 — every named field is absent by name, stated individually so a
  -- failure says WHICH internal field is being published.
  SELECT array_agg(k) INTO v_leak FROM unnest(v_banned) k WHERE (v_out -> 'violation') ? k;
  IF v_leak IS NOT NULL THEN
    v_fail := array_append(v_fail, format('G4: 🔴 INTERNAL FIELD(S) PUBLISHED TO ANON: %s', array_to_string(v_leak, ', ')));
  END IF;

  -- G5 — photos stay a sibling key, not folded into the violation
  IF NOT (v_out ? 'photos') THEN
    v_fail := array_append(v_fail, 'G5: the photos key is gone from the top level');
  END IF;

  -- G6 — the grants are still anon + authenticated and never PUBLIC
  IF has_function_privilege('public', 'public.get_violation_by_view_token(text)', 'EXECUTE') THEN
    v_fail := array_append(v_fail, 'G6: EXECUTE is granted to PUBLIC');
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_violation_by_view_token(text)', 'EXECUTE') THEN
    v_fail := array_append(v_fail, 'G6: anon lost EXECUTE — the public ticket link is broken');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED (fixture violation %):\n%', v_id, array_to_string(v_fail, E'\n');
  END IF;

  RAISE NOTICE 'checked against violation % — % keys, exactly the intended set', v_id, array_length(v_keys, 1);
END
$do$;

SELECT 'PASS — explicit projection: exactly 20 keys, every internal field absent by name, photos still a sibling, grants unchanged' AS result;
