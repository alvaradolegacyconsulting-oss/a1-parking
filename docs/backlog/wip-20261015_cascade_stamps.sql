-- ════════════════════════════════════════════════════════════════════
-- CASCADE STAMPS — so the reverse acts only on its own work
-- ════════════════════════════════════════════════════════════════════
-- Sweep class 15, ruled 2026-10-15.
--
-- ── THE DEFECT THESE CLOSE ──────────────────────────────────────────
-- /admin's property cascade bans only users with no OTHER property.
-- Its reactivation half unbans and reactivates EVERY user assigned to
-- the property. So reactivating property X restores a manager who was
-- deactivated for an unrelated reason — individually by a CA, or by
-- property Y's cascade — as long as they are assigned to X. The code
-- frames that as idempotence, which is true only if THIS cascade
-- flipped the flag.
--
-- With a stamp, reactivation can tell the difference: restore the users
-- this property's cascade deactivated, and SKIP AND REPORT everyone
-- else as "deactivated separately; reactivate individually if
-- intended".
--
-- ── WHY A COLUMN AND NOT A TABLE ────────────────────────────────────
-- Reactivation needs one cheap read per user, and the ruling asked for
-- "a field reactivation can read". A cascade cannot stamp a user twice,
-- because a user already deactivated is skipped rather than
-- re-deactivated, so there is never more than one live stamp per row
-- and a history table would carry no information the audit log does
-- not already hold.
--
-- ── 🔴 PRE-EXISTING DEACTIVATIONS HAVE NO STAMP, DELIBERATELY ───────
-- The 4 rows deactivated before today get NULL, which means "unknown
-- provenance" and resolves to SKIP. That is the ruling: their audit
-- history cannot distinguish an individual deactivation from a cascade
-- one, because the old cascade wrote one row for the whole property
-- (DEACTIVATE_PROPERTY_CASCADE) rather than one per user. Guessing
-- would mean silently restoring access on a maybe.
--
-- ── WRITE SURFACE — 🔴 A TRIGGER, NOT A COLUMN REVOKE ───────────────
-- The first version of this file issued
--   REVOKE UPDATE (cascade_deactivated_by_property, …) FROM authenticated
-- and the paired verification failed it immediately: attacl came back
-- NULL for all three columns.
--
-- 🔴 WHY, AND IT IS WORTH KNOWING: a column-level REVOKE CANNOT
-- SUBTRACT FROM A TABLE-LEVEL GRANT. `authenticated` holds UPDATE on
-- all of user_roles, so revoking UPDATE(col) records nothing at all —
-- Postgres leaves attacl NULL, which means "default privileges apply",
-- which means writable. The REVOKE looked installed and did nothing.
-- The gate caught it because it treated attacl IS NULL as a FAILURE
-- rather than an absence.
--
-- Making a column grant work here would mean REVOKE UPDATE on the
-- whole table and then GRANT UPDATE on an explicit column list — on a
-- table every portal writes, where the next ALTER TABLE ADD COLUMN
-- would silently become unwritable by authenticated. That is a worse
-- problem than the one being solved.
--
-- So: the established pattern instead, the same one
-- companies_protected_columns_guard uses.
--
-- 🔴 SECURITY INVOKER IS THE MECHANISM. Inside a SECURITY DEFINER
-- function current_user is the OWNER, so a DEFINER guard would read
-- `postgres` for every caller and permit everything while looking
-- installed. As INVOKER it reads `authenticated` only for a direct
-- PostgREST write, which means service_role (the cascade) and every
-- DEFINER RPC are exempt BY WHAT THEY ARE — including ones written
-- later.
--
-- ── WRITER SWEEP, DONE BEFORE THE GUARD (binding rule) ──────────────
-- Eight writers of user_roles:
--   register/page.tsx:332            INSERT  (resident self-register)
--   admin/page.tsx:947               INSERT  (driver role)
--   admin/page.tsx:504,535           UPDATE  is_active only (cascade)
--   company_admin/page.tsx:3304      UPDATE  a built `clean` object from
--                                    a narrow select — no row spread
--   lib/user-active.ts:189           UPDATE  service_role (the writer)
--   stripe checkout-session-completed INSERT + UPDATE saas_accepted_version,
--                                    service_role
--   prospect-demo.ts:304             INSERT  service_role
--   insert_user_role and friends     DEFINER RPCs → exempt by current_user
--
-- 🔴 NOT ONE of them touches these three columns, and the trigger is
-- scoped `UPDATE OF` them, so it does not even fire for any existing
-- writer. A guard that is inert for every current path is what a
-- correctly-scoped guard looks like — and the sweep is how that is
-- known rather than hoped.

BEGIN;

ALTER TABLE public.user_roles
  -- Which property's cascade did this. ON DELETE SET NULL on purpose:
  -- if the property is gone, the provenance is gone, and an unstamped
  -- row is SKIPPED rather than restored. Losing the stamp must fail
  -- toward "leave them deactivated", never toward "restore them".
  ADD COLUMN IF NOT EXISTS cascade_deactivated_by_property BIGINT NULL
    REFERENCES public.properties(id) ON DELETE SET NULL,
  -- Which RUN. Two cascades of the same property on the same day are
  -- different events, and the result list of one must not be read as
  -- the other's.
  ADD COLUMN IF NOT EXISTS cascade_deactivated_run UUID NULL,
  ADD COLUMN IF NOT EXISTS cascade_deactivated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.user_roles.cascade_deactivated_by_property IS
  'Set by the property-cascade route when IT deactivated this user. Reactivating that property restores ONLY rows carrying its id; every other deactivated row is skipped and reported as "deactivated separately". NULL means unknown provenance, which resolves to SKIP — pre-2026-10-15 deactivations are all NULL by design, because the old cascade audited one row per PROPERTY rather than one per user and so cannot be told apart from an individual deactivation. Written only by the property-cascade route as service_role; a direct authenticated write is refused by user_roles_cascade_stamp_guard, a SECURITY INVOKER trigger scoped UPDATE OF these columns. NOT a column REVOKE: that was tried first and was a no-op, because a column-level REVOKE cannot subtract from a table-level grant — attacl stayed NULL and the columns stayed writable.';

COMMENT ON COLUMN public.user_roles.cascade_deactivated_run IS
  'The cascade run that deactivated this user. Two runs on one property are different events and their result lists must not be conflated.';

-- ── The guard: authenticated cannot write the provenance ────────────
-- Without it a company_admin could stamp a user through PostgREST and
-- make a later cascade reactivation restore someone it never took.
CREATE OR REPLACE FUNCTION public.user_roles_cascade_stamp_guard()
RETURNS trigger
LANGUAGE plpgsql
-- 🔴 NOT SECURITY DEFINER. See the header: as DEFINER, current_user is
-- the owner and this permits everything while looking installed.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Every caller that is not a direct PostgREST `authenticated` session
  -- passes: service_role, the postgres owner, and every DEFINER RPC.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Fire only when a stamp is ACTUALLY changing. The trigger is already
  -- scoped `UPDATE OF`, but a client that sends the column with its
  -- existing value must not be refused for a write that changes
  -- nothing — the same discipline as import_batch_write_once_guard.
  IF NEW.cascade_deactivated_by_property IS DISTINCT FROM OLD.cascade_deactivated_by_property
     OR NEW.cascade_deactivated_run      IS DISTINCT FROM OLD.cascade_deactivated_run
     OR NEW.cascade_deactivated_at       IS DISTINCT FROM OLD.cascade_deactivated_at THEN
    RAISE EXCEPTION 'cascade_stamp_not_permitted'
      USING HINT = 'The cascade provenance is written only by the property-cascade route. Changing it by hand would make a later reactivation restore a user it never deactivated.';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.user_roles_cascade_stamp_guard() IS
  'Refuses a direct `authenticated` PostgREST write to the cascade provenance columns on user_roles. 🔴 SECURITY INVOKER is the mechanism: inside a SECURITY DEFINER function current_user is the OWNER, so a DEFINER version would permit everything while looking installed. Replaces a column-level REVOKE that was a NO-OP — a column REVOKE cannot subtract from a table-level grant, so attacl stayed NULL and the columns stayed writable. Writer sweep 2026-10-15: none of the 8 user_roles writers touches these columns, and the trigger is scoped UPDATE OF them, so it is inert for every existing path.';

DROP TRIGGER IF EXISTS user_roles_cascade_stamp_guard_trigger ON public.user_roles;
CREATE TRIGGER user_roles_cascade_stamp_guard_trigger
  BEFORE UPDATE OF cascade_deactivated_by_property, cascade_deactivated_run, cascade_deactivated_at
  ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.user_roles_cascade_stamp_guard();

-- Finding B's lookup wants (property, is_active) resolution per user;
-- this is the index that keeps reactivation's stamp filter cheap.
CREATE INDEX IF NOT EXISTS user_roles_cascade_property_idx
  ON public.user_roles (cascade_deactivated_by_property)
  WHERE cascade_deactivated_by_property IS NOT NULL;

COMMIT;
