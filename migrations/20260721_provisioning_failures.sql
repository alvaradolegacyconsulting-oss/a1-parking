-- ═══════════════════════════════════════════════════════════════════════
-- 20260721_provisioning_failures.sql
-- ═══════════════════════════════════════════════════════════════════════
-- B2-1 Commit 2 (schema half) — table for logging post-payment
-- provisioning failures in the self-serve checkout webhook.
--
-- ── Why this exists ────────────────────────────────────────────────────
-- Commit 1 moved company-name uniqueness pre-payment via
-- company_name_available RPC. The webhook's 5-year-old disambiguation
-- loop (silently appending " (2)", " (3)" post-payment) is retired in
-- Commit 2's code half — but a true race between two simultaneous
-- checkouts of the same name can still land two INSERTs at the DB,
-- one of which will 23505 on companies_name_lower_unique. Or the
-- pre-flight might have missed via RPC transient error (fail-open by
-- design). In either case the customer has PAID and no companies row
-- exists.
--
-- Without a landing pad, Stripe would retry the webhook for 72h
-- (each retry hitting the same 23505), and no one on our side would
-- know a charged-but-unprovisioned customer exists — invisible until
-- they open support to ask why they can't log in.
--
-- This table + the code-half email alert (Commit 2 body) surfaces the
-- failure to ops in seconds. Commit 3 (deferred per Mateo) will add
-- an admin_console reconciliation panel; until then, ops resolves
-- manually and stamps resolved=TRUE by hand.
--
-- ── Scope ──────────────────────────────────────────────────────────────
-- Records failures ONLY from the self-serve checkout webhook. The
-- proposal-code webhook branch (redeem_proposal_code — A1's path)
-- has different failure modes and its own UPDATE-flow; not covered
-- here. If a proposal-code failure ever needs the same landing pad,
-- extend this table's usage; do not create a second table.
--
-- ── ACL discipline ─────────────────────────────────────────────────────
-- RLS enabled. Admin-only via get_my_role() = 'admin'. Writes happen
-- ONLY from the webhook via service_role (bypasses RLS). No anon
-- surface. Convention matches audit_logs + other ops-only tables.
--
-- ── OPEN QUESTION: retention ───────────────────────────────────────────
-- raw_intended_tier holds customer-submitted details (company name +
-- track/tier/counts). Rows persist indefinitely today — fine for now
-- because support genuinely needs the full order to reconstruct a
-- charged-but-unprovisioned customer. But there is no retention
-- policy. Revisit when either (a) volume forces the question or (b)
-- Commit 3 admin_console panel adds a "purge resolved older than N
-- days" action. Not building anything today; flagging for
-- awareness.

BEGIN;

CREATE TABLE IF NOT EXISTS public.provisioning_failures (
  id                     BIGSERIAL PRIMARY KEY,
  -- Stripe context — populated when available from the session event.
  -- Nullable because a very early failure (session malformed) might
  -- not have all three yet.
  stripe_session_id      TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  -- Requested company name from intended_tier.company_name — the
  -- name the customer TYPED at signup. Not the collided-with existing
  -- name; capture what THEY asked for so support knows what to
  -- confirm with them.
  requested_company_name TEXT NOT NULL,
  -- Postgres SQLSTATE if extractable ('23505' = unique_violation),
  -- else NULL. Diagnosis aid.
  error_code             TEXT,
  error_message          TEXT NOT NULL,
  -- Full intended_tier JSON for downstream reconstruction. Includes
  -- track, tier, cycle, property_count, driver_count. Support uses
  -- this to build the corrected companies row without re-asking the
  -- customer for every field.
  raw_intended_tier      JSONB,
  -- Alert tracking — did the ops email actually send? Independent from
  -- the row landing. On email send failure, row still lands (ops can
  -- run a manual "SELECT WHERE alert_email_sent = FALSE" to catch
  -- undetected cases).
  alert_email_sent       BOOLEAN NOT NULL DEFAULT FALSE,
  alert_email_message_id TEXT,
  alert_email_error      TEXT,
  -- Resolution tracking — set by ops when they've handled the case.
  -- resolved_by = the admin email who took the action; resolved_notes
  -- describes what they did (renamed to X, refunded, etc.).
  resolved               BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at            TIMESTAMPTZ,
  resolved_by            TEXT,
  resolved_notes         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for the ops dashboard's "unresolved failures" query.
-- Partial index: only unresolved rows indexed. Once resolved=TRUE
-- flips, the row falls out of the index (small footprint at scale).
CREATE INDEX IF NOT EXISTS idx_provisioning_failures_unresolved
  ON public.provisioning_failures (created_at DESC)
  WHERE resolved = FALSE;

-- Stripe session lookup for support cross-referencing.
CREATE INDEX IF NOT EXISTS idx_provisioning_failures_session
  ON public.provisioning_failures (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.provisioning_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provisioning_failures_admin_all" ON public.provisioning_failures;
CREATE POLICY "provisioning_failures_admin_all" ON public.provisioning_failures
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- No client-facing INSERT/UPDATE policies. All writes from the webhook
-- go via service_role which bypasses RLS entirely. Resolution UPDATEs
-- happen from admin_console (Commit 3, deferred) which will be super-
-- admin-only, matching the SELECT policy.

-- Explicit REVOKE from anon per convention (Supabase's default ALTER
-- DEFAULT PRIVILEGES sometimes grants anon on newly-created tables).
REVOKE ALL ON public.provisioning_failures FROM anon;
REVOKE ALL ON SEQUENCE public.provisioning_failures_id_seq FROM anon;

-- ── SCHEMA_ audit ──────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PROVISIONING_FAILURES_TABLE',
  'provisioning_failures',
  NULL,
  jsonb_build_object(
    'migration', '20260721_provisioning_failures',
    'purpose',   'B2-1 Commit 2 schema half — landing pad for post-payment provisioning failures in the self-serve checkout webhook. Retires the silent " (N)" disambiguation loop; failures now surface loudly via email alert + admin_console (deferred Commit 3).',
    'scope',     'Self-serve checkout webhook only. Proposal-code path (A1) unaffected.',
    'writes',    'ONLY via service_role from the webhook handler. RLS admin_all on SELECT/UPDATE via get_my_role()=admin. No anon surface.',
    'follow_up', 'Commit 3 (deferred per Mateo unless a real race lands): admin_console panel with resolve actions (rename & retry / refund via Stripe). Until then, ops queries directly and stamps resolved=TRUE by hand.'
  ),
  now()
);

COMMIT;
