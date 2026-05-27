-- ════════════════════════════════════════════════════════════════════
-- B66.5 commit 1 — dunning schema scaffold
-- Drafted: 2026-05-27 — NOT YET APPLIED.
--
-- The SCHEMA arc for B66.5 (dunning). Establishes the data shape that
-- subsequent commits read + write:
--
--   • commit 2 — webhook handlers populate past_due_since +
--     past_due_grace_until on invoice.payment_failed; clear them on
--     invoice.payment_succeeded.
--   • commit 3 — hourly cron reads past_due_grace_until + suspension_
--     grace_until to drive state transitions (past_due → suspended,
--     suspended → cancelled).
--   • commit 4 — UI banners read account_state + the two _since columns
--     for day-counter display; Resend emails fire from cron + webhook
--     handlers.
--
-- This commit is SCHEMA ONLY. No application code reads or writes the
-- new columns yet; they are inert until commit 2 lands.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. companies.account_state CHECK extension — add 'past_due' to the
--      existing 4-value whitelist (configuring/active/suspended/
--      cancelled). DROP + ADD pattern (Postgres has no in-place ALTER
--      CHECK).
--   2. Four nullable TIMESTAMPTZ columns on companies:
--      • past_due_since           — when account_state flipped to past_due
--      • past_due_grace_until     — when grace expires (cron sweeps)
--      • suspension_since         — when flipped to suspended
--      • suspension_grace_until   — when grace expires (cron cancels)
--   3. companies.updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() +
--      companies_set_updated_at() BEFORE UPDATE trigger function. Mirrors
--      the proposal_codes_set_updated_at() pattern from
--      20260508_phase1_tier_enforcement.sql but uses $func$ tagged
--      delimiter per feedback_sql_editor_dollar_quote_parsing.
--   4. stripe_events.process_skip_reason TEXT NULL — B116 fold-in.
--      Lets the eventual processor record WHY a stripe_events row was
--      skipped (vs the existing process_error field which captures
--      failure). Skip reasons are non-failure ("event_type not handled
--      yet", "company already cancelled", etc.) — distinct from error.
--   5. Two partial indexes for hourly cron sweep performance:
--      • companies_past_due_grace_idx     — past_due rows only
--      • companies_suspension_grace_idx   — suspended rows only
--      Each index is tiny (only rows with the matching account_state),
--      so the cron's "rows whose grace has expired" query is O(grace-
--      expired-rows) not O(all companies).
--
-- ── AUDIT-PASS DISCIPLINE (pre-flight 2026-05-27 confirmed clean) ───
-- Per feedback_audit_pass_must_query_production_schema: pg_constraint
-- + information_schema.columns + pg_trigger + pg_indexes + pg_proc
-- queries run against production BEFORE writing this migration. All
-- 9 audit-pass queries (AP.A-AP.I) returned expected results — no
-- drift, no conflicting state. Notably:
--   • companies_subscription_status_valid CHECK already permits
--     'past_due' as a subscription_status value (Stripe's view of
--     subscription health). That column is intentionally separate
--     from this commit's new account_state='past_due' value.
--   • 5-companies baseline confirmed (verification F target).
--   • No rows currently in any state outside the existing whitelist.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • No application code changes. Schema is inert until commit 2.
-- • Webhook handler dispatch refactor + verify-after-write pattern —
--   commit 2 per locked greenlight.
-- • Cron route + vercel.json — commit 3.
-- • UI banners + Resend SDK + email templates + portal gate wiring —
--   commit 4.
-- • Retrofit verify-after-write to EXISTING webhook handlers — B134
--   (post-B66.5 sub-arc).
-- • Backfill of updated_at for existing rows: handled implicitly by
--   the NOT NULL DEFAULT NOW() — all 5 existing companies will get
--   their updated_at set to the migration-apply timestamp. This is
--   correct (we have no historical "last updated" data; "now" is the
--   honest signal that the column was just added).
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Paste this entire file as ONE block in the
-- Supabase SQL Editor, click Run ONCE. Trigger function body uses
-- $func$ tagged dollar-quote delimiter per
-- feedback_sql_editor_dollar_quote_parsing (bare $$ can be smart-split
-- by the SQL Editor's tokenizer + cause partial apply). BEGIN/COMMIT
-- atomic — any statement failing rolls back the entire migration. All
-- DDL idempotent:
--   • DROP CONSTRAINT IF EXISTS + DO $func$ IF NOT EXISTS guard on ADD
--   • ADD COLUMN IF NOT EXISTS (× 5)
--   • CREATE OR REPLACE FUNCTION
--   • DROP TRIGGER IF EXISTS + CREATE TRIGGER
--   • CREATE INDEX IF NOT EXISTS (× 2)
-- Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Extend companies.account_state CHECK to admit 'past_due'
-- ════════════════════════════════════════════════════════════════════
-- Old whitelist: 'configuring','active','suspended','cancelled' (B65 era).
-- New whitelist: + 'past_due' (B66.5 dunning state, inserted between
-- 'active' and 'suspended' in the lifecycle: active → past_due →
-- suspended → cancelled).

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_account_state_valid;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_account_state_valid'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_account_state_valid
      CHECK (account_state IN ('configuring','active','past_due','suspended','cancelled'));
  END IF;
END
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — Four dunning-lifecycle TIMESTAMPTZ columns on companies
-- ════════════════════════════════════════════════════════════════════
-- All nullable: NULL means "not in that lifecycle stage." A company in
-- 'active' has all four NULL; a 'past_due' company has past_due_since
-- + past_due_grace_until populated and the two suspension_* still NULL;
-- a 'suspended' company has all four populated (past_due_* captured
-- from its pre-suspension period; suspension_* governing the
-- cancellation grace clock).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS past_due_since         TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS past_due_grace_until   TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspension_since       TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspension_grace_until TIMESTAMPTZ;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — companies.updated_at + BEFORE UPDATE trigger
-- ════════════════════════════════════════════════════════════════════
-- DEFAULT NOW() backfills all 5 existing companies to the migration-
-- apply timestamp (no historical "last updated" data available; "now"
-- is the honest signal that the column was just added).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Trigger function — $func$ tagged delimiter (NOT bare $$) per
-- feedback_sql_editor_dollar_quote_parsing. Mirrors the
-- proposal_codes_set_updated_at() shape from
-- 20260508_phase1_tier_enforcement.sql.

CREATE OR REPLACE FUNCTION companies_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS companies_updated_at ON companies;
CREATE TRIGGER companies_updated_at
BEFORE UPDATE ON companies
FOR EACH ROW
EXECUTE FUNCTION companies_set_updated_at();

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — stripe_events.process_skip_reason (B116 fold-in)
-- ════════════════════════════════════════════════════════════════════
-- NULLable TEXT. Populated by the eventual processor when an event is
-- intentionally skipped (e.g., event_type not yet handled, company
-- already in cancelled state, idempotent re-delivery). Distinct from
-- process_error (which captures FAILURE). A skipped event still has
-- processed=TRUE + processed_at populated; the reason column explains
-- why no state change occurred.

ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS process_skip_reason TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Two partial indexes for hourly cron sweep performance
-- ════════════════════════════════════════════════════════════════════
-- Cron pattern (commit 3):
--   SELECT id FROM companies
--   WHERE account_state = 'past_due' AND past_due_grace_until <= NOW();
--   -- (and the suspended → cancelled sibling)
-- WHERE clause matches the partial-index predicate exactly; planner
-- uses the partial index directly. Index size = O(rows in that state),
-- not O(all companies). At our scale (~5 companies today, target ~100
-- at A1 Wrecker + first PM customers), the partial-index choice is
-- premature optimization in absolute terms — but the convention sets
-- the right pattern as scale grows + costs ~0 to ship now.

CREATE INDEX IF NOT EXISTS companies_past_due_grace_idx
  ON companies (past_due_grace_until)
  WHERE account_state = 'past_due';

CREATE INDEX IF NOT EXISTS companies_suspension_grace_idx
  ON companies (suspension_grace_until)
  WHERE account_state = 'suspended';

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES A-G (run after migration applies)
-- ════════════════════════════════════════════════════════════════════
-- Paste each query into the SQL Editor and confirm the expected output.
-- A failed verification means the migration didn't fully apply (or
-- something else drifted) — investigate before claiming commit 1 shipped.
--
-- ── VQ.A — CHECK constraint extended to 5 values
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'companies_account_state_valid';
--   -- Expected: CHECK ((account_state = ANY (ARRAY['configuring'::text,
--   --   'active'::text, 'past_due'::text, 'suspended'::text,
--   --   'cancelled'::text])))
--
-- ── VQ.B — 4 new TIMESTAMPTZ columns present + nullable
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name IN (
--       'past_due_since','past_due_grace_until',
--       'suspension_since','suspension_grace_until'
--     )
--   ORDER BY column_name;
--   -- Expected: 4 rows, all data_type='timestamp with time zone',
--   -- all is_nullable='YES'.
--
-- ── VQ.C — updated_at column present + trigger present + fires on UPDATE
-- Three checks: column existence, trigger existence, and an actual
-- UPDATE that proves the trigger fires.
--
--   -- C.1 — column
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'companies'
--     AND column_name = 'updated_at';
--   -- Expected: 1 row, data_type='timestamp with time zone',
--   -- is_nullable='NO', column_default='now()'.
--
--   -- C.2 — trigger
--   SELECT tgname, pg_get_triggerdef(oid)
--   FROM pg_trigger WHERE tgrelid = 'public.companies'::regclass
--     AND tgname = 'companies_updated_at';
--   -- Expected: 1 row, definition mentions "BEFORE UPDATE" + the
--   -- companies_set_updated_at function.
--
--   -- C.3 — trigger fires (pick any company by id; the UPDATE itself
--   -- is a no-op semantically because we re-write the same name).
--   -- Capture before + after timestamps to prove updated_at changed.
--   WITH before_snap AS (
--     SELECT id, updated_at AS before_ts FROM companies ORDER BY id LIMIT 1
--   ),
--   touched AS (
--     UPDATE companies SET name = name
--     WHERE id = (SELECT id FROM before_snap)
--     RETURNING id, updated_at AS after_ts
--   )
--   SELECT before_snap.before_ts, touched.after_ts,
--          touched.after_ts > before_snap.before_ts AS trigger_fired
--   FROM before_snap, touched;
--   -- Expected: trigger_fired = true.
--
-- ── VQ.D — stripe_events.process_skip_reason present
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'stripe_events'
--     AND column_name = 'process_skip_reason';
--   -- Expected: 1 row, data_type='text', is_nullable='YES'.
--
-- ── VQ.E — Both partial indexes present
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'companies'
--     AND indexname IN (
--       'companies_past_due_grace_idx',
--       'companies_suspension_grace_idx'
--     )
--   ORDER BY indexname;
--   -- Expected: 2 rows. Each indexdef should include the WHERE clause
--   -- matching its account_state value.
--
-- ── VQ.F — Row count unchanged (no data loss)
--   SELECT COUNT(*) AS companies_row_count FROM companies;
--   -- Expected: 5 (matches AP.F baseline). Anything else means a row
--   -- was lost during the migration — investigate immediately.
--
-- ── VQ.G — Existing CHECK constraints still functional (negative test)
-- Confirms the CHECK extension didn't silently disable enforcement.
-- Direct INSERT outside DO/EXCEPTION per
-- feedback_sql_editor_dollar_quote_parsing extension (transparent
-- error display vs. RAISE NOTICE buried in Messages panel).
--
--   INSERT INTO companies (name, tier, tier_type, account_state)
--   VALUES ('VQ_G_NEGATIVE_TEST', 'starter', 'enforcement', 'not_a_real_state');
--   -- Expected: red error in SQL Editor —
--   --   "ERROR: new row for relation 'companies' violates check
--   --    constraint 'companies_account_state_valid'"
--   -- No row inserted. Cleanup not needed (CHECK rejects pre-write).
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent (see APPLY DISCIPLINE header). BEGIN/COMMIT
-- atomic — any failure rolls back ALL 5 PARTs. Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════
