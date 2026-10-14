-- ════════════════════════════════════════════════════════════════════
-- CAPTURE — the full surface of get_my_role / get_my_company /
--           get_my_properties. Read-only, ONE result set.
-- ════════════════════════════════════════════════════════════════════
-- Needed before anyone adds an is_active term to those helpers. The
-- binding lesson is that a guard's positive controls come from a full
-- writer sweep done BEFORE the guard is applied — and these three sit
-- under most RLS in the system.
--
-- A grep of migrations/ gives ~1,199 textual occurrences across 151
-- files, but that is a LOWER BOUND and the wrong source: policies
-- created through the dashboard never enter the repo, and a replaced
-- function body leaves the old text in an old file. The catalog is the
-- audit surface.
--
-- Changes nothing. Select all, run, copy the capture_output column.

WITH s1 AS (
  SELECT '═════ 1. THE HELPERS AS THEY ACTUALLY ARE ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format(
        '  %s  definer=%s  volatility=%s  search_path=%s' || E'\n' ||
        '      %s',
        p.oid::regprocedure, p.prosecdef,
        CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END,
        COALESCE(array_to_string(p.proconfig, ','), '(not pinned)'),
        replace(btrim(p.prosrc), E'\n', ' ')), E'\n' ORDER BY p.proname)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_my_role','get_my_company','get_my_properties')),
    '  !!!! none found') AS t
),
s2 AS (
  -- 🔴 THE NUMBER THAT DECIDES WHETHER THIS IS A ONE-LINE CHANGE.
  SELECT '═════ 2. POLICIES THAT REFERENCE THEM — COUNT BY TABLE ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-44s policies=%s', x.tbl, x.n), E'\n' ORDER BY x.n DESC, x.tbl)
      FROM (SELECT pol.polrelid::regclass::TEXT AS tbl, count(*) AS n
              FROM pg_policy pol
             WHERE (COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') ||
                    COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
                   ~ 'get_my_(role|company|properties)'
             GROUP BY 1) x),
    '  (none)') AS t
),
s3 AS (
  SELECT '═════ 3. TOTALS ═════' || E'\n' ||
    format('  policies referencing any of the three : %s', (
      SELECT count(*) FROM pg_policy pol
       WHERE (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
             ~ 'get_my_(role|company|properties)')) || E'\n' ||
    format('    ...of which name get_my_role          : %s', (
      SELECT count(*) FROM pg_policy pol
       WHERE (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
             ~ 'get_my_role')) || E'\n' ||
    format('    ...get_my_company                     : %s', (
      SELECT count(*) FROM pg_policy pol
       WHERE (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
             ~ 'get_my_company')) || E'\n' ||
    format('    ...get_my_properties                  : %s', (
      SELECT count(*) FROM pg_policy pol
       WHERE (COALESCE(pg_get_expr(pol.polqual,pol.polrelid),'')||COALESCE(pg_get_expr(pol.polwithcheck,pol.polrelid),''))
             ~ 'get_my_properties')) || E'\n' ||
    format('  OTHER FUNCTIONS calling them            : %s', (
      SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace='public'::regnamespace
         AND p.proname NOT IN ('get_my_role','get_my_company','get_my_properties')
         AND p.prosrc ~ 'get_my_(role|company|properties)')) || E'\n' ||
    format('  VIEWS calling them                      : %s', (
      SELECT count(*) FROM pg_views v
       WHERE v.schemaname='public' AND v.definition ~ 'get_my_(role|company|properties)')) AS t
),
s4 AS (
  -- Every other function that calls them. Changing the helper changes
  -- all of these too, and some are DEFINER RPCs whose refusal messages
  -- users read.
  SELECT '═════ 4. FUNCTIONS THAT CALL THEM (each one inherits the change) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-62s definer=%s', p.oid::regprocedure, p.prosecdef),
                 E'\n' ORDER BY p.proname)
      FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace
       AND p.proname NOT IN ('get_my_role','get_my_company','get_my_properties')
       AND p.prosrc ~ 'get_my_(role|company|properties)'),
    '  (none)') AS t
),
s5 AS (
  -- 🔴 The positive-control list. Adding an is_active term means every
  -- role below must still be able to do what it does today, so these
  -- are the accounts a post-change smoke has to cover.
  SELECT '═════ 5. LIVE ROLE POPULATION (the positive controls) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-16s total=%-5s is_active_true=%-5s is_active_false=%-5s NULL=%s',
                 r.role, r.n, r.act, r.inact, r.nul), E'\n' ORDER BY r.n DESC)
      FROM (SELECT role,
                   count(*) AS n,
                   count(*) FILTER (WHERE is_active IS TRUE)  AS act,
                   count(*) FILTER (WHERE is_active IS FALSE) AS inact,
                   count(*) FILTER (WHERE is_active IS NULL)  AS nul
              FROM public.user_roles GROUP BY role) r),
    '  (none)') AS t
),
s6 AS (
  -- Whoever is deactivated today is exactly who would lose access the
  -- moment the helper changes. If any of them SHOULD still have it,
  -- that is a product question, not a code one.
  SELECT '═════ 6. WHO AN is_active TERM WOULD CUT OFF TODAY ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-16s %-42s [%s]', ur.role, ur.email, ur.company),
                 E'\n' ORDER BY ur.role, ur.email)
      FROM public.user_roles ur WHERE ur.is_active IS NOT TRUE),
    '  (nobody is deactivated — the change would cut off no one today)') AS t
),
s7 AS (
  SELECT '═════ 7. auth.users BAN STATE vs user_roles.is_active ═════' || E'\n' ||
    '   (a deactivated row whose auth user is NOT banned is a live login)' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-42s role=%-14s is_active=%-5s banned_until=%s',
                 ur.email, ur.role, ur.is_active, COALESCE(u.banned_until::TEXT,'(null)')),
                 E'\n' ORDER BY ur.email)
      FROM public.user_roles ur
      LEFT JOIN auth.users u ON lower(btrim(u.email)) = lower(btrim(ur.email))
     WHERE ur.is_active IS NOT TRUE),
    '  (none)') AS t
),
doc AS (
  SELECT (SELECT t FROM s1)||E'\n\n'||(SELECT t FROM s2)||E'\n\n'||(SELECT t FROM s3)||E'\n\n'||
         (SELECT t FROM s4)||E'\n\n'||(SELECT t FROM s5)||E'\n\n'||(SELECT t FROM s6)||E'\n\n'||
         (SELECT t FROM s7) AS body
)
SELECT x.ln AS line, x.txt AS capture_output
  FROM doc, regexp_split_to_table(doc.body, E'\n') WITH ORDINALITY AS x(txt, ln)
 ORDER BY x.ln;
