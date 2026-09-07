-- ══════════════════════════════════════════════════════════════════════
-- 20260907_retire_proposal_pdfs_verification.sql
--
-- Structural verification for the proposal-pdfs full retirement. v2
-- pattern (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
-- 6 gates.
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  company_admin_read_redeemed_proposal_pdf policy REMOVED
--   VS2  admin_all_proposal_pdfs policy REMOVED
--   VS3  proposal-pdfs bucket REMOVED
--   VS4  No storage.objects rows for bucket_id='proposal-pdfs'
--   VS5  proposal_codes.pdf_url column STILL EXISTS in schema (inert
--        schema kept per Mateo Sep 7 discipline: retire access surfaces,
--        leave inert schema alone)
--   VS6  audit row present
--
-- Post-apply expected polcount on storage.objects drops from 9 to 7
-- (9 = 11 minus 1 SELECT wildcard dropped 801cc52; minus 2 here = 7).
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: CA SELECT policy removed ══════════════════════════════════
DO $vs1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'company_admin_read_redeemed_proposal_pdf';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: company_admin_read_redeemed_proposal_pdf still exists (count=%)', v_count;
  END IF;
END $vs1$;


-- ── VS2: admin FOR ALL policy removed ═════════════════════════════
DO $vs2$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'admin_all_proposal_pdfs';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS2 FAIL: admin_all_proposal_pdfs still exists (count=%)', v_count;
  END IF;
END $vs2$;


-- ── VS3: bucket removed ═════════════════════════════════════════════
DO $vs3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM storage.buckets
   WHERE id = 'proposal-pdfs';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: bucket proposal-pdfs still exists (count=%)', v_count;
  END IF;
END $vs3$;


-- ── VS4: no orphan objects for the dropped bucket ══════════════════
DO $vs4$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM storage.objects
   WHERE bucket_id = 'proposal-pdfs';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS4 FAIL: storage.objects rows for dropped bucket still exist (count=%). Cascade or explicit delete failed.', v_count;
  END IF;
END $vs4$;


-- ── VS5: proposal_codes.pdf_url column KEPT (inert schema) ════════
-- Per Mateo Sep 7: "retire access surfaces aggressively, leave inert
-- schema alone." A NULL column grants nothing; dropping a column has
-- more blast radius than keeping one.
DO $vs5$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'proposal_codes'
     AND column_name = 'pdf_url';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: proposal_codes.pdf_url column should still exist (count=%). Retirement scope should NOT have dropped it.', v_count;
  END IF;
END $vs5$;


-- ── VS6: audit row present ═════════════════════════════════════════
DO $vs6$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_RETIRE_PROPOSAL_PDFS'
     AND new_values ->> 'migration' = '20260907_retire_proposal_pdfs';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS6 FAIL: audit row missing';
  END IF;
END $vs6$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'proposal-pdfs full retirement'::TEXT AS target,
  ARRAY[
    'VS1  company_admin_read_redeemed_proposal_pdf policy removed',
    'VS2  admin_all_proposal_pdfs policy removed',
    'VS3  proposal-pdfs bucket removed',
    'VS4  no storage.objects rows for the dropped bucket',
    'VS5  proposal_codes.pdf_url column KEPT (inert schema, per discipline)',
    'VS6  SCHEMA_RETIRE_PROPOSAL_PDFS audit row present'
  ] AS gates_verified,
  now() AS verified_at;
