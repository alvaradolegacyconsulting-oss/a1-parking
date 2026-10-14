-- ════════════════════════════════════════════════════════════════════
-- CAPTURE 4 — read-only, ONE result set. Storage bucket mirror.
-- ════════════════════════════════════════════════════════════════════
-- Needed before the bulk-onboarding bucket is written. "Mirror
-- property-authorizations" cannot be done from memory: storage.objects
-- is a SINGLE table whose policies are filtered by bucket_id, so the
-- mirror means finding which of the shared policies name that bucket
-- and what their predicates actually say.
--
-- Catalog is the audit surface — a bucket and its policies are created
-- through the dashboard or the storage API and never enter migrations/,
-- so this is the only authoritative source.
--
-- Changes nothing. Select all, run, copy the capture_output column.

WITH s1 AS (
  SELECT '═════ 1. BUCKETS — public flag, size and MIME limits ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-28s public=%-5s size_limit=%-12s mime=%s',
                 b.id, b.public,
                 COALESCE(b.file_size_limit::TEXT, '(none)'),
                 COALESCE(array_to_string(b.allowed_mime_types, ', '), '(any)')),
                 E'\n' ORDER BY b.id)
                FROM storage.buckets b),
             '  !!!! no buckets visible') AS t
),
s2 AS (
  -- 🔴 THE MIRROR SOURCE. Every policy on storage.objects, with its
  -- predicates, so the new bucket's policies can be written to match
  -- rather than guessed. Note which ones name a bucket_id and which are
  -- bucket-agnostic — a bucket-agnostic policy already applies to the
  -- new bucket the moment it exists, which is the thing to catch.
  SELECT '═════ 2. storage.objects POLICIES (the mirror source) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format(
                 '  %s  [cmd=%s roles=%s]' || E'\n' ||
                 '      USING      : %s' || E'\n' ||
                 '      WITH CHECK : %s',
                 pol.polname, pol.polcmd,
                 COALESCE(array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid=ANY(pol.polroles)),','),'PUBLIC'),
                 COALESCE(pg_get_expr(pol.polqual, pol.polrelid),'(none)'),
                 COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid),'(none)')),
                 E'\n' ORDER BY pol.polcmd, pol.polname)
                FROM pg_policy pol WHERE pol.polrelid='storage.objects'::regclass),
             '  !!!! no policies on storage.objects — is RLS even on?') AS t
),
s3 AS (
  SELECT '═════ 3. 🔴 WHICH POLICIES ARE BUCKET-AGNOSTIC? ═════' || E'\n' ||
    '   (one that names no bucket_id applies to a NEW bucket immediately)' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-46s cmd=%s  names_a_bucket=%s',
                 pol.polname, pol.polcmd,
                 (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'') || COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
                   ~ 'bucket_id'),
                 E'\n' ORDER BY pol.polname)
                FROM pg_policy pol WHERE pol.polrelid='storage.objects'::regclass),
             '  (none)') AS t
),
s4 AS (
  SELECT '═════ 4. storage.objects RLS + GRANTS ═════' || E'\n' ||
    COALESCE((SELECT format('  rls_enabled=%s  rls_FORCED=%s  owner=%s' || E'\n' || '  relacl=%s',
                 c.relrowsecurity, c.relforcerowsecurity,
                 (SELECT rolname FROM pg_roles WHERE oid=c.relowner),
                 COALESCE(array_to_string(c.relacl,', '),'(default)'))
                FROM pg_class c WHERE c.oid='storage.objects'::regclass),
             '  !!!! storage.objects not found') AS t
),
s5 AS (
  -- Object counts per bucket, so the new bucket's emptiness is a fact
  -- rather than an assumption, and so property-authorizations' real
  -- path shape can be mirrored.
  SELECT '═════ 5. OBJECT COUNTS + A SAMPLE PATH SHAPE ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-28s objects=%-6s sample_path=%s',
                 o.bucket_id, o.n, COALESCE(o.sample,'(none)')), E'\n' ORDER BY o.bucket_id)
                FROM (SELECT bucket_id, count(*) AS n,
                             (regexp_split_to_array(min(name), '/'))[1] || '/…' AS sample
                        FROM storage.objects GROUP BY bucket_id) o),
             '  (no objects in any bucket)') AS t
),
s6 AS (
  -- Does a bulk-onboarding bucket already exist from an earlier attempt?
  SELECT '═════ 6. DOES THE TARGET BUCKET ALREADY EXIST? ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %s  public=%s', b.id, b.public), E'\n')
                FROM storage.buckets b WHERE b.id ~* 'bulk|onboard|import'),
             '  no — clean to create') AS t
),
doc AS (
  SELECT (SELECT t FROM s1)||E'\n\n'||(SELECT t FROM s2)||E'\n\n'||(SELECT t FROM s3)||E'\n\n'||
         (SELECT t FROM s4)||E'\n\n'||(SELECT t FROM s5)||E'\n\n'||(SELECT t FROM s6) AS body
)
SELECT x.ln AS line, x.txt AS capture_output
  FROM doc, regexp_split_to_table(doc.body, E'\n') WITH ORDINALITY AS x(txt, ln)
 ORDER BY x.ln;
