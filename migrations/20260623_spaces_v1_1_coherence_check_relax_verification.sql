-- Spaces v1.1 hotfix — verification for spaces_assignment_coherence relax.
--
-- RUN ORDER:
--   1. Section B BEFORE applying the migration (zero rows must violate new
--      CHECK on current data — if non-zero, abort and investigate first).
--   2. Apply 20260623_spaces_v1_1_coherence_check_relax.sql
--   3. Run Sections A, C, D, E AFTER applying.
--
-- LOAD-BEARING SECTIONS (do not skip before declaring "applied and verified"):
--   - Section D: reproduces the exact UAT failure path on a throwaway test
--     row — proves the 1→2 transition now succeeds AND that the SQL test
--     row is cleaned up.
--   - Section E: data-invariant sweep — proves zero spaces are in the
--     "assigned + zero ties" incoherent state that the OLD CHECK was
--     supposedly guarding against. If this returns rows, the RPC/trigger
--     atomicity guarantee is broken somewhere.

-- ════════════════════════════════════════════════════════════════════
-- A. Confirm constraint definition matches the relaxed form
-- ════════════════════════════════════════════════════════════════════

SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.spaces'::regclass
   AND conname = 'spaces_assignment_coherence';
-- Expected: exactly 1 row.
--   definition = 'CHECK ((assigned_to_resident_email IS NULL OR status = ''assigned''::text))'
--   (Postgres re-emits with type cast + double-single-quote literal escaping.)


-- ════════════════════════════════════════════════════════════════════
-- B. PRE-APPLY GATE — zero existing rows can violate the NEW constraint
-- ════════════════════════════════════════════════════════════════════
-- Run this BEFORE applying the migration. If any rows return, the new
-- constraint would fail to add and roll back the txn — but worse, it
-- means there's pre-existing data drift that needs explanation first.

SELECT id, status, assigned_to_resident_email
  FROM public.spaces
 WHERE assigned_to_resident_email IS NOT NULL
   AND status != 'assigned';
-- Expected: 0 rows. If non-zero, INVESTIGATE before applying.


-- ════════════════════════════════════════════════════════════════════
-- C. Negative test — incoherent state still rejected
-- ════════════════════════════════════════════════════════════════════
-- Try to put a populated email on an 'available' space. Should be
-- rejected by the new CHECK. Run this after applying.

DO $$
DECLARE
  v_test_id BIGINT;
  v_caught  BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_test_id
    FROM public.spaces
   WHERE status = 'available'
     AND assigned_to_resident_email IS NULL
   LIMIT 1;

  IF v_test_id IS NULL THEN
    RAISE NOTICE 'SKIP — no available+empty spaces to test against (test inconclusive)';
    RETURN;
  END IF;

  BEGIN
    UPDATE public.spaces
       SET assigned_to_resident_email = 'drift_test@example.com'
     WHERE id = v_test_id;
    -- If we reach here, the constraint failed to reject. ROLLBACK then warn.
    UPDATE public.spaces
       SET assigned_to_resident_email = NULL
     WHERE id = v_test_id;
    RAISE WARNING 'FAIL — incoherent (available + email populated) state was ALLOWED';
  EXCEPTION WHEN check_violation THEN
    v_caught := TRUE;
    RAISE NOTICE 'PASS — incoherent state correctly rejected by new CHECK';
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'verification_C_failed';
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — reproduce the UAT failure path on a throwaway row
-- ════════════════════════════════════════════════════════════════════
-- The exact transition that failed in production: a row in
-- status='assigned' with a populated email transitions to email=NULL
-- while status stays 'assigned' (the dual-write rule for set-size 1→2).
-- Must succeed with the relaxed CHECK.
--
-- Uses a throwaway company/property/label to isolate from real data.
-- Cleans up unconditionally (in the EXCEPTION block too).

DO $$
DECLARE
  v_test_id BIGINT;
  v_caught  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.spaces (
    company, property, label, type, status,
    assigned_to_resident_email, is_active
  ) VALUES (
    '__coherence_check_test_company__',
    '__coherence_check_test_property__',
    '__coherence_check_test_label__',
    'regular',
    'assigned',
    'pre_transition@example.com',
    TRUE
  ) RETURNING id INTO v_test_id;

  BEGIN
    -- The exact UAT-failing transition: status stays 'assigned', email→NULL.
    UPDATE public.spaces
       SET assigned_to_resident_email = NULL
     WHERE id = v_test_id;
    RAISE NOTICE 'PASS — 1→2 transition (status=assigned, email=NULL) now succeeds';
  EXCEPTION WHEN check_violation THEN
    v_caught := TRUE;
    RAISE WARNING 'FAIL — CHECK still rejects the multi-resident state';
  END;

  -- Cleanup unconditionally (whether the transition succeeded or not).
  DELETE FROM public.spaces WHERE id = v_test_id;

  IF v_caught THEN
    RAISE EXCEPTION 'verification_D_failed';
  END IF;
END $$;

-- Sanity that the cleanup landed (no test row should remain in the DB).
SELECT COUNT(*) AS leaked_test_rows
  FROM public.spaces
 WHERE company = '__coherence_check_test_company__';
-- Expected: 0


-- ════════════════════════════════════════════════════════════════════
-- E. ★ LOAD-BEARING — RPC/trigger atomicity invariant ("assigned ⇒ ≥1 tie")
-- ════════════════════════════════════════════════════════════════════
-- The half-coherence the OLD CHECK approximated via the legacy column has
-- moved to RPC/trigger transaction discipline. This sweep verifies the
-- guarantee actually holds against current data: any space in
-- status='assigned' must have at least one row in space_residents.
--
-- If this returns rows, one of:
--   (a) An RPC's atomicity is broken (it flipped status without inserting
--       a tie OR deleted the last tie without flipping status — bug)
--   (b) Someone bypassed the RPCs via direct UPDATE (RLS/admin path)
--   (c) Pre-v1.1 data drift never cleaned up
-- All three are worth investigating regardless.

SELECT s.id, s.property, s.label, s.status, s.assigned_to_resident_email
  FROM public.spaces s
 WHERE s.status = 'assigned'
   AND NOT EXISTS (
     SELECT 1 FROM public.space_residents sr WHERE sr.space_id = s.id
   );
-- Expected: 0 rows.


-- ════════════════════════════════════════════════════════════════════
-- F. Audit-log confirmation that the migration recorded itself
-- ════════════════════════════════════════════════════════════════════

SELECT created_at, action, new_values
  FROM public.audit_logs
 WHERE action = 'SCHEMA_CONSTRAINT_RELAX'
   AND new_values->>'migration' = '20260623_spaces_v1_1_coherence_check_relax'
 ORDER BY created_at DESC
 LIMIT 1;
-- Expected: exactly 1 row, recent created_at, new_values includes
-- old_definition + new_definition + coherence_guard.
