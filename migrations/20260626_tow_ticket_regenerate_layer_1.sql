-- ═══════════════════════════════════════════════════════════════════
-- Tow Ticket Regenerate — Layer 1 (Foundation)
-- Date:   2026-06-26
-- Branch: a1/tow-ticket-regenerate-layer-1
--
-- DECISIONS LOCKED (Jose 2026-06-26): see
-- tow_ticket_regenerate_void_workflow_arc_design.md.
--
-- 🔒 NORTH-STAR INVARIANT THIS PROTECTS
-- ────────────────────────────────────
-- There is NEVER more than one live (non-voided) tow ticket per tow,
-- and NEVER a window with zero. Every design choice serves this.
--
-- WHAT LAYER 1 BUILDS (no UI in this layer)
-- ─────────────────────────────────────────
--   PART 1 — user_roles.can_regenerate_tow_ticket
--            BOOLEAN NOT NULL DEFAULT FALSE. CA-granted (UI in Layer 3).
--            Backfill existing rows → FALSE explicitly.
--
--   PART 2 — violations: three new columns
--              regenerate_reason         TEXT (CHECK enum) — on the VOIDED ORIGINAL
--              regenerate_reason_note    TEXT              — on the VOIDED ORIGINAL
--              regenerated_from          BIGINT FK→violations(id) — on the NEW ROW
--            The new column on the new row is the forward origin link.
--            Pairs with the audit row's 'replaced_by' field on the voided
--            original for bidirectional traceability (Jose lock 2026-06-26).
--
--   PART 3 — regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT)
--            DEFINER RPC. THE atomic void+new+stamp path. Drivers
--            (with permission) and CA/admin (always allowed). NEVER
--            enables driver standalone-void — void_violation is the
--            standalone-void path and is UNTOUCHED.
--
--   PART 4 — stamp_tow_ticket: D2 amendment.
--            Adds `status = CASE WHEN status='new' THEN 'tow_ticket' ELSE status END`
--            to the existing UPDATE SET. Advance-from-new-only — doesn't
--            clobber 'resolved' or 'disputed' on a (re)stamp.
--
--   PART 5 — REVOKE / GRANT discipline + SCHEMA_RPC_ADDED audit rows.
--
-- 🔒 INVARIANTS PRESERVED ACROSS PARTS
-- ────────────────────────────────────
--   1. void_violation RPC UNTOUCHED. Standalone-void stays admin+CA-only
--      (B175 D4 lock). No driver path to standalone-void.
--   2. B175 immutability: voided rows are NEVER edited after void.
--      Regenerate = void original + create NEW row + stamp NEW row.
--   3. Company-scope predicate parity: same `~~*` (ILIKE) on company,
--      exact match on property name — MIRRORS B219 Layer 1 exactly.
--      RLS-visible row = RPC-allowed row.
--   4. B182 already_stamped guard: kept. Regenerate path doesn't trip
--      it (new row is unstamped at the moment of stamp). Stamp path
--      remains protected from accidental double-stamp.
--   5. Atomicity: plpgsql single-transaction semantics + void-first
--      ordering. Code-structure guarantee (see Section C of verification
--      file for the explicit honesty about what runtime can/can't prove).
--   6. Reason required on every regenerate. CHECK constraint + RPC gate.
--
-- APPLY DISCIPLINE (mirrors B219 Layer 1)
-- ───────────────────────────────────────
--   1. Section A of verification → confirm column + RPC absent
--   2. Apply this file as a single paste in SQL Editor
--   3. Sections B–H of verification → confirm pass; report load-bearing
--      results (C/D/E/F/H)
--   4. UI layers (Layer 2 driver UI, Layer 3 CA permission UI, Layer 4
--      metric) ship ONLY after this Layer is live + verified in prod
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — user_roles.can_regenerate_tow_ticket
-- ════════════════════════════════════════════════════════════════════
-- Per-driver permission boolean. CA-granted; UI to grant lives in
-- Layer 3. For now, toggle via direct SQL:
--   UPDATE user_roles SET can_regenerate_tow_ticket = TRUE
--    WHERE lower(email) = lower('driver@example.com');
--
-- Column lives on user_roles (not a separate drivers permissions table)
-- because get_my_role()/get_my_company() already SELECT from user_roles
-- on every RPC call — adding this column makes the regenerate RPC's
-- gate a single round-trip with the existing lookup. NULL semantics
-- are fine for non-drivers (the gate is `role='driver' AND can_*=TRUE`,
-- non-drivers never read the column).

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS can_regenerate_tow_ticket BOOLEAN NOT NULL DEFAULT FALSE;

-- Explicit backfill: any rows that predate the column get FALSE.
-- DEFAULT FALSE covers new INSERTs; this UPDATE is defensive for
-- any historical row that might have NULL in an edge case.
UPDATE public.user_roles
   SET can_regenerate_tow_ticket = FALSE
 WHERE can_regenerate_tow_ticket IS NULL;


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — violations: regenerate_reason + regenerate_reason_note
--          + regenerated_from (bidirectional traceability)
-- ════════════════════════════════════════════════════════════════════
-- regenerate_reason / regenerate_reason_note: populated ON THE VOIDED
--   ORIGINAL when the void was a regenerate (explains why the row was
--   voided). NULL on every non-regenerated row.
--
-- regenerated_from: populated ON THE NEW ROW pointing back to the
--   original's id. The new row is born is_confirmed=TRUE (inherits
--   the already-validated infraction); regenerated_from makes that
--   inheritance EXPLICIT and TRACEABLE in BOTH directions —
--
--     Forward link (original → new): audit_logs VIOLATION_VOIDED row
--                                    with new_values.replaced_by = new_id
--     Backward link (new → original): violations.regenerated_from FK
--                                     on the new row
--
--   Auditor can pivot either direction. Closes the "silently confirmed
--   without review" concern (Jose lock 2026-06-26): the column makes
--   `is_confirmed=TRUE` not a fresh confirmation but a CARRIED one.

ALTER TABLE public.violations
  ADD COLUMN IF NOT EXISTS regenerate_reason      TEXT,
  ADD COLUMN IF NOT EXISTS regenerate_reason_note TEXT,
  ADD COLUMN IF NOT EXISTS regenerated_from       BIGINT REFERENCES public.violations(id) ON DELETE SET NULL;

-- Idempotent CHECK add (drop-if-exists then add — safer for re-runs)
ALTER TABLE public.violations
  DROP CONSTRAINT IF EXISTS violations_regenerate_reason_valid;

ALTER TABLE public.violations
  ADD CONSTRAINT violations_regenerate_reason_valid CHECK (
    regenerate_reason IS NULL
    OR regenerate_reason IN (
      'facility_closed',
      'wrong_facility',
      'facility_changed',
      'vehicle_not_accepted',
      'other'
    )
  );

-- Sanity invariant: regenerate_reason_note should only be populated
-- when regenerate_reason='other'. Soft enforcement via CHECK (other
-- reasons may have an empty note; only 'other' REQUIRES a note via
-- the RPC's pre-validation, not via the CHECK).

CREATE INDEX IF NOT EXISTS violations_regenerated_from_idx
  ON public.violations (regenerated_from)
 WHERE regenerated_from IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — regenerate_tow_ticket DEFINER RPC
-- ════════════════════════════════════════════════════════════════════
-- Atomic void + new-row + carry-forward-evidence + stamp + audit.
-- Single transaction (plpgsql function body); exception → full rollback.

CREATE OR REPLACE FUNCTION public.regenerate_tow_ticket(
  p_original_violation_id   BIGINT,
  p_new_storage_facility_id BIGINT,
  p_new_tow_fee             NUMERIC,
  p_reason                  TEXT,
  p_reason_note             TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  -- Auth + scope
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_can_regen      BOOLEAN;

  -- Original row + new row
  v_original       violations%ROWTYPE;
  v_new_id         BIGINT;
  v_new_row        jsonb;
  v_storage        storage_facilities%ROWTYPE;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ AUTH GATE                                               ║
  -- ╚══════════════════════════════════════════════════════════╝
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Single user_roles lookup: role + company + can_regenerate.
  -- Done in one query to match the existing helper-style efficiency.
  SELECT role, company, can_regenerate_tow_ticket
    INTO v_caller_role, v_caller_company, v_can_regen
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ROLE GATE                                               ║
  -- ║   - driver: needs can_regenerate_tow_ticket = TRUE      ║
  -- ║   - admin / company_admin: always allowed (scope below) ║
  -- ║   - manager / leasing_agent / resident: REFUSED         ║
  -- ║     (drivers regenerate, CA does standalone-void via    ║
  -- ║     void_violation which is UNTOUCHED — D4 lock)        ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  IF v_caller_role = 'driver' THEN
    IF v_can_regen IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'error', 'regenerate_not_permitted',
        'hint',  'Your account does not have regenerate permission. Contact your company admin.'
      );
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ REASON GATE                                             ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF p_reason IS NULL
     OR p_reason NOT IN ('facility_closed', 'wrong_facility', 'facility_changed', 'vehicle_not_accepted', 'other') THEN
    RETURN jsonb_build_object(
      'error', 'invalid_reason',
      'hint',  'reason must be one of: facility_closed, wrong_facility, facility_changed, vehicle_not_accepted, other'
    );
  END IF;

  IF p_reason = 'other' AND (p_reason_note IS NULL OR length(trim(p_reason_note)) < 5) THEN
    RETURN jsonb_build_object(
      'error', 'reason_note_required',
      'hint',  'When reason is "other", a note of at least 5 characters is required.'
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ORIGINAL ROW: load + state checks                       ║
  -- ╚══════════════════════════════════════════════════════════╝
  SELECT * INTO v_original
    FROM public.violations
   WHERE id = p_original_violation_id;

  IF v_original.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_original.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed',
                              'hint', 'Cannot regenerate a draft violation.');
  END IF;
  IF v_original.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_voided',
                              'hint', 'This violation has already been voided.');
  END IF;
  IF v_original.tow_ticket_generated IS NOT TRUE THEN
    RETURN jsonb_build_object('error', 'not_stamped',
                              'hint', 'Regenerate requires an existing stamped ticket. Use stamp_tow_ticket for initial stamps.');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ COMPANY-SCOPE PREDICATE — MIRRORS B219 LAYER 1 EXACTLY  ║
  -- ║   properties.company ~~* v_caller_company (ILIKE)        ║
  -- ║   AND properties.name = v_original.property (exact)      ║
  -- ║                                                          ║
  -- ║ admin: no scope check (super-admin access).             ║
  -- ║ company_admin + driver: must own the property.           ║
  -- ║                                                          ║
  -- ║ Invariant: RLS-visible row = RPC-allowed row.            ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.company ~~* v_caller_company
         AND p.name = v_original.property
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STORAGE FACILITY: validate + same company-scope shape   ║
  -- ║   (mirrors stamp_tow_ticket's storage scope predicate)  ║
  -- ╚══════════════════════════════════════════════════════════╝
  SELECT * INTO v_storage
    FROM public.storage_facilities
   WHERE id = p_new_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  IF v_caller_role <> 'admin' THEN
    IF v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_caller_company) THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 1 — VOID THE ORIGINAL (void-first ordering)        ║
  -- ║   This MUST happen before Step 4 (stamp new) so at no   ║
  -- ║   in-transaction instant are TWO rows live-and-stamped. ║
  -- ║   Section C of verification documents the atomicity     ║
  -- ║   honesty: this guarantee is CODE STRUCTURE, not        ║
  -- ║   runtime-testable from SQL Editor.                     ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.violations
     SET voided_at              = now(),
         voided_by_email        = lower(v_caller_email),
         voided_by_role         = v_caller_role,
         void_reason            = 'regenerate: ' || p_reason,
         regenerate_reason      = p_reason,
         regenerate_reason_note = p_reason_note
   WHERE id = p_original_violation_id;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 2 — INSERT NEW VIOLATION ROW (carry-forward)       ║
  -- ║   is_confirmed=TRUE: infraction already validated on    ║
  -- ║     the original. regenerated_from FK makes the carried ║
  -- ║     confirmation EXPLICIT (bidirectional traceability   ║
  -- ║     pairs with audit_logs.replaced_by on the void row). ║
  -- ║   status='new' (default) — D2 advance fires at Step 4.  ║
  -- ║   tow_ticket_generated=false (default) — Step 4 stamps. ║
  -- ║   voided_at/voided_by_* NOT set — fresh.                ║
  -- ║   view_token NOT carried — fresh; reissue via           ║
  -- ║     set_violation_view_token if the driver re-shares.   ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.violations (
    plate,
    violation_type,
    location,
    notes,
    property,
    driver_name,
    driver_license,
    vehicle_year,
    vehicle_color,
    vehicle_make,
    vehicle_model,
    is_confirmed,
    -- B71 override context carries forward
    was_authorized_at_time,
    decline_reason,
    decline_reason_note,
    -- The forward origin link — pairs with audit_logs.replaced_by
    regenerated_from
  ) VALUES (
    v_original.plate,
    v_original.violation_type,
    v_original.location,
    v_original.notes,
    v_original.property,
    v_original.driver_name,
    v_original.driver_license,
    v_original.vehicle_year,
    v_original.vehicle_color,
    v_original.vehicle_make,
    v_original.vehicle_model,
    TRUE,                              -- inherit confirmation (already-validated infraction)
    v_original.was_authorized_at_time,
    v_original.decline_reason,
    v_original.decline_reason_note,
    p_original_violation_id            -- backward link to original
  )
  RETURNING id INTO v_new_id;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 3 — CARRY-FORWARD EVIDENCE (active rows only)      ║
  -- ║                                                          ║
  -- ║ INTENTIONAL DIVERGENCE: soft-deleted evidence rows      ║
  -- ║ (removed_at IS NOT NULL) are NOT carried forward. The   ║
  -- ║ original removal was deliberate (driver/manager/admin   ║
  -- ║ removed it via MediaRemovalDialog); auto-resurrecting   ║
  -- ║ it on regenerate would silently undo that removal.      ║
  -- ║ Side effect: the new row may have FEWER evidence rows   ║
  -- ║ than the original. This is documented for legal-        ║
  -- ║ exposure surfaces — the divergence is BY DESIGN, not    ║
  -- ║ a missing-evidence bug. (Jose lock 2026-06-26.)         ║
  -- ║                                                          ║
  -- ║ Storage objects in Supabase Storage are NOT duplicated  ║
  -- ║ — only the join rows. Same photo_url → two violation_id ║
  -- ║ entries (original voided + new live).                    ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.violation_photos (violation_id, photo_url, created_at)
  SELECT v_new_id, photo_url, created_at
    FROM public.violation_photos
   WHERE violation_id = p_original_violation_id
     AND removed_at IS NULL;

  INSERT INTO public.violation_videos (violation_id, video_url, created_at)
  SELECT v_new_id, video_url, created_at
    FROM public.violation_videos
   WHERE violation_id = p_original_violation_id
     AND removed_at IS NULL;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 4 — STAMP THE NEW ROW (inline; D2 advance built-in)║
  -- ║                                                          ║
  -- ║ ⚠⚠⚠ KEEP IN SYNC WITH public.stamp_tow_ticket ⚠⚠⚠       ║
  -- ║ (migrations/20260614_b182_pm_ticket_summary.sql)         ║
  -- ║                                                          ║
  -- ║ This UPDATE replicates the stamp_tow_ticket SET clause  ║
  -- ║ inline for atomicity (single transaction; no nested-    ║
  -- ║ RPC call concerns). If a future change adds a field to  ║
  -- ║ stamp_tow_ticket's SET (e.g. new tow_storage_*, new     ║
  -- ║ vsf_*, etc.), THIS UPDATE MUST GAIN THE SAME FIELD.     ║
  -- ║ Drift between the two stamp paths = a real bug          ║
  -- ║ (regenerated tickets would carry stale or missing data).║
  -- ║                                                          ║
  -- ║ D2 advance: status='tow_ticket' set HERE inline (the    ║
  -- ║ new row defaults to status='new' from B219 Layer 1).    ║
  -- ║ The stamp_tow_ticket path uses a CASE guard to avoid    ║
  -- ║ clobbering 'resolved'/'disputed'; here we don't need    ║
  -- ║ the guard because the row was just inserted at 'new'.   ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_new_tow_fee,
         status                   = 'tow_ticket'   -- D2 advance; new row was 'new'
   WHERE id = v_new_id
  RETURNING to_jsonb(violations.*) INTO v_new_row;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 5 — AUDIT (two rows: void + regenerate)            ║
  -- ║                                                          ║
  -- ║ VIOLATION_VOIDED on the original: includes replaced_by  ║
  -- ║   (the new row's id) + regenerate flag for forensic     ║
  -- ║   distinction from manual standalone voids.              ║
  -- ║                                                          ║
  -- ║ VIOLATION_REGENERATED on the new row: full context      ║
  -- ║   (reason, note, original id, old/new facility, caller).║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_VOIDED',
    'violations',
    p_original_violation_id,
    jsonb_build_object(
      'void_reason',          'regenerate: ' || p_reason,
      'regenerate_reason',    p_reason,
      'regenerate_reason_note', p_reason_note,
      'replaced_by',          v_new_id,
      'caller_role',          v_caller_role,
      'via_regenerate',       TRUE
    ),
    now()
  );

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_REGENERATED',
    'violations',
    v_new_id,
    jsonb_build_object(
      'original_violation_id',  p_original_violation_id,
      'reason',                 p_reason,
      'reason_note',            p_reason_note,
      'old_storage_name',       v_original.tow_storage_name,
      'old_tow_fee',            v_original.tow_fee,
      'new_storage_id',         p_new_storage_facility_id,
      'new_storage_name',       v_storage.name,
      'new_tow_fee',            p_new_tow_fee,
      'caller_role',            v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',                TRUE,
    'new_violation_id',  v_new_id,
    'violation',         v_new_row
  );
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — stamp_tow_ticket: D2 advance-from-new-only
-- ════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE; signature preserved (BIGINT, BIGINT, NUMERIC).
-- Body IDENTICAL to B182 form EXCEPT the UPDATE SET clause gains
-- `status = CASE WHEN status = 'new' THEN 'tow_ticket' ELSE status END`.
--
-- Why the CASE guard:
--   - status='new' → advance to 'tow_ticket' (D2 intent)
--   - status='resolved' → KEEP (CA marked resolved mid-flight; don't
--     clobber on a re-stamp, hypothetical though that is post-B182)
--   - status='disputed' → KEEP (same reasoning)
--   - status='tow_ticket' → KEEP (already there; B182 guard would
--     refuse a re-stamp anyway, but defensive)
--
-- B182 already_stamped guard, scope checks, all other behavior:
-- UNCHANGED from b182.

CREATE OR REPLACE FUNCTION public.stamp_tow_ticket(
  p_violation_id        BIGINT,
  p_storage_facility_id BIGINT,
  p_tow_fee             NUMERIC
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company        TEXT;
  v_properties     TEXT[];
  v_row            violations%ROWTYPE;
  v_storage        storage_facilities%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- B182 already-stamped guard (UNCHANGED).
  IF v_row.tow_ticket_generated = true THEN
    RETURN jsonb_build_object(
      'error', 'already_stamped',
      'hint',  'Void the existing ticket and create a new violation entry to reissue.'
    );
  END IF;

  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_company)
    THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  -- D2 (2026-06-26): advance-from-new-only on stamp.
  -- See PART 4 docstring above for the CASE rationale.
  UPDATE violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_tow_fee,
         status                   = CASE WHEN status = 'new' THEN 'tow_ticket' ELSE status END
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Grants + migration audit rows
-- ════════════════════════════════════════════════════════════════════

-- Explicit REVOKE from anon + PUBLIC per
-- [[feedback-revoke-from-anon-explicitly]] +
-- [[feedback-function-public-grant-supabase-default]]
REVOKE EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.regenerate_tow_ticket(BIGINT, BIGINT, NUMERIC, TEXT, TEXT) TO authenticated;

-- stamp_tow_ticket grants UNCHANGED (CREATE OR REPLACE preserves them);
-- re-affirm defensively per the established discipline.
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM anon;
GRANT  EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) TO authenticated;

-- Audit: new RPC + RPC amendment + new columns
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'regenerate_tow_ticket',
  NULL,
  jsonb_build_object(
    'rpc',         'regenerate_tow_ticket',
    'migration',   '20260626_tow_ticket_regenerate_layer_1',
    'returns',     'jsonb',
    'role_gate',   'driver(perm) + company_admin + admin',
    'atomic',      TRUE,
    'invariant',   'void-first ordering; voided rows immutable; void_violation untouched'
  ),
  now()
);

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'stamp_tow_ticket',
  NULL,
  jsonb_build_object(
    'rpc',        'stamp_tow_ticket',
    'migration',  '20260626_tow_ticket_regenerate_layer_1',
    'change',     'D2 advance-from-new-only on stamp (status CASE guard)',
    'invariant',  'never clobbers resolved/disputed; B182 already_stamped guard preserved'
  ),
  now()
);

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_COLUMNS_ADDED',
  'violations + user_roles',
  NULL,
  jsonb_build_object(
    'migration',  '20260626_tow_ticket_regenerate_layer_1',
    'columns',    jsonb_build_array(
      'user_roles.can_regenerate_tow_ticket BOOLEAN NOT NULL DEFAULT FALSE',
      'violations.regenerate_reason TEXT',
      'violations.regenerate_reason_note TEXT',
      'violations.regenerated_from BIGINT FK→violations(id) ON DELETE SET NULL'
    ),
    'check',      'violations_regenerate_reason_valid (5-value enum)'
  ),
  now()
);

COMMIT;
