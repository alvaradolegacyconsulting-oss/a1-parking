-- ══════════════════════════════════════════════════════════════════════
-- 20260903_track_gating_write_path_gates.sql
--
-- 🟢 Track gating — Commit 2 of 2 (the write-path gates).
--
-- Wires public.my_tier_enforcement_capable() (shipped in Commit 1 —
-- 20260903_track_gating_helper.sql, 1f5bcb9) into 8 enforcement
-- write-path SECURITY DEFINER RPCs. Each function gets ONE new
-- gate block inserted immediately AFTER its existing role check
-- and BEFORE any subsequent scope/state check:
--
--     IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
--       RAISE EXCEPTION 'tier_not_permitted'
--         USING HINT = 'This subscription tier does not include
--                      enforcement features. Contact support to
--                      upgrade.',
--               ERRCODE = 'insufficient_privilege';
--     END IF;
--
-- 🔴 SUPER-ADMIN BYPASS (Mateo Sep 3 followup §1):
-- Admin has company=NULL by design (not a tenant). A bare
-- `IF NOT my_tier_enforcement_capable()` would raise no_company_context
-- inside the helper's `IF v_company IS NULL OR v_company = '' THEN
-- RAISE` guard and lock super-admin out of the 6 enforcement RPCs
-- whose role gates admit admin (driver_create_violation_with_snapshot,
-- stamp_tow_ticket, regenerate_tow_ticket, void_violation,
-- set_violation_view_token, set_driver_regenerate_permission). The
-- `<> 'admin' AND` prefix short-circuits before the helper call.
-- Mirrors the existing `IF v_caller_role <> 'admin' THEN` scope-check
-- pattern already in these 8 bodies — same house pattern, same
-- reason (super-admin isn't a tenant).
--
-- Note: driver_create_violation_with_snapshot uses `v_role` (not
-- `v_caller_role`); its gate is written accordingly. Body preservation
-- discipline preserves each fn's variable naming.
--
-- ── 🔴 FOUR RULES INHERITED FROM COMMIT 1 (Mateo Sep 3 §2) ─────────
--   1. legacy checked FIRST → BOTH TRUE regardless of tier_type
--      (A1 is tier_type='enforcement', tier='legacy').
--   2. pm_only → PM-capable, NOT enforcement-capable (Jose Sep 3:
--      negotiated PM customers ride pm_only; they didn't buy
--      Chapter 2308 tow-ticket authority).
--   3. Fail closed on unknown tier — RAISE tier_unrecognized.
--   4. lower(trim()) equality, not ILIKE (metachar-vector-close
--      discipline).
--
-- ── 8 GATED FUNCTIONS ─────────────────────────────────────────────
--   1. driver_create_violation_with_snapshot(jsonb, jsonb)
--   2. set_violation_status(bigint, text)
--   3. stamp_tow_ticket(bigint, bigint, numeric, numeric, text)
--   4. regenerate_tow_ticket(bigint, bigint, numeric, text, text,
--                            numeric, text)
--   5. void_violation(bigint, text)
--   6. set_violation_view_token(bigint)
--   7. set_driver_regenerate_permission(text, boolean)
--   8. update_my_company_tdlr(text)
--
-- ── 4 UNGATED HYBRIDS + 1 HYBRID-CLASSIFIED (Mateo Sep 3 §2) ─────
--   These stay UNGATED as a deliberate exclusion — they serve PM
--   flows too and gating them would break pm_only / pm_starter
--   surfaces that legitimately need them:
--     • approve_vehicle           — PM-track approval path
--     • deactivate_vehicle        — PM-track lifecycle
--     • request_my_vehicle        — resident-facing self-service
--     • pm_plate_lookup           — manager-facing PM lookup
--     • set_manager_approve_permission — PM Starter meter reason
--
-- ── TIER-BEFORE-SCOPE INFORMATION-LEAK NOTE ──────────────────────
-- The gate fires AFTER auth + role gate but BEFORE any scope/state
-- gate. A pm_only caller with the right role but wrong scope gets
-- tier_not_permitted before learning whether the target row exists
-- or belongs to their company. That's the desired shape:
--   • tier is a subscription fact — safe to reveal to authenticated
--     callers who reached the role gate;
--   • the alternative (scope-then-tier) would leak "row exists but
--     you can't see it" via differential error codes to callers who
--     shouldn't even reach enforcement paths.
--
-- ── PARITY-CAPTURE DISCIPLINE ────────────────────────────────────
-- Part 1 snapshots every gated fn's args, result, prosecdef,
-- proconfig, and proacl BEFORE the CREATE OR REPLACE calls. Part 3
-- re-reads AFTER and asserts equality — any drift rolls the txn
-- back. Bodies are also checked for the my_tier_enforcement_capable
-- + tier_not_permitted substrings. This is the Cap-B / Cap-C
-- discipline: byte-identical body preservation is the invariant,
-- machine-enforced, not "trust me."
--
-- ── APPLY DISCIPLINE ──────────────────────────────────────────────
-- 1. BEGIN — atomic apply (parity failure rolls back all 8).
-- 2. Snapshot BEFORE state into session GUC.
-- 3. 8 CREATE OR REPLACE FUNCTION calls (byte-identical bodies
--    from LATEST sources + one gate block each).
-- 4. Parity assertion (args/result/prosecdef/proconfig/proacl
--    UNCHANGED; bodies contain new substrings).
-- 5. Schema audit row (with pre-apply snapshot + fn list + hybrid
--    exclusions).
-- 6. NOTIFY pgrst.
-- 7. COMMIT.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Snapshot BEFORE parity fields into session GUC ─────────
-- Captures per-fn: args (catches DEFAULT drops), result, prosecdef,
-- proconfig (SET search_path), proacl (grants). Stashed into
-- app.track_gating_c2_snap for Part 3's parity assertion + Part 4's
-- audit row.
DO $snap$
DECLARE
  v_sig  TEXT;
  v_oid  oid;
  v_snap JSONB := '{}'::jsonb;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
    'public.set_violation_status(bigint, text)',
    'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
    'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
    'public.void_violation(bigint, text)',
    'public.set_violation_view_token(bigint)',
    'public.set_driver_regenerate_permission(text, boolean)',
    'public.update_my_company_tdlr(text)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'PART1 ENUM FAIL: % not found via to_regprocedure. Enumeration wrong or an earlier migration dropped the fn.', v_sig;
    END IF;
    v_snap := v_snap || jsonb_build_object(
      v_sig,
      jsonb_build_object(
        'args',      pg_get_function_arguments(v_oid),
        'result',    pg_get_function_result(v_oid),
        'prosecdef', (SELECT prosecdef FROM pg_proc WHERE oid = v_oid),
        'proconfig', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = v_oid),
        'proacl',    (SELECT array_to_string(proacl::TEXT[], ',') FROM pg_proc WHERE oid = v_oid)
      )
    );
  END LOOP;
  PERFORM set_config('app.track_gating_c2_snap', v_snap::TEXT, false);
END $snap$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — 8 CREATE OR REPLACE FUNCTION calls with tier gate inserted
--
-- Bodies are byte-identical to their LATEST sources (enumerated in
-- header) EXCEPT for the single gate block inserted after each fn's
-- existing 'role_not_authorized' END IF. Every other line preserved
-- verbatim: signature (with DEFAULTs), LANGUAGE/DEFINER/search_path,
-- DECLARE, comments, logic, trailing REVOKE/GRANT (where present in
-- source). Dollar-quote delimiters ($func$ vs $rpc$) preserved as-is.
-- ══════════════════════════════════════════════════════════════════════


-- ── 2.1 — driver_create_violation_with_snapshot ($rpc$) ─────────────
-- LATEST source: migrations/20260803_violation_snapshot.sql:190
CREATE OR REPLACE FUNCTION public.driver_create_violation_with_snapshot(
  p_violation JSONB,
  p_snapshot  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rpc$
DECLARE
  v_role            TEXT;
  v_violation_id    INT;
  v_snapshot_status TEXT;
  v_record          JSONB;
  v_snapshot_count  INT;
BEGIN
  -- Auth check
  v_role := (SELECT get_my_role());
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_role NOT IN ('driver', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  -- NOTE: this fn uses `v_role` (not `v_caller_role`); variable name matches.
  IF v_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- Input validation
  IF p_violation IS NULL OR jsonb_typeof(p_violation) <> 'object' THEN
    RETURN jsonb_build_object('error', 'p_violation must be a jsonb object');
  END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'array' THEN
    RETURN jsonb_build_object('error', 'p_snapshot must be a jsonb array (may be empty)');
  END IF;
  IF NOT p_violation ? 'scanned_at' OR NOT p_violation ? 'headline_status_at_scan' THEN
    RETURN jsonb_build_object('error', 'p_violation missing required scanned_at or headline_status_at_scan');
  END IF;
  IF NOT p_violation ? 'plate' OR NOT p_violation ? 'violation_type' OR NOT p_violation ? 'property' THEN
    RETURN jsonb_build_object('error', 'p_violation missing required plate/violation_type/property');
  END IF;

  v_snapshot_count := jsonb_array_length(p_snapshot);
  v_snapshot_status := CASE WHEN v_snapshot_count > 0 THEN 'captured' ELSE 'none_present' END;

  -- Parent INSERT. Use jsonb_populate_record to map all provided keys
  -- to the row type; snapshot_status set from computed value above
  -- (never taken from caller — RPC owns it).
  INSERT INTO public.violations
  SELECT (r).*
  FROM (
    SELECT jsonb_populate_record(
      NULL::public.violations,
      p_violation || jsonb_build_object('snapshot_status', v_snapshot_status)
    ) AS r
  ) s
  RETURNING id INTO v_violation_id;

  -- Child INSERTs — one per snapshot record.
  IF v_snapshot_count > 0 THEN
    FOR v_record IN SELECT * FROM jsonb_array_elements(p_snapshot)
    LOOP
      INSERT INTO public.violation_context_records (
        violation_id, record_type, source_id,
        expires_at, start_date, end_date, was_live_at_scan
      ) VALUES (
        v_violation_id,
        v_record->>'record_type',
        v_record->>'source_id',
        NULLIF(v_record->>'expires_at', '')::TIMESTAMPTZ,
        NULLIF(v_record->>'start_date', '')::DATE,
        NULLIF(v_record->>'end_date',   '')::DATE,
        COALESCE((v_record->>'was_live_at_scan')::BOOLEAN, false)
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok',              true,
    'id',              v_violation_id,
    'snapshot_status', v_snapshot_status,
    'snapshot_count',  v_snapshot_count
  );
END;
$rpc$;

REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) TO authenticated;


-- ── 2.2 — set_violation_status ($func$) ─────────────────────────────
-- LATEST source: migrations/20260726_six_site_commit_a_company_scope.sql:80
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

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
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

  -- ── A1 (Commit A, 2026-07-26): wildcard-safe company match ─
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE lower(trim(p.company)) = lower(trim(v_caller_company))
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


-- ── 2.3 — stamp_tow_ticket ($func$) ─────────────────────────────────
-- LATEST source: migrations/20260726_six_site_commit_a_company_scope.sql:213
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

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
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

  -- ── A4 (Commit A, 2026-07-26): wildcard-safe company match (CA/driver) ─
  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND lower(trim(p.company)) = lower(trim(v_company))
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  -- ── A6 (Commit A, 2026-07-26): wildcard-safe property match (manager) ─
  -- NO company predicate — get_my_properties() is already company-scoped.
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE lower(trim(v_row.property)) = lower(trim(p))
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  -- ── A5 (Commit A, 2026-07-26): wildcard-safe storage company match ─
  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (lower(trim(v_storage.company)) = lower(trim(v_company)))
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


-- ── 2.4 — regenerate_tow_ticket ($func$) ────────────────────────────
-- LATEST source: migrations/20260726_six_site_commit_a_company_scope.sql:359
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

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
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

  -- ── A2 (Commit A, 2026-07-26): wildcard-safe company match ─
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(v_caller_company))
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

  -- ── Storage facility: validate + scope ─────────
  SELECT * INTO v_storage
    FROM public.storage_facilities
   WHERE id = p_new_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  -- ── A3 (Commit A, 2026-07-26): wildcard-safe storage company match ─
  IF v_caller_role <> 'admin' THEN
    IF v_storage.company IS NULL
       OR NOT (lower(trim(v_storage.company)) = lower(trim(v_caller_company))) THEN
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


-- ── 2.5 — void_violation ($func$) ───────────────────────────────────
-- LATEST source: migrations/20260611_b175_violation_void.sql:113
CREATE OR REPLACE FUNCTION public.void_violation(
  p_violation_id BIGINT,
  p_void_reason  TEXT
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
  v_row            violations%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  -- ── Auth context ────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ── Role gate (Jose lock amended 2026-06-11: CA-only) ──────────
  -- Authority: admin + company_admin ONLY. Manager EXCLUDED (along
  -- with leasing_agent / driver / resident). The original v1 lock
  -- included manager; Jose amended pre-merge: void is a company-
  -- level correction action, not a per-property one. Managers keep
  -- their existing media-removal authority on confirmed violations
  -- (asymmetry consciously accepted) — but void → CA / admin only.
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Reason validation ──────────────────────────────────────────
  IF p_void_reason IS NULL OR length(trim(p_void_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  -- ── Load the target row + state checks ─────────────────────────
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.is_confirmed = false THEN
    -- Drafts have discard path (F10 draft DELETE policies); void is
    -- the confirmed-record analog.
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    -- Terminal: v1 has no un-void. An erroneously-voided real
    -- violation is corrected by re-issuing a new violation row, not
    -- by reversing the void.
    RETURN jsonb_build_object('error', 'already_voided');
  END IF;

  -- ── Scope gate — mirror F10 SELECT policies per authorized role ─
  -- admin: no scope check (sees all).
  -- company_admin: property IN companies-via-get_my_company().
  -- (Manager branch removed alongside the role gate — managers
  --  cannot void post-amendment.)
  IF v_caller_role = 'company_admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
       )
    THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;
  -- admin falls through (no scope restriction)

  -- ── Atomic write: void the row + audit ─────────────────────────
  UPDATE violations
     SET voided_at       = now(),
         voided_by_email = lower(v_caller_email),
         voided_by_role  = v_caller_role,
         void_reason     = p_void_reason
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_VOIDED',
    'violations',
    p_violation_id::text,
    jsonb_build_object(
      'violation_id', p_violation_id,
      'plate',        v_row.plate,
      'property',     v_row.property,
      'void_reason',  p_void_reason,
      'voided_by_role', v_caller_role,
      'voided_at',    v_updated_row->>'voided_at'
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

-- Grant discipline per [[feedback-revoke-from-anon-explicitly]]:
-- EXPLICIT REVOKE FROM anon + FROM PUBLIC; explicit GRANT to authenticated.
REVOKE EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) TO authenticated;


-- ── 2.6 — set_violation_view_token ($func$) ─────────────────────────
-- LATEST source: migrations/20260611_b178_evidence_field_lockdown.sql:190
CREATE OR REPLACE FUNCTION public.set_violation_view_token(p_violation_id BIGINT)
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
  v_token          TEXT;
  v_expires        TIMESTAMPTZ;
BEGIN
  -- Auth context
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate — same set that generates tow tickets today.
  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- Load + state checks. Only confirmed, non-voided rows get tokens.
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- Scope gate — mirror the F10 SELECT predicates per role.
  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;
  -- admin falls through

  -- Generate token + expiry (unchanged shape).
  -- Schema-qualify gen_random_bytes — pgcrypto installs it in the
  -- 'extensions' schema, NOT public. DEFINER pins search_path = public
  -- (minimum-leak posture is correct), so an unqualified call would
  -- fail at first tokenize with 'function gen_random_bytes(integer)
  -- does not exist'. CREATE-time resolution is lazy → prosecdef +
  -- grant checks pass green; the first real call is what breaks.
  v_expires := now() + interval '90 days';
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  UPDATE violations
     SET view_token            = v_token,
         view_token_expires_at = v_expires
   WHERE id = p_violation_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'token',      v_token,
    'expires_at', v_expires
  );
END
$func$;

-- Grant discipline (explicit REVOKE FROM anon — load-bearing per
-- [[feedback-revoke-from-anon-explicitly]]).
REVOKE EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) TO authenticated;


-- ── 2.7 — set_driver_regenerate_permission ($func$) ─────────────────
-- LATEST source: migrations/20260627_set_driver_regenerate_permission.sql:89
CREATE OR REPLACE FUNCTION public.set_driver_regenerate_permission(
  p_driver_email TEXT,
  p_allowed      BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email     TEXT;
  v_caller_role      TEXT;
  v_caller_company   TEXT;
  v_normalized_email TEXT;
  v_driver_role      TEXT;
  v_driver_company   TEXT;
  v_old_value        BOOLEAN;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ AUTH GATE                                               ║
  -- ╚══════════════════════════════════════════════════════════╝
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Single user_roles lookup: caller role + company
  SELECT role, company INTO v_caller_role, v_caller_company
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;

  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ROLE GATE — admin OR company_admin                      ║
  -- ║   admin: super-admin access, no scope                   ║
  -- ║   company_admin: company-scoped (see scope check below) ║
  -- ║   all others: refused                                   ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ INPUT VALIDATION                                        ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF p_allowed IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'invalid_allowed',
      'hint',  'p_allowed must be TRUE or FALSE (not null).'
    );
  END IF;

  v_normalized_email := lower(trim(COALESCE(p_driver_email, '')));
  IF length(v_normalized_email) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'driver_email_required',
      'hint',  'p_driver_email cannot be null or empty.'
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ TARGET DRIVER: load + state checks                      ║
  -- ╚══════════════════════════════════════════════════════════╝
  SELECT role, company, can_regenerate_tow_ticket
    INTO v_driver_role, v_driver_company, v_old_value
    FROM public.user_roles
   WHERE lower(email) = v_normalized_email
   LIMIT 1;

  IF v_driver_role IS NULL THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;

  -- Target must be a driver — granting regenerate to a manager,
  -- leasing_agent, resident, etc. is nonsense and refused. Layer 1's
  -- can_regenerate_tow_ticket flag is only consulted in
  -- regenerate_tow_ticket's `IF v_caller_role = 'driver'` branch;
  -- non-drivers don't read it.
  IF v_driver_role <> 'driver' THEN
    RETURN jsonb_build_object(
      'error', 'not_a_driver',
      'hint',  'Regenerate permission applies only to drivers. Target role: ' || v_driver_role
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ COMPANY-SCOPE PREDICATE                                 ║
  -- ║                                                          ║
  -- ║ ⚠ Different shape than Layer 1 — see file docstring.     ║
  -- ║   Layer 1 joins through properties.                      ║
  -- ║   This RPC compares user_roles.company directly.         ║
  -- ║                                                          ║
  -- ║ admin: bypasses scope.                                  ║
  -- ║ company_admin: driver.company ~~* caller.company.        ║
  -- ║                                                          ║
  -- ║ ILIKE (~~*) absorbs case/whitespace drift, same as       ║
  -- ║ Layer 1's intent — different join path, same tolerance.  ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role <> 'admin' THEN
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    IF v_driver_company IS NULL
       OR NOT (v_driver_company ~~* v_caller_company) THEN
      RETURN jsonb_build_object('error', 'driver_out_of_scope');
    END IF;
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ IDEMPOTENT SHORT-CIRCUIT                                ║
  -- ║   If new == old, no-op. No UPDATE, no audit row.         ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF COALESCE(v_old_value, FALSE) = p_allowed THEN
    RETURN jsonb_build_object(
      'ok',           TRUE,
      'noop',         TRUE,
      'driver_email', v_normalized_email,
      'allowed',      p_allowed
    );
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ATOMIC UPDATE + AUDIT                                   ║
  -- ║   Single-column UPDATE — narrow surface.                ║
  -- ║   Audit row writes old/new + driver + caller context.    ║
  -- ╚══════════════════════════════════════════════════════════╝
  UPDATE public.user_roles
     SET can_regenerate_tow_ticket = p_allowed
   WHERE lower(email) = v_normalized_email;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'DRIVER_REGENERATE_PERMISSION_CHANGED',
    'user_roles',
    NULL,
    jsonb_build_object(
      'driver_email',  v_normalized_email,
      'old_value',     COALESCE(v_old_value, FALSE),
      'new_value',     p_allowed,
      'caller_role',   v_caller_role,
      'company',       v_caller_company
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',           TRUE,
    'noop',         FALSE,
    'driver_email', v_normalized_email,
    'old_value',    COALESCE(v_old_value, FALSE),
    'new_value',    p_allowed
  );
END;
$func$;

-- Explicit REVOKE from anon + PUBLIC per
-- [[feedback-revoke-from-anon-explicitly]] +
-- [[feedback-function-public-grant-supabase-default]]
REVOKE EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_driver_regenerate_permission(TEXT, BOOLEAN) TO authenticated;


-- ── 2.8 — update_my_company_tdlr ($func$) ───────────────────────────
-- LATEST source: migrations/20260612_b120_p2_ticket_licensing.sql:205
CREATE OR REPLACE FUNCTION public.update_my_company_tdlr(p_tdlr TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_updated_id   BIGINT;
  v_norm_tdlr    TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate — CA only. Admin uses the existing admin portal path;
  -- this RPC is specifically for the CA's own-company write.
  IF v_caller_role <> 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- 🔴 2026-09-03 Track gating Commit 2 — reject if tier doesn't permit enforcement.
  -- Super-admin bypass: admin has company=NULL by design (not a tenant), so a
  -- bare `IF NOT my_tier_enforcement_capable()` would raise `no_company_context`
  -- inside the helper and lock admin out of enforcement RPCs. Skip the tier
  -- check for admin — mirrors the existing `IF v_caller_role <> 'admin'`
  -- scope-check pattern already in these bodies. CA-only fns
  -- (set_violation_status, update_my_company_tdlr) inert-include this branch
  -- for uniformity (admin can't reach the role gate there anyway).
  IF v_caller_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  v_company := get_my_company();
  IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
    RETURN jsonb_build_object('error', 'no_company_scope');
  END IF;

  -- Normalize input: empty string / whitespace-only → NULL (matches
  -- the admin portal's `editingCompany.tdlr_license_number || null`
  -- coercion at admin/page.tsx:246).
  v_norm_tdlr := NULLIF(trim(coalesce(p_tdlr, '')), '');

  UPDATE companies
     SET tdlr_license_number = v_norm_tdlr
   WHERE name ~~* v_company
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('error', 'company_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'tdlr_license_number', v_norm_tdlr);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — Parity assertion (args/result/prosecdef/proconfig/proacl)
--          + body substring assertions
--
-- Any drift rolls the txn back. This is the guarantee that Part 2's
-- CREATE OR REPLACE calls didn't accidentally strip a DEFAULT, change
-- a RETURNS type, flip SECURITY DEFINER→INVOKER, drop a SET clause,
-- or lose a grant. And it confirms the gate block actually landed
-- (my_tier_enforcement_capable + tier_not_permitted substrings).
-- ══════════════════════════════════════════════════════════════════════
DO $parity$
DECLARE
  v_sig       TEXT;
  v_oid       oid;
  v_snap      JSONB;
  v_before    JSONB;
  v_after     JSONB;
  v_body      TEXT;
  v_offenders TEXT := '';
BEGIN
  v_snap := current_setting('app.track_gating_c2_snap', true)::JSONB;
  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'PART3 FAIL: snapshot GUC app.track_gating_c2_snap missing (Part 1 did not run)';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
    'public.set_violation_status(bigint, text)',
    'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
    'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
    'public.void_violation(bigint, text)',
    'public.set_violation_view_token(bigint)',
    'public.set_driver_regenerate_permission(text, boolean)',
    'public.update_my_company_tdlr(text)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      v_offenders := v_offenders || format('%s: DROPPED post-apply; ', v_sig);
      CONTINUE;
    END IF;

    v_before := v_snap -> v_sig;
    v_after  := jsonb_build_object(
      'args',      pg_get_function_arguments(v_oid),
      'result',    pg_get_function_result(v_oid),
      'prosecdef', (SELECT prosecdef FROM pg_proc WHERE oid = v_oid),
      'proconfig', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = v_oid),
      'proacl',    (SELECT array_to_string(proacl::TEXT[], ',') FROM pg_proc WHERE oid = v_oid)
    );

    IF v_before ->> 'args' IS DISTINCT FROM v_after ->> 'args' THEN
      v_offenders := v_offenders || format(
        '%s: args drift  before=%L  after=%L; ',
        v_sig, v_before ->> 'args', v_after ->> 'args'
      );
    END IF;
    IF v_before ->> 'result' IS DISTINCT FROM v_after ->> 'result' THEN
      v_offenders := v_offenders || format(
        '%s: result drift  before=%L  after=%L; ',
        v_sig, v_before ->> 'result', v_after ->> 'result'
      );
    END IF;
    IF v_before ->> 'prosecdef' IS DISTINCT FROM v_after ->> 'prosecdef' THEN
      v_offenders := v_offenders || format(
        '%s: prosecdef drift  before=%s  after=%s; ',
        v_sig, v_before ->> 'prosecdef', v_after ->> 'prosecdef'
      );
    END IF;
    IF v_before ->> 'proconfig' IS DISTINCT FROM v_after ->> 'proconfig' THEN
      v_offenders := v_offenders || format(
        '%s: proconfig drift  before=%L  after=%L; ',
        v_sig, v_before ->> 'proconfig', v_after ->> 'proconfig'
      );
    END IF;
    IF v_before ->> 'proacl' IS DISTINCT FROM v_after ->> 'proacl' THEN
      v_offenders := v_offenders || format(
        '%s: proacl drift  before=%L  after=%L; ',
        v_sig, v_before ->> 'proacl', v_after ->> 'proacl'
      );
    END IF;

    -- Body substring assertions — gate landed.
    v_body := pg_get_functiondef(v_oid);
    IF v_body NOT LIKE '%my_tier_enforcement_capable%' THEN
      v_offenders := v_offenders || format('%s: body missing my_tier_enforcement_capable substring; ', v_sig);
    END IF;
    IF v_body NOT LIKE '%tier_not_permitted%' THEN
      v_offenders := v_offenders || format('%s: body missing tier_not_permitted substring; ', v_sig);
    END IF;
  END LOOP;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'PART3 PARITY FAIL — CREATE OR REPLACE altered a preserved field or gate missing. Offenders: %', v_offenders;
  END IF;
END $parity$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Schema audit row (includes fn list + hybrid exclusions
--          + pre-apply snapshot for future forensics)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TRACK_GATING_WRITE_PATH_GATES',
  'public.driver_create_violation_with_snapshot + set_violation_status + stamp_tow_ticket + regenerate_tow_ticket + void_violation + set_violation_view_token + set_driver_regenerate_permission + update_my_company_tdlr',
  'track_gating_commit_2',
  jsonb_build_object(
    'migration',    '20260903_track_gating_write_path_gates',
    'arc',          'Track gating — Commit 2 of 2 (write-path gates)',
    'commit_1_ref', '1f5bcb9 (20260903_track_gating_helper.sql)',
    'gated_fns', jsonb_build_array(
      'public.driver_create_violation_with_snapshot(jsonb, jsonb)',
      'public.set_violation_status(bigint, text)',
      'public.stamp_tow_ticket(bigint, bigint, numeric, numeric, text)',
      'public.regenerate_tow_ticket(bigint, bigint, numeric, text, text, numeric, text)',
      'public.void_violation(bigint, text)',
      'public.set_violation_view_token(bigint)',
      'public.set_driver_regenerate_permission(text, boolean)',
      'public.update_my_company_tdlr(text)'
    ),
    'ungated_hybrids', jsonb_build_array(
      'approve_vehicle',
      'deactivate_vehicle',
      'request_my_vehicle',
      'pm_plate_lookup',
      'set_manager_approve_permission (PM Starter meter reason)'
    ),
    'gate_shape', 'IF v_caller_role <> ''admin'' AND NOT public.my_tier_enforcement_capable() THEN RAISE EXCEPTION ''tier_not_permitted'' USING HINT = ''...'', ERRCODE = ''insufficient_privilege''; END IF; (driver_create_violation_with_snapshot uses v_role instead of v_caller_role — variable name preserved per source)',
    'admin_bypass_rationale', 'Super-admin has company=NULL by design (not a tenant). A bare IF NOT my_tier_enforcement_capable() would raise no_company_context inside the helper. The <> admin AND prefix short-circuits before the helper call — mirrors the existing scope-check pattern. Regression-guarded by verification file VS_ADMIN.',
    'insertion_point', 'immediately after each fn''s existing role_not_authorized END IF; before any scope/state check',
    'tier_before_scope_note', 'The gate fires AFTER role check + BEFORE scope check. A pm_only caller with the right role but wrong scope learns tier_not_permitted before existence/scope. Deliberate: tier is a subscription fact (safe to reveal to role-gated callers) and the alternative (scope-then-tier) leaks row-existence differentially to callers who shouldn''t reach enforcement paths.',
    'parity_discipline', 'Part 1 snapshotted args/result/prosecdef/proconfig/proacl BEFORE; Part 3 asserted equality AFTER + presence of gate substrings. Any drift rolled the txn back.',
    'pre_apply_snap', current_setting('app.track_gating_c2_snap', true)::JSONB
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — PostgREST cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;
