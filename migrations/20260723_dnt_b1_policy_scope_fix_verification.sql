-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_b1_policy_scope_fix_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies DNT Commit B1 — RLS policy scope fix.
--
-- ── Negative control (pre-apply state) ─────────────────────────────────
-- The corrected per-clause VQ.1 was executed against the unfixed schema
-- BEFORE the migration ran, and correctly raised:
--   {dnt_manager_select.USING, dnt_manager_update.USING,
--    "dnt_manager_insert.WITH CHECK", "dnt_manager_update.WITH CHECK"}
-- VQ.6 passed pre-apply (all policies already TO authenticated).
-- Those failures + passes are what prove these VQs are validated
-- detectors, not decorative silence.
--
-- ── Scope disclaimer ───────────────────────────────────────────────────
-- All VQs here are STRUCTURAL: they assert predicates are present in
-- pg_policies. They DO NOT prove the policies refuse anything. Behavioral
-- proof (sessioned SELECT/INSERT from a foreign-tenant manager expecting
-- zero rows and a rejection) is Commit 4.5's job, not B1's. Green here
-- means the source shape is right; refusal is proven separately.
--
-- All queries silent on pass; failure RAISEs with a named clause list.
-- Safe to re-run (read-only).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.1 — company predicate on every clause of every rewritten policy
-- ══════════════════════════════════════════════════════════════════════
-- Per-CLAUSE (not per-policy): an UPDATE with scoped USING and unscoped
-- WITH CHECK is the exact hole that lets a manager UPDATE a row they
-- own and set property_id to another tenant's property. The bad
-- `qual NOT LIKE … AND with_check NOT LIKE …` per-policy form evaluates
-- FALSE AND TRUE → nothing flagged.
--
-- Assertion is on `%get_my_company()%` — the function call deparses
-- deterministically in pg_policies, unlike source column aliases which
-- the catalog may auto-qualify or strip.
DO $vq_1$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || '.' || clause ORDER BY policyname, clause), '{}')
    INTO v_missing
  FROM (
    SELECT policyname, 'USING'::text AS clause, qual AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND qual IS NOT NULL
       AND policyname <> 'dnt_admin_all'
    UNION ALL
    SELECT policyname, 'WITH CHECK'::text AS clause, with_check AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND with_check IS NOT NULL
       AND policyname <> 'dnt_admin_all'
  ) c
  WHERE c.txt NOT LIKE '%get_my_company()%';

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.1 FAILED — clause(s) not company-scoped: %', v_missing;
  END IF;
END $vq_1$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.1b — property restriction preserved on the 3 manager policies
-- ══════════════════════════════════════════════════════════════════════
-- Catches a rewrite that adds company scope while dropping
-- get_my_properties() — VQ.1 would pass, but every manager would be
-- silently widened to every property in their company.
DO $vq_1b$
DECLARE
  v_missing TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || '.' || clause ORDER BY policyname, clause), '{}')
    INTO v_missing
  FROM (
    SELECT policyname, 'USING'::text AS clause, qual AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND qual IS NOT NULL
       AND policyname IN ('dnt_manager_select','dnt_manager_insert','dnt_manager_update')
    UNION ALL
    SELECT policyname, 'WITH CHECK'::text AS clause, with_check AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND with_check IS NOT NULL
       AND policyname IN ('dnt_manager_select','dnt_manager_insert','dnt_manager_update')
  ) c
  WHERE c.txt NOT LIKE '%get_my_properties()%';

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.1b FAILED — manager clause(s) missing property restriction: %', v_missing;
  END IF;
END $vq_1b$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.1c — no OR-widening in the rewritten policy clauses
-- ══════════════════════════════════════════════════════════════════════
-- VQ.1 and VQ.1b assert each predicate is PRESENT, independently. Neither
-- detects `(company-scoped subquery) OR (property-only subquery)`, which
-- satisfies both and is wide open. That is the present-but-wrong shape
-- this arc started with — a guard that existed, passed inspection, and
-- resolved to the wrong tenant. These 6 policies are pure AND + IN; no
-- legitimate OR exists.
DO $vq_1c$
DECLARE
  v_or TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || '.' || clause ORDER BY policyname, clause), '{}')
    INTO v_or
  FROM (
    SELECT policyname, 'USING'::text AS clause, qual AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND qual IS NOT NULL AND policyname <> 'dnt_admin_all'
    UNION ALL
    SELECT policyname, 'WITH CHECK'::text, with_check
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates'
       AND with_check IS NOT NULL AND policyname <> 'dnt_admin_all'
  ) c
  WHERE c.txt LIKE '% OR %';

  IF array_length(v_or, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.1c FAILED — OR present in policy clause (possible widening): %', v_or;
  END IF;
END $vq_1c$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.2 — no ILIKE (~~*) on any policy on this table
-- ══════════════════════════════════════════════════════════════════════
DO $vq_2$
DECLARE
  v_ilike TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || '.' || clause ORDER BY policyname, clause), '{}')
    INTO v_ilike
  FROM (
    SELECT policyname, 'USING'::text AS clause, qual AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates' AND qual IS NOT NULL
    UNION ALL
    SELECT policyname, 'WITH CHECK'::text AS clause, with_check AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates' AND with_check IS NOT NULL
  ) c
  WHERE c.txt LIKE '%~~*%';

  IF array_length(v_ilike, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.2 FAILED — ILIKE (~~*) still present in DNT policies: %', v_ilike;
  END IF;
END $vq_2$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.3 — exact policy NAME SET (not count) + RLS still enabled
-- ══════════════════════════════════════════════════════════════════════
-- Count alone false-passes if a typo'd policy (dnt_manager_selct) exists
-- alongside a dropped correct one — still totals 7. Assert the exact
-- name set as sorted arrays.
DO $vq_3$
DECLARE
  v_expected TEXT[] := ARRAY[
    'dnt_admin_all',
    'dnt_ca_insert', 'dnt_ca_select', 'dnt_ca_update',
    'dnt_manager_insert', 'dnt_manager_select', 'dnt_manager_update'
  ];
  v_actual TEXT[];
  v_rls    BOOLEAN;
BEGIN
  SELECT COALESCE(array_agg(policyname ORDER BY policyname), '{}') INTO v_actual
  FROM pg_policies
  WHERE schemaname='public' AND tablename='do_not_tow_plates';

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'VQ.3 FAILED — DNT policy set drift. expected=% actual=%', v_expected, v_actual;
  END IF;

  SELECT relrowsecurity INTO v_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relname='do_not_tow_plates';
  IF v_rls IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'VQ.3 FAILED — RLS disabled on do_not_tow_plates';
  END IF;
END $vq_3$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.4 — no DELETE policy AND authenticated lacks DELETE grant
-- ══════════════════════════════════════════════════════════════════════
-- Soft-delete-only invariant, two audiences:
--   • manager/CA — enforced by their policies being SELECT/INSERT/UPDATE
--     only (RLS refuses DELETE for zero-applicable-policy).
--   • admin — enforced ONLY by absence of the DELETE grant, because
--     dnt_admin_all is FOR ALL. Grant flip = admin hard-delete.
-- Both sides asserted so a future migration cannot silently break
-- either mechanism without failing loud here. See migration header
-- for do-not-clean-up rationale.
DO $vq_4$
DECLARE
  v_del_pol   INTEGER;
  v_del_grant BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_del_pol
  FROM pg_policies
  WHERE schemaname='public' AND tablename='do_not_tow_plates' AND cmd='DELETE';
  IF v_del_pol <> 0 THEN
    RAISE EXCEPTION 'VQ.4 FAILED — DELETE-only policy exists on do_not_tow_plates (count=%)', v_del_pol;
  END IF;

  SELECT has_table_privilege('authenticated', 'public.do_not_tow_plates', 'DELETE')
    INTO v_del_grant;
  IF v_del_grant THEN
    RAISE EXCEPTION 'VQ.4 FAILED — authenticated has DELETE grant on do_not_tow_plates (soft-delete invariant broken)';
  END IF;
END $vq_4$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.5 — no policy naming driver/resident/leasing_agent
-- ══════════════════════════════════════════════════════════════════════
-- These roles read via the DEFINER RPC only (check_dnt_plate). Direct
-- table access via RLS would create a second read path with a different
-- reason-visibility policy — the exact class of drift we're preventing.
DO $vq_5$
DECLARE
  v_leaked TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || '.' || clause ORDER BY policyname, clause), '{}')
    INTO v_leaked
  FROM (
    SELECT policyname, 'USING'::text AS clause, qual AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates' AND qual IS NOT NULL
    UNION ALL
    SELECT policyname, 'WITH CHECK'::text AS clause, with_check AS txt
      FROM pg_policies
     WHERE schemaname='public' AND tablename='do_not_tow_plates' AND with_check IS NOT NULL
  ) c
  WHERE c.txt LIKE '%''driver''%'
     OR c.txt LIKE '%''resident''%'
     OR c.txt LIKE '%''leasing_agent''%';

  IF array_length(v_leaked, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.5 FAILED — non-portal role appears in DNT policy clause: %', v_leaked;
  END IF;
END $vq_5$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.6 — every policy scoped exclusively TO authenticated (not PUBLIC)
-- ══════════════════════════════════════════════════════════════════════
-- Omitting `TO authenticated` on CREATE POLICY defaults the target to
-- PUBLIC, which includes anon. Same class as the anon-grants backlog
-- item — silently widens the table you're securing.
DO $vq_6$
DECLARE
  v_wrong TEXT[];
BEGIN
  SELECT COALESCE(array_agg(policyname || ':' || roles::text ORDER BY policyname), '{}')
    INTO v_wrong
  FROM pg_policies
  WHERE schemaname='public'
    AND tablename='do_not_tow_plates'
    AND roles::text <> '{authenticated}';

  IF array_length(v_wrong, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.6 FAILED — policy not scoped exclusively TO authenticated: %', v_wrong;
  END IF;
END $vq_6$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.AUDIT — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════════
DO $vq_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_DNT_B1_POLICY_REWRITE'
    AND new_values->>'migration' = '20260723_dnt_b1_policy_scope_fix';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'VQ.AUDIT FAILED — SCHEMA_DNT_B1_POLICY_REWRITE row missing';
  END IF;
END $vq_audit$;

COMMIT;
