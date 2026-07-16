-- ════════════════════════════════════════════════════════════════════
-- Property name — count-based rename lock (allow at 0 refs; block at ≥1)
-- 2026-07-15 (refined 2026-07-16 to count-based per Mateo decision)
--
-- ═══ CONVENTION CODIFIED HERE ═══════════════════════════════════════
-- 🔴 PROPERTY NAME IS LOCKED WHEN ≥1 USER ASSIGNMENT REFERENCES IT.
-- 🔴 ONLY role='admin' MAY RENAME PAST THE LOCK. FREE RENAME AT 0 REFS
-- 🔴 (COVERS THE FRESH-CREATION TYPO CASE).
--
-- Text-keyed refs from user_roles.property[], drivers.assigned_properties[],
-- and residents.property all ILIKE/= match against properties.name.
-- A rename orphans every one of those refs silently (no FK, no cascade),
-- which manifests as:
--   • manager can't log in (login lookup miss)
--   • driver can't scan (search predicate miss)
--   • driver can't Issue Violation (RLS WITH CHECK reject)
--   • resident registration URL 404
--
-- Rename-at-0-refs is safe: a freshly-created property with no users
-- assigned yet has nothing downstream to orphan (per the design, all
-- downstream data — vehicles/violations/spaces/guest_auths — arrives
-- AFTER a user is provisioned onto the property). Once ≥1 assignment
-- exists, rename is locked to admin only.
--
-- The tactical guard. Structural close is the FK migration (each
-- downstream table swaps `property TEXT` for `property_id BIGINT
-- REFERENCES properties(id)` with ON UPDATE CASCADE / ON DELETE
-- RESTRICT) — filed as backlog memo. When FK ships, this trigger
-- retires.
-- ════════════════════════════════════════════════════════════════════
--
-- ORIGIN
--   2026-07-15 — Jose renamed properties.id=138 to test the trim
--   triggers. Rename silently orphaned legacy-manager (login-lookup
--   miss) + legacy-driver (scan false-notfound AND violations RLS
--   WITH CHECK reject). Reverted the rename to unblock.
--
--   Mateo decision (2026-07-15 → refined 2026-07-16): count-based
--   lock, not flat block. Rationale: flat block breaks legitimate
--   typo-fix-at-creation flows; count-based unblocks those while
--   still stopping dangerous 2,000-resident rename orphans. Same
--   philosophy as the deactivate-guard force-confirm — honest interim
--   now, right fix (FK) on the runway.
--
-- WHAT CHANGES
--   ONE BEFORE UPDATE OF name trigger on public.properties. On any
--   change to NEW.name:
--     1. If role='admin' → allow (support/emergency renames).
--     2. Else, count user assignments across 3 carriers:
--          user_roles.property (text[])
--          drivers.assigned_properties (text[])
--          residents.property (text scalar)
--        Scoped by lower(trim(company)) to prevent cross-tenant leaks.
--     3. If count > 0 → RAISE check_violation with old/new names + count.
--     4. If count = 0 → allow (freshly-created / no-users property).
--
-- WHAT DOES NOT COUNT (deliberate per Mateo)
--   Transactional / historical tables whose property column is a
--   snapshot rather than a live-user-assignment:
--     • violations.property   — historical audit; rename orphans the
--                               historical query, but the enforcement
--                               chain runs on real-time reads scoped by
--                               currently-assigned users (who ARE counted).
--     • vehicle_plate_changes.property — pending state; short-lived.
--     • guest_authorizations.property — active guest windows; count downstream
--                               of resident assignments (residents ARE counted).
--     • spaces.property       — physical parking spots; rename desyncs
--                               display but doesn't break enforcement.
--     • vehicles.property     — vehicle-at-a-property lookup; keyed to
--                               resident_email primarily.
--   Rationale: the LOCK protects ACCESS (user login + enforcement path),
--   not history. In practice at count=0, all 5 above are also 0 (no
--   users → no downstream data yet).
--
-- HAPPY PATH PRESERVED
--   • Admin renames: unchanged (trigger returns NEW).
--   • Fresh-typo-fix rename (0 users assigned): allowed for any role.
--   • Non-name edits (address, pm_*, auth_*): no-op — trigger fires
--     BEFORE UPDATE OF name only.
--
-- WHY NOT ALSO BLOCK DEACTIVATE/DELETE (this migration)
--   Deferred to a SEPARATE feature: Option A honest-copy force-confirm
--   (client-side, both admin + CA property-deactivate paths). Kept out
--   of this migration to keep the trigger surface tight — one function,
--   one concern.
--
-- COMPOSES WITH EXISTING TRIGGERS
--   trg_properties_name_trim (BEFORE INSERT OR UPDATE OF name, 3adc2c5)
--   fires FIRST — NEW.name is already trimmed when this rename-lock
--   fires. So a "rename" that only changes trailing whitespace
--   ('Green Acers' → 'Green Acers ') is NOT a rename after trim; this
--   trigger correctly no-ops (NEW.name IS NOT DISTINCT FROM OLD.name).
--
-- DISCIPLINE
--   DROP-first + pg_proc overload=1 assertion + REVOKE PUBLIC. Whole
--   migration in ONE transaction. VQs test the threat via disposable
--   smoke rows (see companion verification file).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- Trigger 1 of 1 — properties.name rename lock (count-based)
-- ══════════════════════════════════════════════════════════════════
DROP TRIGGER  IF EXISTS trg_properties_name_block_rename ON public.properties;
DROP FUNCTION IF EXISTS public.properties_name_block_rename_trigger();

CREATE FUNCTION public.properties_name_block_rename_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_role TEXT;
  v_refs INT;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    -- Admin bypass — support / emergency renames. Admin owns any
    -- resulting orphan cleanup (they know what they're doing).
    v_role := get_my_role();
    IF v_role = 'admin' THEN
      RETURN NEW;
    END IF;

    -- Count user assignments across 3 carriers scoped by company.
    -- Include is_active=false suspended rows (per project_deactivation
    -- _model.md: suspended accounts preserve their assignment links,
    -- they're coming back on reactivation, they're live-but-dormant
    -- tenancy references).
    SELECT
      COALESCE((SELECT COUNT(*) FROM user_roles ur
                 WHERE lower(trim(ur.company)) = lower(trim(NEW.company))
                   AND OLD.name = ANY(ur.property)), 0)
    + COALESCE((SELECT COUNT(*) FROM drivers d
                 WHERE lower(trim(d.company)) = lower(trim(NEW.company))
                   AND OLD.name = ANY(d.assigned_properties)), 0)
    + COALESCE((SELECT COUNT(*) FROM residents r
                 WHERE lower(trim(r.company)) = lower(trim(NEW.company))
                   AND r.property = OLD.name), 0)
    INTO v_refs;

    IF v_refs > 0 THEN
      RAISE EXCEPTION
        'property "%" has % active user assignments — rename blocked. Reassign or deactivate them first, or contact support to change the name. Attempted rename: [%] to [%] (role=%)',
        OLD.name, v_refs, OLD.name, NEW.name, COALESCE(v_role, '(no-role)')
        USING ERRCODE = 'check_violation';
    END IF;
    -- v_refs = 0: fresh-creation typo case, rename allowed for any role.
  END IF;
  RETURN NEW;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.properties_name_block_rename_trigger() FROM PUBLIC;

CREATE TRIGGER trg_properties_name_block_rename
  BEFORE UPDATE OF name ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.properties_name_block_rename_trigger();

DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'properties_name_block_rename_trigger';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'properties_name_block_rename_trigger has % overloads; expected 1', v_count;
  END IF;
END $chk$;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PROPERTY_NAME_COUNT_BASED_RENAME_LOCK',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260715_property_name_block_rename',
    'change',    $txt$BEFORE UPDATE OF name trigger on public.properties. Admin bypass. For non-admin: counts assignments across user_roles.property (text[]), drivers.assigned_properties (text[]), residents.property (text scalar) scoped by lower(trim(company)); raises check_violation if count > 0, allows if count = 0 (fresh-typo case). Companion client-side field lock disables the name input at ≥1 assignments + short-circuits the update payload for non-admins.$txt$,
    'rationale', $txt$Property rename silently orphans text-keyed refs across 7 downstream tables. Incident 2026-07-15: rename of Test Legacy Property orphaned legacy-manager (login-lookup miss) + legacy-driver (scan false-notfound + violations RLS WITH CHECK reject). Product decision (Mateo 2026-07-16): count-based lock (not flat block) preserves the legitimate fresh-typo-fix flow while stopping dangerous mid-life renames. Assignment tables count is_active=false suspended rows because deactivation preserves the link (project_deactivation_model verified 2026-07-16). Downstream transactional tables (violations, vehicle_plate_changes, guest_authorizations, spaces, vehicles) NOT counted — the lock protects access, not history; at count=0 they're empty anyway (no users → no downstream data).$txt$,
    'convention_codified', $txt$Property name is renamable at 0 user assignments; locked at ≥1 for non-admin roles. Admin always bypass. Enforced structurally via BEFORE UPDATE OF name trigger; complemented by client-side field-lock + payload short-circuit for UX.$txt$,
    'structural_close', $txt$FK migration (property_id everywhere with ON UPDATE CASCADE / ON DELETE RESTRICT) makes rename a display-only non-event at ANY count. Filed as backlog memo. When shipped, this trigger retires.$txt$
  ),
  now()
);

COMMIT;
