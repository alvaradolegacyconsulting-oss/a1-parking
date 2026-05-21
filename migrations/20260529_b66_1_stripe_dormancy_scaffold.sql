-- ════════════════════════════════════════════════════════════════════
-- B66.1 — Stripe Dormancy Layer + Webhook Event Store
-- Drafted: 2026-05-20 — NOT YET APPLIED.
--
-- First commit of the B66 Stripe billing arc. Establishes the three-
-- layer dormancy architecture (Cluster 1.3 of B66 architecture doc) +
-- the webhook event persistence table (Cluster 6.1). Ships with all
-- gates OFF — no customer can reach any Stripe code path until Jose
-- explicitly flips three switches (STRIPE_MODE env, stripe_billing_enabled
-- flag, public_signup_open flag).
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. platform_settings — add 2 BOOLEAN columns (both default FALSE):
--      • stripe_billing_enabled  (Layer 2 of dormancy architecture)
--      • public_signup_open      (Layer 3 — column only; UI wiring deferred to B66.3)
--   2. stripe_events — new table for persisted webhook events.
--      service_role inserts via BYPASSRLS; admin reads via RLS policy.
--      Other roles see zero rows / cannot write (deliberate absence).
--   3. RLS on stripe_events (admin_all FOR ALL, no other policies).
--
-- ── DESIGN DECISIONS BAKED IN ───────────────────────────────────────
-- • platform_settings is a single-row table (id=1, column-per-setting).
--   Two new BOOLEAN columns follow the existing pricing-column shape.
--   No CREATE TABLE — Dashboard-era table; capture-pass is B68 territory.
-- • stripe_events.mode is a CHECK-constrained TEXT enum ('test','live')
--   matching the established pattern (companies_account_state_valid,
--   proposal_codes_base_tier_valid).
-- • stripe_event_id UNIQUE constraint provides idempotency per Cluster
--   6.2 — duplicate Stripe retries are rejected at insert without
--   re-processing.
-- • Partial index on (received_at) WHERE processed = FALSE speeds the
--   eventual background processor's queue scan (B66.5+ work).
-- • RLS pattern mirrors tos_acceptances from B65 schema: admin-all FOR ALL,
--   deliberate absence of all other policies. service_role bypasses RLS
--   by default in Supabase (BYPASSRLS at role creation) — webhook handler
--   inserts via that path without needing an explicit INSERT policy.
-- • public_signup_open column is ADDED in B66.1 but READ by zero UI
--   surfaces. The /signup page conditional render lands in B66.3 when
--   the tier picker UI exists to switch between. Deliberate per locked
--   pre-flight decision.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Open the Supabase SQL Editor, paste this
-- entire file as ONE block, click Run ONCE. Do NOT run statement-by-
-- statement — that breaks BEGIN/COMMIT atomicity (lesson from 4c733d5).
-- If any statement fails, the entire transaction rolls back; safe to
-- re-apply after fixing.
--
-- Fallback path if SQL Editor misbehaves: psql via DATABASE_URL with
-- \i 20260529_b66_1_stripe_dormancy_scaffold.sql
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — platform_settings: add dormancy flags
-- ════════════════════════════════════════════════════════════════════
-- Both default FALSE. Existing id=1 row picks up defaults automatically
-- (no UPDATE needed). New columns are NOT NULL with DEFAULT FALSE so
-- they're safe to read with .select('*').eq('id', 1).single() — never
-- undefined.

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS stripe_billing_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS public_signup_open BOOLEAN NOT NULL DEFAULT FALSE;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — stripe_events table
-- ════════════════════════════════════════════════════════════════════
-- Persisted webhook event log per Cluster 6.1. B66.1 only INSERTs into
-- this table from the webhook handler; the background processor that
-- reads it and updates `processed` lives in later sub-arcs.
--
-- Column notes:
--   stripe_event_id — Stripe's event.id, used as idempotency key.
--                     UNIQUE constraint blocks duplicate retries.
--   event_type      — e.g., 'checkout.session.completed'. Indexed for
--                     processor selection by type.
--   mode            — captured at receipt time by which signing secret
--                     validated the payload. Source of truth for which
--                     environment generated the event.
--   raw_event       — full Stripe event payload as JSONB. Long-term
--                     records live in Stripe Dashboard; this is local
--                     working copy with 1-year retention (Cluster 6.3
--                     — retention cron is separate filing, not B66.1).
--   processed       — flipped TRUE by background processor after
--                     successful state updates. Default FALSE.
--   processed_at    — when processed flipped TRUE.
--   process_error   — last error if processing failed; cleared on
--                     successful retry.
--   process_attempts — incremented on each processor attempt for
--                     observability + retry backoff.

CREATE TABLE IF NOT EXISTS stripe_events (
  id              BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('test','live')),
  raw_event       JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  process_error   TEXT,
  process_attempts INTEGER NOT NULL DEFAULT 0
);

-- Partial index for the eventual background processor's queue scan.
-- WHERE clause keeps the index tiny (only unprocessed rows) so the
-- processor's "next batch to handle" query is O(unprocessed) not O(all).
CREATE INDEX IF NOT EXISTS stripe_events_unprocessed_idx
  ON stripe_events (received_at)
  WHERE processed = FALSE;

-- Secondary index for processor selection by event type (e.g., "handle
-- all checkout.session.completed first"). Not partial — useful for
-- both processed and unprocessed scans during debugging.
CREATE INDEX IF NOT EXISTS stripe_events_type_idx
  ON stripe_events (event_type);

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — RLS on stripe_events
-- ════════════════════════════════════════════════════════════════════
-- Pattern mirrors tos_acceptances (B65 schema, 20260520_b65_self_serve_signup_schema.sql:97-115):
-- admin-all FOR ALL, deliberate absence of all other policies. service_role
-- inserts via BYPASSRLS (Supabase default). All other roles see zero rows
-- and cannot write.
--
-- Why no separate service_role policy: in Supabase, the service_role
-- Postgres role is granted BYPASSRLS at creation. Policies don't apply
-- to it. Adding an explicit "service_role FOR ALL" policy would be
-- redundant and could confuse future maintainers into thinking the
-- bypass depends on the policy.

ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stripe_events_admin_all" ON stripe_events;
CREATE POLICY "stripe_events_admin_all" ON stripe_events
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Deliberate absence: no INSERT/UPDATE/DELETE/SELECT policies for any
-- other role. Webhook writes happen via service_role; admin reads via
-- the policy above; everyone else gets zero rows / write denials.

-- ── B82 discipline generalized to tables ──────────────────────────────
-- Supabase's ALTER DEFAULT PRIVILEGES grants ALL to {anon, authenticated,
-- service_role} on new public-schema tables. anon has no legitimate
-- access to webhook event payloads — REVOKE explicitly so the surface
-- is tightened in-source rather than relying on RLS alone to gate it.
-- Authenticated + service_role defaults remain: RLS gates effective
-- access for the former (admin-only via policy above); BYPASSRLS handles
-- the latter (webhook insert path).
--
-- Generalization of the B82 "explicit > implicit" lesson from functions
-- to tables: anon-revoke becomes the standing pattern for every future
-- table migration. See feedback_revoke_anon_default_on_new_tables.md.
REVOKE ALL ON TABLE stripe_events FROM PUBLIC;
REVOKE ALL ON TABLE stripe_events FROM anon;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. platform_settings columns exist + correct shape ─────────────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'platform_settings'
--     AND column_name IN ('stripe_billing_enabled','public_signup_open')
--   ORDER BY column_name;
--   -- Expected:
--   --   public_signup_open      boolean  false  NO
--   --   stripe_billing_enabled  boolean  false  NO
--
-- ── B. Existing row picked up defaults ─────────────────────────────
--   SELECT id, stripe_billing_enabled, public_signup_open
--   FROM platform_settings WHERE id = 1;
--   -- Expected: id=1, both flags = false
--
-- ── C. stripe_events table + columns + CHECK constraint ────────────
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'stripe_events'
--   ORDER BY ordinal_position;
--   -- Expected: 10 columns in order — id, stripe_event_id, event_type,
--   --   mode, raw_event, received_at, processed, processed_at,
--   --   process_error, process_attempts
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'stripe_events'::regclass
--   ORDER BY conname;
--   -- Expected (3 constraints):
--   --   stripe_events_mode_check       CHECK (mode = ANY (...))
--   --   stripe_events_pkey             PRIMARY KEY (id)
--   --   stripe_events_stripe_event_id_key  UNIQUE (stripe_event_id)
--
-- ── D. Indexes ──────────────────────────────────────────────────────
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'stripe_events'
--   ORDER BY indexname;
--   -- Expected 4 rows:
--   --   stripe_events_pkey
--   --   stripe_events_stripe_event_id_key  (auto from UNIQUE)
--   --   stripe_events_type_idx
--   --   stripe_events_unprocessed_idx      (partial WHERE processed = false)
--
-- ── E. RLS enabled + single admin policy ───────────────────────────
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'stripe_events';
--   -- Expected: t
--
--   SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
--   FROM pg_policy WHERE polrelid = 'stripe_events'::regclass
--   ORDER BY polname;
--   -- Expected exactly 1 row:
--   --   stripe_events_admin_all  *  (get_my_role() = 'admin'::text)
--
-- ── F. Insert idempotency smoke test (optional, requires service_role) ──
-- Run as service_role only:
--   INSERT INTO stripe_events (stripe_event_id, event_type, mode, raw_event)
--   VALUES ('evt_test_001', 'checkout.session.completed', 'test', '{}'::jsonb);
--   -- First insert succeeds.
--
--   INSERT INTO stripe_events (stripe_event_id, event_type, mode, raw_event)
--   VALUES ('evt_test_001', 'checkout.session.completed', 'test', '{}'::jsonb);
--   -- Second insert raises: duplicate key value violates unique constraint
--   --   "stripe_events_stripe_event_id_key"
--
--   DELETE FROM stripe_events WHERE stripe_event_id = 'evt_test_001';
--   -- Cleanup.
--
-- ── G. anon has no table privileges on stripe_events ────────────────
--   SELECT grantee, privilege_type
--   FROM information_schema.table_privileges
--   WHERE table_schema = 'public' AND table_name = 'stripe_events'
--   ORDER BY grantee, privilege_type;
--   -- Expected: NO rows with grantee='anon'.
--   -- Authenticated + service_role should still have the full
--   -- privilege set (SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--   -- REFERENCES, TRIGGER) — RLS gates effective access for
--   -- authenticated; BYPASSRLS handles service_role.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS +
-- CREATE POLICY). BEGIN/COMMIT atomic. Any failure rolls back the entire
-- transaction. Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
