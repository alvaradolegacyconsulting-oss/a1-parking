-- ════════════════════════════════════════════════════════════════════
-- THE LOADER — one transaction, all or nothing
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-16. Apply after wip-20261016_reject_and_audit.sql.
--
-- Paired: wip-20261016_loader_verification.sql
-- Execution half: npm run verify:loader  (on batch 8)
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block and Run ONCE.
--
-- 🔴 ORDERING: once this is applied, do not re-apply any earlier
-- one-time migration in this arc. Verification files are the
-- re-runnable ones.
--
-- ── WHY THE WHOLE LOAD IS ONE SQL FUNCTION ──────────────────────────
-- "A failed load leaves the batch approved and retryable" is only true
-- if a failed attempt left nothing behind. A route issuing three
-- PostgREST calls cannot promise that: 120 residents in and a failure
-- leaves 120 rows that the retry either duplicates or trips the plate
-- unique index on, and the batch is stuck in a state no button
-- resolves.
--
-- 🔴 AND IT IS AVAILABLE HERE, WHICH IT WAS NOT FOR THE CASCADE. That
-- ruling said process each user independently, because banning an auth
-- user is an HTTP call to GoTrue no transaction can undo. The loader
-- touches NO auth: a bulk-loaded resident gets records and no login,
-- and the login comes later through the /claim door. So one
-- transaction, and the ruling requires it.
--
-- ── 🔴 WHAT THIS FUNCTION TRUSTS, SAID PLAINLY ──────────────────────
-- It cannot read the file: Supabase keeps object BYTES in S3 and only
-- metadata in storage.objects, and digest() is not exposed. So the rows
-- arrive as a parameter from the route, which read and hashed the
-- object itself.
--
-- The file hash proves the FILE is unchanged. It does not prove p_rows
-- was derived from it. What is checkable in SQL is the payload's SHAPE
-- against counts computed server-side at submit from the hashed bytes
-- and immutable since:
--   jsonb_array_length(p_rows)        must equal vehicle_count
--   count(distinct lower(email))      must equal resident_count
-- That catches a truncated, padded or re-ordered-and-deduplicated
-- payload. It does not catch a substituted one, and the trust boundary
-- for that is the operator's own session — the same boundary as "was it
-- re-validated", and stated for the same reason.
--
-- ── WRITER SWEEP (binding) ──────────────────────────────────────────
-- residents.import_batch_id and vehicles.import_batch_id: 41 existing
-- write sites across the two tables, NONE of which sets the column —
-- which is why it is nullable and why import_batch_write_once_guard is
-- inert for all of them. This function is the FIRST writer. The guard
-- permits it because it is not an `authenticated` session
-- (current_user is the owner inside a DEFINER function) and because it
-- writes the column on INSERT from NULL, which is not the re-pointing
-- the guard refuses.
--
-- user_roles: 8 writers, enumerated in the cascade-stamps header. This
-- function is the 9th. 🔴 It writes role = 'resident' and nothing else,
-- ever — asserted structurally in the paired verification and by
-- execution in the gate. None of the 8 touches import_batch_id, which
-- part 1a adds there, and the trigger is scoped `UPDATE OF` it, so it
-- is inert for all of them.
--
-- 🔴 PART 1a IS A DESIGN CONSEQUENCE, NOT SCOPE CREEP. "Stamped on
-- every row" and "the loader creates the resident user_roles rows" are
-- both in the ruling, and the stamp did not exist on that table. The
-- alternative is a rollback that derives its targets, which is the
-- thing the cascade-stamps work removed.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — sweep
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE v_n INT; v_s TEXT;
BEGIN
  IF to_regprocedure('public.is_active_import_operator()') IS NULL THEN
    RAISE EXCEPTION 'sweep: is_active_import_operator() is absent. Apply the approve/return RPCs first.';
  END IF;
  -- The stamp columns and their guard must both be in place: the
  -- loader's correctness and rollback's both depend on the column being
  -- truthful, and the guard is what keeps it so.
  IF to_regprocedure('public.import_batch_write_once_guard()') IS NULL THEN
    RAISE EXCEPTION 'sweep: import_batch_write_once_guard() is absent. Rollback deletes by import_batch_id; without the guard a client could forge or clear the association.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)
     AND attname = 'import_batch_id' AND NOT attisdropped;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'sweep: import_batch_id is on % of the 2 data tables', v_n;
  END IF;
  -- 🔴 user_roles writers, swept before part 1a adds the column there.
  -- Eight writers (enumerated in the cascade-stamps header): the
  -- resident self-register INSERT, the /admin driver INSERT, two
  -- cascade is_active UPDATEs, the CA portal's narrow `clean` UPDATE,
  -- lib/user-active's service_role UPDATE, the Stripe
  -- checkout-session-completed INSERT/UPDATE, prospect-demo's INSERT,
  -- and the insert_user_role family of DEFINER RPCs. NONE of them
  -- touches import_batch_id, and the trigger added below is scoped
  -- `UPDATE OF` it, so it is inert for every one.
  SELECT count(*) INTO v_n FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc ~ '\mimport_batch_id\M';
  RAISE NOTICE 'sweep: % existing function(s) mention import_batch_id (the write-once guard, and the loader once applied)', v_n;
  -- 🔴 The plate unique index is the backstop against a double load.
  -- If it is gone, a second load would silently duplicate 358 vehicles.
  IF to_regclass('public.vehicles_plate_norm_uniq') IS NULL THEN
    RAISE EXCEPTION 'sweep: vehicles_plate_norm_uniq is absent — the one thing that would refuse a second load of the same plates.';
  END IF;
  SELECT count(*), string_agg(tgname, ', ') INTO v_n, v_s FROM pg_trigger
   WHERE tgrelid = 'public.import_batches'::regclass AND NOT tgisinternal;
  IF v_n <> 1 OR v_s IS DISTINCT FROM 'import_batches_status_audit' THEN
    RAISE EXCEPTION 'sweep: expected the audit trigger and only it on import_batches, found % (%)', v_n, COALESCE(v_s, '(none)');
  END IF;
  RAISE NOTICE 'sweep clean: operator gate, stamp guard, both stamp columns, plate index, audit trigger';
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — what the load records about itself
-- ════════════════════════════════════════════════════════════════════
-- resident_count and vehicle_count are what the FILE claimed, computed
-- at submit. These are what was actually WRITTEN. They should match,
-- and the point of storing both is that rollback can check it deleted
-- the number that went in rather than trusting the file's arithmetic.
ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS loaded_at             TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS loaded_by             UUID        NULL,
  ADD COLUMN IF NOT EXISTS loaded_resident_count INT         NULL,
  ADD COLUMN IF NOT EXISTS loaded_vehicle_count  INT         NULL;

COMMENT ON COLUMN public.import_batches.loaded_resident_count IS
  'How many residents the load actually INSERTED, as opposed to resident_count which is what the file claimed at submit. Stored separately so rollback can verify it deleted the number that went in rather than trusting the file''s arithmetic — and so a disagreement between the two is visible rather than silently reconciled.';

ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_loaded_complete;
ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_loaded_complete
  CHECK (
    -- 🔴 Every conjunct is IS NOT NULL or a comparison between non-null
    -- values, so no branch can evaluate to UNKNOWN. A CHECK accepts
    -- UNKNOWN, which is how the reject_errors shape shipped with a hole.
    status <> 'loaded'
    OR (loaded_at IS NOT NULL
        AND loaded_by IS NOT NULL
        AND loaded_resident_count IS NOT NULL
        AND loaded_vehicle_count IS NOT NULL)
  );

-- ════════════════════════════════════════════════════════════════════
-- PART 1a — 🔴 the stamp on user_roles, because the loader creates rows there
-- ════════════════════════════════════════════════════════════════════
-- The ruling is "import_batch_id stamped on every row", and the loader
-- creates rows in THREE tables: residents, vehicles and user_roles.
-- Only the first two had the column.
--
-- 🔴 WITHOUT THIS, ROLLBACK CANNOT FIND THE ROLE ROWS. It deletes by
-- import_batch_id; the role rows would have no stamp, so it would have
-- to DERIVE them — "every resident role row at this company whose
-- address matches a resident I am deleting and which has no auth
-- account". That is exactly the shape the cascade-stamps work was done
-- to remove: a reverse that derives its targets acts on rows it never
-- created. One address that happened to match would lose a role nobody
-- asked it to lose.
--
-- Same column shape, same ON DELETE RESTRICT, same write-once guard —
-- the guard function is already generic over NEW.import_batch_id and
-- TG_OP, so it needs no change, only a third trigger.
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS import_batch_id BIGINT NULL
  REFERENCES public.import_batches(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS user_roles_import_batch_id_idx
  ON public.user_roles (import_batch_id) WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.user_roles.import_batch_id IS
  'The bulk-onboarding batch that created this role row, or NULL for every other path. 🔴 LOADER-ONLY AND WRITE-ONCE, enforced by the same import_batch_write_once_guard as residents and vehicles. Rollback deletes by this column; without it the role rows would have to be derived from the residents being deleted, and a reverse that derives its targets acts on rows it never created.';

DROP TRIGGER IF EXISTS user_roles_import_batch_write_once ON public.user_roles;
CREATE TRIGGER user_roles_import_batch_write_once
  BEFORE INSERT OR UPDATE OF import_batch_id ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.import_batch_write_once_guard();

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — the loader
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.load_import_batch(
  p_batch_id    BIGINT,
  p_file_sha256 TEXT,
  p_rows        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid      UUID;
  v_status   TEXT;
  v_sha      TEXT;
  v_prop_id  BIGINT;
  v_res_want INT;
  v_veh_want INT;
  v_prop     TEXT;
  v_company  TEXT;
  v_res_n    INT;
  v_veh_n    INT;
  v_role_n   INT;
  v_distinct INT;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_caller_identity',
      'detail', 'A load records who loaded it. A call with no auth.uid() cannot.');
  END IF;

  SELECT status, file_sha256, property_id, resident_count, vehicle_count
    INTO v_status, v_sha, v_prop_id, v_res_want, v_veh_want
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;

  -- 🔴 APPROVED ONLY. Approve and Load are separate decisions and this
  -- is the second one; a submitted batch has not had the first.
  IF v_status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status', 'status', v_status,
      'detail', CASE WHEN v_status = 'loaded'
                     THEN 'This batch is already loaded. Loading it again would insert every record twice.'
                     ELSE 'Only an approved batch can be loaded.' END);
  END IF;

  IF v_sha IS DISTINCT FROM lower(btrim(COALESCE(p_file_sha256, ''))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sha_mismatch', 'expected', v_sha,
      'detail', 'The file being loaded is not the file on this batch. Reload the batch and review it again.');
  END IF;

  -- ── the payload's shape, against the attested counts ──────────────
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_rows',
      'detail', 'The rows to load were not supplied as an array.');
  END IF;
  IF jsonb_array_length(p_rows) <> v_veh_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'row_count_mismatch',
      'got', jsonb_array_length(p_rows), 'want', v_veh_want,
      'detail', 'The rows supplied do not match the row count recorded when this file was submitted.');
  END IF;
  SELECT count(DISTINCT lower(btrim(r->>'email'))) INTO v_distinct
    FROM jsonb_array_elements(p_rows) AS r;
  IF v_distinct <> v_res_want THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resident_count_mismatch',
      'got', v_distinct, 'want', v_res_want,
      'detail', 'The distinct residents in the rows supplied do not match the count recorded at submit.');
  END IF;

  -- The property and company are DERIVED from the batch, never passed.
  SELECT p.name, p.company INTO v_prop, v_company
    FROM public.properties p WHERE p.id = v_prop_id;
  IF v_prop IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'property_missing',
      'detail', 'This batch points at a property that could not be read.');
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- 🔴 EVERYTHING BELOW IS ONE UNIT. The EXCEPTION block creates a
  -- subtransaction, so any failure inside it rolls back every insert
  -- AND leaves status at 'approved' — because the status UPDATE is
  -- inside it too. That is the ruling made structural: a failed load
  -- leaves the batch approved, retryable, and with nothing behind it.
  -- ══════════════════════════════════════════════════════════════════
  BEGIN
    -- ── residents, one per distinct email ──────────────────────────
    WITH src AS (
      SELECT DISTINCT ON (lower(btrim(r->>'email')))
             lower(btrim(r->>'email'))                                        AS email,
             btrim(COALESCE(r->>'first_name','') || ' ' || COALESCE(r->>'last_name','')) AS name,
             NULLIF(btrim(COALESCE(r->>'phone','')), '')                      AS phone,
             btrim(COALESCE(r->>'unit',''))                                   AS unit
        FROM jsonb_array_elements(p_rows) AS r
       ORDER BY lower(btrim(r->>'email')), (r->>'unit')
    )
    INSERT INTO public.residents
      (name, email, phone, unit, property, company, is_active, status, import_batch_id)
    SELECT name, email, phone, unit, v_prop, v_company, TRUE, 'active', p_batch_id
      FROM src;
    GET DIAGNOSTICS v_res_n = ROW_COUNT;

    -- ── vehicles, one per row, ACTIVE ──────────────────────────────
    -- 🔴 is_active TRUE and status 'active': these are vehicles a
    -- property has already approved by uploading them, so they are not
    -- pending anything. That also puts them inside
    -- vehicles_plate_norm_uniq's predicate, which is what makes a
    -- second load of the same plates impossible rather than merely
    -- unlikely.
    --
    -- is_primary goes to the first vehicle per resident, in the file's
    -- own order, because something has to be and the file's order is
    -- the only expressed preference.
    WITH src AS (
      SELECT r, ROW_NUMBER() OVER (
               PARTITION BY lower(btrim(r->>'email'))
               ORDER BY ord
             ) AS seq
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
    )
    INSERT INTO public.vehicles
      (plate, state, make, model, color, unit, property, company,
       resident_email, is_active, status, is_primary, import_batch_id)
    SELECT upper(btrim(r->>'plate')),
           upper(btrim(NULLIF(COALESCE(r->>'plate_state',''), ''))),
           NULLIF(btrim(COALESCE(r->>'make','')),  ''),
           NULLIF(btrim(COALESCE(r->>'model','')), ''),
           NULLIF(btrim(COALESCE(r->>'color','')), ''),
           btrim(COALESCE(r->>'unit','')),
           v_prop, v_company,
           lower(btrim(r->>'email')),
           TRUE, 'active', (seq = 1), p_batch_id
      FROM src;
    GET DIAGNOSTICS v_veh_n = ROW_COUNT;

    -- ── the resident role rows ─────────────────────────────────────
    -- 🔴 role = 'resident', HARD-CODED, AND THE ONLY ROLE LITERAL IN
    -- THIS FUNCTION. Nothing in the ingest path can express a role: the
    -- template has 11 columns and none of them is one, and the two
    -- ingest libraries contain zero occurrences of the string. This is
    -- the last place a staff role could enter, and it cannot.
    --
    -- Created here rather than left to the claim step so a loaded
    -- resident is a complete identity immediately — get_my_role()
    -- returns NULL without one, which is the blank portal. The claim
    -- route already tolerates a pre-existing resident row and skips
    -- creating a second.
    --
    -- is_active TRUE with no auth account is deliberate and is the
    -- category /api/register/create-user now refuses outright, so the
    -- row protects the address rather than exposing it.
    INSERT INTO public.user_roles (email, role, company, property, is_active, import_batch_id)
    SELECT DISTINCT lower(btrim(r->>'email')), 'resident', v_company, ARRAY[v_prop], TRUE, p_batch_id
      FROM jsonb_array_elements(p_rows) AS r;
    GET DIAGNOSTICS v_role_n = ROW_COUNT;

    UPDATE public.import_batches
       SET status = 'loaded',
           loaded_at = now(),
           loaded_by = v_uid,
           loaded_resident_count = v_res_n,
           loaded_vehicle_count  = v_veh_n
     WHERE id = p_batch_id;

  EXCEPTION
    WHEN unique_violation THEN
      -- A plate already active at this property, or an address that
      -- already holds a role. Not transient: retrying changes nothing,
      -- and the route says so rather than offering a Retry.
      RETURN jsonb_build_object('ok', false, 'error', 'conflict',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Something in this file already exists. Nothing was loaded and the batch is unchanged. Re-review it — the record checks will name the rows.');
    WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'error', 'load_failed',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Nothing was loaded and the batch is still approved. It can be retried.');
  END;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', 'loaded',
    'residents', v_res_n, 'vehicles', v_veh_n, 'roles', v_role_n, 'loaded_by', v_uid);
END
$fn$;

COMMENT ON FUNCTION public.load_import_batch(BIGINT, TEXT, JSONB) IS
  'Loads an approved bulk-onboarding batch in ONE transaction: residents, vehicles (active, is_primary on the first per resident) and resident user_roles rows, every one stamped with import_batch_id. Active-admin only, FOR UPDATE, approved-only, and the file hash must match. 🔴 ALL OR NOTHING by construction: the inserts and the status UPDATE share an EXCEPTION block, so any failure rolls back everything and leaves the batch approved and retryable — which is what makes the ruling true rather than hoped. 🔴 role = ''resident'' is hard-coded and is the only role literal in the function; nothing in the ingest path can express a role at all. It CANNOT read the file (object bytes live in S3, not storage.objects), so the rows arrive from the route; the hash proves the file is unchanged and the payload''s length and distinct-email count are checked against the submit-time attested counts, which catches truncation and padding but not substitution — that boundary is the operator''s session, the same as re-validation. 🔴 It does NOT write parking tags: vehicle_parking_tags is set_vehicle_tag''s alone and is gated on properties.parking_tags_enabled, so a tag_number in the file is refused upstream rather than silently dropped here.';

REVOKE ALL ON FUNCTION public.load_import_batch(BIGINT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.load_import_batch(BIGINT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.load_import_batch(BIGINT, TEXT, JSONB) TO authenticated;

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'loader' AS migration,
  to_regprocedure('public.load_import_batch(bigint, text, jsonb)')::TEXT AS loader,
  (SELECT count(*)::INT FROM pg_attribute
    WHERE attrelid = 'public.import_batches'::regclass
      AND attname IN ('loaded_at','loaded_by','loaded_resident_count','loaded_vehicle_count')
      AND NOT attisdropped) AS loaded_columns_want_4,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid = 'public.import_batches'::regclass
      AND conname = 'import_batches_loaded_complete') AS loaded_complete,
  (SELECT count(*)::INT FROM pg_attribute
    WHERE attrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass, 'public.user_roles'::regclass)
      AND attname = 'import_batch_id' AND NOT attisdropped) AS stamp_columns_want_3,
  (SELECT count(*)::INT FROM pg_trigger
    WHERE tgname IN ('residents_import_batch_write_once','vehicles_import_batch_write_once','user_roles_import_batch_write_once')
      AND NOT tgisinternal) AS stamp_guards_want_3,
  'execution half: npm run verify:loader' AS and_then;
