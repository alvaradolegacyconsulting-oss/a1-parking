-- ════════════════════════════════════════════════════════════════════
-- ROLLBACK — step 3 identity helpers
-- ════════════════════════════════════════════════════════════════════
-- 🔴 RUN PART 0 BEFORE YOU APPLY THE MIGRATION. It takes two seconds
-- and it is the only part that makes this rollback exact.
--
-- ── WHY THIS FILE DOES NOT JUST CONTAIN THE OLD BODIES ──────────────
-- I know what the three helpers looked like in
-- migrations/20260610_b155_2_f9_helper_lower_match.sql. I do NOT know
-- that production still matches it: these are CREATE OR REPLACE
-- functions, the catalog is the audit surface rather than migrations/,
-- and a replaced body leaves the old text sitting in an old file
-- looking authoritative. Restoring a body I merely believe is current
-- would silently revert whatever changed it since — which is exactly
-- the trap that makes migration files one-time rather than
-- idempotent.
--
-- So Part 0 has POSTGRES write the rollback. pg_get_functiondef()
-- emits a complete, runnable CREATE OR REPLACE statement for each
-- helper as it actually is, including its SET clauses. Save that
-- output; it is the rollback, and it cannot be wrong.
--
-- Part 1 is a labelled FALLBACK for the case where Part 0 was not
-- captured. Part 2 is a narrower rollback that keeps the two
-- behaviourally inert changes. Part 3 tells you how to tell whether
-- you need any of this.

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — 🔴 RUN THIS FIRST, BEFORE THE MIGRATION. Read-only.
-- ════════════════════════════════════════════════════════════════════
-- Copy the whole `rollback_statement` column somewhere you can find
-- again. Three rows, each a complete statement. Running those three
-- statements restores production byte-for-byte.
SELECT p.proname                                        AS helper,
       pg_get_functiondef(p.oid) || ';'                 AS rollback_statement
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('get_my_role','get_my_company','get_my_properties')
 ORDER BY p.proname;

-- Keep this next to it: the grants, so a rollback can confirm it did
-- not change who may call them. CREATE OR REPLACE preserves grants, so
-- this should read identically before and after either direction.
SELECT p.proname AS helper,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role_execute,
       COALESCE(array_to_string(p.proconfig, ','), '(search_path NOT pinned)') AS proconfig
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('get_my_role','get_my_company','get_my_properties')
 ORDER BY p.proname;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — FULL ROLLBACK, fallback version
-- ════════════════════════════════════════════════════════════════════
-- 🔴 USE PART 0's OUTPUT IF YOU HAVE IT. Use this block only if you do
-- not, and read this first:
--
-- These bodies are from migrations/20260610_b155_2_f9_helper_lower_match.sql
-- (2026-06-10, "F9 helper lower match"). If anything replaced a helper
-- between then and now, this block REVERTS that too, and nothing here
-- can detect it. That is why it is the fallback and not the default.
--
-- The guard below refuses to run if the current body is NOT the step-3
-- one — because then you are not rolling step 3 back, you are
-- overwriting something else.

DO $do$
DECLARE
  v_name TEXT;
  v_src  TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['get_my_role','get_my_company','get_my_properties']
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc
     WHERE pronamespace='public'::regnamespace AND proname = v_name;
    IF v_src IS NULL THEN
      RAISE EXCEPTION '%() does not exist — stop and look before restoring anything', v_name;
    END IF;
    IF v_src !~ '\mis_active\M' THEN
      RAISE EXCEPTION
        '%() does NOT contain is_active, so step 3 is not applied to it. Running this block would overwrite whatever IS there. Stop — if you meant to restore a different change, use Part 0''s captured output.',
        v_name;
    END IF;
  END LOOP;
  RAISE NOTICE 'pre-flight OK: all three helpers carry the step-3 body, so this really is a step-3 rollback';
END
$do$;

BEGIN;

-- Verbatim from 2026-06-10. No search_path (that is what it was),
-- no is_active, no ORDER BY, and `user_roles` unqualified.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT role FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT company FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_properties()
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT property FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;

COMMIT;

-- Confirm the rollback landed and that it really did undo it.
SELECT 'ROLLED BACK — step 3' AS result,
       (SELECT count(*) FROM pg_proc
         WHERE pronamespace='public'::regnamespace
           AND proname IN ('get_my_role','get_my_company','get_my_properties')
           AND prosrc ~ '\mis_active\M')                 AS still_filtering_want_0,
       (SELECT count(*) FROM pg_proc
         WHERE pronamespace='public'::regnamespace
           AND proname IN ('get_my_role','get_my_company','get_my_properties')
           AND prosecdef)                                AS definer_want_3,
       (SELECT count(*) FROM pg_proc
         WHERE pronamespace='public'::regnamespace
           AND proname IN ('get_my_role','get_my_company','get_my_properties')
           AND has_function_privilege('authenticated', oid, 'EXECUTE')) AS authenticated_execute_want_3,
       '🔴 4 deactivated A1 rows can read tenant data again — that is what rolling back means' AS reminder;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — NARROW ROLLBACK. Probably the one you actually want.
-- ════════════════════════════════════════════════════════════════════
-- 🔴 Only ONE of the three changes can plausibly break anything.
--
--   AND is_active     ← the only one that changes who can see what
--   SET search_path   ← behaviourally inert; it closes a definer-
--                       hijack surface and changes no result
--   ORDER BY id       ← inert today; 0 of 386 emails have more than
--                       one user_roles row, so it never arbitrates
--
-- So if the symptom is "a live user lost access", drop ONLY the
-- is_active term and keep the two safe wins. That is a smaller step
-- than a full rollback and it leaves the hijack surface closed.
--
-- Uncomment deliberately.
--
-- BEGIN;
-- CREATE OR REPLACE FUNCTION public.get_my_role()
-- RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
-- SET search_path = public, pg_temp AS $func$
--   SELECT role FROM public.user_roles
--    WHERE lower(email) = lower(auth.jwt() ->> 'email')
--    ORDER BY id LIMIT 1
-- $func$;
-- CREATE OR REPLACE FUNCTION public.get_my_company()
-- RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
-- SET search_path = public, pg_temp AS $func$
--   SELECT company FROM public.user_roles
--    WHERE lower(email) = lower(auth.jwt() ->> 'email')
--    ORDER BY id LIMIT 1
-- $func$;
-- CREATE OR REPLACE FUNCTION public.get_my_properties()
-- RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
-- SET search_path = public, pg_temp AS $func$
--   SELECT property FROM public.user_roles
--    WHERE lower(email) = lower(auth.jwt() ->> 'email')
--    ORDER BY id LIMIT 1
-- $func$;
-- COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — how to tell whether you need to roll back at all
-- ════════════════════════════════════════════════════════════════════
-- The failure mode to watch for is ONE thing: a user who should have
-- access resolving to NULL. Everything else this change touches is
-- inert.
--
-- 🔴 EXPECTED, NOT A FAILURE: these 4 already-deactivated A1 rows lose
-- data access. That is the entire point of the change.
SELECT 'EXPECTED to lose access' AS category, ur.role, ur.email, ur.company
  FROM public.user_roles ur
 WHERE ur.is_active IS NOT TRUE
 ORDER BY ur.role, ur.email;

-- 🔴 A FAILURE would be a row in THIS result: someone the helpers will
-- refuse who is not deactivated. It should be empty — is_active is NOT
-- NULL anywhere today (386 rows, 0 NULLs), so there is no third state
-- for anyone to fall into. If this ever returns a row, Part 2 is the
-- fix and this query names who to tell.
SELECT 'UNEXPECTED — investigate' AS category, ur.id, ur.role, ur.email, ur.company, ur.is_active
  FROM public.user_roles ur
 WHERE ur.is_active IS NULL
 ORDER BY ur.id;

-- And the live signal, if someone reports a blank portal: this is the
-- helpers' own predicate run against that person's row. If it returns
-- nothing, the helpers return NULL for them and they are the case.
-- Replace the address, run it, and you have the answer in one query.
--
-- SELECT id, email, role, company, is_active
--   FROM public.user_roles
--  WHERE lower(email) = lower('PUT_THE_ADDRESS_HERE')
--    AND is_active
--  ORDER BY id LIMIT 1;
