-- ════════════════════════════════════════════════════════════════════
-- RLS 57014 perf fix — COMMIT 1 (live-blocker unblock)
-- Locked: July 2, 2026
--
-- Symptom: manager sessions 500 in ~8s on
--   GET /rest/v1/residents?select=*&property=ilike.French+Quarter&order=unit.asc
--   GET /rest/v1/spaces?select=type,status&property=ilike.French+Quarter&is_active=eq.true
-- SQLSTATE 57014 (statement_timeout).
--
-- Root cause: per-row RLS eval.
--   spaces:    property ~~* ANY (get_my_properties())
--              STABLE DEFINER helper NOT hoisted → called per row.
--              801 rows × ~10ms/row = 8s.
--   residents: EXISTS ( SELECT 1 FROM user_roles ur ... )
--              subquery-with-user_roles-RLS fires PER ROW.
--              108 rows × ~55ms/row = 6s.
--
-- Fix: Supabase-documented InitPlan hoist forces one-time eval.
-- Two forms depending on the helper's return type:
--   scalar (get_my_role, get_my_company): (SELECT get_my_x())
--   array  (get_my_properties):           ANY (SELECT unnest(get_my_properties()))
-- The array trap (SQLSTATE 42883): wrapping an array helper as
-- (SELECT get_my_properties()) turns ANY from array-form (text ~~* text
-- per element) into subquery-form scalar (text ~~* text[] — no such
-- operator). unnest expands the array back to a SET, so ANY runs
-- element-wise, and the uncorrelated subquery still hoists once.
-- Residents also gets a shape rewrite from the EXISTS pattern to the
-- DEFINER-helper pattern already shipped on vehicles/violations/
-- visitor_passes — this simultaneously closes the case-sensitivity
-- gap (residents.property = ANY was case-sensitive; ~~* ANY matches
-- the shipped precedent).
--
-- Scope: EXTENDED (2026-07-03) — the initial 5 rewrites only saved
-- ~22% because 3 of the 4 stacked SELECT policies on each table were
-- still un-hoisted, and OR-evaluated per row. Extended to cover ALL
-- SELECT-applicable policies on residents + spaces:
--   residents: residents_admin_all (wrap scalar),
--              residents_company_admin_read (rewrite EXISTS → helper),
--              residents_manager_read (already rewritten above),
--              resident_read_own (wrap auth.jwt() — Supabase-canonical
--                per-row auth-fn hoist).
--   spaces:    admin_all_spaces (wrap scalar),
--              company_admin_own_spaces (wrap scalar + scalar),
--              manager_own_spaces (already wrapped above),
--              leasing_agent_read_spaces (already wrapped above),
--              driver_read_spaces (Dashboard, unwrapped — wrap outer),
--              resident_read_own_spaces (Dashboard, unwrapped — wrap outer).
-- Dashboard-created policies (`driver_read_spaces`,
-- `resident_read_own_spaces`) were surfaced by a live pg_policies
-- read after the initial extended apply — migration-file grep missed
-- them. Now migration-tracked going forward.
-- Commit 2 sweeps the remaining ~25 helper-calling policies on
-- vehicles / violations / visitor_passes / dispute_requests /
-- guest_authorizations / space_* / etc. using the same idioms,
-- before A1 go-live.
--
-- SEMANTIC EQUIVALENCE (per Jose gate):
-- • Managers reading residents/spaces at their properties: same rows
--   before/after (modulo case-insensitivity — residents now matches
--   the shipped vehicles behavior; this is the intended parity fix).
-- • Managers at other properties still see nothing at French Quarter.
-- • Admin / company_admin / driver / resident unaffected (their
--   policies remain unchanged).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SPACES ────────────────────────────────────────────────────────────
-- manager_own_spaces: single predicate uses two DEFINER helpers.
-- Both wrapped so each is evaluated ONCE per statement, not per row.
DROP POLICY IF EXISTS "manager_own_spaces" ON public.spaces;
CREATE POLICY "manager_own_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  );

DROP POLICY IF EXISTS "leasing_agent_read_spaces" ON public.spaces;
CREATE POLICY "leasing_agent_read_spaces" ON public.spaces
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'leasing_agent'::text
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  );

-- ── RESIDENTS ─────────────────────────────────────────────────────────
-- Full rewrite from EXISTS(user_roles) → helper-based pattern.
-- Case: was = ANY (case-SENSITIVE) → now ~~* ANY (case-INsensitive)
-- matching the vehicles/violations/visitor_passes shipped precedent.
-- Roles: 'manager' + 'leasing_agent' — same as the original EXISTS.

DROP POLICY IF EXISTS "residents_manager_read" ON public.residents;
CREATE POLICY "residents_manager_read" ON public.residents
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) IN ('manager', 'leasing_agent')
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  );

DROP POLICY IF EXISTS "residents_manager_update" ON public.residents;
CREATE POLICY "residents_manager_update" ON public.residents
  FOR UPDATE TO authenticated
  USING (
    (SELECT get_my_role()) IN ('manager', 'leasing_agent')
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  )
  WITH CHECK (
    (SELECT get_my_role()) IN ('manager', 'leasing_agent')
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  );

DROP POLICY IF EXISTS "residents_manager_insert" ON public.residents;
CREATE POLICY "residents_manager_insert" ON public.residents
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT get_my_role()) IN ('manager', 'leasing_agent')
    AND (property ~~* ANY (SELECT unnest(get_my_properties())))
  );

-- ── SPACES admin_all + company_admin (SELECT-applicable per-row cost)
DROP POLICY IF EXISTS "admin_all_spaces" ON public.spaces;
CREATE POLICY "admin_all_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_spaces" ON public.spaces;
CREATE POLICY "company_admin_own_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND company ~~* (SELECT get_my_company())
  );

-- ── RESIDENTS admin_all + company_admin_read + read_own
-- residents_admin_all: FOR ALL — wrap both USING and WITH CHECK so
-- INSERT/UPDATE paths for admin get the same InitPlan hoist.
DROP POLICY IF EXISTS "residents_admin_all" ON public.residents;
CREATE POLICY "residents_admin_all" ON public.residents
  FOR ALL TO authenticated
  USING ((SELECT get_my_role()) = 'admin')
  WITH CHECK ((SELECT get_my_role()) = 'admin');

-- residents_company_admin_read: was EXISTS(user_roles) — subquery-
-- with-user_roles-RLS-per-row, same anti-pattern as the old manager
-- policy. Rewrite to the helper form. Semantic equivalence: CA sees
-- residents whose company matches CA's own company (case-insensitive
-- via ILIKE — matches the original EXISTS's `ILIKE ur.company`).
DROP POLICY IF EXISTS "residents_company_admin_read" ON public.residents;
CREATE POLICY "residents_company_admin_read" ON public.residents
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'
    AND company ILIKE (SELECT get_my_company())
  );

-- resident_read_own: was `email ILIKE (auth.jwt() ->> 'email')` —
-- auth.jwt() runs per row. Wrap the jwt() call in a subquery so the
-- planner hoists to a single evaluation per statement. Supabase-
-- canonical pattern for auth.jwt / auth.uid inside RLS predicates.
DROP POLICY IF EXISTS "resident_read_own" ON public.residents;
CREATE POLICY "resident_read_own" ON public.residents
  FOR SELECT TO authenticated
  USING (email ILIKE ((SELECT auth.jwt()) ->> 'email'));

-- ── SPACES Dashboard-created policies (from live pg_policies read
--   2026-07-03; not previously in migrations). Wrap the OUTER
--   `get_my_role()` in each — it's called per row and is the residual
--   3s cost after the initial extension. The `property IN (SELECT ...)`
--   subqueries are UNCORRELATED (spaces.property is on the LHS of IN,
--   not referenced inside the subquery) — Postgres already evaluates
--   those once per statement. Inner get_my_company() / auth.jwt() run
--   inside the subquery once, so wrapping them is unnecessary; left
--   as-is to preserve the Dashboard predicate byte-for-byte modulo
--   the outer role-check hoist.
--
-- Semantic equivalence PRESERVED:
--   driver_read_spaces:        driver sees spaces at own-company properties.
--   resident_read_own_spaces:  resident sees spaces at own residents.property
--                              (matched by auth.jwt.email ILIKE residents.email).
-- Both semantics identical before/after; only the outer helper is hoisted.

DROP POLICY IF EXISTS "driver_read_spaces" ON public.spaces;
CREATE POLICY "driver_read_spaces" ON public.spaces
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'::text
    AND property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    )
  );

DROP POLICY IF EXISTS "resident_read_own_spaces" ON public.spaces;
CREATE POLICY "resident_read_own_spaces" ON public.spaces
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'resident'::text
    AND property IN (
      SELECT residents.property FROM residents
      WHERE residents.email ~~* (auth.jwt() ->> 'email')
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- ── A. policy shape confirmed (10 rows) ─────────────────────────────
--   SELECT policyname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE tablename IN ('residents','spaces')
--     AND policyname IN (
--       'manager_own_spaces','leasing_agent_read_spaces',
--       'admin_all_spaces','company_admin_own_spaces',
--       'residents_manager_read','residents_manager_update',
--       'residents_manager_insert',
--       'residents_admin_all','residents_company_admin_read',
--       'resident_read_own'
--     )
--   ORDER BY tablename, policyname;
--   Expected qual/with_check body contains BOTH
--     "(SELECT get_my_role())"     (scalar hoist)
--     "SELECT unnest(get_my_properties())"   (array-set hoist)
--
-- ── A2. hoisting proof — EXPLAIN ANALYZE one manager-session query.
--   Run this in a session whose JWT is the target manager, or via a
--   throwaway RPC that runs SET LOCAL role authenticated + SET LOCAL
--   request.jwt.claim.email. Look for an "InitPlan 1" node calling
--   get_my_properties() ONCE, then a per-row filter using its result.
--     EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
--     SELECT * FROM residents WHERE property ILIKE 'French Quarter';
--
-- ── B. semantic equivalence + timing (run via
--       scripts/probe-residents-500.ts after apply) ─────────────────
--   Manager chris.tobar94+happy@gmail.com should read:
--     residents at French Quarter: exactly 3 (jes, joe, may)
--     spaces at French Quarter: same rows as before
--   Timing target: <500ms per query (was 6s residents, 8s+ timeout spaces)
--   No 57014 statement_timeout errors.
--
-- ── C. negative check — cross-property isolation preserved ──────────
--   Sign a manager at a DIFFERENT property → residents/spaces at
--   French Quarter should return 0 rows (not admitted by RLS).
-- ════════════════════════════════════════════════════════════════════
