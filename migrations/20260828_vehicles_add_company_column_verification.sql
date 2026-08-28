-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_add_company_column_verification.sql
--
-- Post-apply verification for 20260828_vehicles_add_company_column.
-- v2 pattern (feedback_verification_returns_rows_no_transaction):
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with status='PASS' on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 5 Postgres-side gates (this file) + 1 PostgREST gate (separate script):
--   G1 column exists on public.vehicles
--   G2 data type is TEXT
--   G3 nullable (is_nullable='YES') — Commit 1 is nullable by design
--   G4 no column default — Commit 1 has no default by design
--   G5 schema audit row present (SCHEMA_VEHICLES_ADD_COMPANY_COLUMN)
--
-- 🔴 G6 (PostgREST) is NOT in this file — it can't be tested from SQL.
-- Run scripts/gate-vehicles-company-postgrest.ts AFTER this file passes
-- and BEFORE any Commit 2 writer push. The distinction between "Postgres
-- has the column" (this file's job) and "PostgREST returns it via REST"
-- (the script's job) is the exact structural-vs-execution split flagged
-- for RPCs in feedback_rpc_verification_must_include_execution_gate.md.
-- Same class, different subsystem.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_data_type      TEXT;
  v_is_nullable    TEXT;
  v_column_default TEXT;
  v_audit_count    INT;
BEGIN
  -- ── G1 + G2 + G3 + G4 — column shape ─────────────────────────────
  SELECT data_type, is_nullable, column_default
    INTO v_data_type, v_is_nullable, v_column_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'vehicles'
     AND column_name  = 'company';

  IF v_data_type IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: public.vehicles.company column not found';
  END IF;
  IF v_data_type <> 'text' THEN
    RAISE EXCEPTION 'G2 FAIL: expected data_type=text; got %', v_data_type;
  END IF;
  IF v_is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'G3 FAIL: expected is_nullable=YES (Commit 1 is nullable by design; NOT NULL is Commit 4); got %', v_is_nullable;
  END IF;
  IF v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'G4 FAIL: expected no default (Commit 1 has no default by design); got %', v_column_default;
  END IF;

  -- ── G5 schema audit row ──────────────────────────────────────────
  SELECT COUNT(*)
    INTO v_audit_count
    FROM public.audit_logs
   WHERE action     = 'SCHEMA_VEHICLES_ADD_COMPANY_COLUMN'
     AND table_name = 'public.vehicles'
     AND record_id  = 'vehicles.company';

  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'G5 FAIL: schema audit row not found (count=%)', v_audit_count;
  END IF;

  RAISE NOTICE 'All 5 Postgres-side gates passed. G6 (PostgREST cache) MUST be run separately: `npx tsx scripts/gate-vehicles-company-postgrest.ts`';
END $$;

-- Terminal SELECT returns one PASS row (v2 pattern).
-- 🔴 note field flags the outstanding PostgREST gate. Do NOT push any
-- Commit 2 writer change until that gate returns pass.
SELECT
  'PASS'::TEXT                                              AS status,
  'vehicles.company (Commit 1 of 4)'::TEXT                  AS target,
  '5 Postgres-side gates: exists / TEXT / nullable / no-default / audit'::TEXT AS gates,
  '🔴 G6 PostgREST cache visibility gate is a SEPARATE script (scripts/gate-vehicles-company-postgrest.ts) — run before any Commit 2 writer push'::TEXT AS postgrest_gate_note,
  now()                                                     AS verified_at;
