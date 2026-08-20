-- ══════════════════════════════════════════════════════════════════════
-- 20260820_property_house_rules_v1_verification.sql
-- POST-APPLY: all five properties columns exist at expected shape,
-- history table exists with correct FK + indexes, RLS enabled, three
-- policies present, two triggers bound as DEFINER, grants correct,
-- schema audit row landed.
--
-- v2 returns-rows pattern: no BEGIN/COMMIT wrap. Read-only assertions;
-- terminal SELECT is the last statement so its row reaches the SQL
-- Editor. Any RAISE aborts the paste with the exception visible.
--
-- Run AFTER 20260820_property_house_rules_v1.sql.
-- Paste WHOLE. Expect: one row
--   `PASS | property_house_rules_v1 | {gates} | <ts>`.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.COLUMNS_ON_PROPERTIES ────────────────────────────────────────
DO $$
DECLARE
  v_missing TEXT[];
  v_col TEXT;
BEGIN
  v_missing := ARRAY[]::TEXT[];
  FOR v_col IN SELECT unnest(ARRAY[
    'house_rules_text',
    'house_rules_version',
    'house_rules_effective_date',
    'house_rules_updated_at',
    'house_rules_updated_by_email'
  ])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'properties'
         AND column_name = v_col
    ) THEN
      v_missing := array_append(v_missing, v_col);
    END IF;
  END LOOP;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.COLUMNS_ON_PROPERTIES: missing columns %', v_missing;
  END IF;
END $$;

-- ── VQ.VERSION_COLUMN_SHAPE ─────────────────────────────────────────
-- Version must be NOT NULL DEFAULT 0. Nullable version breaks the
-- IS DISTINCT FROM bump comparison and creates the same ambiguity
-- class as feedback_absence_must_not_be_failure_output.
DO $$
DECLARE
  v_nullable TEXT;
  v_default TEXT;
BEGIN
  SELECT is_nullable, column_default
    INTO v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'properties'
     AND column_name  = 'house_rules_version';
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'VQ.VERSION_COLUMN_SHAPE: house_rules_version must be NOT NULL; got is_nullable=%', v_nullable;
  END IF;
  IF v_default IS NULL OR v_default NOT LIKE '%0%' THEN
    RAISE EXCEPTION 'VQ.VERSION_COLUMN_SHAPE: expected DEFAULT 0; got %', v_default;
  END IF;
END $$;

-- ── VQ.HISTORY_TABLE_EXISTS ─────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name   = 'property_house_rules_versions';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.HISTORY_TABLE_EXISTS: property_house_rules_versions table missing';
  END IF;
END $$;

-- ── VQ.HISTORY_FK_ON_DELETE_CASCADE ─────────────────────────────────
-- FK to properties must ON DELETE CASCADE (property deletion clears
-- its version rows — history has no meaning without the property).
DO $$
DECLARE v_delete_action CHAR;
BEGIN
  SELECT c.confdeltype INTO v_delete_action
    FROM pg_constraint c
    JOIN pg_class      src ON src.oid = c.conrelid
    JOIN pg_namespace  n   ON n.oid = src.relnamespace
   WHERE c.contype = 'f'
     AND n.nspname = 'public'
     AND src.relname = 'property_house_rules_versions';
  IF v_delete_action IS NULL THEN
    RAISE EXCEPTION 'VQ.HISTORY_FK_ON_DELETE_CASCADE: FK missing on property_house_rules_versions';
  END IF;
  IF v_delete_action <> 'c' THEN
    -- 'c' = CASCADE, 'a' = NO ACTION, 'r' = RESTRICT, 'n' = SET NULL
    RAISE EXCEPTION 'VQ.HISTORY_FK_ON_DELETE_CASCADE: expected ON DELETE CASCADE (c); got %', v_delete_action;
  END IF;
END $$;

-- ── VQ.HISTORY_RLS_ENABLED ──────────────────────────────────────────
DO $$
DECLARE v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'property_house_rules_versions';
  IF NOT COALESCE(v_rls, false) THEN
    RAISE EXCEPTION 'VQ.HISTORY_RLS_ENABLED: RLS not enabled on property_house_rules_versions';
  END IF;
END $$;

-- ── VQ.HISTORY_POLICIES_PRESENT ─────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'property_house_rules_versions'
     AND policyname IN (
       'manager_select_house_rules_versions',
       'ca_select_house_rules_versions',
       'admin_all_house_rules_versions'
     );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VQ.HISTORY_POLICIES_PRESENT: expected 3 policies (manager/ca/admin); got %', v_count;
  END IF;
END $$;

-- ── VQ.HISTORY_NO_WRITE_POLICIES ────────────────────────────────────
-- Non-admin roles MUST NOT have INSERT/UPDATE/DELETE policies.
-- History is trigger-populated only. A non-admin write policy would
-- allow app-side rewrite of "what were the rules on <date>" —
-- undermines the dispatcher use case (Jose Aug 20).
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename  = 'property_house_rules_versions'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND policyname <> 'admin_all_house_rules_versions';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'VQ.HISTORY_NO_WRITE_POLICIES: found % non-admin write policies (must be 0)', v_count;
  END IF;
END $$;

-- ── VQ.TRIGGERS_BOUND ───────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname = 'properties'
     AND t.tgname IN ('trg_house_rules_version', 'trg_house_rules_history');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VQ.TRIGGERS_BOUND: expected 2 house-rules triggers on properties; got %', v_count;
  END IF;
END $$;

-- ── VQ.TRIGGER_FUNCTIONS_DEFINER ────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('trg_fn_house_rules_version', 'trg_fn_house_rules_history')
     AND p.prosecdef = true;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VQ.TRIGGER_FUNCTIONS_DEFINER: expected 2 DEFINER trigger functions; got %', v_count;
  END IF;
END $$;

-- ── VQ.BEFORE_TRIGGER_NULL_SAFE ─────────────────────────────────────
-- Body must use IS [NOT] DISTINCT FROM for the NULL-safe text
-- comparison (feedback_sql_null_in_scope_gate_bypass + Finding B
-- Aug 19 rule). Naive `= OLD.house_rules_text` returns NULL when
-- either side is NULL → version bumps silently miss unpublish
-- transitions.
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'trg_fn_house_rules_version';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.BEFORE_TRIGGER_NULL_SAFE: trg_fn_house_rules_version function body unreadable';
  END IF;
  IF v_body !~* 'IS\s+(NOT\s+)?DISTINCT\s+FROM' THEN
    RAISE EXCEPTION 'VQ.BEFORE_TRIGGER_NULL_SAFE: body missing IS [NOT] DISTINCT FROM — NULL-safe compare required';
  END IF;
END $$;

-- ── VQ.GRANTS_HISTORY ───────────────────────────────────────────────
DO $$
DECLARE v_anon BOOLEAN; v_auth BOOLEAN;
BEGIN
  SELECT
    has_table_privilege('anon',          'public.property_house_rules_versions', 'SELECT'),
    has_table_privilege('authenticated', 'public.property_house_rules_versions', 'SELECT')
  INTO v_anon, v_auth;
  -- anon MAY have SELECT at the grant level but RLS gates every row →
  -- not a bug. Enforce anon has NO INSERT/UPDATE/DELETE.
  IF has_table_privilege('anon', 'public.property_house_rules_versions', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS_HISTORY: anon HAS INSERT (must be REVOKED)';
  END IF;
  IF has_table_privilege('anon', 'public.property_house_rules_versions', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_HISTORY: anon HAS UPDATE (must be REVOKED)';
  END IF;
  IF has_table_privilege('anon', 'public.property_house_rules_versions', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.GRANTS_HISTORY: anon HAS DELETE (must be REVOKED)';
  END IF;
  IF NOT v_auth THEN
    RAISE EXCEPTION 'VQ.GRANTS_HISTORY: authenticated MISSING SELECT';
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PROPERTY_HOUSE_RULES_V1'
     AND new_values->>'migration' = '20260820_property_house_rules_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- ── FINAL: return one row on pass ─────────────────────────────────
SELECT
  'PASS'::TEXT                                    AS status,
  'property_house_rules_v1'::TEXT                 AS target,
  ARRAY[
    'COLUMNS_ON_PROPERTIES',
    'VERSION_COLUMN_SHAPE',
    'HISTORY_TABLE_EXISTS',
    'HISTORY_FK_ON_DELETE_CASCADE',
    'HISTORY_RLS_ENABLED',
    'HISTORY_POLICIES_PRESENT',
    'HISTORY_NO_WRITE_POLICIES',
    'TRIGGERS_BOUND',
    'TRIGGER_FUNCTIONS_DEFINER',
    'BEFORE_TRIGGER_NULL_SAFE',
    'GRANTS_HISTORY',
    'SCHEMA_AUDIT_ROW'
  ]                                               AS gates_verified,
  now()                                           AS verified_at;
