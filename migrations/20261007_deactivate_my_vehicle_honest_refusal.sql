-- ════════════════════════════════════════════════════════════════════
-- deactivate_my_vehicle — refuse honestly instead of lying ok:true
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-07.
--
-- THE LIE. The idempotency branch keyed on `is_active = false`, which
-- is true of every PENDING row. A resident calling this on a pending
-- request got {ok:true, action:'already_deactivated'} and nothing
-- happened — a successful-looking response for a no-op. Unreachable
-- through the UI (the Remove button requires status='active'), so this
-- is correctness rather than an incident, and it is the same class as
-- the manager-side shortcut fixed the same day.
--
-- FULL RESIDENT WITHDRAWAL IS RULED AND QUEUED, not built here: same
-- ownership guard, a confirm dialog, recorded as resident-withdrawn,
-- visible to the PM — behind the plan-names work. See
-- docs/backlog/resident-withdraw-pending-request-2026-10-07.md. Until
-- then the refusal names the limitation out loud instead of implying
-- the withdrawal worked.
--
-- ONE BLOCK CHANGES. Reproduced from the 2026-10-06 applied definition;
-- header, signature, SECURITY DEFINER, search_path, the ownership
-- predicate and the audit write are untouched.
--
-- Paired: 20261007_deactivate_my_vehicle_honest_refusal_verification.sql

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
  --
  -- 🔴 2026-10-07 — narrowed from `is_active = false` to the state it
  -- names. is_active=false is also true of pending, declined and
  -- expired rows, so this branch reported ok:true/already_deactivated
  -- for a PENDING vehicle and did nothing — telling the caller a
  -- withdrawal had succeeded when no row was touched. Same lying-return
  -- class as the manager-side bug fixed in
  -- 20261007_duplicate_plate_handling.sql PART 4.
  IF v_vehicle.status = 'deactivated' THEN
    RETURN jsonb_build_object(
      'ok',         true,
      'action',     'already_deactivated',
      'vehicle_id', v_vehicle.id
    );
  END IF;

  -- ── 3b. Everything else is refused, honestly ───────────────────
  -- Only a vehicle genuinely IN the authorized set can be removed from
  -- it: status='active' AND is_active. Both halves matter — the 19
  -- status='active'/is_active=false rows the CRM calls "orphaned
  -- plates" are a data defect for a manager to clear, not something a
  -- resident should be stamping with their own name.
  --
  -- Refused, NOT silently accepted:
  --   pending       — nothing to remove yet. Withdrawal is a separate
  --                   ruling, queued behind the plan-names work; until
  --                   it ships this says so rather than pretending.
  --   under_review  — a plate change is in flight; removing the vehicle
  --                   would orphan the pending change row.
  --   declined      — never authorized, and the resident needs to keep
  --                   seeing the decline and its note.
  --
  -- 🔴 RAISE, not a jsonb error field. Every other refusal in this
  -- function raises, the resident page matches on error.message, and —
  -- decisively — the client only inspects `error`. A
  -- jsonb_build_object('error', …) would arrive with error=null and be
  -- read as success, which is the exact failure being removed.
  IF NOT (v_vehicle.status = 'active' AND v_vehicle.is_active = true) THEN
    RAISE EXCEPTION 'not_active'
      USING HINT = 'Only an approved, active vehicle can be removed. A request still waiting for approval cannot be withdrawn here yet — contact your property manager.';
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
