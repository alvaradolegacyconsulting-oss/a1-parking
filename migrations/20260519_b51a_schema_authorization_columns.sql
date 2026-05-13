-- ════════════════════════════════════════════════════════════════════
-- B51a schema — towing authorization columns on properties table
-- Locked: May 19, 2026 — NOT YET APPLIED.
--
-- Adds three nullable columns to support the B51a UI MVP commit that
-- ships separately. This migration is DDL only — no RLS changes, no
-- data backfill, no Storage bucket creation. UI work + bucket creation
-- + audit-log wiring land in the follow-up B51a UI commit once these
-- columns are confirmed in production.
--
-- ── COLUMN NAMING ───────────────────────────────────────────────────
-- "towing" prefix omitted — this is a parking enforcement platform,
-- so the table context makes the domain implicit. Shorter names read
-- better in SELECT lists and INSERT/UPDATE statements.
--   - authorization_pdf_path: storage path within property-authorizations
--     bucket (e.g., "{property_id}/{timestamp}.pdf"). NOT a public URL.
--     UI generates signed URLs on read.
--   - authorization_expiration_date: DATE (date-only, no timezone) —
--     renewal deadline is a calendar concept, not a precise instant.
--   - authorization_notes: free-text 1000-char-cap enforced client-side
--     (no DB CHECK constraint; trust the form, fail soft if exceeded).
--
-- ── NULLABILITY ─────────────────────────────────────────────────────
-- All three columns are NULL-able with no DEFAULT. Existing properties
-- pre-A1-Wrecker won't have authorization data, and adding a NOT NULL
-- column with no DEFAULT would break the migration on any non-empty
-- properties table. SELECTs treat NULL as "no authorization on file"
-- per the B51a UI spec.
--
-- ── RLS NOTE (DEFERRED TO UI COMMIT) ────────────────────────────────
-- The three columns inherit the existing properties table RLS policies
-- automatically. NO new policies needed for column SELECTs/UPDATEs.
-- The follow-up UI commit will create the property-authorizations
-- Storage bucket + bucket-level RLS gating PDF reads to authorized
-- roles (super admin / CA on own company / manager on assigned property).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS authorization_pdf_path TEXT,
  ADD COLUMN IF NOT EXISTS authorization_expiration_date DATE,
  ADD COLUMN IF NOT EXISTS authorization_notes TEXT;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Columns exist with correct types + nullability ───────────────
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'properties'
--     AND column_name IN (
--       'authorization_pdf_path',
--       'authorization_expiration_date',
--       'authorization_notes'
--     )
--   ORDER BY column_name;
--   -- Expected 3 rows:
--   --   authorization_expiration_date   date    YES    NULL
--   --   authorization_notes             text    YES    NULL
--   --   authorization_pdf_path          text    YES    NULL
--
-- ── B. No existing rows broken (every property still selectable) ────
--   SELECT COUNT(*) AS total_properties,
--          COUNT(authorization_pdf_path) AS with_auth_pdf,
--          COUNT(authorization_expiration_date) AS with_auth_expiration,
--          COUNT(authorization_notes) AS with_auth_notes
--   FROM properties;
--   -- Expected: total_properties matches pre-migration COUNT(*);
--   -- the three "with_auth_*" values should all be 0 since this
--   -- migration adds no data.
--
-- ── C. Existing RLS policies still cover the new columns ────────────
-- The new columns are part of the existing properties table; they
-- inherit whatever RLS policies are already in place on properties.
-- No additional policy DDL needed for column-level SELECT/UPDATE.
-- Sanity check: confirm property reads still work for each role:
--   -- As manager.bayou@demotowing.com:
--   SELECT id, name, authorization_pdf_path FROM properties LIMIT 1;
--   -- As company_admin@demotowing.com:
--   SELECT id, name, authorization_expiration_date FROM properties LIMIT 1;
--   -- Both should succeed and return NULL in the new columns.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS is idempotent — re-applying the migration
-- on a DB that already has the columns is a no-op. Migration body is
-- DDL only inside BEGIN/COMMIT; any parse or constraint failure rolls
-- back atomically. No risk to existing data.
-- ════════════════════════════════════════════════════════════════════
