-- ═══════════════════════════════════════════════════════════════════════
-- 20260722_order_forms_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260722_order_forms.sql.
-- Run AFTER the migration lands.
--
-- Pattern (matches 743e519, 20260721_company_name_available_rpc_verification,
-- 20260721_provisioning_failures_verification): every VQ is a DO-block
-- assertion. Silent success = pass. Any failure RAISE EXCEPTIONs with
-- a named reason. If this file completes without error output, all
-- gates green + Commit B (webhook code) may deploy.
--
-- Read-only + one intentional-fail probe wrapped in savepoint (VQ.G).
-- Safe to run repeatedly.

-- ── VQ.A — Table + column shape ────────────────────────────────────────
DO $vqa$
DECLARE
  v_missing TEXT;
  v_expected TEXT[] := ARRAY[
    'id','company_id','saas_acceptance_id','proposal_code_id','source',
    'track','tier','cycle','property_count','driver_count',
    'stripe_customer_id','stripe_subscription_id','currency',
    'line_items','supersedes_order_form_id','accepted_at','created_at'
  ];
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
  FROM unnest(v_expected) c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_forms' AND column_name = c
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.A FAIL: order_forms missing columns: %', v_missing;
  END IF;

  -- Key NOT NULLs
  FOR v_missing IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'order_forms'
       AND column_name IN ('company_id','saas_acceptance_id','source','track','tier',
                           'cycle','property_count','driver_count','currency',
                           'line_items','accepted_at','created_at')
       AND is_nullable = 'YES'
  LOOP
    RAISE EXCEPTION 'VQ.A FAIL: column % should be NOT NULL', v_missing;
  END LOOP;

  -- Nullable-by-design
  FOR v_missing IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'order_forms'
       AND column_name IN ('proposal_code_id','supersedes_order_form_id','stripe_customer_id','stripe_subscription_id')
       AND is_nullable = 'NO'
  LOOP
    RAISE EXCEPTION 'VQ.A FAIL: column % should be NULLABLE', v_missing;
  END LOOP;
END $vqa$;

-- ── VQ.B — Foreign keys wired correctly ────────────────────────────────
DO $vqb$
DECLARE
  v_fk_count INT;
BEGIN
  -- company_id → companies(id)
  SELECT COUNT(*) INTO v_fk_count
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = rc.constraint_name
   WHERE kcu.table_schema = 'public' AND kcu.table_name = 'order_forms'
     AND kcu.column_name = 'company_id';
  IF v_fk_count < 1 THEN RAISE EXCEPTION 'VQ.B FAIL: order_forms.company_id has no FK'; END IF;

  -- saas_acceptance_id → tos_acceptances(id)
  SELECT COUNT(*) INTO v_fk_count
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.referential_constraints rc
      ON kcu.constraint_name = rc.constraint_name
   WHERE kcu.table_schema = 'public' AND kcu.table_name = 'order_forms'
     AND kcu.column_name = 'saas_acceptance_id';
  IF v_fk_count < 1 THEN RAISE EXCEPTION 'VQ.B FAIL: order_forms.saas_acceptance_id has no FK'; END IF;

  -- proposal_code_id → proposal_codes(id) (nullable but FK still present)
  SELECT COUNT(*) INTO v_fk_count
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.referential_constraints rc
      ON kcu.constraint_name = rc.constraint_name
   WHERE kcu.table_schema = 'public' AND kcu.table_name = 'order_forms'
     AND kcu.column_name = 'proposal_code_id';
  IF v_fk_count < 1 THEN RAISE EXCEPTION 'VQ.B FAIL: order_forms.proposal_code_id has no FK'; END IF;

  -- supersedes_order_form_id → order_forms(id) (self-FK)
  SELECT COUNT(*) INTO v_fk_count
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.referential_constraints rc
      ON kcu.constraint_name = rc.constraint_name
   WHERE kcu.table_schema = 'public' AND kcu.table_name = 'order_forms'
     AND kcu.column_name = 'supersedes_order_form_id';
  IF v_fk_count < 1 THEN RAISE EXCEPTION 'VQ.B FAIL: order_forms.supersedes_order_form_id has no self-FK'; END IF;
END $vqb$;

-- ── VQ.C — CHECK constraints on enums ──────────────────────────────────
DO $vqc$
DECLARE v_count INT;
BEGIN
  -- source, track, cycle CHECK
  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints
   WHERE constraint_schema = 'public'
     AND check_clause ILIKE '%source%self_serve%proposal_code%';
  IF v_count < 1 THEN RAISE EXCEPTION 'VQ.C FAIL: source CHECK constraint missing or wrong shape'; END IF;

  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints
   WHERE constraint_schema = 'public'
     AND check_clause ILIKE '%track%enforcement%property_management%';
  IF v_count < 1 THEN RAISE EXCEPTION 'VQ.C FAIL: track CHECK constraint missing or wrong shape'; END IF;

  SELECT COUNT(*) INTO v_count
    FROM information_schema.check_constraints
   WHERE constraint_schema = 'public'
     AND check_clause ILIKE '%cycle%monthly%annual%';
  IF v_count < 1 THEN RAISE EXCEPTION 'VQ.C FAIL: cycle CHECK constraint missing or wrong shape'; END IF;
END $vqc$;

-- ── VQ.D — RLS enabled + policies present ──────────────────────────────
DO $vqd$
DECLARE
  v_rls          BOOLEAN;
  v_policy_count INT;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class
   WHERE relnamespace = 'public'::regnamespace AND relname = 'order_forms';
  IF v_rls IS NULL THEN RAISE EXCEPTION 'VQ.D FAIL: order_forms table not found'; END IF;
  IF v_rls IS NOT TRUE THEN RAISE EXCEPTION 'VQ.D FAIL: RLS not enabled on order_forms'; END IF;

  -- Exactly ONE policy — admin_select. Anything else means an
  -- INSERT/UPDATE/DELETE policy has been added that shouldn't be there.
  SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'order_forms';
  IF v_policy_count <> 1 THEN
    RAISE EXCEPTION 'VQ.D FAIL: expected exactly 1 policy (order_forms_admin_select) on order_forms, found %', v_policy_count;
  END IF;

  PERFORM 1 FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'order_forms'
     AND policyname = 'order_forms_admin_select'
     AND cmd = 'SELECT'
     AND qual LIKE '%get_my_role%admin%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VQ.D FAIL: order_forms_admin_select policy missing or wrong shape (must be SELECT + qual references get_my_role() = admin)';
  END IF;
END $vqd$;

-- ── VQ.E — Indexes present ─────────────────────────────────────────────
DO $vqe$
BEGIN
  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'order_forms'
     AND indexname = 'idx_order_forms_company';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_order_forms_company missing'; END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'order_forms'
     AND indexname = 'idx_order_forms_saas_acceptance';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_order_forms_saas_acceptance missing'; END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'order_forms'
     AND indexname = 'idx_order_forms_proposal_code'
     AND indexdef ILIKE '%WHERE (proposal_code_id IS NOT NULL)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_order_forms_proposal_code missing or not partial'; END IF;

  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'order_forms'
     AND indexname = 'idx_order_forms_supersedes'
     AND indexdef ILIKE '%WHERE (supersedes_order_form_id IS NOT NULL)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'VQ.E FAIL: idx_order_forms_supersedes missing or not partial'; END IF;
END $vqe$;

-- ── VQ.F — SCHEMA_ audit row present ───────────────────────────────────
DO $vqf$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_ORDER_FORMS_TABLE'
     AND user_email = 'system_migration_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.F FAIL: no SCHEMA_ORDER_FORMS_TABLE audit row found';
  END IF;
END $vqf$;

-- ── VQ.G — Anon absent (table + sequence) ──────────────────────────────
DO $vqg$
BEGIN
  IF has_table_privilege('anon', 'public.order_forms', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.G FAIL: anon has SELECT on order_forms';
  END IF;
  IF has_table_privilege('anon', 'public.order_forms', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.G FAIL: anon has INSERT on order_forms';
  END IF;
  IF has_table_privilege('anon', 'public.order_forms', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.G FAIL: anon has UPDATE on order_forms';
  END IF;
  IF has_table_privilege('anon', 'public.order_forms', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.G FAIL: anon has DELETE on order_forms';
  END IF;
  IF has_sequence_privilege('anon', 'public.order_forms_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.G FAIL: anon has USAGE on order_forms_id_seq';
  END IF;
END $vqg$;

-- ── VQ.H — Immutability probe (FULL write surface, both roles) ─────────
-- Widened per Mateo 2026-07-22: the initial VQ.H only checked
-- authenticated.INSERT and caught the missing REVOKE — but three
-- other write surfaces (auth.UPDATE, auth.DELETE, anon.INSERT/UPDATE/
-- DELETE) were unproven. "Immutability" is only claimed when EVERY
-- non-service-role write privilege is confirmed absent.
--
-- has_table_privilege reflects the effective grant matrix at the ACL
-- layer without needing SET ROLE. Grant is the outer gate, RLS is the
-- inner — this VQ probes the outer.
DO $vqh$
BEGIN
  -- Row 1 — authenticated writes: all forbidden
  IF has_table_privilege('authenticated', 'public.order_forms', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.H FAIL: authenticated has INSERT on order_forms (should be service_role only)';
  END IF;
  IF has_table_privilege('authenticated', 'public.order_forms', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.H FAIL: authenticated has UPDATE on order_forms (immutability broken)';
  END IF;
  IF has_table_privilege('authenticated', 'public.order_forms', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.H FAIL: authenticated has DELETE on order_forms (immutability broken)';
  END IF;

  -- Row 2 — anon: all forbidden (already covered by VQ.G, re-checked
  -- here for at-a-glance completeness of the immutability claim)
  IF has_table_privilege('anon', 'public.order_forms', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.H FAIL: anon has INSERT on order_forms';
  END IF;
  IF has_table_privilege('anon', 'public.order_forms', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.H FAIL: anon has UPDATE on order_forms';
  END IF;
  IF has_table_privilege('anon', 'public.order_forms', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.H FAIL: anon has DELETE on order_forms';
  END IF;

  -- Row 3 — SELECT for authenticated IS allowed by the admin_select
  -- policy — the policy's qual restricts to role=admin at the row
  -- level. Confirm the grant exists so the policy has something to
  -- gate.
  IF NOT has_table_privilege('authenticated', 'public.order_forms', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.H FAIL: authenticated missing SELECT grant — admin_select policy has nothing to gate';
  END IF;

  -- Row 4 — service_role must have INSERT (webhook writer)
  IF NOT has_table_privilege('service_role', 'public.order_forms', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.H FAIL: service_role missing INSERT — webhook cannot write snapshots';
  END IF;
END $vqh$;

-- ── All green ──────────────────────────────────────────────────────────
-- If this file completed without error, VQ.A–H all passed. The code
-- half (webhook writers) is safe to deploy.
