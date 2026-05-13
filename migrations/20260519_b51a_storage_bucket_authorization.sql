-- ════════════════════════════════════════════════════════════════════
-- B51a Storage bucket — property-authorizations
-- Locked: May 19, 2026 — NOT YET APPLIED.
--
-- Companion to the B51a UI commit. Schema migration 185f79f already
-- added authorization_pdf_path / authorization_expiration_date /
-- authorization_notes columns to properties. This migration creates
-- the Storage bucket the UI uploads to + RLS policies gating access.
--
-- ── BUCKET CONFIG ───────────────────────────────────────────────────
-- private (no public read), 10MB max file, application/pdf MIME only.
-- File path convention: '{property_id}/{timestamp}.pdf'
-- The property_id prefix in the path is what the RLS policies use to
-- resolve back to properties.company / properties.name for scoping.
--
-- ── RLS MATRIX ──────────────────────────────────────────────────────
--   role             SELECT  INSERT  UPDATE  DELETE
--   admin            all     all     all     all      (admin_all FOR ALL)
--   company_admin    own     own     own     own      (ca_all FOR ALL, own company)
--   manager          own     —       —       —        (manager_select scoped)
--   driver, resident, leasing_agent: implicit deny (no policy)
--
-- Path-to-property resolution: split_part(name, '/', 1)::bigint
-- extracts the property_id from the storage path. EXISTS subquery
-- against properties checks company match (CA) or property-name
-- assignment (manager). Same delegation pattern as Commit A's
-- violation_photos_select_inherits_violation policy.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Create bucket (idempotent) ───────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-authorizations',
  'property-authorizations',
  FALSE,
  10485760,                              -- 10 MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. RLS policies on storage.objects ──────────────────────────────
-- Three policies cover the matrix above. FOR ALL collapses
-- SELECT/INSERT/UPDATE/DELETE into one policy with USING + WITH CHECK
-- evaluating the same expression. Manager is SELECT-only.

-- ── 2a. admin: full access to this bucket ───────────────────────────
DROP POLICY IF EXISTS "auth_pdf_admin_all" ON storage.objects;
CREATE POLICY "auth_pdf_admin_all" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'property-authorizations'
    AND get_my_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'property-authorizations'
    AND get_my_role() = 'admin'
  );

-- ── 2b. company_admin: full access on own-company properties ────────
DROP POLICY IF EXISTS "auth_pdf_ca_all" ON storage.objects;
CREATE POLICY "auth_pdf_ca_all" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'property-authorizations'
    AND get_my_role() = 'company_admin'
    AND EXISTS (
      SELECT 1 FROM properties p
      WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
        AND p.company ILIKE get_my_company()
    )
  )
  WITH CHECK (
    bucket_id = 'property-authorizations'
    AND get_my_role() = 'company_admin'
    AND EXISTS (
      SELECT 1 FROM properties p
      WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
        AND p.company ILIKE get_my_company()
    )
  );

-- ── 2c. manager: SELECT only on assigned properties ─────────────────
-- get_my_properties() returns text[] of property NAMES; we resolve
-- property_id → properties.name and check it's in the assigned list.
-- View-only per B51a UI spec decision 1: manager doesn't edit
-- authorization documents (they're a company-admin-level concern).
DROP POLICY IF EXISTS "auth_pdf_manager_select" ON storage.objects;
CREATE POLICY "auth_pdf_manager_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'property-authorizations'
    AND get_my_role() = 'manager'
    AND EXISTS (
      SELECT 1 FROM properties p
      WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
        AND p.name ~~* ANY (get_my_properties())
    )
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Bucket exists with correct config ────────────────────────────
--   SELECT id, name, public, file_size_limit, allowed_mime_types
--   FROM storage.buckets
--   WHERE id = 'property-authorizations';
--   -- Expected: 1 row. public = false, file_size_limit = 10485760,
--   --   allowed_mime_types = {application/pdf}
--
-- ── B. Policy inventory (3 policies) ────────────────────────────────
--   SELECT polname, polcmd
--   FROM pg_policy
--   WHERE polrelid = 'storage.objects'::regclass
--     AND polname LIKE 'auth_pdf_%'
--   ORDER BY polname;
--   -- Expected (polcmd: r=SELECT, *=ALL):
--   --   auth_pdf_admin_all              *
--   --   auth_pdf_ca_all                 *
--   --   auth_pdf_manager_select         r
--
-- ── C. Inheritance smoke (after UI commit deploys + you upload a
--     test PDF for any property as a CA, then test reads as each role):
--   -- As company_admin on own property's PDF: SELECT visible.
--   -- As manager assigned to that property: SELECT visible.
--   -- As manager NOT assigned: SELECT returns 0 rows.
--   -- As driver / resident / leasing_agent: SELECT returns 0 rows.
--   -- As admin: SELECT visible regardless of company.
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- Bucket INSERT uses ON CONFLICT to be idempotent. RLS policies use
-- DROP IF EXISTS + CREATE for safe re-apply. BEGIN/COMMIT wraps the
-- whole thing — any parse failure rolls back the entire transaction
-- and existing storage state remains intact.
-- ════════════════════════════════════════════════════════════════════
