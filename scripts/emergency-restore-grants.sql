-- ═══════════════════════════════════════════════════════════════════════
-- emergency-restore-grants.sql
-- ═══════════════════════════════════════════════════════════════════════
-- PASTE-READY EMERGENCY RESTORE
-- Only run if a POST-COMMIT smoke fails after
-- 20260722_grant_remediation_deny_by_default.sql.
--
-- ── WHEN TO USE ────────────────────────────────────────────────────────
-- The migration is atomic (BEGIN/COMMIT). Any failure INSIDE the txn
-- rolls back automatically — no restore needed.
--
-- This script exists for the ONE dangerous case: migration commits
-- successfully (VQ.GRANTS all pass), but a POST-COMMIT smoke fails —
-- a function misbehaves under the new grant state, an anon surface
-- 500s, a trigger silently fails, an authenticated portal returns
-- nothing.
--
-- ── WHAT IT DOES ───────────────────────────────────────────────────────
-- Restores the over-permissive PRE-migration state instantly.
-- NOT the target end state — a stopgap. Restores A1-live anon
-- surfaces + all authenticated portals in seconds while you diagnose.
--
-- After running this: identify which smoke failed, fix the gap in a
-- follow-up migration (add the missing grant, correct the signature,
-- etc.), then re-run the deny-by-default migration.
--
-- ── OPERATOR DISCIPLINE ────────────────────────────────────────────────
-- Keep this SQL open in a second editor tab BEFORE running the
-- deny-by-default migration. Do not type it live — paste-ready
-- verbatim. Seconds count.

BEGIN;

  -- Broad re-grant matching Supabase's default schema-wide GRANT ALL.
  GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;

  -- Restore default privileges too so newly-created tables auto-grant
  -- back (matches the pre-migration Supabase default).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

  -- Audit-log the emergency restore so we have a forensic record.
  -- FILL IN THE REASON before executing — a short description of what
  -- smoke failed and any signal about why.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    'system_migration_v1',
    'SCHEMA_GRANT_REMEDIATION_EMERGENCY_RESTORE',
    'schema',
    NULL,
    jsonb_build_object(
      'triggering_migration', '20260722_grant_remediation_deny_by_default',
      'reason',               '<FILL IN: which smoke failed + any diagnostic signal>',
      'restored_at',          now()
    ),
    now()
  );

COMMIT;

-- ── AFTER RUNNING ──────────────────────────────────────────────────────
-- 1. Verify A1-live surfaces recover — visitor form loads, plate lookup
--    works, tow link resolves, authenticated portals load.
-- 2. Read the audit_logs entry above to confirm restore recorded.
-- 3. Investigate: which smoke failed? Was it a missing grant? A wrong
--    function signature? A trigger that needed a different owner?
-- 4. File a follow-up migration adding the missing piece.
-- 5. Re-run 20260722_grant_remediation_deny_by_default.sql after fix.
