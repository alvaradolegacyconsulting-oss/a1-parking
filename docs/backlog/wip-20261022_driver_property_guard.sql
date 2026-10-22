-- ════════════════════════════════════════════════════════════════════
-- A deactivated property blocks the citation AND the tow
-- ════════════════════════════════════════════════════════════════════
-- Confirmed by Jose 2026-10-22. Measured 2026-10-16:
--
--   • the driver property dropdown, plate lookup and tag lookup all
--     list and accept a property with is_active = false, because every
--     one of them keys on the NAME in drivers.assigned_properties and
--     never joins properties;
--   • driver_create_violation_with_snapshot checks assignment-list
--     membership and NOTHING about properties.is_active;
--   • the client's fallback `violations` INSERT bypasses that guard
--     entirely and is governed only by RLS, which gates on role +
--     company — not assignment, not is_active;
--   • none of the three tow-decision paths (set_violation_status to
--     'tow_ticket', stamp_tow_ticket, regenerate_tow_ticket) consults
--     is_active either.
--
--   Proved by execution on Test-LEGACY's deactivated "Alias Probe Two":
--   the RPC wrote violation 438 and the fallback insert wrote 439.
--
-- 🔴 WHY A TRIGGER AND NOT A GUARD IN EACH FUNCTION. There are eight
-- writers and two of them are plain client inserts. A per-function
-- check leaves the fallback open, which is the hole that made the
-- canary succeed twice. A BEFORE trigger is the one layer every writer
-- crosses.
--
-- 🔴 AND WHY BLOCK CREATION, WHEN THE DNT PIVOT SAID OTHERWISE. On
-- 2026-07-23 a BEFORE INSERT trigger on violations was DROPPED on
-- purpose: "TAG ALLOWED, TOW BLOCKED … the list protects the vehicle
-- from the TRUCK, not from the CITATION." That reasoning is about an
-- AUTHORIZED VEHICLE, which can still block a fire lane. A deactivated
-- property is a different fact: we have no enforcement relationship
-- there at all, so there is no citation to write. Jose confirmed both
-- halves — citation and tow.
--
-- Paired: wip-20261022_driver_property_guard_verification.sql

-- ── 1. the shared predicate ─────────────────────────────────────────
-- One function, so the INSERT guard and the tow guard cannot drift.
-- Property is keyed by NAME because every writer passes a name; that
-- is the known text-keyed fragility and is not changed here.
CREATE OR REPLACE FUNCTION public.property_is_enforceable(p_property TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- 🔴 NOT EXISTS(active) is deliberately NOT the same as
  -- EXISTS(inactive): a property NAME that matches no row at all is
  -- also unenforceable, and the phantom-property class is exactly how
  -- rows got written against names with no matching property before.
  SELECT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(p_property))
       AND p.is_active = TRUE
  )
$fn$;

REVOKE ALL ON FUNCTION public.property_is_enforceable(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.property_is_enforceable(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.property_is_enforceable(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.property_is_enforceable(TEXT) IS
  'TRUE only when a property with this name exists AND is_active. A name with no matching property is unenforceable too — absence is not permission. Shared by the violations insert guard and the tow-decision guard so the two cannot drift.';

-- ── 2. the citation guard: enforceable property AND assignment ─────
-- (the "section 4" of the brief, folded in here so the function exists
--  before the trigger that calls it)
-- The fallback insert needs an ASSIGNMENT, not just a company.
-- RLS on violations gates INSERT on role + company. Measured: a driver
-- with no drivers row inserted at a property in their own company
-- through the client's fallback path and it was ACCEPTED, while the RPC
-- refused the same thing with driver_no_properties_assigned.
--
-- 🔴 THIS IS ENFORCED IN THE TRIGGER, NOT BY REWRITING THE POLICY.
-- Replacing a policy means first reading every INSERT-capable policy on
-- violations, and adding one instead would OR with the existing set and
-- change nothing — the permissive-wildcard trap. The trigger layer
-- already runs for every writer, and it can ask the same question the
-- RPC asks. If the policy is later tightened as well, this stays
-- correct: two closed doors, not one door and a claim.
--
-- Scoped to DRIVERS only. service_role (the seeder) has no JWT so
-- get_my_role() is NULL; an admin bypasses as it does everywhere else;
-- a company_admin is already bound to their company by RLS and by the
-- RPC's own branch.
CREATE OR REPLACE FUNCTION public.reject_violation_at_dead_property()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_role     TEXT;
  v_assigned TEXT[];
BEGIN
  -- (a) the property must be enforceable at all
  IF NOT public.property_is_enforceable(NEW.property) THEN
    RAISE EXCEPTION
      'Enforcement is not active at %. No citation can be created there.', NEW.property
      USING ERRCODE = 'check_violation',
            HINT = 'The property is deactivated, or its name does not match a property on file. Ask your company administrator.';
  END IF;

  -- (b) and a driver must be assigned to it
  v_role := public.get_my_role();
  IF v_role = 'driver' THEN
    v_assigned := public.get_my_driver_assigned_properties();
    -- 🔴 NULL means no drivers row. The client used to substitute
    -- ['All'] in that case and skip its own property filter entirely;
    -- here it is a refusal, which is what the RPC already did.
    IF v_assigned IS NULL OR array_length(v_assigned, 1) IS NULL THEN
      RAISE EXCEPTION
        'You have no properties assigned, so no citation can be created.'
        USING ERRCODE = 'check_violation',
              HINT = 'Ask your company administrator to assign you to at least one property.';
    END IF;
    IF NOT (lower(trim(NEW.property)) = ANY (
      SELECT lower(trim(p)) FROM unnest(v_assigned) p)) THEN
      RAISE EXCEPTION
        '% is not one of your assigned properties.', NEW.property
        USING ERRCODE = 'check_violation',
              HINT = 'You can only create a citation at a property you are assigned to.';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.reject_violation_at_dead_property() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_violation_at_dead_property() FROM anon;
REVOKE ALL ON FUNCTION public.reject_violation_at_dead_property() FROM authenticated;

-- 🔴 INSERT ONLY. An UPDATE guard would refuse the corrective paths —
-- void, resolve, status changes — on citations that already exist at a
-- property deactivated afterwards. Those must stay possible: the
-- deactivation is not a reason to strand a live ticket.
DROP TRIGGER IF EXISTS violations_reject_dead_property ON public.violations;
CREATE TRIGGER violations_reject_dead_property
  BEFORE INSERT ON public.violations
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_violation_at_dead_property();

-- ── 3. the tow-decision guard ───────────────────────────────────────
-- A citation written while the property was live must not become a TOW
-- after the property is deactivated. Creation is covered above; this is
-- the stamp.
CREATE OR REPLACE FUNCTION public.reject_tow_at_dead_property()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Only the transition INTO a tow. 🔴 IS DISTINCT FROM, not <>: a
  -- NULL on either side would make <> unknown and the guard would pass
  -- on exactly the rows it is meant to inspect.
  IF NEW.tow_ticket_generated IS DISTINCT FROM OLD.tow_ticket_generated
     AND NEW.tow_ticket_generated = TRUE
     AND NOT public.property_is_enforceable(NEW.property) THEN
    RAISE EXCEPTION
      'Enforcement is not active at %. No tow ticket can be issued there.', NEW.property
      USING ERRCODE = 'check_violation',
            HINT = 'The property is deactivated. The citation stays on file and can still be voided or resolved.';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.reject_tow_at_dead_property() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_tow_at_dead_property() FROM anon;
REVOKE ALL ON FUNCTION public.reject_tow_at_dead_property() FROM authenticated;

DROP TRIGGER IF EXISTS violations_reject_tow_dead_property ON public.violations;
CREATE TRIGGER violations_reject_tow_dead_property
  BEFORE UPDATE OF tow_ticket_generated ON public.violations
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_tow_at_dead_property();

COMMENT ON TRIGGER violations_reject_dead_property ON public.violations IS
  '2026-10-22. Refuses a citation at a property that is not active, or whose name matches no property. BEFORE INSERT so every writer crosses it — there are eight, and two are plain client inserts that no per-function guard reaches. UPDATE is deliberately NOT guarded: void and resolve must stay possible on tickets at a property deactivated after the fact.';
COMMENT ON TRIGGER violations_reject_tow_dead_property ON public.violations IS
  '2026-10-22. Refuses the transition into tow_ticket_generated = TRUE at a property that is not active. Creation is guarded separately; this stops a citation written while the property was live from becoming a tow after it was deactivated.';
