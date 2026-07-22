-- ═══════════════════════════════════════════════════════════════════════
-- 20260722_provisioning_failures_grants_hardening_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Companion verification for 20260722_provisioning_failures_grants_hardening.sql.
--
-- This is the WIDENED VQ that adfc6e1's VQ.F should have been. Kept
-- as a separate file (not a modification of the original verification)
-- because adfc6e1 is already-committed history. Run this file INSTEAD
-- of adfc6e1's VQ.F for the write-surface completeness check.
--
-- Pattern: DO-block assertions. Silent = pass.

-- ── VQ.HARDENING — full write surface on provisioning_failures ────────
-- Six write privileges must be absent (auth I/U/D + anon I/U/D), and
-- two must be present (auth SELECT for admin_all policy; service_role
-- INSERT for webhook writes). Same shape as order_forms VQ.H.
DO $vqph$
BEGIN
  -- Row 1 — authenticated writes: all forbidden
  IF has_table_privilege('authenticated', 'public.provisioning_failures', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: authenticated has INSERT on provisioning_failures (should be service_role only)';
  END IF;
  IF has_table_privilege('authenticated', 'public.provisioning_failures', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: authenticated has UPDATE on provisioning_failures (admin resolve should go via future DEFINER RPC)';
  END IF;
  IF has_table_privilege('authenticated', 'public.provisioning_failures', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: authenticated has DELETE on provisioning_failures (rows are legal record; never delete)';
  END IF;

  -- Row 2 — anon: all forbidden (already covered by adfc6e1 VQ.F but
  -- re-checked here for completeness of the write-surface claim)
  IF has_table_privilege('anon', 'public.provisioning_failures', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: anon has SELECT on provisioning_failures (PII exposure)';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: anon has INSERT on provisioning_failures';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: anon has UPDATE on provisioning_failures';
  END IF;
  IF has_table_privilege('anon', 'public.provisioning_failures', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: anon has DELETE on provisioning_failures';
  END IF;

  -- Row 3 — anon sequence USAGE forbidden
  IF has_sequence_privilege('anon', 'public.provisioning_failures_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: anon has USAGE on provisioning_failures_id_seq';
  END IF;
  IF has_sequence_privilege('authenticated', 'public.provisioning_failures_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: authenticated has USAGE on provisioning_failures_id_seq (writes are service_role only)';
  END IF;

  -- Row 4 — SELECT for authenticated IS allowed by the admin_all
  -- policy — the policy's qual restricts to role=admin at the row
  -- level. Confirm the grant exists so the policy has something to
  -- gate.
  IF NOT has_table_privilege('authenticated', 'public.provisioning_failures', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: authenticated missing SELECT grant — admin_all policy has nothing to gate';
  END IF;

  -- Row 5 — service_role must have INSERT (webhook writer path)
  IF NOT has_table_privilege('service_role', 'public.provisioning_failures', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: service_role missing INSERT — webhook cannot log failures';
  END IF;
END $vqph$;

-- ── Audit row present ──────────────────────────────────────────────────
DO $vqph_audit$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PROVISIONING_FAILURES_GRANTS_HARDENING'
     AND user_email = 'system_migration_v1';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.HARDENING FAIL: no SCHEMA_PROVISIONING_FAILURES_GRANTS_HARDENING audit row found';
  END IF;
END $vqph_audit$;

-- ── All green ──────────────────────────────────────────────────────────
-- Silent completion = provisioning_failures write surface fully closed
-- to authenticated + anon; SELECT grants intact for RLS policies to
-- gate; service_role writes unaffected.
