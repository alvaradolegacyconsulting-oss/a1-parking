-- ════════════════════════════════════════════════════════════════════
-- 🔴 ROLLBACK — drop the Stage 1c activation guard
-- ════════════════════════════════════════════════════════════════════
-- HOLD THIS. Run it ONLY if the reactivation fix is not deployed and
-- verified by 5 pm Central on 2026-10-14.
--
-- WHAT IT RESTORES: B206 resident reactivation (manager portal) and the
-- super-admin ACTIVATE_PROPERTY_CASCADE. Both are refused right now
-- with `vehicle_activation_not_permitted`.
--
-- WHAT IT REOPENS: an `authenticated` caller can again move a vehicle
-- into the authorized state by direct PATCH or by INSERTing an
-- already-active row — i.e. approval without approval authority. That
-- hole existed for months until 2026-10-14, so this returns to the
-- status quo rather than creating new exposure. Stage 1b still stands:
-- approve_vehicle itself enforces can_approve_vehicles either way, so
-- the RPC route stays closed.
--
-- ONE STATEMENT. The function is left in place so re-applying is just
-- the CREATE TRIGGER from the Stage 1c migration — no need to re-run
-- the whole file.

DROP TRIGGER IF EXISTS vehicles_activation_guard_trigger ON public.vehicles;

-- Proof it is gone, and that the function survived for the re-apply.
SELECT
  'activation guard dropped'::TEXT AS action,
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.vehicles'::regclass
      AND tgname='vehicles_activation_guard_trigger' AND NOT tgisinternal) AS trigger_want_0,
  (to_regprocedure('public.vehicles_activation_guard()') IS NOT NULL)      AS function_kept_want_true,
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.vehicles'::regclass AND NOT tgisinternal)        AS other_vehicles_triggers,
  'To re-apply later: run only the CREATE TRIGGER block from migrations/20261014_stage1c_vehicle_activation_guard.sql'::TEXT AS reapply;
