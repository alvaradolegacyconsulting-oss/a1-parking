-- ════════════════════════════════════════════════════════════════════
-- APPROVAL QUEUE — the schema Approve-then-Load needs
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-15, all four items approved:
--   1. 'approved' into the status allowlist
--   2. 'approved' into import_batches_one_live_per_file
--   3. 'approved' into import_batches_approval_complete
--   4. approved_by → UUID (the approver's user id; the name is joined
--      for display)
-- plus a fifth the ruling requires and could not be implemented
-- without — see part 5.
--
-- Paired: wip-20261015_approval_queue_schema_verification.sql
--
-- ── WRITER SWEEP, DONE BEFORE THE MIGRATION (binding rule) ──────────
-- Repo side, every reference to import_batches:
--   api/bulk-onboarding/submit  INSERT (status forced 'submitted')
--                               UPDATE storage_path (the immutable copy)
--                               DELETE on the copy-failure path only
--   scripts/verify-bulk-http    SELECT + DELETE of its own batches
--   scripts/submit-demo-batch   SELECT only
--   migrations/…_bucket.sql     comments only
-- 🔴 NOT ONE of them writes status after insert, approved_by,
-- approved_at or reject_reason. The only writer of those will be the
-- RPCs in the next file.
--
-- Readers of approved_by, which is the column changing TYPE:
--   🔴 ZERO. Not in app/, not in scripts/. Nothing selects it, renders
--   it or compares it, so the type change cannot break a caller.
--   Measured, not assumed: grep over app/ and scripts/ for approved_by,
--   approved_at and reject_reason returns nothing.
--
-- Data side: 1 row (batch 8, 'submitted'), approved_by IS NULL.
-- So TEXT → UUID loses nothing. Part 0 asserts that rather than
-- trusting this comment, because the gap between writing it and Jose
-- applying it is a gap in which a batch could be approved.
--
-- ── THE CATALOG HALF OF THE SWEEP IS PART 0, NOT A COMMENT ──────────
-- The repo is not the audit surface: a policy, grant or trigger added
-- from the dashboard never enters it. So the catalog checks run here,
-- in the transaction, and RAISE rather than report — if an UPDATE
-- policy or grant has appeared on this table since Phase A, adding
-- 'approved' to the allowlist would hand it a new reachable state and
-- this migration must refuse.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — the sweep, executed, failing closed
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE
  v_bad   INT;
  v_names TEXT;
BEGIN
  -- (a) No non-NULL approved_by. If one appeared, the cast below could
  -- fail mid-migration or silently coerce, and either way the audit
  -- trail of a real approval is at stake.
  SELECT count(*) INTO v_bad FROM public.import_batches WHERE approved_by IS NOT NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: % batch row(s) already carry approved_by. Resolve by hand before changing its type — do not let a cast decide what a real approval meant.', v_bad;
  END IF;

  -- (b) No status outside the current allowlist (a row written around
  -- the CHECK, e.g. by a disabled-trigger load).
  SELECT count(*), string_agg(DISTINCT status, ', ') INTO v_bad, v_names
    FROM public.import_batches
   WHERE status NOT IN ('submitted','rejected','loaded','rolled_back');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: % row(s) hold a status outside the allowlist (%). The allowlist is meant to be exhaustive.', v_bad, v_names;
  END IF;

  -- (c) 🔴 STILL NO CLIENT WRITE PATH. Phase A shipped two SELECT
  -- policies and deliberately no INSERT/UPDATE/DELETE policy, so that
  -- "a forgotten policy cannot become a write path". Adding a new
  -- reachable status to a table that has since gained a write policy
  -- would be handing that policy a new state to write.
  SELECT count(*), string_agg(policyname || ' (' || cmd || ')', ', ')
    INTO v_bad, v_names
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'import_batches'
     AND cmd <> 'SELECT';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: import_batches has gained % non-SELECT policy(ies) since Phase A: %. Status transitions are meant to go only through RPCs.', v_bad, v_names;
  END IF;

  -- (d) And no write GRANT either. 🔴 pg_class.relacl, not
  -- information_schema: the information_schema privilege views
  -- under-report, and a grant this migration cannot see is exactly the
  -- one that matters.
  SELECT count(*), string_agg(DISTINCT a.privilege_type, ', ')
    INTO v_bad, v_names
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid = 'public.import_batches'::regclass
     AND r.rolname IN ('authenticated','anon')
     AND a.privilege_type <> 'SELECT';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: authenticated/anon hold non-SELECT grants on import_batches (%). Phase A granted SELECT only, as the belt for the missing policies.', v_names;
  END IF;

  -- (e) No trigger on the table. Phase A installed none here (the
  -- write-once guard is on residents and vehicles), so one appearing
  -- would be an unswept writer of every column below.
  SELECT count(*), string_agg(tgname, ', ') INTO v_bad, v_names
    FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: import_batches has % trigger(s) (%) that Phase A did not install. Sweep them before widening the allowlist.', v_bad, v_names;
  END IF;

  -- (f) Nothing in the catalog reads approved_by by name — no function
  -- body, no view definition. The repo sweep covers app code; this
  -- covers what the dashboard can add without touching the repo.
  SELECT count(*), string_agg(p.proname, ', ') INTO v_bad, v_names
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ '\mapproved_by\M';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: % function(s) reference approved_by (%). They must be read before its type changes.', v_bad, v_names;
  END IF;

  SELECT count(*), string_agg(viewname, ', ') INTO v_bad, v_names
    FROM pg_views
   WHERE schemaname = 'public' AND definition ~ '\mapproved_by\M';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'sweep: % view(s) reference approved_by (%).', v_bad, v_names;
  END IF;

  RAISE NOTICE 'sweep clean: no approvals yet, no write policy, no write grant, no trigger, no catalog reader of approved_by';
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — 'approved' joins the status allowlist
-- ════════════════════════════════════════════════════════════════════
-- Approve and Load are separate decisions, so there has to be a state
-- between them. Without it an approved-but-unloaded batch would sit in
-- 'submitted' (indistinguishable from unreviewed, so the queue could
-- not show Jose what he has already decided) or in 'loaded' (a lie, and
-- the one that makes import_batch_id meaningless because no row carries
-- it).
--
-- 🔴 ALLOWLIST, NOT DENYLIST, DELIBERATELY. An unknown status must fail
-- closed, which is why this is a migration rather than nothing.
ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_status_allowed;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_status_allowed
  CHECK (status IN ('submitted', 'approved', 'rejected', 'loaded', 'rolled_back'));

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — 🔴 'approved' counts as LIVE for the duplicate guard
-- ════════════════════════════════════════════════════════════════════
-- This is the half that fails silently. The partial unique index was
--   WHERE status IN ('submitted', 'loaded')
-- so an approved-but-unloaded batch would drop out of "live" and:
--   1. the CA resubmits the identical file — reasonably, nothing told
--      them it was approved — and the insert now SUCCEEDS;
--   2. two rows exist for the same bytes on the same property;
--   3. both are loadable, and loading both inserts 228 residents and
--      358 vehicles TWICE.
-- Nothing errors at any step. The only thing standing between an
-- approval and a double load is this WHERE clause.
DROP INDEX IF EXISTS public.import_batches_one_live_per_file;
CREATE UNIQUE INDEX import_batches_one_live_per_file
  ON public.import_batches (property_id, file_sha256)
  WHERE status IN ('submitted', 'approved', 'loaded');

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — an approval must name who and when
-- ════════════════════════════════════════════════════════════════════
-- The constraint's intent already covered this; its list predates the
-- state. Without 'approved' in it, a row could reach approved with
-- approved_by NULL — an approval with no record of who approved it.
ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_approval_complete;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_approval_complete
  CHECK (status NOT IN ('approved', 'loaded', 'rolled_back')
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL));

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — approved_by becomes the approver's user id
-- ════════════════════════════════════════════════════════════════════
-- The customer's half of this record is pinned to a uid
-- (attested_by_user_id UUID NOT NULL); the operator's half was a string.
-- An email identifies a person until they change it, and then the audit
-- trail of 586 inserted records names a mailbox that may belong to
-- someone else. Part 0 proved no row carries a value, so there is
-- nothing to convert and the USING clause is a formality that would
-- raise rather than coerce if that changed between writing and applying.
ALTER TABLE public.import_batches
  ALTER COLUMN approved_by TYPE UUID USING NULLIF(btrim(approved_by), '')::UUID;

COMMENT ON COLUMN public.import_batches.approved_by IS
  'The auth user id of the operator who approved this batch, set only by approve_import_batch(). 🔴 A UUID rather than an email, matching attested_by_user_id: this row is the provenance of every record the load inserts, and an email names a mailbox that may later belong to someone else. The display name is joined at read time, never stored here.';

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — where the returned error list lives
-- ════════════════════════════════════════════════════════════════════
-- 🔴 A FIFTH ITEM, BECAUSE THE RULING CANNOT BE IMPLEMENTED WITHOUT ONE.
--
-- The ruling: a stale load gives Jose one click, "Return to company",
-- which sets rejected with an auto-generated reason "and attaches the
-- fresh row-numbered error file. The CA sees it and resubmits."
--
-- There is nowhere for that file to go today. The CA has INSERT on the
-- bulk-onboarding bucket and NO SELECT — bulk_csv_ca_insert is INSERT
-- only, bulk_csv_admin_select is admin-only — so a CSV written to the
-- bucket is a file the CA cannot read. Giving them a SELECT policy
-- would be the first crack in a bucket whose whole design is "customer
-- writes, operator reads".
--
-- So the errors live on the row, which the CA already reads through
-- ib_company_admin_select, and the CA page builds the row-numbered CSV
-- from them client-side — the same list, through the same code path the
-- preview's error download already uses.
--
-- reject_error_count is the TRUE total and is separate on purpose: if
-- reject_errors is ever capped, a consumer must be able to tell a
-- complete list from a truncated one. A truncated error file that does
-- not say it is truncated sends the CA to fix eight problems out of
-- forty and resubmit into the same rejection.
ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS reject_errors JSONB,
  ADD COLUMN IF NOT EXISTS reject_error_count INT;

ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_reject_errors_shape;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_reject_errors_shape
  CHECK (
    -- Either both are absent, or both are present and agree in
    -- direction: the stored list may be shorter than the count (capped)
    -- but never longer, and a count without a list is a claim with no
    -- evidence.
    (reject_errors IS NULL AND reject_error_count IS NULL)
    OR (jsonb_typeof(reject_errors) = 'array'
        AND reject_error_count IS NOT NULL
        AND reject_error_count >= jsonb_array_length(reject_errors)
        AND reject_error_count > 0)
  );

COMMENT ON COLUMN public.import_batches.reject_errors IS
  'The row-numbered validation errors attached when a batch is returned to the company, as a JSONB array of the same {row, column, code, message} objects the preview returns. Written only by return_import_batch_to_company(). 🔴 It lives on the row rather than as a file in the bucket because the CA has INSERT and no SELECT there, so a CSV in the bucket is a file they cannot read — and the bucket''s design is customer-writes/operator-reads. The CA page builds the downloadable CSV from this column through the same path as the preview''s error download.';

COMMENT ON COLUMN public.import_batches.reject_error_count IS
  'The TRUE number of validation errors found, which may exceed jsonb_array_length(reject_errors) if the stored list was capped. Separate from the list on purpose: a truncated error file that does not say it is truncated sends the CA to fix some of their problems and resubmit into the same rejection.';

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
-- Outside the transaction so it prints whether or not the editor
-- wrapped the above, and so a partial apply cannot report success.
SELECT
  'approval-queue schema' AS migration,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_status_allowed') AS status_allowlist,
  (SELECT pg_get_expr(indpred, indrelid) FROM pg_index
    WHERE indexrelid = 'public.import_batches_one_live_per_file'::regclass) AS live_index_predicate,
  (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'public.import_batches'::regclass AND attname = 'approved_by') AS approved_by_type;
