-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — bulk-onboarding bucket + CA upload policy
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT: the terminal SELECT must return the
-- PASS row, and a transaction here would hide it behind the DO block's
-- own rollback on failure.
--
-- 🔴 WHAT THIS FILE CANNOT PROVE. It reads the catalog and executes
-- the helper, so it proves the objects exist, run, and fail closed
-- without a JWT. It does NOT prove what a real company_admin's client
-- can and cannot upload — only a live probe with a real JWT does that,
-- and that is scripts/verify-bulk-bucket.ts (npm run verify:bulkbucket),
-- which must be green before the CA page ships. Reading prosrc proves
-- text exists, not that it runs; reading a policy proves it is
-- installed, not that it refuses.

DO $do$
DECLARE
  v_fail  TEXT[] := '{}';
  v_mime  TEXT[];
  v_n     INT;
  v_expr  TEXT;
  v_b     BOOLEAN;
  v_prop  BIGINT;
  -- 🔴 Must stay byte-identical to the regex in the migration's 3a.
  v_re    TEXT := '^[0-9]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$';
BEGIN

  -- ── G1. Bucket config, exactly ────────────────────────────────────
  SELECT allowed_mime_types INTO v_mime FROM storage.buckets WHERE id = 'bulk-onboarding';
  IF NOT FOUND THEN
    v_fail := array_append(v_fail, 'G1: bucket bulk-onboarding does not exist');
  ELSE
    IF (SELECT public FROM storage.buckets WHERE id='bulk-onboarding') IS NOT FALSE THEN
      v_fail := array_append(v_fail, 'G1a: 🔴 bucket is PUBLIC — resident PII would be world-readable');
    END IF;
    IF (SELECT file_size_limit FROM storage.buckets WHERE id='bulk-onboarding') <> 2097152 THEN
      v_fail := array_append(v_fail, format('G1b: file_size_limit is %s, want 2097152',
        (SELECT file_size_limit FROM storage.buckets WHERE id='bulk-onboarding')));
    END IF;
    -- Set comparison, not array equality: order is not the contract.
    IF NOT (v_mime @> ARRAY['text/csv','application/vnd.ms-excel','text/plain','application/octet-stream']
            AND v_mime <@ ARRAY['text/csv','application/vnd.ms-excel','text/plain','application/octet-stream']) THEN
      v_fail := array_append(v_fail, format('G1c: allowed_mime_types is %s — a text/csv-only list rejects Excel-installed Windows machines', v_mime));
    END IF;
  END IF;

  -- ── G2. Policy inventory on THIS bucket ───────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_policy pol
   WHERE pol.polrelid = 'storage.objects'::regclass
     AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')
          || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) LIKE '%bulk-onboarding%';
  IF v_n <> 2 THEN
    v_fail := array_append(v_fail, format('G2: %s policies name bulk-onboarding, want exactly 2 (bulk_csv_ca_insert, bulk_csv_admin_select)', v_n));
  END IF;

  -- 🔴 G2a. No UPDATE, DELETE or ALL policy may name this bucket. A
  -- submitted file must not change or disappear before review, and
  -- FOR ALL would smuggle both in behind one name.
  SELECT count(*) INTO v_n
    FROM pg_policy pol
   WHERE pol.polrelid = 'storage.objects'::regclass
     AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')
          || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) LIKE '%bulk-onboarding%'
     AND pol.polcmd IN ('w','d','*');
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G2a: 🔴 %s UPDATE/DELETE/ALL policies name bulk-onboarding; want 0 (no overwrite, no withdrawal)', v_n));
  END IF;

  -- G2b. Nothing on this bucket is granted to anon or to PUBLIC.
  SELECT count(*) INTO v_n
    FROM pg_policy pol
   WHERE pol.polrelid = 'storage.objects'::regclass
     AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')
          || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) LIKE '%bulk-onboarding%'
     AND (pol.polroles = '{0}'
          OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY(pol.polroles) AND r.rolname = 'anon'));
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G2b: 🔴 %s policies on bulk-onboarding reach anon or PUBLIC; want 0', v_n));
  END IF;

  -- ── G3. Regression: the allow-all class stays closed ──────────────
  -- A policy on storage.objects that names NO bucket_id applies to
  -- this bucket the moment it exists. That is how the hole dropped on
  -- 2026-10-15 reached both private buckets. Re-asserted here because
  -- creating a bucket is exactly when it would bite.
  SELECT count(*) INTO v_n
    FROM pg_policy pol
   WHERE pol.polrelid = 'storage.objects'::regclass
     AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')
          || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) !~ 'bucket_id';
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G3: 🔴 %s bucket-AGNOSTIC policies on storage.objects — they apply to bulk-onboarding too', v_n));
  END IF;

  -- ── G4. Helper: exists, DEFINER, pinned, not reachable by anon ────
  IF to_regprocedure('public.may_bulk_upload_at(bigint)') IS NULL THEN
    v_fail := array_append(v_fail, 'G4: may_bulk_upload_at(bigint) is missing');
  ELSE
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.may_bulk_upload_at(bigint)')) THEN
      v_fail := array_append(v_fail, 'G4a: helper is not SECURITY DEFINER — the policy would then depend on companies being CA-readable');
    END IF;
    -- Spacing inside proconfig is Postgres's to normalize, so match on
    -- word boundaries rather than an exact string. \m\M, not a
    -- substring: a bare '%public%' would also be satisfied by
    -- 'search_path=public_staging'.
    IF NOT EXISTS (SELECT 1 FROM pg_proc
                    WHERE oid = to_regprocedure('public.may_bulk_upload_at(bigint)')
                      AND array_to_string(proconfig,',') ~ 'search_path=[^,]*\mpublic\M'
                      AND array_to_string(proconfig,',') ~ '\mpg_temp\M') THEN
      v_fail := array_append(v_fail, format('G4b: search_path is not pinned (proconfig=%s)',
        (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure('public.may_bulk_upload_at(bigint)'))));
    END IF;
    IF has_function_privilege('anon','public.may_bulk_upload_at(bigint)','EXECUTE') THEN
      v_fail := array_append(v_fail, 'G4c: 🔴 anon holds EXECUTE on the helper');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = to_regprocedure('public.may_bulk_upload_at(bigint)') AND a.grantee = 0) THEN
      v_fail := array_append(v_fail, 'G4d: 🔴 PUBLIC holds a grant on the helper (the Supabase DEFINER default)');
    END IF;

    -- 🔴 G4e. EXECUTION gate. Structural checks prove the text is
    -- there; only a call proves it runs and fails closed. This session
    -- runs without a JWT, so auth.jwt() is NULL and every call must be
    -- FALSE — including for a property that really exists.
    EXECUTE 'SELECT public.may_bulk_upload_at(NULL::bigint)' INTO v_b;
    IF v_b IS NOT FALSE THEN
      v_fail := array_append(v_fail, format('G4e: may_bulk_upload_at(NULL) returned %s, want FALSE', v_b));
    END IF;
    SELECT id INTO v_prop FROM public.properties WHERE is_active ORDER BY id LIMIT 1;
    IF v_prop IS NULL THEN
      v_fail := array_append(v_fail, 'G4f: no active property to test with — cannot run the execution gate');
    ELSE
      EXECUTE format('SELECT public.may_bulk_upload_at(%s::bigint)', v_prop) INTO v_b;
      IF v_b IS NOT FALSE THEN
        v_fail := array_append(v_fail, format('G4f: 🔴 helper returned %s for property %s with NO JWT — it does not fail closed', v_b, v_prop));
      END IF;
    END IF;
  END IF;

  -- ── G5. 🔴 batches/ is unreachable BY PATTERN, not by omission ────
  -- Two halves, because either alone is worthless: the policy must
  -- anchor on digits-then-slash, AND digits-then-slash must actually
  -- refuse the batches/ prefix.
  SELECT COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid),'') INTO v_expr
    FROM pg_policy pol
   WHERE pol.polrelid = 'storage.objects'::regclass AND pol.polname = 'bulk_csv_ca_insert';
  IF v_expr IS NULL OR v_expr = '' THEN
    v_fail := array_append(v_fail, 'G5: bulk_csv_ca_insert has no WITH CHECK');
  ELSIF position('^[0-9]+/' IN v_expr) = 0 THEN
    v_fail := array_append(v_fail, 'G5a: 🔴 the CA policy is not anchored on ''^[0-9]+/'' — the batches/ prefix may be writable');
  END IF;
  IF ('batches/' || gen_random_uuid() || '.csv') ~ v_re THEN
    v_fail := array_append(v_fail, 'G5b: 🔴 the path regex ACCEPTS a batches/ path — the immutable copy is CA-writable');
  END IF;
  -- Positive control: the regex is not simply refusing everything.
  IF NOT (('143/' || gen_random_uuid() || '.csv') ~ v_re) THEN
    v_fail := array_append(v_fail, 'G5c: the path regex refuses a LEGITIMATE {property_id}/{uuid}.csv path — no CA could ever upload');
  END IF;
  -- And the cast guard: a non-numeric prefix must not be able to raise.
  IF (CASE WHEN split_part('batches/x.csv','/',1) ~ '^[0-9]+$'
           THEN split_part('batches/x.csv','/',1)::BIGINT END) IS NOT NULL THEN
    v_fail := array_append(v_fail, 'G5d: the CASE cast guard resolved a non-numeric prefix');
  END IF;

  -- ── G6. The data assumptions the helper rests on ──────────────────
  -- The helper uses plain predicates on these columns rather than
  -- COALESCE, so a NULL would silently fail a tenant closed. Assert
  -- the NULLs are absent instead of papering over them.
  SELECT count(*) INTO v_n FROM public.companies WHERE account_state IS NULL OR is_active IS NULL;
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G6a: %s companies have NULL account_state or is_active — the helper would refuse them', v_n));
  END IF;
  SELECT count(*) INTO v_n FROM public.user_roles WHERE role = 'company_admin' AND is_active IS NULL;
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G6b: %s company_admin rows have NULL is_active — the helper would refuse them', v_n));
  END IF;
  SELECT count(*) INTO v_n FROM public.properties p
   WHERE NOT EXISTS (SELECT 1 FROM public.companies c WHERE lower(trim(c.name)) = lower(trim(p.company)));
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G6c: %s properties have no companies row matching properties.company — no CA could upload for them', v_n));
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'BULK BUCKET VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

-- ── PASS row + the state a reader needs ─────────────────────────────
-- bulk_onboarding_enabled is REPORTED, not asserted: it is 0 today and
-- becomes 1 the moment Jose enables A1, and a gate that fails on the
-- feature being turned on is a gate nobody keeps.
SELECT 'PASS — bulk-onboarding bucket'                                            AS result,
       (SELECT public::TEXT FROM storage.buckets WHERE id='bulk-onboarding')      AS bucket_public,
       (SELECT file_size_limit FROM storage.buckets WHERE id='bulk-onboarding')   AS size_limit,
       (SELECT array_length(allowed_mime_types,1) FROM storage.buckets WHERE id='bulk-onboarding') AS mime_types,
       (SELECT count(*) FROM pg_policy pol
         WHERE pol.polrelid='storage.objects'::regclass
           AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) LIKE '%bulk-onboarding%') AS bucket_policies,
       (SELECT count(*) FROM pg_policy pol
         WHERE pol.polrelid='storage.objects'::regclass
           AND (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'')) !~ 'bucket_id') AS bucket_agnostic_want_0,
       (SELECT count(*) FROM storage.objects WHERE bucket_id='bulk-onboarding')   AS objects_now,
       (SELECT count(*) FROM public.companies WHERE bulk_onboarding_enabled)      AS companies_flag_on_reported,
       '🔴 npm run verify:bulkbucket still required — only a real JWT proves what a CA can upload' AS next;
