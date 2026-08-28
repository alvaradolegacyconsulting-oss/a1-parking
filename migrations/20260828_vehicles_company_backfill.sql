-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_company_backfill.sql
--
-- 🟢 vehicles.company arc — COMMIT 3 of 4
--
-- Backfills public.vehicles.company from public.properties.company
-- via lower(trim(name)) join. Idempotent (WHERE v.company IS NULL);
-- re-runnable; Commit-2 writer values are never overwritten.
--
-- ── PROGRAMMATIC GATE + UPDATE + AUDIT IN ONE DO BLOCK ──────────────
--
-- The gate + update + audit run inside one DO block. Implicit-txn
-- atomicity: if the gate raises, nothing runs; if the audit insert
-- fails, the UPDATE rolls back with it. Mateo Aug 28 §B.1: "STOP.
-- Not a judgment call" — a programmatic RAISE EXCEPTION enforces
-- that; there's no eyeball-and-decide seam.
--
-- Gate counts also emitted via RAISE NOTICE so they're visible in the
-- error pane regardless of pass/fail.
--
-- ── OPERATIONAL CONSTRAINT — SEED-DEMO RPC (Mateo Aug 28 §A opt 2) ──
-- 🔴 DO NOT INVOKE public.seed_demo_data (or whatever the seed-demo
-- DEFINER RPC is named — see migrations/20260711_seed_demo_data_rpc.sql:515)
-- between Commit 3 (this file) and Commit 4 (SET NOT NULL). The seed
-- RPC's INSERT does not yet populate company; a run in this window
-- would create NULL-company rows that this backfill would not catch
-- (this file runs once) and that Commit 4's SET NOT NULL would then
-- reject at its next invocation.
-- Constraint expires when the seed-demo RPC's own body-only migration
-- lands (queued as follow-up before Commit 4).
--
-- ── WRITER ALWAYS WINS ──────────────────────────────────────────────
-- The `AND v.company IS NULL` clause is load-bearing. Removing it
-- would let this backfill overwrite an explicit Commit-2 writer value
-- with a name-resolved lookup value. Since ambiguous_names=0 is
-- gated, the lookup value is EQUAL to the writer value today — but
-- writer-wins is the property that made writer-population the right
-- choice in §1.3, and the backfill must not undo it.
--
-- ── APPLY ─────────────────────────────────────────────────────────
-- Single paste. RAISE NOTICE lines print the gate counts + affected
-- row count. Any RAISE EXCEPTION aborts the DO block; the UPDATE
-- does not run in that case. Post-apply: run
-- 20260828_vehicles_company_backfill_verification.sql.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_total_vehicles  INT;
  v_null_company    INT;
  v_unmatched       INT;
  v_ambiguous_names INT;
  v_backfilled      INT;
BEGIN
  -- ── C3.GATE ─────────────────────────────────────────────────────
  -- Compute the safety-gate counts. Mateo §B.1: unmatched=0 AND
  -- ambiguous_names=0 or STOP.
  SELECT count(*) INTO v_total_vehicles FROM public.vehicles;

  SELECT count(*) INTO v_null_company
    FROM public.vehicles WHERE company IS NULL;

  SELECT count(*) INTO v_unmatched
    FROM public.vehicles v
    LEFT JOIN public.properties p
      ON lower(trim(p.name)) = lower(trim(v.property))
   WHERE p.id IS NULL;

  SELECT count(*) INTO v_ambiguous_names
    FROM (
      SELECT lower(trim(name))
        FROM public.properties
       GROUP BY 1
      HAVING count(DISTINCT lower(trim(company))) > 1
    ) x;

  RAISE NOTICE 'C3.GATE: total_vehicles=% · null_company=% · unmatched=% · ambiguous_names=%',
    v_total_vehicles, v_null_company, v_unmatched, v_ambiguous_names;

  -- ── GATE ENFORCEMENT ────────────────────────────────────────────
  IF v_unmatched > 0 THEN
    RAISE EXCEPTION 'C3.GATE FAIL: unmatched=% > 0. There are vehicles.property values that do not resolve to any properties row. The backfill would leave those rows with NULL company. Investigate before proceeding — do not resolve on judgment.', v_unmatched;
  END IF;
  IF v_ambiguous_names > 0 THEN
    RAISE EXCEPTION 'C3.GATE FAIL: ambiguous_names=% > 0. Two or more tenants have the same property name (case/whitespace-insensitive). The name-keyed backfill would arbitrarily assign one tenant''s company to the other tenant''s vehicles. This gate is why the backfill window matters — once ambiguous_names > 0, this migration can no longer run safely at all.', v_ambiguous_names;
  END IF;

  -- ── EARLY RETURN — nothing to backfill ──────────────────────────
  -- Idempotent no-op path. Re-running a completed backfill hits this.
  IF v_null_company = 0 THEN
    RAISE NOTICE 'C3.BACKFILL: null_company=0 — nothing to backfill. Idempotent no-op.';
    -- Still write an audit row so re-runs are traceable.
    INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
    VALUES (
      'SCHEMA_VEHICLES_COMPANY_BACKFILL',
      'public.vehicles',
      'vehicles.company',
      jsonb_build_object(
        'migration',        '20260828_vehicles_company_backfill',
        'arc',              'vehicles.company Commit 3 of 4',
        'outcome',          'noop_all_backfilled',
        'total_vehicles',   v_total_vehicles,
        'null_company',     v_null_company,
        'unmatched',        v_unmatched,
        'ambiguous_names',  v_ambiguous_names,
        'rows_backfilled',  0
      )
    );
    RETURN;
  END IF;

  -- ── UPDATE ──────────────────────────────────────────────────────
  -- Idempotency clause `AND v.company IS NULL` is load-bearing —
  -- writer values from Commit 2 must never be overwritten by this
  -- name-resolved backfill (see header note "WRITER ALWAYS WINS").
  UPDATE public.vehicles v
     SET company = p.company
    FROM public.properties p
   WHERE lower(trim(p.name)) = lower(trim(v.property))
     AND v.company IS NULL;
  GET DIAGNOSTICS v_backfilled = ROW_COUNT;

  RAISE NOTICE 'C3.BACKFILL: % rows backfilled (of % NULL-company candidates)',
    v_backfilled, v_null_company;

  -- ── AUDIT ───────────────────────────────────────────────────────
  -- Rows-affected count in the record, not just the console.
  INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
  VALUES (
    'SCHEMA_VEHICLES_COMPANY_BACKFILL',
    'public.vehicles',
    'vehicles.company',
    jsonb_build_object(
      'migration',        '20260828_vehicles_company_backfill',
      'arc',              'vehicles.company Commit 3 of 4',
      'outcome',          'backfilled',
      'total_vehicles',   v_total_vehicles,
      'null_company_pre', v_null_company,
      'unmatched',        v_unmatched,
      'ambiguous_names',  v_ambiguous_names,
      'rows_backfilled',  v_backfilled,
      'idempotency',      'WHERE v.company IS NULL — Commit 2 writer values preserved',
      'writer_wins_note', 'Backfill never overwrites an explicit writer value'
    )
  );
END $$;

-- Terminal SELECT — returns the outcome so Jose sees it in the result
-- pane, not just the NOTICE log.
SELECT
  'APPLIED'::TEXT                                       AS status,
  '20260828_vehicles_company_backfill'::TEXT            AS migration,
  (SELECT count(*) FROM public.vehicles)                AS total_vehicles_post,
  (SELECT count(*) FROM public.vehicles WHERE company IS NULL) AS null_company_post,
  '🔴 Run 20260828_vehicles_company_backfill_verification.sql next to confirm still_null=0 AND mismatched=0 AND orphaned=0'::TEXT AS next_step,
  now()                                                 AS applied_at;
