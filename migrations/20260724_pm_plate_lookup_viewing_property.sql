-- ═══════════════════════════════════════════════════════════════════════
-- 20260724_pm_plate_lookup_viewing_property.sql
-- ═══════════════════════════════════════════════════════════════════════
-- pm_plate_lookup — scope query to the manager's viewing property, not
-- their entire portfolio.
--
-- ── Why ───────────────────────────────────────────────────────────────
-- Grep-verified 2026-07-24 (see docs/backlog/pm-plate-lookup-viewing-
-- property-scope.md): all 7 branches of pm_plate_lookup scope against
-- the caller's entire assigned-properties portfolio via = ANY
-- (v_properties_normalized). Manager viewing property X sees matches
-- from property Y as if they were at X.
--
-- Behaviourally verified 2026-07-23:
--   • Resident `LESLY` (Unit 205) — returns "Active resident" whether
--     manager is viewing 138 or 146
--   • `TESTAP` (authorized at 146) — same manager viewing 138 gets
--     'authorized_plate' rendering as ✓ Authorized
--
-- Severity ranking (Mateo 2026-07-24): silent-and-confidently-wrong
-- (5 non-AP branches: no property field in the response) beats
-- visibly-inconsistent (1 branch: AP, returns ap_property_name next to
-- green ✓). Both fixed together at the RPC layer, not client-side —
-- client-side would require adding a matched-property field to every
-- branch's return, strictly more change than scoping the query.
--
-- ── Fix shape ─────────────────────────────────────────────────────────
--   • Signature gains p_viewing_property TEXT DEFAULT NULL
--   • 6 branches gain: AND (p_viewing_property IS NULL OR lower(trim(x.property)) = lower(trim(p_viewing_property)))
--   • 1 branch (AP branch 1.5): argument change on check_authorized_plate
--     call — NULL → p_viewing_property. That function already scopes on
--     its p_property parameter (proven by driver-scan smoke step 5a);
--     just pass viewing through instead of asking "any of your
--     assigned properties."
--   • Branch 6 (unauthorized fallthrough) has no query; no change.
--
-- Portfolio scope PRESERVED on all 6 branches — viewing-property
-- predicate is LAYERED onto the existing = ANY (v_properties_normalized),
-- not replacing it. Belt (portfolio, RLS-equivalent) + braces (viewing).
--
-- B2 invariants PRESERVED byte-identical on branch 0: dnt_p alias +
-- lower(trim(dnt_p.company)) company predicate + dnt.removed_at IS NULL
-- + expires_at lifecycle. Post-apply run of
-- 20260723_dnt_b2_function_scope_fix_verification.sql must stay silent
-- — its VQ.COMPANY + VQ.LIFECYCLE assert on THIS function's source.
--
-- Also updated AP-CASCADE-DB verification's AP.PM_CALLS this commit:
-- asserts positive form (check_authorized_plate(v_normalized,
-- p_viewing_property)) instead of the pre-VIEWING string.
--
-- ── Audit field rename ────────────────────────────────────────────────
-- properties_searched → properties_in_scope. Under the old behaviour
-- the two were synonymous (query searched the caller's full portfolio).
-- Under the new behaviour, properties_in_scope records the caller's
-- portfolio (RLS-equivalent) and viewing_property records the narrowing
-- filter actually applied. When viewing_property is non-null the
-- effective search is the intersection, NOT the full list — a field
-- named "properties_searched" would overstate the operation.
--
-- Historical audit rows keep 'properties_searched' key; new rows use
-- 'properties_in_scope' + 'viewing_property'. Forensic queries spanning
-- pre/post-2026-07-24 need to check both keys.
--
-- ── ROLLBACK — TWO steps, BOTH required, in order ────────────────────
-- Client is sending p_viewing_property to a 2-arg function. Reverting
-- the SQL alone leaves the client sending an extra parameter that
-- PostgREST can't resolve on a 1-arg function → every manager plate
-- lookup errors. Worse state than the bug being rolled back.
--
--   1. REVERT THE CLIENT COMMIT FIRST (or in the same push cycle).
--      app/manager/page.tsx: switchProperty stops clearing lookup
--      state; Plate Lookup call reverts to
--      supabase.rpc('pm_plate_lookup', { p_plate: raw }) — no
--      p_viewing_property argument.
--
--   2. THEN restore the 1-arg SQL definition:
--      -- DROP the CURRENT (2-arg) signature FIRST. The AP-CASCADE-DB
--      -- file's DROP targets (TEXT) only; skipping this DROP produces
--      -- an OVERLOAD during rollback, not a restore — the exact trap
--      -- STEP 1 of this migration prevents on the way in.
--      DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT, TEXT);
--      -- Then re-apply pm_plate_lookup from
--      -- migrations/20260723_ap_cascade_check_authorized_plate.sql:203-418
--      -- (includes DROP-TEXT + CREATE + inline pg_proc + REVOKE/GRANT).
--      -- Verify: SELECT count(*) FROM pg_proc
--      --   WHERE proname='pm_plate_lookup'
--      --     AND pronamespace='public'::regnamespace;
--      -- Expected: 1.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Drop old signature (DROP-first per standing overload trap)
-- ══════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE with a changed signature (adding p_viewing_property)
-- produces a DUPLICATE, not a replacement. Inline pg_proc COUNT=1
-- assertion after CREATE catches it, but DROP first makes the trap
-- structurally impossible.
DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT);

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — pm_plate_lookup with viewing-property scoping
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to
-- migrations/20260723_ap_cascade_check_authorized_plate.sql:205-411
-- EXCEPT the 7 changes marked NEW (AP-VIEWING) inline.
CREATE OR REPLACE FUNCTION public.pm_plate_lookup(
  p_plate            TEXT,
  p_viewing_property TEXT DEFAULT NULL       -- NEW (AP-VIEWING)
)
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
  v_ap_result             JSONB;
  v_ap_property_name      TEXT;
  v_ap_label              TEXT;
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
  -- B2 invariants preserved: dnt_p alias + lower(trim(dnt_p.company))
  -- company predicate + dnt.removed_at IS NULL + expires_at lifecycle.
  -- AP-VIEWING adds the viewing-property predicate.
  SELECT dnt.reason INTO v_dnt_reason
    FROM public.do_not_tow_plates dnt
    JOIN public.properties dnt_p ON dnt_p.id = dnt.property_id
   WHERE dnt.plate = v_normalized
     AND lower(trim(dnt_p.name))    = ANY (v_properties_normalized)
     AND lower(trim(dnt_p.company)) = lower(trim(get_my_company()))
     AND (p_viewing_property IS NULL OR lower(trim(dnt_p.name)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
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
    AND (p_viewing_property IS NULL OR lower(trim(v.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 1.5 Authorized plate (AP-CASCADE) ─────────────────────
    -- AP-VIEWING: argument change — NULL → p_viewing_property.
    -- check_authorized_plate already scopes on p_property; we
    -- just pass the manager's viewing property through instead
    -- of asking "any of your assigned properties."
    v_ap_result := public.check_authorized_plate(v_normalized, p_viewing_property);   -- NEW (AP-VIEWING)
    IF COALESCE((v_ap_result->>'is_authorized')::boolean, FALSE) THEN
      v_result_type      := 'authorized_plate';
      v_unit_number      := NULL;
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
      AND (p_viewing_property IS NULL OR lower(trim(v.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
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
        AND (p_viewing_property IS NULL OR lower(trim(vpc.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
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
          AND (p_viewing_property IS NULL OR lower(trim(ga.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
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
            AND (p_viewing_property IS NULL OR lower(trim(vp.property)) = lower(trim(p_viewing_property)))   -- NEW (AP-VIEWING)
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
  -- AP-VIEWING rename: properties_searched → properties_in_scope.
  -- Historical audit rows keep 'properties_searched' key; new rows use
  -- 'properties_in_scope' + 'viewing_property'. Forensic queries
  -- spanning pre/post-2026-07-24 need both keys.
  --   properties_in_scope: caller's RLS-equivalent portfolio
  --   viewing_property:    narrowing filter actually applied (may be NULL
  --                        when called without a viewing property; today
  --                        only the manager Plate Lookup client calls it,
  --                        and it always passes manager.name)
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_in_scope',  to_jsonb(v_properties),
      'viewing_property',     p_viewing_property
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',       v_result_type,
    'unit_number',       v_unit_number,
    'guest_name',        v_guest_name,
    'valid_through',     v_guest_end,
    'reason',            v_dnt_reason,
    'ap_property_name',  v_ap_property_name,
    'ap_label',          v_ap_label
  );
END;
$func$;

-- pg_proc COUNT=1 assertion (preserved discipline)
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

REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — SCHEMA_ audit (NOT EXISTS-guarded, wrap-safe strings)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_PM_PLATE_LOOKUP_VIEWING_PROPERTY',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260724_pm_plate_lookup_viewing_property',
    'purpose',   'pm_plate_lookup — scope query to manager viewing '
              || 'property, not full portfolio. Fixes all 7 branches at '
              || 'the RPC layer (6 predicates + 1 AP argument change). '
              || 'Client passes manager.name; NULL default preserves '
              || 'back-compat.',
    'branches_changed', jsonb_build_object(
      'branch_0_dnt',            'predicate on dnt_p.name',
      'branch_1_resident',       'predicate on v.property',
      'branch_1.5_ap',           'argument change: NULL → p_viewing_property',
      'branch_2_pending',        'predicate on v.property',
      'branch_3_plate_change',   'predicate on vpc.property',
      'branch_4_guest_auth',     'predicate on ga.property',
      'branch_5_visitor',        'predicate on vp.property',
      'branch_6_unauthorized',   'no query, no change'
    ),
    'invariants_preserved', 'B2 dnt_p company predicate + removed_at/expires_at lifecycle (branch 0). Re-run 20260723_dnt_b2_function_scope_fix_verification.sql post-apply.',
    'audit_field_rename', 'properties_searched → properties_in_scope. Historical rows keep old key; forensic queries need both.',
    'rollback', 'TWO steps: (1) revert client commit first (Plate Lookup call + switchProperty clears), (2) DROP FUNCTION pm_plate_lookup(TEXT,TEXT), then re-apply from AP-CASCADE-DB. See migration header for details.'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_PM_PLATE_LOOKUP_VIEWING_PROPERTY'
     AND new_values->>'migration' = '20260724_pm_plate_lookup_viewing_property'
);

COMMIT;
