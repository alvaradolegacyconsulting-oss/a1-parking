-- ════════════════════════════════════════════════════════════════════
-- plate prohibitions — PART 3: management RPCs + revocation
-- ════════════════════════════════════════════════════════════════════
--
-- Apply AFTER parts 1 and 2.
--
-- Three RPCs and one replacement:
--   preview_plate_prohibition_impact  — the confirm dialog's counts
--   add_plate_prohibition             — create, then revoke, returning
--                                       what it ACTUALLY revoked
--   remove_plate_prohibition          — soft delete, reason REQUIRED
--   deactivate_vehicle                — REPLACED: 'plate_prohibited'
--                                       added to v_system_codes
--
-- There is deliberately NO list RPC. Managers and company admins can
-- SELECT the table directly under the part-1 RLS, and that policy
-- already returns FULL HISTORY including removed and expired rows,
-- which is the requirement. An RPC would be a second surface to keep
-- in step with the policy.
--
-- ── 🔴 PREVIEW AND APPLY SHARE ONE QUERY ────────────────────────────
-- The confirm dialog promises "this will deactivate 2 vehicles and
-- revoke 1 visitor pass", and the gate asserts the promise matches
-- reality. The only way that holds is if the preview and the executor
-- select the same rows by the same predicate — so the predicate lives
-- in ONE function, prohibition_impact_rows(), and both call it.
-- Writing it twice is how the two drift, which is the
-- preview-and-executor-share-line-items lesson from the Stripe arc.
--
-- Paired: 20261011_plate_prohibitions_verification.sql (covers all three parts)

-- ══════════════════════════════════════════════════════════════════
-- The shared impact query
-- ══════════════════════════════════════════════════════════════════
-- What an ACTIVE authorization for this plate at this property looks
-- like, across all three tables. Liveness per table:
--   vehicles           is_active AND status='active'
--   visitor_passes     is_active AND expires_at > now()   ← both
--   guest_authorizations is_active AND status='active' AND revoked_at IS NULL
--
-- 🔴 visitor_passes needs BOTH predicates. 1,846 of its rows are
-- flagged active and expired because nothing flips the flag on expiry;
-- counting on is_active alone would promise to revoke passes that died
-- weeks ago and then "revoke" them, inflating the dialog's numbers.
CREATE OR REPLACE FUNCTION public.prohibition_impact_rows(
  p_property TEXT,
  p_plate    TEXT
)
RETURNS TABLE (kind TEXT, row_id BIGINT, label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH norm AS (
    SELECT upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g')) AS plate,
           lower(trim(COALESCE(p_property, '')))                                AS prop
  )
  SELECT 'vehicle'::TEXT, v.id, COALESCE(v.unit, '?')
    FROM public.vehicles v, norm n
   WHERE lower(trim(v.property)) = n.prop
     AND upper(regexp_replace(COALESCE(v.plate, ''), '[^A-Za-z0-9]', '', 'g')) = n.plate
     AND v.is_active IS TRUE AND v.status = 'active'
  UNION ALL
  SELECT 'visitor_pass'::TEXT, vp.id, COALESCE(vp.visiting_unit, '?')
    FROM public.visitor_passes vp, norm n
   WHERE lower(trim(vp.property)) = n.prop
     AND upper(regexp_replace(COALESCE(vp.plate, ''), '[^A-Za-z0-9]', '', 'g')) = n.plate
     AND vp.is_active IS TRUE AND vp.expires_at > now()
  UNION ALL
  SELECT 'guest_auth'::TEXT, ga.id, COALESCE(ga.visiting_unit, '?')
    FROM public.guest_authorizations ga, norm n
   WHERE lower(trim(ga.property)) = n.prop
     AND upper(regexp_replace(COALESCE(ga.plate, ''), '[^A-Za-z0-9]', '', 'g')) = n.plate
     AND ga.is_active IS TRUE AND ga.status = 'active' AND ga.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.prohibition_impact_rows(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prohibition_impact_rows(TEXT, TEXT) TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════
-- Shared authority check
-- ══════════════════════════════════════════════════════════════════
-- manager at that property, company_admin at that company, or admin.
-- leasing_agent is READ-ONLY on prohibitions (part-1 RLS) and is
-- absent here on purpose.
CREATE OR REPLACE FUNCTION public.may_manage_prohibitions_at(p_property TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role TEXT;
BEGIN
  v_role := public.get_my_role();
  IF v_role = 'admin' THEN RETURN TRUE; END IF;
  IF v_role = 'manager' THEN
    RETURN lower(trim(COALESCE(p_property, ''))) IN (
      SELECT lower(trim(x)) FROM unnest(public.get_my_properties()) AS x
    );
  END IF;
  IF v_role = 'company_admin' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.name)) = lower(trim(COALESCE(p_property, '')))
         AND lower(trim(p.company)) = lower(trim(public.get_my_company()))
    );
  END IF;
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.may_manage_prohibitions_at(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_manage_prohibitions_at(TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- preview_plate_prohibition_impact
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.preview_plate_prohibition_impact(
  p_property TEXT,
  p_plate    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.may_manage_prohibitions_at(p_property) THEN
    RETURN jsonb_build_object('error', 'not_authorized',
      'hint', 'Only a manager at this property, or a company admin, may manage prohibitions.');
  END IF;
  RETURN jsonb_build_object(
    'ok', TRUE,
    'vehicles',      (SELECT count(*) FROM public.prohibition_impact_rows(p_property, p_plate) WHERE kind = 'vehicle'),
    'visitor_passes',(SELECT count(*) FROM public.prohibition_impact_rows(p_property, p_plate) WHERE kind = 'visitor_pass'),
    'guest_auths',   (SELECT count(*) FROM public.prohibition_impact_rows(p_property, p_plate) WHERE kind = 'guest_auth'),
    'already_prohibited', ((public.plate_prohibition_at(p_property, p_plate)).id IS NOT NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_plate_prohibition_impact(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_plate_prohibition_impact(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- add_plate_prohibition
-- ══════════════════════════════════════════════════════════════════
-- Creates the prohibition, then revokes what it conflicts with, and
-- returns the ACTUAL counts — not the preview's. The gate compares the
-- two, so a drift between promise and effect is a test failure rather
-- than something a manager discovers.
--
-- 🔴 WHY REVOCATION IS NOT OPTIONAL. The driver cascade has an explicit
-- invariant that any protective record renders prominently, and its
-- headline pick order can never be reordered. A plate that is
-- prohibited AND holds a live visitor pass puts that in contradiction:
-- suppress the pass and the protective-record rule breaks, show it and
-- the prohibition is advisory. Revoking at creation is the only
-- resolution that leaves the cascade coherent.
CREATE OR REPLACE FUNCTION public.add_plate_prohibition(
  p_property   TEXT,
  p_plate      TEXT,
  p_reason     TEXT,
  p_note       TEXT DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller      TEXT;
  v_property_id BIGINT;
  v_plate       TEXT;
  v_id          BIGINT;
  v_veh         BIGINT[] := ARRAY[]::BIGINT[];
  v_pass        BIGINT[] := ARRAY[]::BIGINT[];
  v_ga          BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  v_caller := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_caller = '' THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF NOT public.may_manage_prohibitions_at(p_property) THEN
    RETURN jsonb_build_object('error', 'not_authorized',
      'hint', 'Only a manager at this property, or a company admin, may add a prohibition.');
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required',
      'hint', 'Say why this plate is not permitted. Managers and company admins will see it; residents never will.');
  END IF;

  SELECT id INTO v_property_id FROM public.properties
   WHERE lower(trim(name)) = lower(trim(p_property)) LIMIT 1;
  IF v_property_id IS NULL THEN
    RETURN jsonb_build_object('error', 'property_not_found');
  END IF;

  v_plate := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_plate) = 0 THEN
    RETURN jsonb_build_object('error', 'plate_required');
  END IF;

  -- Idempotent: an active prohibition already covers this plate.
  IF (public.plate_prohibition_at(p_property, v_plate)).id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'action', 'already_prohibited',
      'prohibition_id', (public.plate_prohibition_at(p_property, v_plate)).id);
  END IF;

  INSERT INTO public.property_plate_prohibitions
    (property_id, plate, reason, note, added_by, expires_at)
  VALUES
    (v_property_id, v_plate, trim(p_reason), NULLIF(trim(COALESCE(p_note, '')), ''), v_caller, p_expires_at)
  RETURNING id INTO v_id;

  -- ── Revoke, collecting the ids actually changed ─────────────────
  -- Each UPDATE re-asserts its own liveness predicate, so a row that
  -- stopped being live between the preview and now is skipped rather
  -- than counted.
  --
  -- Vehicles: status='deactivated' + reason='plate_prohibited'. Set
  -- directly rather than through deactivate_vehicle, because that RPC
  -- is manager-gated and REFUSES system codes — which is exactly the
  -- guard we want to keep, so this path writes the columns itself.
  WITH upd AS (
    UPDATE public.vehicles v
       SET is_active = FALSE, status = 'deactivated',
           deactivation_reason = 'plate_prohibited',
           deactivation_note = format('Plate not permitted at %s', p_property),
           deactivated_by = v_caller, deactivated_at = now()
     WHERE v.id IN (SELECT row_id FROM public.prohibition_impact_rows(p_property, v_plate) WHERE kind = 'vehicle')
       AND v.is_active IS TRUE AND v.status = 'active'
    RETURNING v.id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::BIGINT[]) INTO v_veh FROM upd;

  WITH upd AS (
    UPDATE public.visitor_passes vp
       SET is_active = FALSE
     WHERE vp.id IN (SELECT row_id FROM public.prohibition_impact_rows(p_property, v_plate) WHERE kind = 'visitor_pass')
       AND vp.is_active IS TRUE AND vp.expires_at > now()
    RETURNING vp.id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::BIGINT[]) INTO v_pass FROM upd;

  WITH upd AS (
    UPDATE public.guest_authorizations ga
       SET is_active = FALSE, status = 'revoked',
           revoked_at = now(), revoked_by_email = v_caller,
           revoked_reason = 'plate_prohibited'
     WHERE ga.id IN (SELECT row_id FROM public.prohibition_impact_rows(p_property, v_plate) WHERE kind = 'guest_auth')
       AND ga.is_active IS TRUE AND ga.revoked_at IS NULL
    RETURNING ga.id
  ) SELECT COALESCE(array_agg(id), ARRAY[]::BIGINT[]) INTO v_ga FROM upd;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values)
  VALUES (v_caller, 'PLATE_PROHIBITION_ADDED', 'property_plate_prohibitions', NULL,
    jsonb_build_object('prohibition_id', v_id, 'property', p_property, 'plate', v_plate,
      'expires_at', p_expires_at,
      'revoked', jsonb_build_object('vehicles', v_veh, 'visitor_passes', v_pass, 'guest_auths', v_ga)));

  RETURN jsonb_build_object(
    'ok', TRUE, 'action', 'prohibited', 'prohibition_id', v_id, 'plate', v_plate,
    'revoked', jsonb_build_object(
      'vehicles',       array_length(v_veh, 1),
      'visitor_passes', array_length(v_pass, 1),
      'guest_auths',    array_length(v_ga, 1)),
    'revoked_ids', jsonb_build_object('vehicles', v_veh, 'visitor_passes', v_pass, 'guest_auths', v_ga));
END;
$$;

REVOKE ALL ON FUNCTION public.add_plate_prohibition(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_plate_prohibition(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- remove_plate_prohibition
-- ══════════════════════════════════════════════════════════════════
-- 🔴 REMOVAL IS THE KEY REQUIREMENT (Jose). A reason is required, who
-- and when are recorded, the delete is soft, and NOTHING IS RESTORED —
-- the resident re-registers through normal approval. A manager may
-- remove a prohibition a company admin added at their property.
--
-- The reason is enforced twice: here, for the message, and by
-- ppp_removal_is_complete at the table, so a direct UPDATE cannot
-- remove a row anonymously either.
CREATE OR REPLACE FUNCTION public.remove_plate_prohibition(
  p_id     BIGINT,
  p_reason TEXT,
  p_note   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller   TEXT;
  v_row      public.property_plate_prohibitions;
  v_property TEXT;
BEGIN
  v_caller := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_caller = '' THEN RETURN jsonb_build_object('error', 'unauthenticated'); END IF;

  SELECT * INTO v_row FROM public.property_plate_prohibitions WHERE id = p_id;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'prohibition_not_found'); END IF;

  SELECT name INTO v_property FROM public.properties WHERE id = v_row.property_id;
  IF NOT public.may_manage_prohibitions_at(v_property) THEN
    RETURN jsonb_build_object('error', 'not_authorized',
      'hint', 'Only a manager at this property, or a company admin, may lift a prohibition.');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'removal_reason_required',
      'hint', 'Say why this prohibition is being lifted. It stays in the history for this property.');
  END IF;

  IF v_row.removed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'action', 'already_removed',
      'removed_at', v_row.removed_at, 'removed_by', v_row.removed_by);
  END IF;

  UPDATE public.property_plate_prohibitions
     SET removed_at = now(), removed_by = v_caller,
         removed_reason = trim(p_reason),
         removed_note = NULLIF(trim(COALESCE(p_note, '')), '')
   WHERE id = p_id AND removed_at IS NULL;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values)
  VALUES (v_caller, 'PLATE_PROHIBITION_REMOVED', 'property_plate_prohibitions', NULL,
    jsonb_build_object('prohibition_id', p_id, 'plate', v_row.plate, 'property', v_property,
                       'added_by', v_row.added_by, 'added_at', v_row.added_at, 'reason', v_row.reason),
    jsonb_build_object('removed_by', v_caller, 'removed_reason', trim(p_reason),
                       'restored_nothing', TRUE));

  -- 🔴 Says so explicitly in the payload: lifting a prohibition does
  -- NOT bring back a vehicle or pass it revoked. The UI repeats it, and
  -- a caller reading only this return still learns it.
  RETURN jsonb_build_object('ok', TRUE, 'action', 'removed', 'prohibition_id', p_id,
    'restored_nothing', TRUE,
    'hint', 'The prohibition is lifted and stays in this property''s history. Nothing it revoked has been restored — the resident registers again through normal approval.');
END;
$$;

REVOKE ALL ON FUNCTION public.remove_plate_prohibition(BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_plate_prohibition(BIGINT, TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- deactivate_vehicle — REPLACED, one array literal
-- ══════════════════════════════════════════════════════════════════
-- Reproduced from the 2026-10-07 applied definition (migrations/
-- 20261007_duplicate_plate_handling.sql PART 4). Diff against the live
-- pg_get_functiondef before applying: the only expected change is
-- v_system_codes gaining 'plate_prohibited', plus its comment.
CREATE OR REPLACE FUNCTION public.deactivate_vehicle(p_vehicle_id bigint, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_caller_properties  TEXT[];
  v_caller_company     TEXT;
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN;
  v_updated            public.vehicles%ROWTYPE;
  -- 🔴 2026-10-06 — 'resident_removed' added. Stamped only by
  -- deactivate_my_vehicle. A manager must not be able to claim the
  -- resident removed their own car, so it is system-only here for the
  -- same reason the three cascade codes are.
  -- 🔴 2026-10-11 — 'plate_prohibited' added. Stamped only by
  -- add_plate_prohibition's retroactive revocation. A manager must not
  -- be able to claim a vehicle was removed because the plate is
  -- prohibited when no prohibition exists — same reason the three
  -- cascade codes and resident_removed are system-only.
  --
  -- 🔴 AND THE TS LIST IS THE OTHER HALF. app/lib/deactivation-reasons.ts
  -- is documented as the source of truth for codes, but THIS array is
  -- what enforces "managers must not select a system code". Adding a
  -- code to TS alone leaves the manager path open. Both, in one change.
  v_system_codes       TEXT[] := ARRAY['cascade_resident_deactivated','owner_trim','admin_cascade','resident_removed','plate_prohibited'];
BEGIN
  -- ── 1. Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.email();
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── 2. Role gate ───────────────────────────────────────────────────
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(trim(email)) = lower(trim(v_caller_email))
   ORDER BY id DESC LIMIT 1;
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'no_role',
      'hint',  'No role row for the calling email.'
    );
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_permitted',
      'hint',  'Only managers or company_admins may deactivate vehicles.'
    );
  END IF;
  IF v_caller_role = 'manager' THEN
    IF NOT COALESCE((
      SELECT can_approve_vehicles FROM public.user_roles
        WHERE lower(trim(email)) = lower(trim(v_caller_email))
        ORDER BY id DESC LIMIT 1
    ), false) THEN
      RETURN jsonb_build_object(
        'error', 'authority_not_permitted',
        'hint',  'This manager account lacks vehicle-approval authority.'
      );
    END IF;
  END IF;

  -- ── 3. Load target vehicle ─────────────────────────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ── 3b. Property presence gate (Mateo Aug 9 Item 2, Layer 1) ───
  -- Distinct error class BEFORE the scope check. A NULL-property
  -- vehicle cannot have its scope verified in either branch; treat
  -- it as a data defect that needs manual attention, NOT as an
  -- out-of-scope refusal.
  IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_property_missing',
      'hint',  'Vehicle has no property — cannot verify scope. Data-fix required.'
    );
  END IF;

  -- ── 4. Scope gate — lower(trim(...)) (STRICTER than approve_vehicle) ─
  -- Deliberate divergence from approve_vehicle. See header §2.
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := lower(trim(v_vehicle.property)) IN (
      SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p
    );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.name))    = lower(trim(v_vehicle.property))
         AND lower(trim(p.company)) = lower(trim(v_caller_company))
    ) INTO v_in_scope;
  END IF;

  -- ── 4b. Scope decision (Mateo Aug 9 Item 2, Layer 2) ─────────────
  -- COALESCE the flag so any future column added to the scope check
  -- that could return NULL will fail CLOSED rather than open. Belt-
  -- and-suspenders alongside the Layer-1 property presence gate.
  IF NOT COALESCE(v_in_scope, false) THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Reason gate (presence + note-required + system-code reject) ──
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF trim(p_reason) = ANY(v_system_codes) THEN
    RETURN jsonb_build_object(
      'error', 'system_reason_not_permitted',
      'hint',  format('%L is a system-only cascade code; managers must not select it.', p_reason)
    );
  END IF;
  IF trim(p_reason) = 'other' THEN
    IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
      RETURN jsonb_build_object('error', 'note_required_when_reason_other');
    END IF;
  END IF;

  -- ── 6. Already-deactivated shortcut ───────────────────────────────
  --
  -- 🔴 2026-10-07 — replaced `is_active = false` with an ALLOWLIST of
  -- the statuses a deactivation may act on.
  --
  -- THE BUG: is_active=false is TRUE FOR EVERY PENDING ROW (39 live).
  -- So this shortcut treated "waiting for approval" as "already
  -- deactivated", returned ok:true without stamping anything, and made
  -- the duplicate-clearing action this arc adds a silent no-op.
  --
  -- 🔴 WHY NOT simply `status = 'deactivated'`, which was the first
  -- draft: that would let a manager deactivate a DECLINED row (55
  -- live), which is destructive rather than merely odd. The resident
  -- portal fetches `is_active = true OR status = 'declined'`, so a
  -- declined vehicle is visible to the resident along with the
  -- manager's note; rewriting its status to 'deactivated' makes that
  -- record VANISH from their view and puts it beyond
  -- mark_my_vehicle_declined_read. A declined vehicle was also never in
  -- the authorized set, so deactivating it is not a meaningful action.
  --
  -- So: proceed only for rows that are IN the authorized set or
  -- awaiting entry to it — active, pending, under_review. Everything
  -- else short-circuits, including any status added later, because an
  -- allowlist fails closed where a denylist fails open.
  --
  -- The action string stays 'already_deactivated' so no existing caller
  -- changes, even though for a declined row the wording is loose.
  -- Tightening that vocabulary is a separate change with its own
  -- callers to audit.
  --
  -- Live effect: 694 active + 39 pending + 2 under_review proceed;
  -- 55 declined + 6 deactivated no-op. The 19 status='active' /
  -- is_active=false rows the CRM calls "orphaned plates" proceed, which
  -- is right — a manager should be able to clear them.
  IF v_vehicle.status IS NULL OR v_vehicle.status NOT IN ('active', 'pending', 'under_review') THEN
    RETURN jsonb_build_object(
      'ok',     true,
      'action', 'already_deactivated',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 7. THE DEACTIVATION UPDATE ──────────────────────────────────
  UPDATE public.vehicles
     SET is_active           = false,
         status              = 'deactivated',
         deactivation_reason = trim(p_reason),
         deactivation_note   = NULLIF(trim(COALESCE(p_note, '')), ''),
         deactivated_by      = v_caller_email,
         deactivated_at      = now()
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      true,
    'action',  'deactivated',
    'vehicle', to_jsonb(v_updated)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) TO authenticated;
