-- ═══════════════════════════════════════════════════════════════════════
-- 20260722_provisioning_failures_grants_hardening.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Additive hardening for provisioning_failures (shipped as adfc6e1
-- 2026-07-21). The original migration REVOKE'd anon but not
-- authenticated — leaving Supabase's default authenticated GRANT
-- INSERT/UPDATE/DELETE standing on a PII-carrying table
-- (raw_intended_tier holds customer company name + Stripe IDs).
--
-- Discovered 2026-07-22 when order_forms's widened VQ.H caught the
-- same class of hole on that table pre-apply. Mateo escalated:
-- "audit the sibling table" — same Supabase default grant, same
-- possible hole, PII-carrying.
--
-- ── Why REVOKE and not just rely on RLS ────────────────────────────────
-- The admin_all policy on provisioning_failures uses
-- `USING (get_my_role() = 'admin') WITH CHECK (get_my_role() = 'admin')`
-- which discriminates admin from non-admin at the row level. A
-- non-admin authenticated caller's INSERT/UPDATE/DELETE would be
-- blocked by RLS today. But: grants + RLS are independent gates.
-- Belt-and-suspenders: REVOKE at the ACL layer too. If RLS is ever
-- accidentally disabled or a broader policy added, the grant is the
-- second wall.
--
-- ── Policy shape unchanged (deliberate) ────────────────────────────────
-- admin_all is FOR ALL (SELECT/INSERT/UPDATE/DELETE). After this
-- REVOKE, INSERT/UPDATE/DELETE by authenticated (even admin) will
-- fail at the grant layer — the policy has nothing to gate for those
-- verbs. Effectively becomes a SELECT-only policy for authenticated.
--
-- This is aligned with the design intent recorded in adfc6e1's
-- header: "All writes from the webhook go via service_role which
-- bypasses RLS entirely." Admin resolve actions (Commit 3, deferred)
-- were always going to need a DEFINER RPC anyway (matching order_forms's
-- append-with-supersedes correction pattern) — a direct admin UPDATE
-- via RLS wasn't the intended write path. Not changing the policy
-- shape here; the REVOKE is the smallest change that achieves the
-- goal without touching a policy definition.
--
-- ── ACL discipline ─────────────────────────────────────────────────────
-- Idempotent — REVOKE is safe whether the grant exists or not.
-- Safe to re-run against any state.
--
-- ── Companion verification ─────────────────────────────────────────────
-- 20260722_provisioning_failures_grants_hardening_verification.sql
-- has the 6-way widened check matching order_forms VQ.H.

BEGIN;

-- Belt-and-suspenders REVOKE for authenticated writes. SELECT stays
-- so the admin_all policy has a grant to gate. TRUNCATE included
-- (rare but possible via GRANT ALL default).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.provisioning_failures FROM authenticated;

-- Confirm anon is also fully closed (adfc6e1 REVOKE'd it but re-run
-- is idempotent and belt-and-suspenders across additive migrations
-- protects against a future migration that accidentally re-grants).
REVOKE ALL ON public.provisioning_failures FROM anon;
REVOKE ALL ON SEQUENCE public.provisioning_failures_id_seq FROM anon, authenticated;

-- ── SCHEMA_ audit ──────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PROVISIONING_FAILURES_GRANTS_HARDENING',
  'provisioning_failures',
  NULL,
  jsonb_build_object(
    'migration', '20260722_provisioning_failures_grants_hardening',
    'purpose',   'REVOKE INSERT/UPDATE/DELETE/TRUNCATE from authenticated on provisioning_failures (adfc6e1 REVOKE''d anon but not authenticated). Belt-and-suspenders alongside RLS admin_all policy — closes the grant-layer hole discovered when order_forms VQ.H widening caught the same class of issue.',
    'trigger',   'Mateo 2026-07-22 audit review: order_forms VQ.H widened to full write surface; sibling provisioning_failures (PII-carrying — raw_intended_tier) audited under same expectation. authenticated write grants confirmed removed here.',
    'policy_unchanged', 'admin_all policy stays FOR ALL. After REVOKE, INSERT/UPDATE/DELETE by authenticated fail at grant layer; policy effectively SELECT-only for authenticated. Consistent with adfc6e1 header (webhook writes via service_role; admin resolve actions via future DEFINER RPC in Commit 3).',
    'idempotent', 'REVOKE is safe whether the grant exists or not. Safe to re-run.'
  ),
  now()
);

COMMIT;
