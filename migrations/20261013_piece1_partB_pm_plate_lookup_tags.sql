-- ════════════════════════════════════════════════════════════════════
-- PIECE 1 PART B — pm_plate_lookup: tags + the prohibited branch
-- ════════════════════════════════════════════════════════════════════
--
-- Written against the captured live body (pg_get_functiondef,
-- 2026-10-12). Everything outside the additions below is VERBATIM.
--
-- Signature: p_plate text, p_viewing_property text DEFAULT NULL
-- preserved exactly, p_tag text DEFAULT NULL appended last — so every
-- existing 2-argument caller keeps working unchanged.
--
-- 🔴 DROP + CREATE, not CREATE OR REPLACE. Adding a third parameter
-- makes a DIFFERENT function: f(text,text) and f(text,text,text) would
-- coexist and PostgREST answers PGRST203 on the ambiguous call. The
-- captured overload_count is 1 and the verification asserts it is still
-- 1 afterwards.
--
-- Grants re-issued to exactly what the capture recorded:
--   proacl = postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres
-- No anon. SECURITY DEFINER, VOLATILE, search_path = public, pg_temp,
-- all preserved.
--
-- ── THE ADDITIONS, in full ──────────────────────────────────────────
--
--  1. p_tag parameter + v_tag_* / v_prohibited / v_plate_vehicle_id decls.
--
--  2. Branch 1 also captures v.id into v_plate_vehicle_id. Required: a
--     tag can only be called a mismatch by comparing it against the
--     vehicle the PLATE resolved to. The branch's predicates are
--     untouched — including testing is_active only and not status,
--     which is ruled intentional (under-review vehicles stay protected
--     during plate review).
--
--  3. A prohibited branch.
--
--     🔴 PLACED JUST BEFORE 'unauthorized', NOT IMMEDIATELY AFTER DNT.
--     The ruling said "after DNT"; this is after DNT, and also after
--     every protective branch, because plate_status.ts records the
--     ranking decision explicitly: "Ranked below every protective
--     status deliberately. A prohibition cannot outrank a live grant in
--     the HEADLINE." Putting it right after DNT would rank it ABOVE
--     resident, so a prohibited plate that still holds a live grant
--     would read as refused — and the two are kept from colliding by
--     add_plate_prohibition revoking conflicting grants when the
--     prohibition is created, not by this branch winning a race.
--     One line from Jose moves it if that reading is wrong.
--
--     reason is NEVER returned for a prohibition — the existing
--     'reason' field in the return belongs to do_not_tow and keeps
--     only that meaning.
--
--  4. Tag evaluation AFTER the cascade, never inside it.
--
--     🔴 tag_mismatch / tag_voided BECOME the result_type ONLY when the
--     plate itself came back 'unauthorized'. They never replace a
--     protective status. The plate is the source of truth: a resident
--     whose car displays the wrong tag is still authorized, and
--     downgrading them because a tag was swapped would be a
--     false-negative on enforcement — the same class as removing the
--     per-property filter from the driver lookup. For a protected
--     plate the tag rides along in tag_status, so the manager sees
--     "authorized, but that tag is not this car's".
--
--  5. Return gains tag_number + tag_status; the audit row gains them too.
--
-- 🔴 CLIENT, SAME COMMIT: app/manager/page.tsx:1281 whitelists
-- result_type and degrades anything unlisted to "Unexpected response
-- from server." It must gain 'tag_mismatch', 'tag_voided', 'prohibited'
-- AND 'do_not_tow' — do_not_tow has been missing since the DNT branch
-- shipped, latent only because do_not_tow_plates is empty (0 rows, 0 of
-- 67 sampled lookups). The CA portal needs no change: this function
-- raises for any role outside manager/leasing_agent.
--
-- Paired: wip-20261013_piece1_partB_pm_plate_lookup_tags_verification.sql

BEGIN;

DROP FUNCTION IF EXISTS public.pm_plate_lookup(text, text);

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(
  p_plate            text,
  p_viewing_property text DEFAULT NULL::text,
  p_tag              text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_email          TEXT;
  v_role                  TEXT;
  v_properties            TEXT[];
  v_properties_normalized TEXT[];
  v_normalized            TEXT;
  v_vehicle_unit          TEXT;
  v_visitor_unit          TEXT;
  v_guest_name            TEXT;
  v_guest_unit            TEXT;
  v_guest_end             DATE;
  v_result_type           TEXT;
  v_unit_number           TEXT;
  v_dnt_reason            TEXT;
  v_ap_result             JSONB;
  v_ap_property_name      TEXT;
  v_ap_label              TEXT;
  -- NEW (tags + prohibition)
  v_plate_vehicle_id      BIGINT;
  v_prohibited            BOOLEAN := FALSE;
  v_tag_norm              TEXT;
  v_tag_vehicle_id        BIGINT;
  v_tag_is_voided         BOOLEAN;
  v_tag_found             BOOLEAN := FALSE;
  v_tag_status            TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  v_properties_normalized := ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p);

  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 0. Do Not Tow match (B2: parked, empty table = inert branch) ─
  -- B2 invariants preserved: dnt_p alias + lower(trim(dnt_p.company))
  -- company predicate + dnt.removed_at IS NULL + expires_at lifecycle.
  -- AP-VIEWING adds the viewing-property predicate.
  SELECT dnt.reason INTO v_dnt_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(dnt_p.name))    = ANY (v_properties_normalized)
     AND lower(trim(dnt_p.company)) = lower(trim(get_my_company()))
     AND (p_viewing_property IS NULL OR lower(trim(dnt_p.name)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  IF v_dnt_reason IS NOT NULL THEN
    v_result_type := 'do_not_tow';
    v_unit_number := NULL;
  END IF;

  -- ── Branches 1 → 1.5 → 2-6 ───────────────────────────────────────
  IF v_result_type IS NULL THEN
  -- ── 1. Resident match (active permit) ──────────────────────────
  -- NEW: also captures v.id, so the tag check below can tell whether a
  -- scanned tag belongs to THIS vehicle. Predicates unchanged.
  SELECT v.unit, v.id INTO v_vehicle_unit, v_plate_vehicle_id
  FROM vehicles v
  WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
    AND v.is_active = TRUE
    AND lower(trim(v.property)) = ANY (v_properties_normalized)
    AND (p_viewing_property IS NULL OR lower(trim(v.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 1.5 Authorized plate (AP-CASCADE) ─────────────────────
    -- AP-VIEWING: argument change — NULL → p_viewing_property.
    -- check_authorized_plate already scopes on p_property; we
    -- just pass the manager's viewing property through instead
    -- of asking "any of your assigned properties."
    v_ap_result := public.check_authorized_plate(v_normalized, p_viewing_property);   -- NEW (AP-VIEWING)
    IF COALESCE((v_ap_result->>'is_authorized')::boolean, FALSE) THEN
      v_result_type      := 'authorized_plate';
      v_unit_number      := NULL;
      v_ap_property_name := v_ap_result->>'property_name';
      v_ap_label         := v_ap_result->>'label';
    END IF;

    IF v_result_type IS NULL THEN
    -- ── 2. Pending permit match (B230) ────────────────────────────
    SELECT v.unit INTO v_vehicle_unit
    FROM vehicles v
    WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND v.is_active = FALSE
      AND v.status    = 'pending'
      AND lower(trim(v.property)) = ANY (v_properties_normalized)
      AND (p_viewing_property IS NULL OR lower(trim(v.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
    LIMIT 1;

    IF v_vehicle_unit IS NOT NULL THEN
      v_result_type := 'pending';
      v_unit_number := v_vehicle_unit;
    ELSE
      -- ── 3. Plate-change pending match (B230) ────────────────────
      SELECT v.unit INTO v_vehicle_unit
      FROM vehicle_plate_changes vpc
      JOIN vehicles v ON v.id = vpc.vehicle_id
      WHERE upper(regexp_replace(vpc.new_plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vpc.status = 'pending'
        AND lower(trim(vpc.property)) = ANY (v_properties_normalized)
        AND (p_viewing_property IS NULL OR lower(trim(vpc.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
      ORDER BY vpc.submitted_at DESC
      LIMIT 1;

      IF v_vehicle_unit IS NOT NULL THEN
        v_result_type := 'plate_under_review';
        v_unit_number := v_vehicle_unit;
      ELSE
        -- ── 4. Guest authorization match (B220 stage 2.5) ────────
        -- 2026-08-05: CURRENT_DATE → public.current_date_central()
        -- (Commit B of guest-auth CURRENT_DATE fix). start_date and
        -- end_date are DATE columns; the helper returns DATE in
        -- America/Chicago. See helper header for rationale.
        SELECT
          ga.guest_name,
          ga.visiting_unit,
          ga.end_date
        INTO
          v_guest_name,
          v_guest_unit,
          v_guest_end
        FROM guest_authorizations ga
        WHERE upper(regexp_replace(ga.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
          AND ga.is_active = TRUE
          AND ga.status = 'active'
          AND ga.start_date <= public.current_date_central()   -- was CURRENT_DATE
          AND ga.end_date   >= public.current_date_central()   -- was CURRENT_DATE
          AND lower(trim(ga.property)) = ANY (v_properties_normalized)
          AND (p_viewing_property IS NULL OR lower(trim(ga.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
        ORDER BY ga.end_date DESC
        LIMIT 1;

        IF v_guest_unit IS NOT NULL THEN
          v_result_type := 'guest_authorized';
          v_unit_number := v_guest_unit;
        ELSE
          -- ── 5. Visitor pass match ─────────────────────────────
          SELECT vp.visiting_unit INTO v_visitor_unit
          FROM visitor_passes vp
          WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
            AND vp.is_active = TRUE
            AND vp.expires_at > now()
            AND lower(trim(vp.property)) = ANY (v_properties_normalized)
            AND (p_viewing_property IS NULL OR lower(trim(vp.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
          ORDER BY vp.expires_at DESC
          LIMIT 1;

          IF FOUND THEN
            v_result_type := 'visitor';
            v_unit_number := v_visitor_unit;
          ELSE
            -- ── 5.5 Prohibited (NEW 2026-10-13) ─────────────────
            -- Mirrors branch 0's shape exactly: join properties,
            -- company predicate, viewing-property predicate,
            -- removed_at IS NULL, expires_at lifecycle. Ranked here
            -- rather than after DNT so it cannot outrank a live
            -- grant — see the header.
            SELECT TRUE INTO v_prohibited
              FROM public.property_plate_prohibitions pp
              JOIN public.properties pp_p ON pp_p.id = pp.property_id
             WHERE pp.plate = v_normalized
               AND lower(trim(pp_p.name))    = ANY (v_properties_normalized)
               AND lower(trim(pp_p.company)) = lower(trim(get_my_company()))
               AND (p_viewing_property IS NULL OR lower(trim(pp_p.name)) = lower(trim(p_viewing_property)))
               AND pp.removed_at IS NULL
               AND (pp.expires_at IS NULL OR pp.expires_at > now())
             LIMIT 1;

            IF COALESCE(v_prohibited, FALSE) THEN
              v_result_type := 'prohibited';
              v_unit_number := NULL;
            ELSE
              -- ── 6. Unauthorized ─────────────────────────────────
              v_result_type := 'unauthorized';
              v_unit_number := NULL;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
    END IF;
  END IF;
  END IF;

  -- ── 6.5 Parking tag check (NEW 2026-10-13) ──────────────────────
  -- Runs AFTER the cascade, never inside it. A tag corroborates a
  -- plate; it never decides authorization, because the plate is the
  -- source of truth.
  IF p_tag IS NOT NULL THEN
    v_tag_norm := public.normalize_tag_number(p_tag);
    IF v_tag_norm IS NOT NULL THEN
      -- NULLS FIRST on voided_at prefers the LIVE row when a number has
      -- been issued, collected and re-issued: the history rows are kept
      -- deliberately, so "which one" has to be answered explicitly.
      SELECT t.vehicle_id, (t.voided_at IS NOT NULL)
        INTO v_tag_vehicle_id, v_tag_is_voided
        FROM public.vehicle_parking_tags t
        JOIN public.properties tp ON tp.id = t.property_id
       WHERE t.tag_number = v_tag_norm
         AND lower(trim(tp.name))    = ANY (v_properties_normalized)
         AND lower(trim(tp.company)) = lower(trim(get_my_company()))
         AND (p_viewing_property IS NULL OR lower(trim(tp.name)) = lower(trim(p_viewing_property)))
       ORDER BY t.voided_at NULLS FIRST, t.assigned_at DESC
       LIMIT 1;
      v_tag_found := FOUND;

      IF NOT v_tag_found THEN
        -- Never issued at this property. Reported, but it does not
        -- change the plate's answer.
        v_tag_status := 'unknown';
      ELSIF v_tag_is_voided THEN
        v_tag_status := 'voided';
      ELSIF v_plate_vehicle_id IS NOT NULL AND v_tag_vehicle_id = v_plate_vehicle_id THEN
        v_tag_status := 'match';
      ELSE
        v_tag_status := 'mismatch';
      END IF;

      -- 🔴 Only an UNAUTHORIZED plate is re-labelled by its tag. A
      -- protective result stands and carries tag_status alongside it.
      IF v_result_type = 'unauthorized' THEN
        IF v_tag_status = 'voided' THEN
          v_result_type := 'tag_voided';
        ELSIF v_tag_status = 'mismatch' THEN
          v_result_type := 'tag_mismatch';
        END IF;
      END IF;
    ELSE
      v_tag_status := 'unreadable';   -- given, but nothing alphanumeric in it
    END IF;
  END IF;

  -- ── 7. Audit write ──────────────────────────────────────────────
  -- AP-VIEWING rename: properties_searched → properties_in_scope.
  -- Historical audit rows keep 'properties_searched' key; new rows use
  -- 'properties_in_scope' + 'viewing_property'. Forensic queries
  -- spanning pre/post-2026-07-24 need both keys.
  --   properties_in_scope: caller's RLS-equivalent portfolio
  --   viewing_property:    narrowing filter actually applied (may be NULL
  --                        when called without a viewing property; today
  --                        only the manager Plate Lookup client calls it,
  --                        and it always passes manager.name)
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_in_scope',  to_jsonb(v_properties),
      'viewing_property',     p_viewing_property,
      'tag_number',           v_tag_norm,     -- NEW
      'tag_status',           v_tag_status    -- NEW
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',       v_result_type,
    'unit_number',       v_unit_number,
    'guest_name',        v_guest_name,
    'valid_through',     v_guest_end,
    'reason',            v_dnt_reason,
    'ap_property_name',  v_ap_property_name,
    'ap_label',          v_ap_label,
    'tag_number',        v_tag_norm,          -- NEW
    'tag_status',        v_tag_status         -- NEW
  );
END;
$function$;

-- Grants re-issued to exactly the captured proacl. postgres is the
-- owner and holds EXECUTE implicitly; no anon.
REVOKE ALL ON FUNCTION public.pm_plate_lookup(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.pm_plate_lookup(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_plate_lookup(text, text, text) TO service_role;

COMMENT ON FUNCTION public.pm_plate_lookup(text, text, text) IS
  'Manager/leasing-agent plate lookup. Cascade: do_not_tow -> resident -> authorized_plate -> pending -> plate_under_review -> guest_authorized -> visitor -> prohibited -> unauthorized. p_tag is optional and NEVER decides authorization: a tag corroborates the plate, which stays the source of truth. tag_status is always reported (match / mismatch / voided / unknown / unreadable), but result_type is only re-labelled to tag_mismatch or tag_voided when the plate itself came back unauthorized — downgrading a protected plate because someone hung the wrong tag would be a false negative on enforcement. prohibited is ranked below every protective branch per plate_status.ts; its reason is never returned.';

COMMIT;
