-- ════════════════════════════════════════════════════════════════════
-- STAGE 1b — approve_vehicle enforces can_approve_vehicles
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 THE SECURITY HOLE. Proved by canary twice (2026-10-12, re-proved
-- 2026-10-14): a manager with user_roles.can_approve_vehicles = FALSE
-- calls approve_vehicle and gets {ok:true, action:'approved'}; the
-- vehicle becomes active. The flag was enforced ONLY in the UI
-- (manager/page.tsx:605 hides the button), so any direct RPC call —
-- or a direct PATCH — bypassed it entirely.
--
-- deactivate_vehicle has always enforced it and answers
-- authority_not_permitted. The two RPCs disagreed. This makes approve
-- match deactivate, which is also the shape the client already handles.
--
-- Ruling (Jose, 2026-10-12): only APPROVAL requires the authority,
-- because approval affects billing. Decline and Remove stay open to any
-- manager/leasing agent at their property. CAs are always allowed.
--
-- Written against the captured live body (pg_get_functiondef,
-- 2026-10-12). Everything outside the two marked additions is VERBATIM,
-- including the duplicate pre-check, the 23505 race handler, and the
-- ~~* scope predicates — those are a separate, filed ILIKE arc and are
-- NOT touched here.
--
-- 🔴 NOTE ON THE ROLE LIST, unchanged and worth stating: the captured
-- body already restricts callers to ('manager','company_admin'). So
-- leasing_agent CANNOT approve today, and neither can a super-admin.
-- Neither is a change; both are facts the authority check sits on top
-- of. Do not widen the list while adding a flag check — that would
-- hand approval to leasing agents under cover of a security fix.
--
-- CREATE OR REPLACE, not DROP + CREATE: the signature is unchanged
-- (p_vehicle_id bigint, p_manager_note text DEFAULT NULL), so there is
-- no overload to strand and no PGRST203 risk. The DEFAULT is
-- reproduced verbatim — CREATE OR REPLACE drops parameter defaults.
--
-- Paired: wip-20261014_stage1b_approve_vehicle_authority_verification.sql

CREATE OR REPLACE FUNCTION public.approve_vehicle(
  p_vehicle_id bigint,
  p_manager_note text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_role        TEXT;
  v_caller_company     TEXT;
  v_caller_properties  TEXT[];
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN := FALSE;
  v_updated            public.vehicles%ROWTYPE;
  v_clash              public.vehicles%ROWTYPE;
  v_may_approve        BOOLEAN;   -- NEW
BEGIN
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'approve_vehicle requires manager or company_admin role; got ' || v_caller_role
    );
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE p.name ~~* v_vehicle.property
         AND p.company ~~* v_caller_company
    ) INTO v_in_scope;
  END IF;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 🔴 NEW 2026-10-14 (1 of 2) — APPROVAL AUTHORITY ──────────────
  -- Managers need user_roles.can_approve_vehicles. CAs are always
  -- allowed (ruled). Checked AFTER scope so the message a manager gets
  -- is about the thing they can act on — asking their CA for the flag —
  -- rather than leaking that a vehicle exists at a property outside
  -- their scope.
  --
  -- ANY active role row for this caller carrying the flag grants it.
  -- A caller with two active rows (one flagged, one not) is already an
  -- ambiguity the rest of the system resolves the same permissive way;
  -- this is not the place to invent a stricter rule, and doing so
  -- silently would revoke approval from whoever is in that state.
  --
  -- COALESCE(..., FALSE): the column is nullable, and NULL must read as
  -- "not granted". Fail closed.
  IF v_caller_role = 'manager' THEN
    SELECT COALESCE(bool_or(COALESCE(ur.can_approve_vehicles, FALSE)), FALSE)
      INTO v_may_approve
      FROM public.user_roles ur
     WHERE lower(trim(ur.email)) = lower(trim(COALESCE(auth.jwt() ->> 'email', '')))
       AND ur.is_active
       AND ur.role = 'manager';
    IF NOT v_may_approve THEN
      -- Same error code and hint shape deactivate_vehicle already
      -- returns, so the client handles both identically.
      RETURN jsonb_build_object(
        'error', 'authority_not_permitted',
        'hint',  'This manager account lacks vehicle-approval authority.'
      );
    END IF;
  END IF;
  -- ── end addition 1 ───────────────────────────────────────────────

  IF v_vehicle.status = 'active' AND v_vehicle.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_active',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 🔴 2026-10-07 (a) — DUPLICATE PRE-CHECK ──────────────────────
  -- Same predicate as vehicles_plate_norm_uniq: normalized plate, same
  -- property, active only.
  --
  -- The clash row is in this manager's scope by construction — it is at
  -- the same property as the vehicle whose scope was just verified — so
  -- returning its unit and resident discloses nothing the manager
  -- cannot already read.
  SELECT * INTO v_clash
    FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_vehicle.property))
     AND public.normalize_plate(v.plate) = public.normalize_plate(v_vehicle.plate)
     AND v.is_active = TRUE
     AND v.status = 'active'
     AND v.id <> p_vehicle_id
   LIMIT 1;
  IF v_clash.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error',                   'plate_already_active',
      -- same_resident drives which of the two manager messages the UI
      -- shows: a duplicate to clear, or a record to deactivate first.
      'same_resident',           lower(trim(COALESCE(v_clash.resident_email, ''))) = lower(trim(COALESCE(v_vehicle.resident_email, ''))),
      'existing_vehicle_id',     v_clash.id,
      'existing_unit',           v_clash.unit,
      'existing_resident_email', v_clash.resident_email,
      'plate',                   v_clash.plate,
      'hint',                    format('Plate %s is already active at %s, unit %s.', v_clash.plate, v_clash.property, COALESCE(v_clash.unit, '?'))
    );
  END IF;

  -- ── 🔴 NEW 2026-10-14 (2 of 2) — AUDIT ANNOTATION ────────────────
  -- Stamps the vehicle id so the VEHICLE_STATE_CHANGE audit trigger can
  -- record via_approve_rpc = TRUE. Before this, that field read FALSE
  -- for every genuine approval because nothing ever set it — a field
  -- that always says "not via the RPC" is a positive claim that is
  -- simply wrong, which is worse than not recording it.
  --
  -- 🔴 THIS IS AN AUDIT ANNOTATION, NOT A SECURITY CONTROL. The guard
  -- trigger (Stage 1c) keys on current_user, which distinguishes a
  -- DEFINER RPC from a direct PATCH without a flag anyone could race.
  -- Do not build an access check on this GUC.
  --
  -- Carries the vehicle id rather than a boolean so one approve call
  -- cannot annotate a multi-row UPDATE in the same transaction.
  -- Transaction-local (third arg TRUE).
  PERFORM set_config('app.vehicle_approve_id', p_vehicle_id::TEXT, TRUE);
  -- ── end addition 2 ───────────────────────────────────────────────

  -- ── THE APPROVAL UPDATE ─────────────────────────────────────────
  -- (b) The backstop. Two managers approving two duplicate pending rows
  -- in the same instant both pass the pre-check; the index refuses the
  -- second. Without this handler that path is the original 23505 hang.
  BEGIN
    UPDATE public.vehicles
       SET is_active     = TRUE,
           status        = 'active',
           resident_read = TRUE,
           manager_note  = p_manager_note
     WHERE id = p_vehicle_id
    RETURNING * INTO v_updated;
  EXCEPTION WHEN unique_violation THEN
    -- Re-read the winner so the message names a real row rather than
    -- echoing the constraint.
    SELECT * INTO v_clash
      FROM public.vehicles v
     WHERE lower(trim(v.property)) = lower(trim(v_vehicle.property))
       AND public.normalize_plate(v.plate) = public.normalize_plate(v_vehicle.plate)
       AND v.is_active = TRUE
       AND v.status = 'active'
       AND v.id <> p_vehicle_id
     LIMIT 1;
    RETURN jsonb_build_object(
      'error',                   'plate_already_active',
      'raced',                   TRUE,
      'same_resident',           lower(trim(COALESCE(v_clash.resident_email, ''))) = lower(trim(COALESCE(v_vehicle.resident_email, ''))),
      'existing_vehicle_id',     v_clash.id,
      'existing_unit',           v_clash.unit,
      'existing_resident_email', v_clash.resident_email,
      'plate',                   COALESCE(v_clash.plate, v_vehicle.plate),
      'hint',                    'Another approval for this plate completed first.'
    );
  END;

  RETURN jsonb_build_object(
    'ok',      TRUE,
    'action',  'approved',
    'vehicle', to_jsonb(v_updated)
  );
END;
$function$;

-- Grants re-issued to exactly the captured proacl:
--   postgres=X/postgres, service_role=X/postgres, authenticated=X/postgres
-- No anon. CREATE OR REPLACE preserves them, but stating them makes a
-- drift visible in the verification rather than assumed.
REVOKE ALL ON FUNCTION public.approve_vehicle(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_vehicle(bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_vehicle(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_vehicle(bigint, text) TO service_role;

COMMENT ON FUNCTION public.approve_vehicle(bigint, text) IS
  'Approves a pending vehicle. Callers: manager (requires user_roles.can_approve_vehicles — enforced HERE since 2026-10-14; before that the flag was UI-only and any direct RPC call bypassed it) and company_admin (always allowed; approval affects billing, which is a subscriber concern). leasing_agent and super-admin are NOT callers, unchanged. Refuses with authority_not_permitted, matching deactivate_vehicle, which has always enforced the flag. Also sets the transaction-local app.vehicle_approve_id so the VEHICLE_STATE_CHANGE audit trigger can record via_approve_rpc truthfully; that GUC is an AUDIT ANNOTATION and must never be used as an access control — the guard trigger keys on current_user instead.';
