-- ════════════════════════════════════════════════════════════════════
-- Slice 5-adjacent data hardening — plate uniqueness backstop
-- Locked: July 3, 2026
--
-- Purpose: enforce the plate-collision class at the DB level across
-- EVERY vehicles INSERT/UPDATE path — not just the two client-side
-- (addVehicle + addResident cascade in manager/page.tsx, guarded via
-- assertPlateUniqueAtProperty in app/lib/plate.ts) and the one RPC
-- (submit_plate_change, guarded in the collision-guard migration).
-- Guard = user-facing UX (clean error message); index = integrity
-- backstop that catches any path we missed or add later. Both coexist.
--
-- Match the Slice 4 guard's scope EXACTLY so neither is stricter than
-- the other:
--   · upper(plate) (case-insensitive)
--   · raw property (name; canonicalization / property_id refactor
--     will retire this later — TODO logged)
--   · WHERE is_active=true AND status IN ('active','under_review')
--     — deactivated / declined vehicles' plates remain reusable
--
-- Enforcement design fact this preserves: enforcement matches on plate
-- alone (not plate + state). driver_plate_lookup + client searchPlate
-- key on plate + property. That's why the index and guard both key on
-- upper(plate) alone with no state column. If enforcement ever moves
-- to plate+state matching, the guard AND this index both gain 'state'
-- — Slice 6 note in app/components/PmResidentCrm.tsx captures this
-- codebase-side.
--
-- SEQUENCING (per Jose 2026-07-03): dedupe first, then create index.
-- Creating a UNIQUE index while a duplicate exists errors. One
-- migration file — dedupe statement before index creation.
--
-- The existing duplicate: TEST1 at Bayou Heights (2 rows, different
-- residents/units, same plate). Test-data leftover (both emails use
-- the alvaradolegacyconsulting+ prefix pattern). Deactivating the
-- NEWER row (id=477) is the conservative pick — keeps first arrival,
-- treats the second as data-cleanup via the standard Slice 5
-- deactivate semantic (is_active=false, status='deactivated'). No
-- records lost; audit stamp captures the cleanup for future reference.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. DEDUPE — TEST1 at Bayou Heights ────────────────────────────
-- Deactivate the newer row so the surviving pair matches the index
-- constraint (one active row per upper(plate)+property).
UPDATE public.vehicles
   SET is_active = false,
       status    = 'deactivated'
 WHERE id = 477
   AND upper(plate) = 'TEST1'
   AND property = 'Bayou Heights Apartments';

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system',
  'DEACTIVATE_VEHICLE',
  'vehicles',
  '477',
  jsonb_build_object(
    'is_active', false,
    'status',    'deactivated',
    'plate',     'TEST1',
    'property',  'Bayou Heights Apartments',
    'reason',    'slice5_hardening_dedupe',
    'note',      'Legacy duplicate — same plate/property as vehicle id=476. Newer row deactivated so the partial unique index on (upper(plate), property) WHERE is_active AND status IN (active,under_review) can enforce plate collision class DB-wide going forward.'
  ),
  now()
);

-- ── 2. INDEX — plate uniqueness backstop ──────────────────────────
-- Partial UNIQUE across every INSERT/UPDATE path. Two rows can't co-
-- exist as authorized (active/under_review + is_active=true) with the
-- same upper(plate) at the same property.
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_authorized_plate_uidx
  ON public.vehicles (upper(plate), property)
  WHERE is_active = true AND status IN ('active', 'under_review');

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFY (after apply)
--
-- ── A. Dedupe applied — row 477 deactivated
--   SELECT id, plate, property, status, is_active FROM public.vehicles
--    WHERE upper(plate) = 'TEST1' AND property = 'Bayou Heights Apartments';
--   Expected: 476 active/true; 477 deactivated/false.
--
-- ── B. Index exists with correct predicate
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'vehicles' AND indexname = 'vehicles_authorized_plate_uidx';
--   Expected: 1 row; indexdef contains
--     "UNIQUE INDEX ... ON public.vehicles USING btree (upper(plate), property)
--       WHERE ((is_active = true) AND (status = ANY (ARRAY['active'::text,
--       'under_review'::text])))"
--
-- ── C. Constraint fires on manual duplicate attempt
--   INSERT INTO vehicles (plate, property, status, is_active, resident_email, unit)
--   VALUES ('TEST1', 'Bayou Heights Apartments', 'active', true, 'x@example.com', 'X');
--   Expected: 23505 unique_violation on vehicles_authorized_plate_uidx.
--
-- ── D. Reusability for deactivated plates preserved
--   INSERT a vehicle with plate='ABC1234' + property='X' + status='active' → ok
--   UPDATE that vehicle status='deactivated', is_active=false → ok
--   INSERT another vehicle with plate='ABC1234' + property='X' + status='active' → ok
--   (Deactivated plates remain reusable per the WHERE clause.)
-- ════════════════════════════════════════════════════════════════════
