-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_company_backfill_verification.sql
--
-- Post-apply verification for 20260828_vehicles_company_backfill.
-- v2 pattern (feedback_verification_returns_rows_no_transaction):
--   - NO BEGIN/COMMIT wrap
--   - Terminal SELECT returns one row with status='PASS' on success
--   - Any gate failure surfaces via a RAISE EXCEPTION mid-DO block
--
-- 3 gates:
--   V3.1 still_null = 0 (backfill hit every eligible row)
--   V3.2 mismatched = 0 (every v.company equals its property's company,
--        using IS DISTINCT FROM to correctly count NULL-on-either-side
--        as a mismatch — Mateo Aug 28 §B.3: FILTER (WHERE v.company <> p.company)
--        would silently pass a NULL-vs-value case as "not distinct" and
--        the gate would report green while broken)
--   V3.3 orphaned = 0 (no vehicles.property that fails to resolve to
--        any properties row)
--
-- All three assessed against non-zero total; total=0 is itself a fail
-- (nothing to verify → nothing verified).
--
-- Also emits the schema-audit row confirmation (V3.4) as a soft
-- assertion — helps disambiguate "backfill migration was never applied"
-- from "backfill ran but had issues."
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_total       INT;
  v_still_null  INT;
  v_mismatched  INT;
  v_orphaned    INT;
  v_audit_count INT;
BEGIN
  -- Single scan — all counts derived from one LEFT JOIN.
  SELECT
    count(*),
    count(*) FILTER (WHERE v.company IS NULL),
    -- 🔴 IS DISTINCT FROM is the NULL-safe comparison. `<>` yields NULL
    -- when either side is NULL, and NULL is not TRUE so FILTER skips
    -- it — a genuine mismatch involving a NULL would count as zero
    -- and the gate would report pass while broken (Mateo §B.3).
    count(*) FILTER (
      WHERE p.id IS NOT NULL
        AND lower(trim(v.company)) IS DISTINCT FROM lower(trim(p.company))
    ),
    count(*) FILTER (WHERE p.id IS NULL)
    INTO v_total, v_still_null, v_mismatched, v_orphaned
    FROM public.vehicles v
    LEFT JOIN public.properties p
      ON lower(trim(p.name)) = lower(trim(v.property));

  RAISE NOTICE 'V3.BACKFILL raw: total=% · still_null=% · mismatched=% · orphaned=%',
    v_total, v_still_null, v_mismatched, v_orphaned;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'V3 PREREQ FAIL: total=0 — nothing to verify. Backfill migration not applied, or vehicles table empty (production A1 has 140+ rows).';
  END IF;
  IF v_still_null <> 0 THEN
    RAISE EXCEPTION 'V3.1 FAIL: still_null=% (want 0). Backfill did not populate every row. Diagnostic: SELECT id, property, company FROM public.vehicles WHERE company IS NULL;', v_still_null;
  END IF;
  IF v_mismatched <> 0 THEN
    RAISE EXCEPTION 'V3.2 FAIL: mismatched=% (want 0). A vehicle carries a company value that does not match its property''s company (case/whitespace-insensitive). This should be structurally impossible after the backfill unless: (a) a Commit-2 writer stamped the wrong company (rare — property.company changed after the writer captured company from residents), or (b) properties.company was updated post-backfill and vehicles now trail. Diagnostic: SELECT v.id, v.property, v.company AS v_company, p.company AS p_company FROM public.vehicles v LEFT JOIN public.properties p ON lower(trim(p.name)) = lower(trim(v.property)) WHERE p.id IS NOT NULL AND lower(trim(v.company)) IS DISTINCT FROM lower(trim(p.company));', v_mismatched;
  END IF;
  IF v_orphaned <> 0 THEN
    RAISE EXCEPTION 'V3.3 FAIL: orphaned=% (want 0). Vehicles.property values that do not resolve to any properties row. C3.GATE should have caught this pre-backfill; if this fires, an orphan appeared between C3.GATE and V3 (a property was deactivated/renamed in that window, or a new vehicle landed with a bad property). Diagnostic: SELECT id, property FROM public.vehicles v WHERE NOT EXISTS (SELECT 1 FROM public.properties p WHERE lower(trim(p.name)) = lower(trim(v.property)));', v_orphaned;
  END IF;

  -- ── V3.4 (soft) schema audit row exists ─────────────────────────
  SELECT COUNT(*) INTO v_audit_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_VEHICLES_COMPANY_BACKFILL'
     AND new_values->>'migration' = '20260828_vehicles_company_backfill';
  IF v_audit_count < 1 THEN
    RAISE EXCEPTION 'V3.4 FAIL: schema audit row not found. Backfill migration DO block did not complete — check for a mid-run RAISE EXCEPTION in the error pane.';
  END IF;

  RAISE NOTICE 'V3.BACKFILL: all 4 gates PASS. Safe to proceed to Commit 4 within the week.';
END $$;

-- Terminal SELECT — one PASS row with the counts + audit row's
-- rows_backfilled for record.
SELECT
  'PASS'::TEXT                                                    AS status,
  '20260828_vehicles_company_backfill'::TEXT                      AS target,
  '4 gates: total>0 / still_null=0 / mismatched=0 (IS DISTINCT FROM-safe) / orphaned=0 / audit row present'::TEXT AS gates,
  (SELECT count(*) FROM public.vehicles)                          AS total_vehicles,
  (SELECT (new_values->>'rows_backfilled')::INT
     FROM public.audit_logs
    WHERE action = 'SCHEMA_VEHICLES_COMPANY_BACKFILL'
      AND new_values->>'migration' = '20260828_vehicles_company_backfill'
    ORDER BY created_at DESC
    LIMIT 1)                                                       AS rows_backfilled_last_run,
  '🔴 Commit 4 (SET NOT NULL) within the week of Commit 3 per Mateo §D — pre: five-path Test-LEGACY smoke, probe rows deleted; post: V4.A1_DRIFT reads A1 natural traffic'::TEXT AS next_step,
  now()                                                            AS verified_at;
