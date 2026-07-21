-- ═══════════════════════════════════════════════════════════════════════
-- 20260721_provisioning_failures_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260721_provisioning_failures.sql.
-- Run AFTER the migration lands.
--
-- Pattern (matches 743e519, 20260721_company_name_available_rpc_verification):
-- every VQ is a DO-block assertion. Silent success = pass. Any failure
-- RAISE EXCEPTIONs with a named reason. If this file completes without
-- error output, all gates are green and Commit B (the code half) may
-- deploy. If ANY gate raises, DO NOT deploy Commit B — the webhook's
-- INSERT into provisioning_failures would fail.
--
-- Read-only. Safe to run repeatedly.

-- ── VQ.A — Table + column shape ────────────────────────────────────────
-- Expect all 15 columns present with the intended nullability.
DO $vqa$
DECLARE
  v_missing TEXT;
  v_expected TEXT[] := ARRAY[
    'id','stripe_session_id','stripe_customer_id','stripe_subscription_id',
    'requested_company_name','error_code','error_message','raw_intended_tier',
    'alert_email_sent','alert_email_message_id','alert_email_error',
    'resolved','resolved_at','resolved_by','resolved_notes','created_at'
  ];
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
  FROM unnest(v_expected) c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'provisioning_failures'
      AND column_name = c
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.A FAIL: provisioning_failures missing columns: %', v_missing;
  END IF;

  -- requested_company_name + error_message must be NOT NULL
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'provisioning_failures'
     AND column_name = 'requested_company_name' AND is_nullable = 'NO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.A FAIL: requested_company_name should be NOT NULL';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'provisioning_failures'
     AND column_name = 'error_message' AND is_nullable = 'NO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.A FAIL: error_message should be NOT NULL';
  END IF;

  -- resolved + alert_email_sent must default FALSE (BOOLEAN NOT NULL)
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'provisioning_failures'
     AND column_name = 'resolved' AND is_nullable = 'NO' AND column_default ILIKE '%false%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.A FAIL: resolved should be BOOLEAN NOT NULL DEFAULT FALSE';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'provisioning_failures'
     AND column_name = 'alert_email_sent' AND is_nullable = 'NO' AND column_default ILIKE '%false%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.A FAIL: alert_email_sent should be BOOLEAN NOT NULL DEFAULT FALSE';
  END IF;
END $vqa$;

-- ── VQ.B — RLS enabled ─────────────────────────────────────────────────
DO $vqb$
DECLARE v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND relname = 'provisioning_failures';
  IF v_rls IS NULL THEN
    RAISE EXCEPTION 'VQ.B FAIL: provisioning_failures table not found in pg_class';
  END IF;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION 'VQ.B FAIL: RLS not enabled on provisioning_failures';
  END IF;
END $vqb$;

-- ── VQ.C — Admin-all policy present, correct shape ────────────────────
DO $vqc$
DECLARE
  v_count INT;
  v_qual  TEXT;
  v_check TEXT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'provisioning_failures';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: expected exactly 1 policy on provisioning_failures, found %', v_count;
  END IF;

  SELECT qual, with_check INTO v_qual, v_check
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'provisioning_failures'
    AND policyname = 'provisioning_failures_admin_all';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'VQ.C FAIL: policy provisioning_failures_admin_all not found';
  END IF;
  IF v_qual NOT LIKE '%get_my_role%admin%' THEN
    RAISE EXCEPTION 'VQ.C FAIL: policy qual should reference get_my_role() = admin, found: %', v_qual;
  END IF;
  IF v_check NOT LIKE '%get_my_role%admin%' THEN
    RAISE EXCEPTION 'VQ.C FAIL: policy with_check should reference get_my_role() = admin, found: %', v_check;
  END IF;
END $vqc$;

-- ── VQ.D — Indexes present (PK + 2 partial indexes) ────────────────────
DO $vqd$
DECLARE
  v_pk_count      INT;
  v_unresolved_ct INT;
  v_session_ct    INT;
BEGIN
  SELECT COUNT(*) INTO v_pk_count
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'provisioning_failures'
    AND indexdef ILIKE '%pkey%';
  IF v_pk_count <> 1 THEN
    RAISE EXCEPTION 'VQ.D FAIL: expected 1 PRIMARY KEY index, found %', v_pk_count;
  END IF;

  SELECT COUNT(*) INTO v_unresolved_ct
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'provisioning_failures'
    AND indexname = 'idx_provisioning_failures_unresolved'
    AND indexdef ILIKE '%WHERE (resolved = false)%';
  IF v_unresolved_ct <> 1 THEN
    RAISE EXCEPTION 'VQ.D FAIL: idx_provisioning_failures_unresolved not present as partial WHERE resolved=false';
  END IF;

  SELECT COUNT(*) INTO v_session_ct
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'provisioning_failures'
    AND indexname = 'idx_provisioning_failures_session'
    AND indexdef ILIKE '%WHERE (stripe_session_id IS NOT NULL)%';
  IF v_session_ct <> 1 THEN
    RAISE EXCEPTION 'VQ.D FAIL: idx_provisioning_failures_session not present as partial WHERE stripe_session_id IS NOT NULL';
  END IF;
END $vqd$;

-- ── VQ.E — SCHEMA_ audit row present ───────────────────────────────────
DO $vqe$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_PROVISIONING_FAILURES_TABLE'
    AND user_email = 'system_migration_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.E FAIL: no SCHEMA_PROVISIONING_FAILURES_TABLE audit row found';
  END IF;
END $vqe$;

-- ── VQ.F — Anon grants absent (table + sequence) ───────────────────────
-- Uses direct privilege predicates rather than
-- information_schema.role_usage_grants — the latter is a weak signal
-- for sequence USAGE and misses grants under some Supabase configs.
-- has_table_privilege / has_sequence_privilege are the authoritative
-- source (per Mateo 2026-07-21 review).
DO $vqf$
BEGIN
  IF has_table_privilege('anon', 'public.provisioning_failures', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.F FAIL: anon has SELECT on provisioning_failures';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.F FAIL: anon has INSERT on provisioning_failures';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.F FAIL: anon has UPDATE on provisioning_failures';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.F FAIL: anon has DELETE on provisioning_failures';
  END IF;
  IF has_sequence_privilege('anon', 'public.provisioning_failures_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.F FAIL: anon has USAGE on provisioning_failures_id_seq';
  END IF;
END $vqf$;

-- ── All green ──────────────────────────────────────────────────────────
-- If this file completed without error, VQ.A–F all passed. Commit B
-- (the code half) is safe to deploy.
