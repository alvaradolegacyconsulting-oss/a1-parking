-- ════════════════════════════════════════════════════════════════════
-- 🔴 HOTFIX — anon can upload into every bucket
-- ════════════════════════════════════════════════════════════════════
-- `allow all uploads 1vw1xyh_0` on storage.objects is cmd=a (INSERT),
-- roles = PUBLIC, WITH CHECK: true, and names NO bucket. With
-- anon=arwd on storage.objects, an unauthenticated caller holding the
-- public anon key can write into ANY bucket.
--
-- PROVED BY EXECUTION 2026-10-15, anonymous client:
--   property-authorizations  upload application/pdf  → ALLOWED
--   vehicle-removal-photos   upload image/png        → ALLOWED
--   logos                    upload text/plain       → ALLOWED
-- Reads ARE gated (download refused), so it is write-only. Both probe
-- objects were deleted and verified gone.
--
-- 🔴 THE FIRST PROBE WAS REFUSED BY THE MIME ALLOWLIST, NOT BY RLS.
-- With the correct content type both private buckets accepted the
-- upload. A MIME allowlist is a convenience filter, not an access
-- control — worth remembering the next time one looks like a boundary.
--
-- The generated suffix in the policy name says it was created from the
-- dashboard, which is why it appears in no migration and why only a
-- catalog capture could find it.
--
-- ── 🔴 REPLACE BEFORE DROPPING ─────────────────────────────────────
-- violation-photos and violation-videos have NO policy of their own.
-- The driver portal and the CA portal upload to them from a client
-- session, so they work ONLY because of the allow-all. Dropping it
-- alone kills driver violation photo upload — the core enforcement
-- workflow. Same shape as Stage 1c: remove a layer and something that
-- silently depended on it stops.
--
-- ── UPLOAD WRITER SWEEP (binding, done first) ──────────────────────
--   driver/page.tsx:1284         violation-photos         driver
--   driver/page.tsx:1296         violation-videos         driver   (resumable/tus)
--   company_admin:3704           violation-photos         company_admin
--   company_admin:3716           violation-videos         company_admin (resumable/tus)
--   company_admin:2124           property-authorizations  company_admin  [covered]
--   company_admin:2201           logos  upsert:true       company_admin
--   admin/page.tsx:341           logos  upsert:true       admin
--   admin_console:603            logos  upsert:true       admin
--   lib/tow-log-writes.ts        vehicle-removal-photos   manager/CA     [covered]
--
--   9 sites · 0 ANONYMOUS · ticket/view/[token] does NOT upload — it is
--   read-only through get_violation_by_view_token. So NO anon storage
--   policy is needed, interim or otherwise.
--
--   Already covered by existing per-bucket policies:
--     property-authorizations  auth_pdf_ca_all / _admin_all / _manager_select
--     vehicle-removal-photos   removal_photos_ca_all / _manager_all / _admin_all
--   Needing a replacement policy: violation-photos, violation-videos
--   Needing UPDATE added:        logos (three sites use upsert:true,
--                                and its only policy is INSERT-only)
--
-- ── no other bucket-agnostic policy exists ─────────────────────────
-- Capture §3: of nine policies on storage.objects, `allow all uploads`
-- is the ONLY one that names no bucket_id, and it is cmd=a. There is no
-- bucket-agnostic UPDATE or DELETE policy. Asserted below.

-- ════════════════════════════════════════════════════════════════════
-- STEP 0 — HAS IT BEEN USED? Run this FIRST and read it.
-- ════════════════════════════════════════════════════════════════════
-- An anonymous upload leaves owner IS NULL. Nothing here deletes
-- anything: only A1 and Jose can judge a file's provenance.
SELECT 'possible anon uploads (owner IS NULL)'::TEXT AS report,
       o.bucket_id, o.name, o.created_at,
       (o.metadata ->> 'mimetype') AS mimetype,
       (o.metadata ->> 'size')     AS size_bytes
  FROM storage.objects o
 WHERE o.owner IS NULL
 ORDER BY o.bucket_id, o.created_at DESC;

-- And anything in the public buckets that does not match the app's
-- path shape (`<unix-ms>-<filename>`), which is how a planted file
-- would stand out.
SELECT 'public-bucket paths not matching the app shape'::TEXT AS report,
       o.bucket_id, o.name, o.created_at, o.owner
  FROM storage.objects o
 WHERE o.bucket_id IN ('violation-photos','violation-videos')
   AND o.name !~ '^[0-9]{10,}-'
 ORDER BY o.created_at DESC;

-- ════════════════════════════════════════════════════════════════════
-- STEP 1 — REPLACE: scoped policies for what the sweep found
-- ════════════════════════════════════════════════════════════════════
-- 🔴 Scoped to `authenticated`, NOT to specific roles. The sweep shows
-- driver and company_admin uploading violation media, but the manager
-- portal carries tow-ticket flows and a path the sweep missed would
-- break enforcement on contact. The security gain here is entirely
-- "signed in, not anonymous" — narrowing further buys almost nothing
-- against a PUBLIC-read bucket and risks the prime directive. Same
-- shape as the existing `authenticated upload logos` policy.
DROP POLICY IF EXISTS violation_media_authenticated_insert ON storage.objects;
CREATE POLICY violation_media_authenticated_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('violation-photos', 'violation-videos')
    AND auth.role() = 'authenticated'
  );

-- logos: three sites use upsert:true, and the only existing logos
-- policy is INSERT-only. An upsert that REPLACES an object needs
-- UPDATE, so replacing a company logo may already be failing today;
-- adding it can only improve matters and the gate proves upload works.
DROP POLICY IF EXISTS logos_authenticated_update ON storage.objects;
CREATE POLICY logos_authenticated_update ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'logos' AND auth.role() = 'authenticated')
  WITH CHECK (bucket_id = 'logos' AND auth.role() = 'authenticated');

-- ════════════════════════════════════════════════════════════════════
-- STEP 2 — then DROP the allow-all
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "allow all uploads 1vw1xyh_0" ON storage.objects;

-- ════════════════════════════════════════════════════════════════════
-- STEP 3 — PROOF
-- ════════════════════════════════════════════════════════════════════
SELECT
  'storage allow-all removed'::TEXT AS target,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='storage.objects'::regclass
      AND polname = 'allow all uploads 1vw1xyh_0')                        AS allow_all_want_0,
  -- 🔴 No policy may be bucket-agnostic. One that names no bucket_id
  -- applies to every FUTURE bucket the moment it is created — which is
  -- what made this reachable, and what would undo the bulk-onboarding
  -- bucket before it existed.
  (SELECT count(*) FROM pg_policy pol
    WHERE pol.polrelid='storage.objects'::regclass
      AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')
        || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) !~ 'bucket_id') AS bucket_agnostic_want_0,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='storage.objects'::regclass AND polcmd='a')            AS insert_policies,
  (SELECT count(*) FROM pg_policy
    WHERE polrelid='storage.objects'::regclass)                           AS total_policies,
  (SELECT count(*) FROM storage.objects WHERE owner IS NULL)              AS owner_null_objects,
  'Run npm run verify:storagepolicies next: anon refused on all five buckets WITH A CORRECT MIME TYPE, and driver / CA / authorization-PDF / logo uploads all still work.'::TEXT AS next_step;
