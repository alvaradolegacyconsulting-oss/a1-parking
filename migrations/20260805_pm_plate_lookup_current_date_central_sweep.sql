-- ══════════════════════════════════════════════════════════════════════
-- 20260805_pm_plate_lookup_current_date_central_sweep.sql
-- Commit B of the guest-auth CURRENT_DATE fix. Rewrites pm_plate_lookup
-- to use public.current_date_central() (Commit A helper) instead of
-- CURRENT_DATE in the guest-auth branch predicate.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── ONLY CHANGE FROM 20260724_pm_plate_lookup_viewing_property.sql ──
--
--   line 253: AND ga.start_date <= CURRENT_DATE
--   line 254: AND ga.end_date   >= CURRENT_DATE
--
-- become
--
--   AND ga.start_date <= public.current_date_central()
--   AND ga.end_date   >= public.current_date_central()
--
-- Everything else — signature, DECLARE block, all 6 branches, audit
-- write, RETURN shape, pg_proc COUNT=1 assertion, REVOKE/GRANT block —
-- is BYTE-IDENTICAL to the 20260724 body. `CREATE OR REPLACE` on a
-- ~220-line function replaces the whole thing; diff review is the
-- guard that no other line moved.
--
-- ── 🔴 DEPLOY BEFORE 7PM CENTRAL — MAKES THE TRANSITION A NON-EVENT ──
--
-- Before 7pm Central, CURRENT_DATE (UTC session) and
-- current_date_central() return the SAME date. So neither edge case
-- is active, no guest's authorization status changes at the moment
-- of deploy. Deploy after 7pm Central and a live guest can flip
-- from admitted → denied (start edge) or denied → admitted (end
-- edge) mid-evening. Wait until morning if the current time in
-- Central is post-7pm.
--
-- ── 🔴 START-EDGE BEHAVIOUR CHANGE (Mateo lock 2026-08-05) ──────────
--
-- The predicate carries BOTH boundary directions in one line pair:
--
--   end_date >= CURRENT_DATE    — currently FAIL-CLOSED (tow risk)
--   start_date <= CURRENT_DATE  — currently FAIL-OPEN (early admit)
--
-- After the fix:
--
--   * Guest authorized THROUGH Aug 3, arriving 8pm CDT Aug 3:
--       today reads unauthorized (bug) → after fix reads guest_authorized
--
--   * Guest authorized FROM Aug 4, arriving 8pm CDT Aug 3:
--       today reads guest_authorized (fail-open) → after fix reads unauthorized
--
-- BOTH are corrections to what the property meant when they set the
-- window. The SECOND creates a five-hour nightly window in which an
-- early-arriving guest loses protection they have today — correct
-- behaviour, but a NEW tow exposure created by a change whose
-- purpose is REMOVING tow exposure. Filed as backlog:
-- docs/backlog/guest-auth-arrival-grace-question.md (should windows
-- carry arrival grace? — product policy decision, NOT a bug fix).
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- 20260805_current_date_central_helper.sql (Commit A) — applied +
-- verified silent 2026-08-05. If Commit A is not present, this
-- migration fails at CREATE OR REPLACE with "function
-- current_date_central() does not exist."
--
-- Also updates the Commit A COMMENT ON in this file to record the
-- INVOKER-grant note (Mateo Section 2 addition — a future INVOKER
-- caller of current_date_central() needs an explicit GRANT).
--
-- ── PRE-APPLY (Jose runs FIRST) ──────────────────────────────────────
--
-- See 20260805_pm_plate_lookup_current_date_central_sweep_retrospective.sql
-- Read-only. Zero rows is the expected outcome (Aug 3 retrospective
-- was zero; this covers Aug 3 → now in case Green Acres used the
-- feature in the interim). Any row = incident triage, halt.
--
-- ── DO NOT ────────────────────────────────────────────────────────────
--
-- - DO NOT reorder branches; downstream client depends on 1 > 1.5 >
--   2 > 3 > 4 > 5 > 6 precedence exactly as documented in 20260724.
-- - DO NOT touch the AP-VIEWING predicate additions (7 branches,
--   marked NEW inline) — that was July 24's scoping work.
-- - DO NOT replace `public.current_date_central()` with an inline
--   `(now() AT TIME ZONE 'America/Chicago')::date` — the helper
--   exists to keep the predicate in one place.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── STEP 1 — pm_plate_lookup CREATE OR REPLACE ──────────────────────
-- Body byte-identical to 20260724_pm_plate_lookup_viewing_property.sql
-- EXCEPT the 2 CURRENT_DATE swaps in branch 4 (guest auth).
CREATE OR REPLACE FUNCTION public.pm_plate_lookup(
  p_plate            TEXT,
  p_viewing_property TEXT DEFAULT NULL       -- NEW (AP-VIEWING, 20260724)
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
        -- 2026-08-05: CURRENT_DATE → public.current_date_central()
        -- (Commit B of guest-auth CURRENT_DATE fix). start_date and
        -- end_date are DATE columns; the helper returns DATE in
        -- America/Chicago. See helper header for rationale.
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
          AND ga.start_date <= public.current_date_central()   -- was CURRENT_DATE
          AND ga.end_date   >= public.current_date_central()   -- was CURRENT_DATE
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

-- ── STEP 2 — belt REVOKE/GRANT (CREATE OR REPLACE preserves grants,
--            but re-issue for safety across future refactors) ────────
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT, TEXT) TO authenticated;

-- ── STEP 3 — Commit A COMMENT ON update with INVOKER-grant note ────
-- Mateo Section 2 addition: someone debugging permission-denied on a
-- future INVOKER caller should find the answer in the comment, not
-- by bisecting. Idempotent — just refreshes the description.
COMMENT ON FUNCTION public.current_date_central() IS
  'Returns today''s date in the property timezone (America/Chicago). Use this INSTEAD OF CURRENT_DATE in any user-facing DATE boundary — CURRENT_DATE resolves in the session TimeZone (Supabase default UTC, Vercel Node UTC), which produces a 5-hour early rollover at 7pm Central every day. STABLE (not IMMUTABLE — depends on now()). No hardcoded offset — America/Chicago resolves CDT/CST from tzdata. WARNING (timestamptz): this helper alone is NOT sufficient when comparing a timestamptz column to a date — the implicit timestamptz->date cast ALSO uses the session TimeZone. For a timestamptz column, use (col AT TIME ZONE ''America/Chicago'')::date or compare instants via now(). WARNING (grants): today''s callers are SECURITY DEFINER RPCs that run as postgres; no app-role EXECUTE was granted. If a future INVOKER caller (anon or authenticated) needs this helper, that caller''s migration MUST issue GRANT EXECUTE explicitly — otherwise the failure surfaces at runtime as permission-denied, not at deploy. Installed 2026-08-05.';

-- ── STEP 4 — SCHEMA_ audit (NOT EXISTS-guarded) ─────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_PM_PLATE_LOOKUP_CURRENT_DATE_CENTRAL',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260805_pm_plate_lookup_current_date_central_sweep',
    'purpose',   'pm_plate_lookup — swap CURRENT_DATE (UTC session) for public.current_date_central() (America/Chicago) in the guest-auth branch (branch 4). '
              || 'Fixes the 5-hour nightly window where a guest whose window ends TODAY was denied enforcement at 7pm+ Central. '
              || 'Mirror edge: a guest whose window starts TOMORROW is now correctly denied at 7pm+ Central today (was fail-open). '
              || 'See docs/backlog/guest-auth-arrival-grace-question.md for the product-policy question this raises.',
    'lines_changed', jsonb_build_object(
      'file',        '20260724_pm_plate_lookup_viewing_property.sql',
      'line_253',    'AND ga.start_date <= CURRENT_DATE  →  AND ga.start_date <= public.current_date_central()',
      'line_254',    'AND ga.end_date   >= CURRENT_DATE  →  AND ga.end_date   >= public.current_date_central()'
    ),
    'invariants_preserved', 'All 6 branches byte-identical except lines 253-254. AP-VIEWING predicates (7 sites) preserved. Signature (TEXT, TEXT) preserved. SECURITY DEFINER preserved. Grants preserved. pg_proc COUNT=1 assertion preserved.',
    'commit_a', '20260805_current_date_central_helper',
    'retrospective_run', 'Jose runs 20260805_pm_plate_lookup_current_date_central_sweep_retrospective.sql BEFORE this migration applies. Zero rows expected. Any row = incident triage.',
    'deploy_timing', 'Deploy BEFORE 7pm Central. After 7pm can flip a live guest status mid-evening.',
    'rollback', 'CREATE OR REPLACE with the 20260724 body (2 lines revert to CURRENT_DATE). Do NOT DROP — dropping loses AP-VIEWING scoping.'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_PM_PLATE_LOOKUP_CURRENT_DATE_CENTRAL'
     AND new_values->>'migration' = '20260805_pm_plate_lookup_current_date_central_sweep'
);

COMMIT;
