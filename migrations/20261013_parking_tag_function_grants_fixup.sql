-- ════════════════════════════════════════════════════════════════════
-- FIX-UP — default PUBLIC EXECUTE on two Piece 1 functions
-- ════════════════════════════════════════════════════════════════════
-- G5 of the Piece 1 verification failed, correctly: Postgres grants
-- EXECUTE to PUBLIC on every new function, and the migration revoked it
-- on three of five. REVOKE/GRANT are idempotent — safe to re-run, and
-- the migration file now carries these so the repo matches the DB.
--
-- Neither function is referenced by an RLS policy or an index (the
-- policies compare with lower(trim()); both unique indexes are on plain
-- columns), so revoking PUBLIC cannot change RLS evaluation. Inside the
-- DEFINER RPCs normalize_tag_number runs as the function OWNER, so no
-- caller needs a grant for the RPCs to work. A trigger function's
-- EXECUTE is checked at CREATE TRIGGER time, not when it fires.

REVOKE ALL ON FUNCTION public.normalize_tag_number(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_tag_number(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.normalize_tag_number(TEXT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.normalize_tag_number(TEXT) TO service_role;

-- No GRANT: nothing needs to call this directly.
REVOKE ALL ON FUNCTION public.vehicles_void_parking_tag() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vehicles_void_parking_tag() FROM anon;

-- Parity for the three that were already revoked — service_role was
-- missing on all three, which scripts and gates need.
GRANT EXECUTE ON FUNCTION public.set_vehicle_tag(BIGINT, TEXT)            TO service_role;
GRANT EXECUTE ON FUNCTION public.void_vehicle_tag(BIGINT, TEXT, TEXT)     TO service_role;
GRANT EXECUTE ON FUNCTION public.may_manage_parking_tags_at(BIGINT)       TO service_role;

-- ── proof, per function and per role, by execution ──────────────────
-- has_function_privilege asks Postgres directly rather than regexing
-- proacl, where grantor names contain privilege letters.
SELECT f.sig,
       has_function_privilege('anon',          f.sig, 'EXECUTE') AS anon_want_false,
       has_function_privilege('authenticated', f.sig, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role',  f.sig, 'EXECUTE') AS service_role,
       -- PUBLIC is represented by the pseudo-role 'public' in proacl;
       -- an empty grantee entry (=X/owner) is the PUBLIC grant.
       COALESCE((SELECT array_to_string(proacl, ',') FROM pg_proc
                  WHERE oid = to_regprocedure(f.sig)) ~ '(^|,)=X', FALSE) AS public_grant_want_false
  FROM (VALUES
    ('public.normalize_tag_number(text)'),
    ('public.may_manage_parking_tags_at(bigint)'),
    ('public.set_vehicle_tag(bigint,text)'),
    ('public.void_vehicle_tag(bigint,text,text)'),
    ('public.vehicles_void_parking_tag()')
  ) AS f(sig)
 ORDER BY f.sig;
