-- ═══════════════════════════════════════════════════════════════════════
-- 20260722_order_forms.sql
-- ═══════════════════════════════════════════════════════════════════════
-- B2-5 C5 — Order Form snapshot table (immutable, DB-enforced).
--
-- ── Why this exists ────────────────────────────────────────────────────
-- The SaaS Agreement defines "Order Form" as the electronic order
-- completed at sign-up/check-out, including the then-current Pricing
-- Schedule. Today we persist a thin slice: companies.name,
-- stripe_customer_id, stripe_subscription_id, subscription_status,
-- current_period_end. We do NOT store the tier, quantities, specific
-- price IDs, unit amounts, or graduated permit rate table the customer
-- accepted. All that lives in Stripe, reconstructable only by querying
-- the subscription's price IDs and hoping stripe_prices rows haven't
-- been deactivated or changed since.
--
-- That's derivable-if-nothing-changed, not recorded. A signed
-- commercial instrument (the SaaS Agreement) should point to an
-- immutable snapshot of exactly what was agreed, frozen at acceptance.
-- This table IS that snapshot.
--
-- ── Immutability (DB-enforced per Jose 2026-07-22) ─────────────────────
-- No UPDATE/DELETE policy at all. All writes via service_role from
-- the webhook (bypasses RLS). Corrections require appending a new row
-- via a future admin-only DEFINER RPC and setting supersedes_order_form_id
-- on the new row — never editing the old. The supersedes column ships
-- IN THIS MIGRATION so the append-to-correct path is available without
-- a follow-up migration (adding a column later to a deliberately
-- insert-once table is exactly the operation you don't want to be
-- doing).
--
-- ── Scope (both paths per Jose 2026-07-22) ─────────────────────────────
-- Written from BOTH provisioning paths:
--   • Self-serve — checkout-session-completed.ts::handleCheckoutSessionCompleted
--   • Proposal-code — checkout-session-completed.ts::handleProposalCodeCompletion
--                     (this is A1's path + every future Legacy customer)
--
-- ── Testability today ──────────────────────────────────────────────────
-- Proposal-code half: fully testable now.
-- Self-serve half: structural only, until the accept_saas_agreement
--                  chicken-and-egg is fixed. See
--                  docs/backlog/accept-saas-agreement-selfserve-chicken-and-egg.md
--
-- ── NO backfill of A1 ──────────────────────────────────────────────────
-- Reconstructing a snapshot from Stripe after the fact is the drift-
-- risky path this exists to replace. Subscriptions predating this
-- migration have NO order_forms row by design. First forward
-- provisioning writes the first row.
--
-- ── ACL discipline ─────────────────────────────────────────────────────
-- RLS enabled. Admin SELECT only (super-admin console reads). No
-- CA-select policy yet — user_roles.company is text today (not FK)
-- and the FK epic hasn't landed; a name-match SELECT policy would
-- plant the anti-pattern we're actively retiring (see
-- pm_plate_lookup hardening 743e519, footprint counts d1303c7).
-- When the FK epic ships user_roles.company_id, add
-- order_forms_ca_select_own then. Until then, ops queries via
-- admin_console.

BEGIN;

CREATE TABLE IF NOT EXISTS public.order_forms (
  id                          BIGSERIAL PRIMARY KEY,

  -- ── Bindings ─────────────────────────────────────────────────────
  company_id                  BIGINT NOT NULL
                                REFERENCES public.companies(id) ON DELETE RESTRICT,

  -- The SaaS tos_acceptances row this Order Form represents. Enforced
  -- present because an Order Form without a signed SaaS agreement is a
  -- legal contradiction. Note: the tos_acceptances row MUST exist
  -- before this row lands (writers look it up and RESTRICT if missing).
  saas_acceptance_id          BIGINT NOT NULL
                                REFERENCES public.tos_acceptances(id) ON DELETE RESTRICT,

  -- Only populated for source='proposal_code'; NULL for source='self_serve'.
  proposal_code_id            BIGINT NULL
                                REFERENCES public.proposal_codes(id) ON DELETE RESTRICT,

  source                      TEXT NOT NULL
                                CHECK (source IN ('self_serve','proposal_code')),

  -- ── Commercial terms captured verbatim at acceptance ─────────────
  track                       TEXT    NOT NULL
                                CHECK (track IN ('enforcement','property_management')),
  tier                        TEXT    NOT NULL,   -- 'pm_only' | 'enforcement_only' | 'legacy'
  cycle                       TEXT    NOT NULL
                                CHECK (cycle IN ('monthly','annual')),
  property_count              INTEGER NOT NULL CHECK (property_count >= 0),
  driver_count                INTEGER NOT NULL DEFAULT 0 CHECK (driver_count >= 0),

  -- ── Stripe context ───────────────────────────────────────────────
  -- Nullable for defensive resilience — a snapshot should still land
  -- even if a Stripe field is missing (better a partial snapshot than
  -- none). In practice both are populated for every real write.
  stripe_customer_id          TEXT,
  stripe_subscription_id      TEXT,
  currency                    TEXT NOT NULL DEFAULT 'usd',

  -- ── Frozen line items ────────────────────────────────────────────
  -- JSONB array. Each element:
  --   {
  --     "line_item":         "base" | "per_property" | "per_permit" | "per_driver",
  --     "stripe_price_id":   "price_xxx",
  --     "quantity":          <int>,
  --     "unit_amount_cents": <int|null>,      -- null for graduated
  --     "tiers":             <jsonb|null>     -- graduated permit rate schedule, copied
  --                                              verbatim from stripe_prices at write time
  --   }
  -- JSONB (not columnar) because:
  --   1. The graduated permit line needs JSONB for tiers anyway — so
  --      the mixed-shape problem exists either way.
  --   2. New line-item types (e.g., per_space) don't force a migration.
  --   3. GIN-indexable if analytical queries need it later.
  line_items                  JSONB NOT NULL,

  -- ── Supersedes chain ─────────────────────────────────────────────
  -- Append-to-correct pattern. Corrections don't edit; they insert a
  -- new row with supersedes_order_form_id pointing to the old row.
  -- NULL = original snapshot. RESTRICT on delete so a supersede chain
  -- can never be broken by row deletion.
  supersedes_order_form_id    BIGINT NULL
                                REFERENCES public.order_forms(id) ON DELETE RESTRICT,

  -- ── Timestamps ───────────────────────────────────────────────────
  -- accepted_at = tos_acceptances.reviewed_at of the linked SaaS row.
  -- Copied redundantly for query convenience (no JOIN needed for a
  -- "what did they accept on YYYY-MM-DD" query).
  accepted_at                 TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast queries for the two most-likely access patterns.
CREATE INDEX IF NOT EXISTS idx_order_forms_company
  ON public.order_forms (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_forms_saas_acceptance
  ON public.order_forms (saas_acceptance_id);

CREATE INDEX IF NOT EXISTS idx_order_forms_proposal_code
  ON public.order_forms (proposal_code_id)
  WHERE proposal_code_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_forms_supersedes
  ON public.order_forms (supersedes_order_form_id)
  WHERE supersedes_order_form_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.order_forms ENABLE ROW LEVEL SECURITY;

-- Admin SELECT only for now. CA-select DEFERRED until user_roles.company_id
-- (FK epic) lands — planting a name-match SELECT policy today would
-- reintroduce the exact anti-pattern the FK epic is retiring.
DROP POLICY IF EXISTS "order_forms_admin_select" ON public.order_forms;
CREATE POLICY "order_forms_admin_select" ON public.order_forms
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin');

-- Deliberate absence: NO INSERT, UPDATE, or DELETE policies. All writes
-- go through service_role from the webhook (bypasses RLS). Corrections
-- happen via append-with-supersedes from a future admin RPC, not via
-- UPDATE. Postgres RLS default-denies missing policies, so an authenticated
-- caller (even admin) attempting UPDATE/DELETE fails at RLS check —
-- verified in VQ.G.

-- ── Belt-and-suspenders grants ────────────────────────────────────────
-- Supabase's ALTER DEFAULT PRIVILEGES on public schema grants both anon
-- and authenticated on new tables. RLS is the inner gate but grants
-- are the outer one — "no INSERT policy" is not equivalent to "cannot
-- INSERT" while GRANT INSERT is standing. For an insert-once legal
-- record, we close BOTH gates. Belt (this REVOKE) + suspenders (RLS
-- default-deny with no INSERT/UPDATE/DELETE policies).
--
-- authenticated KEEPS SELECT — the admin_select policy needs a table
-- grant to have anything to gate. Its qual restricts to admin at the
-- row level.
--
-- service_role bypasses grants + RLS — webhook writes unaffected.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.order_forms FROM authenticated;
REVOKE ALL ON public.order_forms FROM anon;
REVOKE ALL ON SEQUENCE public.order_forms_id_seq FROM anon, authenticated;

-- ── SCHEMA_ audit ──────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_ORDER_FORMS_TABLE',
  'order_forms',
  NULL,
  jsonb_build_object(
    'migration', '20260722_order_forms',
    'purpose',   'B2-5 C5 — immutable Order Form snapshot capturing exact commercial terms at SaaS acceptance. Written from both provisioning paths (self-serve checkout-session-completed + proposal-code handleProposalCodeCompletion). Replaces the derivable-if-nothing-changed shape (Stripe subscription + stripe_prices JOIN) with a frozen record.',
    'immutability', 'DB-enforced. RLS admin-SELECT only; NO INSERT/UPDATE/DELETE policies for authenticated roles. Writes only via service_role. Corrections use append-with-supersedes (supersedes_order_form_id column ships in this migration to avoid a follow-up migration on a deliberately insert-once table).',
    'scope',     'Both paths (self-serve + proposal-code). Proposal-code half testable today; self-serve half blocked by accept_saas_agreement chicken-and-egg (see docs/backlog/accept-saas-agreement-selfserve-chicken-and-egg.md) — structurally complete + wired but no end-to-end verification until that fix lands.',
    'ca_select_deferred', 'CA-select policy DEFERRED until FK epic lands user_roles.company_id. Adding a lower(trim())-name-match SELECT policy today would reintroduce the anti-pattern retired by 743e519 pm_plate_lookup hardening + d1303c7 subscriber footprint counts.',
    'backfill',  'NONE. Subscriptions predating this migration have no snapshot BY DESIGN. Reconstructing from Stripe would bake in the drift risk this exists to replace.'
  ),
  now()
);

COMMIT;
