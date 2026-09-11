-- ══════════════════════════════════════════════════════════════════════
-- 20260911_email_ilike_tier2_equality.sql
--
-- 🔴 SECURITY — Tier 2 of the `email ~~*` rewrite. TWO policies.
--    The reconnaissance tier: bulk PII reads with NO ROLE GATE.
--
-- ── WHY THESE TWO ARE THEIR OWN TIER ────────────────────────────────
-- Neither policy has a role gate. The email predicate IS the whole
-- policy, so ANY authenticated caller whose address carries a LIKE
-- metacharacter reads the entire table. Tier 3's ten remaining policies
-- also require a provisioned role, which is a materially higher bar —
-- that is the line between the two tiers, not severity of the data.
--
--   residents — resident PII at scale
--   drivers   — names, contact details, TDLR operator licence numbers
--
-- Tier 1 (applied 2026-09-11, all gates green) took the escalation
-- policies and user_read_own_role, which moved up because it is the
-- reconnaissance step FOR the escalation rather than a peer of these.
--
-- ── THE REWRITE ─────────────────────────────────────────────────────
--   email ~~* (auth.jwt() ->> 'email')
--     becomes
--   lower(trim(email)) = lower(trim((SELECT auth.jwt()) ->> 'email'))
--
-- trim() fixes a pre-existing latent bug rather than compensating for
-- new strictness — 'a@b.com ' ILIKE 'a@b.com' is ALREADY false, so an
-- address stored with surrounding whitespace has never matched its own
-- owner under either operator. Probe C (2026-09-07) found
-- rows_with_whitespace = 0, so this is defensive, not a migration.
--
-- ── 🔴 driver_read_own CARRIES A SECOND DEFECT: TO {public} ─────────
-- Its siblings are `TO authenticated`. This one is `TO public`, on the
-- table holding operator licence numbers.
--
-- NOT EXPLOITABLE TODAY, and the reasoning is worth keeping because it
-- is the reason this is a cleanup rather than an incident:
--   · the 2026-07-22 grant remediation revoked anon's table grants, so
--     the GRANT layer refuses before RLS is ever evaluated, and
--   · auth.jwt() is NULL for anon, so the predicate would not match.
-- Two independent reasons. But both are circumstantial — the first is a
-- grant a future migration could restore, and defence that depends on
-- something outside the policy is not defence the policy provides.
--
-- Retargeted to `authenticated` in the same statement that rewrites the
-- predicate. It is a DROP/CREATE either way.
--
-- It also had BARE auth.jwt() with no subquery wrapper, unlike every
-- sibling. Wrapped here — the 2026-07-03 57014 initplan hoisting
-- (pattern_rls_definer_helper_hoist). resident_read_own already had it.
--
-- ── SOURCE ──────────────────────────────────────────────────────────
-- Both predicates are VERBATIM from the runtime pg_policies enumeration,
-- not reconstructed from migrations/. Neither policy appears in any
-- migration file — both are dashboard-created, which is why a repo grep
-- found neither and only the catalog did
-- (feedback_catalog_is_audit_surface_not_migrations).
--
-- ── AFTER THIS ──────────────────────────────────────────────────────
-- Tier 3 remains: ten role-gated reads still carrying ILIKE, plus three
-- audit_logs policies still targeting {public}. Real, materially lower,
-- schedulable. A green run here does NOT mean the email vector is
-- closed — the verification says so in E4 rather than leaving it to be
-- inferred.
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- Paired file: 20260911_email_ilike_tier2_equality_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1 — resident_read_own    residents    SELECT    {authenticated}
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "resident_read_own" ON public.residents;
CREATE POLICY "resident_read_own" ON public.residents
  FOR SELECT TO authenticated
  USING (
    lower(trim(email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
  );


-- ══════════════════════════════════════════════════════════════════════
-- 2 — driver_read_own    drivers    SELECT    {public} → {authenticated}
--     🔴 TWO changes in one statement: the predicate AND the role.
--     A gate that only checks the predicate would pass while the
--     retarget was silently omitted — the verification asserts polroles
--     explicitly for exactly that reason.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "driver_read_own" ON public.drivers;
CREATE POLICY "driver_read_own" ON public.drivers
  FOR SELECT TO authenticated
  USING (
    lower(trim(email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
  );


-- ══════════════════════════════════════════════════════════════════════
-- Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_EMAIL_ILIKE_TIER2_EQUALITY',
  'public.residents,public.drivers',
  'email_ilike_tier2',
  jsonb_build_object(
    'migration', '20260911_email_ilike_tier2_equality',
    'arc',       'email ~~* rewrite — Tier 2: ungated bulk PII reads',
    'policies',  jsonb_build_array(
      'resident_read_own (SELECT, residents) — no role gate',
      'driver_read_own (SELECT, drivers) — no role gate, AND retargeted {public} -> {authenticated}'
    ),
    'why_a_separate_tier', 'Neither policy has a role gate — the email predicate is the whole policy, so any authenticated caller with a LIKE metacharacter in their address reads the entire table. Tier 3 additionally requires a provisioned role.',
    'driver_read_own_public_grant', 'Was FOR SELECT TO public on a table holding TDLR operator licence numbers. Not exploitable today — the 2026-07-22 remediation revoked anon table grants so the grant layer refuses first, and auth.jwt() is NULL for anon — but both reasons are circumstantial and live outside the policy. Retargeted to authenticated in the same DROP/CREATE.',
    'source', 'Both predicates verbatim from the runtime pg_policies enumeration. Neither policy appears in ANY migration file — both dashboard-created.',
    'trim_rationale', 'trim() fixes a pre-existing latent bug, not new strictness: ''a@b.com '' ILIKE ''a@b.com'' is already false, so an untrimmed address never matched its own owner under either operator. Probe C 2026-09-07 found 0 such rows.',
    'remaining', 'Tier 3 — ten role-gated reads still carrying ILIKE, plus three audit_logs policies still targeting {public}.'
  ),
  now()
);

COMMIT;
