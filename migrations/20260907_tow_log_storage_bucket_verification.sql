-- ══════════════════════════════════════════════════════════════════════
-- 20260907_tow_log_storage_bucket_verification.sql
--
-- STRUCTURAL gates only for Tow Log Commit 1. v2 pattern (no
-- BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
--
-- ── SCOPE ──────────────────────────────────────────────────────────
-- Booleans and OIDs only. NO rendered SQL string assertions.
-- pg_get_expr output is for human review, never a gate — lower(trim(x))
-- and other expressions render in ways that break string comparison
-- (feedback_gates_must_assert_what_they_measured item 8).
--
-- EXECUTION GATES are a SEPARATE follow-up. This file cannot assert
-- that a manager at property A is denied writes under property B's
-- prefix — that requires Jose to trigger each denial by hand first,
-- read the actual message, and then the assertions get written from
-- the empirical text.
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1  bucket `vehicle-removal-photos` exists
--   VS2  bucket public = FALSE
--   VS3  bucket file_size_limit = 15728640 (15 MB)
--   VS4  bucket allowed_mime_types = image/jpeg + image/png + image/webp + application/pdf
--   VS5  3 policies exist on storage.objects with expected names
--   VS6  all 3 policies have polcmd = '*' (FOR ALL)
--   VS7  no policy grants anon (polroles excludes anon.oid)
--   VS8  audit row present
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: bucket exists ══════════════════════════════════════════════
DO $vs1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM storage.buckets
   WHERE id = 'vehicle-removal-photos';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: bucket vehicle-removal-photos not found (count=%)', v_count;
  END IF;
END $vs1$;


-- ── VS2: public = FALSE ═════════════════════════════════════════════
DO $vs2$
DECLARE v_public BOOLEAN;
BEGIN
  SELECT public INTO v_public
    FROM storage.buckets
   WHERE id = 'vehicle-removal-photos';
  IF v_public IS NOT FALSE THEN
    RAISE EXCEPTION 'VS2 FAIL: bucket public=% (want FALSE — private bucket, signed URLs only)', v_public;
  END IF;
END $vs2$;


-- ── VS3: file_size_limit = 15 MB ════════════════════════════════════
DO $vs3$
DECLARE v_limit BIGINT;
BEGIN
  SELECT file_size_limit INTO v_limit
    FROM storage.buckets
   WHERE id = 'vehicle-removal-photos';
  IF v_limit IS DISTINCT FROM 15728640 THEN
    RAISE EXCEPTION 'VS3 FAIL: file_size_limit=% (want 15728640 = 15 MB; bucket-enforced, not UI label)', v_limit;
  END IF;
END $vs3$;


-- ── VS4: allowed_mime_types (array equality) ═══════════════════════
DO $vs4$
DECLARE v_actual TEXT[];
BEGIN
  SELECT allowed_mime_types INTO v_actual
    FROM storage.buckets
   WHERE id = 'vehicle-removal-photos';
  -- Array equality via sort — order-insensitive assertion. Missing OR
  -- extra values both fail.
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(v_actual) x)
     IS DISTINCT FROM
     (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]) x)
  THEN
    RAISE EXCEPTION 'VS4 FAIL: allowed_mime_types=% (want [image/jpeg, image/png, image/webp, application/pdf])', v_actual;
  END IF;
END $vs4$;


-- ── VS5: 3 named policies exist ═════════════════════════════════════
DO $vs5$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname IN (
       'removal_photos_admin_all',
       'removal_photos_ca_all',
       'removal_photos_manager_all'
     );
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VS5 FAIL: expected 3 removal_photos_* policies on storage.objects; got %', v_count;
  END IF;
END $vs5$;


-- ── VS6: all 3 policies have polcmd = '*' (FOR ALL) ════════════════
DO $vs6$
DECLARE
  v_row RECORD;
  v_wrong TEXT := '';
BEGIN
  FOR v_row IN
    SELECT polname, polcmd
      FROM pg_policy
     WHERE polrelid = 'storage.objects'::regclass
       AND polname IN (
         'removal_photos_admin_all',
         'removal_photos_ca_all',
         'removal_photos_manager_all'
       )
     ORDER BY polname
  LOOP
    -- polcmd: '*'=ALL, 'r'=SELECT, 'a'=INSERT, 'w'=UPDATE, 'd'=DELETE
    IF v_row.polcmd <> '*' THEN
      v_wrong := v_wrong || format('%s (polcmd=%L); ', v_row.polname, v_row.polcmd);
    END IF;
  END LOOP;
  IF v_wrong <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL: policies not FOR ALL (polcmd should be *): %', v_wrong;
  END IF;
END $vs6$;


-- ── VS7: no policy grants anon ═════════════════════════════════════
DO $vs7$
DECLARE
  v_anon_oid OID;
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname = 'anon';
  IF v_anon_oid IS NULL THEN
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: no anon role in this cluster — cannot check exclusion';
  END IF;

  FOR v_row IN
    SELECT polname, polroles
      FROM pg_policy
     WHERE polrelid = 'storage.objects'::regclass
       AND polname IN (
         'removal_photos_admin_all',
         'removal_photos_ca_all',
         'removal_photos_manager_all'
       )
  LOOP
    -- polroles = {0} means public (no role restriction). Neither {0} nor
    -- inclusion of anon.oid is acceptable — we require explicit
    -- authenticated targeting.
    IF v_anon_oid = ANY(v_row.polroles) OR v_row.polroles = ARRAY[0]::oid[] THEN
      v_bad := v_bad || format('%s (polroles=%s); ', v_row.polname, v_row.polroles::text);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS7 FAIL: policies grant anon or PUBLIC: %', v_bad;
  END IF;
END $vs7$;


-- ── VS8: audit row present ══════════════════════════════════════════
DO $vs8$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOW_LOG_STORAGE_BUCKET'
     AND new_values ->> 'migration' = '20260907_tow_log_storage_bucket';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: audit row missing';
  END IF;
END $vs8$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'tow_log_storage_bucket structural (Tow Log Commit 1)'::TEXT AS target,
  ARRAY[
    'VS1  bucket vehicle-removal-photos exists',
    'VS2  bucket public = FALSE',
    'VS3  bucket file_size_limit = 15728640 (15 MB, bucket-enforced)',
    'VS4  bucket allowed_mime_types = image/jpeg + image/png + image/webp + application/pdf',
    'VS5  3 policies exist on storage.objects (removal_photos_admin_all/ca_all/manager_all)',
    'VS6  all 3 policies have polcmd = *  (FOR ALL)',
    'VS7  no policy grants anon or PUBLIC (polroles excludes anon.oid + {0})',
    'VS8  SCHEMA_TOW_LOG_STORAGE_BUCKET audit row present'
  ] AS gates_verified,
  now() AS verified_at;

-- ══════════════════════════════════════════════════════════════════
-- NOT IN THIS FILE (execution gates — separate follow-up):
--   E1  manager at property A uploads under {A}/... → SUCCESS
--   E2  manager at property A uploads under {B}/... → DENIED
--   E3  manager at property A reads {B}/... → DENIED
--   E4  company_admin reads across own-company properties → SUCCESS
--   E5  company_admin reads another company's prefix → DENIED
--   E6  anon → DENIED
--   E7  file exceeding file_size_limit → REJECTED BY BUCKET (landmine #2 test)
--   E8  disallowed MIME type → REJECTED BY BUCKET
--   E9  malformed path (non-numeric first segment) → DENIED (not 22P02 error)
--
-- Empirical text for E-cases lands after Jose triggers each denial by
-- hand and reports the actual message. Assertions get written from
-- what the system actually said, not from what we expected it to say.
-- ══════════════════════════════════════════════════════════════════
