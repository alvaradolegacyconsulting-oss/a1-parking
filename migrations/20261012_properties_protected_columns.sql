-- ════════════════════════════════════════════════════════════════════
-- properties — CA-only columns, by extending the Piece 0 guard
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-12, after the Piece 0 finding that
-- properties_manager_update is FOR UPDATE TO authenticated for manager
-- AND leasing_agent with NO column list — so a manager or leasing agent
-- can write every column on a property they are assigned to.
--
-- ── DATA CHECK FIRST (run before this file was written) ─────────────
--   • 28 properties; every `company` matches an existing company — 0 orphans
--   • 0 property create/update/activate/deactivate actions performed by
--     anyone holding ONLY a manager or leasing_agent role. All were
--     company admins.
--   • 0 creator-company mismatches among the 19 properties that have a
--     create_property audit row. The other 9 have none — `properties`
--     has NO created_by column, so for those the creator is simply
--     unrecorded, not wrong.
-- The exposure is LATENT. Nothing to remediate; this closes it going
-- forward.
--
-- ── WHAT IS PROTECTED, AND WHAT DELIBERATELY IS NOT ─────────────────
-- CA/super-admin only:
--   company            🔴 the serious one. The WITH CHECK re-tests
--                      `properties.name = ANY(ur.property)` and never
--                      mentions company, so a manager could set it to
--                      another company's name — moving the property out
--                      of their CA's portal and into a stranger's, with
--                      every company-scoped read following it.
--   is_active          property lifecycle.
--   auth_* / authorization_*   the property authorization document —
--                      the legal evidence that the company may enforce
--                      there. A manager marking their own property
--                      authorized is the whole problem.
--   the two Piece 0 switches (already guarded; folded in here).
--
-- STAYS manager-editable, per ruling:
--   visitor_pass_limit, visitor_capacity, exempt_plates — pass caps
--   house_rules_*  — managers author house rules today
--   address, city, state, zip, notes, pm_name, pm_phone, pm_email
--   name — already protected by the policy's own WITH CHECK, and worth
--          leaving to it: four tables reference properties by name.
--
-- 🔴 AN ALLOWLIST WOULD BE WRONG HERE, unusually. Everywhere else in
-- this codebase a denylist fails open and is the bug. Here the opposite
-- holds: the thing being protected is a SMALL, NAMED set, and the
-- default for a new column must be "a manager can edit it" — because a
-- new column that silently becomes CA-only breaks the manager portal
-- with no error naming the cause, which is exactly why Piece 0 rejected
-- narrowed column grants. So this is a denylist on purpose, and the
-- paired verification asserts the list's CONTENTS rather than trusting
-- it to stay complete.
--
-- 🔴 RENAMED from properties_feature_switch_guard. The old name
-- described two columns; this guards fourteen, and a guard whose name
-- understates its job is one someone removes thinking it is narrow.
-- The Piece 0 verification file is amended in the same commit to assert
-- the new name — re-running the superseded version will fail on the
-- trigger name, which is correct.
--
-- Paired: wip-20261012_properties_protected_columns_verification.sql

CREATE OR REPLACE FUNCTION public.properties_protected_columns_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email   TEXT;
  v_role    TEXT;
  v_changed TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Which protected columns did this UPDATE actually change?
  -- Collected rather than short-circuited so the error can NAME them —
  -- "you cannot change company" is actionable; "not permitted" is not.
  --
  -- 🔴 array_append, NOT `v_changed || 'company'`. With an UNTYPED
  -- literal Postgres resolves text[] || unknown as anyarray || anyarray,
  -- coerces the literal to text[], and raises
  --   malformed array literal: "company"
  -- for EVERY caller — before the role check, so the no-JWT passthrough
  -- never runs and migrations, the demo seeder and the CA's own
  -- set_property_feature_switch RPC all break. The v1 of this file
  -- shipped that bug and the structural verification passed green over
  -- it, because reading prosrc proves the text exists, not that it runs.
  -- G7 below executes the guard for that reason.
  IF NEW.company                          IS DISTINCT FROM OLD.company                          THEN v_changed := array_append(v_changed, 'company'); END IF;
  IF NEW.is_active                        IS DISTINCT FROM OLD.is_active                        THEN v_changed := array_append(v_changed, 'is_active'); END IF;
  IF NEW.auth_status                      IS DISTINCT FROM OLD.auth_status                      THEN v_changed := array_append(v_changed, 'auth_status'); END IF;
  IF NEW.auth_document_url                IS DISTINCT FROM OLD.auth_document_url                THEN v_changed := array_append(v_changed, 'auth_document_url'); END IF;
  IF NEW.auth_reference                   IS DISTINCT FROM OLD.auth_reference                   THEN v_changed := array_append(v_changed, 'auth_reference'); END IF;
  IF NEW.auth_uploaded_by                 IS DISTINCT FROM OLD.auth_uploaded_by                 THEN v_changed := array_append(v_changed, 'auth_uploaded_by'); END IF;
  IF NEW.auth_uploaded_at                 IS DISTINCT FROM OLD.auth_uploaded_at                 THEN v_changed := array_append(v_changed, 'auth_uploaded_at'); END IF;
  IF NEW.auth_expires_at                  IS DISTINCT FROM OLD.auth_expires_at                  THEN v_changed := array_append(v_changed, 'auth_expires_at'); END IF;
  IF NEW.auth_notes                       IS DISTINCT FROM OLD.auth_notes                       THEN v_changed := array_append(v_changed, 'auth_notes'); END IF;
  IF NEW.authorization_pdf_path           IS DISTINCT FROM OLD.authorization_pdf_path           THEN v_changed := array_append(v_changed, 'authorization_pdf_path'); END IF;
  IF NEW.authorization_expiration_date    IS DISTINCT FROM OLD.authorization_expiration_date    THEN v_changed := array_append(v_changed, 'authorization_expiration_date'); END IF;
  IF NEW.authorization_notes              IS DISTINCT FROM OLD.authorization_notes              THEN v_changed := array_append(v_changed, 'authorization_notes'); END IF;
  IF NEW.parking_tags_enabled             IS DISTINCT FROM OLD.parking_tags_enabled             THEN v_changed := array_append(v_changed, 'parking_tags_enabled'); END IF;
  IF NEW.printable_visitor_passes_enabled IS DISTINCT FROM OLD.printable_visitor_passes_enabled THEN v_changed := array_append(v_changed, 'printable_visitor_passes_enabled'); END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;   -- nothing protected changed
  END IF;

  -- 🔴 Refuses only an AUTHENTICATED non-CA caller. A SQL session or a
  -- service-role path has no user JWT and proceeds: migrations,
  -- backfills and the prospect-demo seeder must keep working, and the
  -- threat is a manager's browser sending a PATCH that
  -- properties_manager_update would allow.
  v_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN NEW;
  END IF;

  v_role := public.get_my_role();
  IF v_role IS DISTINCT FROM 'company_admin' AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'protected_column_not_permitted'
      USING HINT = format(
        'Only a company admin can change %s on a property. Ask your company administrator.',
        array_to_string(v_changed, ', '));
  END IF;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.properties_protected_columns_guard() IS
  'Refuses an UPDATE to a CA-only properties column by an authenticated caller who is not company_admin or admin. Exists because properties_manager_update is FOR UPDATE TO authenticated for manager AND leasing_agent with no column list — the policy cannot express this and column grants would silently make every FUTURE column CA-only, which is why Piece 0 rejected them. Protected: company, is_active, the auth_*/authorization_* document set, and the two feature switches. Deliberately NOT protected: pass caps, house rules and the everyday contact/address columns — managers own those, and a denylist is correct here precisely because a new column must default to manager-editable. `company` is the serious one: the policy''s WITH CHECK re-tests name and never mentions company, so without this a manager could move their property into another company. A caller with no user JWT (SQL session, service_role) passes through on purpose.';

DROP TRIGGER IF EXISTS properties_feature_switch_guard_trigger ON public.properties;
DROP TRIGGER IF EXISTS properties_protected_columns_guard_trigger ON public.properties;
CREATE TRIGGER properties_protected_columns_guard_trigger
  BEFORE UPDATE ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.properties_protected_columns_guard();

-- The Piece 0 function is superseded. Left in place rather than dropped
-- so a re-run of the Piece 0 migration does not fail on a missing
-- dependency; nothing references it once the trigger above replaces it.
COMMENT ON FUNCTION public.properties_feature_switch_guard() IS
  'SUPERSEDED 2026-10-12 by properties_protected_columns_guard(), which covers the same two switches plus twelve more CA-only columns. No trigger references this any more. Kept so re-applying the Piece 0 migration is harmless.';
