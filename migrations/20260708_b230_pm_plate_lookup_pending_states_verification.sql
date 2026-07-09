-- ════════════════════════════════════════════════════════════════════
-- B230 Part A — Post-apply verification
-- Companion to 20260708_b230_pm_plate_lookup_pending_states.sql
-- ════════════════════════════════════════════════════════════════════

-- ── VQ.A — Single overload, SD, VOLATILE, expected signature
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS is_security_definer,
       p.provolatile                             AS volatility,
       (SELECT count(*) FROM pg_proc p2
        WHERE p2.proname = 'pm_plate_lookup'
          AND p2.pronamespace = n.oid)           AS overload_count
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
-- Expected 1 row:
--   proname             = pm_plate_lookup
--   args                = p_plate text
--   is_security_definer = true
--   volatility          = v  (VOLATILE — writes audit_logs)
--   overload_count      = 1


-- ── VQ.B — Grants preserved: authenticated only
SELECT array(
  SELECT grantee || '=' || privilege_type
  FROM information_schema.routine_privileges
  WHERE routine_name = 'pm_plate_lookup'
    AND routine_schema = 'public'
  ORDER BY grantee, privilege_type
) AS grants;
-- Expected: { 'authenticated=EXECUTE', 'postgres=EXECUTE' }
-- (anon + PUBLIC + service_role all revoked / never granted)


-- ── VQ.C — Audit row landed
SELECT action, new_values->>'migration' AS migration, new_values->>'rpc' AS rpc, created_at
FROM public.audit_logs
WHERE action = 'SCHEMA_RPC_UPDATED'
  AND new_values->>'migration' = '20260708_b230_pm_plate_lookup_pending_states'
ORDER BY created_at DESC LIMIT 1;
-- Expected 1 row.


-- ── VQ.D — Behavioral smoke (manual, run as a manager or leasing_agent):
--
-- Setup:
--   • A vehicle at the caller's property with is_active=FALSE, status='pending'.
--   • A vehicle_plate_changes row with status='pending', new_plate=<TEST_PLATE>,
--     property = caller's property.
--   • An unrelated vehicle at ANOTHER property (out-of-scope) with the
--     same plate — this is the scoping-guardrail check.
--
-- VQ.D.1 — Pending-permit plate returns 'pending' (not 'unauthorized'):
--   SELECT public.pm_plate_lookup('<PENDING_VEHICLE_PLATE>');
--   -- Expected: {"result_type": "pending", "unit_number": "<unit>", ...}
--
-- VQ.D.2 — Pending plate change returns 'plate_under_review':
--   SELECT public.pm_plate_lookup('<TEST_PLATE_new_plate>');
--   -- Expected: {"result_type": "plate_under_review", "unit_number": "<unit>", ...}
--
-- VQ.D.3 — Same plate at ANOTHER property → NOT returned (scoping):
--   Log in as a manager whose properties do NOT include the pending row's property.
--   SELECT public.pm_plate_lookup('<PENDING_VEHICLE_PLATE>');
--   -- Expected: {"result_type": "unauthorized", ...} — the pending row is
--   -- out-of-scope for this caller. Guardrail 1 confirmed.
--
-- VQ.D.4 — Regressions: existing states still work
--   • Approved plate → 'resident'
--   • Guest-authorized plate → 'guest_authorized' (B220 regression check)
--   • Visitor pass → 'visitor'
--   • Random plate → 'unauthorized'
--
-- VQ.D.5 — Audit rows land for every lookup (VOLATILE preserved):
--   SELECT count(*) FROM audit_logs
--   WHERE action = 'plate_lookup' AND created_at >= now() - interval '5 minutes';
--   -- Expected: count matches the number of lookups in VQ.D.1-4.


-- ── VQ.E — Rollback smoke (only if needed):
--   \i 20260628_pm_plate_lookup_volatile_fix.sql
-- Restores the 4-value cascade. Client consumers of the new
-- result_types silently degrade to 'unauthorized' rendering (pre-B230
-- behavior). No data cleanup needed.
