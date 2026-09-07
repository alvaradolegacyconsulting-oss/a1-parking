-- ══════════════════════════════════════════════════════════════════════
-- 20260907_retire_proposal_pdfs.sql
--
-- 🔴 Retires the proposal-pdfs runtime surface.
--
-- ── WHY ─────────────────────────────────────────────────────────────
-- The `proposals/*.pdf` hand-gen workflow (rendered locally,
-- uploaded to `proposal-pdfs` bucket, referenced by
-- `proposal_codes.pdf_url`) was NEVER EXECUTED in the app's lifetime:
--
--   proposal_codes total_rows:      1
--   proposal_codes with pdf_url:    0
--   recent_codes (90d) with pdf:    0
--
-- The design routed around it (Founding Member offer for A1 Wrecker
-- went via direct link, not PDF). The bucket accumulated one orphan
-- object (`proposals/TESTPROP-YT0H.pdf` from a wiped test code) and
-- two RLS policies (one broken via cross-table EXISTS predicate that
-- couldn't evaluate correctly under permissive-OR).
--
-- Sep 7 2026 storage remediation surfaced the whole surface as
-- decorative + risky. Per Mateo Sep 7 decision: full retirement.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────
-- 1. Drop `company_admin_read_redeemed_proposal_pdf` (CA SELECT policy;
--    zero consumers even before the retirement — no CA-facing UI ever
--    called /api/proposal-codes/[id]/pdf-url).
-- 2. Drop `admin_all_proposal_pdfs` (admin FOR ALL policy).
-- 3. Delete the orphan storage object `proposals/TESTPROP-YT0H.pdf`.
-- 4. Drop the `proposal-pdfs` bucket entirely.
-- 5. Audit row.
--
-- ── WHAT THIS KEEPS ────────────────────────────────────────────────
-- • `proposal_codes.pdf_url` column: LEFT IN SCHEMA. Nullable, unused,
--   inert. A NULL column grants nothing. Dropping a column has more
--   blast radius than keeping one (per Mateo Sep 7: "retire access
--   surfaces aggressively, leave inert schema alone").
-- • `scripts/render-proposal.ts` + `docs/hand-gen-pdf.md`: retained
--   as design artifacts with retirement headers pointing at this
--   commit. Runtime path can be rebuilt from them if a future
--   proposal-PDF workflow returns (rebuild guidance in headers).
--
-- ── COMPANION APP-SIDE COMMIT ──────────────────────────────────────
-- Ships BEFORE this SQL commit (per Mateo Sep 7): removes the API
-- route, admin UI "View PDF" affordance, viewPdf() handler, and the
-- "PDF: Pending" banner. That commit shipped first so no button in
-- the admin console points at a bucket that no longer exists during
-- the intervening window.
--
-- ── APPLY DISCIPLINE ───────────────────────────────────────────────
-- 🔴 Sep 7 2026 FIRST-ATTEMPT LEARNING: Supabase installs a
-- `storage.protect_delete()` trigger that blocks direct SQL DELETE
-- on storage.objects + storage.buckets, raising 42501 with HINT
-- "Use the Storage API instead. This prevents accidental data loss
-- from orphaned objects." The initial version of this migration tried
-- DELETE FROM storage.objects + DELETE FROM storage.buckets and
-- rolled back atomically. Correct Supabase-side safety guard;
-- migration split accordingly.
--
-- This migration now handles ONLY the policy drops + audit — all
-- SQL-safe. The bucket + orphan object removal happens via a
-- companion Storage API call (Node script using service role) that
-- runs OUT OF BAND, before or after this SQL applies.
--
-- Companion Node script (Storage API path):
--   set -a; source .env.local; set +a
--   node -e '
--     const {createClient} = require("@supabase/supabase-js");
--     const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,
--                            process.env.SUPABASE_SERVICE_ROLE_KEY);
--     (async () => {
--       const e = await c.storage.emptyBucket("proposal-pdfs");
--       console.log("emptyBucket:", e.error ? "ERR "+e.error.message : "OK");
--       const d = await c.storage.deleteBucket("proposal-pdfs");
--       console.log("deleteBucket:", d.error ? "ERR "+d.error.message : "OK");
--     })();
--   '
--
-- Sequencing (either order fine — verification checks both end states):
--   Path A: SQL first → policies gone on still-existing bucket (harmless)
--           → Node deletes bucket → verification PASS
--   Path B: Node first → bucket gone; policies now attach to nothing
--           → SQL drops orphaned policies → verification PASS
--
-- 🔴 ACTUAL SEQUENCE (Sep 7 2026): Path B. Bucket + orphan object
-- removed via Storage API before this SQL applied. This migration
-- (once applied) drops the two orphaned policies + writes audit.
--
-- 🔴 STORAGE API GOTCHA observed: emptyBucket + deleteBucket run
-- back-to-back hits an eventual-consistency lag — the immediate
-- deleteBucket returns "not empty" even though the just-prior
-- emptyBucket succeeded and list confirms zero objects. Retry with
-- an explicit .remove([...]) followed by deleteBucket works. Filed
-- as a Supabase Storage SDK behavior note for future migrations
-- that drop buckets.
--
-- SQL is atomic (BEGIN/COMMIT); either policy drop rolls back with
-- the other. Re-apply is safe (DROP POLICY IF EXISTS).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Drop the CA SELECT policy (dead code even pre-retirement) ───
DROP POLICY IF EXISTS "company_admin_read_redeemed_proposal_pdf" ON storage.objects;


-- ── 2. Drop the admin FOR ALL policy ───────────────────────────────
DROP POLICY IF EXISTS "admin_all_proposal_pdfs" ON storage.objects;


-- ── 3. Audit row ───────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RETIRE_PROPOSAL_PDFS',
  'storage.buckets',
  'proposal-pdfs',
  jsonb_build_object(
    'migration',            '20260907_retire_proposal_pdfs',
    'arc',                  'Storage remediation Sept 7 — proposal-pdfs full retirement (never-used workflow)',
    'usage_evidence',       jsonb_build_object(
      'proposal_codes_total',            1,
      'proposal_codes_with_pdf_url',     0,
      'recent_90d_with_pdf',             0,
      'orphan_objects_in_bucket_pre',    1
    ),
    'dropped_policies',     jsonb_build_array(
      'company_admin_read_redeemed_proposal_pdf',
      'admin_all_proposal_pdfs'
    ),
    'dropped_bucket',       'proposal-pdfs',
    'deleted_object_count', '1 (orphan proposals/TESTPROP-YT0H.pdf)',
    'schema_kept',          'proposal_codes.pdf_url column stays in schema (nullable, unused, inert). Retire access surfaces, leave inert schema alone.',
    'artifacts_kept',       jsonb_build_array(
      'scripts/render-proposal.ts (with retirement header)',
      'docs/hand-gen-pdf.md (with retirement header)'
    ),
    'companion_app_commit', 'Removed API route /api/proposal-codes/[id]/pdf-url, admin UI View-PDF affordance (3 buttons), viewPdf() handler, PDF-Pending banner. Shipped BEFORE this SQL commit.',
    'companion_storage_api', 'Bucket + orphan object removal via Storage API (Node script — see APPLY DISCIPLINE header block for exact commands). Direct SQL DELETE blocked by storage.protect_delete() trigger; safety guard is correct.',
    'restore_path',         'If a proposal-PDF workflow returns: fresh bucket via new migration mirroring 20260519_b51a shape; SECURITY DEFINER helper instead of cross-table EXISTS; rebuild API route + admin affordance. Do NOT resurrect the retired policies.',
    'next',                 'INSERT wildcard 1vw1xyh_0 blue-green (Commit A additive + fresh-write smoke, Commit B subtractive + fresh-write smoke). Then Tow Log Commit 2.'
  ),
  now()
);


COMMIT;
