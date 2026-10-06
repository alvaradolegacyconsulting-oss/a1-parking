-- ════════════════════════════════════════════════════════════════════
-- Resident self-removal of their own vehicle
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-06. A resident can take their own vehicle out
-- of the authorized set. Soft-deactivate only — the row is kept and
-- audited with the resident as the actor. Reactivation is NOT
-- resident-reachable: a PM restore is the approval, and a resident who
-- wants the plate back re-adds it through request_my_vehicle, which
-- lands as pending.
--
-- TWO PARTS, and the second is not optional:
--   PART 1  deactivate_my_vehicle(p_vehicle_id)  — new
--   PART 2  deactivate_vehicle(...)              — REPLACED, to add
--           'resident_removed' to its system-code reject list
--
-- 🔴 WHY PART 2 IS REQUIRED. The TS module app/lib/deactivation-reasons.ts
-- is documented as the single source of truth for reason codes, but the
-- ENFORCEMENT of "managers must not select a system code" is a SECOND
-- copy of that list, hardcoded inside deactivate_vehicle:
--     v_system_codes TEXT[] := ARRAY['cascade_resident_deactivated', ...]
-- Adding 'resident_removed' to the TS list alone would leave a manager
-- able to pass it straight to deactivate_vehicle and stamp a vehicle as
-- resident-removed when the resident did nothing. The two lists are one
-- fact in two places; they change together or not at all.
--
-- ── OWNERSHIP: WHY NOT update_my_vehicle_cosmetic's PREDICATE ───────
-- The cosmetic RPC scopes by UNIT — (property, unit) IN (the caller's
-- resident rows) — so any resident at a unit may edit any vehicle
-- there. That is right for a colour correction and wrong for removal:
-- it would let a roommate delete another person's car. This RPC keeps
-- the cosmetic RPC's STRUCTURE (effective-active guard, resident-role
-- check, no-oracle error, SET search_path, GRANT envelope) and narrows
-- the predicate to ownership AND current residency:
--     lower(trim(v.resident_email)) = lower(trim(jwt email))
--   AND the caller is STILL an active resident at that (property, unit)
-- Both halves are load-bearing. Email alone would let a moved-out
-- resident act on a vehicle at an address that is no longer theirs;
-- residency alone is the roommate hole.
--
-- Measured against live data before writing (2026-10-06): of 681 active
-- vehicles, 678 satisfy this predicate for their own resident. The
-- other 3 sit at a unit whose residents row is INACTIVE — they are
-- caught by the effective-active guard and get the deactivated message,
-- not the no-oracle error. 13 units currently have more than one active
-- resident, so the roommate case is real and the gate tests it.
--
-- lower(trim(...)) on BOTH sides of the tuple as well as the email.
-- Exact comparison and lower(trim()) agree on all 678 today, so this
-- costs nothing and matches deactivate_vehicle's own convention, which
-- its header calls "the strictest of the three property-matching
-- conventions in tree". A unit stored with a trailing space should not
-- decide whether someone can remove their car.
--
-- 🔴 NULL unit fails CLOSED. A row constructor containing NULL never
-- matches, so a vehicle with a NULL unit is not removable by this RPC.
-- That is the right direction for a destructive action; the PM path
-- still works, and deactivate_vehicle has its own explicit
-- vehicle_property_missing class for the sibling data defect.
--
-- NO BILLING CHANGE. countActiveRecords counts vehicles with
-- status='active' AND is_active=true, so a soft-deactivated row leaves
-- the permit count on its own. There is no syncOnRemove — syncOnAdd
-- only ratchets upward and reconcileAtRenewal trims at renewal — so
-- nothing is called here, exactly as a manager un-approve calls nothing.
--
-- Apply in one paste. Verification file is paired:
--   wip-20261006_resident_vehicle_removal_verification.sql

-- ══════════════════════════════════════════════════════════════════
-- PART 1 — deactivate_my_vehicle
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.deactivate_my_vehicle(p_vehicle_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $func$
DECLARE
  v_email   TEXT;
  v_vehicle public.vehicles%ROWTYPE;
  v_updated public.vehicles%ROWTYPE;
BEGIN
  -- ── 1. Effective-active guard ──────────────────────────────────
  -- First, so a stale session belonging to a deactivated resident
  -- cannot act. The raise string + HINT match request_my_vehicle and
  -- update_my_vehicle_cosmetic VERBATIM so the resident page's
  -- existing matcher (error.message.includes('account_deactivated'))
  -- handles this RPC with no client change.
  --
  -- This is also what answers the inactive-resident case: the 3 live
  -- vehicles whose residents row is inactive stop here and are told
  -- their registration is deactivated, rather than being told their
  -- own car is "not found or not yours".
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  IF public.get_my_role() IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self vehicle removal only.';
  END IF;

  v_email := lower(trim(auth.jwt() ->> 'email'));

  -- ── 2. Load the vehicle THROUGH the ownership predicate ────────
  -- Ownership is part of the lookup, not a check after it, so there is
  -- no branch that has the row in hand and then decides. A vehicle that
  -- does not exist and a vehicle belonging to a roommate produce the
  -- identical result.
  SELECT * INTO v_vehicle
    FROM public.vehicles v
   WHERE v.id = p_vehicle_id
     AND lower(trim(v.resident_email)) = v_email
     AND (lower(trim(v.property)), lower(trim(v.unit))) IN (
           SELECT lower(trim(r.property)), lower(trim(r.unit))
             FROM public.residents r
            WHERE lower(trim(r.email)) = v_email
              AND r.is_active = true
         );

  IF v_vehicle.id IS NULL THEN
    -- Same error for "no such vehicle" and "not yours" — refusing to
    -- confirm that someone else's plate id exists. Mirrors
    -- update_my_vehicle_cosmetic's no-oracle wording.
    RAISE EXCEPTION 'vehicle not found or not yours';
  END IF;

  -- ── 3. Idempotent already-deactivated path ─────────────────────
  -- Not an error, and not an oracle: ownership is already proven above.
  -- A double-tapped confirm dialog or a retried request must not
  -- surface a failure for an outcome the resident already has.
  IF v_vehicle.is_active = false THEN
    RETURN jsonb_build_object(
      'ok',         true,
      'action',     'already_deactivated',
      'vehicle_id', v_vehicle.id
    );
  END IF;

  -- ── 4. The deactivation ────────────────────────────────────────
  -- deactivated_by carries the RESIDENT's address: they are the actor,
  -- and the CRM restore panel reads this column to say who did it.
  -- deactivation_note stays NULL — the reason code is self-describing
  -- and inventing prose on the resident's behalf would be a worse
  -- record than none.
  UPDATE public.vehicles
     SET is_active           = false,
         status              = 'deactivated',
         deactivation_reason = 'resident_removed',
         deactivation_note   = NULL,
         deactivated_by      = v_email,
         deactivated_at      = now()
   WHERE id = v_vehicle.id
  RETURNING * INTO v_updated;

  -- ── 5. Audit, with the resident as actor ───────────────────────
  -- Non-blocking by construction (same statement, same txn) but
  -- deliberately AFTER the update: a failed audit insert rolls the
  -- removal back, which is the correct direction for a record that
  -- exists to answer "who took this plate off the list".
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, created_at)
  VALUES (
    v_email,
    'RESIDENT_DEACTIVATE_VEHICLE',
    'vehicles',
    NULL,
    jsonb_build_object('is_active', true, 'status', v_vehicle.status),
    jsonb_build_object(
      'vehicle_id', v_updated.id,
      'plate',      v_updated.plate,
      'property',   v_updated.property,
      'unit',       v_updated.unit,
      'reason',     'resident_removed'
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',         true,
    'action',     'deactivated',
    'vehicle_id', v_updated.id,
    'plate',      v_updated.plate
  );
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.deactivate_my_vehicle(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deactivate_my_vehicle(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.deactivate_my_vehicle(BIGINT) TO authenticated;

COMMENT ON FUNCTION public.deactivate_my_vehicle(BIGINT) IS
  'DEFINER RPC for resident-self vehicle removal (soft-deactivate; stamps status=deactivated, reason=resident_removed, deactivated_by=the resident). Ownership is lower(trim(resident_email)) = caller AND the caller is still an ACTIVE resident at that (property, unit) — deliberately NARROWER than update_my_vehicle_cosmetic, which scopes by unit and would let a roommate remove another person''s car. Inactive resident hits the effective-active guard and gets account_deactivated, not the no-oracle error. Idempotent on an already-deactivated row. Writes a RESIDENT_DEACTIVATE_VEHICLE audit row. CASCADES NONE. No billing call: permit counting keys on status=active AND is_active=true and there is no syncOnRemove. Reactivation is NOT reachable here — a PM restore is the approval. Grants: authenticated EXECUTE; PUBLIC + anon REVOKED.';

-- ══════════════════════════════════════════════════════════════════
-- PART 2 — deactivate_vehicle, REPLACED
-- ══════════════════════════════════════════════════════════════════
--
-- 🔴 Reproduced from the live pg_get_functiondef pulled 2026-10-06.
-- The ONLY intended change is one array literal in the DECLARE block:
--     v_system_codes gains 'resident_removed'
-- Header reproduced exactly — the p_note DEFAULT NULL::text, RETURNS
-- jsonb, LANGUAGE plpgsql, SECURITY DEFINER, SET search_path TO
-- 'public', 'pg_temp', and default VOLATILE (no volatility keyword in
-- the live definition). CREATE OR REPLACE silently drops a parameter
-- default and can flip volatility if the header differs, so this is
-- copied rather than retyped.
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
  v_system_codes       TEXT[] := ARRAY['cascade_resident_deactivated','owner_trim','admin_cascade','resident_removed'];
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
  IF v_vehicle.is_active = false THEN
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

-- Re-issue the GRANT envelope. The 2026-08-09 header makes this
-- mandatory on any replacement: CREATE OR REPLACE does not reset
-- grants, but re-issuing is idempotent and a replacement that ever
-- becomes a DROP+CREATE (arg-type change) would otherwise silently
-- inherit the PUBLIC default.
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) TO authenticated;
