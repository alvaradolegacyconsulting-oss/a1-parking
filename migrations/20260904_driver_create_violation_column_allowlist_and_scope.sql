-- ══════════════════════════════════════════════════════════════════════
-- 20260904_driver_create_violation_column_allowlist_and_scope.sql
--
-- 🟢 Track gating Commit 3 Commit B — driver_create_violation_with_snapshot rewrite
--
-- Closes the mass-assignment vector Mateo Sep 3 §2 surfaced:
-- prior body used `jsonb_populate_record(NULL::public.violations,
-- p_violation || ...)` which mapped EVERY key in the caller's payload
-- to its matching column. Server owned exactly one field
-- (snapshot_status); everything else on `violations` was
-- caller-controlled — including `tow_ticket_generated`,
-- `tow_fee`, `is_confirmed`, `status`, `voided_at`, `view_token`.
-- A driver could forge a finished tow ticket that never passed
-- stamp_tow_ticket's DNT guard, storage-facility scope check, or
-- already-stamped check.
--
-- ── FIVE CHANGES vs prior body (byte-preserved elsewhere) ──────────
--
-- 1. **Column allowlist** — 17 keys (Mateo Sep 3 followup §1 approved):
--        plate, violation_type, location, notes, property,
--        driver_name, driver_license,
--        video_url,
--        vehicle_color, vehicle_make, vehicle_model, vehicle_year,
--        was_authorized_at_time, decline_reason, decline_reason_note,
--        scanned_at, headline_status_at_scan,
--        is_confirmed   ← accepted-but-ignored (transition key)
--    Any key in p_violation not on the list → RETURN
--    { error: 'unrecognized_keys', keys: [...], hint: '...' }.
--
-- 2. **Server-owned columns** — hardcoded in the INSERT, never read
--    from payload:
--        snapshot_status  → computed from p_snapshot length
--        is_confirmed     → FALSE (draft state; separate confirm
--                            step exists at driver:1511 + CA:3329)
--    Everything else on violations (status, tow_*, void*,
--    view_token*, regenerated_from, created_at) takes its DB default.
--
-- 3. **is_confirmed transition — accepted but ignored** (Mateo Sep 3
--    followup §2 reversal). Client (driver/page.tsx:1290) currently
--    sends `is_confirmed: false`. Strict reject would break the live
--    client during deploy window. Accept the key (on allowlist);
--    ignore the value (RPC hardcodes FALSE). Deprecation cleanup on
--    the client is optional tidying, not a coupled deploy.
--
-- 4. **Property scope guard** — new. Per-role branch:
--        driver          → get_my_driver_assigned_properties() (Commit A)
--        company_admin   → get_my_company() → properties.company match
--        admin           → bypass (super-admin, not a tenant)
--    Returns { error: 'driver_no_properties_assigned' } or
--    { error: 'property_not_authorized_for_driver' } or
--    { error: 'property_not_authorized_for_ca' }.
--
-- 5. **Rejections as jsonb returns** (Mateo Sep 3 followup §2 rule).
--    Every new failure surfaces via `RETURN jsonb_build_object('error',
--    ...)`. Only the tier gate stays a RAISE (uniform across 8 fns;
--    shouldn't diverge in one). Returns land in `rpcRes.data.error`
--    on the client — the fallback narrow (67b76f5) surfaces them
--    directly without falling back.
--
-- ── PARITY PRESERVED ───────────────────────────────────────────────
--
-- Signature UNCHANGED: (p_violation JSONB, p_snapshot JSONB) RETURNS JSONB.
-- LANGUAGE plpgsql SECURITY DEFINER SET search_path=public UNCHANGED.
-- Dollar-quote delimiter $rpc$ UNCHANGED (matches source).
-- REVOKE/GRANT block re-issued verbatim (CREATE OR REPLACE preserves
-- grants; explicit re-issue is defense-in-depth).
--
-- ── PARITY CAPTURE (Mateo Sep 3 §3) ────────────────────────────────
--
-- Part 1 snapshots args/result/prosecdef/proconfig/proacl BEFORE.
-- Part 3 asserts EQUALITY on all 5 fields AFTER. Body substring
-- assertions:
--   MUST contain: unrecognized_keys, get_my_driver_assigned_properties,
--                 property_not_authorized_for_driver
--   MUST NOT contain: jsonb_populate_record (the vector we're closing)
-- Any drift → RAISE + whole transaction rolls back.
--
-- Callers still send is_confirmed: false (client behavior unchanged
-- per §2). Fallback path narrowed in 67b76f5 to skip on
-- rpcRes.data.error, so the new returns surface cleanly to the driver.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — Snapshot BEFORE parity fields into session GUC
-- ══════════════════════════════════════════════════════════════════════
DO $part1$
DECLARE
  v_oid oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  v_snap JSONB;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PART1 FAIL: fn driver_create_violation_with_snapshot(jsonb, jsonb) not found — Commit 2 gate should already be in place';
  END IF;
  v_snap := jsonb_build_object(
    'args',      pg_get_function_arguments(v_oid),
    'result',    pg_get_function_result(v_oid),
    'prosecdef', (SELECT prosecdef FROM pg_proc WHERE oid = v_oid),
    'proconfig', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = v_oid),
    'proacl',    (SELECT array_to_string(proacl::TEXT[], ',') FROM pg_proc WHERE oid = v_oid)
  );
  PERFORM set_config('app.commit_3b_snap', v_snap::TEXT, false);
END $part1$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — CREATE OR REPLACE with allowlist + scope + server-owned
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.driver_create_violation_with_snapshot(
  p_violation JSONB,
  p_snapshot  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rpc$
DECLARE
  v_role              TEXT;
  v_violation_id      INT;
  v_snapshot_status   TEXT;
  v_record            JSONB;
  v_snapshot_count    INT;
  v_property          TEXT;
  v_key               TEXT;
  v_unrecognized_keys TEXT[] := '{}';
  v_assigned          TEXT[];
  -- Allowlist of caller-settable keys. is_confirmed is accepted-but-
  -- ignored (transition key; client sends false today, server hardcodes
  -- FALSE below regardless). See header §3.
  v_allowlist CONSTANT TEXT[] := ARRAY[
    'plate', 'violation_type', 'location', 'notes', 'property',
    'driver_name', 'driver_license',
    'video_url',
    'vehicle_color', 'vehicle_make', 'vehicle_model', 'vehicle_year',
    'was_authorized_at_time', 'decline_reason', 'decline_reason_note',
    'scanned_at', 'headline_status_at_scan',
    'is_confirmed'
  ];
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────
  v_role := (SELECT get_my_role());
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_role NOT IN ('driver', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Track gating (Commit 2 gate — preserved verbatim) ──────────
  -- Super-admin bypass: admin has company=NULL by design; helper
  -- would raise no_company_context and lock admin out. See Commit 2
  -- header for full rationale.
  IF v_role <> 'admin' AND NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'This subscription tier does not include enforcement features. Contact support to upgrade.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Input validation (from prior body) ──────────────────────────
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

  -- ── 🔴 Column allowlist — mass-assignment close ─────────────────
  -- Every key in p_violation must be on v_allowlist. Any extra key
  -- → return { error: 'unrecognized_keys', keys: [...] }. Loud beats
  -- quiet on first release; the reject-shape names the offenders so
  -- the client/server disagreement surfaces immediately.
  FOR v_key IN SELECT jsonb_object_keys(p_violation) LOOP
    IF NOT (v_key = ANY(v_allowlist)) THEN
      v_unrecognized_keys := array_append(v_unrecognized_keys, v_key);
    END IF;
  END LOOP;
  IF array_length(v_unrecognized_keys, 1) > 0 THEN
    RETURN jsonb_build_object(
      'error', 'unrecognized_keys',
      'keys',  to_jsonb(v_unrecognized_keys),
      'hint',  'These keys are server-owned; the RPC sets them from validated inputs. Remove them from p_violation.'
    );
  END IF;

  -- ── 🔴 Property scope guard — per-role branch ───────────────────
  v_property := p_violation ->> 'property';
  IF v_role = 'driver' THEN
    v_assigned := public.get_my_driver_assigned_properties();
    IF v_assigned IS NULL OR array_length(v_assigned, 1) IS NULL THEN
      RETURN jsonb_build_object(
        'error', 'driver_no_properties_assigned',
        'hint',  'Contact your company admin to be assigned to at least one property.'
      );
    END IF;
    IF NOT (lower(trim(v_property)) = ANY (
      SELECT lower(trim(p)) FROM unnest(v_assigned) p)) THEN
      RETURN jsonb_build_object(
        'error', 'property_not_authorized_for_driver',
        'hint',  'The property in this scan is not in your assignment list.'
      );
    END IF;
  ELSIF v_role = 'company_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.properties
       WHERE lower(trim(name)) = lower(trim(v_property))
         AND lower(trim(company)) = lower(trim(public.get_my_company()))
    ) THEN
      RETURN jsonb_build_object(
        'error', 'property_not_authorized_for_ca',
        'hint',  'That property is not at your company.'
      );
    END IF;
  END IF;
  -- admin bypasses scope (super-admin, not a tenant)

  -- ── Compute server-owned snapshot_status ────────────────────────
  v_snapshot_count := jsonb_array_length(p_snapshot);
  v_snapshot_status := CASE WHEN v_snapshot_count > 0 THEN 'captured' ELSE 'none_present' END;

  -- ── 🔴 Explicit INSERT — no jsonb_populate_record ───────────────
  -- Named columns only. Server-owned columns hardcoded; DB defaults
  -- fill the rest (status='new' per column default, tow_* NULL,
  -- void* NULL, view_token* NULL, regenerated_from NULL,
  -- created_at now()).
  --
  -- NULLIF wraps for typed columns handle both JSON null and JSON
  -- empty-string (client sends `vehicle_year: null` when unspecified;
  -- driver/page.tsx:1289 uses `? (parseInt(...) || null) : null`).
  INSERT INTO public.violations (
    -- Scan observation (caller-settable — the 17-key allowlist)
    plate, violation_type, location, notes, property,
    driver_name, driver_license,
    video_url,
    vehicle_color, vehicle_make, vehicle_model, vehicle_year,
    was_authorized_at_time, decline_reason, decline_reason_note,
    scanned_at, headline_status_at_scan,
    -- Server-owned (RPC-computed / hardcoded)
    snapshot_status, is_confirmed
  )
  VALUES (
    p_violation ->> 'plate',
    p_violation ->> 'violation_type',
    p_violation ->> 'location',
    p_violation ->> 'notes',
    v_property,
    p_violation ->> 'driver_name',
    p_violation ->> 'driver_license',
    p_violation ->> 'video_url',
    p_violation ->> 'vehicle_color',
    p_violation ->> 'vehicle_make',
    p_violation ->> 'vehicle_model',
    NULLIF(p_violation ->> 'vehicle_year', '')::SMALLINT,
    NULLIF(p_violation ->> 'was_authorized_at_time', '')::BOOLEAN,
    p_violation ->> 'decline_reason',
    p_violation ->> 'decline_reason_note',
    (p_violation ->> 'scanned_at')::TIMESTAMPTZ,
    p_violation ->> 'headline_status_at_scan',
    v_snapshot_status,   -- server-owned
    FALSE                -- is_confirmed hardcoded (draft state)
  )
  RETURNING id INTO v_violation_id;

  -- ── Child INSERTs (unchanged from prior body) ────────────────────
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

-- Grants re-issued (CREATE OR REPLACE preserves; defense-in-depth).
REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) TO authenticated;

COMMENT ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) IS
  '2026-09-04 Track gating Commit 3 Commit B. Rewrote body to close the mass-assignment vector (jsonb_populate_record removed). 17-key column allowlist + server-owned columns (snapshot_status computed, is_confirmed hardcoded FALSE) + per-role property scope guard (driver via get_my_driver_assigned_properties, CA via get_my_company, admin bypass). is_confirmed accepted-but-ignored on payload for client-transition compatibility. Rejections as jsonb returns; only tier_not_permitted stays a RAISE.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — Parity assertion + body-substring checks
-- ══════════════════════════════════════════════════════════════════════
DO $part3$
DECLARE
  v_oid       oid;
  v_snap      JSONB;
  v_before    JSONB;
  v_after     JSONB;
  v_body      TEXT;
  v_offenders TEXT := '';
BEGIN
  v_snap := current_setting('app.commit_3b_snap', true)::JSONB;
  IF v_snap IS NULL THEN
    RAISE EXCEPTION 'PART3 FAIL: snapshot GUC app.commit_3b_snap missing (PART 1 did not run)';
  END IF;

  v_oid := to_regprocedure('public.driver_create_violation_with_snapshot(jsonb, jsonb)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PART3 FAIL: fn DROPPED post-CREATE OR REPLACE';
  END IF;

  v_before := v_snap;
  v_after  := jsonb_build_object(
    'args',      pg_get_function_arguments(v_oid),
    'result',    pg_get_function_result(v_oid),
    'prosecdef', (SELECT prosecdef FROM pg_proc WHERE oid = v_oid),
    'proconfig', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = v_oid),
    'proacl',    (SELECT array_to_string(proacl::TEXT[], ',') FROM pg_proc WHERE oid = v_oid)
  );

  -- Signature + attributes MUST be unchanged (only body changes).
  IF v_before ->> 'args' IS DISTINCT FROM v_after ->> 'args' THEN
    v_offenders := v_offenders || format('args drift  before=%L  after=%L; ',
      v_before ->> 'args', v_after ->> 'args');
  END IF;
  IF v_before ->> 'result' IS DISTINCT FROM v_after ->> 'result' THEN
    v_offenders := v_offenders || format('result drift  before=%L  after=%L; ',
      v_before ->> 'result', v_after ->> 'result');
  END IF;
  IF v_before ->> 'prosecdef' IS DISTINCT FROM v_after ->> 'prosecdef' THEN
    v_offenders := v_offenders || format('prosecdef drift  before=%s  after=%s; ',
      v_before ->> 'prosecdef', v_after ->> 'prosecdef');
  END IF;
  IF v_before ->> 'proconfig' IS DISTINCT FROM v_after ->> 'proconfig' THEN
    v_offenders := v_offenders || format('proconfig drift  before=%L  after=%L; ',
      v_before ->> 'proconfig', v_after ->> 'proconfig');
  END IF;
  IF v_before ->> 'proacl' IS DISTINCT FROM v_after ->> 'proacl' THEN
    v_offenders := v_offenders || format('proacl drift  before=%L  after=%L; ',
      v_before ->> 'proacl', v_after ->> 'proacl');
  END IF;

  -- Body substring assertions — new markers MUST be present,
  -- retired marker MUST be absent.
  v_body := pg_get_functiondef(v_oid);

  IF v_body NOT LIKE '%unrecognized_keys%' THEN
    v_offenders := v_offenders || 'body missing unrecognized_keys marker (allowlist enforcement); ';
  END IF;
  IF v_body NOT LIKE '%get_my_driver_assigned_properties%' THEN
    v_offenders := v_offenders || 'body missing get_my_driver_assigned_properties call (driver scope guard); ';
  END IF;
  IF v_body NOT LIKE '%property_not_authorized_for_driver%' THEN
    v_offenders := v_offenders || 'body missing property_not_authorized_for_driver return; ';
  END IF;
  IF v_body NOT LIKE '%my_tier_enforcement_capable%' THEN
    v_offenders := v_offenders || 'body missing my_tier_enforcement_capable (Commit 2 gate REGRESSION); ';
  END IF;
  IF v_body NOT LIKE '%tier_not_permitted%' THEN
    v_offenders := v_offenders || 'body missing tier_not_permitted RAISE (Commit 2 gate REGRESSION); ';
  END IF;
  IF v_body LIKE '%jsonb_populate_record%' THEN
    v_offenders := v_offenders || 'body still contains jsonb_populate_record (mass-assignment vector NOT closed); ';
  END IF;

  IF v_offenders <> '' THEN
    RAISE EXCEPTION 'PART3 PARITY/CONTENT FAIL — % Rolling back Commit B.', v_offenders;
  END IF;
END $part3$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_DRIVER_CREATE_VIOLATION_ALLOWLIST_AND_SCOPE',
  'public.driver_create_violation_with_snapshot',
  'commit_3_commit_b',
  jsonb_build_object(
    'migration',        '20260904_driver_create_violation_column_allowlist_and_scope',
    'arc',              'Track gating Commit 3 Commit B — mass-assignment close + property scope guard',
    'closes_vector',    'jsonb_populate_record → any-column mass-assignment. Prior body owned only snapshot_status; caller controlled everything else.',
    'allowlist_keys',   jsonb_build_array(
                          'plate','violation_type','location','notes','property',
                          'driver_name','driver_license','video_url',
                          'vehicle_color','vehicle_make','vehicle_model','vehicle_year',
                          'was_authorized_at_time','decline_reason','decline_reason_note',
                          'scanned_at','headline_status_at_scan',
                          'is_confirmed  (accepted-but-ignored transition key)'
                        ),
    'server_owned',     jsonb_build_object(
                          'snapshot_status', 'computed from p_snapshot length',
                          'is_confirmed',    'hardcoded FALSE (draft state; separate confirm step at driver:1511 + CA:3329)',
                          'others_via_default', 'status/tow_*/void*/view_token*/regenerated_from/created_at all take DB defaults'
                        ),
    'scope_guard',      jsonb_build_object(
                          'driver',        'get_my_driver_assigned_properties (Commit A helper)',
                          'company_admin', 'get_my_company() → properties.company match',
                          'admin',         'bypass (super-admin, not a tenant)'
                        ),
    'rejection_shape',  'RETURN jsonb_build_object(...) for validation/scope. RAISE only for tier_not_permitted (Commit 2 uniform).',
    'client_compat',    'Client at driver/page.tsx:1275-1300 already sends is_confirmed:false (on allowlist; ignored). Fallback narrow (67b76f5) surfaces jsonb returns via Branch 1 without falling back. No coupled deploy required.',
    'parity_check',     'PART 3 asserts EQUALITY on args/result/prosecdef/proconfig/proacl. Body substring: MUST contain unrecognized_keys + get_my_driver_assigned_properties + property_not_authorized_for_driver + my_tier_enforcement_capable + tier_not_permitted. MUST NOT contain jsonb_populate_record. Any drift → rollback.',
    'next',             'Commit C — column-level GRANT tightening on public.violations (REVOKE outcome-of-other-RPCs columns from authenticated; DEFINER RPCs unaffected). Awaiting enumeration report per Mateo Sep 3 followup §3.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — PostgREST cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;
