-- ════════════════════════════════════════════════════════════════════
-- PIECE 1 PART C — driver tag lookup, scoped in SQL
-- ════════════════════════════════════════════════════════════════════
--
-- Completes Piece 1: "driver tag search scoped to the driver's assigned
-- properties."
--
-- 🔴 WHY AN RPC AND NOT A CLIENT PREDICATE. Two hard blockers and one
-- choice:
--
--  1. vehicle_parking_tags has NO driver policy. Part A wrote three
--     SELECT policies — manager, company_admin, resident-own — on
--     purpose. A driver reads nothing. Widening the table's RLS to
--     drivers would expose every tag at the company to a render-only
--     client filter.
--  2. The table keys on property_id, and the driver portal never reads
--     the properties table at all (`grep "from('properties')"
--     app/driver/page.tsx` → zero hits), so it cannot resolve a name to
--     an id without a new read path.
--  3. 🔴 The choice: "scoped to assigned properties" has to mean scoped
--     in SQL. The driver portal's existing plate predicates scope by a
--     client-side .ilike('property', selectedProperty) — which is the
--     enforcement boundary and must not be touched — but the portal
--     never VALIDATES that selectedProperty is really assigned, and
--     driver/page.tsx:488 falls back to assigned_properties: ['All']
--     when its .single() fails. That is a filed, open defect. This new
--     surface does not inherit it: the gate below is server-side.
--
-- ── WHAT IT REFUSES ────────────────────────────────────────────────
--   • a caller with no drivers row, or a DEACTIVATED driver — the
--     existing helper does not check drivers.is_active, so this does
--   • a property outside the caller's company
--   • a property that is NOT active  ← the half of the open defect that
--     render-only filtering cannot close: a deactivated property stays
--     in assigned_properties forever
--   • a property not in assigned_properties (unless that array holds
--     the 'All' sentinel, which the portal uses for company-wide
--     drivers; 'All' still requires the property to exist, be active,
--     and belong to the caller's company)
--
-- 🔴 A TAG NEVER DECIDES AUTHORIZATION. Same invariant as Part B: this
-- returns what the tag says and the plate's own status separately. The
-- driver's plate cascade is untouched — no new CompositeRecord type, no
-- change to COMPOSITE_SORT_PRIORITY, which is documented as fragile and
-- load-bearing. A tag finding can never suppress a protective record
-- because it is not in the pick order at all.
--
-- Paired: wip-20261013_piece1_partC_driver_tag_lookup_verification.sql
--
-- 🔴 MACHINE-READ BY verify:lookuptypes. Every value this function can
-- put in tag_status, listed once. The gate asserts each one appears
-- literally in the body below (so this line cannot lie) AND has a
-- branch in app/driver/page.tsx — because a status with no branch
-- renders as a bare "Tag X: <status>" fallback, which is the same class
-- of silent gap as do_not_tow missing from the manager whitelist.
-- TAG_STATUS_MANIFEST: tags_not_enabled unreadable unknown voided issued match mismatch

CREATE OR REPLACE FUNCTION public.driver_tag_lookup(
  p_tag      TEXT,
  p_property TEXT,
  p_plate    TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email      TEXT;
  v_assigned   TEXT[];
  v_company    TEXT;
  v_prop_id    BIGINT;
  v_prop_name  TEXT;
  v_tags_on    BOOLEAN;
  v_tag        TEXT;
  v_plate_norm TEXT;
  v_reg_plate  TEXT;
  v_reg_unit   TEXT;
  v_reg_status TEXT;
  v_voided     BOOLEAN;
  v_found      BOOLEAN;
BEGIN
  v_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_signed_in');
  END IF;

  -- The driver's own assignment + company, read server-side. Reusing
  -- the existing helper rather than a second source of truth.
  v_assigned := public.get_my_driver_assigned_properties();
  -- 🔴 d.is_active, which get_my_driver_assigned_properties does NOT
  -- check — its contract is only "returns the array, or NULL if no row
  -- exists". A deactivated driver keeps their assigned_properties, so
  -- without this a removed driver could still read tags.
  SELECT lower(trim(d.company)) INTO v_company
    FROM public.drivers d
   WHERE lower(trim(d.email)) = v_email
     AND d.is_active
   LIMIT 1;

  IF v_company IS NULL THEN
    -- One code for "no drivers row" and "driver deactivated": a caller
    -- must not learn which. Distinguished from no_properties_assigned,
    -- where the caller IS a live driver with nothing assigned.
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_a_driver');
  END IF;
  IF v_assigned IS NULL OR array_length(v_assigned, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'no_properties_assigned');
  END IF;

  -- 🔴 THE SCOPE GATE. Exists + active + same company, and named in the
  -- assignment (or the 'All' sentinel). All four, server-side.
  SELECT p.id, p.name, COALESCE(p.parking_tags_enabled, FALSE)
    INTO v_prop_id, v_prop_name, v_tags_on
    FROM public.properties p
   WHERE lower(trim(p.name))    = lower(trim(COALESCE(p_property, '')))
     AND lower(trim(p.company)) = v_company
     AND p.is_active
     AND ( 'All' = ANY (v_assigned)
        OR EXISTS (SELECT 1 FROM unnest(v_assigned) a(nm)
                    WHERE lower(trim(a.nm)) = lower(trim(p.name))) )
   LIMIT 1;

  IF v_prop_id IS NULL THEN
    -- One code for all four refusals on purpose: a driver must not be
    -- able to probe which of "wrong company", "deactivated" or "not
    -- yours" applies to a property name they guessed.
    RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_in_scope');
  END IF;

  -- 🔴 Reported, not inferred. With tags switched off the table simply
  -- has no rows for this property, so every lookup would come back
  -- 'unknown' — "never issued here" — which is true but reads as "that
  -- tag is bogus" when the real answer is "this lot doesn't use tags".
  -- Absence must not be the failure output. The driver portal cannot
  -- read properties at all, so this is the only place that can say it.
  IF NOT v_tags_on THEN
    RETURN jsonb_build_object('ok', TRUE, 'tag_status', 'tags_not_enabled',
                              'property', v_prop_name);
  END IF;

  v_tag := public.normalize_tag_number(p_tag);
  IF v_tag IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'tag_status', 'unreadable',
                              'property', v_prop_name);
  END IF;

  -- NULLS FIRST prefers the LIVE row when a number has been issued,
  -- collected and re-issued — the history rows are retained
  -- deliberately, so "which one" is answered explicitly.
  SELECT v.plate, v.unit, v.status, (t.voided_at IS NOT NULL)
    INTO v_reg_plate, v_reg_unit, v_reg_status, v_voided
    FROM public.vehicle_parking_tags t
    JOIN public.vehicles v ON v.id = t.vehicle_id
   WHERE t.property_id = v_prop_id
     AND t.tag_number  = v_tag
   ORDER BY t.voided_at NULLS FIRST, t.assigned_at DESC
   LIMIT 1;
  v_found := FOUND;

  IF NOT v_found THEN
    RETURN jsonb_build_object('ok', TRUE, 'tag_status', 'unknown',
                              'tag_number', v_tag, 'property', v_prop_name);
  END IF;

  IF v_voided THEN
    -- The registered plate is NOT returned for a voided tag. The tag is
    -- out of service; which car used to hold it is not the driver's
    -- business and is the one field that would turn this surface into a
    -- plate directory.
    RETURN jsonb_build_object('ok', TRUE, 'tag_status', 'voided',
                              'tag_number', v_tag, 'property', v_prop_name);
  END IF;

  v_plate_norm := CASE
    WHEN p_plate IS NULL THEN NULL
    ELSE upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'))
  END;

  RETURN jsonb_build_object(
    'ok',          TRUE,
    'tag_status',  CASE
                     WHEN v_plate_norm IS NULL OR v_plate_norm = '' THEN 'issued'
                     WHEN upper(regexp_replace(v_reg_plate, '[^A-Za-z0-9]', '', 'g')) = v_plate_norm THEN 'match'
                     ELSE 'mismatch'
                   END,
    'tag_number',  v_tag,
    'property',    v_prop_name,
    -- Minimised per B225: plate + unit + the vehicle's own status. No
    -- resident_email, no make/model/colour — the driver is comparing a
    -- hangtag to the car in front of them, not browsing residents.
    'plate',         v_reg_plate,
    'unit',          v_reg_unit,
    'vehicle_status',v_reg_status
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.driver_tag_lookup(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_tag_lookup(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_tag_lookup(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_tag_lookup(TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.driver_tag_lookup(TEXT, TEXT, TEXT) IS
  'Driver-facing parking tag lookup, scoped SERVER-SIDE. Refuses a caller with no drivers row or a deactivated one (get_my_driver_assigned_properties does not check drivers.is_active, so this function does), and a property that does not exist, is not active, belongs to another company, or is not in the caller''s assigned_properties (the ''All'' sentinel still requires the first three). That is deliberately stronger than the portal''s plate predicates, which scope by a client-side filter and never validate the assignment — a filed, open defect this surface does not inherit. Returns tag_status: tags_not_enabled / unreadable / unknown / voided / issued / match / mismatch. tags_not_enabled is reported rather than left to be inferred from an empty result, because with the switch off every tag would otherwise read as ''never issued here''. A voided tag does NOT return the plate that held it. A tag NEVER decides authorization: the plate''s own status is reported separately and the driver''s plate cascade is untouched, so a tag finding cannot suppress a protective record.';
