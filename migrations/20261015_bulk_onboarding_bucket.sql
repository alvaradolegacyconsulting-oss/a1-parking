-- ════════════════════════════════════════════════════════════════════
-- PHASE A — bulk-onboarding bucket + CA upload policy
-- ════════════════════════════════════════════════════════════════════
-- Mirrors migrations/20260519_b51a_storage_bucket_authorization.sql
-- (property-authorizations), which is the only CA-scoped storage
-- surface in production and has held for five months. The mirror is of
-- the PREDICATE SHAPE, not the command: auth_pdf_ca_all is FOR ALL,
-- and this one is INSERT ONLY.
--
-- 🔴 NO UPDATE AND NO DELETE POLICY, FOR ANY ROLE. A submitted file
-- must not change or disappear between submission and Jose's review.
-- service_role bypasses RLS, so the loader and the retention job still
-- work; nothing a browser holds can rewrite or remove a submission.
--
-- 🔴 MIME IS A CONVENIENCE FILTER, NOT AN ACCESS CONTROL. Proven this
-- morning: the first anon probe of the allow-all hole was refused on
-- content type and nearly read as "RLS stopped it". The list below is
-- wide on purpose — Windows with Excel installed sends .csv as
-- application/vnd.ms-excel, other machines send text/plain or
-- application/octet-stream, and a text/csv-only list would reject A1's
-- real files at the storage layer with an unhelpful error. The route
-- does the real check: UTF-8, parses as CSV, exact header.
--
-- ── PATH SHAPE: {property_id}/{uuid}.csv ────────────────────────────
-- 🔴 DEVIATION from the approved spec, which said {company_id}/. Three
-- reasons, and it is a one-line flip back if the ruling stands:
--   1. One property per file is already a hard rule in the customer
--      instructions, and import_batches.property_id already exists —
--      so the property is known before the upload either way.
--   2. It is strictly narrower. Under a company prefix a CA can park a
--      file that names no property; under a property prefix storage
--      itself binds the file to one property they demonstrably own.
--   3. 🔴 It removes a trust boundary from the route. The route must
--      not trust the client's path, so with the property id IN the
--      path it derives the property FROM the path and there is no
--      second property identity in the payload to disagree with it.
-- A company prefix would need companies.id, and properties has no
-- company_id yet (that is the filed audit-view arc), so it would also
-- mean a new join this one does not need.
--
-- 🔴 batches/ IS OUTSIDE WHAT THIS POLICY CAN WRITE, BY PATTERN.
-- The immutable per-batch copy lives at batches/{batch_id}.csv. The
-- CA policy is anchored on '^[0-9]+/', and 'batches' is not digits, so
-- the prefix is unreachable rather than merely unlisted. The regex is
-- also why the cast below is wrapped in a CASE: 'batches'::BIGINT
-- raises 22P02, and AND is not guaranteed to short-circuit, so an
-- unguarded cast would make a denial arrive as a cast error.

BEGIN;

-- ── 1. Bucket ───────────────────────────────────────────────────────
-- 2 MB against a 1,000-row ceiling: a 1,000-row file of this shape is
-- ~120 KB, so the cap is ~17x headroom and still small enough that a
-- wrong file cannot fill the bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bulk-onboarding',
  'bulk-onboarding',
  FALSE,
  2097152,
  ARRAY['text/csv','application/vnd.ms-excel','text/plain','application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. Authority helper ─────────────────────────────────────────────
-- SECURITY DEFINER so the policy does not depend on whether a CA can
-- SELECT companies under RLS, and so the flag lives in one place that
-- the route can call too.
--
-- 🔴 Equality on lower(trim(...)), never ILIKE. The existing storage
-- policies compare company names with ILIKE, where an unchecked value
-- is the pattern; properties.company and companies.name carry a
-- metacharacter CHECK (20260901) but user_roles.company does not.
-- Equality has no pattern side at all, and trim() also covers the
-- trailing-whitespace class that bit property 138.
--
-- 🔴 ur.is_active is checked here because get_my_role() does not; a
-- deactivated CA row still returns 'company_admin' from that helper.
--
-- Suspended tenants: excluded via account_state. past_due is allowed
-- through, because a tenant inside the dunning grace window is still
-- operating and nothing here charges them. configuring is allowed
-- because the flag plus Jose's manual approval already gate the load.
CREATE OR REPLACE FUNCTION public.may_bulk_upload_at(p_property_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.properties p ON p.id = p_property_id
      JOIN public.companies  c ON lower(trim(c.name)) = lower(trim(p.company))
     WHERE lower(trim(ur.email)) = lower(trim(auth.jwt() ->> 'email'))
       AND ur.role = 'company_admin'
       AND ur.is_active
       AND lower(trim(ur.company)) = lower(trim(p.company))
       AND p.is_active
       AND c.is_active
       AND c.account_state NOT IN ('suspended','cancelled')
       AND c.bulk_onboarding_enabled
  )
$fn$;

COMMENT ON FUNCTION public.may_bulk_upload_at(BIGINT) IS
  'Phase A: may the JWT holder upload a bulk-onboarding CSV for this property? '
  'Active company_admin of the property''s company, property active, company active '
  'and not suspended/cancelled, and companies.bulk_onboarding_enabled. '
  'NULL p_property_id returns FALSE (the join on p.id finds nothing). '
  'DEFINER so the storage policy does not depend on companies being CA-readable.';

-- A SECURITY DEFINER function inherits EXECUTE to PUBLIC by Supabase
-- default; revoke before granting.
REVOKE ALL ON FUNCTION public.may_bulk_upload_at(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.may_bulk_upload_at(BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.may_bulk_upload_at(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.may_bulk_upload_at(BIGINT) TO service_role;

-- ── 3. Policies on storage.objects ──────────────────────────────────
-- Both name bucket_id. A policy that names none applies to every
-- future bucket the moment it is created, which is exactly the hole
-- dropped this morning.

-- 3a. company_admin: INSERT only, own property's prefix only.
DROP POLICY IF EXISTS "bulk_csv_ca_insert" ON storage.objects;
CREATE POLICY "bulk_csv_ca_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'bulk-onboarding'
    AND storage.objects.name ~ '^[0-9]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$'
    AND public.may_bulk_upload_at(
          (CASE WHEN split_part(storage.objects.name, '/', 1) ~ '^[0-9]+$'
                THEN split_part(storage.objects.name, '/', 1)::BIGINT END))
  );

-- 3b. super admin: read the whole bucket, including batches/.
-- Reviewing a batch means reading the file that was submitted, and the
-- immutable copy is the one the loader will hash. SELECT only: Jose
-- approves through import_batches, not by editing objects.
--
-- get_my_role() is the established idiom for this (auth_pdf_admin_all
-- uses it) and is kept for consistency. It does not check
-- user_roles.is_active; that gap is a pre-existing class across every
-- admin policy, not something this file changes.
DROP POLICY IF EXISTS "bulk_csv_admin_select" ON storage.objects;
CREATE POLICY "bulk_csv_admin_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'bulk-onboarding'
    AND get_my_role() = 'admin'
  );

-- No CA SELECT policy: the CA sees their submission through
-- import_batches (which has two SELECT policies), not by listing
-- objects. No UPDATE policy anywhere, so upsert cannot overwrite. No
-- DELETE policy anywhere, so a submission cannot be withdrawn from the
-- browser. No anon policy, and no policy granted to PUBLIC.

COMMIT;
