-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_vehicle_removals_notes_column_verification.sql
--
-- STRUCTURAL gates for the notes-column + 15-arg-signature extension.
-- v2 pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  public.vehicle_removals.notes column exists (TEXT NULL)
--   VS2  🔴 14-arg record_vehicle_removal signature GONE
--        (to_regprocedure returns NULL — proves overload trap avoided)
--   VS3  15-arg record_vehicle_removal exists + SECURITY DEFINER
--   VS4  15-arg record_vehicle_removal grants — EXECUTE to
--        authenticated only (no anon, no PUBLIC)
--   VS5  SCHEMA_TOW_LOG_VEHICLE_REMOVALS_NOTES_COLUMN audit row present
--
-- VS2 is the load-bearing gate — CREATE OR REPLACE on an additional-
-- default-arg signature creates an OVERLOAD, not a replacement. If
-- both survive, PostgREST sees ambiguous candidates when the client
-- omits p_notes and calls fail silently or route wrong. Explicit
-- assertion that the 14-arg is gone.
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: notes column exists with correct type + nullability ═══════
DO $vs1$
DECLARE
  v_type    TEXT;
  v_nullable TEXT;
BEGIN
  SELECT data_type, is_nullable
    INTO v_type, v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'vehicle_removals'
     AND column_name  = 'notes';

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: public.vehicle_removals.notes column not found';
  END IF;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION 'VS1 FAIL: notes column type = % (expected text)', v_type;
  END IF;
  IF v_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VS1 FAIL: notes column is_nullable = % (expected YES)', v_nullable;
  END IF;
END $vs1$;


-- ── VS2: 🔴 14-arg record_vehicle_removal signature GONE ═══════════
-- If the 14-arg form still exists after this migration applies, the
-- DROP FUNCTION step failed silently (usually a type-list mismatch)
-- and PostgREST will see two overloads. Fail loud.
DO $vs2$
DECLARE
  v_old_oid OID;
BEGIN
  v_old_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT'
    || ')'
  );
  IF v_old_oid IS NOT NULL THEN
    RAISE EXCEPTION
      'VS2 FAIL: 14-arg record_vehicle_removal STILL EXISTS (oid=%). Overload trap — DROP FUNCTION in migration did not fire. PostgREST will see ambiguous candidates when clients omit p_notes.',
      v_old_oid;
  END IF;
END $vs2$;


-- ── VS3: 15-arg record_vehicle_removal exists + SECURITY DEFINER ══
DO $vs3$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS3 FAIL: 15-arg public.record_vehicle_removal not found';
  END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS3 FAIL: 15-arg record_vehicle_removal is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs3$;


-- ── VS4: 15-arg grants — EXECUTE authenticated only ════════════════
DO $vs4$
DECLARE
  v_oid     OID;
  v_acl     aclitem[];
  v_acl_str TEXT;
  v_bad     TEXT := '';
BEGIN
  v_oid := to_regprocedure(
    'public.record_vehicle_removal('
    || 'TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT, '
    || 'TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT'
    || ')'
  );
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: function not found (VS3 should have caught)';
  END IF;

  SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
  v_acl_str := COALESCE(v_acl::text, 'NULL');

  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: proacl NULL — default PUBLIC EXECUTE grant not revoked (feedback_function_public_grant_supabase_default)';
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


-- ── VS5: audit row present ═════════════════════════════════════════
DO $vs5$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOW_LOG_VEHICLE_REMOVALS_NOTES_COLUMN'
     AND new_values ->> 'migration' = '20260909_tow_log_vehicle_removals_notes_column';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: audit row missing';
  END IF;
END $vs5$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'vehicle_removals notes column + record_vehicle_removal 15-arg signature'::TEXT AS target,
  ARRAY[
    'VS1  public.vehicle_removals.notes column exists (TEXT nullable)',
    'VS2  🔴 14-arg record_vehicle_removal is GONE (overload trap avoided)',
    'VS3  15-arg record_vehicle_removal exists + SECURITY DEFINER',
    'VS4  15-arg grants — EXECUTE to authenticated only (no anon, no PUBLIC)',
    'VS5  SCHEMA_TOW_LOG_VEHICLE_REMOVALS_NOTES_COLUMN audit row present'
  ] AS gates_verified,
  now() AS verified_at;
