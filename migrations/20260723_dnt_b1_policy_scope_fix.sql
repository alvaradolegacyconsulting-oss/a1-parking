-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_b1_policy_scope_fix.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT Commit B1 — RLS policy scope fix on public.do_not_tow_plates.
--
-- ── The defect ─────────────────────────────────────────────────────────
-- Manager policies (dnt_manager_select / insert / update) scope by
-- property NAME only. get_my_properties() returns a TEXT[] of names with
-- no company predicate. A manager at Company Y assigned to any property
-- whose name collides with a Company X property can:
--   • SELECT — read X's DNT rows + free-text reason
--   • INSERT — create a DNT row on X's property (block X's enforcement)
--   • UPDATE — modify or soft-delete X's row (remove X's protection)
-- Reachable via PostgREST directly; no UI required.
--
-- Not exploitable today (zero cross-company name collisions confirmed,
-- A1 has no manager accounts), but self-serve will generate collisions
-- routinely and Commit 5 makes this table load-bearing. Close it now.
--
-- The CA policies (dnt_ca_select / insert / update) scope correctly by
-- company BUT via `company ILIKE get_my_company()` (`~~*`). Once
-- company names are user-supplied at self-serve, `%` and `_` become
-- silent wildcards. Same fix normalizes both surfaces to one canonical
-- comparison across the whole table.
--
-- ── The fix ────────────────────────────────────────────────────────────
-- All 6 non-admin policies rewritten with:
--     lower(trim(p.company)) = lower(trim(get_my_company()))
-- Manager policies additionally get normalized name matching:
--     lower(trim(p.name)) IN (SELECT lower(trim(x)) FROM unnest(get_my_properties()))
-- dnt_admin_all untouched — no scope defect there.
--
-- ── Load-bearing invariant (DO NOT "clean up") ─────────────────────────
-- Soft-delete-only on this table is enforced by TWO different mechanisms
-- for two different audiences:
--
--   • manager / company_admin — enforced by RLS. Their policies are
--     FOR SELECT/INSERT/UPDATE only. A DELETE finds zero applicable
--     policies and is refused even if the grant exists. Robust.
--
--   • admin — enforced ONLY by the ABSENCE of the DELETE grant on
--     `authenticated`. dnt_admin_all is FOR ALL, which covers DELETE,
--     so the moment DELETE is granted to authenticated, admin can hard
--     delete rows on a table whose entire design is soft-delete.
--
-- VQ.4 asserts both sides (no DELETE-only policy AND no DELETE grant).
-- Do not grant DELETE to `authenticated` on this table "for
-- consistency" without first narrowing dnt_admin_all off FOR ALL.
--
-- ── Pre-apply state (verified 2026-07-23, Jose — negative control) ────
-- The corrected per-clause VQ.1 was executed against the current schema
-- BEFORE this migration exists, and correctly raised:
--   VQ.1 FAILED — clause(s) not company-scoped: {
--     dnt_manager_select.USING,
--     dnt_manager_update.USING,
--     "dnt_manager_insert.WITH CHECK",
--     "dnt_manager_update.WITH CHECK"
--   }
-- Manager three × applicable clauses. CA clauses passed pre-apply
-- (get_my_company() present). VQ.6 (roles = {authenticated}) passed
-- pre-apply; this migration must PRESERVE that, not establish it.
--
-- The failure above is the negative control that proves the detector
-- fires on the real defect. Post-apply, VQ.1 must go silent — silence
-- then means the rewrite landed, not that the check is toothless.
--
-- ── Rollback ───────────────────────────────────────────────────────────
-- Re-apply the 6 prior policy definitions from:
--   migrations/20260723_do_not_tow_plates.sql, lines 164-237
--   (dnt_manager_select/insert/update + dnt_ca_select/insert/update).
-- pg_policies.qual/with_check also retain the current definition until
-- overwritten (extra safety net for emergency reconstruction).
--
-- ── Atomicity ──────────────────────────────────────────────────────────
-- All 6 DROP+CREATE inside one BEGIN...COMMIT. Any single failure
-- rolls back to the current state (all 7 original policies, including
-- the buggy manager three — no worse than starting).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- Manager policies — add company predicate + normalize name matching
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "dnt_manager_select" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_select" ON public.do_not_tow_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

DROP POLICY IF EXISTS "dnt_manager_insert" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_insert" ON public.do_not_tow_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

DROP POLICY IF EXISTS "dnt_manager_update" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_update" ON public.do_not_tow_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  )
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- CA policies — normalize company comparison (retire ILIKE / ~~*)
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "dnt_ca_select" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_select" ON public.do_not_tow_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

DROP POLICY IF EXISTS "dnt_ca_insert" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_insert" ON public.do_not_tow_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

DROP POLICY IF EXISTS "dnt_ca_update" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_update" ON public.do_not_tow_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- SCHEMA_ audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_DNT_B1_POLICY_REWRITE',
  'do_not_tow_plates',
  NULL,
  jsonb_build_object(
    'migration', '20260723_dnt_b1_policy_scope_fix',
    'purpose',   'Add company predicate to 3 manager DNT policies; normalize CA policies to lower(trim(=)) instead of ILIKE.',
    'rewritten', ARRAY['dnt_manager_select','dnt_manager_insert','dnt_manager_update',
                       'dnt_ca_select','dnt_ca_insert','dnt_ca_update'],
    'untouched', ARRAY['dnt_admin_all'],
    'defect_class', 'name-keyed matching with company predicate omitted (manager 3) + wildcard-vulnerable ILIKE company comparison (CA 3)',
    'load_bearing_note', 'Soft-delete-only guaranteed by ABSENCE of DELETE grant on authenticated, NOT by absence of DELETE policy. Do not "clean up" the grant.',
    'followup_b2', 'Function-level company scope fix (check_dnt_plate, pm_plate_lookup branch 0, set_violation_status guard, stamp_tow_ticket guard, new regenerate_tow_ticket guard) + reason role-conditional at RPC + VQ.PARITY.',
    'followup_b3', 'Server-side DEFINER RPC filter_dnt_protected + client-side notice for CSV export.'
  ),
  now()
);

COMMIT;
