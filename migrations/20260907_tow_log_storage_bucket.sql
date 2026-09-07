-- ══════════════════════════════════════════════════════════════════════
-- 20260907_tow_log_storage_bucket.sql
--
-- Tow Log Commit 1 — storage bucket + storage.objects RLS policies for
-- `vehicle-removal-photos`.
--
-- ── SCOPE ──────────────────────────────────────────────────────────
-- 1. Create private bucket `vehicle-removal-photos` with real
--    file_size_limit (enforced at the bucket, NOT a UI label — landmine
--    #2 from Sept 7 preflight: violation-photos' 10MB is a rendered
--    string with nothing behind it).
-- 2. Three RLS policies on storage.objects:
--    - admin: FOR ALL, unrestricted within this bucket
--    - company_admin: FOR ALL, scoped by properties.company EQUALITY
--    - manager: FOR ALL (not SELECT-only — managers are the primary
--      Tow Log writers; deliberate divergence from auth-PDF)
--
-- ── PREDICATE DISCIPLINE — EQUALITY NOT ILIKE ─────────────────────
-- Auth-PDF migration (20260519_b51a_storage_bucket_authorization.sql)
-- uses:
--   ca:      p.company ILIKE get_my_company()
--   manager: p.name    ~~* ANY (get_my_properties())
--
-- This migration deliberately does NOT copy those. Per Mateo Sept 7
-- design + open 24-site email~~* disclosure work + space_payments
-- discipline at 20260830_space_payments_v1_table.sql:40-58, new
-- policies use:
--   lower(trim(p.company)) = lower(trim(get_my_company()))
-- and for manager (equality against an array):
--   lower(trim(p.name)) IN (SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x)
--
-- Both close the wildcard-in-value vector without depending on the
-- companies_name_no_sql_metachar / properties_name_no_sql_metachar
-- CHECKs — belt-and-suspenders, and the pattern new PM RPCs should
-- follow uniformly.
--
-- ── PATH CONVENTION ────────────────────────────────────────────────
-- {property_id}/{removal_id}/{timestamp}-{n}.{ext}
--
-- property_id is the RLS scoping key (split_part(name, '/', 1)::bigint).
-- Following auth-PDF's split_part pattern verbatim. Malformed paths
-- (non-numeric first segment) fail the bigint cast at RLS eval —
-- consistent with auth-PDF; not a bug we introduce.
--
-- ── SIZE + MIME ────────────────────────────────────────────────────
-- file_size_limit = 15 MB (15728640 bytes). Phone camera photos are
-- typically 2-8MB; PDFs from tow operators can be larger. 15MB covers
-- the realistic upper bound without opening for arbitrary media
-- attachment. Enforced by bucket, not by client.
--
-- allowed_mime_types = image/jpeg + image/png + image/webp + application/pdf
-- Covers the 3 phone-camera output formats (heic auto-converts to jpeg
-- on modern iOS on upload) + tow-operator PDFs (ticket + receipt).
-- Bucket rejects anything else at write time.
--
-- ── APPLY DISCIPLINE ───────────────────────────────────────────────
-- BEGIN/COMMIT — atomic; failure rolls back bucket create + all 3
-- policies. Idempotent on re-apply (bucket ON CONFLICT DO UPDATE;
-- policies DROP IF EXISTS + CREATE).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- Part 1 — Create bucket (idempotent)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-removal-photos',
  'vehicle-removal-photos',
  FALSE,
  15728640,                                                            -- 15 MB (real, bucket-enforced)
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ══════════════════════════════════════════════════════════════════════
-- Part 2a — admin: FOR ALL, unrestricted within bucket
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "removal_photos_admin_all" ON storage.objects;
CREATE POLICY "removal_photos_admin_all" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'admin'
  )
  WITH CHECK (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'admin'
  );


-- ══════════════════════════════════════════════════════════════════════
-- Part 2b — company_admin: FOR ALL, own-company properties (equality)
-- ══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "removal_photos_ca_all" ON storage.objects;
CREATE POLICY "removal_photos_ca_all" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'company_admin'
    -- 🔴 Numeric-prefix guard: fail malformed paths as denials, not as
    -- 22P02 invalid_text_representation errors at RLS eval time. Path
    -- convention is {property_id}/{removal_id}/... so a well-formed
    -- name always begins with digits followed by '/'. Auth-PDF migration
    -- inherited the wart by omitting this guard — we don't repeat it.
    AND storage.objects.name ~ '^[0-9]+/'
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
         AND lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  )
  WITH CHECK (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'company_admin'
    -- 🔴 Numeric-prefix guard: fail malformed paths as denials, not as
    -- 22P02 invalid_text_representation errors at RLS eval time. Path
    -- convention is {property_id}/{removal_id}/... so a well-formed
    -- name always begins with digits followed by '/'. Auth-PDF migration
    -- inherited the wart by omitting this guard — we don't repeat it.
    AND storage.objects.name ~ '^[0-9]+/'
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
         AND lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- Part 2c — manager: FOR ALL, assigned properties (equality against array)
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 DIVERGENCE FROM AUTH-PDF: this policy is FOR ALL, not SELECT-only.
-- Managers are the primary Tow Log writers (Saturday-night lot-side
-- entry) — the whole point of the surface. auth-PDF made managers
-- SELECT-only because tow-authorization docs are a CA-level concern;
-- removals are the opposite shape.
--
-- get_my_properties() returns text[] of property NAMES. Equality against
-- the array uses IN (SELECT lower(trim(x)) FROM unnest(...)) rather
-- than ANY(...) with ILIKE — same discipline as the CA branch above.
DROP POLICY IF EXISTS "removal_photos_manager_all" ON storage.objects;
CREATE POLICY "removal_photos_manager_all" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'manager'
    -- 🔴 Numeric-prefix guard (see CA policy for rationale).
    AND storage.objects.name ~ '^[0-9]+/'
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  )
  WITH CHECK (
    bucket_id = 'vehicle-removal-photos'
    AND get_my_role() = 'manager'
    -- 🔴 Numeric-prefix guard (see CA policy for rationale).
    AND storage.objects.name ~ '^[0-9]+/'
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = split_part(storage.objects.name, '/', 1)::bigint
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- Part 3 — Audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_TOW_LOG_STORAGE_BUCKET',
  'storage.buckets',
  'vehicle-removal-photos',
  jsonb_build_object(
    'migration',            '20260907_tow_log_storage_bucket',
    'arc',                  'Tow Log Commit 1 — bucket + storage.objects RLS policies',
    'bucket_shape',         jsonb_build_object(
      'id',                   'vehicle-removal-photos',
      'public',               false,
      'file_size_limit',      15728640,
      'allowed_mime_types',   jsonb_build_array('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    ),
    'path_convention',      '{property_id}/{removal_id}/{timestamp}-{n}.{ext}',
    'policies',             jsonb_build_array(
      'removal_photos_admin_all',
      'removal_photos_ca_all',
      'removal_photos_manager_all'
    ),
    'predicate_discipline', 'EQUALITY (lower(trim(...))) for scope predicates. Deliberate divergence from auth-PDF (20260519_b51a) which uses ILIKE + ~~* ANY. Follows space_payments (20260830) + Sept 7 design. Belt-and-suspenders with the metachar CHECK on companies/properties names.',
    'manager_for_all',      'Divergence from auth-PDF (manager SELECT-only). Managers are primary Tow Log writers per design.',
    'size_limit_real',      'file_size_limit=15728640 (15MB) enforced at bucket. NOT a UI label. Landmine #2 from Sept 7 preflight: violation-photos 10MB was UI-only string with nothing behind it; ours is real.',
    'next',                 'Commit 2: tow_operators + RLS + CRUD RPCs.'
  ),
  now()
);


COMMIT;
