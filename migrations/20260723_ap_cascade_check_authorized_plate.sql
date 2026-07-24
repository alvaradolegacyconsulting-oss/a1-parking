-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_ap_cascade_check_authorized_plate.sql
-- ═══════════════════════════════════════════════════════════════════════
-- AP-CASCADE-DB — check_authorized_plate DEFINER RPC + pm_plate_lookup
-- branch 1.5. Commit 2 of 4 in the Authorized Plates arc.
--
-- ── Design shape ───────────────────────────────────────────────────────
-- Three plate-resolution paths exist in the codebase (enumerated during
-- design):
--   1. Driver scan       — client-side cascade in app/driver/page.tsx
--   2. Manager scan      — server-side pm_plate_lookup RPC
--   3. CA scan           — client-side cascade in app/company_admin/page.tsx
-- With overlapping-but-not-identical status vocabularies. Under
-- Authorized Plates, all three must agree on a plate or a staff vehicle
-- gets towed by the one person whose screen decides (the driver).
--
-- The two client-side paths CANNOT query authorized_plates directly:
-- AP-SCHEMA has no driver SELECT policy by design (RLS blind spot), and
-- CA-scoped RLS-then-`inCompany` filter is a client-side pattern that
-- doesn't scale. Solution: ONE SECURITY DEFINER RPC called from all
-- three paths.
--
-- Rejected alternative: three parallel implementations of the same
-- lookup. That is precisely how `regenerate_tow_ticket` diverged from
-- `stamp_tow_ticket` in the DNT arc — the `⚠ KEEP IN SYNC` banner
-- didn't prevent the divergence; a single implementation does.
--
-- ── Call-site contract (CRITICAL — do not "simplify") ─────────────────
--   • Callers with a selected/scoped property MUST pass p_property
--     (exact match, single-property mode).
--   • NULL is reserved for genuine search-all-in-scope (CA/manager
--     scan with no property context).
--
-- Bug prevented: CA passing NULL when it DOES have a selectedProperty
-- would search all company properties, return first-match, then the
-- client compares property_name and renders 'otherproperty' — for a
-- plate that IS authorized at the selected property (case: vendor
-- authorized at two same-company buildings, older row wins the LIMIT
-- 1). Not exotic; vendor working two buildings is the ordinary case.
--
-- Client call shape:
--   driver: rpc('check_authorized_plate', { p_plate, p_property: targetProp })
--   CA:     rpc('check_authorized_plate', { p_plate, p_property: selectedProperty?.name ?? null })
--   manager (via pm_plate_lookup): SELECT check_authorized_plate(v_normalized, NULL)
--
-- ── Fail-soft asymmetry (deliberate — do NOT "fix" to fail-closed) ────
-- If get_my_company() returns NULL (JWT context failure, whitespace-
-- bearing stored email, etc.), the scope predicates match nothing and
-- the plate reads as not-authorized. That is the safe direction here:
--   • False refusal (someone with broken context can't confirm a plate
--     as authorized) — a driver sees non-resident and can still Issue
--     Violation; enforcement is not blocked.
--   • False authorization (someone with broken context sees Authorized
--     for a plate that isn't) — would silently permit staff-treatment
--     of a random vehicle. This we prevent.
-- Same asymmetry as check_dnt_plate's fail-soft-on-scope pattern.
--
-- ── Status vocabulary ─────────────────────────────────────────────────
-- All three paths emit new status 'authorized_plate' (distinct from
-- resident's existing status values). Render layer treats identically
-- to resident card per Jose's spec ("behaves like a resident"). Data
-- payload distinguishes for logs, analytics, and the CA/super-admin
-- count column.
--
-- ── Deterministic ORDER BY ────────────────────────────────────────────
-- ORDER BY ap.added_at ASC ensures first-match when the plate is
-- authorized at multiple in-scope properties (rare — vendor at two
-- buildings, same company). Oldest authorization wins. Driver's
-- single-property mode is unaffected (partial unique on (property_id,
-- plate) WHERE removed_at IS NULL enforces one active per property).
--
-- ── Pre-apply state (negative controls) ───────────────────────────────
--   AP.CHECK_EXISTS   — FAIL (function doesn't exist)
--   AP.CHECK_ALIAS    — FAIL
--   AP.CHECK_COMPANY  — FAIL
--   AP.CHECK_LIFECYCLE— FAIL
--   AP.CHECK_ORDERING — FAIL (v_is_authorized doesn't exist yet)
--   AP.CHECK_ROLE_LABEL — FAIL (CASE shape not present)
--   AP.CHECK_ADMIN_ESCAPE — FAIL (admin OR-branch not present)
--   AP.CHECK_GRANTS   — FAIL (function doesn't exist)
--   AP.PM_CALLS       — FAIL (pm_plate_lookup doesn't call RPC yet)
--   AP.PM_SETS_TYPE   — FAIL (v_result_type := 'authorized_plate' not present)
--   AP.AUDIT          — FAIL (row not landed)
-- All 11 pre-apply. Post-apply silent = fix landed.
--
-- ── Rollback ───────────────────────────────────────────────────────────
--   1. Restore pm_plate_lookup from migrations/20260723_dnt_b2_function_scope_fix.sql:304-511
--   2. DROP FUNCTION IF EXISTS public.check_authorized_plate(TEXT, TEXT);
-- No table impact. AP-SCHEMA (51c29f2) unaffected.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — check_authorized_plate: single DEFINER RPC for all 3 paths
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_authorized_plate(
  p_plate    TEXT,
  p_property TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized     TEXT;
  v_role           TEXT;
  v_email          TEXT;
  v_authorized_p   BIGINT;
  v_property_name  TEXT;
  v_label          TEXT;
  v_is_authorized  BOOLEAN;
BEGIN
  IF p_plate IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL);
  END IF;

  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL);
  END IF;

  v_role := get_my_role();
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL);
  END IF;

  v_normalized := UPPER(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF v_normalized = '' THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL);
  END IF;

  -- ── Role-scoped lookup ────────────────────────────────────────────
  -- p_property NULL → search all in-scope properties (CA/manager scan)
  -- p_property set  → check only that property (with scope validation)
  --                   Callers with a selected property MUST pass it —
  --                   see header "Call-site contract."
  -- Admin: cross-tenant (deliberately over-broad, matches check_dnt_plate).
  SELECT ap.property_id, ap_p.name, ap.label
    INTO v_authorized_p, v_property_name, v_label
  FROM public.authorized_plates ap
  JOIN public.properties ap_p ON ap_p.id = ap.property_id
  WHERE ap.plate = v_normalized
    AND ap.removed_at IS NULL
    AND (p_property IS NULL
         OR lower(trim(ap_p.name)) = lower(trim(p_property)))
    AND (
      v_role = 'admin'
      OR (v_role IN ('manager','leasing_agent')
          AND lower(trim(ap_p.name)) IN (
                SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
              )
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
      OR (v_role = 'driver'
          AND EXISTS (
            SELECT 1
              FROM public.drivers d
              CROSS JOIN LATERAL unnest(d.assigned_properties) AS prop
             WHERE lower(d.email)    = lower(v_email)
               AND lower(trim(prop)) = lower(trim(ap_p.name))
          )
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
      OR (v_role = 'company_admin'
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
    )
  ORDER BY ap.added_at ASC
  LIMIT 1;

  -- Capture is_authorized from row-existence BEFORE label suppression.
  -- Analogous to B2's v_is_dnt fix — a suppressed label must not flip
  -- is_authorized to false. Role suppression touches only the returned
  -- label field, never the boolean.
  v_is_authorized := v_authorized_p IS NOT NULL;

  RETURN jsonb_build_object(
    'is_authorized', v_is_authorized,
    'property_id',   v_authorized_p,
    'property_name', v_property_name,
    'label',         CASE
                       WHEN v_role IN ('manager','leasing_agent','company_admin','admin')
                         THEN v_label
                       ELSE NULL   -- default-deny: driver + others get status only
                     END
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.check_authorized_plate(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_authorized_plate(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_authorized_plate(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — pm_plate_lookup: add branch 1.5 (call check_authorized_plate)
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to prior definition
-- (20260723_dnt_b2_function_scope_fix.sql:304-511) EXCEPT:
--   (a) DECLARE gains v_ap_result JSONB, v_ap_property_name TEXT, v_ap_label TEXT
--   (b) Inside the outer `ELSE` (line 387 prior), BEFORE branch 2's
--       nested block, insert branch 1.5: call check_authorized_plate.
--       Branches 2-6 wrap in an additional IF v_result_type IS NULL.
--   (c) Terminal RETURN gains 'ap_property_name' + 'ap_label' fields.
-- Comment additions marked NEW (AP-CASCADE) inline.
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
  v_ap_result             JSONB;   -- NEW (AP-CASCADE)
  v_ap_property_name      TEXT;    -- NEW (AP-CASCADE)
  v_ap_label              TEXT;    -- NEW (AP-CASCADE)
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

  -- ── 0. Do Not Tow match (B2: parked, empty table = inert branch) ─
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

  -- ── Branches 1 → 1.5 → 2-6 ───────────────────────────────────────
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
    -- ── 1.5 Authorized plate (AP-CASCADE) ─────────────────────
    -- NEW: call check_authorized_plate with p_property=NULL so the
    -- RPC scopes to caller's get_my_properties() internally. One
    -- implementation across driver + CA + manager (this) — see the
    -- RPC's header for the call-site contract + fail-soft rationale.
    -- Nested SECURITY DEFINER preserves auth.jwt() so get_my_company()
    -- and get_my_properties() resolve to the original manager caller.
    v_ap_result := public.check_authorized_plate(v_normalized, NULL);
    IF COALESCE((v_ap_result->>'is_authorized')::boolean, FALSE) THEN
      v_result_type      := 'authorized_plate';
      v_unit_number      := NULL;                              -- AP rows have no unit
      v_ap_property_name := v_ap_result->>'property_name';
      v_ap_label         := v_ap_result->>'label';
    END IF;

    IF v_result_type IS NULL THEN
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
    'result_type',       v_result_type,
    'unit_number',       v_unit_number,
    'guest_name',        v_guest_name,
    'valid_through',     v_guest_end,
    'reason',            v_dnt_reason,
    'ap_property_name',  v_ap_property_name,   -- NEW (AP-CASCADE)
    'ap_label',          v_ap_label            -- NEW (AP-CASCADE)
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
-- STEP 3 — SCHEMA_ audit (NOT EXISTS-guarded, safe to re-run)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_AP_CASCADE_CHECK_AUTHORIZED_PLATE',
  'proc',
  NULL,
  jsonb_build_object(
    'migration',       '20260723_ap_cascade_check_authorized_plate',
    'commit',          'AP-CASCADE-DB (2 of 4)',
    'purpose',         'Single DEFINER RPC (check_authorized_plate) called from driver + CA + manager plate-resolution paths. Solves RLS blind spot for driver, prevents three-cascade drift, keeps one company-scope implementation.',
    'rpc_signature',   'check_authorized_plate(p_plate TEXT, p_property TEXT DEFAULT NULL) RETURNS jsonb',
    'call_site_contract', 'Callers with a selected property MUST pass p_property. NULL is reserved for genuine search-all-in-scope. Do not simplify CA call to always-NULL — that reintroduces the otherproperty misreport (vendor at two same-company buildings, older row wins LIMIT 1).',
    'fail_soft_asymmetry', 'get_my_company() NULL → scope predicates match nothing → plate reads not-authorized. Safe direction (no false authorization). Deliberate. Do NOT fail-closed.',
    'status_value',    'authorized_plate (distinct from resident/authorized/otherproperty; render mirrors resident card)',
    'pm_plate_lookup_change', 'Adds branch 1.5 (calls RPC with p_property=NULL). DECLARE gains v_ap_result JSONB + v_ap_property_name TEXT + v_ap_label TEXT. Terminal RETURN gains ap_property_name + ap_label fields.',
    'followup_client', 'AP-CASCADE-CLIENT commit adds branch 1.5 to app/driver/page.tsx and app/company_admin/page.tsx. Split from DB to avoid client build failure forcing revert of verified SQL.',
    'rollback',        'Restore pm_plate_lookup from 20260723_dnt_b2_function_scope_fix.sql:304-511; DROP FUNCTION check_authorized_plate.'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_AP_CASCADE_CHECK_AUTHORIZED_PLATE'
     AND new_values->>'migration' = '20260723_ap_cascade_check_authorized_plate'
);

COMMIT;
