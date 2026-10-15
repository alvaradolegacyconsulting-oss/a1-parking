-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — rollback's value dependents
-- ════════════════════════════════════════════════════════════════════
-- Pairs wip-20261016_rollback_value_dependents.sql. Re-runnable,
-- read-only, no transaction. Terminal SELECT returns the PASS row.
--
-- Run wip-20261016_rollback_verification.sql as well: that one still
-- covers the operator gate, same-day, the claim refusal and
-- all-or-nothing. This file covers the eleven dependent checks.
--
-- Execution half: npm run verify:rollback
--
-- 🔴 THE COUNT ASSERTION IS THE POINT OF THIS FILE. The FK walk is
-- self-maintaining — it discovers a referencing table added tomorrow.
-- The value list is not, and a value reference that is not on it is
-- not checked at all, which is exactly how this arc shipped a rollback
-- that would have orphaned six tables. So G2 counts the list BY
-- EXECUTION and requires 8, and G7 asserts the exclusions, so neither
-- an addition nor a quiet removal can pass.
--
-- Counting it by reading the function body with a regex would be the
-- third repeat of a mistake already made twice here: a comment quoting
-- the thing asserted defeats the count. The list is a set-returning
-- function so the count is data.
--
-- 🔴 Every RAISE format string counted by hand; %% is a literal percent.

DO $do$
DECLARE
  v_def  TEXT;
  v_src  TEXT;
  v_body TEXT;
  v_n    INT;
  v_fk   INT;
  v_s    TEXT;
  r      RECORD;
BEGIN
  -- ── G1. the list function ────────────────────────────────────────
  IF to_regprocedure('public.import_batch_value_dependents()') IS NULL THEN
    RAISE EXCEPTION 'G1 FAIL: import_batch_value_dependents() is absent';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.import_batch_value_dependents()'));
  IF v_def IS NULL THEN RAISE EXCEPTION 'G1 FAIL: it could not be read'; END IF;
  IF v_def !~ 'IMMUTABLE' THEN
    RAISE EXCEPTION 'G1 FAIL: the list is not IMMUTABLE. It is a constant; marking it so is what lets the planner and the reader treat it as one.';
  END IF;
  IF v_def !~ 'search_path' THEN RAISE EXCEPTION 'G1 FAIL: no pinned search_path'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid = to_regprocedure('public.import_batch_value_dependents()')::oid AND a.grantee = 0;
  IF v_n > 0 THEN RAISE EXCEPTION 'G1 FAIL: PUBLIC holds EXECUTE on the list'; END IF;
  RAISE NOTICE 'G1 ok: the list exists, IMMUTABLE, pinned, PUBLIC revoked';

  -- ── 🔴 G2. EXACTLY EIGHT, BY EXECUTION ───────────────────────────
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents();
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'G2 FAIL: the value-dependent list holds % entries, want exactly 8. A ninth value reference in the schema that is not on this list is NOT CHECKED AT ALL — that is how a rollback that would orphan six tables shipped. If a reference was genuinely added, add it to the list and raise this number in the same change.', v_n;
  END IF;
  -- And they are the eight that were swept, by name.
  FOR v_s IN SELECT unnest(ARRAY[
      'space_residents','space_assignment_history','space_payments','space_requests',
      'guest_authorizations','dispute_requests','violations','vehicle_removals'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.import_batch_value_dependents() d WHERE d.tbl = v_s) THEN
      RAISE EXCEPTION 'G2 FAIL: % is not on the value-dependent list. It references a resident or a vehicle by value, so dropping it means a rollback orphans its rows silently.', v_s;
    END IF;
  END LOOP;
  -- Six by address, two by plate.
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents() WHERE key_kind = 'resident_email';
  IF v_n <> 6 THEN RAISE EXCEPTION 'G2 FAIL: % entries keyed on resident_email, want 6', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents() WHERE key_kind = 'plate';
  IF v_n <> 2 THEN RAISE EXCEPTION 'G2 FAIL: % entries keyed on plate, want 2 — violations and vehicle_removals', v_n; END IF;
  -- The two with no property column must scope through the space.
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents()
   WHERE scope_kind = 'via_space' AND tbl IN ('space_residents','space_assignment_history');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'G2 FAIL: % of the 2 property-less tables scope via_space. Matching resident_email alone over-refuses, because the same address can be a resident at another property.', v_n;
  END IF;
  -- The two plate ones must carry the time scope.
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents()
   WHERE scope_kind = 'property_since_load';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'G2 FAIL: % entries scoped since the load, want 2. Without it a violation written before the plate was ever loaded blocks the undo of a load it predates.', v_n;
  END IF;
  RAISE NOTICE 'G2 ok: exactly 8 — 6 by address (2 via the space), 2 by plate since the load';

  -- ── G3. every listed table and column exists ─────────────────────
  -- A dynamic query over a missing column fails at ROLLBACK time,
  -- which is the worst possible moment to discover it.
  FOR r IN SELECT * FROM public.import_batch_value_dependents() LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE EXCEPTION 'G3 FAIL: public.% does not exist', r.tbl;
    END IF;
    IF r.key_kind = 'resident_email' AND NOT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass
          AND attname = 'resident_email' AND NOT attisdropped) THEN
      RAISE EXCEPTION 'G3 FAIL: %.resident_email does not exist', r.tbl;
    END IF;
    IF r.key_kind = 'plate' THEN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass
            AND attname IN ('plate','property','created_at') AND NOT attisdropped
          HAVING count(*) = 3) THEN
        RAISE EXCEPTION 'G3 FAIL: %.{plate,property,created_at} are not all present', r.tbl;
      END IF;
    END IF;
    IF r.scope_kind = 'via_space' AND NOT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass
          AND attname = 'space_id' AND NOT attisdropped) THEN
      RAISE EXCEPTION 'G3 FAIL: %.space_id does not exist, so it cannot scope through the space', r.tbl;
    END IF;
    IF r.scope_kind = 'property' AND NOT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || r.tbl)::regclass
          AND attname = 'property' AND NOT attisdropped) THEN
      RAISE EXCEPTION 'G3 FAIL: %.property does not exist', r.tbl;
    END IF;
  END LOOP;
  RAISE NOTICE 'G3 ok: every listed table has the key and the scope column its entry claims';

  -- ── G4. rollback uses the list, and handles every kind ───────────
  SELECT p.prosrc INTO v_src
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.rollback_import_batch(bigint)')::oid;
  IF v_src IS NULL THEN RAISE EXCEPTION 'G4 FAIL: rollback_import_batch could not be read'; END IF;
  v_body := regexp_replace(v_src, '--[^\n]*', '', 'g');
  IF length(v_body) >= length(v_src) THEN
    RAISE EXCEPTION 'G4 FAIL: stripping comments removed nothing (% vs %) — the counts below would be reading prose.', length(v_body), length(v_src);
  END IF;
  IF v_body !~ 'import_batch_value_dependents' THEN
    RAISE EXCEPTION 'G4 FAIL: rollback does not iterate the value-dependent list. The eight value references would go unchecked.';
  END IF;
  IF v_body !~ 'pg_constraint' THEN
    RAISE EXCEPTION 'G4 FAIL: rollback lost the dynamic FK walk. The value list does not replace it — the walk still catches a referencing table added later.';
  END IF;
  FOR v_s IN SELECT unnest(ARRAY['resident_email|property','resident_email|via_space','plate|property_since_load']) LOOP
    IF v_body !~ replace(v_s, '|', '\|') THEN
      RAISE EXCEPTION 'G4 FAIL: rollback has no branch for the kind %. An entry of that kind would be skipped.', v_s;
    END IF;
  END LOOP;
  -- 🔴 An unhandled kind must REFUSE, not be skipped.
  IF v_body !~ 'unhandled_dependent_kind' THEN
    RAISE EXCEPTION 'G4 FAIL: an entry with an unimplemented kind is not refused. Skipping it silently is the exact failure the list exists to prevent.';
  END IF;
  -- The plate branch must use the index's normalizer and the window.
  IF v_body !~ 'normalize_plate' THEN
    RAISE EXCEPTION 'G4 FAIL: the plate checks do not use normalize_plate. Comparing raw plate text compares a different key than the one that collides.';
  END IF;
  IF v_body !~ 'created_at >= \$3' THEN
    RAISE EXCEPTION 'G4 FAIL: the plate checks are not scoped to rows created since the load';
  END IF;
  IF v_body !~ 'public\.spaces' THEN
    RAISE EXCEPTION 'G4 FAIL: the via_space branch does not join spaces, so it cannot scope by property';
  END IF;
  -- The refusal must name each blocker so it can be resolved by hand.
  IF v_body !~ '''rows''' OR v_body !~ '''table''' OR v_body !~ '''key''' THEN
    RAISE EXCEPTION 'G4 FAIL: the blockers are not returned with table, key and row count. "It has dependents" is not something anyone can act on.';
  END IF;
  RAISE NOTICE 'G4 ok: the list is iterated, all three kinds branch, an unknown kind refuses, plate uses normalize_plate and the window, blockers are named';

  -- ── 🔴 G5. eleven checks in total ────────────────────────────────
  SELECT count(*) INTO v_fk FROM pg_constraint
   WHERE contype = 'f' AND confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass);
  SELECT count(*) INTO v_n FROM public.import_batch_value_dependents();
  IF v_fk + v_n <> 11 THEN
    RAISE EXCEPTION 'G5 FAIL: % FK + % value = % checks, want 11. If an FK was ADDED the walk already covers it and this number should rise with it; if one was REMOVED, find out why before lowering it.', v_fk, v_n, v_fk + v_n;
  END IF;
  RAISE NOTICE 'G5 ok: % FK + % value = 11 dependent checks', v_fk, v_n;

  -- ── 🔴 G6. the exclusions are asserted, not just documented ──────
  -- Ruled 2026-10-16: these are independent. Asserting it means a later
  -- addition is a deliberate change with a gate failure attached,
  -- rather than someone quietly disagreeing with the ruling.
  FOR v_s IN SELECT unnest(ARRAY['visitor_passes','authorized_plates','audit_logs',
                                 'do_not_tow_plates','property_plate_prohibitions']) LOOP
    IF EXISTS (SELECT 1 FROM public.import_batch_value_dependents() d WHERE d.tbl = v_s) THEN
      RAISE EXCEPTION 'G6 FAIL: % is on the dependent list and was ruled INDEPENDENT. A visitor pass belongs to a visitor and a plate list is configuration — neither came to exist because a vehicle row did. audit_logs is excluded because a log outlives its subject and rollback writes its own, so blocking on it would make rollback block on itself.', v_s;
    END IF;
  END LOOP;
  RAISE NOTICE 'G6 ok: visitor_passes, authorized_plates, audit_logs and the plate lists stay independent';
END
$do$;

-- ── the PASS row ────────────────────────────────────────────────────
SELECT
  'rollback value dependents' AS verification,
  'PASS — G1..G6' AS result,
  (SELECT count(*)::INT FROM public.import_batch_value_dependents()) AS value_checks,
  (SELECT count(*)::INT FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN ('public.residents'::regclass, 'public.vehicles'::regclass)) AS fk_checks,
  (SELECT string_agg(tbl || ':' || key_kind || '/' || scope_kind, '  ' ORDER BY key_kind, tbl)
     FROM public.import_batch_value_dependents()) AS the_list,
  'execution half: npm run verify:rollback' AS and_then;
