-- ════════════════════════════════════════════════════════════════════
-- get_violation_by_view_token — explicit projection, no internal notes
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-16: the storage-facility link carries no internal notes
-- and no staff information.
--
-- 🔴 WHAT IT WAS DOING. `to_jsonb(v.*)` handed an anonymous token
-- holder the ENTIRE violations row — 42 columns. Measured as reaching
-- the browser but never rendered: notes, void_reason, voided_by_email
-- (a staff address), decline_reason_note, regenerate_reason_note,
-- status_changed_by, scanned_at, snapshot_status, and view_token itself.
-- Not an escalation — the token is 256-bit and unguessable, and the
-- reader is the vehicle's owner — but a disclosure to that reader of
-- things written for us.
--
-- 🔴 WHY EXPLICIT AND NOT A DROP-LIST. A projection that names what it
-- includes cannot leak a column added later; a drop-list leaks every
-- column nobody remembered to add to it. The next migration that adds
-- an internal note column to violations must not silently publish it.
--
-- WHAT CHANGES: one SELECT. The token length gate, the is_confirmed
-- requirement, the voided branch, the expiry check, the TDLR/VSF
-- resolution, the photo aggregate and the grants are all unchanged.
-- The token and its lifetime are untouched.
--
-- TWO KEYS ARE NEW TO THE PAYLOAD, both ruled the same day:
--   tow_mileage_fee        — the page showed tow_fee as the TOTAL while
--                            a mileage charge sat unshown. Four tokened
--                            tickets carry one today (all test-tenant;
--                            no A1 ticket is affected). Chapter 2308
--                            makes the charges disclosure the point of
--                            the document, so it is shown and summed.
--   tow_ticket_generated_at — when the vehicle was towed, as distinct
--                            from created_at, which is when the
--                            violation was written.

CREATE OR REPLACE FUNCTION public.get_violation_by_view_token(p_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_violation    jsonb;
  v_photos       jsonb;
  v_id           BIGINT;
  v_voided       TIMESTAMPTZ;
  v_property     TEXT;
  v_storage_name TEXT;
  v_company_name TEXT;
  v_tdlr         TEXT;
  v_vsf          TEXT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;

  SELECT v.id, v.voided_at
    INTO v_id, v_voided
    FROM violations v
   WHERE v.view_token = p_token
     AND v.is_confirmed = true;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  IF v_voided IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'voided');
  END IF;

  -- 🔴 THE PROJECTION. Every key is a field the motorist-facing page
  -- renders. Nothing here is written for internal use.
  SELECT jsonb_build_object(
           'id',                      v.id,
           'plate',                   v.plate,
           'violation_type',          v.violation_type,
           'location',                v.location,
           'property',                v.property,
           'created_at',              v.created_at,
           'vehicle_year',            v.vehicle_year,
           'vehicle_make',            v.vehicle_make,
           'vehicle_model',           v.vehicle_model,
           'vehicle_color',           v.vehicle_color,
           -- The TOW OPERATOR's name and licence, standard on a Texas
           -- tow ticket — not the vehicle owner's.
           'driver_name',             v.driver_name,
           'driver_license',          v.driver_license,
           'tow_storage_name',        v.tow_storage_name,
           'tow_storage_address',     v.tow_storage_address,
           'tow_storage_phone',       v.tow_storage_phone,
           'tow_fee',                 v.tow_fee,
           'tow_mileage_fee',         v.tow_mileage_fee,
           'tow_ticket_generated_at', v.tow_ticket_generated_at
         ),
         v.property, v.tow_storage_name
    INTO v_violation, v_property, v_storage_name
    FROM violations v
   WHERE v.id = v_id
     AND v.view_token_expires_at > now();

  IF v_violation IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  -- Resolve property → company once. Reused for both TDLR (the
  -- company's licence) and VSF. Unchanged from the B120 form.
  SELECT c.name, c.tdlr_license_number
    INTO v_company_name, v_tdlr
    FROM properties p
    JOIN companies c ON c.name ~~* p.company
   WHERE p.name = v_property
   LIMIT 1;

  -- VSF scoped BY COMPANY: two facilities could share a name across
  -- companies, and this is a motorist-facing legal document, so
  -- resolving the wrong VSF# is a real cost. Unchanged.
  IF v_storage_name IS NOT NULL AND v_company_name IS NOT NULL THEN
    SELECT vsf_license_number
      INTO v_vsf
      FROM storage_facilities
     WHERE name ~~* v_storage_name
       AND company ~~* v_company_name
     LIMIT 1;
  END IF;

  -- The two licence numbers are Chapter 2308 disclosures and stay.
  v_violation := v_violation || jsonb_build_object(
    'resolved_tdlr_license', v_tdlr,
    'resolved_vsf_license',  v_vsf
  );

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', id, 'photo_url', photo_url)
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_photos
    FROM violation_photos
   WHERE violation_id = v_id
     AND removed_at IS NULL;

  RETURN jsonb_build_object(
    'violation', v_violation,
    'photos',    v_photos
  );
END
$func$;

-- Grants re-affirmed, unchanged: anon + authenticated, never PUBLIC.
REVOKE EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.get_violation_by_view_token(TEXT) IS
  'Anonymous tow-ticket read for the storage-facility / vehicle-owner link. 🔴 EXPLICIT PROJECTION (2026-10-16): 18 violation fields plus the two resolved licence numbers, and nothing else. It replaced to_jsonb(v.*), which handed an anonymous token holder all 42 columns including notes, void_reason, voided_by_email, the decline and regenerate notes, status_changed_by and view_token itself. A projection that names what it includes cannot publish a column added later; a drop-list would.';
