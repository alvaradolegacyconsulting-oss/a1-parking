-- ════════════════════════════════════════════════════════════════════
-- B66.2b commit 1 — Proposal code Stripe pricing schema
-- Drafted: 2026-05-22 — NOT YET APPLIED.
--
-- Second sub-arc of the B66 Stripe billing arc; first sub-arc to wire
-- proposal-code-driven pricing into the standard catalog table from
-- B66.2a (commit 3135cab). The B66.2a stripe_prices table holds 30
-- standard catalog Prices today; this migration prepares it (and the
-- two related tables) to also hold proposal-code-override Prices once
-- commit 2 ships the admin issue-time creation flow.
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. proposal_codes.lock_in_duration — NEW nullable INTEGER column
--      (months, 1-36 range). Captures contractual lock-in for codes
--      that include one. Commit 2 adds the admin input field + display.
--
--   2. companies.acquisition_channel — NEW nullable TEXT column with
--      CHECK ('self_serve'|'proposal_code'). Backfilled to
--      'proposal_code' for ALL existing companies because every
--      current company was provisioned via the proposal-code path
--      (self-serve doesn't ship until B66.3). NULL default forces
--      explicit population at signup; absence surfaces bugs faster
--      than a silent default would.
--
--   3. stripe_prices.proposal_code_id — NEW nullable BIGINT FK to
--      proposal_codes(id) with ON DELETE RESTRICT. Standard catalog
--      rows have NULL; proposal-code override rows have the FK
--      populated. RESTRICT prevents accidental DELETE of an issued
--      proposal code that has Stripe Prices attached.
--
--   4. Composite UNIQUE adjustment on stripe_prices. The B66.2a
--      stripe_prices_unique_combo constraint (tier_track, tier_name,
--      line_item, cycle, mode) would collide the moment a proposal-
--      code row anchored to (e.g.) enforcement.legacy.base.monthly
--      shares those 5 values with the standard catalog row at the
--      same tuple. Path 1 fix (per pre-flight ask 14): drop the
--      single 5-column UNIQUE, replace with two partial UNIQUE
--      indexes:
--        • stripe_prices_unique_combo_standard
--            (tier_track, tier_name, line_item, cycle, mode)
--            WHERE proposal_code_id IS NULL
--          → covers the 30 standard catalog rows. Identical to the
--            old constraint's coverage; existing rows stay unique.
--        • stripe_prices_unique_combo_proposal
--            (proposal_code_id, line_item, cycle, mode)
--            WHERE proposal_code_id IS NOT NULL
--          → prevents duplicate Prices on issue-button re-runs for
--            the same proposal code. mode included so test+live
--            catalogs stay isolated even within one proposal code.
--      Path 1 (partial indexes) wins on readability over Path 2
--      (NULLS NOT DISTINCT 6-column UNIQUE). The existing
--      stripe_prices_driver_enforcement_only CHECK still applies to
--      both standard + proposal rows (per_driver line_item still
--      enforcement-track only). The 6-value tier_name CHECK still
--      applies to proposal rows (every proposal code anchors to a
--      real tier via base_tier).
--
--   5. redeem_proposal_code() body update. Single behavioral change:
--      the INSERT INTO companies now sets acquisition_channel =
--      'proposal_code' explicitly. Function signature unchanged
--      (CREATE OR REPLACE preserves existing REVOKE-from-PUBLIC +
--      GRANT to authenticated — both also re-applied defensively at
--      the bottom per feedback_function_public_grant_supabase_default).
--      Note: this function is post-B65.4 (10 args including p_address);
--      body byte-identical to B65.4 except the new column line.
--
-- ── DEPENDENCIES BAKED IN ────────────────────────────────────────────
-- • B66.2a stripe_prices table must exist (commit 3135cab applied —
--   confirmed via Jose's A-G verification 2026-05-22).
-- • B66.2a stripe_prices_unique_combo constraint must exist (created
--   by 20260530 migration). Verified by DROP CONSTRAINT IF EXISTS
--   safety in PART 4.
-- • B65.4 redeem_proposal_code 10-arg signature must exist (commit
--   applied per project_b65_self_serve_onboarding_v1 memory).
-- • B82/named-5 REVOKE-from-PUBLIC + GRANT-to-authenticated discipline
--   for redeem_proposal_code applied 2026-05-26 — re-applied
--   defensively at bottom of PART 5.
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • Stripe Price object creation — that's commit 2 (issue-route
--   extension + new proposal-code-stripe.ts helper).
-- • Backfill of existing redeemed proposal codes — commit 3 deferred
--   out of scope per Jose's 2026-05-22 SQL inspection (no production
--   A1 row with custom_*_fee populated; A1 still on manual-invoice
--   path per Cluster 4A.5). When A1 transitions to Stripe billing,
--   commit 3 ships then with knowledge of actual row shape.
-- • Annual cycle support for proposal codes (pre-flight ask 7 YAGNI'd).
--   All proposal-row stripe_prices rows will have cycle='monthly'.
-- • B100 — Revoke flow Stripe Price deactivation (filed as separate
--   backlog entry; out of scope here).
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Open the Supabase SQL Editor, paste this
-- entire file as ONE block, click Run ONCE. Do NOT run statement-by-
-- statement — that breaks BEGIN/COMMIT atomicity (lesson from 4c733d5
-- per feedback_sql_editor_partial_apply). If any statement fails, the
-- entire transaction rolls back; safe to re-apply after fixing. All
-- DDL is idempotent (IF NOT EXISTS / DO $$ guards).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — proposal_codes.lock_in_duration
-- ════════════════════════════════════════════════════════════════════
-- Months of contractual lock-in. Nullable (most codes don't have one).
-- 1-36 month range covers practical lock-in lengths; the upper bound
-- is a sanity ceiling rather than a hard product constraint. Commit 2
-- adds the admin form input + draft-mode field + read-only display in
-- the issued/redeemed summary.

ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS lock_in_duration INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_lock_in_duration_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_lock_in_duration_valid
      CHECK (lock_in_duration IS NULL OR (lock_in_duration BETWEEN 1 AND 36));
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — companies.acquisition_channel + backfill
-- ════════════════════════════════════════════════════════════════════
-- TEXT with CHECK (NULL or one of the two valid values). NULL default
-- forces explicit population at signup — surfaces missed wiring as a
-- visible NULL rather than as a wrong-looking default.
--
-- Backfill rationale: every current company was provisioned via the
-- proposal-code path (manual provisioning pre-B65; B65 redemption
-- flow post-B65). Self-serve doesn't ship until B66.3. Setting all
-- existing rows to 'proposal_code' is historically accurate.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS acquisition_channel TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_acquisition_channel_valid'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_acquisition_channel_valid
      CHECK (acquisition_channel IS NULL OR acquisition_channel IN ('self_serve', 'proposal_code'));
  END IF;
END $$;

-- Backfill existing rows. Idempotent — only touches rows where
-- acquisition_channel IS NULL, so re-applying the migration after
-- new rows have been created (with the column already populated by
-- redeem_proposal_code) doesn't overwrite anything.
UPDATE companies
  SET acquisition_channel = 'proposal_code'
  WHERE acquisition_channel IS NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — stripe_prices.proposal_code_id
-- ════════════════════════════════════════════════════════════════════
-- BIGINT nullable FK to proposal_codes(id). NULL = standard catalog
-- row (current 30 from B66.2a). NOT NULL = proposal-code override row.
--
-- ON DELETE RESTRICT: prevents deleting a proposal code that has
-- Stripe Prices attached. Today /admin/proposal-codes/[code] only
-- allows DELETE on drafts, and drafts have no Stripe Prices (Stripe
-- creation happens at Issue, not Save Draft) — so RESTRICT will
-- never block a legitimate operation. If an admin ever attempts a
-- direct-DB delete of an issued code, RESTRICT prevents silently
-- nuking the Price-tracking row.
--
-- Index supports JOIN/SELECT-by-proposal_code performance at
-- redemption time (B66.7) and at backfill-script time. Partial WHERE
-- IS NOT NULL keeps the index lean (standard-catalog rows excluded).

ALTER TABLE stripe_prices
  ADD COLUMN IF NOT EXISTS proposal_code_id BIGINT
    REFERENCES proposal_codes(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_stripe_prices_proposal_code_id
  ON stripe_prices(proposal_code_id)
  WHERE proposal_code_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — Composite UNIQUE adjustment
-- ════════════════════════════════════════════════════════════════════
-- B66.2a's stripe_prices_unique_combo single 5-column UNIQUE breaks
-- the moment a proposal-row shares (tier_track, tier_name, line_item,
-- cycle, mode) with a standard-row — which it WILL (e.g., A1 anchored
-- to enforcement.legacy.base.monthly.test has the same tuple as the
-- standard catalog row at that address). Path 1 fix from pre-flight
-- ask 14: drop + replace with two partial UNIQUE indexes.
--
-- The two indexes together cover:
--   • Standard rows: unique by (track, tier, line_item, cycle, mode)
--     when proposal_code_id IS NULL (semantically: "one standard
--     catalog Price per logical address per mode"). All 30 existing
--     rows satisfy this and migrate transparently.
--   • Proposal rows: unique by (proposal_code_id, line_item, cycle,
--     mode) when proposal_code_id IS NOT NULL (semantically: "one
--     Price per (line_item, cycle, mode) per proposal code"). The
--     issue-button re-runs in commit 2 rely on this for idempotency
--     alongside the lookup_key probe.
--
-- The existing UNIQUE on stripe_prices.stripe_price_id (B66.2a) stays
-- intact and continues to prevent the same Stripe Price from backing
-- two rows regardless of standard/proposal distinction. All B66.2a
-- CHECK constraints stay intact and apply to both row types.

ALTER TABLE stripe_prices
  DROP CONSTRAINT IF EXISTS stripe_prices_unique_combo;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_prices_unique_combo_standard
  ON stripe_prices (tier_track, tier_name, line_item, cycle, mode)
  WHERE proposal_code_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_prices_unique_combo_proposal
  ON stripe_prices (proposal_code_id, line_item, cycle, mode)
  WHERE proposal_code_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — redeem_proposal_code() body update
-- ════════════════════════════════════════════════════════════════════
-- Single behavioral change: the INSERT INTO companies now sets
-- acquisition_channel = 'proposal_code' explicitly. Function signature
-- is unchanged from B65.4 (10 args, p_address as 8th positional with
-- DEFAULT NULL), so CREATE OR REPLACE replaces in place. Body is
-- byte-identical to B65.4 (migration 20260521_b65_4_redeem_signature_
-- address.sql) except for the two-line acquisition_channel addition
-- to the INSERT.
--
-- The /admin/proposal-codes/[code] "Apply to Company" manual modal
-- (a parallel admin-side redemption path that bypasses this RPC) gets
-- a one-line acquisition_channel='proposal_code' addition in commit
-- 2, keeping the two paths consistent.
--
-- B82/named-5 GRANT discipline preserved by REPLACE (Postgres
-- preserves function-level privileges across CREATE OR REPLACE when
-- the signature matches exactly). The REVOKE-from-PUBLIC + GRANT-to-
-- authenticated block is re-applied defensively at the bottom of
-- this PART so the migration is self-documenting and re-apply-safe
-- against a hypothetical fresh DB.

CREATE OR REPLACE FUNCTION redeem_proposal_code(
  p_code                   TEXT,
  p_user_id                UUID,
  p_company_name           TEXT,
  p_primary_contact_name   TEXT,
  p_primary_contact_phone  TEXT,
  p_tos_version            TEXT,
  p_privacy_version        TEXT,
  p_address                TEXT DEFAULT NULL,
  p_ip_address             INET DEFAULT NULL,
  p_user_agent             TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_code          proposal_codes%ROWTYPE;
  v_company_id    BIGINT;
BEGIN
  -- ── Auth sanity ──────────────────────────────────────────────────
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;
  IF v_caller_uid <> p_user_id THEN
    RAISE EXCEPTION 'auth.uid mismatch with p_user_id' USING ERRCODE = 'check_violation';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller_uid LIMIT 1;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'caller email not found' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Required-field sanity ────────────────────────────────────────
  IF p_company_name IS NULL OR length(trim(p_company_name)) = 0 THEN
    RAISE EXCEPTION 'company_name required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_tos_version IS NULL OR p_privacy_version IS NULL THEN
    RAISE EXCEPTION 'tos_version and privacy_version required' USING ERRCODE = 'check_violation';
  END IF;

  -- ── Validate code under row lock (prevents double-redeem race) ───
  SELECT * INTO v_code FROM proposal_codes WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'code not found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.status <> 'issued' THEN
    RAISE EXCEPTION 'code not redeemable (status=%)' , v_code.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'check_violation';
  END IF;
  IF v_code.base_tier IS NULL OR v_code.base_tier_type IS NULL THEN
    RAISE EXCEPTION 'code missing base tier/tier_type — not self-serve-ready' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM companies WHERE name ILIKE p_company_name) THEN
    RAISE EXCEPTION 'company name already in use' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Create company in configuring state ───────────────────────
  INSERT INTO companies (
    name, tier, tier_type,
    primary_contact_name, phone,
    address,
    acquisition_channel,
    is_active
  ) VALUES (
    p_company_name,
    v_code.base_tier,
    v_code.base_tier_type,
    p_primary_contact_name,
    p_primary_contact_phone,
    p_address,
    'proposal_code',
    TRUE
  )
  RETURNING id INTO v_company_id;

  -- ── 2. Insert user_roles row (company_admin, no property scope) ──
  INSERT INTO user_roles (email, role, company, property)
  VALUES (
    lower(v_caller_email),
    'company_admin',
    p_company_name,
    '{}'::text[]
  );

  -- ── 3. Link the code to the new company + flip status ────────────
  UPDATE proposal_codes
  SET company_id = v_company_id,
      status     = 'redeemed',
      redeemed_at = now()
  WHERE id = v_code.id;

  -- ── 4. Record legal acceptance ───────────────────────────────────
  INSERT INTO tos_acceptances (
    user_id, company_id, tos_version, privacy_version,
    ip_address, user_agent
  ) VALUES (
    v_caller_uid, v_company_id, p_tos_version, p_privacy_version,
    p_ip_address, p_user_agent
  );

  -- ── 5. Activate the account ──────────────────────────────────────
  UPDATE companies SET account_state = 'active' WHERE id = v_company_id;

  RETURN v_company_id;
END;
$$;

-- B82/named-5 GRANT discipline (defensive re-apply; preserved across
-- CREATE OR REPLACE automatically but re-stated for self-documentation
-- and re-apply-safety on fresh DBs).
REVOKE EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_proposal_code(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT
) TO authenticated;
-- Deliberately NOT granted to anon. Caller must hold a session.

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. proposal_codes.lock_in_duration column + CHECK ──────────────
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'proposal_codes'
--     AND column_name = 'lock_in_duration';
--   -- Expected: 1 row — lock_in_duration | integer | YES
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'proposal_codes_lock_in_duration_valid';
--   -- Expected: 1 row — CHECK ((lock_in_duration IS NULL) OR ((lock_in_duration >= 1) AND (lock_in_duration <= 36)))
--
-- ── B. companies.acquisition_channel column + CHECK ────────────────
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'companies'
--     AND column_name = 'acquisition_channel';
--   -- Expected: 1 row — acquisition_channel | text | YES | NULL
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'companies_acquisition_channel_valid';
--   -- Expected: 1 row — CHECK ((acquisition_channel IS NULL) OR (acquisition_channel = ANY (ARRAY['self_serve'::text, 'proposal_code'::text])))
--
-- ── C. companies.acquisition_channel backfill complete ─────────────
--   SELECT acquisition_channel, COUNT(*) FROM companies GROUP BY acquisition_channel ORDER BY acquisition_channel NULLS FIRST;
--   -- Expected: 0 rows with NULL; all existing companies have 'proposal_code'.
--   -- If self-serve has somehow already shipped (B66.3+), a 'self_serve' bucket may also appear.
--
-- ── D. stripe_prices.proposal_code_id column + FK ──────────────────
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'stripe_prices'
--     AND column_name = 'proposal_code_id';
--   -- Expected: 1 row — proposal_code_id | bigint | YES
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'stripe_prices'::regclass
--     AND contype = 'f'
--     AND conname LIKE '%proposal_code_id%';
--   -- Expected: 1 row — FOREIGN KEY (proposal_code_id) REFERENCES proposal_codes(id) ON DELETE RESTRICT
--
-- ── E. Old composite UNIQUE constraint dropped ─────────────────────
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'stripe_prices'::regclass
--     AND conname = 'stripe_prices_unique_combo';
--   -- Expected: 0 rows. Constraint dropped by PART 4.
--
-- ── F. Two new partial UNIQUE indexes exist ────────────────────────
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND tablename = 'stripe_prices'
--     AND indexname IN (
--       'stripe_prices_unique_combo_standard',
--       'stripe_prices_unique_combo_proposal',
--       'idx_stripe_prices_proposal_code_id'
--     )
--   ORDER BY indexname;
--   -- Expected: 3 rows.
--   --   idx_stripe_prices_proposal_code_id        — non-unique partial WHERE IS NOT NULL
--   --   stripe_prices_unique_combo_proposal       — UNIQUE partial WHERE IS NOT NULL on (proposal_code_id, line_item, cycle, mode)
--   --   stripe_prices_unique_combo_standard       — UNIQUE partial WHERE IS NULL on (tier_track, tier_name, line_item, cycle, mode)
--
-- ── G. redeem_proposal_code body references acquisition_channel ────
--   SELECT pg_get_functiondef(oid) ILIKE '%acquisition_channel%' AS has_ref
--   FROM pg_proc
--   WHERE proname = 'redeem_proposal_code';
--   -- Expected: 1 row, has_ref = true.
--
--   -- Also confirm exactly one signature exists (no B65.4-style overload drift):
--   SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc
--   WHERE proname = 'redeem_proposal_code';
--   -- Expected: 1 row with 10 args including p_address text DEFAULT NULL.
--
-- ── H. Existing 30 stripe_prices rows intact ───────────────────────
--   SELECT mode, COUNT(*) FROM stripe_prices
--   WHERE proposal_code_id IS NULL
--   GROUP BY mode
--   ORDER BY mode;
--   -- Expected: test | 30  (the B66.2a catalog, unchanged).
--   -- If STRIPE_MODE=live has been populated since, expect a live row too.
--
--   -- Verify the new partial UNIQUE doesn't reject any existing row:
--   SELECT tier_track, tier_name, line_item, cycle, mode, COUNT(*)
--   FROM stripe_prices
--   WHERE proposal_code_id IS NULL
--   GROUP BY tier_track, tier_name, line_item, cycle, mode
--   HAVING COUNT(*) > 1;
--   -- Expected: 0 rows. All existing standard rows are unique by the
--   -- 5-tuple, so the new partial UNIQUE migrates them transparently.
--
-- ── OPTIONAL NEGATIVE TESTS (destructive — dev/staging only) ────────
-- These confirm constraints actually enforce. Run with service_role
-- (admin RLS would gate them otherwise). Roll back if non-dev.
--
-- N1. lock_in_duration out of range rejected:
--   INSERT INTO proposal_codes (code, status, lock_in_duration)
--   VALUES ('TEST-LOCKIN-OOR', 'draft', 0);
--   -- Expected: CHECK violation on proposal_codes_lock_in_duration_valid.
--
-- N2. acquisition_channel bad value rejected:
--   UPDATE companies SET acquisition_channel = 'invalid' WHERE id = (SELECT id FROM companies LIMIT 1);
--   -- Expected: CHECK violation on companies_acquisition_channel_valid.
--
-- N3. Proposal-row duplicate rejected:
--   -- (Requires a proposal_code row to exist; substitute a real id.)
--   INSERT INTO stripe_prices (
--     stripe_price_id, stripe_product_id, tier_track, tier_name,
--     line_item, cycle, unit_amount_cents, mode, lookup_key, proposal_code_id
--   ) VALUES
--     ('price_test_dup_a', 'prod_test', 'enforcement', 'legacy', 'base', 'monthly', 12900, 'test', 'sml.proposal.TEST-X.base.monthly', 999),
--     ('price_test_dup_b', 'prod_test', 'enforcement', 'legacy', 'base', 'monthly', 12900, 'test', 'sml.proposal.TEST-X.base.monthly', 999);
--   -- Expected: UNIQUE violation on stripe_prices_unique_combo_proposal.
--
-- N4. Standard + proposal at same 5-tuple coexist:
--   -- This is the WHOLE POINT of the partial UNIQUE split — the
--   -- standard row at (enforcement, legacy, base, monthly, test)
--   -- already exists in the catalog. Adding a proposal-row at the
--   -- same 5-tuple (different proposal_code_id) must NOT raise.
--   INSERT INTO stripe_prices (
--     stripe_price_id, stripe_product_id, tier_track, tier_name,
--     line_item, cycle, unit_amount_cents, mode, lookup_key, proposal_code_id
--   ) VALUES (
--     'price_test_coexist', 'prod_test', 'enforcement', 'legacy',
--     'base', 'monthly', 9900, 'test', 'sml.proposal.TEST-COEXIST.base.monthly', 999
--   );
--   -- Expected: succeeds (no violation). Clean up afterward.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL is idempotent:
--   • ADD COLUMN IF NOT EXISTS
--   • DO $$ BEGIN IF NOT EXISTS ... ADD CONSTRAINT
--   • DROP CONSTRAINT IF EXISTS
--   • CREATE [UNIQUE] INDEX IF NOT EXISTS
--   • CREATE OR REPLACE FUNCTION
--   • UPDATE ... WHERE acquisition_channel IS NULL (no-op on re-apply)
-- BEGIN/COMMIT atomic — any failure rolls back the entire transaction.
-- Safe to re-apply after fixing.
-- ════════════════════════════════════════════════════════════════════
