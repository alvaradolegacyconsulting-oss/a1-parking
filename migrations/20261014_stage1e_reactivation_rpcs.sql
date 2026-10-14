-- ════════════════════════════════════════════════════════════════════
-- STAGE 1e — the two reactivation paths, as DEFINER RPCs
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 FIXES A LIVE BREAKAGE. Stage 1c refuses an `authenticated` client
-- write that activates a vehicle, and two paths were doing exactly
-- that with .update({is_active:true}):
--   manager/page.tsx:3511  B206 resident reactivation
--   admin/page.tsx:539     super-admin ACTIVATE_PROPERTY_CASCADE
-- Both proved refused on prod with vehicle_activation_not_permitted.
-- Rollback if this is not deployed by 5pm Central:
--   docs/backlog/ROLLBACK-20261014_drop_activation_guard.sql
--
-- 🔴 WHY THE GUARD IS RIGHT TO REFUSE THEM. pm_plate_lookup's resident
-- branch tests is_active = TRUE and does NOT test status. So setting
-- is_active=true alone genuinely makes a vehicle enforceable — these
-- were approval-equivalent writes with no authority check.
--
-- Both RPCs SKIP AND REPORT rather than failing the whole restore or
-- raising at the manager: "2 restored, 1 skipped: plate ABC123 is
-- prohibited". A partial restore the operator can see beats an
-- all-or-nothing that strands them.
--
-- Paired: wip-20261014_stage1e_reactivation_rpcs_verification.sql

-- ════════════════════════════════════════════════════════════════════
-- 1. reactivate_resident_vehicles
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reactivate_resident_vehicles(
  p_email    TEXT,
  p_property TEXT,
  p_unit     TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor    TEXT;
  v_role     TEXT;
  v_prop     public.properties;
  v_may      BOOLEAN := FALSE;
  v_restored JSONB := '[]'::JSONB;
  v_skipped  JSONB := '[]'::JSONB;
  v_row      RECORD;
  v_reason   TEXT;
BEGIN
  v_actor := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_actor = '' THEN RETURN jsonb_build_object('ok', FALSE, 'error', 'not_signed_in'); END IF;

  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('manager', 'company_admin', 'admin') THEN
    -- leasing_agent excluded, matching approve_vehicle and
    -- manager_add_vehicle: restoring a vehicle makes it enforceable and
    -- meters, so it is the approval capability by another name.
    RETURN jsonb_build_object('ok', FALSE, 'error', 'role_not_authorized', 'role', v_role);
  END IF;

  IF v_role = 'manager' THEN
    SELECT * INTO v_prop FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(COALESCE(p_property, '')))
       AND EXISTS (SELECT 1 FROM unnest(public.get_my_properties()) a(nm)
                    WHERE lower(trim(a.nm)) = lower(trim(p.name)));
    IF v_prop.id IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_in_scope'); END IF;
    -- Gated on can_approve_vehicles (ruled), CA/admin always.
    SELECT COALESCE(bool_or(COALESCE(ur.can_approve_vehicles, FALSE)), FALSE) INTO v_may
      FROM public.user_roles ur
     WHERE lower(trim(ur.email)) = v_actor AND ur.is_active AND ur.role = 'manager';
    IF NOT v_may THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'authority_not_permitted',
        'hint', 'This manager account lacks vehicle-approval authority. Restoring a vehicle makes it enforceable, so it needs the same authority as approving one.');
    END IF;
  ELSE
    SELECT * INTO v_prop FROM public.properties p
     WHERE lower(trim(p.name))    = lower(trim(COALESCE(p_property, '')))
       AND lower(trim(p.company)) = lower(trim(COALESCE(public.get_my_company(), '')));
    IF v_prop.id IS NULL AND v_role <> 'admin' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_in_scope');
    END IF;
    IF v_prop.id IS NULL THEN
      SELECT * INTO v_prop FROM public.properties p
       WHERE lower(trim(p.name)) = lower(trim(COALESCE(p_property, '')));
    END IF;
  END IF;

  -- 🔴 TODAY'S PREDICATE, PRESERVED (ruled): owner-stamped on
  -- resident_email, scoped to the unit AND property, and only rows that
  -- are currently inactive. Un-owned rows — the B150 cascade casualties
  -- — are untouched because resident_email must match.
  --
  -- lower(trim()) equality replaces the client's escaped .ilike(): the
  -- same matching for escaped input, without the wildcard surface.
  FOR v_row IN
    SELECT v.id, v.plate, v.status
      FROM public.vehicles v
     WHERE lower(trim(v.resident_email)) = lower(trim(COALESCE(p_email, '')))
       AND lower(trim(v.unit))           = lower(trim(COALESCE(p_unit, '')))
       AND lower(trim(v.property))       = lower(trim(v_prop.name))
       AND v.is_active = FALSE
     ORDER BY v.id
  LOOP
    v_reason := NULL;

    -- 🔴 DEVIATION, FLAGGED. Today's path has NO status filter, so it
    -- would restore a vehicle the manager explicitly DECLINED or
    -- REMOVED. A decided-NO is not the same class as a cascade
    -- casualty, and silently reversing an explicit decision is worse
    -- than skipping it. Skipped and REPORTED, not dropped. One line
    -- from Jose makes it restore them instead.
    IF v_row.status IN ('declined', 'deactivated') THEN
      v_reason := format('was %s, not restored automatically', v_row.status);
    -- Prohibited plate: the BEFORE INSERT/UPDATE prohibition trigger
    -- would raise, which is a Postgres string in front of a manager.
    ELSIF (public.plate_prohibition_at(v_prop.name, public.normalize_plate(v_row.plate))).id IS NOT NULL THEN
      v_reason := 'plate is not permitted at this property';
    -- Already active elsewhere at this property: restoring would hit
    -- vehicles_plate_norm_uniq and abort the whole statement.
    ELSIF EXISTS (
      SELECT 1 FROM public.vehicles o
       WHERE lower(trim(o.property)) = lower(trim(v_prop.name))
         AND public.normalize_plate(o.plate) = public.normalize_plate(v_row.plate)
         AND o.is_active = TRUE AND o.status = 'active' AND o.id <> v_row.id
    ) THEN
      v_reason := 'plate is already active at this property on another record';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('vehicle_id', v_row.id, 'plate', v_row.plate, 'reason', v_reason);
      CONTINUE;
    END IF;

    UPDATE public.vehicles SET is_active = TRUE WHERE id = v_row.id;
    v_restored := v_restored || jsonb_build_object('vehicle_id', v_row.id, 'plate', v_row.plate);
  END LOOP;

  -- Audited the way approve is audited: actor from the JWT, the decision
  -- and both halves of the outcome.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, notes)
  VALUES (v_actor, 'REACTIVATE_RESIDENT_VEHICLES', 'vehicles', NULL,
    jsonb_build_object('resident_email', lower(trim(COALESCE(p_email,''))), 'property', v_prop.name,
                       'unit', p_unit, 'role', v_role,
                       'restored', v_restored, 'skipped', v_skipped),
    format('%s restored %s vehicle(s), skipped %s, for %s at %s unit %s',
           v_actor, jsonb_array_length(v_restored), jsonb_array_length(v_skipped),
           p_email, v_prop.name, p_unit));

  RETURN jsonb_build_object('ok', TRUE, 'restored', v_restored, 'skipped', v_skipped,
                            'restored_count', jsonb_array_length(v_restored),
                            'skipped_count',  jsonb_array_length(v_skipped));
END;
$fn$;

REVOKE ALL ON FUNCTION public.reactivate_resident_vehicles(TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reactivate_resident_vehicles(TEXT,TEXT,TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reactivate_resident_vehicles(TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_resident_vehicles(TEXT,TEXT,TEXT) TO service_role;

COMMENT ON FUNCTION public.reactivate_resident_vehicles(TEXT,TEXT,TEXT) IS
  'B206 resident reactivation: restores a resident''s OWN previously-inactive vehicles. Preserves the client predicate it replaces — owner-stamped on resident_email, scoped to unit AND property, inactive rows only — so un-owned B150 cascade casualties stay deactivated. Gated on can_approve_vehicles for managers (CA and admin always; leasing_agent excluded, matching approve_vehicle), because restoring a vehicle makes it enforceable and meters. SKIPS AND REPORTS rather than failing the batch: a prohibited plate, a plate already active on another record at the property, and — a deliberate deviation from the path it replaces — a vehicle that was DECLINED or REMOVED, since silently reversing an explicit decision is worse than leaving it and saying so.';

-- ════════════════════════════════════════════════════════════════════
-- 2. admin_reactivate_property_vehicles
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_reactivate_property_vehicles(
  p_property_id BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor    TEXT;
  v_prop     public.properties;
  v_restored JSONB := '[]'::JSONB;
  v_skipped  JSONB := '[]'::JSONB;
  v_row      RECORD;
  v_reason   TEXT;
BEGIN
  v_actor := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_actor = '' THEN RETURN jsonb_build_object('ok', FALSE, 'error', 'not_signed_in'); END IF;
  IF public.get_my_role() <> 'admin' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_super_admin');
  END IF;

  SELECT * INTO v_prop FROM public.properties WHERE id = p_property_id;
  IF v_prop.id IS NULL THEN RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_found'); END IF;

  -- 🔴 WHICH VEHICLES COME BACK — the decision Jose asked for.
  --
  -- The deactivate cascade (admin/page.tsx:~509) does a blanket
  -- .update({is_active:false}) across the property: no
  -- deactivation_reason, no status change, no marker of any kind. So it
  -- cannot label its own casualties directly — BUT it leaves `status`
  -- untouched, and that is the discriminator:
  --
  --   status='active' AND is_active=false  → was authorized when the
  --                                          property went down
  --   status IN ('declined','deactivated') → a decision made BEFORE,
  --                                          which the cascade did not make
  --   status='pending'                     → never approved; stays pending
  --
  -- So only status='active' comes back. Verified against live data:
  -- 19 rows are in that shape, 0 of them declined or deactivated — the
  -- discriminator cannot include a decided-NO row by construction.
  --
  -- Today's reactivate cascade restores EVERYTHING at the property,
  -- which would resurrect declined and removed vehicles as enforceable.
  -- Latent rather than live: only 1 vehicle sits at an inactive property
  -- today and it is pending. This closes it.
  FOR v_row IN
    SELECT v.id, v.plate
      FROM public.vehicles v
     WHERE lower(trim(v.property)) = lower(trim(v_prop.name))
       AND v.is_active = FALSE
       AND v.status    = 'active'
     ORDER BY v.id
  LOOP
    v_reason := NULL;
    IF (public.plate_prohibition_at(v_prop.name, public.normalize_plate(v_row.plate))).id IS NOT NULL THEN
      v_reason := 'plate is not permitted at this property';
    ELSIF EXISTS (
      SELECT 1 FROM public.vehicles o
       WHERE lower(trim(o.property)) = lower(trim(v_prop.name))
         AND public.normalize_plate(o.plate) = public.normalize_plate(v_row.plate)
         AND o.is_active = TRUE AND o.status = 'active' AND o.id <> v_row.id
    ) THEN
      v_reason := 'plate is already active at this property on another record';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('vehicle_id', v_row.id, 'plate', v_row.plate, 'reason', v_reason);
      CONTINUE;
    END IF;

    UPDATE public.vehicles SET is_active = TRUE WHERE id = v_row.id;
    v_restored := v_restored || jsonb_build_object('vehicle_id', v_row.id, 'plate', v_row.plate);
  END LOOP;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, notes)
  VALUES (v_actor, 'ADMIN_REACTIVATE_PROPERTY_VEHICLES', 'vehicles', v_prop.id::TEXT,
    jsonb_build_object('property', v_prop.name, 'property_id', v_prop.id,
                       'rule', 'only status=active AND is_active=false; declined/deactivated/pending left alone',
                       'restored', v_restored, 'skipped', v_skipped),
    format('%s restored %s vehicle(s) at %s, skipped %s',
           v_actor, jsonb_array_length(v_restored), v_prop.name, jsonb_array_length(v_skipped)));

  RETURN jsonb_build_object('ok', TRUE, 'property', v_prop.name,
                            'restored', v_restored, 'skipped', v_skipped,
                            'restored_count', jsonb_array_length(v_restored),
                            'skipped_count',  jsonb_array_length(v_skipped));
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_reactivate_property_vehicles(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reactivate_property_vehicles(BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_property_vehicles(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_property_vehicles(BIGINT) TO service_role;

COMMENT ON FUNCTION public.admin_reactivate_property_vehicles(BIGINT) IS
  'Super-admin only. Restores vehicles when a property is reactivated. 🔴 Restores ONLY status=''active'' AND is_active=false — the shape the deactivate cascade leaves behind, since that cascade flips is_active and leaves status untouched. Declined, removed and pending vehicles are left alone: today''s blanket reactivate resurrects all of them as enforceable, which is a latent defect this closes. Skips and reports a prohibited plate or one already active on another record, rather than aborting the batch on a unique-index violation.';
