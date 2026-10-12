-- ════════════════════════════════════════════════════════════════════
-- STAGE 1a — server-side audit of every vehicle state change
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-12. Decline and Remove stay open to any
-- manager/leasing agent at their property, as today, but must be
-- audited SERVER-SIDE. Only approval requires can_approve_vehicles,
-- because approval affects billing.
--
-- 🔴 WHY A TRIGGER AND NOT MORE CLIENT CALLS. The portal already writes
-- DECLINE_VEHICLE, REMOVE_VEHICLE and EDIT_VEHICLE rows, and
-- approve_vehicle writes its own. All of them are OPTIONAL in the sense
-- that matters: they are separate round-trips after the UPDATE, so a
-- direct PATCH from anywhere else — curl, another client, a future
-- screen that forgets — changes the row and writes nothing. Only a
-- trigger is on the write path itself.
--
-- 🔴 IT DOES DOUBLE-LOG, AND THAT IS THE RECOMMENDATION.
-- A decline now produces two rows: the client's DECLINE_VEHICLE
-- (intent, actor as the client reports it) and this trigger's
-- VEHICLE_STATE_CHANGE (what actually changed, actor from the JWT).
-- They cannot be de-duplicated without coupling the trigger to
-- knowledge of which client call preceded it, and suppressing the
-- server row whenever a client row exists would restore exactly the
-- gap this closes — the direct-PATCH path writes no client row at all.
-- So: distinct action name, both retained. The client rows describe
-- intent and may be missing; VEHICLE_STATE_CHANGE is the one that is
-- always there.
--
-- Covers INSERT as well as UPDATE. manager_insert_vehicles WITH CHECK
-- validates role and property but NOT status, so a row can arrive
-- already active; that is a state change from nothing and belongs in
-- the log. (Refusing it is the guard's job, in Stage 1b.)
--
-- Paired: wip-20261013_stage1_vehicle_state_audit_verification.sql

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
  -- Actor from the JWT, never from an argument the caller controls.
  -- A path with no JWT (cron, migration, service_role) is recorded as
  -- 'system' rather than NULL: "who did this" must always be answered,
  -- and NULL reads as missing data instead of as a system action.
  v_actor := COALESCE(NULLIF(lower(trim(COALESCE(auth.jwt() ->> 'email', ''))), ''), 'system');

  IF TG_OP = 'UPDATE' THEN
    -- Nothing to say if neither column moved. The trigger is declared
    -- on these two columns, which fires on an UPDATE that MENTIONS
    -- them even when the value is unchanged — so the comparison is
    -- still required.
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NULL;
    END IF;
    v_old := jsonb_build_object('status', OLD.status, 'is_active', OLD.is_active);
  ELSE
    v_old := NULL;   -- INSERT: there is no prior state, and saying so
                     -- is different from saying the prior state was null
  END IF;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, notes)
  VALUES (
    v_actor,
    'VEHICLE_STATE_CHANGE',
    'vehicles',
    -- audit_logs.record_id is TEXT. bigint -> text survives as an
    -- ASSIGNMENT cast so the bare NEW.id would work (Piece 1's audit
    -- inserts rely on exactly that), but a trigger that raises breaks
    -- EVERY write to the table, so the cast is written out.
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
      -- Records whether approve_vehicle's flag was set for THIS row, so
      -- the log distinguishes an approval that went through the RPC from
      -- a direct write that merely produced the same end state.
      'via_approve_rpc',
        COALESCE(current_setting('app.vehicle_approve_id', TRUE) = NEW.id::TEXT, FALSE)
    ),
    format('vehicle %s (%s) at %s: %s -> %s',
           NEW.id, NEW.plate, NEW.property,
           CASE WHEN TG_OP = 'INSERT' THEN '(new)'
                ELSE format('is_active=%s status=%s', OLD.is_active, OLD.status) END,
           format('is_active=%s status=%s', NEW.is_active, NEW.status))
  );
  RETURN NULL;   -- AFTER trigger
END;
$fn$;

REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM anon;
REVOKE ALL ON FUNCTION public.vehicles_audit_state_change() FROM authenticated;

COMMENT ON FUNCTION public.vehicles_audit_state_change() IS
  'Writes a VEHICLE_STATE_CHANGE audit row for every INSERT, and every UPDATE that actually moves vehicles.status or vehicles.is_active, by ANY path — RPC, portal, or a direct PATCH. Actor comes from the JWT (''system'' when there is none), never from an argument. Deliberately duplicates the portal''s own DECLINE_VEHICLE / REMOVE_VEHICLE / EDIT_VEHICLE rows and approve_vehicle''s: those are separate round-trips that a direct write skips entirely, so they record intent and may be absent, while this one is on the write path and is always present. new_values.via_approve_rpc records whether approve_vehicle''s transaction-local flag was set for this row, which is what tells an approval apart from a direct write that reached the same state.';

-- AFTER, so it records what was actually committed rather than what was
-- proposed — a BEFORE trigger later in the chain could still change it.
DROP TRIGGER IF EXISTS vehicles_audit_state_change_trigger ON public.vehicles;
CREATE TRIGGER vehicles_audit_state_change_trigger
  AFTER INSERT OR UPDATE OF status, is_active ON public.vehicles
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicles_audit_state_change();
