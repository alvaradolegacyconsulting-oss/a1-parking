-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_commit_4_rpcs_verification.sql
--
-- STRUCTURAL gates for Tow Log Commit 4 (3 DEFINER RPCs). v2 pattern
-- (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
--
-- ── 🔴 SIGNATURE SUPERSEDED — UPDATED 2026-09-10 ────────────────────
-- This file originally asserted the 14-arg record_vehicle_removal that
-- 20260909_tow_log_commit_4_rpcs.sql created. That signature was
-- DROPPED hours later by 20260909_tow_log_vehicle_removals_notes_column
-- .sql, which created the 15-arg form (p_notes appended).
--
-- Leaving the old assertion in place built a trap with the gradient
-- pointing the WRONG WAY:
--   1. Re-run this file → VS1 fails, because the 14-arg is correctly gone
--   2. Natural response to a failing verification → re-apply its
--      migration
--   3. 20260909_tow_log_commit_4_rpcs.sql does CREATE OR REPLACE on the
--      14-arg → RESURRECTS the dropped signature
--   4. Now BOTH exist. This stale gate passes; the current one fails;
--      PostgREST returns PGRST203 "could not choose the best candidate"
--      for every client call that omits p_notes.
--
-- That is exactly what happened on 2026-09-10 — confirmed live via
-- PostgREST before the corrective DROP.
--
-- Gates now assert the 15-arg (what actually ships) AND that the 14-arg
-- is gone, so this file DETECTS the resurrection instead of rewarding
-- it. See the SUPERSEDED — DO NOT RE-APPLY header on
-- 20260909_tow_log_commit_4_rpcs.sql.
--
-- Body-level assertions about record_vehicle_removal's plate handling
-- live in 20260910_record_vehicle_removal_plate_normalize_fix_
-- verification.sql, not here.
--
-- ── SCOPE ──────────────────────────────────────────────────────────
-- Booleans and OIDs only. NO rendered SQL string assertions.
-- Function signature gates use to_regprocedure() per
-- feedback_function_parameter_modifiers_stripped.
-- Grant audits use pg_proc.proacl per
-- feedback_information_schema_under_reports_grants.
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  record_vehicle_removal function exists with 15-arg signature
--        + SECURITY DEFINER
--   VS1b 🔴 the 14-arg signature this migration originally created is
--        GONE — see the SUPERSEDED note below
--   VS2  record_vehicle_removal grants — EXECUTE to authenticated only
--   VS3  attach_removal_media function exists with 3-arg signature
--        + SECURITY DEFINER
--   VS4  attach_removal_media grants — EXECUTE to authenticated only
--   VS5  void_vehicle_removal function exists with 2-arg signature
--        + SECURITY DEFINER
--   VS6  void_vehicle_removal grants — EXECUTE to authenticated only
--   VS7  SCHEMA_TOW_LOG_COMMIT_4_RPCS audit row present
--
-- Execution gates deferred to the empirical pass with Commit 3 E12-E22.
-- Commit 4 execution set is richer — more error branches, path-prefix
-- validation, soft-link resolution, tow_operator scope, towed_at
-- future check. Assertions will be written from actual message text
-- (never predicted) — same discipline as Commit 2 empirical file.
-- ══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
-- Reusable check pattern: SECURITY DEFINER function + authenticated-
-- only EXECUTE. Applied per RPC below.
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: record_vehicle_removal exists + SECURITY DEFINER ═══════════
DO $vs1$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure('public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.record_vehicle_removal(15 args) not found';
  END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS1 FAIL: record_vehicle_removal is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs1$;


-- ── VS1b: 🔴 the superseded 14-arg signature is GONE ═══════════════
-- The load-bearing gate of this file after 2026-09-10. If the 14-arg
-- exists, someone re-applied 20260909_tow_log_commit_4_rpcs.sql and
-- PostgREST now sees two candidates for every call that omits p_notes.
-- Corrective: DROP FUNCTION the 14-arg, then NOTIFY pgrst.
DO $vs1b$
DECLARE v_old_oid OID;
BEGIN
  v_old_oid := to_regprocedure('public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT)');
  IF v_old_oid IS NOT NULL THEN
    RAISE EXCEPTION
      'VS1b FAIL: the SUPERSEDED 14-arg record_vehicle_removal exists again (oid=%). 20260909_tow_log_commit_4_rpcs.sql was re-applied — its CREATE OR REPLACE resurrects a signature that 20260909_tow_log_vehicle_removals_notes_column.sql dropped. PostgREST will return PGRST203 for every client call that omits p_notes. Fix: DROP FUNCTION public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT); then NOTIFY pgrst, ''reload schema''.',
      v_old_oid;
  END IF;
END $vs1b$;


-- ── VS2: record_vehicle_removal grants ═════════════════════════════
DO $vs2$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure('public.record_vehicle_removal(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: function not found (VS1 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS2 FAIL: proacl NULL — default PUBLIC EXECUTE grant not revoked (feedback_function_public_grant_supabase_default). Explicit REVOKE FROM PUBLIC + FROM anon required.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%'
  ) THEN
    v_bad := v_bad || format('missing authenticated EXECUTE (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%'
  ) THEN
    v_bad := v_bad || format('anon EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS2 FAIL: %', v_bad;
  END IF;
END $vs2$;


-- ── VS3: attach_removal_media exists + SECURITY DEFINER ════════════
DO $vs3$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure('public.attach_removal_media(BIGINT, TEXT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: public.attach_removal_media(BIGINT, TEXT, TEXT) not found';
  END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS3 FAIL: attach_removal_media is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs3$;


-- ── VS4: attach_removal_media grants ═══════════════════════════════
DO $vs4$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure('public.attach_removal_media(BIGINT, TEXT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: function not found (VS3 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: proacl NULL — default PUBLIC EXECUTE grant not revoked';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%'
  ) THEN
    v_bad := v_bad || format('missing authenticated EXECUTE (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%'
  ) THEN
    v_bad := v_bad || format('anon EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS4 FAIL: %', v_bad;
  END IF;
END $vs4$;


-- ── VS5: void_vehicle_removal exists + SECURITY DEFINER ════════════
DO $vs5$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure('public.void_vehicle_removal(BIGINT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS5 FAIL: public.void_vehicle_removal(BIGINT, TEXT) not found';
  END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS5 FAIL: void_vehicle_removal is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs5$;


-- ── VS6: void_vehicle_removal grants ══════════════════════════════
DO $vs6$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure('public.void_vehicle_removal(BIGINT, TEXT)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS6 FAIL: function not found (VS5 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS6 FAIL: proacl NULL — default PUBLIC EXECUTE grant not revoked';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%'
  ) THEN
    v_bad := v_bad || format('missing authenticated EXECUTE (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%'
  ) THEN
    v_bad := v_bad || format('anon EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC EXECUTE granted (proacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL: %', v_bad;
  END IF;
END $vs6$;


-- ── VS7: audit row present ═════════════════════════════════════════
DO $vs7$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOW_LOG_COMMIT_4_RPCS'
     AND new_values ->> 'migration' = '20260909_tow_log_commit_4_rpcs';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS7 FAIL: audit row missing';
  END IF;
END $vs7$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'Tow Log Commit 4 RPCs structural (3 DEFINER functions + grants + audit)'::TEXT AS target,
  ARRAY[
    'VS1  record_vehicle_removal(15 args) exists + SECURITY DEFINER',
    'VS1b 🔴 the superseded 14-arg signature is GONE (detects a re-apply of this migration)',
    'VS2  record_vehicle_removal grants — EXECUTE to authenticated only (no anon, no PUBLIC)',
    'VS3  attach_removal_media(BIGINT,TEXT,TEXT) exists + SECURITY DEFINER',
    'VS4  attach_removal_media grants — EXECUTE to authenticated only',
    'VS5  void_vehicle_removal(BIGINT,TEXT) exists + SECURITY DEFINER',
    'VS6  void_vehicle_removal grants — EXECUTE to authenticated only',
    'VS7  SCHEMA_TOW_LOG_COMMIT_4_RPCS audit row present'
  ] AS gates_verified,
  now() AS verified_at;


-- ══════════════════════════════════════════════════════════════════
-- NOT IN THIS FILE — EXECUTION GATES (deferred to empirical pass)
--
-- Land with Commit 3 E12-E22 after Jose runs the runbook. Commit 4
-- execution set is richer — write-path exercises + validation branches.
-- Documented for the eventual assertion set:
--
-- record_vehicle_removal:
--   E30  manager pm-tier @ property A creates → {ok:true, id:<n>}
--        AND row shows operator_name/phone snapshotted from
--        tow_operators; recorded_by_email = auth.jwt() email;
--        linked_vehicle_id resolved (or NULL for walk-in)
--   E31  enforcement-tier manager → RAISE 42501 tier_not_permitted
--   E32  driver role → {error:'role_not_authorized'}
--   E33  anon → 42501 permission denied for function
--   E34  towed_at 10 min in future → {error:'towed_at_future'}
--   E35  invalid removal_type → {error:'invalid_removal_type'}
--   E36  cross-company tow_operator_id → {error:'tow_operator_out_of_scope'}
--   E37  deactivated tow_operator_id → {error:'tow_operator_inactive'}
--   E38  manager @ property A submits property B → {error:'property_not_authorized_for_manager'}
--   E39  plate that matches an active vehicles row → row.linked_vehicle_id populated
--   E40  plate that doesn't match anything → row.linked_vehicle_id NULL
--   E41  plate with hyphen → row.plate stored alphanumeric-only.
--        ⚠ REVISED 2026-09-10: the RPC now normalizes and inserts the
--        normalized value, so the trigger NO-OPS. Proving the trigger
--        still raises needs a direct service_role INSERT, not this RPC.
--        Covered as E2/E3 in 20260910_record_vehicle_removal_plate_
--        normalize_fix_verification.sql.
--
-- attach_removal_media:
--   E42  manager attaches with correct prefix path → {ok:true, id:<n>}
--   E43  path missing property_id/removal_id/ prefix → {error:'path_mismatch', expected_prefix:'...'}
--   E44  invalid kind → {error:'invalid_kind'}
--   E45  cross-property manager attach → {error:'out_of_scope'}
--   E46  removal doesn't exist → {error:'removal_not_found'}
--
-- void_vehicle_removal:
--   E47  manager voids own removal → {ok:true, removal:<row>} with voided_at set
--   E48  void without reason → {error:'reason_required'}
--   E49  void already-voided → {error:'already_voided'}
--   E50  cross-company void → {error:'out_of_scope'}
--
-- Each empirical case: Jose triggers, reports message verbatim,
-- assertion gets written from actual text.
--
-- Fixtures reused: Test-PM, Test-LEGACY, Test-ENF, plus tow_operators
-- rows created via Commit 2 in the empirical harness.
-- ══════════════════════════════════════════════════════════════════
