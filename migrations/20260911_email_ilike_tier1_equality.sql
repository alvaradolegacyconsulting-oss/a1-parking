-- ══════════════════════════════════════════════════════════════════════
-- 20260911_email_ilike_tier1_equality.sql
--
-- 🔴 SECURITY — Tier 1 of the `email ~~*` rewrite. SIX policies.
--    Privilege escalation + cross-account writes + the directory read.
--
-- ── THE VULNERABILITY ───────────────────────────────────────────────
-- `~~*` is ILIKE, so a policy comparing `email ~~* (auth.jwt() ->>
-- 'email')` uses THE CALLER'S OWN EMAIL AS A PATTERN. `%` matches any
-- sequence and `_` matches one, and both are valid in an RFC 5322 local
-- part. Probed against production 2026-09-11: admin.createUser ACCEPTS
-- `%`, with no error.
--
-- 🔴 AND IT IS NOT MERELY DISCLOSURE. July's conclusion — "escalation is
-- ruled out, the helpers use equality" — was correct about the helpers
-- and wrong about the reach, because THREE POLICIES NEVER CALL THE
-- HELPERS. They do their own inline user_roles lookup with ILIKE:
--
--     EXISTS (SELECT 1 FROM user_roles ur
--              WHERE ur.email ~~* (auth.jwt() ->> 'email') AND ...)
--
-- A caller holding `%@gmail.com` matches whichever company_admin has a
-- Gmail address and INHERITS THAT ROLE for the duration of the check.
-- The equality-locked helpers are bypassed because these policies never
-- consult them. That reaches UPDATE on residents at company scope and
-- UPDATE on properties at a manager's assigned list.
--
-- ── WHY THE FIX IS HERE AND NOT AT THE INPUT ────────────────────────
-- The 2026-09-04 company-name fix used a metacharacter CHECK on input.
-- That does not transfer: `john_smith@gmail.com` is a legitimate
-- address and cannot be rejected. ELEVEN of 231 accounts contain `_`.
-- The 2026-09-11 tourniquet blocks `%` and `\` at every ingress but
-- deliberately allows `_`, and it cannot help the accounts that already
-- exist. The policy layer is the only correct place.
--
-- ── FOUR OF THESE SIX WERE NEVER IN THIS REPO ───────────────────────
-- residents_company_admin_update, properties_manager_update,
-- user_read_own_role and driver_read_own are DASHBOARD-CREATED. A grep
-- of migrations/ finds none of them. They surfaced only because the
-- audit enumerated pg_policies at runtime.
-- (feedback_catalog_is_audit_surface_not_migrations.)
--
-- The `qual`/`with_check` text for those was supplied verbatim from
-- that enumeration.
--
-- The other three — resident_insert_disputes, resident_insert_passes and
-- resident_update_passes — were first reconstructed from
-- 20260703_rls_57014_perf_commit2_sweep.sql, a MIGRATION FILE, which is
-- the source that was already wrong once this week (VS2, 09-10).
--
-- ✅ VERIFIED 2026-09-11: all three were subsequently diffed against the
-- live `qual`/`with_check` from the runtime enumeration and MATCH
-- exactly, modulo pg_get_expr's own re-rendering (it adds `AS` aliases
-- to scalar subqueries and normalises parentheses). No divergence.
--
-- 🔴 THAT IS A RESULT ABOUT THESE THREE FILES, NOT ABOUT THE METHOD.
-- migrations/ happened to be accurate here. It is not a reason to trust
-- it next time — the same source produced a wrong answer the day before,
-- and the four dashboard-created policies in this very migration appear
-- in no migration at all.
--
-- ── THE REWRITE ─────────────────────────────────────────────────────
--   email ~~* (auth.jwt() ->> 'email')
--     becomes
--   lower(trim(email)) = lower(trim((SELECT auth.jwt()) ->> 'email'))
--
-- Matching the b155.2 helper shape (20260610).
--
-- trim() as well as lower(), and the reason is NOT that equality is
-- stricter than ILIKE about whitespace. It isn't:
--     'a@b.com ' ILIKE 'a@b.com'  -- already false
-- ILIKE fails on a stored trailing space exactly as equality does. So
-- trim() FIXES A PRE-EXISTING LATENT BUG — an address stored with
-- surrounding whitespace has never matched its own owner, under either
-- operator — rather than compensating for anything this rewrite
-- introduces.
--
-- Latent, not live: Probe C on 2026-09-07 returned
-- rows_with_whitespace = 0 on user_roles. Nothing to migrate; this is
-- purely defensive against a future write path that stores an untrimmed
-- address.
--
-- ⚠ ONE DELIBERATE ADDITION BEYOND THE SECURITY CHANGE: auth.jwt() is
-- wrapped as (SELECT auth.jwt()) on the four dashboard policies, which
-- had it bare. That is the initplan-hoisting pattern the 2026-07-03
-- 57014 sweep applied everywhere else (pattern_rls_definer_helper_hoist)
-- — without it the function re-evaluates per row. The three in-repo
-- policies already carry it. Flagged rather than slipped in: if you want
-- the security change with zero perf delta, say so and I will drop the
-- wrappers from the four.
--
-- ── NOT IN THIS COMMIT ──────────────────────────────────────────────
-- Tier 2 (drivers.driver_read_own, residents.resident_read_own) and
-- Tier 3 (ten role-gated reads + the {public} retargeting).
--
-- driver_read_own is FOR SELECT TO {public} on a table holding driver
-- licence numbers. Not currently exploitable — the 2026-07-22 grant
-- remediation revoked anon table grants and auth.jwt() is NULL for anon
-- — but it is Tier 2's first item and its retarget to `authenticated`
-- belongs in the same statement that rewrites it. Verbatim captured:
--     qual: (email ~~* (auth.jwt() ->> 'email'::text))   with_check: null
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- Report-first → diff the three against live → apply → verify.
-- Paired file: 20260911_email_ilike_tier1_equality_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1 — residents_company_admin_update    residents    UPDATE
--     🔴 ESCALATION. Inline user_roles lookup, bypasses the helpers.
--     TWO ILIKEs: ur.email and residents.company. Both become equality.
--     The company one is guarded today by companies_name_no_sql_metachar
--     (2026-09-01) — but a guarantee that rests on a CHECK on ANOTHER
--     table is not a guarantee this policy controls.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "residents_company_admin_update" ON public.residents;
CREATE POLICY "residents_company_admin_update" ON public.residents
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE lower(trim(ur.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
         AND ur.role = 'company_admin'::text
         AND ur.company IS NOT NULL
         AND lower(trim(residents.company)) = lower(trim(ur.company))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE lower(trim(ur.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
         AND ur.role = 'company_admin'::text
         AND ur.company IS NOT NULL
         AND lower(trim(residents.company)) = lower(trim(ur.company))
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- 2 — properties_manager_update    properties    UPDATE
--     🔴 ESCALATION. Same inline-lookup shape.
--     properties.name = ANY (ur.property) is ALREADY equality and is
--     left exactly as it was — only the email predicate changes.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "properties_manager_update" ON public.properties;
CREATE POLICY "properties_manager_update" ON public.properties
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE lower(trim(ur.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
         AND ur.role = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
         AND ur.property IS NOT NULL
         AND properties.name = ANY (ur.property)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE lower(trim(ur.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
         AND ur.role = ANY (ARRAY['manager'::text, 'leasing_agent'::text])
         AND ur.property IS NOT NULL
         AND properties.name = ANY (ur.property)
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- 3 — user_read_own_role    user_roles    SELECT
--     🔴 THE DIRECTORY, AND THE RECONNAISSANCE STEP.
--     No role gate at all — the email predicate is the WHOLE policy, so
--     any authenticated caller with a wildcard reads every user's email,
--     role, company and property assignments.
--     It is in Tier 1 rather than Tier 2 because it is the INPUT to the
--     escalation above: policies 1 and 2 look up user_roles, and this is
--     what tells an attacker which company_admin has a Gmail address.
--     Fixing the writers while leaving this open fixes half a two-step.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "user_read_own_role" ON public.user_roles;
CREATE POLICY "user_read_own_role" ON public.user_roles
  FOR SELECT TO authenticated
  USING (
    lower(trim(email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
  );


-- ══════════════════════════════════════════════════════════════════════
-- 4 — resident_insert_disputes    dispute_requests    INSERT
--     Role-gated via get_my_role() (equality-locked since 20260610), so
--     the wildcard alone does not pass — but the email predicate still
--     widens WHICH resident a caller may file as.
--     (SELECT get_my_role()) and (SELECT auth.jwt()) wrappers preserved
--     verbatim — they are the 57014 initplan hoisting, not decoration.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "resident_insert_disputes" ON public.dispute_requests;
CREATE POLICY "resident_insert_disputes" ON public.dispute_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND lower(trim(resident_email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
  );


-- ══════════════════════════════════════════════════════════════════════
-- 5 — resident_insert_passes    visitor_passes    INSERT
--     The ILIKE is inside the residents subquery, so a wildcard widens
--     the set of (property, visiting_unit) pairs a caller may create
--     passes for — i.e. passes at properties that are not theirs.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "resident_insert_passes" ON public.visitor_passes;
CREATE POLICY "resident_insert_passes" ON public.visitor_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM public.residents
      WHERE lower(trim(residents.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- 6 — resident_update_passes    visitor_passes    UPDATE
--     Same subquery in BOTH qual and with_check. Both rewritten; a fix
--     to only one would leave the other as the open half.
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "resident_update_passes" ON public.visitor_passes;
CREATE POLICY "resident_update_passes" ON public.visitor_passes
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM public.residents
      WHERE lower(trim(residents.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
    )
  )
  WITH CHECK (
    (SELECT get_my_role()) = 'resident'::text
    AND (property, visiting_unit) IN (
      SELECT residents.property, residents.unit FROM public.residents
      WHERE lower(trim(residents.email)) = lower(trim((SELECT auth.jwt()) ->> 'email'::text))
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_EMAIL_ILIKE_TIER1_EQUALITY',
  'public.residents,public.properties,public.user_roles,public.dispute_requests,public.visitor_passes',
  'email_ilike_tier1',
  jsonb_build_object(
    'migration', '20260911_email_ilike_tier1_equality',
    'arc',       'email ~~* rewrite — Tier 1: escalation, cross-account writes, and the directory read',
    'policies',  jsonb_build_array(
      'residents_company_admin_update (UPDATE) — escalation, two ILIKEs',
      'properties_manager_update (UPDATE) — escalation',
      'user_read_own_role (SELECT) — the directory, and the recon step for the two above',
      'resident_insert_disputes (INSERT)',
      'resident_insert_passes (INSERT)',
      'resident_update_passes (UPDATE, qual + with_check)'
    ),
    'vulnerability', 'email ~~* uses the caller''s own address as an ILIKE pattern. Three of these policies do an inline user_roles lookup and never call the equality-locked helpers, so a wildcard caller inherits another role — escalation, not disclosure. admin.createUser was probed 2026-09-11 and ACCEPTS % with no error.',
    'why_not_input_validation', 'john_smith@gmail.com is a legitimate address and 11 of 231 accounts contain _. The 2026-09-11 tourniquet blocks % and \ at every ingress but cannot help existing accounts and deliberately allows _.',
    'four_were_dashboard_created', 'residents_company_admin_update, properties_manager_update, user_read_own_role and driver_read_own appear in NO migration. They surfaced only via runtime pg_policies enumeration.',
    'three_reconstructed_then_verified', 'resident_insert_disputes, resident_insert_passes and resident_update_passes were rebuilt from 20260703_rls_57014_perf_commit2_sweep.sql, then diffed against the live qual from the runtime enumeration — exact match modulo pg_get_expr re-rendering. A result about those three files, not a reason to trust migrations/ next time.',
    'perf_note', 'auth.jwt() wrapped as (SELECT auth.jwt()) on the four dashboard policies, matching the 2026-07-03 57014 initplan hoisting the rest of the codebase uses.',
    'not_in_this_commit', 'Tier 2 (drivers.driver_read_own — also {public}→authenticated — and residents.resident_read_own) and Tier 3 (ten role-gated reads + {public} retargeting).'
  ),
  now()
);

COMMIT;
