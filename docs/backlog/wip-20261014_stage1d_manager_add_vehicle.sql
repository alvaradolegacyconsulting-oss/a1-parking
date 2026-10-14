-- ════════════════════════════════════════════════════════════════════
-- STAGE 1d — manager_add_vehicle: the only add path
-- ════════════════════════════════════════════════════════════════════
--
-- Ships BEFORE Stage 1c (ruled). 1c refuses INSERT-as-active for
-- `authenticated`; if the add paths still insert directly, flagged
-- managers' "Add vehicle" breaks the moment 1c lands. So this lands and
-- is confirmed first.
--
-- ── WHY AN RPC AND NOT A TRIGGER THAT REWRITES status ───────────────
-- A trigger that silently downgraded an insert to 'pending' would be a
-- LYING SUCCESS: the client asked for active, the row stored pending,
-- and nothing in the response says which happened. The ruling requires
-- the opposite — "must never report the vehicle as active when it's
-- pending" — which only a function that RETURNS the decision can do.
-- Mechanism follows outcome: a trigger is right when the outcome is
-- refusal, an RPC when the outcome is "store it differently AND say so".
--
-- ── THE THREE CALL SITES THIS REPLACES ──────────────────────────────
--   manager/page.tsx:2699  handleAddVehicleSubmit   (LIVE)
--   manager/page.tsx:3038  addResident cascade      (LIVE)
--   manager/page.tsx:2587  legacy addVehicle        (unreachable today)
--
-- 🔴 The legacy one is wired too. Its callers sit in !PM_CRM_ENABLED
-- blocks, but that flag's own comment says "flip to false to fall back
-- to the legacy" — it is a ROLLBACK path, not dead code. Leaving it
-- unwired means a rollback to legacy breaks Add Vehicle after 1c.
--
-- Service-role paths are NOT routed through this and must not be:
-- /api/register/companion-vehicle, /api/billing/bulk-invite (B113) and
-- the prospect-demo seeder all insert as service_role, which 1c lets
-- through on current_user. Routing them here would require a JWT they
-- do not have.
--
-- Paired: wip-20261014_stage1d_manager_add_vehicle_verification.sql

-- ── 1. Audit honesty fix, coupled to this change ────────────────────
-- via_approve_rpc read FALSE on an INSERT, which is a positive claim
-- ("not via the RPC") about something that does not apply — an INSERT
-- has no prior state to have been flipped from. It is now NULL for
-- INSERT, and a new via_add_rpc answers the question that DOES apply:
-- did this row arrive through manager_add_vehicle?
CREATE OR REPLACE FUNCTION public.vehicles_audit_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor TEXT;
  v_old   JSONB;
BEGIN
  v_actor := COALESCE(NULLIF(lower(trim(COALESCE(auth.jwt() ->> 'email', ''))), ''), 'system');

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NULL;
    END IF;
    v_old := jsonb_build_object('status', OLD.status, 'is_active', OLD.is_active);
  ELSE
    v_old := NULL;
  END IF;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, notes)
  VALUES (
    v_actor,
    'VEHICLE_STATE_CHANGE',
    'vehicles',
    NEW.id::TEXT,
    v_old,
    jsonb_build_object(
      'status',        NEW.status,
      'is_active',     NEW.is_active,
      'property',      NEW.property,
      'company',       NEW.company,
      'plate',         NEW.plate,
      'unit',          NEW.unit,
      'vehicle_id',    NEW.id,
      'op',            TG_OP,
      -- NULL on INSERT: "was this an approve of an existing row" has no
      -- answer for a row that did not exist. false would be a claim.
      'via_approve_rpc',
        CASE WHEN TG_OP = 'INSERT' THEN NULL
             ELSE to_jsonb(COALESCE(current_setting('app.vehicle_approve_id', TRUE) = NEW.id::TEXT, FALSE)) END,
      -- and the question that does apply to an INSERT
      'via_add_rpc',
        CASE WHEN TG_OP = 'INSERT'
             THEN to_jsonb(COALESCE(current_setting('app.vehicle_add_rpc', TRUE) = '1', FALSE))
             ELSE NULL END
    ),
    format('vehicle %s (%s) at %s: %s -> %s',
           NEW.id, NEW.plate, NEW.property,
           CASE WHEN TG_OP = 'INSERT' THEN '(new)'
                ELSE format('is_active=%s status=%s', OLD.is_active, OLD.status) END,
           format('is_active=%s status=%s', NEW.is_active, NEW.status))
  );
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM anon;
REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM authenticated;

-- ── 2. The add path ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.manager_add_vehicle(
  p_property       TEXT,
  p_unit           TEXT,
  p_resident_email TEXT,
  p_plate          TEXT,
  p_state          TEXT,
  p_make           TEXT DEFAULT NULL,
  p_model          TEXT DEFAULT NULL,
  p_year           INT  DEFAULT NULL,
  p_color          TEXT DEFAULT NULL,
  p_space          TEXT DEFAULT NULL,
  p_tag            TEXT DEFAULT NULL,
  -- 🔴 Carried ONLY to preserve the legacy add form exactly. That form
  -- is reachable only under the !PM_CRM_ENABLED rollback switch, and
  -- permit_expiry is non-null on 0 of 847 vehicles — the field is
  -- effectively unused. But dropping it would narrow a live (if
  -- dormant) path, and the prime directive is not to change current
  -- processes. Its retirement is filed separately, as ruled; this
  -- parameter does not touch its semantics.
  p_permit_expiry  DATE DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email       TEXT;
  v_role        TEXT;
  v_prop        public.properties;
  v_tier        TEXT;
  v_plate       TEXT;
  v_in_scope    BOOLEAN := FALSE;
  v_may_approve BOOLEAN := FALSE;
  v_want_active BOOLEAN;
  v_clash_plate TEXT; v_clash_unit TEXT; v_clash BOOLEAN;
  v_new_id      BIGINT;
  v_tag_result  JSONB;
BEGIN
  v_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_signed_in');
  END IF;

  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('manager', 'leasing_agent', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'role_not_authorized', 'role', v_role);
  END IF;

  v_plate := public.normalize_plate(p_plate);
  IF COALESCE(v_plate, '') = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'plate_required');
  END IF;
  IF COALESCE(trim(p_unit), '') = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'unit_required');
  END IF;

  -- Scope. Resolved the same way the rest of the system does, and the
  -- company side is taken from the PROPERTY row, never from an argument.
  IF v_role IN ('manager', 'leasing_agent') THEN
    SELECT * INTO v_prop FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(COALESCE(p_property, '')))
       AND EXISTS (SELECT 1 FROM unnest(public.get_my_properties()) a(nm)
                    WHERE lower(trim(a.nm)) = lower(trim(p.name)))
     LIMIT 1;
  ELSE
    SELECT * INTO v_prop FROM public.properties p
     WHERE lower(trim(p.name))    = lower(trim(COALESCE(p_property, '')))
       AND lower(trim(p.company)) = lower(trim(COALESCE(public.get_my_company(), '')))
     LIMIT 1;
  END IF;
  v_in_scope := v_prop.id IS NOT NULL;
  IF NOT v_in_scope THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_in_scope');
  END IF;
  IF NOT COALESCE(v_prop.is_active, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'property_not_active');
  END IF;

  -- ── Does this row land ACTIVE or PENDING? ─────────────────────────
  -- 🔴 AUTHORITY ALONE DECIDES. The tier does NOT gate this, and an
  -- earlier draft of this function had it wrong.
  --
  -- initialVehicleState(tier) returns pending for pm_only, which reads
  -- like a second gate — but it is only the INITIAL state of a
  -- TWO-STEP: the existing add path inserts pending and then calls
  -- approveVehicleWrite inline, so a flagged manager on a pm_only tier
  -- ends up ACTIVE today. Treating pm_only as "always pending" here
  -- would leave those rows pending forever and change a live process,
  -- against the prime directive.
  --
  -- The permit door governs RESIDENT self-registration (/register →
  -- pending for PM approval), not a staff member's own add. The tier is
  -- still read, for the audit row, because "which tier was this on" is
  -- the question someone will ask later.
  SELECT c.tier INTO v_tier FROM public.companies c
   WHERE lower(trim(c.name)) = lower(trim(v_prop.company)) LIMIT 1;

  -- Approval authority. CA and super-admin always.
  --
  -- 🔴 DEVIATION FROM THE RULING, FLAGGED FOR JOSE.
  -- The ruling says "a manager/leasing agent with can_approve_vehicles
  -- may insert directly as active". Implemented literally, a flagged
  -- LEASING AGENT could create an active vehicle — while
  -- approve_vehicle refuses leasing_agent outright, so the same person
  -- cannot approve a pending one. That is an escalation by the back
  -- door: the capability they are denied, reached through a different
  -- verb. So leasing_agent lands PENDING here regardless of the flag,
  -- which is the fail-closed reading and consistent with every other
  -- surface. One line from Jose makes it match the literal ruling.
  IF v_role IN ('company_admin', 'admin') THEN
    v_may_approve := TRUE;
  ELSIF v_role = 'manager' THEN
    SELECT COALESCE(bool_or(COALESCE(ur.can_approve_vehicles, FALSE)), FALSE)
      INTO v_may_approve
      FROM public.user_roles ur
     WHERE lower(trim(ur.email)) = v_email
       AND ur.is_active AND ur.role = 'manager';
  ELSE
    v_may_approve := FALSE;   -- leasing_agent
  END IF;

  -- Authority alone. See the note above on why the tier is not a term.
  v_want_active := v_may_approve;

  -- ── Refusals that must happen BEFORE the insert ───────────────────
  -- The prohibition trigger and the unique index would both raise, and
  -- a raised error is a Postgres string in the UI. Pre-checking turns
  -- each into a code with a sentence.
  IF (public.plate_prohibition_at(v_prop.name, v_plate)).id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'plate_prohibited', 'plate', v_plate);
  END IF;

  SELECT v.plate, v.unit INTO v_clash_plate, v_clash_unit
    FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_prop.name))
     AND public.normalize_plate(v.plate) = v_plate
     AND v.is_active = TRUE AND v.status = 'active'
   LIMIT 1;
  v_clash := FOUND;
  IF v_clash THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'plate_already_active',
                              'plate', v_clash_plate, 'existing_unit', v_clash_unit);
  END IF;

  -- ── The insert ────────────────────────────────────────────────────
  -- Annotates itself so the audit row can say the row arrived through
  -- this RPC. Transaction-local. An AUDIT ANNOTATION, not a control —
  -- Stage 1c keys on current_user.
  PERFORM set_config('app.vehicle_add_rpc', '1', TRUE);

  INSERT INTO public.vehicles (
    plate, state, make, model, year, color, space, permit_expiry,
    unit, property, company, resident_email, status, is_active
  ) VALUES (
    v_plate, upper(trim(COALESCE(p_state, 'TX'))),
    NULLIF(trim(COALESCE(p_make, '')), ''), NULLIF(trim(COALESCE(p_model, '')), ''),
    p_year, NULLIF(trim(COALESCE(p_color, '')), ''), NULLIF(trim(COALESCE(p_space, '')), ''),
    p_permit_expiry,
    trim(p_unit), v_prop.name, v_prop.company,
    lower(trim(COALESCE(p_resident_email, ''))),
    CASE WHEN v_want_active THEN 'active' ELSE 'pending' END,
    v_want_active
  )
  RETURNING id INTO v_new_id;

  -- ── Optional tag, only once the row is ACTIVE ─────────────────────
  IF COALESCE(trim(COALESCE(p_tag, '')), '') <> '' THEN
    IF v_want_active THEN
      v_tag_result := public.set_vehicle_tag(v_new_id, p_tag);
    ELSE
      -- Honest: the tag was not recorded, and why.
      v_tag_result := jsonb_build_object('ok', FALSE, 'error', 'vehicle_not_active');
    END IF;
  END IF;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, notes)
  VALUES (v_email, 'MANAGER_ADD_VEHICLE_RPC', 'vehicles', v_new_id::TEXT,
    jsonb_build_object(
      'plate', v_plate, 'property', v_prop.name, 'unit', trim(p_unit),
      'resident_email', lower(trim(COALESCE(p_resident_email, ''))),
      'role', v_role, 'tier', v_tier,
      'may_approve', v_may_approve,
      'landed', CASE WHEN v_want_active THEN 'active' ELSE 'pending' END,
      'pending_reason', CASE
        WHEN v_want_active THEN NULL
        WHEN v_role = 'leasing_agent' THEN 'leasing_agent_no_approval_authority'
        ELSE 'no_approval_authority' END,
      'tag_result', v_tag_result),
    format('%s added %s at %s unit %s — landed %s', v_email, v_plate, v_prop.name, trim(p_unit),
           CASE WHEN v_want_active THEN 'active' ELSE 'pending' END));

  RETURN jsonb_build_object(
    'ok', TRUE,
    'action',     CASE WHEN v_want_active THEN 'added_active' ELSE 'added_pending' END,
    'vehicle_id', v_new_id,
    'plate',      v_plate,
    'status',     CASE WHEN v_want_active THEN 'active' ELSE 'pending' END,
    -- The client renders "waiting for approval" from THIS, not from a
    -- guess about the caller's role.
    'pending_reason', CASE
      WHEN v_want_active THEN NULL
      ELSE 'no_approval_authority' END,
    'tag_result', v_tag_result
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.manager_add_vehicle(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT,TEXT,TEXT,TEXT,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.manager_add_vehicle(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT,TEXT,TEXT,TEXT,DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.manager_add_vehicle(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT,TEXT,TEXT,TEXT,DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manager_add_vehicle(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT,TEXT,TEXT,TEXT,DATE) TO service_role;

COMMENT ON FUNCTION public.manager_add_vehicle(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INT,TEXT,TEXT,TEXT,DATE) IS
  'The only add-vehicle path for an authenticated staff caller. Decides active-vs-pending and RETURNS which, because a trigger that silently rewrote status would report active for a row stored pending. APPROVAL AUTHORITY ALONE decides active-vs-pending. The tier is deliberately NOT a term: initialVehicleState(tier) returns pending for pm_only, but that is only the initial state of a two-step whose second step approves inline, so a flagged manager on pm_only lands ACTIVE today and must keep doing so. The permit door governs resident self-registration, not a staff add. CA and super-admin always land active; a manager needs can_approve_vehicles; a leasing_agent lands PENDING regardless of the flag, because approve_vehicle refuses leasing_agent and letting them create an active row would reach the denied capability through a different verb. Pre-checks prohibition and duplicate-active so neither surfaces as a raised Postgres string. Service-role paths (companion-vehicle, B113 bulk invite, demo seeder) are deliberately NOT routed here — they hold no JWT, and Stage 1c lets them through on current_user.';
