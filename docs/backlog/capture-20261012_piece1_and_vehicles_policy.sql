-- ════════════════════════════════════════════════════════════════════
-- CAPTURE PASS — read-only, ONE result set
-- ════════════════════════════════════════════════════════════════════
-- v2. The first version was eight separate statements and the Supabase
-- editor returns only the LAST statement's result set, so only block 7
-- came back. Everything is now assembled into a single text document
-- and split one row per line, so the whole capture is one scrollable,
-- copyable column.
--
-- Changes nothing. Select all, run, copy the `capture_output` column.
--
-- Every section has a loud fallback: a missing object must say so, not
-- come back as a blank row that reads like "nothing to report".

WITH s1 AS (
  SELECT '═════ 1. pm_plate_lookup(text,text) — VERBATIM BODY ═════' || E'\n' ||
    COALESCE(
      (SELECT pg_get_functiondef(oid) FROM pg_proc
        WHERE oid = to_regprocedure('public.pm_plate_lookup(text,text)')),
      '!!!! NOT FOUND at signature (text,text). Overloads actually present: ' ||
      COALESCE((SELECT string_agg('(' || pg_get_function_identity_arguments(oid) || ')', ' | ')
                  FROM pg_proc WHERE proname = 'pm_plate_lookup'), '(none at all)')
    ) AS t
),
s2 AS (
  SELECT '═════ 2. HEADER FACTS (what CREATE OR REPLACE would drop) ═════' || E'\n' ||
    COALESCE(
      (SELECT format(
          '  identity_args    = %s' || E'\n' ||
          '  security_definer = %s' || E'\n' ||
          '  volatility       = %s   (i=immutable s=stable v=volatile)' || E'\n' ||
          '  settings         = %s' || E'\n' ||
          '  proacl           = %s' || E'\n' ||
          '  overload_count   = %s   (want 1; >1 means PGRST203 risk on DROP)',
          pg_get_function_identity_arguments(p.oid),
          p.prosecdef, p.provolatile,
          COALESCE(array_to_string(p.proconfig, ', '), '(none — no search_path pin!)'),
          COALESCE(array_to_string(p.proacl, ', '), '(default — PUBLIC holds EXECUTE)'),
          (SELECT count(*) FROM pg_proc q
            WHERE q.proname = 'pm_plate_lookup' AND q.pronamespace = p.pronamespace))
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.pm_plate_lookup(text,text)')),
      '  !!!! function not found — see section 1') AS t
),
s3 AS (
  SELECT '═════ 3. KEY COLUMN TYPES (so the new FK matches, not guesses) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-30s %-14s %s',
                 c.relname || '.' || a.attname,
                 format_type(a.atttypid, a.atttypmod),
                 CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE '' END), E'\n' ORDER BY c.relname, a.attnum)
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname IN ('vehicles','properties','companies','vehicle_parking_tags')
                AND a.attname IN ('id','property','property_id','company','company_id','name','vehicle_id')
                AND a.attnum > 0 AND NOT a.attisdropped),
             '  !!!! no columns matched — tables missing?') AS t
),
s4 AS (
  SELECT '═════ 4. TRIGGERS ON vehicles (order + collision check) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %s' || E'\n' || '      %s', t.tgname, pg_get_triggerdef(t.oid)),
                                E'\n' ORDER BY t.tgname)
                FROM pg_trigger t
               WHERE t.tgrelid = 'public.vehicles'::regclass AND NOT t.tgisinternal),
             '  (no user triggers on vehicles)') AS t
),
s5 AS (
  SELECT '═════ 5. vehicles POLICIES — for the manager_update report ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format(
                 '  %s  [cmd=%s roles=%s]' || E'\n' ||
                 '      USING      : %s' || E'\n' ||
                 '      WITH CHECK : %s',
                 pol.polname, pol.polcmd,
                 COALESCE(array_to_string(ARRAY(SELECT rolname FROM pg_roles
                                                 WHERE oid = ANY(pol.polroles)), ','), 'PUBLIC'),
                 COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '(none)'),
                 COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '(none)')),
                 E'\n' ORDER BY pol.polcmd, pol.polname)
                FROM pg_policy pol WHERE pol.polrelid = 'public.vehicles'::regclass),
             '  !!!! no policies on vehicles — RLS may be off entirely') AS t
),
s6 AS (
  SELECT '═════ 6. vehicles COLUMN-LEVEL GRANTS (attacl, not info_schema) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-28s %s', a.attname, array_to_string(a.attacl, ', ')), E'\n' ORDER BY a.attnum)
                FROM pg_attribute a
               WHERE a.attrelid = 'public.vehicles'::regclass
                 AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
             '  (none — no column-level grants; table-level grants govern)') || E'\n' ||
    '  table-level: ' ||
    COALESCE((SELECT array_to_string(relacl, ', ') FROM pg_class
               WHERE oid = 'public.vehicles'::regclass), '(default)') AS t
),
s7 AS (
  SELECT '═════ 7. APPROVAL-AUTHORITY COLUMNS ON user_roles ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-34s %s', a.attname, format_type(a.atttypid, a.atttypmod)),
                                E'\n' ORDER BY a.attnum)
                FROM pg_attribute a
               WHERE a.attrelid = 'public.user_roles'::regclass
                 AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.attname ~ 'approve|approval|can_|permission'),
             '  (no approval-authority columns — the check must live elsewhere)') AS t
),
s8 AS (
  SELECT '═════ 8. PIECE 1 FUNCTION GRANTS (confirms the fix-up) ═════' || E'\n' ||
    COALESCE((SELECT string_agg(format('  %-44s anon=%s auth=%s public_grant=%s',
                 f.sig,
                 has_function_privilege('anon', f.sig, 'EXECUTE'),
                 has_function_privilege('authenticated', f.sig, 'EXECUTE'),
                 COALESCE((SELECT array_to_string(proacl, ',') FROM pg_proc
                            WHERE oid = to_regprocedure(f.sig)) ~ '(^|,)=X', FALSE)),
                 E'\n' ORDER BY f.sig)
                FROM (VALUES
                  ('public.normalize_tag_number(text)'),
                  ('public.may_manage_parking_tags_at(bigint)'),
                  ('public.set_vehicle_tag(bigint,text)'),
                  ('public.void_vehicle_tag(bigint,text,text)'),
                  ('public.vehicles_void_parking_tag()')
                ) AS f(sig)
               WHERE to_regprocedure(f.sig) IS NOT NULL),
             '  !!!! none of the Piece 1 functions exist — Part A not applied?') AS t
),
doc AS (
  SELECT (SELECT t FROM s1) || E'\n\n' || (SELECT t FROM s2) || E'\n\n' ||
         (SELECT t FROM s3) || E'\n\n' || (SELECT t FROM s4) || E'\n\n' ||
         (SELECT t FROM s5) || E'\n\n' || (SELECT t FROM s6) || E'\n\n' ||
         (SELECT t FROM s7) || E'\n\n' || (SELECT t FROM s8) AS body
)
SELECT x.ln AS line, x.txt AS capture_output
  FROM doc, regexp_split_to_table(doc.body, E'\n') WITH ORDINALITY AS x(txt, ln)
 ORDER BY x.ln;
