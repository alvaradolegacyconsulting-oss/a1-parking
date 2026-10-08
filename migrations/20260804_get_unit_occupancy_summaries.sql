-- ══════════════════════════════════════════════════════════════════════
-- 20260804_get_unit_occupancy_summaries.sql
-- New DEFINER RPC that returns unit-scoped occupancy (active residents
-- + their active plate counts) for a batch of units at one property.
-- Single source of truth for the manager-portal unit-occupancy surface.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS RPC EXISTS ──────────────────────────────────────────────
--
-- When a manager approves a pending resident or vehicle, the portal
-- should already be showing them who and what is currently tied to the
-- unit — so they don't have to look it up before deciding. Preflight
-- 2026-08-04 (FOR MATEO thread) surfaced that the codebase has THREE
-- different vehicle-counting predicates in production:
--
--   1. `is_active = TRUE`                                (ENFORCEMENT)
--   2. `status = 'active'`                               (user-facing counts, via countVehicles)
--   3. `is_active = TRUE AND status = 'active'`          (billing meter)
--
-- Jose's 2026-08-04 vehicles probe found 7 rows at Green Acres and 1
-- at Test Legacy Property where `status='active' AND is_active=FALSE`
-- — portal shows approved, enforcement will NOT authorize. That's a
-- separate finding, filed as backlog.
--
-- This RPC pins on ENFORCEMENT (`vehicles.is_active = TRUE`), matching
-- check_resident_plate's WHERE clause exactly. If we tell the manager
-- "4 plates currently authorized to park here" and 5 cars scan
-- authorized, we've handed them something worse than nothing. Every
-- surface reading this number must read from this one predicate.
--
-- ── PATH B SCOPING — DIRECT user_roles LOOKUP (NOT get_my_properties()) ──
--
-- `get_my_properties()` reads `SELECT property FROM user_roles WHERE
-- lower(email) = lower(auth.jwt() ->> 'email') LIMIT 1` — non-
-- deterministic if multiple user_roles rows share a lowered email.
-- 20260704_user_roles_unique_lower_email.sql adds the UNIQUE INDEX
-- that closes the class.
--
-- Jose confirmed 2026-08-04 the index (user_roles_lower_email_uidx)
-- IS present in production. The invariant is applied. So Path B is
-- now BELT-AND-BRACES rather than load-bearing — its 49 sibling
-- callers of get_my_properties() are safe under the invariant, and
-- so would this RPC be. Path B was written before the confirmation
-- landed; keeping it means correctness is invariant-independent
-- (see Mateo lock 2026-08-04: "a function whose correctness is
-- conditional on an external invariant is worse than one that
-- doesn't need it, independent of how likely the invariant is to
-- hold"). A future reader may simplify to get_my_properties()
-- deliberately, but do NOT do so casually — the belt has value.
--
-- Path B queries user_roles directly and aggregates ALL rows for the
-- caller, so multiple-row states can't hide properties.
--
-- The scope predicate is otherwise identical to the manager/leasing_
-- agent branch of check_authorized_plate (2026-07-23 ap_cascade):
-- `lower(trim(...))` on both sides for property match + company match
-- via user_roles.company = properties.company. Strictest of the three
-- property-matching conventions in tree — do NOT "align" this to the
-- ILIKE convention; the coupling of role + property + company must
-- stay tight.
--
-- ── ENFORCEMENT IS PROPERTY-SCOPED, NOT UNIT-SCOPED ──────────────────
--
-- check_resident_plate matches plate + property + is_active. It does
-- NOT consult unit. So a plate we attribute to unit 205 is authorized
-- EVERYWHERE ON THE PROPERTY, not only at 205. The unit attribution
-- is ours, for display fidelity ("who parks here"). Copy the client
-- renders reflects this — "N authorized plates", not "N plates
-- authorized to park here" (which reads as a unit-level enforcement
-- claim we don't make).
--
-- ── UNIT NORMALIZATION LIMIT — FAILS OPEN BY DESIGN ──────────────────
--
-- Unit match uses `lower(trim(...))` on both sides. Real-world unit
-- values at A1 include:
--   `[#67]`  — will NOT reconcile with `67`
--   `[136]` and `[Apt 136]` — same physical unit, DIFFERENT keys
-- Jose's 2026-08-04 probes surfaced both at Green Acres.
--
-- A missed match FAILS OPEN — no flag renders, and the manager is
-- NOT told anything was withheld. This is deliberate: a flag that
-- fires confidently against the wrong household is worse than no
-- flag (the manager acts on a false association, and a wrong answer
-- delivered with a red badge is more damaging than a missing one).
-- The design counts what enforcement counts, and enforcement is
-- property-scoped anyway; the unit link is display attribution, not
-- a security gate.
--
-- Data hygiene (normalizing the unit values themselves) is filed
-- separately as a backlog item (docs/backlog/unit-value-
-- normalization-green-acres.md). Do NOT add fuzzy or prefix-stripping
-- matching here — that shifts the fail mode from "silent absence"
-- to "confident wrong answer".
--
-- ── OUT-OF-SCOPE IS AN EXCEPTION, NOT A ZERO ─────────────────────────
--
-- A client that reads `total_active_residents` without first checking
-- an error flag renders "0 active residents in this unit" — a
-- POSITIVE CLAIM that the unit is empty, made in response to a scope
-- failure. The manager then approves believing the unit is vacant.
-- Same fail-open shape we keep hitting. Out-of-scope RAISES; the
-- client-side rule (documented in the client commit) is: a failed or
-- missing occupancy payload renders NOTHING — no badge, no line, no
-- "0 residents". Absence of information must look like absence.
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- 20260524_b74_rls_vehicles_visitor_passes.sql — check_resident_plate
-- 20260610_b155_2_f9_helper_lower_match.sql   — get_my_properties() shape
-- 20260610_b166_vehicles_resident_email.sql   — vehicles.resident_email
-- 20260704_user_roles_unique_lower_email.sql  — invariant this RPC is defensive against (pending Jose apply)
-- 20260723_ap_cascade_check_authorized_plate.sql — scope-check convention
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_unit_occupancy_summaries(
  p_property TEXT,
  p_units    TEXT[]
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email             TEXT;
  v_property_company  TEXT;
BEGIN
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RAISE EXCEPTION 'out_of_scope: property required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_units IS NULL OR array_length(p_units, 1) IS NULL THEN
    -- Empty batch is allowed — return empty units map, no scope check
    -- (nothing to leak). Caller may pre-collect an empty unit set on
    -- an empty resident list.
    RETURN jsonb_build_object('property', p_property, 'units', '{}'::jsonb);
  END IF;

  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'out_of_scope: unauthenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Resolve the passed property's company. Path B: no dependency on
  -- get_my_company() either — the LIMIT 1 concern applies to that
  -- helper too, and this RPC pins its own resolution.
  SELECT p.company INTO v_property_company
    FROM public.properties p
   WHERE lower(trim(p.name)) = lower(trim(p_property))
   LIMIT 1;

  IF v_property_company IS NULL THEN
    RAISE EXCEPTION 'out_of_scope: property not found' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Path B scope check: aggregate ALL user_roles rows for the caller,
  -- so multiple-row states (pending 20260704 UNIQUE index) can't hide
  -- properties. Matches check_authorized_plate manager-branch predicate
  -- exactly (lower(trim(...)) + company match) — do NOT "align" to
  -- the ILIKE convention; the coupling is deliberate.
  IF NOT EXISTS (
    SELECT 1
      FROM public.user_roles ur, unnest(ur.property) AS user_prop
     WHERE lower(ur.email) = lower(v_email)
       AND ur.role IN ('manager','leasing_agent','company_admin','admin')
       AND lower(trim(user_prop))  = lower(trim(p_property))
       AND lower(trim(ur.company)) = lower(trim(v_property_company))
  ) THEN
    RAISE EXCEPTION 'out_of_scope: caller not authorized for property' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Build per-unit occupancy. Predicate MUST match check_resident_
  -- plate exactly: is_active=TRUE + property match (ILIKE for text-
  -- drift tolerance, matches the enforcement predicate) + unit match
  -- (lower(trim()) — see UNIT NORMALIZATION LIMIT header comment).
  --
  -- Per-resident plate count links via BOTH resident_email AND unit.
  -- An anomalous vehicle whose resident_email matches R.Delgado but
  -- whose vehicle.unit differs from residents.unit is counted at the
  -- vehicle's unit, not the resident's — this predicate is for
  -- display accuracy at THIS unit. Enforcement is property-scoped
  -- (see header ENFORCEMENT IS PROPERTY-SCOPED note).
  --
  -- DEFENSIVE DEDUP: residents grouped by lower(email) so one person
  -- can never appear twice in one unit's panel. Jose 2026-08-04 found
  -- natalielop08@gmail.com with two residents rows at Apt 136; the
  -- residents table has NO unique constraint on email (20260704's
  -- UNIQUE(lower(email)) is on user_roles, not residents). This
  -- defense is cheap and independent of whatever residents-uniqueness
  -- decision follows (docs/backlog/residents-duplicate-row-
  -- uniqueness.md). total_active_residents also uses DISTINCT to
  -- match the array cardinality.
  --
  -- ORPHAN PLATES surfaced: total_active_plates counts ALL vehicles
  -- at the unit (is_active + property + unit). Sum of per-resident
  -- plate_counts may be LESS than total_active_plates when a vehicle
  -- at the unit has no matching residents row (manager-entered plates
  -- via b167, un-owned rows per B166 owner-stamp finding). Client
  -- labels the delta as "(N not linked to a resident)" so a manager
  -- reading "2 residents · 2+2 plates · total 5" gets the signal
  -- rather than an unexplained arithmetic gap.
  RETURN jsonb_build_object(
    'property', p_property,
    'units', COALESCE((
      SELECT jsonb_object_agg(u.unit_key, u.unit_payload)
        FROM (
          SELECT
            requested.unit AS unit_key,
            jsonb_build_object(
              'residents', COALESCE((
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'email',       x.email,
                    'name',        x.name,
                    'plate_count', x.plate_count
                  )
                  ORDER BY x.name NULLS LAST, x.email
                )
                FROM (
                  SELECT DISTINCT ON (lower(r.email))
                    r.email,
                    r.name,
                    COALESCE((
                      SELECT COUNT(*)
                        FROM public.vehicles v
                       WHERE v.property ILIKE p_property
                         AND lower(trim(v.unit))     = lower(trim(requested.unit))
                         AND lower(v.resident_email) = lower(r.email)
                         AND v.is_active             = TRUE
                    ), 0) AS plate_count
                  FROM public.residents r
                  WHERE r.property ILIKE p_property
                    AND r.is_active = TRUE
                    AND lower(trim(r.unit)) = lower(trim(requested.unit))
                  ORDER BY lower(r.email), r.name NULLS LAST
                ) x
              ), '[]'::jsonb),
              'total_active_residents', COALESCE((
                SELECT COUNT(DISTINCT lower(r.email))
                  FROM public.residents r
                 WHERE r.property ILIKE p_property
                   AND r.is_active = TRUE
                   AND lower(trim(r.unit)) = lower(trim(requested.unit))
              ), 0),
              'total_active_plates', COALESCE((
                SELECT COUNT(*)
                  FROM public.vehicles v
                 WHERE v.property ILIKE p_property
                   AND lower(trim(v.unit)) = lower(trim(requested.unit))
                   AND v.is_active         = TRUE
              ), 0)
            ) AS unit_payload
          FROM (
            SELECT DISTINCT unit
              FROM unnest(p_units) AS u(unit)
             WHERE unit IS NOT NULL
               AND length(trim(unit)) > 0
          ) AS requested
        ) AS u
    ), '{}'::jsonb)
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.get_unit_occupancy_summaries(TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_unit_occupancy_summaries(TEXT, TEXT[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_unit_occupancy_summaries(TEXT, TEXT[]) TO authenticated;

COMMENT ON FUNCTION public.get_unit_occupancy_summaries(TEXT, TEXT[]) IS
  'Manager-portal unit occupancy: for a batch of units at one property, returns per-unit active residents (email, name, plate_count) + totals. Predicate is_active=TRUE on both residents and vehicles — pinned to check_resident_plate enforcement predicate. Path B scoping (direct user_roles aggregation, does NOT call get_my_properties()) — defensive against 20260704 UNIQUE(lower(email)) index status. Out-of-scope RAISES (not zeros) — a client reading total_active_residents without checking error would render "0 residents" as fact. Unit match uses lower(trim(...)); #67 does not reconcile with 67 — bounded fail-open by design.';

COMMIT;
