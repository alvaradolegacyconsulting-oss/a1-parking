-- ════════════════════════════════════════════════════════════════════
-- CAPTURE 3 — read-only, ONE result set. companies guard surface.
-- ════════════════════════════════════════════════════════════════════
-- Needed before the bulk-onboarding flag: `companies` has NO
-- protected-column guard today (only companies_updated_at), so a
-- super-admin-only flag guard is the FIRST of its kind on that table.
-- Copying the properties pattern blind risks colliding with a policy
-- shape that differs — properties has a WITH CHECK that accidentally
-- protects `name`, and companies may have nothing comparable.
--
-- Changes nothing. Select all, run, copy the capture_output column.

WITH s1 AS (
  SELECT '═════ 1. companies TRIGGERS ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %s' || E'\n' || '      %s', t.tgname, pg_get_triggerdef(t.oid)), E'\n' ORDER BY t.tgname)
                FROM pg_trigger t WHERE t.tgrelid='public.companies'::regclass AND NOT t.tgisinternal),
             '  (none — the flag guard would be the first trigger of its kind here)') AS t
),
s2 AS (
  SELECT '═════ 2. companies POLICIES ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format(
                 '  %s  [cmd=%s roles=%s]' || E'\n' ||
                 '      USING      : %s' || E'\n' ||
                 '      WITH CHECK : %s',
                 pol.polname, pol.polcmd,
                 COALESCE(array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid=ANY(pol.polroles)),','),'PUBLIC'),
                 COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'(none)'),
                 COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),'(none)')),
                 E'\n' ORDER BY pol.polcmd, pol.polname)
                FROM pg_policy pol WHERE pol.polrelid='public.companies'::regclass),
             '  !!!! no policies on companies — is RLS even on?') AS t
),
s3 AS (
  SELECT '═════ 3. companies RLS + GRANTS ═════' || E'\n' ||
    COALESCE((SELECT format('  rls_enabled=%s  rls_FORCED=%s  owner=%s' || E'\n' || '  relacl=%s',
                 c.relrowsecurity, c.relforcerowsecurity,
                 (SELECT rolname FROM pg_roles WHERE oid=c.relowner),
                 COALESCE(array_to_string(c.relacl,', '),'(default)'))
                FROM pg_class c WHERE c.oid='public.companies'::regclass),
             '  !!!! companies not found') AS t
),
s4 AS (
  -- Which roles can UPDATE companies at all? If a CA can, the flag
  -- needs a guard. If nobody but service_role can, it may not.
  SELECT '═════ 4. WHO CAN UPDATE companies ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-16s UPDATE=%s  SELECT=%s', r,
                 has_table_privilege(r,'public.companies','UPDATE'),
                 has_table_privilege(r,'public.companies','SELECT')), E'\n')
                FROM (VALUES ('anon'),('authenticated'),('service_role')) AS x(r)),
             '  (could not resolve roles)') AS t
),
s5 AS (
  -- Is there an existing super-admin predicate to reuse, rather than
  -- inventing one? properties' guard keys on get_my_role().
  SELECT '═════ 5. SUPER-ADMIN PREDICATE HELPERS AVAILABLE ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-44s secdef=%s vol=%s',
                 p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', p.prosecdef, p.provolatile),
                 E'\n' ORDER BY p.proname)
                FROM pg_proc p
               WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
                 AND p.proname ~ '^(get_my_role|get_my_company|is_super_admin|my_tier)'),
             '  (none found — the guard must read user_roles directly)') AS t
),
doc AS (
  SELECT (SELECT t FROM s1)||E'\n\n'||(SELECT t FROM s2)||E'\n\n'||(SELECT t FROM s3)||E'\n\n'||
         (SELECT t FROM s4)||E'\n\n'||(SELECT t FROM s5) AS body
)
SELECT x.ln AS line, x.txt AS capture_output
  FROM doc, regexp_split_to_table(doc.body, E'\n') WITH ORDINALITY AS x(txt, ln)
 ORDER BY x.ln;
