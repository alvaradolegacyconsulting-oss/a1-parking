-- ════════════════════════════════════════════════════════════════════
-- Property-name trailing-whitespace class — structural close
-- 2026-07-15
--
-- ═══ CONVENTION CODIFIED HERE ═══════════════════════════════════════
-- 🔴 NAME COLUMNS THAT FLOW INTO STRING-COMPARISON PREDICATES MUST BE
-- 🔴 TRIMMED AT THE DATABASE LAYER, NOT JUST THE CLIENT.
--
-- Client-side trim is a UX/defense-in-depth layer, not the guard.
-- The database-level trigger is what makes the class structurally
-- impossible: it fires regardless of write path (client form, RPC,
-- direct SQL, future refactor, ad-hoc admin fix), turning a trimmable
-- string into an invariant of the column itself.
-- ════════════════════════════════════════════════════════════════════
--
-- ORIGIN — P0 2026-07-14
--   A1 (first live customer) hit an enforcement false-negative:
--   driver plate lookup returned NO PERMIT FOUND on plates with
--   legitimately-active visitor passes. Byte-exact diagnosis:
--   properties.name for UI-added rows carried a trailing space
--   ('Green Acers ' vs stored visitor_passes.property = 'Green
--   Acers'); driver's .ilike('property', selectedProperty) compared
--   spaced-vs-clean and mismatched. Manager surface happened to work
--   only because its stored comparison alignment differed by
--   coincidence, not tolerance.
--
--   Data cleaned live by Jose 2026-07-14 (see incident notes):
--     • properties.name         — 4 rows trimmed
--     • spaces.property         — 8 rows trimmed
--     • drivers.assigned_properties — 3 driver rows, element-wise
--
--   That closed the specific plate. This migration closes the class
--   for future writes on all three columns.
--
-- WHAT CHANGES — 3 BEFORE INSERT/UPDATE triggers
--
--   1. properties_name_trim_trigger
--        FIRE: BEFORE INSERT OR UPDATE OF name ON public.properties
--        ACTION: NEW.name := trim(NEW.name)
--
--   2. spaces_property_trim_trigger
--        FIRE: BEFORE INSERT OR UPDATE OF property ON public.spaces
--        ACTION: NEW.property := trim(NEW.property) (NULL-safe)
--
--   3. drivers_assigned_properties_trim_trigger
--        FIRE: BEFORE INSERT OR UPDATE OF assigned_properties ON
--              public.drivers
--        ACTION: element-wise trim across the text[] array via
--                ARRAY(SELECT trim(p) FROM unnest(NEW.assigned_
--                properties) p) — NULL-safe; empty array {} passes
--                through unchanged; already-trimmed values are
--                idempotent no-ops.
--
--   All three triggers are SECURITY INVOKER (default) — they run
--   under the caller's privileges. They don't need to bypass RLS;
--   they just mutate NEW.* before the row lands.
--
-- HAPPY PATH PRESERVED
--   Already-clean values pass through unchanged. Legitimate names
--   with INNER spaces ("Green Acers", "Sugarberry Place") are
--   unaffected — trim() only strips outer whitespace.
--
-- WHY ALL THREE, TOGETHER
--   Trigger on properties alone leaves the other two carriers able
--   to re-accumulate spaces from their own write paths (space-pool
--   generation, driver-assignment checkboxes, future manual SQL).
--   A partial fix looks done and isn't. Ship all three atomically.
--
-- DISCIPLINE
--   DROP-first per trigger function + pg_proc overload=1 assertion
--   per function + REVOKE PUBLIC + GRANT to authenticated (triggers
--   need callable EXECUTE only in the sense that the row-owner has
--   access via the trigger metadata; REVOKE from PUBLIC is safety-
--   posture consistent with the anon-RPC discipline). Whole
--   migration in ONE transaction. VQs live in the companion
--   verification file — they prove the trigger FIRES on direct SQL
--   writes (the "step 6" test that distinguishes UI-trim from
--   structural class-close).
--
-- 🔴 STANDING RULE (also codified in this header): any free-text
--    prose in a jsonb_build_object audit payload is dollar-quoted
--    using $txt$...$txt$, never single-quoted. Same rule for header
--    comments: reword to avoid apostrophes rather than rely on
--    -- comment safety.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- Trigger 1 of 3 — properties.name (the root source)
-- ══════════════════════════════════════════════════════════════════
DROP TRIGGER  IF EXISTS trg_properties_name_trim ON public.properties;
DROP FUNCTION IF EXISTS public.properties_name_trim_trigger();

CREATE FUNCTION public.properties_name_trim_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.name IS NOT NULL THEN
    NEW.name := trim(NEW.name);
  END IF;
  RETURN NEW;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.properties_name_trim_trigger() FROM PUBLIC;

CREATE TRIGGER trg_properties_name_trim
  BEFORE INSERT OR UPDATE OF name ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_name_trim_trigger();

DO $chk1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'properties_name_trim_trigger';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'properties_name_trim_trigger has % overloads; expected 1', v_count;
  END IF;
END $chk1$;


-- ══════════════════════════════════════════════════════════════════
-- Trigger 2 of 3 — spaces.property (space-pool derivation carrier)
-- ══════════════════════════════════════════════════════════════════
DROP TRIGGER  IF EXISTS trg_spaces_property_trim ON public.spaces;
DROP FUNCTION IF EXISTS public.spaces_property_trim_trigger();

CREATE FUNCTION public.spaces_property_trim_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.property IS NOT NULL THEN
    NEW.property := trim(NEW.property);
  END IF;
  RETURN NEW;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.spaces_property_trim_trigger() FROM PUBLIC;

CREATE TRIGGER trg_spaces_property_trim
  BEFORE INSERT OR UPDATE OF property ON public.spaces
  FOR EACH ROW EXECUTE FUNCTION public.spaces_property_trim_trigger();

DO $chk2$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'spaces_property_trim_trigger';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'spaces_property_trim_trigger has % overloads; expected 1', v_count;
  END IF;
END $chk2$;


-- ══════════════════════════════════════════════════════════════════
-- Trigger 3 of 3 — drivers.assigned_properties (text[] element-wise)
-- ══════════════════════════════════════════════════════════════════
DROP TRIGGER  IF EXISTS trg_drivers_assigned_properties_trim ON public.drivers;
DROP FUNCTION IF EXISTS public.drivers_assigned_properties_trim_trigger();

CREATE FUNCTION public.drivers_assigned_properties_trim_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.assigned_properties IS NOT NULL THEN
    NEW.assigned_properties := ARRAY(
      SELECT trim(p) FROM unnest(NEW.assigned_properties) AS p
    );
  END IF;
  RETURN NEW;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.drivers_assigned_properties_trim_trigger() FROM PUBLIC;

CREATE TRIGGER trg_drivers_assigned_properties_trim
  BEFORE INSERT OR UPDATE OF assigned_properties ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION public.drivers_assigned_properties_trim_trigger();

DO $chk3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'drivers_assigned_properties_trim_trigger';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'drivers_assigned_properties_trim_trigger has % overloads; expected 1', v_count;
  END IF;
END $chk3$;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PROPERTY_NAME_TRIM_TRIGGERS',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260715_property_name_trim_triggers',
    'change',    $txt$Three BEFORE INSERT OR UPDATE triggers that trim string-comparison name columns at the DB layer: properties.name (root source), spaces.property (space-pool carrier), drivers.assigned_properties (text[] element-wise). Ship atomically; if any pg_proc overload=1 assertion trips, whole migration rolls back. Companion client trims land in the same deploy at the CA-portal Add/Edit Property + Add User + Edit Driver + updateDriver write paths (defense-in-depth). Companion Fix 2 lands the pattern-side trim + wildcard-escape on the 5 driver searchPlate .ilike predicates.$txt$,
    'rationale', $txt$A1 P0 2026-07-14: UI-added properties carried trailing whitespace on name (Add Property form did not trim). Poison propagated into spaces.property + drivers.assigned_properties via downstream writes. Drivers plate lookup .ilike compared spaced-vs-clean and mismatched, returning NO PERMIT FOUND on plates with legitimately-active visitor passes — enforcement false-negative, worst-class failure mode. Live data cleaned by operator that night; this migration is the recurrence guard: DB-level trim triggers make trailing whitespace structurally impossible on these three columns, regardless of write path (client, RPC, direct SQL, future refactor). Sibling name columns on other tables (user_roles.property, residents.property, vehicles.property, guest_authorizations.property, vehicle_plate_changes.property, violations.property) are clean today per operator cleanup; each deserves its own trim trigger migration once the primary three are locked (filed as backlog: sibling property-column trim triggers).$txt$,
    'convention_codified', $txt$Name columns that flow into string-comparison predicates must be trimmed at the DB layer, not just the client. Client-side trim is a UX defense-in-depth layer; the DB trigger is the guard. Enforced structurally via BEFORE INSERT/UPDATE trigger that mutates NEW.column, running regardless of caller identity or write path.$txt$
  ),
  now()
);

COMMIT;
