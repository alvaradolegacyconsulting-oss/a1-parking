-- ══════════════════════════════════════════════════════════════════════
-- 20260830_space_payments_v1_table.sql
--
-- 🟢 Reserved-space payment tracking arc — COMMIT 2 of 4
--
-- Creates public.space_payments: append-only ledger of payments a
-- property has received for reserved spaces. Table + RLS + grants +
-- indexes only. No RPC (Commit 3), no UI (Commit 3), no report
-- (Commit 4). Nothing writes to this table until Commit 3's RPCs ship.
--
-- ── 🔴 LOAD-BEARING RULES (write once, read forever) ────────────────
--
-- 1. NON-PAYMENT CHANGES NOTHING (Commit 1's rule, still true).
--    No authorization withdraws, no violation fires, no status
--    transitions. Ledger is a metadata record; it does not gate
--    enforcement. If a future commit ever consults this table before
--    deciding to tow, it has broken the record-only model.
--
-- 2. APPEND-ONLY BY GRANT, NOT BY CONVENTION.
--    No application role has INSERT, UPDATE, or DELETE on this
--    table. Only SELECT. Writes flow through Commit 3 DEFINER RPCs
--    that populate snapshots server-side, forge-proof
--    recorded_by_email via auth.jwt() ->> 'email', and enforce
--    row-level scope. See §GRANTS below.
--
-- 3. SNAPSHOTS STAY, FOREVER.
--    space_label, property, resident_email, resident_name, unit are
--    ALL snapshots captured at INSERT time. They RECORD what was
--    true on the day the payment was recorded. When the wider
--    property_id FK arc lands (project_fk_property_id_migration),
--    this table gains property_id ADDITIONALLY — the text `property`
--    column stays. Same for any future space FK — space_label stays.
--    Same for resident_id — resident_email/name/unit stay.
--    🔴 Converting any snapshot column to an FK-only reference
--    silently rewrites payment history when the referenced row
--    renames or reassigns. That is the exact value-join drift class
--    the snapshot design refuses (vehicles.company arc, Aug 21
--    visitor-pass persistence).
--
-- 4. RLS PREDICATE IS EQUALITY, NOT ILIKE (deliberately diverges
--    from the shipped `~~*` sibling pattern on spaces/vehicles/
--    residents/violations/visitor_passes).
--    Rationale: the shipped `property ~~* ANY (get_my_properties())`
--    treats the stored value as an ILIKE pattern. A property named
--    `Smith_Lot` matches `SmithXLot` (`_` is a wildcard). A company
--    named `%` matches everything. That's the top Bar-2 blocker
--    documented in docs/CURRENT_STATE.md: 147 company sites + 82
--    property sites carry the vulnerability today; the input
--    validator that closes it is unstarted.
--    Every existing `~~*` site is there because changing it is a
--    migration risk. This table is NEW — no legacy constraint. It
--    ships with the safer form from day one. Sibling tables get
--    fixed in the metacharacter-normalization sweep (separate arc);
--    ledger doesn't wait.
--    🔴 DO NOT normalize this back to `~~*` in any future sweep.
--    The divergence is deliberate and named. If sibling tables
--    move TO equality via the metacharacter sweep, both will match
--    at that point.
--
-- ── SCHEMA ───────────────────────────────────────────────────────────
-- Per Mateo 2026-08-30 §3.
-- period_month: DATE, first-of-month enforced by CHECK. Renders as
-- "September 2026" or "2026-09" at the surface; stored once, sortable,
-- range-queryable.
-- amount: NUMERIC(10,2) NOT NULL, > 0. No negative rows — corrections
-- are voids (voided_at + voided_by_email + void_reason). Same
-- convention as violations.
-- method: TEXT NULL, free text. The property collects however it
-- already collects; an enum would be us deciding their processes.
-- resident_email/name/unit: NULL-allowed because an unassigned space
-- can carry a fee and a payment.
-- voided_* triple: coherence CHECK — either all three NULL (not
-- voided) or all three set (voided). Catches half-voided writes at
-- the schema level.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — TABLE ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.space_payments (
  id                 BIGSERIAL   PRIMARY KEY,
  space_id           BIGINT      NOT NULL REFERENCES public.spaces(id) ON DELETE RESTRICT,
  company            TEXT        NOT NULL,
  property           TEXT        NOT NULL,   -- snapshot; see LOAD-BEARING #3
  space_label        TEXT        NOT NULL,   -- snapshot
  period_month       DATE        NOT NULL,
  amount             NUMERIC(10,2) NOT NULL,
  method             TEXT        NULL,       -- free text; property's own process
  resident_email     TEXT        NULL,       -- snapshot (nullable — unassigned spaces can be paid)
  resident_name      TEXT        NULL,       -- snapshot
  unit               TEXT        NULL,       -- snapshot
  note               TEXT        NULL,
  recorded_by_email  TEXT        NOT NULL,   -- populated server-side via auth.jwt() in Commit 3 RPC
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at          TIMESTAMPTZ NULL,
  voided_by_email    TEXT        NULL,
  void_reason        TEXT        NULL,

  -- Amount must be positive. Corrections are voids, not negative rows.
  CONSTRAINT space_payments_amount_positive
    CHECK (amount > 0),

  -- period_month must be the first of a month. Store canonical form.
  CONSTRAINT space_payments_period_first_of_month
    CHECK (period_month = date_trunc('month', period_month)::date),

  -- Void coherence: either all three fields set or all three NULL.
  -- Catches half-voided writes at the schema level (e.g., voided_at
  -- set but reason left NULL). Void RPC in Commit 3 sets the triple
  -- atomically; this constraint guards the invariant if any future
  -- writer forgets one field.
  CONSTRAINT space_payments_void_coherence
    CHECK (
      (voided_at IS NULL AND voided_by_email IS NULL AND void_reason IS NULL)
      OR
      (voided_at IS NOT NULL AND voided_by_email IS NOT NULL AND void_reason IS NOT NULL)
    )
);

COMMENT ON TABLE public.space_payments IS
  '2026-08-30. Reserved-space payment tracking Commit 2 — append-only ledger of payments a property has received for reserved spaces. INERT to the system: non-payment changes nothing (no authorization withdraws, no violation fires). Append-only enforced by GRANTS (SELECT-only for authenticated); every write flows through a Commit 3 DEFINER RPC that populates snapshots server-side + forge-proofs recorded_by_email via auth.jwt(). Every "snapshot" column (property, space_label, resident_email, resident_name, unit) stays forever alongside any future FK — converting to FK-only silently rewrites payment history on rename/reassign (value-join drift class). RLS uses lower(trim()) equality, not ~~* ILIKE — deliberate divergence from the shipped sibling pattern (see migration header + docs/CURRENT_STATE.md metacharacter vector); do NOT normalize back to ~~* in future sweeps.';

-- ── PART 2 — INDEXES ────────────────────────────────────────────────
-- (space_id, period_month) — the report's per-space pivot
-- (company, period_month) — the CA-scope month view + monthly report
-- (lower(trim(resident_email))) partial — resident-centric "has this
--   person paid?" query, case-insensitive, skips unassigned rows
CREATE INDEX IF NOT EXISTS space_payments_space_period_idx
  ON public.space_payments (space_id, period_month);

CREATE INDEX IF NOT EXISTS space_payments_company_period_idx
  ON public.space_payments (company, period_month);

CREATE INDEX IF NOT EXISTS space_payments_resident_email_lower_idx
  ON public.space_payments (lower(trim(resident_email)))
  WHERE resident_email IS NOT NULL;

-- ── PART 3 — GRANTS (append-only enforcement) ──────────────────────
-- SELECT only for authenticated. NO INSERT, NO UPDATE, NO DELETE for
-- any application role. This is the commit's main claim.
--
-- All writes flow through Commit 3 DEFINER RPCs (record_space_payment,
-- void_space_payment). service_role bypasses these grants for probes,
-- cleanup, and DEFINER RPC bodies — that's the intended write path.
--
-- Why this matters (Mateo Aug 30 §2 rationale):
--   - No DELETE → ledger is truly append-only, not just conventionally
--   - No UPDATE → amount can't be silently altered after the fact;
--     voiding is the sanctioned correction, sets three columns via RPC
--   - 🔴 No INSERT → recorded_by_email cannot be forged. A manager
--     with client INSERT rights could attribute a payment to a
--     colleague. Attribution comes from auth.jwt() server-side and
--     is unforgeable.
REVOKE ALL ON public.space_payments FROM PUBLIC;
REVOKE ALL ON public.space_payments FROM anon;
REVOKE ALL ON public.space_payments FROM authenticated;
GRANT SELECT ON public.space_payments TO authenticated;
-- Sequence: BIGSERIAL creates space_payments_id_seq. authenticated
-- doesn't need USAGE on it — INSERTs come from DEFINER RPCs running
-- as the function owner (postgres/service_role by SET ROLE via
-- SECURITY DEFINER), which have USAGE by default.

-- ── PART 4 — ROW LEVEL SECURITY ────────────────────────────────────
ALTER TABLE public.space_payments ENABLE ROW LEVEL SECURITY;

-- Deliberately no FORCE ROW LEVEL SECURITY: service_role bypass is
-- required for the Commit 3 DEFINER RPC bodies + probe/cleanup ops.

-- ── admin — all rows visible ────────────────────────────────────────
DROP POLICY IF EXISTS "admin_all_space_payments" ON public.space_payments;
CREATE POLICY "admin_all_space_payments" ON public.space_payments
  FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

-- ── company_admin — SELECT within own company ──────────────────────
-- Equality (NULL-safe via trim, case-insensitive via lower) — NOT
-- ~~* ILIKE. See migration header §RLS PREDICATE rationale.
DROP POLICY IF EXISTS "company_admin_own_space_payments" ON public.space_payments;
CREATE POLICY "company_admin_own_space_payments" ON public.space_payments
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND lower(trim(company)) = lower(trim((SELECT get_my_company())))
  );

-- ── manager — SELECT within their scoped properties ────────────────
-- Equality against the case-insensitive/trimmed property set from
-- get_my_properties(). Diverges from spaces/vehicles/residents ~~*
-- pattern by design. See header §RLS PREDICATE.
DROP POLICY IF EXISTS "manager_own_space_payments" ON public.space_payments;
CREATE POLICY "manager_own_space_payments" ON public.space_payments
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND lower(trim(property)) = ANY (
      SELECT lower(trim(p)) FROM unnest(get_my_properties()) AS p
    )
  );

-- ── leasing_agent — SELECT within their scoped properties ──────────
-- Same shape as manager.
DROP POLICY IF EXISTS "leasing_agent_read_space_payments" ON public.space_payments;
CREATE POLICY "leasing_agent_read_space_payments" ON public.space_payments
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'leasing_agent'::text
    AND lower(trim(property)) = ANY (
      SELECT lower(trim(p)) FROM unnest(get_my_properties()) AS p
    )
  );

-- ── driver + resident — NO POLICY ──────────────────────────────────
-- Postgres RLS with no matching policy = row is invisible = SELECT
-- returns 0 rows. NOT an error. Per
-- feedback_rls_denials_return_empty_not_error — RLS filters, doesn't
-- throw. Any test expecting an exception for these roles false-passes.
--
-- Residents specifically: they see the fee AMOUNT on their assigned
-- space (via app/lib/spaces.ts.Space.monthly_fee) but NEVER payment
-- status in v1 (per scope doc §4 lock). Not showing the row here is
-- how we make that true.

-- ── PART 5 — Schema audit row ───────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_SPACE_PAYMENTS_TABLE_V1',
  'public.space_payments',
  'commit_2_of_4',
  jsonb_build_object(
    'migration',       '20260830_space_payments_v1_table',
    'arc',             'Reserved-space payment tracking — Commit 2 of 4 (table + RLS + grants + indexes)',
    'schema_changes',  jsonb_build_array(
      'CREATED TABLE public.space_payments (17 cols, 3 CHECKs, 1 FK ON DELETE RESTRICT)',
      'CREATED 3 indexes (space_period, company_period, resident_email lower(trim) partial)',
      'ENABLED RLS + 4 SELECT policies (admin, company_admin, manager, leasing_agent — driver/resident deliberately no policy)',
      'REVOKED all writes from PUBLIC/anon/authenticated; GRANTED SELECT ONLY to authenticated (append-only-by-grant)'
    ),
    'rls_deliberate_divergence', 'lower(trim()) equality, not ~~* ILIKE. Every existing ~~* site carries the metacharacter vulnerability (docs/CURRENT_STATE.md). New table ships with the safer form; sibling tables get fixed in the metacharacter-normalization sweep. Do NOT normalize back.',
    'load_bearing_rules', jsonb_build_array(
      'Non-payment changes nothing (Commit 1 rule extended)',
      'Append-only by GRANT (SELECT-only for authenticated; DEFINER RPCs in Commit 3 own all writes)',
      'Snapshot columns stay forever alongside any future FK — converting to FK-only rewrites history on rename/reassign',
      'RLS is equality not ILIKE (see rls_deliberate_divergence)'
    ),
    'next_commits',    'Commit 3: DEFINER RPCs record_space_payment + void_space_payment + resident/unit/space_label snapshot from spaces + space_residents at INSERT time. Commit 4: monthly report (per property, per period). Neither commit modifies this schema.',
    'unwriteable_until_commit_3', TRUE
  ),
  now()
);

-- ── PART 6 — PostgREST schema cache reload ─────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;
