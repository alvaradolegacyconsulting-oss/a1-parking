-- ════════════════════════════════════════════════════════════════════
-- STAGE 1c — the activation guard on vehicles
-- ════════════════════════════════════════════════════════════════════
--
-- Closes the PATCH half of the hole Stage 1b closed in the RPC: an
-- `authenticated` caller may not move a vehicle INTO the authorized
-- state by writing the table directly. Proved by canary twice: a
-- manager with can_approve_vehicles=FALSE both PATCHed status to
-- 'active' and INSERTed an already-active row.
--
-- Lands AFTER Stage 1d, which routed all three manager add paths
-- through manager_add_vehicle. Shipping this first would have broken a
-- flagged manager's Add Vehicle on contact.
--
-- ── 🔴 SECURITY INVOKER, AND THAT IS THE WHOLE MECHANISM ────────────
-- This function is deliberately NOT SECURITY DEFINER. Inside a DEFINER
-- function, current_user is the function's OWNER — so a DEFINER guard
-- would see 'postgres' no matter who called, and the discriminator
-- below would be blind.
--
-- As INVOKER, current_user reflects the calling context:
--     PostgREST as a signed-in user  → 'authenticated'   GUARDED
--     any SECURITY DEFINER RPC       → its owner          passes
--     service_role (API routes, cron)→ 'service_role'     passes
--     psql / a migration             → 'postgres'         passes
--
-- 🔴 WHY THIS AND NOT A FLAG. The first design used a transaction-local
-- GUC that approve_vehicle would set. current_user is better on every
-- axis: nothing to set, nothing to leak, and EVERY DEFINER RPC is
-- covered automatically — including ones written later, which a flag
-- would require each author to remember. The GUC survives only as an
-- AUDIT annotation (via_approve_rpc / via_add_rpc), and must never be
-- read as an access control.
--
-- That is also the bulk-loader exemption model, as ruled: the exemption
-- is the execution context of a DEFINER function, NOT "service_role may
-- do anything". A loader written as a DEFINER RPC passes because of
-- what it IS, not because of a carve-out naming it.
--
-- ── WHAT IS STILL ALLOWED, deliberately ─────────────────────────────
-- Everything that does not move a row INTO the authorized state:
--   • decline  (is_active→false, status→'declined')
--   • remove   (is_active→false, status→'deactivated')
--   • cosmetic edits, space, plate
--   • an INSERT that lands PENDING
-- Decline and Remove stay open to any manager at their property
-- (ruled); only APPROVAL is gated, because approval affects billing.
--
-- No role test. The CA portal's only vehicle UPDATE is
-- `{is_active:false}` (company_admin/page.tsx:2478) — a deactivation —
-- so no legitimate CA path moves a row into the authorized state
-- either, and a uniform rule has no allowlist to drift.
--
-- Paired: wip-20261014_stage1c_vehicle_activation_guard_verification.sql
-- Execution half: npm run verify:activationguard

CREATE OR REPLACE FUNCTION public.vehicles_activation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- 🔴 NO "SECURITY DEFINER" HERE. See the header. Adding it silently
-- disables this guard: current_user would become the owner for every
-- caller and the branch below would always pass.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_entering BOOLEAN;
BEGIN
  -- Anything that is not a signed-in PostgREST session passes. That is
  -- one comparison rather than a list of blessed callers.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_entering :=
    CASE
      WHEN TG_OP = 'INSERT' THEN
        -- A row that ARRIVES authorized. The canary proved a manager
        -- could do this: manager_insert_vehicles' WITH CHECK validates
        -- role and property but not status, so an insert was a
        -- self-approval with no approve_vehicle call at all.
        COALESCE(NEW.is_active, FALSE) OR NEW.status = 'active'
      ELSE
        -- Either column crossing on its own counts. is_active and
        -- status are written separately by different paths, and 19 rows
        -- exist today with one true and the other not, so requiring
        -- both to cross would let either half through alone.
           (NEW.is_active IS TRUE AND OLD.is_active IS NOT TRUE)
        OR (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
    END;

  IF v_entering THEN
    RAISE EXCEPTION 'vehicle_activation_not_permitted'
      USING HINT = 'A vehicle can only be activated through approve_vehicle or manager_add_vehicle, which check approval authority. Writing the table directly bypasses that check.';
  END IF;

  RETURN NEW;
END;
$fn$;

-- A trigger function needs no caller EXECUTE: the privilege is checked
-- at CREATE TRIGGER time, not when it fires.
REVOKE ALL ON FUNCTION public.vehicles_activation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vehicles_activation_guard() FROM anon;
REVOKE ALL ON FUNCTION public.vehicles_activation_guard() FROM authenticated;

COMMENT ON FUNCTION public.vehicles_activation_guard() IS
  'Refuses a direct write by an `authenticated` PostgREST session that moves a vehicle INTO the authorized state — on INSERT (a row arriving active) as well as UPDATE (either is_active or status crossing). 🔴 SECURITY INVOKER is the mechanism, not an oversight: inside a SECURITY DEFINER function current_user is the OWNER, so a DEFINER version of this guard would see ''postgres'' for every caller and never fire. As INVOKER it sees ''authenticated'' only for direct client writes, which means every DEFINER RPC — including ones written later — is exempt by what it is rather than by being named in a list. Decline, remove, cosmetic edits and pending INSERTs are all still allowed: only approval is gated, because approval affects billing.';

DROP TRIGGER IF EXISTS vehicles_activation_guard_trigger ON public.vehicles;
CREATE TRIGGER vehicles_activation_guard_trigger
  BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicles_activation_guard();
