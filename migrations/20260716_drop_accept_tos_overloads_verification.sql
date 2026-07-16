-- ════════════════════════════════════════════════════════════════════
-- Verification — 20260716_drop_accept_tos_overloads
-- 2026-07-16
-- ════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════
-- VQ.A — both accept_tos overloads absent
-- ══════════════════════════════════════════════════════════════════
DO $vqa$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_tos';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VQ.A FAIL: accept_tos still has % overload(s) after drop', v_count;
  END IF;
  RAISE NOTICE 'VQ.A PASS: accept_tos absent (0 overloads)';
END $vqa$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.B — accept_saas_agreement STAYS (deferral proof — negative check)
-- The drop migration deliberately preserves this sibling RPC. VQ
-- confirms it's still present so nothing accidentally took it out
-- as a copy-paste-adjacent casualty.
-- ══════════════════════════════════════════════════════════════════
DO $vqb$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_saas_agreement';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.B FAIL: accept_saas_agreement missing — should have stayed (see 20260716_drop_accept_tos_overloads header)';
  END IF;
  RAISE NOTICE 'VQ.B PASS: accept_saas_agreement still present (deferral honored)';
END $vqb$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.C — accept_all_pending_consents (the hard-gate replacement) STILL
-- present (didn't accidentally drop the replacement)
-- ══════════════════════════════════════════════════════════════════
DO $vqc$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_all_pending_consents';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.C FAIL: accept_all_pending_consents expected 1 overload, found % — the hard-gate RPC MUST survive this drop', v_count;
  END IF;
  RAISE NOTICE 'VQ.C PASS: accept_all_pending_consents intact (hard-gate RPC survived)';
END $vqc$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.D — SCHEMA_ audit row landed with deferral breadcrumb
-- ══════════════════════════════════════════════════════════════════
DO $vqd$
DECLARE
  v_count INT;
  v_defer TEXT;
BEGIN
  SELECT COUNT(*), MAX(new_values->>'deferral_breadcrumb')
    INTO v_count, v_defer
    FROM public.audit_logs
   WHERE action = 'SCHEMA_ACCEPT_TOS_RETIRED'
     AND new_values->>'migration' = '20260716_drop_accept_tos_overloads';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.D FAIL: SCHEMA_ audit row missing';
  END IF;
  IF v_defer IS NULL OR position('accept_saas_agreement' in v_defer) = 0 THEN
    RAISE EXCEPTION 'VQ.D FAIL: audit row missing accept_saas_agreement deferral breadcrumb';
  END IF;
  RAISE NOTICE 'VQ.D PASS: SCHEMA_ audit row present with deferral breadcrumb';
END $vqd$;

-- Silent success = all gates green.
