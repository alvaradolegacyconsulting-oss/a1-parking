-- ════════════════════════════════════════════════════════════════════
-- 🔴 PENDING A RULING — widening who may re-validate a batch
-- ════════════════════════════════════════════════════════════════════
-- Do not apply until this is ruled on. See
-- docs/phaseB-queue-revalidation-blocker.md.
--
-- ── THE PROBLEM, PROVEN BY EXECUTION 2026-10-15 ─────────────────────
-- The ruling asks for re-validation at three points: when Jose opens a
-- batch, at approve, and at load. An active super-admin canary was
-- created, used, and deleted:
--
--   get_my_role()                 = "admin"
--   may_bulk_upload_at(139)       = false
--   bulk_validate_rows(139, …)    = REFUSED: property_not_in_scope
--   download batches/8.csv        = ok, 30998 bytes
--   select from import_batches    = ok
--
-- So Jose can read the batch row and download the exact bytes that were
-- submitted, and cannot run the check that says whether they would
-- still load. bulk_validate_rows gates on may_bulk_upload_at(), which
-- requires ur.role = 'company_admin'. None of the three re-validation
-- points can be built until that changes.
--
-- ── 🔴 WHY NOT JUST WIDEN may_bulk_upload_at ────────────────────────
-- Because the storage INSERT policy calls it:
--   bulk_csv_ca_insert … AND public.may_bulk_upload_at(<path's id>)
-- Adding an admin branch there would let an admin UPLOAD a CSV into any
-- property's prefix. Upload authority and validate authority are
-- different questions and the same function cannot answer both: one is
-- "may you put a file here", the other is "may you check a file that is
-- already here". So a second function, and may_bulk_upload_at is left
-- exactly as it is.
--
-- ── 🔴 WHY THE BODY IS NOT RETYPED ──────────────────────────────────
-- bulk_validate_rows is ~100 lines whose correctness was established by
-- the rehearsal against the published fixture expectations. Retyping it
-- to change one line is how a subtle edit gets in, and CREATE OR
-- REPLACE also drops parameter defaults that a retyped signature can
-- silently lose. So Postgres writes the new definition: part 2 reads
-- pg_get_functiondef(), asserts the gate line is present EXACTLY ONCE,
-- substitutes that one substring, asserts the substitution landed, and
-- EXECUTEs the result. Nothing else about the function can change,
-- because nothing else is touched.
--
-- Paired: wip-20261015_admin_validate_gate_verification.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — sweep
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE v_n INT; v_s TEXT;
BEGIN
  -- Who calls may_bulk_upload_at today? It must stay exactly as it is,
  -- so this records its callers rather than changing them.
  SELECT count(*), string_agg(p.proname, ', ') INTO v_n, v_s
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc ~ '\mmay_bulk_upload_at\M'
     AND p.proname <> 'may_bulk_upload_at';
  RAISE NOTICE 'sweep: % function(s) call may_bulk_upload_at: %', v_n, COALESCE(v_s, '(none)');

  SELECT count(*), string_agg(policyname, ', ') INTO v_n, v_s
    FROM pg_policies
   WHERE (qual ~ '\mmay_bulk_upload_at\M' OR with_check ~ '\mmay_bulk_upload_at\M');
  RAISE NOTICE 'sweep: % policy(ies) call may_bulk_upload_at: %', v_n, COALESCE(v_s, '(none)');
  IF v_n <> 1 OR v_s IS DISTINCT FROM 'bulk_csv_ca_insert' THEN
    RAISE EXCEPTION 'sweep: expected exactly bulk_csv_ca_insert to call may_bulk_upload_at, found % (%). A second caller changes what leaving that function alone protects.', v_n, COALESCE(v_s, '(none)');
  END IF;

  -- The function being edited must exist with the signature expected.
  IF to_regprocedure('public.bulk_validate_rows(bigint, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'sweep: bulk_validate_rows(bigint, jsonb) is absent. Nothing to widen.';
  END IF;
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — may_bulk_validate_at: upload authority OR an active admin
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.may_bulk_validate_at(p_property_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    -- The customer's half, unchanged and unmodified: an active
    -- company_admin of the property's company, with the flag on.
    public.may_bulk_upload_at(p_property_id)
    -- The operator's half. 🔴 THE PROPERTY MUST EXIST AND BE NAMED.
    -- may_bulk_upload_at returns FALSE for a NULL id because its join
    -- finds nothing; this branch never looks at the property, so
    -- without these two conditions an admin would get TRUE for a NULL
    -- id and bulk_validate_rows would then run with v_property and
    -- v_company NULL — where every `property = NULL` comparison is
    -- NULL, every duplicate check silently finds nothing, and the file
    -- comes back clean because nothing was compared.
    OR (
      p_property_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.properties p WHERE p.id = p_property_id)
      -- Read from user_roles directly, with is_active spelled out, so
      -- the two halves of this OR are the same shape and neither
      -- depends on what get_my_role() happens to mean today.
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
         WHERE lower(trim(ur.email)) = lower(trim(auth.jwt() ->> 'email'))
           AND ur.role = 'admin'
           AND ur.is_active
      )
    )
$fn$;

COMMENT ON FUNCTION public.may_bulk_validate_at(BIGINT) IS
  'May the JWT holder run bulk_validate_rows for this property? Either may_bulk_upload_at() (an active company_admin of the property''s company with the flag on) or an active super-admin. 🔴 A SEPARATE FUNCTION FROM may_bulk_upload_at ON PURPOSE: that one is called by the storage INSERT policy bulk_csv_ca_insert, so widening it would let an admin upload a CSV into any property''s prefix. Upload authority and validate authority are different questions. The admin branch requires a non-NULL property id that exists, because it does not otherwise consult the property, and bulk_validate_rows with a NULL property would compare every row against NULL and report the file clean.';

-- A SECURITY DEFINER function inherits EXECUTE to PUBLIC by Supabase
-- default; revoke before granting.
REVOKE ALL ON FUNCTION public.may_bulk_validate_at(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.may_bulk_validate_at(BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.may_bulk_validate_at(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.may_bulk_validate_at(BIGINT) TO service_role;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — repoint bulk_validate_rows's gate, one substring only
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE
  v_src  TEXT;
  v_new  TEXT;
  v_hits INT;
  v_old  CONSTANT TEXT := 'NOT public.may_bulk_upload_at(p_property_id)';
  v_rep  CONSTANT TEXT := 'NOT public.may_bulk_validate_at(p_property_id)';
BEGIN
  SELECT pg_get_functiondef(to_regprocedure('public.bulk_validate_rows(bigint, jsonb)'))
    INTO v_src;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'part 2: could not read the definition of bulk_validate_rows';
  END IF;

  -- 🔴 EXACTLY ONE OCCURRENCE. Zero means the gate is not where this
  -- migration thinks it is and the substitution would be a silent
  -- no-op that leaves the function unchanged while the migration
  -- reports success. More than one means there is a second gate site
  -- this was not written for.
  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_src, 'NOT public\.may_bulk_upload_at\(p_property_id\)', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'part 2: found % occurrence(s) of the gate line in bulk_validate_rows, expected exactly 1. Read the function before changing it.', v_hits;
  END IF;

  v_new := replace(v_src, v_old, v_rep);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'part 2: the substitution changed nothing';
  END IF;
  IF position(v_rep in v_new) = 0 THEN
    RAISE EXCEPTION 'part 2: the new gate line is not in the result';
  END IF;
  IF position(v_old in v_new) > 0 THEN
    RAISE EXCEPTION 'part 2: the old gate line survives in the result';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'part 2: bulk_validate_rows now gates on may_bulk_validate_at (one substring changed, body otherwise untouched)';
END
$do$;

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'admin validate gate' AS migration,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'may_bulk_validate_at') AS helper_installed,
  (SELECT (prosrc ~ '\mmay_bulk_validate_at\M')::TEXT FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'bulk_validate_rows') AS rpc_repointed,
  (SELECT (prosrc ~ '\mmay_bulk_upload_at\M')::TEXT FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'bulk_validate_rows') AS rpc_still_calls_old_gate,
  'execution half: npm run verify:validategate' AS and_then;
