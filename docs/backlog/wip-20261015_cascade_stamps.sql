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
-- ── WRITE SURFACE ───────────────────────────────────────────────────
-- Only the cascade route writes these, as service_role. There is no
-- RPC because service_role needs none — but per Piece 0's ruling the
-- columns still carry a REVOKE as a second layer.
--
-- 🔴 AND PIECE 0's OBJECTION TO COLUMN GRANTS APPLIES HERE TOO: a
-- column REVOKE does not appear in a pg_policies dump, so the next
-- person auditing user_roles will not find it and will conclude an
-- authenticated session can write these. The paired verification
-- asserts the REVOKE from pg_attribute.attacl, which is what makes it
-- discoverable — information_schema's privilege views under-report
-- grants and must not be used for this.

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
  'Set by the property-cascade route when IT deactivated this user. Reactivating that property restores ONLY rows carrying its id; every other deactivated row is skipped and reported as "deactivated separately". NULL means unknown provenance, which resolves to SKIP — pre-2026-10-15 deactivations are all NULL by design, because the old cascade audited one row per PROPERTY rather than one per user and so cannot be told apart from an individual deactivation. Written only by the route as service_role; UPDATE is REVOKED from authenticated, and the paired verification asserts that from pg_attribute.attacl because a column grant is invisible in a pg_policies dump.';

COMMENT ON COLUMN public.user_roles.cascade_deactivated_run IS
  'The cascade run that deactivated this user. Two runs on one property are different events and their result lists must not be conflated.';

-- ── Second layer: authenticated cannot write the provenance ─────────
-- Without this a company_admin could stamp a user through PostgREST and
-- make a later cascade reactivation restore someone it never took.
REVOKE UPDATE (cascade_deactivated_by_property, cascade_deactivated_run, cascade_deactivated_at)
  ON public.user_roles FROM authenticated;
REVOKE UPDATE (cascade_deactivated_by_property, cascade_deactivated_run, cascade_deactivated_at)
  ON public.user_roles FROM anon;

-- Finding B's lookup wants (property, is_active) resolution per user;
-- this is the index that keeps reactivation's stamp filter cheap.
CREATE INDEX IF NOT EXISTS user_roles_cascade_property_idx
  ON public.user_roles (cascade_deactivated_by_property)
  WHERE cascade_deactivated_by_property IS NOT NULL;

COMMIT;
