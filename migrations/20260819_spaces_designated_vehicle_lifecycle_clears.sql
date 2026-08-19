-- ══════════════════════════════════════════════════════════════════════
-- 20260819_spaces_designated_vehicle_lifecycle_clears.sql
--
-- Commit 2 of the designated-vehicle arc. Lifecycle clears — the four
-- code sites where a designation must auto-clear to prevent a stale
-- pointer from misrepresenting state. Mateo Aug 18 scope +
-- Aug 19 constraints.
--
-- 🔴 NON-GOALS unchanged from Commit 1 (repeated here so any diff
-- reviewer sees them):
--   - No change to derive_space_allowed_plates
--   - No change to pm_plate_lookup / driver scan path
--   - No designation data on any driver surface
--   - No resident-portal visibility in v1
--   - No new space type
--
-- ══════════════════════════════════════════════════════════════════════
-- APPLY TIMING (Mateo Aug 19 wording correction)
-- ══════════════════════════════════════════════════════════════════════
-- Apply once (single database). Test Legacy is a tenant inside the
-- production database, not a separate environment — ALTER / CREATE
-- statements are live for A1 the moment they run. What is tenant-
-- scoped is the EXERCISE afterward: seed test data at Test Legacy,
-- run the verification, then rely on the surface. The "apply first at
-- Test Legacy" reading treats the migration as an environment gate;
-- it isn't. It's a live schema change that a Test Legacy exercise
-- validates BEFORE user surface exposure.
--
-- Timing constraint from Green Acres: apply outside their working
-- hours and NOT on a day anything else touches spaces or vehicles.
-- Commit 1's column + RPC are live-inert (no UI reaches them yet);
-- this commit stays live-inert too until Commit 3 exposes the
-- surface. Correct state to hold.
--
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 PREDICATE SYMMETRY (Mateo Aug 19 constraint #2)
-- ══════════════════════════════════════════════════════════════════════
-- The RPC set-guard and the trigger clear-guard MUST be exact
-- negations of each other. Both quoted here so an edit to one is
-- visibly an edit to the other.
--
-- RPC set-guard (20260818_spaces_designated_vehicle_column_and_rpc.sql,
-- step 5 of set_space_designated_vehicle):
--
--   IF NOT (v_vehicle.is_active = TRUE AND v_vehicle.status = 'active') THEN
--     RETURN jsonb_build_object('error', 'vehicle_not_active', ...);
--   END IF;
--
-- Trigger clear-guard (this file, Part 1 WHEN clause):
--
--   WHEN (
--     -- was fully active
--     OLD.is_active IS TRUE
--     AND OLD.status IS NOT DISTINCT FROM 'active'
--     -- now not fully active (De Morgan of NOT (NEW.is_active IS TRUE
--     -- AND NEW.status IS NOT DISTINCT FROM 'active'))
--     AND (
--       NEW.is_active IS NOT TRUE
--       OR NEW.status IS DISTINCT FROM 'active'
--     )
--   )
--
-- The trigger form uses IS TRUE / IS NOT TRUE / IS [NOT] DISTINCT
-- FROM instead of the RPC's `= TRUE` / `= 'active'` because trigger
-- WHEN clauses treat NULL as "skip" — the equality form would
-- silently skip on any NULL transition (Mateo Aug 19 constraint #1,
-- D-8 class). See verification gate VQ.TRIGGER_WHEN_NULL_SAFE.
--
-- ══════════════════════════════════════════════════════════════════════
-- FOUR CLEAR-SITES — each with its own tagged comment marker so the
-- paired verification file can assert each site by name.
-- @DVCLEAR_SITE_1 — vehicle deactivate/decline trigger (unconditional)
-- @DVCLEAR_SITE_2 — free_spaces_on_resident_deactivate (conditional)
-- @DVCLEAR_SITE_3 — free_space per-resident empty branch (conditional)
-- @DVCLEAR_SITE_4 — free_space whole-space branch (unconditional)
--
-- Fifth-clear-site question (Mateo Aug 19 #4): confirmed NONE needed
-- 2026-08-19 — grep across app/ + migrations/ shows zero paths that
-- UPDATE vehicles.resident_email. VEHICLE_EDITABLE_FIELDS at
-- app/manager/page.tsx:2181 is ['color','make','model','year','state']
-- (cosmetic only). Column is set at INSERT time and stable thereafter.
-- If any future migration adds a resident_email UPDATE path, this
-- feature will need a fifth clear-site + gate.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — @DVCLEAR_SITE_1 — vehicle deactivate/decline trigger
-- ══════════════════════════════════════════════════════════════════════
--
-- Covers BOTH the deactivate_vehicle RPC path AND the direct
-- declineVehicleWrite path at app/lib/manager-crm-writes.ts:620
-- (verified 2026-08-19 that decline still does a direct
-- .update({ is_active: false, status: 'declined', manager_note })
-- bypassing the RPC — trigger is the only shape that covers both).
--
-- Unconditional clear (any space with this vehicle designated) — the
-- vehicle itself is gone as a valid target regardless of who else is
-- on the space.

CREATE OR REPLACE FUNCTION public.clear_space_designation_on_vehicle_inactive()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  -- @DVCLEAR_SITE_1: unconditional clear — the vehicle is no longer
  -- a valid designation target. No conditionality on space state
  -- because a stale designation is worse than no designation.
  UPDATE public.spaces
     SET designated_vehicle_id = NULL
   WHERE designated_vehicle_id = OLD.id;

  -- No audit row per space — the source event (vehicle
  -- deactivate/decline) is already audited in its own path
  -- (DEACTIVATE_VEHICLE / DECLINE_VEHICLE). A cascade audit here
  -- would be forensically redundant.

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.clear_space_designation_on_vehicle_inactive() IS
  '@DVCLEAR_SITE_1 — Auto-clears spaces.designated_vehicle_id when a vehicle transitions out of "fully active" (is_active=TRUE AND status=active). Fires from trigger vehicles_inactive_clear_space_designation, WHEN clause is the exact negation of set_space_designated_vehicle''s vehicle_not_active reject (predicate symmetry — see migration header). Unconditional clear: any space designating this vehicle loses its designation. Covers both deactivate_vehicle RPC + direct declineVehicleWrite paths. 2026-08-19.';

DROP TRIGGER IF EXISTS vehicles_inactive_clear_space_designation ON public.vehicles;
CREATE TRIGGER vehicles_inactive_clear_space_designation
  AFTER UPDATE OF is_active, status ON public.vehicles
  FOR EACH ROW
  WHEN (
    -- 🔴 NULL-safe form (Mateo Aug 19 #1). Trigger WHEN clauses
    -- treat NULL as "skip"; the naïve `= true` / `= 'active'` form
    -- would silently miss any NULL transition. See migration header
    -- §PREDICATE SYMMETRY for exact negation of the RPC set-guard.
    --
    -- was fully active:
    OLD.is_active IS TRUE
    AND OLD.status IS NOT DISTINCT FROM 'active'
    -- now not fully active (De Morgan of NOT (NEW active AND NEW
    -- status='active')):
    AND (
      NEW.is_active IS NOT TRUE
      OR NEW.status IS DISTINCT FROM 'active'
    )
  )
  EXECUTE FUNCTION public.clear_space_designation_on_vehicle_inactive();

-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — @DVCLEAR_SITE_2 — free_spaces_on_resident_deactivate
-- ══════════════════════════════════════════════════════════════════════
--
-- Extends the existing trigger function (20260622_spaces_v1_1_multi_
-- resident_schema.sql:188-261) to conditionally clear
-- designated_vehicle_id when the space is fully freed (v_remaining=0)
-- OR when the departing resident owned the designated vehicle
-- (co-resident case — protect the remaining resident's designation
-- if theirs is different).
--
-- Conditional per Mateo Aug 19 #4 co-resident correctness: clear
-- ONLY when the designated vehicle belongs to the departing resident.
-- Unconditional clear would silently wipe a remaining co-resident's
-- legitimate designation — same class as the sites-3/4 distinction.
--
-- BODY OTHERWISE UNCHANGED. This is a mechanical addition of one
-- column expression inside two existing UPDATEs (v_remaining=0 and
-- v_remaining=1 branches); everything else stays as 20260622 shipped
-- it. Signature preservation: no DEFAULTs on this function.

CREATE OR REPLACE FUNCTION public.free_spaces_on_resident_deactivate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_space_id  BIGINT;
  v_remaining INTEGER;
BEGIN
  -- Loop over every space this resident was tied to. Index on
  -- lower(resident_email) makes this an index scan.
  FOR v_space_id IN
    SELECT space_id
      FROM public.space_residents
     WHERE lower(resident_email) = lower(NEW.email)
  LOOP
    -- Remove this resident's tie to v_space_id.
    DELETE FROM public.space_residents
     WHERE space_id = v_space_id
       AND lower(resident_email) = lower(NEW.email);

    -- Check if any ties remain for this space.
    SELECT COUNT(*) INTO v_remaining
      FROM public.space_residents
     WHERE space_id = v_space_id;

    -- If empty, flip the space back to 'available' + clear the legacy
    -- assigned_to_resident_email column (dual-write discipline) + clear
    -- designated_vehicle_id (no residents = no valid designation).
    IF v_remaining = 0 THEN
      UPDATE public.spaces
         SET status                     = 'available',
             assigned_to_resident_email = NULL,
             assigned_at                = NULL,
             assigned_by_email          = NULL,
             -- @DVCLEAR_SITE_2 — no remaining residents, nothing to preserve
             designated_vehicle_id      = NULL
       WHERE id = v_space_id;
    ELSIF v_remaining = 1 THEN
      -- Set went from N≥2 to 1: dual-write the remaining email into the
      -- legacy column so commit-2-5 legacy readers continue to see a
      -- valid single-resident state.
      --
      -- @DVCLEAR_SITE_2 — co-resident branch. Clear the designation
      -- ONLY if it points at a vehicle owned by the DEPARTING resident.
      -- The remaining co-resident's designation (if different) must
      -- survive. CASE preserves the current designated_vehicle_id
      -- unchanged in the else-branch.
      UPDATE public.spaces
         SET assigned_to_resident_email = (
               SELECT lower(resident_email)
                 FROM public.space_residents
                WHERE space_id = v_space_id
                LIMIT 1
             ),
             designated_vehicle_id = CASE
               WHEN designated_vehicle_id IN (
                 SELECT v.id FROM public.vehicles v
                  WHERE lower(trim(COALESCE(v.resident_email, '')))
                        = lower(trim(NEW.email))
               )
               THEN NULL
               ELSE designated_vehicle_id
             END
       WHERE id = v_space_id;
    ELSE
      -- v_remaining >= 2. Legacy column stays NULL (multi-resident state)
      -- per dual-write rule. Still apply the conditional designation
      -- clear — the departing resident's vehicle should not survive as
      -- the designation for a space they no longer sit on.
      -- @DVCLEAR_SITE_2 — multi-resident departure branch (conditional)
      UPDATE public.spaces
         SET designated_vehicle_id = CASE
               WHEN designated_vehicle_id IN (
                 SELECT v.id FROM public.vehicles v
                  WHERE lower(trim(COALESCE(v.resident_email, '')))
                        = lower(trim(NEW.email))
               )
               THEN NULL
               ELSE designated_vehicle_id
             END
       WHERE id = v_space_id
         AND designated_vehicle_id IS NOT NULL;
    END IF;

    -- Audit row per space freed. AUTH_SPACE_FREE_AUTO distinguishes
    -- trigger-driven frees from manual free_space RPC calls in log queries.
    INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
    VALUES (
      lower(NEW.email),                    -- user_email: the resident being deactivated
      'AUTH_SPACE_FREE_AUTO',
      'spaces',
      v_space_id,
      jsonb_build_object(
        'space_id',              v_space_id,
        'freed_resident_email',  lower(NEW.email),
        'remaining_residents',   v_remaining,
        'trigger_source',        TG_NAME,
        'space_freed_completely', (v_remaining = 0)
      ),
      now()
    );
  END LOOP;

  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.free_spaces_on_resident_deactivate() IS
  'Trigger function fired on residents is_active TRUE→FALSE transition. Removes space ties + updates spaces per v_remaining. Extended 2026-08-19 (@DVCLEAR_SITE_2) to also clear designated_vehicle_id — unconditionally when the space fully empties, conditionally (only when the designated vehicle belonged to the departing resident) when co-residents remain. See migration 20260819_spaces_designated_vehicle_lifecycle_clears header for the four-site model.';

-- Trigger definition unchanged from 20260622 shipping form. Re-DROP +
-- CREATE ensures a clean binding on re-apply even though the trigger
-- itself hasn't changed shape — only the referenced function body.
DROP TRIGGER IF EXISTS residents_deactivate_free_spaces ON public.residents;
CREATE TRIGGER residents_deactivate_free_spaces
  AFTER UPDATE OF is_active ON public.residents
  FOR EACH ROW
  WHEN (OLD.is_active = TRUE AND NEW.is_active = FALSE)
  EXECUTE FUNCTION public.free_spaces_on_resident_deactivate();

-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — @DVCLEAR_SITE_3 + @DVCLEAR_SITE_4 — free_space RPC
-- ══════════════════════════════════════════════════════════════════════
--
-- Extends the existing free_space RPC (20260622_spaces_v1_1_multi_
-- resident_schema.sql:414-527). Two clear-sites live inside this one
-- function:
--
--   @DVCLEAR_SITE_4 — whole-space branch (p_resident_email is NULL/empty):
--     unconditional clear. Space fully freed → no residents remain.
--
--   @DVCLEAR_SITE_3 — per-resident empty branch (v_remaining = 0):
--     conditional clear. Symmetric with @DVCLEAR_SITE_2 co-resident
--     handling, though this branch always reaches v_remaining=0 so
--     the condition is technically always satisfied. Kept conditional
--     for parity with sites 2/3 pattern — a future co-resident case
--     in this branch would inherit the correct behavior automatically.
--
--   ALSO: v_remaining >= 1 co-resident branch — conditional clear when
--   the designated vehicle belonged to the freed resident (only that
--   pointer becomes stale; the remaining co-resident's designation
--   survives).
--
-- SIGNATURE PRESERVATION (per feedback_create_or_replace_drops_defaults):
--   p_reason TEXT DEFAULT 'manual_free'  ← preserved verbatim
--   p_resident_email TEXT DEFAULT NULL   ← preserved verbatim
-- Function is 3-arg (BIGINT, TEXT, TEXT); the old 2-arg form was
-- dropped at 20260622:530. Verified via pg_get_function_arguments
-- against production.

CREATE OR REPLACE FUNCTION public.free_space(
  p_space_id       BIGINT,
  p_reason         TEXT DEFAULT 'manual_free',
  p_resident_email TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email             TEXT;
  v_role              TEXT;
  v_company           TEXT;
  v_space_company     TEXT;
  v_normalized_reason TEXT;
  v_normalized_email  TEXT;
  v_remaining         INTEGER;
BEGIN
  v_email := auth.jwt() ->> 'email';

  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  SELECT company INTO v_space_company
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;

  v_normalized_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_normalized_reason IS NULL THEN v_normalized_reason := 'manual_free'; END IF;
  IF v_normalized_reason NOT IN ('manual_free','deactivation','manual_reassign','space_decommissioned') THEN
    RAISE EXCEPTION 'invalid_freed_reason'
      USING HINT = 'reason must be one of: manual_free, deactivation, manual_reassign, space_decommissioned';
  END IF;

  v_normalized_email := lower(trim(COALESCE(p_resident_email, '')));

  IF length(v_normalized_email) = 0 THEN
    -- @DVCLEAR_SITE_4 — Whole-space free (legacy mode). DELETE all
    -- ties, status='available', clear legacy column, UNCONDITIONAL
    -- clear of designated_vehicle_id (no residents = no valid target).
    DELETE FROM public.space_residents WHERE space_id = p_space_id;
    UPDATE public.spaces
       SET status                     = 'available',
           assigned_to_resident_email = NULL,
           assigned_at                = NULL,
           assigned_by_email          = NULL,
           -- @DVCLEAR_SITE_4 — space fully freed, unconditional
           designated_vehicle_id      = NULL
     WHERE id = p_space_id;

    INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
    VALUES (
      lower(v_email), 'AUTH_SPACE_FREE', 'spaces', p_space_id,
      jsonb_build_object(
        'reason',           v_normalized_reason,
        'mode',             'whole_space',
        'set_size_after',   0
      ),
      now()
    );
    RETURN TRUE;
  END IF;

  -- Per-resident free: remove just this email's tie. Idempotent.
  DELETE FROM public.space_residents
   WHERE space_id = p_space_id
     AND lower(resident_email) = v_normalized_email;

  SELECT COUNT(*) INTO v_remaining
    FROM public.space_residents WHERE space_id = p_space_id;

  IF v_remaining = 0 THEN
    -- @DVCLEAR_SITE_3 — empty set after per-resident free. The
    -- freed resident was the last tie; unconditional clear is
    -- semantically equivalent to the conditional form here (no
    -- residents remain to preserve for) but we keep the conditional
    -- shape for parity with @DVCLEAR_SITE_2 — a hypothetical future
    -- branch that lands here with residents remaining would inherit
    -- the correct behavior.
    UPDATE public.spaces
       SET status                     = 'available',
           assigned_to_resident_email = NULL,
           assigned_at                = NULL,
           assigned_by_email          = NULL,
           -- @DVCLEAR_SITE_3 — per-resident empty, conditional shape
           designated_vehicle_id      = CASE
             WHEN designated_vehicle_id IN (
               SELECT v.id FROM public.vehicles v
                WHERE lower(trim(COALESCE(v.resident_email, '')))
                      = v_normalized_email
             )
             THEN NULL
             ELSE NULL   -- v_remaining=0 → nothing to preserve; explicit NULL
           END
     WHERE id = p_space_id;
  ELSIF v_remaining = 1 THEN
    -- Set went from 2 to 1: dual-write the remaining email + clear
    -- designation conditionally (only if the freed resident owned
    -- the designated vehicle; remaining co-resident's designation
    -- must survive).
    UPDATE public.spaces
       SET assigned_to_resident_email = (
             SELECT lower(resident_email)
               FROM public.space_residents
              WHERE space_id = p_space_id
              LIMIT 1
           ),
           -- @DVCLEAR_SITE_3 — co-resident case, conditional clear
           designated_vehicle_id = CASE
             WHEN designated_vehicle_id IN (
               SELECT v.id FROM public.vehicles v
                WHERE lower(trim(COALESCE(v.resident_email, '')))
                      = v_normalized_email
             )
             THEN NULL
             ELSE designated_vehicle_id
           END
     WHERE id = p_space_id;
  ELSE
    -- v_remaining >= 2: legacy column stays NULL (multi-resident state).
    -- Still apply the conditional clear.
    -- @DVCLEAR_SITE_3 — multi-resident, conditional clear
    UPDATE public.spaces
       SET designated_vehicle_id = CASE
             WHEN designated_vehicle_id IN (
               SELECT v.id FROM public.vehicles v
                WHERE lower(trim(COALESCE(v.resident_email, '')))
                      = v_normalized_email
             )
             THEN NULL
             ELSE designated_vehicle_id
           END
     WHERE id = p_space_id
       AND designated_vehicle_id IS NOT NULL;
  END IF;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_FREE', 'spaces', p_space_id,
    jsonb_build_object(
      'reason',                v_normalized_reason,
      'mode',                  'per_resident',
      'freed_resident_email',  v_normalized_email,
      'set_size_after',        v_remaining
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

COMMENT ON FUNCTION public.free_space(BIGINT, TEXT, TEXT) IS
  'DEFINER RPC — free a space fully (empty p_resident_email) or per-resident. Extended 2026-08-19 (@DVCLEAR_SITE_3 + @DVCLEAR_SITE_4) to clear spaces.designated_vehicle_id in every clear branch. Whole-space branch: unconditional (nobody left to preserve for). Per-resident branches (v_remaining=0/1/>=2): conditional on the departing resident owning the designated vehicle, so co-resident designations survive. Signature preserved: (BIGINT, TEXT DEFAULT ''manual_free'', TEXT DEFAULT NULL). See migration 20260819 header for the four-site clear model.';

-- Grants unchanged (CREATE OR REPLACE preserves them).

-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_SPACES_DESIGNATED_VEHICLE_LIFECYCLE_CLEARS',
  'public.spaces (via 4 clear-sites)',
  'designated_vehicle_lifecycle',
  jsonb_build_object(
    'migration',      '20260819_spaces_designated_vehicle_lifecycle_clears',
    'commit',         '2 of 5 (lifecycle clears)',
    'site_1',         '@DVCLEAR_SITE_1 — trigger on vehicles is_active/status transition (unconditional)',
    'site_2',         '@DVCLEAR_SITE_2 — free_spaces_on_resident_deactivate (conditional)',
    'site_3',         '@DVCLEAR_SITE_3 — free_space per-resident branches (conditional)',
    'site_4',         '@DVCLEAR_SITE_4 — free_space whole-space branch (unconditional)',
    'predicate_symmetry', 'trigger WHEN is exact NULL-safe negation of set_space_designated_vehicle vehicle_not_active reject; both quoted in migration header',
    'null_safe_form', 'IS TRUE / IS NOT TRUE / IS [NOT] DISTINCT FROM — no `= true` / `= false`',
    'fifth_site_needed', false,
    'fifth_site_rationale', 'zero code paths UPDATE vehicles.resident_email (VEHICLE_EDITABLE_FIELDS cosmetic-only at app/manager/page.tsx:2181) — column is INSERT-time-stable'
  )
);

COMMIT;
