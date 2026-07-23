-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_b2_function_scope_fix.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT Commit B2 — function-level company scope fix on 5 DNT lookups.
--
-- ── The defect ─────────────────────────────────────────────────────────
-- All existing DNT lookups (check_dnt_plate, pm_plate_lookup branch 0,
-- set_violation_status tow_ticket guard, stamp_tow_ticket guard) match
-- on property NAME only. A plate on Company X's "Main Street Lot" DNT
-- list also matches Company Y's "Main Street Lot" — same cross-tenant
-- leak class that B1 just closed at the RLS layer.
--
-- regenerate_tow_ticket has NO DNT guard at all. It voids the original
-- and inline-stamps a new violation (Step 4 of its body), bypassing
-- stamp_tow_ticket's guard entirely. This is the gap Commit A's
-- confirmation query surfaced (`references_dnt: false`).
--
-- ── The fix (one migration, five functions, each touched once) ─────────
--   • check_dnt_plate       — full rewrite: is_dnt captured BEFORE
--                             reason suppression, role-conditional
--                             reason (default-deny), driver branch uses
--                             get_my_company() as single source, DNT
--                             lookup company-scoped (with admin escape)
--   • pm_plate_lookup       — branch 0 only: DNT lookup gains company
--                             scope. Everything else byte-identical.
--                             No admin escape needed (role-gated to
--                             manager/leasing_agent at line 293).
--   • set_violation_status  — DNT guard block: CANONICAL role-aware
--                             (with admin escape as no-op since CA-only)
--   • stamp_tow_ticket      — DNT guard block: CANONICAL role-aware
--                             (admin escape active)
--   • regenerate_tow_ticket — NEW DNT guard at entry, after row load +
--                             caller company-scope check, before storage
--                             facility validation. CANONICAL block via
--                             one-line v_row := v_original alias, so
--                             the guard block is byte-identical across
--                             all three tow paths.
--
-- ── Canonical DNT guard block (byte-identical across 3 tow paths) ──────
-- Identical text lets one VQ meaningfully assert the control across all
-- three call sites. Textual divergence is how stamp/regenerate diverged
-- in the first place — comment banners are documentation, byte-identical
-- source is a control. Uses get_my_company() lower()-only normalization
-- with a fail-closed sentinel (company_unresolved) distinct from
-- do_not_tow_active — a context failure rendered as "vehicle protected"
-- is the lying-message class this arc has been careful to avoid.
--
-- ── dnt_p alias — VQ target unique to the DNT block ────────────────────
-- All 5 DNT lookups alias the properties join as `dnt_p` (not `p`).
-- VQ.COMPANY asserts `lower(trim(dnt_p.company)) = lower(trim(get_my_company()))`
-- as an exact string, unique to the DNT block and unreachable from
-- caller-authorization code that already contains get_my_company()
-- (e.g., set_violation_status:509). Stays precise after the ~~*
-- cross-company cleanup lands (filed as Bar-2 blocker; see below).
--
-- ── Admin escape is deliberately over-broad ────────────────────────────
-- admin's DNT lookup omits the company predicate (v_caller_role='admin'
-- OR company match). violations has no company column, so v_row.property
-- cannot be resolved to a single tenant by name. Admin's DNT lookup
-- matches ANY tenant's DNT row with that plate+property-name; that is:
--
--   FALSE REFUSAL (admin refused because another tenant protected the
--   plate at a same-named property) — safe direction for a protection
--   feature. There is NO false permit risk here.
--
-- Do NOT "harden" admin into the scoped branch — the tenant of
-- v_row.property cannot be determined from name alone, so scoping admin
-- would silently under-protect. See v_caller_role='admin' OR ... anchor.
--
-- ── get_my_company() normalization asymmetry (rationale for sentinel) ──
-- get_my_company() normalizes with `lower(email)` only — there is NO
-- trim(). Whitespace-bearing stored emails resolve to NULL. The
-- company_unresolved fail-closed sentinel in the tow guards exists
-- specifically because of this. See:
--   migrations/20260610_b155_2_f9_helper_lower_match.sql:72-80
--
-- ── check_dnt_plate fail-SOFT asymmetry (deliberate) ───────────────────
-- Unlike the tow guards (fail-closed on company_unresolved),
-- check_dnt_plate is a READ. NULL company → returns {is_dnt:false,
-- reason:null} via the authorization branch failing. This matches the
-- read-only convention: readers do not raise; they return safely.
-- Protection is downstream in the tow guards, which DO fail closed.
--
-- ── Status vocabulary (verified 2026-07-23) ────────────────────────────
-- CHECK constraint from 20260624_b219_violation_status_lifecycle.sql:104
--   status IN ('new', 'tow_ticket', 'resolved', 'disputed')
-- tow_ticket is the ONLY tow-initiating value. set_violation_status
-- guard fires only when p_new_status='tow_ticket'. If this vocabulary
-- is ever widened with another tow-initiating value, this guard needs
-- review — no VQ catches an unrelated migration widening the CHECK.
--
-- ── stamp_tow_ticket auto-advance (covered by same guard) ──────────────
-- stamp_tow_ticket's Step 4 inline UPDATE sets status='tow_ticket' as
-- part of the stamp. That auto-advance is covered by the same DNT
-- guard block at the top of stamp_tow_ticket — no separate branch.
--
-- ── Pre-apply state (negative controls, to be verified by Jose) ────────
-- Executed against the current schema BEFORE this migration:
--   VQ.PARITY       — expect FAIL naming regenerate_tow_ticket
--                     (references_dnt: false; other 4 true — per
--                      Commit A confirmation query)
--   VQ.COMPANY      — expect FAIL naming all 5 sites (none contain
--                     'dnt_p' alias yet; existing 4 use bare `p` and
--                      lack company predicate in DNT lookup;
--                      regenerate has no DNT lookup)
--   VQ.LIFECYCLE    — expect PASS on 4, FAIL on regenerate_tow_ticket
--                     (existing 4 already have removed_at + expires_at;
--                      regenerate has no DNT lookup yet)
--   VQ.SIGNATURE    — expect PASS pre and post (each function is
--                     already single-definition)
--   VQ.UNRESOLVED   — expect FAIL naming all 3 tow-path guards
--                     (company_unresolved sentinel not yet present)
--   VQ.ISDNT_ORDER  — expect FAIL (v_is_dnt doesn't exist yet)
--   VQ.REASON_ROLE  — expect FAIL (role-conditional return shape not
--                     yet present in check_dnt_plate)
--   VQ.AUDIT        — expect FAIL pre; PASS post
-- Every VQ has a real pre-apply failure output → validated as detector
-- before it is relied upon. Silent post-apply then means the fix
-- landed, not that the check is toothless.
--
-- ── Observed but NOT in B2 scope (filed as Bar-2 blocker) ──────────────
-- Pre-existing ~~* (ILIKE) caller-authorization checks exist in:
--   set_violation_status:527-533       (cross-company check on violation)
--   regenerate_tow_ticket:374-381      (cross-company check on violation)
--   regenerate_tow_ticket:391-396      (cross-company check on storage)
--   stamp_tow_ticket:681-715           (cross-company check on both)
-- These are NOT DNT lookups; they are caller-scope checks that predate
-- DNT. They are wildcard-vulnerable and, once public_signup_open flips,
-- a caller at 'Smith_Towing' passes the ILIKE against 'SmithXTowing's
-- violation → reaches the DNT guard → DNT guard scopes to CALLER's
-- company → nothing matches → tow permitted on a vehicle the OTHER
-- tenant protected. B2's guard is present, correct, and irrelevant.
--
-- Filed as Bar-2 launch blocker (BAR2_launch_checklist_july13_2026.md).
-- Not folded into B2 to keep the migration scoped to DNT lookups and
-- preserve a clean rollback story. dnt_p alias makes VQ.COMPANY stable
-- against the incoming rewrite.
--
-- ── Rollback ───────────────────────────────────────────────────────────
-- Re-apply the 4 existing function definitions from:
--   migrations/20260723_do_not_tow_cascade_and_guards.sql
--     - lines 149-250: check_dnt_plate + REVOKE/GRANT
--     - lines 263-470: pm_plate_lookup + pg_proc chk + REVOKE/GRANT
--     - lines 479-600: set_violation_status + REVOKE/GRANT
--     - lines 611-735: stamp_tow_ticket
-- And re-apply the prior regenerate_tow_ticket definition from:
--   migrations/20260629_violations_mileage_vin_persistence.sql:278-552
-- Rollback drops the added DNT guard from regenerate.
--
-- ── Apply history ──────────────────────────────────────────────────────
-- This migration was applied THREE times:
--   1. Original — divergent CANONICAL marker decoration in
--      set_violation_status (2 fewer trailing `──` box-drawing chars
--      than stamp/regenerate, shortened for indent alignment inside
--      `IF p_new_status='tow_ticket' THEN`). Verification aborted at
--      VQ.CANONICAL. VQ.CANONICAL correctly named the outlier
--      (set_violation_status, whitespace-normalized hash 957f4b92,
--      vs the matching d2070c67 hash of stamp + regenerate). Because
--      the transaction aborted at VQ.CANONICAL, VQ.AUDIT never ran.
--      Ship report footnote: second validated detector in the arc
--      after VQ.1, both observed doing their job.
--   2. Unchanged re-apply — same source, no guard on the audit insert.
--      Landed a second SCHEMA_ audit row.
--   3. Corrected (this file end state) — marker standardization
--      (trailing `──` decoration stripped from all 6 marker lines),
--      VQ.CANONICAL hardening (anchor moved to core semantic substring,
--      exactly-once + order pre-checks added before extraction), and
--      NOT EXISTS wrap on the SCHEMA_ audit insert below.
--
-- audit_logs holds TWO SCHEMA_DNT_B2_FUNCTION_SCOPE_FIX rows, NOT
-- three: the NOT EXISTS guard landed in apply 3 and suppressed its own
-- insert. Row count is NOT a proxy for apply count for this migration.
-- Do not hand-delete the duplicate — audit_logs is append-only by
-- design; a hand-deleted audit row is a worse artifact than a
-- duplicated one.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — check_dnt_plate: full rewrite
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_dnt_plate(
  p_plate    TEXT,
  p_property TEXT
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized TEXT;
  v_reason     TEXT;
  v_is_dnt     BOOLEAN;
  v_role       TEXT;
  v_email      TEXT;
  v_authorized BOOLEAN := FALSE;
BEGIN
  IF p_plate IS NULL OR p_property IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_role := get_my_role();
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  v_normalized := UPPER(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF v_normalized = '' THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  -- ── CALLER-SCOPE CHECK ───────────────────────────────────────────
  IF v_role = 'admin' THEN
    v_authorized := TRUE;

  ELSIF v_role IN ('manager', 'leasing_agent') THEN
    v_authorized := EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) prop
       WHERE lower(trim(prop)) = lower(trim(p_property))
    );

  ELSIF v_role = 'driver' THEN
    -- B2: assigned_properties still from drivers.assigned_properties
    -- (that's what drivers table is authoritative for), but the COMPANY
    -- answer moves to get_my_company() as single source of truth. LATERAL
    -- join required for unnest to see d.* — implicit lateral inside a
    -- JOIN tree loses visibility.
    v_authorized := EXISTS (
      SELECT 1
        FROM public.drivers d
        CROSS JOIN LATERAL unnest(d.assigned_properties) AS prop
        JOIN public.properties dnt_p
          ON lower(trim(dnt_p.name))    = lower(trim(prop))
         AND lower(trim(dnt_p.company)) = lower(trim(get_my_company()))
       WHERE lower(d.email)         = lower(v_email)
         AND lower(trim(prop))      = lower(trim(p_property))
    );

  ELSIF v_role = 'company_admin' THEN
    v_authorized := EXISTS (
      SELECT 1 FROM public.properties dnt_p
       WHERE lower(trim(dnt_p.company)) = lower(trim(get_my_company()))
         AND lower(trim(dnt_p.name))    = lower(trim(p_property))
    );

  ELSE
    -- residents, unknown roles: no enforcement power → denied
    v_authorized := FALSE;
  END IF;

  IF NOT v_authorized THEN
    RETURN jsonb_build_object('is_dnt', false, 'reason', NULL);
  END IF;

  -- ── DNT lookup (only reached if authorized) ──────────────────────
  -- Company predicate added (with admin escape). Lifecycle filters
  -- preserved. Property-name join uses lower(trim()) both sides.
  SELECT dnt.reason INTO v_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(dnt_p.name)) = lower(trim(p_property))
     AND (v_role = 'admin'
          OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  -- Capture is_dnt from v_reason BEFORE role-conditional suppression.
  -- If suppression flips v_reason to NULL for drivers, is_dnt must
  -- still be TRUE so the DO NOT TOW card still renders on their surface.
  v_is_dnt := v_reason IS NOT NULL;

  RETURN jsonb_build_object(
    'is_dnt', v_is_dnt,
    'reason', CASE
                WHEN v_role IN ('manager','leasing_agent','company_admin','admin')
                  THEN v_reason
                ELSE NULL   -- default-deny: unknown roles inherit nothing
              END
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.check_dnt_plate(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_dnt_plate(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_dnt_plate(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — pm_plate_lookup: branch 0 gains company scope
-- ══════════════════════════════════════════════════════════════════════
-- Everything outside branch 0 is byte-identical to the prior definition
-- in 20260723_do_not_tow_cascade_and_guards.sql:263-454. Only the DNT
-- SELECT (branch 0) changes: dnt_p alias + company predicate.
-- Restricted to manager/leasing_agent by role gate — no admin escape.
DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT);

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email          TEXT;
  v_role                  TEXT;
  v_properties            TEXT[];
  v_properties_normalized TEXT[];
  v_normalized            TEXT;
  v_vehicle_unit          TEXT;
  v_visitor_unit          TEXT;
  v_guest_name            TEXT;
  v_guest_unit            TEXT;
  v_guest_end             DATE;
  v_result_type           TEXT;
  v_unit_number           TEXT;
  v_dnt_reason            TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  v_properties_normalized := ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p);

  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 0. Do Not Tow match — B2: company predicate + dnt_p alias ────
  -- Company predicate added (no admin escape — pm_plate_lookup
  -- restricted to manager/leasing_agent, both of which require a
  -- resolvable company via the caller-has-no-assigned-properties path
  -- above). Lifecycle filters preserved. Reason returned as-is —
  -- portal surface per Jose 2026-07-23 driver-vs-portal boundary.
  SELECT dnt.reason INTO v_dnt_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(dnt_p.name))    = ANY (v_properties_normalized)
     AND lower(trim(dnt_p.company)) = lower(trim(get_my_company()))
     AND dnt.removed_at IS NULL
     AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
   LIMIT 1;

  IF v_dnt_reason IS NOT NULL THEN
    v_result_type := 'do_not_tow';
    v_unit_number := NULL;
  END IF;

  -- ── Branches 1-6 (byte-identical to prior definition) ────────────
  IF v_result_type IS NULL THEN
  -- ── 1. Resident match (active permit) ──────────────────────────
  SELECT v.unit INTO v_vehicle_unit
  FROM vehicles v
  WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
    AND v.is_active = TRUE
    AND lower(trim(v.property)) = ANY (v_properties_normalized)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 2. Pending permit match (B230) ────────────────────────────
    SELECT v.unit INTO v_vehicle_unit
    FROM vehicles v
    WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND v.is_active = FALSE
      AND v.status    = 'pending'
      AND lower(trim(v.property)) = ANY (v_properties_normalized)
    LIMIT 1;

    IF v_vehicle_unit IS NOT NULL THEN
      v_result_type := 'pending';
      v_unit_number := v_vehicle_unit;
    ELSE
      -- ── 3. Plate-change pending match (B230) ────────────────────
      SELECT v.unit INTO v_vehicle_unit
      FROM vehicle_plate_changes vpc
      JOIN vehicles v ON v.id = vpc.vehicle_id
      WHERE upper(regexp_replace(vpc.new_plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vpc.status = 'pending'
        AND lower(trim(vpc.property)) = ANY (v_properties_normalized)
      ORDER BY vpc.submitted_at DESC
      LIMIT 1;

      IF v_vehicle_unit IS NOT NULL THEN
        v_result_type := 'plate_under_review';
        v_unit_number := v_vehicle_unit;
      ELSE
        -- ── 4. Guest authorization match (B220 stage 2.5) ────────
        SELECT
          ga.guest_name,
          ga.visiting_unit,
          ga.end_date
        INTO
          v_guest_name,
          v_guest_unit,
          v_guest_end
        FROM guest_authorizations ga
        WHERE upper(regexp_replace(ga.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
          AND ga.is_active = TRUE
          AND ga.status = 'active'
          AND ga.start_date <= CURRENT_DATE
          AND ga.end_date   >= CURRENT_DATE
          AND lower(trim(ga.property)) = ANY (v_properties_normalized)
        ORDER BY ga.end_date DESC
        LIMIT 1;

        IF v_guest_unit IS NOT NULL THEN
          v_result_type := 'guest_authorized';
          v_unit_number := v_guest_unit;
        ELSE
          -- ── 5. Visitor pass match ─────────────────────────────
          SELECT vp.visiting_unit INTO v_visitor_unit
          FROM visitor_passes vp
          WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
            AND vp.is_active = TRUE
            AND vp.expires_at > now()
            AND lower(trim(vp.property)) = ANY (v_properties_normalized)
          ORDER BY vp.expires_at DESC
          LIMIT 1;

          IF FOUND THEN
            v_result_type := 'visitor';
            v_unit_number := v_visitor_unit;
          ELSE
            -- ── 6. Unauthorized ─────────────────────────────────
            v_result_type := 'unauthorized';
            v_unit_number := NULL;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  END IF;

  -- ── 7. Audit write ──────────────────────────────────────────────
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_searched',  to_jsonb(v_properties)
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',   v_result_type,
    'unit_number',   v_unit_number,
    'guest_name',    v_guest_name,
    'valid_through', v_guest_end,
    'reason',        v_dnt_reason
  );
END;
$func$;

-- pg_proc COUNT=1 assertion (preserved from cascade migration)
DO $chk_pm$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pm_plate_lookup has % overloads; expected 1', v_count;
  END IF;
END $chk_pm$;

REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — set_violation_status: canonical DNT guard block
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to prior definition except the DNT guard block
-- inside IF p_new_status='tow_ticket'. Uses the CANONICAL block —
-- role-aware admin escape is a no-op here (function is CA-only per
-- line 505 role gate) but the text is identical for VQ.COMPANY /
-- VQ.UNRESOLVED / canonical-block invariants to hold across all 3
-- tow paths.
CREATE OR REPLACE FUNCTION public.set_violation_status(
  p_violation_id BIGINT,
  p_new_status   TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_row            violations%ROWTYPE;
  v_old_status     TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role != 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_caller_company := get_my_company();
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_assigned');
  END IF;

  IF p_new_status IS NULL
     OR p_new_status NOT IN ('new', 'tow_ticket', 'resolved', 'disputed') THEN
    RETURN jsonb_build_object(
      'error', 'invalid_status',
      'hint',  'status must be one of: new, tow_ticket, resolved, disputed'
    );
  END IF;

  SELECT * INTO v_row FROM public.violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.company ~~* v_caller_company
       AND p.name = v_row.property
  ) THEN
    RETURN jsonb_build_object('error', 'cross_company_denied');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided_row_immutable');
  END IF;

  -- ── DNT guard — only for tow-advancing transition ────────────────
  -- Cleanup transitions (new/resolved/disputed) always allowed on DNT
  -- plates per tag-not-block model. Void has its own separate RPC
  -- (void_violation) and is orthogonal.
  IF p_new_status = 'tow_ticket' THEN
    -- ── CANONICAL DNT guard block (Commit B2)
    -- Byte-identical across set_violation_status, stamp_tow_ticket,
    -- and regenerate_tow_ticket. Do not hand-edit any single copy.
    IF v_caller_role <> 'admin'
       AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
      RETURN jsonb_build_object('error', 'company_unresolved');
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.do_not_tow_plates dnt
        JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
       WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
         AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
         AND (v_caller_role = 'admin'
              OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
         AND dnt.removed_at IS NULL
         AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'error', 'do_not_tow_active',
        'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
      );
    END IF;
    -- ── END CANONICAL BLOCK
  END IF;

  v_old_status := COALESCE(v_row.status, 'new');

  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object('ok', TRUE, 'noop', TRUE, 'status', p_new_status);
  END IF;

  UPDATE public.violations
     SET status            = p_new_status,
         status_changed_at = now(),
         status_changed_by = lower(v_caller_email)
   WHERE id = p_violation_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_STATUS_CHANGE',
    'violations',
    p_violation_id,
    jsonb_build_object(
      'old_status', v_old_status,
      'new_status', p_new_status,
      'company',    v_caller_company
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'old_status', v_old_status,
    'new_status', p_new_status
  );
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 4 — stamp_tow_ticket: canonical DNT guard block
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to prior definition except the DNT guard block
-- (replaces the prior unconditional guard). Uses the CANONICAL block
-- with admin escape active. Handles auto-advance to status='tow_ticket'
-- transitively — the same guard block gates all stamp writes.
CREATE OR REPLACE FUNCTION public.stamp_tow_ticket(
  p_violation_id        BIGINT,
  p_storage_facility_id BIGINT,
  p_tow_fee             NUMERIC,
  p_mileage_fee         NUMERIC DEFAULT NULL,
  p_vin                 TEXT    DEFAULT NULL
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

  -- ── CANONICAL DNT guard block (Commit B2)
  -- Byte-identical across set_violation_status, stamp_tow_ticket,
  -- and regenerate_tow_ticket. Do not hand-edit any single copy.
  IF v_caller_role <> 'admin'
     AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
    RETURN jsonb_build_object('error', 'company_unresolved');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.do_not_tow_plates dnt
      JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
     WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
       AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
       AND (v_caller_role = 'admin'
            OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
       AND dnt.removed_at IS NULL
       AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
  ) THEN
    RETURN jsonb_build_object(
      'error', 'do_not_tow_active',
      'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
    );
  END IF;
  -- ── END CANONICAL BLOCK

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

  UPDATE violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_tow_fee,
         tow_mileage_fee          = COALESCE(p_mileage_fee, tow_mileage_fee),
         vehicle_vin              = COALESCE(p_vin,         vehicle_vin),
         status                   = CASE WHEN status = 'new' THEN 'tow_ticket' ELSE status END
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 5 — regenerate_tow_ticket: canonical DNT guard at entry
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to prior definition
-- (20260629_violations_mileage_vin_persistence.sql:278-552) except:
--   (a) DECLARE gains v_row violations%ROWTYPE
--   (b) After caller company-scope check (line 381 in original), and
--       BEFORE storage facility validation, insert v_row := v_original;
--       plus the CANONICAL DNT guard block.
-- Rationale for entry-guard placement:
--   regenerate is a tow action end-to-end. Its sole purpose is to
--   reissue a tow ticket; a new violation row whose only function is
--   to carry a tow ticket has no value if the tow can't happen.
--   Refuse at entry with same convention as the other guards.
CREATE OR REPLACE FUNCTION public.regenerate_tow_ticket(
  p_original_violation_id   BIGINT,
  p_new_storage_facility_id BIGINT,
  p_new_tow_fee             NUMERIC,
  p_reason                  TEXT,
  p_reason_note             TEXT    DEFAULT NULL,
  p_new_mileage_fee         NUMERIC DEFAULT NULL,
  p_new_vin                 TEXT    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_can_regen      BOOLEAN;
  v_original       violations%ROWTYPE;
  v_row            violations%ROWTYPE;      -- B2: alias for canonical DNT block
  v_new_id         BIGINT;
  v_new_row        jsonb;
  v_storage        storage_facilities%ROWTYPE;
BEGIN
  -- ── Auth gate ───────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  SELECT role, company, can_regenerate_tow_ticket
    INTO v_caller_role, v_caller_company, v_can_regen
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ── Role gate ───────────────────────────────────────────────
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

  -- ── Reason gate ─────────────────────────────────────────────
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

  -- ── Original row: load + state checks ──────────────────────
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

  -- ── Company-scope predicate (mirrors b40 RLS shape, UNCHANGED) ─
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

  -- ── B2: DNT guard at entry (after row load + caller scope) ─────
  -- v_row alias binds v_original into the canonical variable name so
  -- the guard block is byte-identical across all three tow paths.
  v_row := v_original;

  -- ── CANONICAL DNT guard block (Commit B2)
  -- Byte-identical across set_violation_status, stamp_tow_ticket,
  -- and regenerate_tow_ticket. Do not hand-edit any single copy.
  IF v_caller_role <> 'admin'
     AND (get_my_company() IS NULL OR btrim(get_my_company()) = '') THEN
    RETURN jsonb_build_object('error', 'company_unresolved');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.do_not_tow_plates dnt
      JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
     WHERE dnt.plate = UPPER(regexp_replace(COALESCE(v_row.plate,''), '[^A-Za-z0-9]', '', 'g'))
       AND lower(trim(dnt_p.name)) = lower(trim(v_row.property))
       AND (v_caller_role = 'admin'
            OR lower(trim(dnt_p.company)) = lower(trim(get_my_company())))
       AND dnt.removed_at IS NULL
       AND (dnt.expires_at IS NULL OR dnt.expires_at > now())
  ) THEN
    RETURN jsonb_build_object(
      'error', 'do_not_tow_active',
      'hint',  'This plate is on the Do Not Tow list at this property. The requested tow action is refused. Remove from the property''s DNT list (via Settings) or void the violation to close it out.'
    );
  END IF;
  -- ── END CANONICAL BLOCK

  -- ── Storage facility: validate + scope (UNCHANGED) ─────────
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
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.violations (
    plate, violation_type, location, notes, property,
    driver_name, driver_license,
    vehicle_year, vehicle_color, vehicle_make, vehicle_model,
    is_confirmed,
    was_authorized_at_time, decline_reason, decline_reason_note,
    regenerated_from
  ) VALUES (
    v_original.plate, v_original.violation_type, v_original.location, v_original.notes, v_original.property,
    v_original.driver_name, v_original.driver_license,
    v_original.vehicle_year, v_original.vehicle_color, v_original.vehicle_make, v_original.vehicle_model,
    TRUE,
    v_original.was_authorized_at_time, v_original.decline_reason, v_original.decline_reason_note,
    p_original_violation_id
  )
  RETURNING id INTO v_new_id;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 3 — CARRY-FORWARD EVIDENCE (active rows only)      ║
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
  -- ║ (Now also enforced by VQ.PARITY in B2 verification.)     ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_new_tow_fee,
         tow_mileage_fee          = p_new_mileage_fee,
         vehicle_vin              = p_new_vin,
         status                   = 'tow_ticket'
   WHERE id = v_new_id
  RETURNING to_jsonb(violations.*) INTO v_new_row;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ STEP 5 — AUDIT (two rows: void + regenerate) UNCHANGED  ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_VOIDED',
    'violations',
    p_original_violation_id,
    jsonb_build_object(
      'void_reason',            'regenerate: ' || p_reason,
      'regenerate_reason',      p_reason,
      'regenerate_reason_note', p_reason_note,
      'replaced_by',            v_new_id,
      'caller_role',            v_caller_role,
      'via_regenerate',         TRUE
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
      'old_mileage_fee',        v_original.tow_mileage_fee,
      'old_vin',                v_original.vehicle_vin,
      'new_storage_id',         p_new_storage_facility_id,
      'new_storage_name',       v_storage.name,
      'new_tow_fee',            p_new_tow_fee,
      'new_mileage_fee',        p_new_mileage_fee,
      'new_vin',                p_new_vin,
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

-- ══════════════════════════════════════════════════════════════════════
-- STEP 6 — SCHEMA_ audit row
-- ══════════════════════════════════════════════════════════════════════
-- NOT EXISTS guard — prevents duplicate SCHEMA_ row on re-apply.
-- VQ.AUDIT asserts presence, not count; duplicated audit rows are
-- cosmetic but confuse future audit-log reconstruction. Do NOT
-- hand-delete an existing extra row — audit_logs is append-only by
-- design. See migration header "Apply history" for the double-apply
-- narrative.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_DNT_B2_FUNCTION_SCOPE_FIX',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260723_dnt_b2_function_scope_fix',
    'purpose',   'DNT Commit B2 — company-scope DNT lookups on 5 functions + close regenerate_tow_ticket gap + role-conditional reason (default-deny ELSE) in check_dnt_plate.',
    'touched',   ARRAY['check_dnt_plate','pm_plate_lookup','set_violation_status','stamp_tow_ticket','regenerate_tow_ticket'],
    'canonical_block', 'DNT guard block byte-identical (whitespace-normalized) across the 3 tow paths. Asserted by VQ.CANONICAL — hash comparison of extracted region between CANONICAL/END markers, with exactly-once + order pre-checks.',
    'admin_escape', 'DNT lookup and company_unresolved sentinel both role-aware: (v_caller_role=admin OR company match). Deliberately over-broad for admin — false refusal only, no false permit. See migration header for the violations-has-no-company-column reasoning.',
    'reason_role_conditional', 'check_dnt_plate returns reason ONLY for manager/leasing_agent/company_admin/admin; default-deny ELSE for drivers, residents, and any future role. is_dnt captured BEFORE the CASE so suppression cannot flip the DO NOT TOW card off the driver surface.',
    'dnt_p_alias', 'All 5 DNT lookups alias properties as dnt_p (not p). Enables VQ.COMPANY to assert on lower(trim(dnt_p.company)) — unique to DNT block, unreachable from caller-auth code that already contains get_my_company().',
    'followup_b3', 'Server-side DEFINER RPC filter_dnt_protected + fail-loud client + user-facing exclusion notice for CSV export on /history.',
    'followup_bar2_blocker', 'Pre-existing ~~* caller-authorization checks in set_violation_status:527-533, regenerate_tow_ticket:374-381 + :391-396, stamp_tow_ticket:681-715 remain (NOT DNT lookups). Filed on Bar-2 pre-flip checklist (memory: project_bar2_pm_only_flip_checklist) — bypass class: DNT guard scopes to caller, ILIKE lets caller reach cross-tenant violations; guard is present and irrelevant.'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_DNT_B2_FUNCTION_SCOPE_FIX'
     AND new_values->>'migration' = '20260723_dnt_b2_function_scope_fix'
);

COMMIT;
