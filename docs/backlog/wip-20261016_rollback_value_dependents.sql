-- ════════════════════════════════════════════════════════════════════
-- ROLLBACK, PART 2 — the eight dependents an FK walk cannot see
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-16 after the sweep. Apply after
-- wip-20261016_rollback.sql.
--
-- 🔴 ORDERING HAZARD: once this is applied, do NOT re-apply
-- wip-20261016_rollback.sql — it would replace the function with the
-- version that checks only the three foreign keys. Verification files
-- are the re-runnable ones.
--
-- Paired: wip-20261016_rollback_value_dependents_verification.sql
-- Execution half: npm run verify:rollback
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block and Run ONCE.
--
-- ── 🔴 WHAT THE SWEEP FOUND ─────────────────────────────────────────
-- The dynamic FK walk discovers three referencing relationships. The
-- live schema has ELEVEN things that depend on a resident or a vehicle,
-- because the other eight reference them BY VALUE — an email, a
-- normalized plate — and a foreign-key walk is blind to those.
--
-- Rolling back without them deletes a resident and leaves their space
-- assignment, their guest authorization and their open dispute
-- pointing at nobody; and deletes a vehicle while leaving a violation
-- and a tow-log entry pointing at a plate with no vehicle row.
--
-- 🔴 THE TWO PLATE ONES MATTER MOST, and were in neither original
-- list. Enforcement is what the product is for: a property loads 358
-- cars in the morning and by the afternoon one of them has a ticket or
-- has been towed. violations and vehicle_removals are where a rollback
-- does its most visible damage, and vehicle_removals is a LOG — the
-- standing rule is that it is a log and not enforcement, so an entry
-- there must not be silently detached either.
--
-- ── 🔴 WHY THE LIST IS A FUNCTION AND NOT A LITERAL IN THE BODY ─────
-- Because the verification has to COUNT it, and counting it by reading
-- the body with a regex is the mistake this arc has already made twice
-- — a comment quoting the thing asserted defeats the count. As a
-- set-returning function the list is DATA: the gate runs
--   SELECT count(*) FROM public.import_batch_value_dependents()
-- and gets 8 by execution. A ninth value reference added to the schema
-- without being added here fails that gate.
--
-- The FK walk is self-maintaining and this list is not. That asymmetry
-- is the whole reason the count assertion is required.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────
-- audit_logs       a log is meant to outlive its subject, and rollback
--                  writes its own audit row — blocking on audit rows
--                  would make it block on itself.
-- visitor_passes   a pass belongs to a VISITOR. The same plate at the
--                  same property is a coincidence, not a reference: the
--                  pass did not come to exist because a vehicle row
--                  did, and removing the row leaves it exactly as true.
-- authorized_plates, do_not_tow_plates, property_plate_prohibitions
--                  plate LISTS — configuration about a plate,
--                  independent of whether any vehicle row exists.
-- guest_authorizations.plate
--                  that is the GUEST's plate, not the resident's
--                  vehicle. The resident_email on the same table is
--                  the real dependency and is checked.
-- guest_auth_chain_summary, guest_auth_long_chains
--                  views. Confirmed: "cannot delete from view".
-- every *_by_email / issued_by / created_by column elsewhere
--                  ACTOR columns — a staff member who did something,
--                  not a resident this batch created.
-- Ruled 2026-10-16: visitor_passes and authorized_plates independent.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 0 — sweep
-- ════════════════════════════════════════════════════════════════════
DO $do$
DECLARE v_n INT; v_s TEXT;
BEGIN
  IF to_regprocedure('public.rollback_import_batch(bigint)') IS NULL THEN
    RAISE EXCEPTION 'sweep: rollback_import_batch(bigint) is absent. Apply wip-20261016_rollback.sql first.';
  END IF;
  IF to_regprocedure('public.normalize_plate(text)') IS NULL THEN
    RAISE EXCEPTION 'sweep: normalize_plate(text) is absent. The plate-keyed checks must use the SAME normalizer the plate uniqueness index uses, or they compare a different key than the one that collides.';
  END IF;
  -- Every table and column the new checks name must exist, or a
  -- dynamic query would fail at rollback time rather than here.
  FOR v_s IN SELECT unnest(ARRAY[
      'space_residents','space_assignment_history','space_payments','space_requests',
      'guest_authorizations','dispute_requests','violations','vehicle_removals'])
  LOOP
    IF to_regclass('public.' || v_s) IS NULL THEN
      RAISE EXCEPTION 'sweep: table public.% does not exist', v_s;
    END IF;
  END LOOP;
  -- resident_email on the six.
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.space_residents'::regclass,'public.space_assignment_history'::regclass,
                      'public.space_payments'::regclass,'public.space_requests'::regclass,
                      'public.guest_authorizations'::regclass,'public.dispute_requests'::regclass)
     AND attname = 'resident_email' AND NOT attisdropped;
  IF v_n <> 6 THEN RAISE EXCEPTION 'sweep: resident_email is on % of the 6 email-keyed tables', v_n; END IF;
  -- space_id on the two that scope through spaces.
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.space_residents'::regclass,'public.space_assignment_history'::regclass)
     AND attname = 'space_id' AND NOT attisdropped;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'sweep: space_id is on % of 2. Those two have no property column, so they MUST scope through spaces.property — matching resident_email alone over-refuses, because the same address can be a resident at another property.', v_n;
  END IF;
  -- plate, property and created_at on the two plate-keyed ones.
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid IN ('public.violations'::regclass,'public.vehicle_removals'::regclass)
     AND attname IN ('plate','property','created_at') AND NOT attisdropped;
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'sweep: expected plate, property and created_at on both plate-keyed tables (6 columns), found %. created_at carries the time scope: a plate was in the lot before it was loaded, so a violation predating the load is not a dependent.', v_n;
  END IF;
  RAISE NOTICE 'sweep clean: normalize_plate present, 8 tables present, 6 resident_email, 2 space_id, plate/property/created_at on both';
END
$do$;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — the list, as DATA so it can be counted
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.import_batch_value_dependents()
RETURNS TABLE (tbl TEXT, key_kind TEXT, scope_kind TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  VALUES
    -- Keyed on the resident's address. No time scope is needed: the
    -- validator refuses a file containing an address already on file
    -- at that property, so any match here arrived after the load.
    ('space_residents',          'resident_email', 'via_space'),
    ('space_assignment_history', 'resident_email', 'via_space'),
    ('space_payments',           'resident_email', 'property'),
    ('space_requests',           'resident_email', 'property'),
    ('guest_authorizations',     'resident_email', 'property'),
    ('dispute_requests',         'resident_email', 'property'),
    -- Keyed on the normalized plate at the property, SINCE THE LOAD.
    ('violations',               'plate',          'property_since_load'),
    ('vehicle_removals',         'plate',          'property_since_load')
$fn$;

COMMENT ON FUNCTION public.import_batch_value_dependents() IS
  'The eight tables that reference a resident or a vehicle BY VALUE rather than by foreign key, with the key and the scope each needs. rollback_import_batch iterates it; the paired verification COUNTS it and requires 8. 🔴 It is a function rather than a literal inside the rollback body so the count is an execution check — counting it by reading the body with a regex is the mistake this arc already made twice, because a comment quoting the thing asserted defeats the count. The FK walk is self-maintaining and this list is not, which is why the count assertion exists: a ninth value reference added to the schema without being added here fails the gate.';

REVOKE ALL ON FUNCTION public.import_batch_value_dependents() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_batch_value_dependents() FROM anon;
GRANT EXECUTE ON FUNCTION public.import_batch_value_dependents() TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_batch_value_dependents() TO service_role;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — rollback, with the value checks alongside the FK walk
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.rollback_import_batch(p_batch_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid       UUID;
  v_status    TEXT;
  v_loaded_at TIMESTAMPTZ;
  v_prop_id   BIGINT;
  v_prop      TEXT;
  v_res_n     INT;
  v_veh_n     INT;
  v_role_n    INT;
  v_claimed   JSONB;
  v_claimed_n INT;
  v_dep       RECORD;
  v_vdep      RECORD;
  v_sql       TEXT;
  v_hits      BIGINT;
  v_blockers  JSONB := '[]'::jsonb;
  v_checked   INT := 0;
BEGIN
  IF NOT public.is_active_import_operator() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator');
  END IF;
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_caller_identity',
      'detail', 'A rollback records who did it. A call with no auth.uid() cannot.');
  END IF;

  SELECT status, loaded_at, property_id INTO v_status, v_loaded_at, v_prop_id
    FROM public.import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_such_batch');
  END IF;
  IF v_status <> 'loaded' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wrong_status', 'status', v_status,
      'detail', 'Only a loaded batch can be rolled back.');
  END IF;

  IF v_loaded_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_load_time',
      'detail', 'This batch is marked loaded with no load time, so same-day cannot be decided and the plate checks have no window. Do not roll it back without looking at it.');
  END IF;
  IF (v_loaded_at AT TIME ZONE 'America/Chicago')::date <> public.current_date_central() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_same_day',
      'loaded_on', (v_loaded_at AT TIME ZONE 'America/Chicago')::date,
      'today',     public.current_date_central(),
      'detail', 'Rollback is same-day only. This batch was loaded on an earlier day, and residents have had time to use it — removing their records now would take away access they have been relying on.');
  END IF;

  SELECT p.name INTO v_prop FROM public.properties p WHERE p.id = v_prop_id;
  IF v_prop IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'property_missing',
      'detail', 'This batch points at a property that could not be read.');
  END IF;

  -- ── anyone who has claimed stops the whole rollback ──────────────
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('email', t.email, 'unit', t.unit)
                                      ORDER BY t.unit, t.email), '[]'::jsonb)
    INTO v_claimed_n, v_claimed
    FROM (
      SELECT r.email, r.unit
        FROM public.residents r
        JOIN auth.users u ON lower(btrim(u.email)) = lower(btrim(r.email))
       WHERE r.import_batch_id = p_batch_id
       LIMIT 200
    ) t;
  IF v_claimed_n > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_claimed',
      'claimed_count', v_claimed_n, 'claimed', v_claimed,
      'detail', 'Residents in this batch have already set up logins. A login is not something a rollback can take back — deleting their role row would leave them signed in with no access, and deleting the account is not part of an undo. Deactivate the ones that should not be there instead.');
  END IF;

  -- ── dependents by FOREIGN KEY, discovered ────────────────────────
  FOR v_dep IN
    SELECT (con.conrelid::regclass)::TEXT  AS referencing,
           (con.confrelid::regclass)::TEXT AS target,
           a.attname                       AS fk_column,
           con.conname                     AS fk_name,
           EXISTS (SELECT 1 FROM pg_attribute ia
                    WHERE ia.attrelid = con.conrelid
                      AND ia.attname = 'import_batch_id'
                      AND NOT ia.attisdropped) AS has_stamp
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND con.confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)
       AND array_length(con.conkey, 1) = 1
  LOOP
    v_sql := format(
      'SELECT count(*) FROM %s d WHERE d.%I IN (SELECT id FROM %s WHERE import_batch_id = $1)%s',
      v_dep.referencing, v_dep.fk_column, v_dep.target,
      CASE WHEN v_dep.has_stamp THEN ' AND d.import_batch_id IS DISTINCT FROM $1' ELSE '' END);
    EXECUTE v_sql INTO v_hits USING p_batch_id;
    v_checked := v_checked + 1;
    IF v_hits > 0 THEN
      v_blockers := v_blockers || jsonb_build_object(
        'table', v_dep.referencing, 'key', v_dep.fk_column, 'rows', v_hits,
        'how', 'foreign key', 'constraint', v_dep.fk_name);
    END IF;
  END LOOP;

  -- ── 🔴 dependents BY VALUE, from the counted list ────────────────
  -- An FK walk cannot see these. Each is scoped to this property, so a
  -- resident with the same address at a DIFFERENT property does not
  -- block, and the plate ones are scoped to rows created since the
  -- load, because a plate was in the lot before it was loaded and a
  -- violation written last week never referred to the vehicle row.
  FOR v_vdep IN SELECT * FROM public.import_batch_value_dependents() LOOP
    v_sql := CASE v_vdep.key_kind || '|' || v_vdep.scope_kind
      WHEN 'resident_email|property' THEN format($q$
        SELECT count(*) FROM public.%I d
         WHERE lower(btrim(d.resident_email)) IN (
                 SELECT lower(btrim(r.email)) FROM public.residents r
                  WHERE r.import_batch_id = $1)
           AND lower(btrim(d.property)) = lower(btrim($2))$q$, v_vdep.tbl)
      -- No property column on these two: scope through the space.
      WHEN 'resident_email|via_space' THEN format($q$
        SELECT count(*) FROM public.%I d
         WHERE lower(btrim(d.resident_email)) IN (
                 SELECT lower(btrim(r.email)) FROM public.residents r
                  WHERE r.import_batch_id = $1)
           AND EXISTS (SELECT 1 FROM public.spaces s
                        WHERE s.id = d.space_id
                          AND lower(btrim(s.property)) = lower(btrim($2)))$q$, v_vdep.tbl)
      WHEN 'plate|property_since_load' THEN format($q$
        SELECT count(*) FROM public.%I d
         WHERE public.normalize_plate(d.plate) IN (
                 SELECT public.normalize_plate(v.plate) FROM public.vehicles v
                  WHERE v.import_batch_id = $1)
           AND lower(btrim(d.property)) = lower(btrim($2))
           AND d.created_at >= $3$q$, v_vdep.tbl)
      ELSE NULL
    END;
    -- 🔴 AN UNHANDLED KIND REFUSES THE ROLLBACK. If a row is added to
    -- the list with a key or scope this CASE does not implement, the
    -- alternative is skipping it silently — which is exactly the
    -- failure the list exists to prevent.
    IF v_sql IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'unhandled_dependent_kind',
        'table', v_vdep.tbl, 'key_kind', v_vdep.key_kind, 'scope_kind', v_vdep.scope_kind,
        'detail', 'A dependent was listed with a key or scope the rollback does not know how to check. Nothing was removed. This is a code gap, not a data problem.');
    END IF;
    IF v_vdep.key_kind = 'plate' THEN
      EXECUTE v_sql INTO v_hits USING p_batch_id, v_prop, v_loaded_at;
    ELSE
      EXECUTE v_sql INTO v_hits USING p_batch_id, v_prop;
    END IF;
    v_checked := v_checked + 1;
    IF v_hits > 0 THEN
      v_blockers := v_blockers || jsonb_build_object(
        'table', 'public.' || v_vdep.tbl, 'key', v_vdep.key_kind, 'rows', v_hits,
        'how', CASE WHEN v_vdep.scope_kind = 'property_since_load'
                    THEN 'matched by normalized plate at this property, created since the load'
                    WHEN v_vdep.scope_kind = 'via_space'
                    THEN 'matched by resident address, scoped through the space''s property'
                    ELSE 'matched by resident address at this property' END);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'has_dependents',
      'blockers', v_blockers, 'checks_run', v_checked,
      'detail', 'Other records now point at rows this batch created — a space assignment, a guest authorization, a dispute, a violation, a tow-log entry. Removing the batch would orphan or destroy them, and that is not an undo. Each one is listed above with how many rows; resolve those first.');
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- 🔴 ONE UNIT. The deletes and the status change share an EXCEPTION
  -- block, so a failure anywhere rolls back every delete AND leaves the
  -- batch 'loaded'. A half-undone load is worse than one still there.
  -- ══════════════════════════════════════════════════════════════════
  BEGIN
    DELETE FROM public.vehicles WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_veh_n = ROW_COUNT;
    DELETE FROM public.user_roles WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_role_n = ROW_COUNT;
    DELETE FROM public.residents WHERE import_batch_id = p_batch_id;
    GET DIAGNOSTICS v_res_n = ROW_COUNT;

    UPDATE public.import_batches
       SET status = 'rolled_back'
     WHERE id = p_batch_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN jsonb_build_object('ok', false, 'error', 'has_dependents',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Something references a row this batch created that the pre-flight did not find. Nothing was removed and the batch is still loaded.');
    WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'error', 'rollback_failed',
        'sqlstate', SQLSTATE, 'detail', SQLERRM,
        'hint', 'Nothing was removed and the batch is still loaded. It can be retried.');
  END;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'status', 'rolled_back',
    'residents', v_res_n, 'vehicles', v_veh_n, 'roles', v_role_n,
    'checks_run', v_checked, 'rolled_back_by', v_uid);
END
$fn$;

COMMENT ON FUNCTION public.rollback_import_batch(BIGINT) IS
  'Same-day undo of a loaded bulk-onboarding batch, in ONE transaction: deletes vehicles, the stamped role rows and residents by import_batch_id and sets rolled_back. Active-admin only, FOR UPDATE, loaded-only, hash-independent. 🔴 Same-day means the PROPERTY''S day via current_date_central(). 🔴 REFUSES if any resident has an auth account, listing them — a login is the one thing no transaction can undo, and that refusal also closes the unstamped-role-row question. 🔴 ELEVEN DEPENDENT CHECKS: three foreign keys discovered from pg_constraint, plus EIGHT value references from import_batch_value_dependents() that an FK walk is blind to — six keyed on the resident''s address and two on the normalized plate. The plate checks are scoped to rows created since the load, because a plate was in the lot before it was loaded and a violation written last week never referred to the vehicle row; space_residents and space_assignment_history have no property column and scope through spaces.property, since matching the address alone would refuse because of a resident with the same address at another property. Every blocker is returned with its table, key and row count so it can be resolved by hand. 🔴 visitor_passes and authorized_plates are deliberately NOT dependents (ruled 2026-10-16): a pass belongs to a visitor and a plate list is configuration, so neither came to exist because a vehicle row did, and removing the row leaves both exactly as true as they were. audit_logs is excluded because a log outlives its subject and rollback writes its own.';

REVOKE ALL ON FUNCTION public.rollback_import_batch(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rollback_import_batch(BIGINT) FROM anon;
GRANT EXECUTE ON FUNCTION public.rollback_import_batch(BIGINT) TO authenticated;

COMMIT;

-- ── after COMMIT: the PASS row ──────────────────────────────────────
SELECT
  'rollback value dependents' AS migration,
  (SELECT count(*)::INT FROM public.import_batch_value_dependents()) AS value_checks_want_8,
  (SELECT count(*)::INT FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)) AS fk_checks,
  (SELECT count(*)::INT FROM public.import_batch_value_dependents())
    + (SELECT count(*)::INT FROM pg_constraint
        WHERE contype = 'f'
          AND confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)) AS total_want_11,
  'execution half: npm run verify:rollback' AS and_then;
