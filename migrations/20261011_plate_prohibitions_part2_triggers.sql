-- ════════════════════════════════════════════════════════════════════
-- plate prohibitions — PART 2: the enforcement guarantee
-- ════════════════════════════════════════════════════════════════════
--
-- Apply AFTER part 1.
--
-- ── WHY TRIGGERS AND NOT THIRTEEN CHECKS ────────────────────────────
-- There are thirteen paths that create a plate authorization, and only
-- eight are RPCs:
--   RPC:    request_my_vehicle, approve_vehicle, issue_visitor_pass,
--           create_guest_authorization,
--           submit_guest_authorization_request,
--           approve_guest_authorization_request, submit_plate_change,
--           approve_plate_change
--   DIRECT: manager/page.tsx:2563, manager/page.tsx:2964,
--           api/billing/bulk-invite:328 (service-role, bypasses RLS),
--           api/register/companion-vehicle, lib/prospect-demo.ts
--
-- Thirteen hand-placed checks means the fourteenth path has none. A
-- BEFORE trigger is the one place none of them can route around —
-- including the service-role bulk path, because triggers fire for
-- service_role too.
--
-- 🔴 THIS IS THE OPPOSITE CALL FROM THE VISITOR-PASS DEDUP (2026-10-09),
-- and for a principled reason. There the required outcome was "return
-- the pass you already have", which a trigger cannot do — it can only
-- suppress the row, producing a success that wrote nothing. Here the
-- required outcome is REFUSAL, which is exactly what a trigger does
-- well. Mechanism follows outcome.
--
-- The RPCs still get checks, in part 3, purely for wording.
--
-- ── 🔴 THE DETAIL THE WHOLE FEATURE RESTS ON ────────────────────────
-- plate_prohibition_at() is SECURITY DEFINER, and it must be.
--
-- A trigger function runs as the INSERTING user. property_plate_prohibitions
-- has RLS, and residents have NO select policy on it — so a non-DEFINER
-- helper would return zero rows to the exact caller this feature exists
-- to stop, the check would pass, and the registration would succeed.
-- The feature would be silently inert for residents and visitors while
-- appearing to work for managers, who can read the table.
--
-- That failure has no symptom. A gate that only tests a manager would
-- certify it.
--
-- Paired: 20261011_plate_prohibitions_verification.sql (covers all three parts)

-- ══════════════════════════════════════════════════════════════════
-- The lookup
-- ══════════════════════════════════════════════════════════════════
-- Takes the property by NAME because that is what vehicles,
-- visitor_passes and guest_authorizations carry. Resolves to the FK
-- internally, so the prohibition table keeps its id scoping while the
-- callers keep theirs.
--
-- ACTIVE = removed_at IS NULL AND (expires_at IS NULL OR expires_at >
-- now()). BOTH, always — a lapsed prohibition stops applying by itself
-- and the index cannot carry the expiry half, so every caller applies
-- it. Returning the row rather than a boolean so part 3 and the
-- management surfaces can show the reason to the roles entitled to it.
CREATE OR REPLACE FUNCTION public.plate_prohibition_at(
  p_property TEXT,
  p_plate    TEXT
)
RETURNS public.property_plate_prohibitions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ppp.*
    FROM public.property_plate_prohibitions ppp
    JOIN public.properties pr ON pr.id = ppp.property_id
   WHERE lower(trim(pr.name)) = lower(trim(COALESCE(p_property, '')))
     AND ppp.plate = upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'))
     AND ppp.removed_at IS NULL
     AND (ppp.expires_at IS NULL OR ppp.expires_at > now())
   ORDER BY ppp.added_at DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION public.plate_prohibition_at(TEXT, TEXT) IS
  'The ACTIVE prohibition for (property name, plate), or no row. 🔴 SECURITY DEFINER IS LOAD-BEARING: the BEFORE triggers that call this run as the inserting user, and residents have no SELECT policy on property_plate_prohibitions — a non-DEFINER version would return nothing to exactly the callers this blocks, and the feature would be silently inert for residents and visitors while still working for managers. Active means removed_at IS NULL AND (expires_at IS NULL OR expires_at > now()); the index can only carry the removed_at half because now() is not IMMUTABLE.';

REVOKE ALL ON FUNCTION public.plate_prohibition_at(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plate_prohibition_at(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.plate_prohibition_at(TEXT, TEXT) TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════
-- The refusal
-- ══════════════════════════════════════════════════════════════════
-- One matchable token, 'plate_prohibited', in MESSAGE — the convention
-- every resident-facing refusal in this codebase already uses
-- (account_deactivated, vehicle_already_registered, not_your_unit), and
-- the clients match on error.message.
--
-- 🔴 THE HINT IS THE NEUTRAL COPY, AND THE REASON IS NEVER IN IT.
-- This error reaches residents and anonymous visitors. A manager gets
-- explicit wording and the reason from the management surface, which
-- can read the table; the trigger must be safe when surfaced raw, so
-- its own text is the resident-facing sentence. DETAIL carries only the
-- plate and property — no reason, no note, no attribution.
CREATE OR REPLACE FUNCTION public.raise_plate_prohibited(
  p_property TEXT,
  p_plate    TEXT
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RAISE EXCEPTION 'plate_prohibited'
    USING HINT   = 'This vehicle can''t be registered here. Please contact the property office.',
          DETAIL = format('plate=%s property=%s',
                          upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g')),
                          COALESCE(p_property, ''));
END;
$$;

-- ══════════════════════════════════════════════════════════════════
-- vehicles
-- ══════════════════════════════════════════════════════════════════
-- Fires on INSERT, and on an UPDATE that makes a row AUTHORIZED.
--
-- 🔴 WHY THE UPDATE ARM MATTERS: approve_vehicle does not change plate
-- or property — it flips is_active/status on a row that already exists.
-- A plate prohibited AFTER the resident submitted would sail through an
-- insert-only trigger the moment a manager approved it. That is the
-- most likely real sequence, not an edge case.
--
-- And the arm is deliberately narrow — it checks only when the row IS
-- or BECOMES an authorization. The retroactive revocation in part 3
-- sets is_active=false, so it must not trip this.
CREATE OR REPLACE FUNCTION public.vehicles_check_plate_prohibition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_becomes_authorized BOOLEAN;
BEGIN
  v_becomes_authorized := (NEW.is_active IS TRUE AND NEW.status = 'active');

  -- A pending row is not yet an authorization, but it must still be
  -- refused at submission: queuing a request that can never be
  -- approved is the pattern the duplicate-plate arc removed.
  IF TG_OP = 'INSERT' OR v_becomes_authorized THEN
    IF (public.plate_prohibition_at(NEW.property, NEW.plate)).id IS NOT NULL THEN
      PERFORM public.raise_plate_prohibited(NEW.property, NEW.plate);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_plate_prohibition_trigger ON public.vehicles;
CREATE TRIGGER vehicles_plate_prohibition_trigger
  BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicles_check_plate_prohibition();

-- ══════════════════════════════════════════════════════════════════
-- visitor_passes
-- ══════════════════════════════════════════════════════════════════
-- Covers issue_visitor_pass and anything else that ever writes this
-- table. The UPDATE arm catches a pass being re-activated.
CREATE OR REPLACE FUNCTION public.visitor_passes_check_plate_prohibition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.is_active IS TRUE THEN
    IF (public.plate_prohibition_at(NEW.property, NEW.plate)).id IS NOT NULL THEN
      PERFORM public.raise_plate_prohibited(NEW.property, NEW.plate);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visitor_passes_plate_prohibition_trigger ON public.visitor_passes;
CREATE TRIGGER visitor_passes_plate_prohibition_trigger
  BEFORE INSERT OR UPDATE ON public.visitor_passes
  FOR EACH ROW
  EXECUTE FUNCTION public.visitor_passes_check_plate_prohibition();

-- 🔴 NOTE ON THE REVOCATION PATH: part 3 revokes passes by setting
-- is_active = false, which does not satisfy `NEW.is_active IS TRUE`, so
-- it does not trip this trigger. If a future change revokes by some
-- other means, re-read this.

-- ══════════════════════════════════════════════════════════════════
-- guest_authorizations
-- ══════════════════════════════════════════════════════════════════
-- Covers create_guest_authorization, the resident submit and the
-- manager approve. A resident-submitted request for a prohibited plate
-- is refused at submission rather than landing in the manager's queue.
CREATE OR REPLACE FUNCTION public.guest_auth_check_plate_prohibition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.is_active IS TRUE AND NEW.status = 'active') THEN
    IF (public.plate_prohibition_at(NEW.property, NEW.plate)).id IS NOT NULL THEN
      PERFORM public.raise_plate_prohibited(NEW.property, NEW.plate);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guest_auth_plate_prohibition_trigger ON public.guest_authorizations;
CREATE TRIGGER guest_auth_plate_prohibition_trigger
  BEFORE INSERT OR UPDATE ON public.guest_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.guest_auth_check_plate_prohibition();
