-- ══════════════════════════════════════════════════════════════════════
-- 20260907_storage_drop_wildcard_select.sql
--
-- 🔴 Closes the 473-object anon-enumeration exposure on violation-photos.
--
-- ── FINDING ─────────────────────────────────────────────────────────
-- Sep 7 2026 pre-apply enumeration on storage.objects surfaced two
-- unscoped PUBLIC wildcard policies dashboard-created early in project
-- life (never in migrations/):
--
--   allow all uploads 1vw1xyh_0  (INSERT, USING null, WITH CHECK true, PUBLIC)
--   allow all uploads 1vw1xyh_1  (SELECT, USING true,                PUBLIC)
--
-- Bucket-count audit revealed 473 live violation photos in the
-- `violation-photos` bucket (public=true, newest from Sept 6, actively
-- produced by A1). The public bucket flag makes any object readable
-- via CDN URL by anyone WHO KNOWS THE URL. The wildcard SELECT above
-- lets anon LIST the bucket via /storage/v1/object/list — obtaining
-- all 473 filenames. Enumeration + public read = full download.
--
-- The June 2026 acceptance note at 20260610_a1_tow_ticket_view_token.sql:
-- 269-272 accepted the "tow photos low-PII; bucket pre-exists this
-- build" tradeoff on the assumption someone would need to KNOW the
-- URL. The wildcard SELECT hands over the INDEX; that changes the
-- tradeoff.
--
-- Photographs are of vehicles, plates, and locations tied to tow
-- events involving identifiable people, belonging to a live customer
-- (A1). Enumeration is the acute exposure.
--
-- ── THIS COMMIT ─────────────────────────────────────────────────────
-- Drops "allow all uploads 1vw1xyh_1" (the SELECT wildcard) ONLY.
-- The INSERT wildcard 1vw1xyh_0 stays for now — driver + CA violation
-- photo upload depends on it and needs scoped replacement policies
-- BEFORE it can drop. Split per Mateo Sep 7: "The two wildcards do
-- not need to move together, and treating them as a pair is what's
-- been holding this up."
--
-- ── DROP IS SAFE ────────────────────────────────────────────────────
-- Verified pre-apply:
--   • grep of app/ for `.list(` on storage returned ZERO hits — nothing
--     in production lists buckets. Object references live in
--     violation_photos.photo_url as full CDN URLs, rendered directly.
--   • Public buckets (violation-photos, violation-videos, logos)
--     bypass storage.objects RLS for READS entirely — the CDN serves
--     via the bucket public flag, not the wildcard policy. Nothing
--     visible in those buckets stops being visible after this drop.
--   • Private buckets (property-authorizations, proposal-pdfs) each
--     hold exactly ONE stale test object (bucket-count audit). Each
--     has scoped SELECT policies (auth_pdf_*, admin_all_proposal_pdfs,
--     company_admin_read_redeemed_proposal_pdf). Even if a scoped
--     policy has a bug, blast radius is one orphaned test PDF and
--     one test proposal — verifiable post-drop.
--
-- ── RESTORE STATEMENT (staged in clipboard before apply) ────────────
-- If ANY scoped read fails post-drop, fire this to restore:
--
--   CREATE POLICY "allow all uploads 1vw1xyh_1" ON storage.objects
--     FOR SELECT TO PUBLIC USING (true);
--
-- That regenerates the exact predicate + role targeting the drop
-- removed (per Block 1 output: polcmd='r', using_expr='true',
-- polroles={0}). Then investigate the failing scoped policy in a
-- separate arc.
--
-- ── DOES NOT ADDRESS (filed separately) ─────────────────────────────
-- 1. INSERT wildcard 1vw1xyh_0 — awaits scoped replacements for
--    violation-photos + violation-videos + verified driver upload
--    smoke, then drops in its own commit.
-- 2. Storage-wipe gap — the June pre-launch wipe cleared DB rows but
--    left 473 storage objects in violation-photos + 25 in
--    violation-videos + 22 in logos. Some fraction are orphans whose
--    violation_photos rows no longer exist. Quantify + wipe procedure
--    update filed as follow-up.
-- 3. file_size_limit / allowed_mime_types on public buckets — filed
--    with the INSERT-wildcard-replacement commit (same edit surface).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Drop the SELECT wildcard ────────────────────────────────────
DROP POLICY IF EXISTS "allow all uploads 1vw1xyh_1" ON storage.objects;


-- ── 2. Audit row ───────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_STORAGE_DROP_WILDCARD_SELECT',
  'storage.objects',
  'allow all uploads 1vw1xyh_1',
  jsonb_build_object(
    'migration',            '20260907_storage_drop_wildcard_select',
    'arc',                  'Storage remediation Sept 7 — anon enumeration close (473 violation photos + others)',
    'dropped_policy',       jsonb_build_object(
      'name',                 'allow all uploads 1vw1xyh_1',
      'cmd',                  'SELECT (r)',
      'roles',                'PUBLIC ({0})',
      'using_expr',           'true (unscoped — matched every bucket, every anon caller)',
      'created_via',          'Supabase Dashboard (name shape 1vw1xyh_*; never entered migrations/)'
    ),
    'primary_exposure_closed', 'Anon LIST on violation-photos (473 live photos) — public bucket + wildcard SELECT enabled enumeration; drop removes enumeration',
    'sibling_wildcard_still_up', jsonb_build_object(
      'name',   'allow all uploads 1vw1xyh_0',
      'cmd',    'INSERT (a)',
      'reason', 'Driver + CA violation photo upload depends on it; awaits scoped replacement policies before drop'
    ),
    'app_dependency_check', 'grep of app/ for storage .list( returned 0 hits — nothing enumerates buckets; violation_photos.photo_url stores full CDN URLs rendered directly',
    'private_bucket_impact', 'property-authorizations + proposal-pdfs each hold 1 stale test object; scoped SELECT policies (auth_pdf_*, admin_all_proposal_pdfs, company_admin_read_redeemed_proposal_pdf) become load-bearing on first-ever eval — Blocks 1/2/4 re-verification post-drop confirms',
    'restore_statement',    'CREATE POLICY "allow all uploads 1vw1xyh_1" ON storage.objects FOR SELECT TO PUBLIC USING (true);',
    'follow_ups',           jsonb_build_array(
      'INSERT wildcard 1vw1xyh_0 drop after scoped replacements ship',
      'storage-wipe procedure gap (June wipe left 473+25+22 objects)',
      'orphan count query for violation-photos rows with no violation_photos row reference',
      'file_size_limit + allowed_mime_types on public buckets'
    )
  ),
  now()
);


COMMIT;
