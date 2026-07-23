-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_park_revoke_writes.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT-PARK — revoke population vectors on public.do_not_tow_plates.
--
-- ── Applied by hand first; this file is the RECORD ────────────────────
-- Jose ran the REVOKE by hand on 2026-07-23 (grants moved from
-- INSERT/SELECT/UPDATE → SELECT only). He subsequently ran the full
-- block below. This file captures the applied state so a future rebuild
-- or rollback recovery has a canonical source. All three statements are
-- idempotent (REVOKE + COMMENT are always safe to re-run; the audit
-- insert is NOT EXISTS-guarded) so re-applying is safe.
--
-- ── Purpose ────────────────────────────────────────────────────────────
-- Turn *incidentally empty* into *provably unpopulatable*. The three tow
-- guards (set_violation_status, stamp_tow_ticket, regenerate_tow_ticket)
-- are LIVE code on the enforcement path and inert only because
-- do_not_tow_plates has zero rows. No UI exists; nothing populates the
-- table. But nothing PREVENTED population either — one direct INSERT
-- would silently activate absolute tow refusal on a live customer months
-- from now, with nobody remembering the mechanism exists.
--
-- REVOKE INSERT, UPDATE removes the two population vectors from
-- `authenticated`. SELECT is retained: harmless on an empty table,
-- preserves B1's read policies as verified controls, and means an
-- unpark restores two privileges rather than three. service_role is
-- unchanged (probes + future unpark).
--
-- ── Verification ───────────────────────────────────────────────────────
-- B1's VQ.4 is extended to cover the parked invariant:
--   authenticated must hold NO DELETE, NO INSERT, NO UPDATE.
-- See migrations/20260723_dnt_b1_policy_scope_fix_verification.sql VQ.4.
--
-- The natural negative control (VQ.4 fires FAIL when INSERT+UPDATE
-- grants exist) was consumed by the manual apply — grants were removed
-- before the extended VQ.4 shipped. Substitute control used in ship
-- report:
--   SELECT has_table_privilege('authenticated','public.violations','INSERT')
--     → true (confirms has_table_privilege returns true when grant
--            exists; extended VQ.4 predicate is not structurally inert).
--
-- ── Reversal (do NOT run without an explicit decision) ─────────────────
--   GRANT INSERT, UPDATE ON public.do_not_tow_plates TO authenticated;
-- Restoring INSERT/UPDATE reactivates the capability. do_not_tow_plates
-- implements absolute tow refusal with no override — see COMMENT ON
-- TABLE below.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Revoke population vectors from authenticated
-- ══════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE ON public.do_not_tow_plates FROM authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — Persistent inline documentation
-- ══════════════════════════════════════════════════════════════════════
-- Survives pg_dump; visible in psql \d+. Whoever finds this table next
-- knows what they'd be switching on.
COMMENT ON TABLE public.do_not_tow_plates IS
  'PARKED — DNT capability implements absolute tow refusal with no override. '
  'No UI by design; unowned pending a decision on whether the capability is '
  'wanted. Tow guards in set_violation_status, stamp_tow_ticket, and '
  'regenerate_tow_ticket are live and inert only because this table is empty. '
  'INSERT/UPDATE revoked from authenticated 2026-07-23; service_role retains '
  'full access for probes and any future unpark. Do not re-grant '
  'INSERT/UPDATE without an explicit decision — reactivates the capability.';

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — SCHEMA_ audit (NOT EXISTS-guarded, safe to re-run)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_DNT_PARK_REVOKE_WRITES',
  'do_not_tow_plates',
  NULL,
  jsonb_build_object(
    'migration', '20260723_dnt_park_revoke_writes',
    'purpose',   'Turn incidentally-empty into provably-unpopulatable. Enforces the parked state as a verified invariant rather than a remembered assumption.',
    'revoked',   ARRAY['INSERT','UPDATE'],
    'retained',  ARRAY['SELECT (authenticated, harmless on empty table + preserves B1 read policies)'],
    'service_role', 'unchanged (probes + future unpark)',
    'reversal',  'GRANT INSERT, UPDATE ON public.do_not_tow_plates TO authenticated',
    'applied_by_hand_first', 'true — Jose ran REVOKE 2026-07-23 pre-file; this migration is the record',
    'natural_negative_control', 'consumed by manual apply — INSERT/UPDATE grants already gone before extended VQ.4 shipped',
    'substitute_negative_control', 'has_table_privilege(authenticated, public.violations, INSERT) = true (confirms predicate is not structurally inert)',
    'verification', 'B1 VQ.4 extended to assert no DELETE + no INSERT + no UPDATE grants on authenticated'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_DNT_PARK_REVOKE_WRITES'
     AND new_values->>'migration' = '20260723_dnt_park_revoke_writes'
);

COMMIT;
