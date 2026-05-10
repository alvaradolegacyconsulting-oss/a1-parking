-- ════════════════════════════════════════════════════════════════════
-- Custom Proposal Codes — Phase 1 schema additions
-- Locked: May 10, 2026
--
-- Run via Supabase SQL Editor as a single transaction.
--
-- What this does:
--   1. Add lifecycle columns to proposal_codes:
--      prefix, pdf_url, issued_at, issued_by, revoked_at, revoke_reason
--   2. Re-affirm status CHECK with all 5 lifecycle values.
--   3. Create can_generate_proposal_codes() SECURITY DEFINER helper
--      (today: admin only; future: swap body for permission flag).
--   4. Update proposal_codes_summary VIEW to expose pdf_url for
--      redeemed-company readers (decision Q4 from May 9 session).
--      Pricing columns remain excluded.
--   5. Storage RLS for the proposal-pdfs bucket. Bucket itself is
--      created via Supabase Dashboard (private, 5 MB limit, PDF only)
--      before commit 2 deploys.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Lifecycle + base-tier columns ─────────────────────────────────
-- prefix, pdf_url, issued_at, issued_by, revoked_at, revoke_reason are
-- lifecycle metadata. base_tier_type + base_tier capture the tier the
-- proposal is anchored to (so admin can override against tier defaults).
ALTER TABLE proposal_codes
  ADD COLUMN IF NOT EXISTS prefix TEXT,
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS issued_by TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason TEXT,
  ADD COLUMN IF NOT EXISTS base_tier_type TEXT,
  ADD COLUMN IF NOT EXISTS base_tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_base_tier_type_valid') THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_base_tier_type_valid
      CHECK (base_tier_type IS NULL OR base_tier_type IN ('enforcement', 'property_management'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_base_tier_valid') THEN
    ALTER TABLE proposal_codes
      ADD CONSTRAINT proposal_codes_base_tier_valid
      CHECK (base_tier IS NULL OR base_tier IN ('starter','growth','legacy','essential','professional','enterprise'));
  END IF;
END $$;

-- ── 2. Re-affirm status CHECK (no-op if already correct) ─────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_codes_status_check') THEN
    ALTER TABLE proposal_codes DROP CONSTRAINT proposal_codes_status_check;
  END IF;
  ALTER TABLE proposal_codes
    ADD CONSTRAINT proposal_codes_status_check
    CHECK (status IN ('draft', 'issued', 'redeemed', 'expired', 'revoked'));
END $$;

-- ── 3. Permission helper ─────────────────────────────────────────────
-- Today: admin only. Future: replace body with a permission-flag check
-- on user_roles or a staff_permissions table — every callsite stays.

CREATE OR REPLACE FUNCTION can_generate_proposal_codes()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN get_my_role() = 'admin';
END;
$$;

-- ── 4. proposal_codes_summary view — add pdf_url, keep pricing out ──
DROP VIEW IF EXISTS proposal_codes_summary;
CREATE VIEW proposal_codes_summary
WITH (security_barrier = true, security_invoker = false) AS
SELECT pc.id,
       pc.code,
       pc.status,
       pc.feature_overrides,
       pc.redeemed_at,
       pc.expires_at,
       pc.client_name,
       pc.client_email,
       pc.notes,
       pc.company_id,
       pc.pdf_url
FROM proposal_codes pc
WHERE pc.status = 'redeemed'
  AND pc.company_id IN (
    SELECT c.id FROM companies c
    WHERE c.name ILIKE get_my_company()
  );

GRANT SELECT ON proposal_codes_summary TO authenticated;

-- ── 5. Storage RLS for proposal-pdfs ─────────────────────────────────
-- Bucket creation is a Dashboard step (Storage → New bucket):
--   name: proposal-pdfs
--   public: OFF
--   file size limit: 5 MB
--   allowed MIME types: application/pdf
-- These policies kick in once the bucket exists. They reference the
-- bucket by id ('proposal-pdfs'), so applying the migration before the
-- bucket exists is harmless (policies just match nothing).

DROP POLICY IF EXISTS "admin_all_proposal_pdfs" ON storage.objects;
CREATE POLICY "admin_all_proposal_pdfs" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'proposal-pdfs' AND get_my_role() = 'admin')
  WITH CHECK (bucket_id = 'proposal-pdfs' AND get_my_role() = 'admin');

DROP POLICY IF EXISTS "company_admin_read_redeemed_proposal_pdf" ON storage.objects;
CREATE POLICY "company_admin_read_redeemed_proposal_pdf" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'proposal-pdfs'
    AND name LIKE 'proposals/%.pdf'
    AND EXISTS (
      SELECT 1
      FROM proposal_codes pc
      JOIN companies c ON c.id = pc.company_id
      WHERE pc.status = 'redeemed'
        AND c.name ILIKE get_my_company()
        AND ('proposals/' || pc.code || '.pdf') = storage.objects.name
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification queries (run after migration applies):
--
-- 1) New columns present:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='proposal_codes'
--     AND column_name IN ('prefix','pdf_url','issued_at','issued_by','revoked_at','revoke_reason');
--
-- 2) Status CHECK has all 5:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname='proposal_codes_status_check';
--
-- 3) Permission fn present:
--   SELECT can_generate_proposal_codes();  -- expect true if you're admin
--
-- 4) View has pdf_url:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='proposal_codes_summary'
--   ORDER BY ordinal_position;
--
-- 5) Storage policies attached:
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'storage.objects'::regclass
--     AND polname IN ('admin_all_proposal_pdfs', 'company_admin_read_redeemed_proposal_pdf');
-- ════════════════════════════════════════════════════════════════════
