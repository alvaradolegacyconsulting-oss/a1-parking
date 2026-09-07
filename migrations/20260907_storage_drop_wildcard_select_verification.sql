-- ══════════════════════════════════════════════════════════════════════
-- 20260907_storage_drop_wildcard_select_verification.sql
--
-- Structural verification for the wildcard SELECT drop. v2 pattern
-- (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row). 5 gates.
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  Dropped policy "allow all uploads 1vw1xyh_1" NO LONGER EXISTS
--   VS2  Sibling INSERT wildcard "allow all uploads 1vw1xyh_0" STILL
--        EXISTS (this commit deliberately does NOT drop it — driver
--        upload depends on it; awaits scoped replacement)
--   VS3  Scoped SELECT policies on private buckets STILL EXIST
--        (auth_pdf_admin_all, auth_pdf_ca_all, auth_pdf_manager_select,
--         admin_all_proposal_pdfs, company_admin_read_redeemed_proposal_pdf,
--         removal_photos_admin_all, removal_photos_ca_all, removal_photos_manager_all)
--   VS4  Bucket public/private flags UNCHANGED by this migration
--        (violation-photos + violation-videos + logos still public,
--         property-authorizations + proposal-pdfs + vehicle-removal-photos
--         still private)
--   VS5  Audit row present
--
-- ── EXECUTION VERIFICATION (Jose, post-apply, out of band) ─────────
--   E1  anon list on violation-photos → 400/403 (was 200 with populated array)
--   E2  authenticated CA reads own-company auth-PDF via signed URL → SUCCESS
--        (property-authorizations scoped policy exercised for first time)
--   E3  authenticated manager reads assigned property's auth-PDF via
--        signed URL → SUCCESS (auth_pdf_manager_select exercised)
--   E4  authenticated CA reads own-company redeemed proposal PDF →
--        SUCCESS (company_admin_read_redeemed_proposal_pdf exercised)
--   E5  /ticket/view/[token] still renders violation photos (unaffected
--        — bucket public flag serves the CDN URL, not RLS)
--
-- If any E fails: the restore statement in the migration header restores
-- the wildcard immediately.
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: wildcard SELECT policy no longer exists ═══════════════════
DO $vs1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'allow all uploads 1vw1xyh_1';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: policy "allow all uploads 1vw1xyh_1" still exists (count=%). Drop did not apply.', v_count;
  END IF;
END $vs1$;


-- ── VS2: sibling INSERT wildcard STILL EXISTS (deliberate) ════════
DO $vs2$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname = 'allow all uploads 1vw1xyh_0';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS2 FAIL: sibling INSERT wildcard "allow all uploads 1vw1xyh_0" count=% (want 1 — this commit deliberately does NOT drop it; driver upload depends on it; awaits scoped replacement in follow-up commit). If 0, both wildcards were dropped and driver upload is BROKEN — investigate + restore.', v_count;
  END IF;
END $vs2$;


-- ── VS3: scoped SELECT policies on private buckets still intact ═══
DO $vs3$
DECLARE
  v_count INT;
  v_expected TEXT[] := ARRAY[
    'auth_pdf_admin_all',
    'auth_pdf_ca_all',
    'auth_pdf_manager_select',
    'admin_all_proposal_pdfs',
    'company_admin_read_redeemed_proposal_pdf',
    'removal_photos_admin_all',
    'removal_photos_ca_all',
    'removal_photos_manager_all'
  ];
  v_missing TEXT[];
BEGIN
  SELECT array_agg(name)
    INTO v_missing
    FROM (
      SELECT unnest(v_expected) AS name
      EXCEPT
      SELECT polname FROM pg_policy
       WHERE polrelid = 'storage.objects'::regclass
    ) t;
  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VS3 FAIL: scoped SELECT policies missing after drop: %', v_missing;
  END IF;
END $vs3$;


-- ── VS4: bucket public/private flags unchanged ═════════════════════
DO $vs4$
DECLARE
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  FOR v_row IN
    SELECT id, public
      FROM storage.buckets
     WHERE id IN (
       'violation-photos', 'violation-videos', 'logos',
       'property-authorizations', 'proposal-pdfs', 'vehicle-removal-photos'
     )
  LOOP
    IF v_row.id IN ('violation-photos', 'violation-videos', 'logos') AND v_row.public <> TRUE THEN
      v_bad := v_bad || format('%s should be public=TRUE (was public); ', v_row.id);
    ELSIF v_row.id IN ('property-authorizations', 'proposal-pdfs', 'vehicle-removal-photos') AND v_row.public <> FALSE THEN
      v_bad := v_bad || format('%s should be public=FALSE (was private); ', v_row.id);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS4 FAIL: bucket public/private flag drifted: %', v_bad;
  END IF;
END $vs4$;


-- ── VS5: audit row present ═════════════════════════════════════════
DO $vs5$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_STORAGE_DROP_WILDCARD_SELECT'
     AND new_values ->> 'migration' = '20260907_storage_drop_wildcard_select';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS5 FAIL: audit row missing';
  END IF;
END $vs5$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'storage_drop_wildcard_select (SELECT wildcard only; INSERT wildcard follows separately)'::TEXT AS target,
  ARRAY[
    'VS1  "allow all uploads 1vw1xyh_1" no longer exists',
    'VS2  sibling INSERT wildcard "1vw1xyh_0" STILL exists (deliberate; driver upload depends on it)',
    'VS3  8 scoped SELECT policies on private buckets still intact',
    'VS4  bucket public/private flags unchanged',
    'VS5  SCHEMA_STORAGE_DROP_WILDCARD_SELECT audit row present'
  ] AS gates_verified,
  now() AS verified_at;

-- ══════════════════════════════════════════════════════════════════
-- POST-APPLY EXECUTION CHECKS (Jose, out of band):
--
-- E1 — Anon list on violation-photos, expect denial:
--   REF=inwnwtaibumrrhsuxlly
--   KEY=<publishable anon key>
--   curl -sS -w "\nstatus=%{http_code}\n" -X POST \
--     -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"prefix":"","limit":10,"offset":0}' \
--     "https://$REF.supabase.co/storage/v1/object/list/violation-photos"
--   Expected: HTTP 400 or 403 (previously HTTP 200 with populated array).
--
-- E2 — Authenticated CA opens own-company auth-PDF (UI smoke).
--      Sign in as pm-ca@test.shieldmylot.com, open Manage → Property →
--      Authorization PDF. Expected: PDF renders in browser.
--
-- E3 — Authenticated manager opens assigned property's auth-PDF.
--      Sign in as legacy-manager@test.shieldmylot.com, open a property
--      they're assigned to (e.g. Test Legacy Property), view auth PDF.
--      Expected: PDF renders.
--
-- E4 — Authenticated CA with redeemed code opens their proposal PDF.
--      Sign in as the CA whose company has a redeemed proposal_code
--      (see Probe C fixture query), open Billing → Proposal PDF.
--      Expected: PDF renders.
--
-- E5 — /ticket/view/[token] renders violation photos (unaffected).
--      Open any existing tow-ticket public view URL. Expected: photos
--      render (served by bucket public flag; wildcard drop irrelevant).
--
-- If any of E2/E3/E4 fails: restore statement from migration header
-- fires and the failing scoped policy investigates in its own arc.
-- If E5 fails: unrelated — public bucket flag is broken somewhere
-- else; wildcard drop was not the cause.
-- ══════════════════════════════════════════════════════════════════
