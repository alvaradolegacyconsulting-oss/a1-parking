-- ══════════════════════════════════════════════════════════════════════
-- 20260818_spaces_designated_vehicle_column_and_rpc_verification.sql
-- POST-APPLY: column exists at expected shape (nullable, FK to
-- vehicles.id, ON DELETE SET NULL), COMMENT present, RPC exists as
-- DEFINER, defaults preserved (p_vehicle_id DEFAULT NULL), grants
-- correct (auth only, no anon/PUBLIC), schema audit row landed.
--
-- v2 returns-rows pattern: no BEGIN/COMMIT wrap. Read-only assertions;
-- terminal SELECT is the last statement so its row reaches the SQL
-- Editor. Any RAISE aborts the paste with the exception visible.
--
-- Run AFTER 20260818_spaces_designated_vehicle_column_and_rpc.sql.
-- Paste WHOLE. Expect: one row
--   `PASS | designated_vehicle (col + rpc) | {9 gates} | <ts>`.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.COLUMN_EXISTS ─────────────────────────────────────────────────
DO $$
DECLARE v_data_type TEXT;
BEGIN
  SELECT data_type INTO v_data_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'spaces'
     AND column_name  = 'designated_vehicle_id';
  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'VQ.COLUMN_EXISTS: spaces.designated_vehicle_id missing';
  END IF;
  IF v_data_type NOT IN ('bigint') THEN
    RAISE EXCEPTION 'VQ.COLUMN_EXISTS: expected bigint; got %', v_data_type;
  END IF;
END $$;

-- ── VQ.COLUMN_NULLABLE_NO_DEFAULT ────────────────────────────────────
-- NULL means "any approved vehicle" — today's behavior. A DEFAULT
-- would flip that semantic silently.
DO $$
DECLARE v_is_nullable TEXT; v_default TEXT;
BEGIN
  SELECT is_nullable, column_default INTO v_is_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'spaces'
     AND column_name  = 'designated_vehicle_id';
  IF v_is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VQ.COLUMN_NULLABLE_NO_DEFAULT: expected nullable; got is_nullable=%', v_is_nullable;
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.COLUMN_NULLABLE_NO_DEFAULT: expected no DEFAULT; got %', v_default;
  END IF;
END $$;

-- ── VQ.FK_TO_VEHICLES_SET_NULL ───────────────────────────────────────
-- FK must target vehicles.id AND be ON DELETE SET NULL (not CASCADE
-- — a vehicle delete should NOT delete the space; it should clear
-- the designation and preserve the space + resident tie).
DO $$
DECLARE
  v_fk_count INT;
  v_delete_action CHAR;
BEGIN
  SELECT COUNT(*), MIN(c.confdeltype)
    INTO v_fk_count, v_delete_action
    FROM pg_constraint c
    JOIN pg_class      src ON src.oid = c.conrelid
    JOIN pg_namespace  srcn ON srcn.oid = src.relnamespace
    JOIN pg_class      tgt ON tgt.oid = c.confrelid
    JOIN pg_attribute  a   ON a.attrelid = src.oid AND a.attnum = ANY(c.conkey)
   WHERE c.contype = 'f'
     AND srcn.nspname = 'public'
     AND src.relname  = 'spaces'
     AND tgt.relname  = 'vehicles'
     AND a.attname    = 'designated_vehicle_id';
  IF v_fk_count <> 1 THEN
    RAISE EXCEPTION 'VQ.FK_TO_VEHICLES_SET_NULL: expected 1 FK to vehicles; got %', v_fk_count;
  END IF;
  IF v_delete_action <> 'n' THEN
    -- pg_constraint.confdeltype: 'n' = SET NULL, 'a' = NO ACTION,
    -- 'r' = RESTRICT, 'c' = CASCADE, 'd' = SET DEFAULT
    RAISE EXCEPTION 'VQ.FK_TO_VEHICLES_SET_NULL: expected ON DELETE SET NULL (n); got %', v_delete_action;
  END IF;
END $$;

-- ── VQ.COLUMN_COMMENT_PRESENT ───────────────────────────────────────
-- COMMENT is the durable spec for what NULL means and what surfaces
-- consume the column. Fail loudly if missing or truncated.
DO $$
DECLARE v_comment TEXT;
BEGIN
  SELECT col_description(c.oid, a.attnum) INTO v_comment
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'spaces'
     AND a.attname = 'designated_vehicle_id';
  IF v_comment IS NULL OR length(v_comment) < 100 THEN
    RAISE EXCEPTION 'VQ.COLUMN_COMMENT_PRESENT: comment missing or truncated (len=%)', COALESCE(length(v_comment), 0);
  END IF;
  IF v_comment NOT LIKE '%NEVER consumed by derive_space_allowed_plates%' THEN
    RAISE EXCEPTION 'VQ.COLUMN_COMMENT_PRESENT: comment missing scope-lock reference';
  END IF;
END $$;

-- ── VQ.RPC_EXISTS ────────────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'set_space_designated_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_vehicle_id bigint';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected 1 set_space_designated_vehicle(BIGINT,BIGINT); got %', v_count;
  END IF;
END $$;

-- ── VQ.RPC_STILL_DEFINER ────────────────────────────────────────────
DO $$
DECLARE v_security TEXT;
BEGIN
  SELECT CASE prosecdef WHEN true THEN 'DEFINER' ELSE 'INVOKER' END
    INTO v_security
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'set_space_designated_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_vehicle_id bigint';
  IF v_security <> 'DEFINER' THEN
    RAISE EXCEPTION 'VQ.RPC_STILL_DEFINER: expected SECURITY DEFINER; got %', v_security;
  END IF;
END $$;

-- ── VQ.RPC_DEFAULTS_PRESERVED ───────────────────────────────────────
-- p_vehicle_id DEFAULT NULL is load-bearing — one-arg call clears
-- the designation. A future re-definition dropping the default would
-- break clear-callers with 42883 at call time.
DO $$
DECLARE v_args TEXT;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'set_space_designated_vehicle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_vehicle_id bigint';
  IF v_args NOT LIKE '%DEFAULT NULL%' THEN
    RAISE EXCEPTION 'VQ.RPC_DEFAULTS_PRESERVED: p_vehicle_id DEFAULT NULL missing; one-arg clear-callers would break. Got: %', v_args;
  END IF;
END $$;

-- ── VQ.RPC_GRANTS ───────────────────────────────────────────────────
DO $$
DECLARE v_anon_has BOOLEAN; v_auth_has BOOLEAN; v_public_has BOOLEAN;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.set_space_designated_vehicle(bigint,bigint)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.set_space_designated_vehicle(bigint,bigint)', 'EXECUTE'),
    has_function_privilege('public',        'public.set_space_designated_vehicle(bigint,bigint)', 'EXECUTE')
  INTO v_anon_has, v_auth_has, v_public_has;
  IF v_anon_has THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: anon HAS EXECUTE (must be REVOKED)';
  END IF;
  IF v_public_has THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: PUBLIC HAS EXECUTE (must be REVOKED)';
  END IF;
  IF NOT v_auth_has THEN
    RAISE EXCEPTION 'VQ.RPC_GRANTS: authenticated MISSING EXECUTE';
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_SPACES_DESIGNATED_VEHICLE_COLUMN_AND_RPC'
     AND new_values->>'migration' = '20260818_spaces_designated_vehicle_column_and_rpc';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- ── FINAL: return one row on pass ─────────────────────────────────
SELECT
  'PASS'::TEXT                                    AS status,
  'designated_vehicle (col + rpc)'::TEXT          AS target,
  ARRAY[
    'COLUMN_EXISTS',
    'COLUMN_NULLABLE_NO_DEFAULT',
    'FK_TO_VEHICLES_SET_NULL',
    'COLUMN_COMMENT_PRESENT',
    'RPC_EXISTS',
    'RPC_STILL_DEFINER',
    'RPC_DEFAULTS_PRESERVED',
    'RPC_GRANTS',
    'SCHEMA_AUDIT_ROW'
  ]                                               AS gates_verified,
  now()                                           AS verified_at;
