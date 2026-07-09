-- ════════════════════════════════════════════════════════════════════
-- B237 — proposal_codes CHECK constraints — widen for 3-tier canonical
-- 2026-07-08
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   1. Widens proposal_codes_base_tier_valid to admit the canonical
--      3-tier values ('pm_only','enforcement_only','legacy') alongside
--      the pre-canonical 6-tier + premium names that shipped in
--      20260520_b89_proposal_codes_premium.sql.
--   2. Adds a companion proposal_codes_base_tier_type_valid CHECK
--      admitting only ('enforcement','property_management') — the two
--      values the form submits and the executor branches on. There is
--      no CHECK on base_tier_type today; parity gap.
--
-- WHY
--   The admin proposal-code form (app/admin/proposal-codes/new/page.tsx:57-58)
--   submits base_tier ∈ {'enforcement_only', 'pm_only', 'legacy'} and
--   base_tier_type ∈ {'enforcement', 'property_management'}. Legacy
--   passes the pre-B237 CHECK (it's in the 7-value list already), but
--   PM-Only and Enforcement-Only submissions rejected as of 2026-07-08
--   with `violates check constraint "proposal_codes_base_tier_valid"`.
--   Live blocker for issuing anything other than Legacy proposal codes.
--   4th straggler from the 3-tier pivot (B232, B233, Commit 2 overload
--   were the first three).
--
-- WHY THE INCLUSIVE LIST (not tight 3-value)
--   Prod distinct query (2026-07-08) returned 30 rows with 5 pre-
--   canonical stragglers:
--     starter | enforcement          × 1
--     growth | enforcement           × 1
--     essential | property_management × 2
--     enterprise | property_management × 1
--     (plus 24 legacy + 1 NULL)
--   A tight 3-value CHECK would fail on ADD because those rows are
--   valid history. Per Jose's decision-tree: preserve historical rows
--   inclusively now; the pre-launch wipe zeroes proposal_codes anyway,
--   so a post-wipe tightening migration to the canonical 3-value list
--   is trivial (drop this CHECK, re-add tight). Backlog candidate.
--   Same Surprise-C posture as tos_acceptances_document_type_valid
--   keeping 'tos_and_privacy' indefinitely.
--
-- WHAT ABOUT 'premium'
--   Kept in the whitelist. Premium codes are contact-sales/manual-
--   invoice per B89; the form doesn't offer 'premium' in the current
--   admin dropdown but the executor still branches on
--   base_tier === 'premium' (app/lib/proposal-code-stripe.ts:132) to
--   bypass Stripe Price creation. Retain for the escape hatch.
--
-- DISCIPLINE
--   Guarded single migration. DROP + guarded ADD (Postgres has no
--   ALTER CHECK CONSTRAINT in-place). Single BEGIN/COMMIT per
--   [[feedback_sql_editor_partial_apply]]. Dollar-tag $body$ per
--   [[feedback_sql_editor_dollar_quote_parsing]].
--
-- ROLLBACK
--   \i 20260520_b89_proposal_codes_premium.sql re-adds the 7-value
--   CHECK (would still cover pre-B237 rows). Drop the new
--   base_tier_type CHECK by name. Schema-safe.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Widen proposal_codes_base_tier_valid ─────────────────
ALTER TABLE proposal_codes
  DROP CONSTRAINT IF EXISTS proposal_codes_base_tier_valid;

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_base_tier_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_base_tier_valid
      CHECK (base_tier IS NULL OR base_tier IN (
        -- Canonical 3-tier (form submits ONLY these three today)
        'pm_only', 'enforcement_only', 'legacy',
        -- Escape hatch: contact-sales tier, executor branches on this
        'premium',
        -- Pre-canonical 6-tier names retained for historical rows
        -- (5 rows on 2026-07-08; wiped pre-launch, then tighten in a
        -- follow-up migration).
        'starter', 'growth',
        'essential', 'professional', 'enterprise'
      ));
  END IF;
END
$body$;

-- ── PART 2 — Add companion base_tier_type CHECK ───────────────────
ALTER TABLE proposal_codes
  DROP CONSTRAINT IF EXISTS proposal_codes_base_tier_type_valid;

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_base_tier_type_valid'
  ) THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_base_tier_type_valid
      CHECK (base_tier_type IS NULL OR base_tier_type IN (
        'enforcement', 'property_management'
      ));
  END IF;
END
$body$;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PROPOSAL_CODES_TIER_CHECK_WIDEN',
  'pg_constraint',
  NULL,
  jsonb_build_object(
    'migration', '20260708_b237_proposal_codes_tier_check_widen',
    'change',    'proposal_codes_base_tier_valid widened from 7-value pre-canonical to 10-value inclusive (canonical 3 + premium + 5 pre-canonical for historical rows); companion proposal_codes_base_tier_type_valid CHECK added admitting (enforcement, property_management)',
    'rationale', 'B237 — PM-Only + Enforcement-Only proposal-code issuance blocked by pre-canonical CHECK; 4th straggler from 3-tier pivot after B232/B233/Commit 2 overload. Inclusive list preserves 5 historical rows; post-wipe tighten to canonical 3 is trivial follow-up.'
  ),
  now()
);

COMMIT;
