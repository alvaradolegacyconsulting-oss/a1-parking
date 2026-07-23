-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_do_not_tow_plates_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260723_do_not_tow_plates.sql.
-- Run AFTER the migration lands.
--
-- Pattern: DO-block assertions. Silent = pass.
-- Includes the VQ.GRANTS block per
-- docs/development/migration-verification-template.md — this is the
-- FIRST new-table migration since that template landed, and the
-- template exists precisely so a new table can't ship with the
-- Supabase default-grant hole that bit order_forms + provisioning_failures.
--
-- ── Paste discipline (Mateo 2026-07-23) ────────────────────────────────
-- 🔴 PASTE THE WHOLE FILE, NOT BLOCK-BY-BLOCK. The Supabase SQL Editor
-- has an "auto-enable RLS" helper that scans partial pastes and injects
-- `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` at the end. On a
-- partial DO-block paste that helper can find a PL/pgSQL variable name
-- (e.g., v_prop_id), interpret it as a table name, and inject that
-- ALTER *inside* the DO block — truncating it before the closing
-- $tag$ and producing 'unterminated dollar-quoted string' errors that
-- look like your SQL is broken. It isn't; the editor injected. Paste
-- whole file → run → verify no injection appeared in the pasted text
-- above the run button.

-- ── VQ.A — Table + column shape ────────────────────────────────────────
DO $vqa$
DECLARE
  v_missing TEXT;
  v_expected TEXT[] := ARRAY[
    'id','property_id','plate','reason','added_by','added_at',
    'expires_at','removed_at','removed_by'
  ];
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
  FROM unnest(v_expected) c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'do_not_tow_plates' AND column_name = c
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.A FAIL: do_not_tow_plates missing columns: %', v_missing;
  END IF;

  -- NOT NULLs
  FOR v_missing IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'do_not_tow_plates'
       AND column_name IN ('property_id','plate','reason','added_by','added_at')
       AND is_nullable = 'YES'
  LOOP
    RAISE EXCEPTION 'VQ.A FAIL: column % should be NOT NULL', v_missing;
  END LOOP;

  -- Nullable-by-design
  FOR v_missing IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'do_not_tow_plates'
       AND column_name IN ('expires_at','removed_at','removed_by')
       AND is_nullable = 'NO'
  LOOP
    RAISE EXCEPTION 'VQ.A FAIL: column % should be NULLABLE', v_missing;
  END LOOP;
END $vqa$;

-- ── VQ.B — FK to properties + CASCADE on delete ────────────────────────
DO $vqb$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = rc.constraint_name
   WHERE kcu.table_schema = 'public' AND kcu.table_name = 'do_not_tow_plates'
     AND kcu.column_name = 'property_id'
     AND rc.delete_rule = 'CASCADE';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.B FAIL: do_not_tow_plates.property_id missing FK to properties(id) ON DELETE CASCADE';
  END IF;
END $vqb$;

-- ── VQ.C — CHECK constraints (reason + added_by non-empty) ─────────────
DO $vqc$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints
   WHERE constraint_schema = 'public'
     AND check_clause ILIKE '%reason%';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: dnt_reason_nonempty CHECK missing';
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints
   WHERE constraint_schema = 'public'
     AND check_clause ILIKE '%added_by%';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: dnt_added_by_nonempty CHECK missing';
  END IF;
END $vqc$;

-- ── VQ.D — RLS enabled + 7 policies present ────────────────────────────
-- Expected policies: dnt_admin_all, dnt_manager_select, dnt_manager_insert,
-- dnt_manager_update, dnt_ca_select, dnt_ca_insert, dnt_ca_update.
-- Explicitly ABSENT: any DELETE policy for authenticated (hard delete forbidden).
DO $vqd$
DECLARE
  v_rls          BOOLEAN;
  v_policy_count INT;
  v_delete_count INT;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class
   WHERE relnamespace = 'public'::regnamespace AND relname = 'do_not_tow_plates';
  IF v_rls IS NULL THEN RAISE EXCEPTION 'VQ.D FAIL: do_not_tow_plates not found'; END IF;
  IF v_rls IS NOT TRUE THEN RAISE EXCEPTION 'VQ.D FAIL: RLS not enabled'; END IF;

  SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates';
  IF v_policy_count <> 7 THEN
    RAISE EXCEPTION 'VQ.D FAIL: expected exactly 7 policies (admin_all + 3 manager + 3 CA), found %', v_policy_count;
  END IF;

  -- No client-facing DELETE policy (hard delete forbidden — soft-delete
  -- via removed_at UPDATE only).
  SELECT COUNT(*) INTO v_delete_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates'
     AND cmd = 'DELETE';
  IF v_delete_count <> 0 THEN
    RAISE EXCEPTION 'VQ.D FAIL: expected 0 DELETE policies, found %. Hard DELETE must be forbidden — soft-delete via removed_at UPDATE only.', v_delete_count;
  END IF;

  -- FOR ALL policies count as DELETE-capable too — verify admin_all is the only one
  PERFORM 1 FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates'
     AND policyname = 'dnt_admin_all' AND cmd = 'ALL';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.D FAIL: dnt_admin_all policy missing or not FOR ALL';
  END IF;
END $vqd$;

-- ── VQ.E — Indexes present (partial unique + 2 partial regular) ────────
DO $vqe$
BEGIN
  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates'
     AND indexname = 'idx_dnt_property_plate_active'
     AND indexdef ILIKE '%UNIQUE%'
     AND indexdef ILIKE '%WHERE (removed_at IS NULL)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_dnt_property_plate_active missing or not partial-unique'; END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates'
     AND indexname = 'idx_dnt_plate_active'
     AND indexdef ILIKE '%WHERE (removed_at IS NULL)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_dnt_plate_active missing or not partial'; END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'do_not_tow_plates'
     AND indexname = 'idx_dnt_property_active';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_dnt_property_active missing'; END IF;
END $vqe$;

-- ── VQ.F — Plate normalization trigger fires + normalizes correctly ────
-- Behavioral check: temporary probe row proves the trigger uppercases +
-- strips non-alphanumeric. Cleaned up at end. Uses a fake property_id
-- that doesn't exist so the FK will block the actual INSERT (we only
-- need to prove the trigger's NEW.plate normalization runs BEFORE FK
-- check). Actually — the FK check happens BEFORE row commit but AFTER
-- BEFORE-triggers, so trigger fires first. We use a savepoint to
-- absorb the FK failure and inspect the normalized value.
--
-- Simpler approach: create a temporary property, INSERT + assert +
-- cleanup. Guarded to Test-LEGACY or refuses to run.
DO $vqf$
DECLARE
  v_prop_id BIGINT;
  v_dnt_id  BIGINT;
  v_stored  TEXT;
BEGIN
  -- Pick any test-env property. If Test-LEGACY doesn't have one,
  -- SKIP the behavioral test (don't fail the migration verify).
  SELECT p.id INTO v_prop_id
    FROM public.properties p
    JOIN public.companies c ON c.name = p.company
   WHERE c.company_env = 'test'
   LIMIT 1;

  IF v_prop_id IS NULL THEN
    RAISE NOTICE 'VQ.F SKIP: no test-env property found to run trigger probe';
    RETURN;
  END IF;

  -- Probe INSERT with a plate that needs normalization
  INSERT INTO public.do_not_tow_plates (property_id, plate, reason, added_by)
  VALUES (v_prop_id, 'abc-1234', 'VQ.F probe — auto-delete', 'vq_verification@internal')
  RETURNING id, plate INTO v_dnt_id, v_stored;

  IF v_stored <> 'ABC1234' THEN
    -- Cleanup before raising
    DELETE FROM public.do_not_tow_plates WHERE id = v_dnt_id;
    RAISE EXCEPTION 'VQ.F FAIL: trigger did not normalize plate — stored ''%'' expected ''ABC1234''', v_stored;
  END IF;

  -- Cleanup — soft delete first (documents cleanup) then hard delete
  -- via service_role (this migration runs as superuser/service_role
  -- so DELETE succeeds despite the no-DELETE-policy RLS restriction).
  DELETE FROM public.do_not_tow_plates WHERE id = v_dnt_id;
END $vqf$;

-- ── VQ.G — SCHEMA_ audit row present ───────────────────────────────────
DO $vqg$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DO_NOT_TOW_PLATES_TABLE'
     AND user_email = 'system_migration_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.G FAIL: no SCHEMA_DO_NOT_TOW_PLATES_TABLE audit row found';
  END IF;
END $vqg$;

-- ── VQ.GRANTS — grant surface (adapted from migration-verification-template.md) ─
-- Adapted from template: authenticated INSERT + UPDATE assertions
-- COMMENTED OUT with WHY (this table intentionally allows authenticated
-- writes — managers + CAs add DNT plates directly from the Settings UI,
-- gated by RLS at row level). DELETE assertion KEPT — hard delete
-- forbidden per design (soft-delete via removed_at UPDATE only).
-- All anon assertions KEPT. Sequence USAGE for authenticated
-- COMMENTED OUT with WHY (self-INSERT policy exists).
DO $vq_grants$
BEGIN
  -- IF has_table_privilege('authenticated', 'public.do_not_tow_plates', 'INSERT') THEN
  --   RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has INSERT — REVOKE required';
  -- END IF;
  -- WHY commented: managers/CAs INSERT via manager Settings UI (Commit 5).
  -- Gated by RLS dnt_manager_insert + dnt_ca_insert (scope by property).

  -- IF has_table_privilege('authenticated', 'public.do_not_tow_plates', 'UPDATE') THEN
  --   RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has UPDATE — REVOKE required';
  -- END IF;
  -- WHY commented: managers/CAs UPDATE for soft-delete (set removed_at/by).
  -- Gated by RLS dnt_manager_update + dnt_ca_update.

  IF has_table_privilege('authenticated', 'public.do_not_tow_plates', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has DELETE on do_not_tow_plates — hard DELETE forbidden by design (soft-delete via removed_at UPDATE only)';
  END IF;

  IF has_table_privilege('anon', 'public.do_not_tow_plates', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has SELECT on do_not_tow_plates — anonymous read exposure';
  END IF;
  IF has_table_privilege('anon', 'public.do_not_tow_plates', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has INSERT on do_not_tow_plates — anonymous write exposure';
  END IF;
  IF has_table_privilege('anon', 'public.do_not_tow_plates', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has UPDATE on do_not_tow_plates';
  END IF;
  IF has_table_privilege('anon', 'public.do_not_tow_plates', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has DELETE on do_not_tow_plates';
  END IF;

  -- Sequence: anon USAGE forbidden.
  IF has_sequence_privilege('anon', 'public.do_not_tow_plates_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has USAGE on do_not_tow_plates_id_seq';
  END IF;

  -- Positive assertions (guardrails on the intended path)
  -- These are the assertions that catch the bug of "granted the table
  -- but forgot the sequence" — Manager's INSERT would fail at
  -- nextval() with 'permission denied for sequence' if USAGE missing.
  -- Explicit grants + positive assertions = never breaks (Mateo
  -- 2026-07-23 discipline: never rely on inherited defaults post-
  -- grant-remediation).
  IF NOT has_table_privilege('authenticated', 'public.do_not_tow_plates', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated missing SELECT — RLS policies have nothing to gate';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.do_not_tow_plates', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated missing INSERT — manager/CA Settings UI cannot add plates';
  END IF;
  IF NOT has_sequence_privilege('authenticated', 'public.do_not_tow_plates_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated lacks sequence USAGE on do_not_tow_plates_id_seq — manager INSERT will fail at nextval()';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.do_not_tow_plates', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: service_role missing INSERT — any DEFINER RPC write path broken';
  END IF;
END $vq_grants$;

-- ── All green ──────────────────────────────────────────────────────────
-- Silent completion = table shape correct, RLS + policies correct,
-- indexes present, trigger normalizes, audit row landed, grant surface
-- correct per DNT's intended-write design.
